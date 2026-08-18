mod addon;
mod frame_hub;
mod mp4;
mod replay_buffer;

use anyhow::{anyhow, Context, Result};
use addon::emit_json;
use frame_hub::{FrameBuffer, FrameHub, RAW_AUDIO, RAW_DELTA, RAW_KEYFRAME};
use mp4::{avcc_sample_contains_idr, validate_avc_config, FragmentedMp4Recorder};
use quinn::crypto::rustls::QuicServerConfig;
use replay_buffer::{ReplayBuffer, ReplaySampleKind, ReplaySnapshot};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UdpSocket;
use tokio::sync::Mutex;

const ALPN: &[u8] = b"livesuite-quic-reliable";
const MAGIC: &[u8; 4] = b"LSQ1";
const VIDEO_STREAM_MAGIC: &[u8; 4] = b"LSVS";
const AUDIO_STREAM_MAGIC: &[u8; 4] = b"LSA2";
const PROTOCOL_VERSION: u8 = 1;
const MEDIA_HEADER_SIZE: usize = 60;
const MAX_CONTROL_FRAME: usize = 64 * 1024;
const MAX_RELIABLE_FRAME: usize = 8 * 1024 * 1024;

const CONTROL_HELLO: u8 = 0x01;
const CONTROL_SYNC_REQUEST: u8 = 0x02;
const CONTROL_SYNC_RESULT: u8 = 0x03;
const CONTROL_STOP: u8 = 0x04;
const CONTROL_HELLO_ACK: u8 = 0x81;
const CONTROL_SYNC_RESPONSE: u8 = 0x82;
const CONTROL_STATS: u8 = 0x83;

const PACKET_MEDIA: u8 = 0x10;
const PACKET_PARITY: u8 = 0x11;
const PACKET_UDP_HELLO: u8 = 0x12;
const PACKET_UDP_SYNC_REQUEST: u8 = 0x13;
const PACKET_UDP_SYNC_RESULT: u8 = 0x14;
const PACKET_UDP_STOP: u8 = 0x15;
const PACKET_UDP_HELLO_ACK: u8 = 0x92;
const PACKET_UDP_SYNC_RESPONSE: u8 = 0x93;
const PACKET_UDP_STATS: u8 = 0x94;

const FLAG_CONFIG: u8 = 0x02;
const FLAG_RELIABLE_COPY: u8 = 0x04;
const FLAG_AUDIO: u8 = 0x08;

#[derive(Clone, Debug)]
pub(crate) struct Options {
    pub(crate) bind: IpAddr,
    pub(crate) port: u16,
    pub(crate) udp_fallback_port: Option<u16>,
    pub(crate) recording_dir: PathBuf,
    pub(crate) max_latency_ms: u64,
    pub(crate) reorder_window_ms: u64,
    pub(crate) synchronize_pull_streams: bool,
    pub(crate) include_audio_in_pull: bool,
}

impl Options {
    pub(crate) fn from_start_options(options: &addon::StartOptions) -> Result<Self> {
        let bind = options
            .bind
            .parse::<IpAddr>()
            .context("invalid bind address")?;
        let port = u16::try_from(options.port).context("invalid port")?;
        let udp_fallback_port = options
            .udp_fallback_port
            .map(|port| u16::try_from(port).context("invalid udp fallback port"))
            .transpose()?;
        if udp_fallback_port == Some(port) {
            return Err(anyhow!("QUIC and UDP fallback ports must differ"));
        }
        Ok(Self {
            bind,
            port,
            udp_fallback_port,
            recording_dir: PathBuf::from(&options.recording_dir),
            max_latency_ms: u64::from(options.max_latency_ms),
            reorder_window_ms: u64::from(options.reorder_window_ms),
            synchronize_pull_streams: options.synchronize_pull_streams,
            include_audio_in_pull: options.include_audio_in_pull,
        })
    }
}

#[derive(Clone, Debug)]
struct Hello {
    session_id: u64,
    transport: &'static str,
    path: String,
    width: u16,
    height: u16,
    fps: u16,
    bitrate: u32,
    audio_enabled: bool,
    audio_sample_rate: u32,
    audio_channels: u8,
    audio_bitrate: u32,
    audio_group_duration_us: u32,
}

#[derive(Clone, Debug)]
struct MediaPacket<'a> {
    packet_type: u8,
    flags: u8,
    session_id: u64,
    frame_id: u32,
    capture_epoch_ms: i64,
    encode_epoch_ms: i64,
    pts_us: i64,
    frame_size: usize,
    fragment_index: u16,
    fragment_count: u16,
    fec_group_start: u16,
    fec_group_size: u8,
    shard_size: usize,
    payload: &'a [u8],
}

impl<'a> MediaPacket<'a> {
    fn parse(data: &'a [u8]) -> Result<Self> {
        if data.len() < MEDIA_HEADER_SIZE || &data[0..4] != MAGIC {
            return Err(anyhow!("invalid media packet header"));
        }
        let header_size = read_u16(data, 6)? as usize;
        if header_size != MEDIA_HEADER_SIZE || data.len() < header_size {
            return Err(anyhow!("unsupported media header size"));
        }
        let flags = data[5];
        let payload_size = if flags & FLAG_RELIABLE_COPY != 0 {
            data.len() - header_size
        } else {
            read_u16(data, 58)? as usize
        };
        if header_size + payload_size != data.len() {
            return Err(anyhow!("media payload size mismatch"));
        }
        let packet_type = data[4];
        if packet_type != PACKET_MEDIA && packet_type != PACKET_PARITY {
            return Err(anyhow!("unsupported media packet type"));
        }
        let fragment_count = read_u16(data, 50)?;
        let shard_size = read_u16(data, 56)? as usize;
        if fragment_count == 0 || shard_size == 0 {
            return Err(anyhow!("invalid fragment declaration"));
        }
        Ok(Self {
            packet_type,
            flags,
            session_id: read_u64(data, 8)?,
            frame_id: read_u32(data, 16)?,
            capture_epoch_ms: read_i64(data, 20)?,
            encode_epoch_ms: read_i64(data, 28)?,
            pts_us: read_i64(data, 36)?,
            frame_size: read_u32(data, 44)? as usize,
            fragment_index: read_u16(data, 48)?,
            fragment_count,
            fec_group_start: read_u16(data, 52)?,
            fec_group_size: data[54],
            shard_size,
            payload: &data[header_size..],
        })
    }
}

#[derive(Debug)]
struct ParityShard {
    group_size: u8,
    data: Vec<u8>,
}

#[derive(Debug)]
struct FrameAssembly {
    flags: u8,
    capture_epoch_ms: i64,
    encode_epoch_ms: i64,
    pts_us: i64,
    frame_size: usize,
    shard_size: usize,
    created_at: Instant,
    fragments: Vec<Option<Vec<u8>>>,
    parity: BTreeMap<u16, ParityShard>,
}

impl FrameAssembly {
    fn new(packet: &MediaPacket<'_>) -> Result<Self> {
        let count = packet.fragment_count as usize;
        if count > 4096 || packet.frame_size > MAX_RELIABLE_FRAME {
            return Err(anyhow!("frame declaration exceeds limits"));
        }
        Ok(Self {
            flags: packet.flags,
            capture_epoch_ms: packet.capture_epoch_ms,
            encode_epoch_ms: packet.encode_epoch_ms,
            pts_us: packet.pts_us,
            frame_size: packet.frame_size,
            shard_size: packet.shard_size,
            created_at: Instant::now(),
            fragments: vec![None; count],
            parity: BTreeMap::new(),
        })
    }

    fn insert(&mut self, packet: &MediaPacket<'_>) -> Result<bool> {
        if packet.frame_size != self.frame_size
            || packet.fragment_count as usize != self.fragments.len()
            || packet.shard_size != self.shard_size
        {
            return Err(anyhow!("inconsistent frame fragments"));
        }
        if packet.packet_type == PACKET_MEDIA {
            let index = packet.fragment_index as usize;
            if index >= self.fragments.len() || packet.payload.len() > self.shard_size {
                return Err(anyhow!("invalid media fragment index or size"));
            }
            if self.fragments[index].is_none() {
                self.fragments[index] = Some(packet.payload.to_vec());
            }
        } else {
            if packet.fragment_index != u16::MAX || packet.fec_group_size == 0 {
                return Err(anyhow!("invalid parity fragment"));
            }
            self.parity
                .entry(packet.fec_group_start)
                .or_insert_with(|| ParityShard {
                    group_size: packet.fec_group_size,
                    data: packet.payload.to_vec(),
                });
        }
        Ok(self.fragments.iter().all(Option::is_some))
    }

    fn try_recover(&mut self) -> usize {
        let mut recovered = 0;
        for (&start, parity) in &self.parity {
            let start = start as usize;
            let end = (start + parity.group_size as usize).min(self.fragments.len());
            if start >= end {
                continue;
            }
            let missing = (start..end)
                .filter(|&index| self.fragments[index].is_none())
                .collect::<Vec<_>>();
            if missing.len() != 1 {
                continue;
            }
            let missing_index = missing[0];
            let mut recovered_data = parity.data.clone();
            recovered_data.resize(self.shard_size, 0);
            for index in start..end {
                if index == missing_index {
                    continue;
                }
                if let Some(fragment) = &self.fragments[index] {
                    for (position, value) in fragment.iter().enumerate() {
                        recovered_data[position] ^= *value;
                    }
                }
            }
            let expected_size = if missing_index + 1 == self.fragments.len() {
                self.frame_size
                    .saturating_sub(missing_index * self.shard_size)
            } else {
                self.shard_size
            };
            recovered_data.truncate(expected_size);
            self.fragments[missing_index] = Some(recovered_data);
            recovered += 1;
        }
        recovered
    }

    fn missing_count(&self) -> usize {
        self.fragments
            .iter()
            .filter(|fragment| fragment.is_none())
            .count()
    }

    fn assemble(self) -> Result<Vec<u8>> {
        let mut data = Vec::with_capacity(self.frame_size);
        for fragment in self.fragments {
            data.extend_from_slice(
                fragment
                    .as_ref()
                    .ok_or_else(|| anyhow!("frame is incomplete"))?,
            );
        }
        data.truncate(self.frame_size);
        if data.len() != self.frame_size {
            return Err(anyhow!("assembled frame has the wrong size"));
        }
        Ok(data)
    }
}

#[derive(Clone, Copy, Debug)]
struct ClockBounds {
    offset_min_ms: i64,
    offset_max_ms: i64,
    rtt_ms: u32,
}

/// 服务端时钟估计器：用最小二乘线性模型 `server = slope * client + intercept`
/// 拟合推流端时钟与服务端时钟的对应关系，从而对任意推流端时间戳预测其
/// 对应的服务端墙钟时刻。同步结果（无偏）用于正式拟合；媒体到达样本仅在
/// 尚无同步样本时作为冷启动近似，避免引入编码/网络延迟偏差。
#[derive(Debug, Default)]
struct ClockEstimator {
    samples: VecDeque<(f64, f64)>,
    slope: f64,
    intercept: f64,
    ready: bool,
    has_sync_samples: bool,
    best_rtt_ms: Option<u32>,
}

impl ClockEstimator {
    fn observe_sync(&mut self, bounds: ClockBounds, now_ms: i64) {
        self.best_rtt_ms = Some(match self.best_rtt_ms {
            Some(best) => best.min(bounds.rtt_ms),
            None => bounds.rtt_ms,
        });
        if bounds.rtt_ms > 500 {
            return; // 明显受网络抖动污染的同步结果直接丢弃
        }
        // 到达样本只用于时钟同步尚未开始时的冷启动。第一份真正的四时间戳
        // 结果到达后必须清掉这些带网络延迟偏差的样本，否则会把每条流的
        // 首包延迟错误地拟合进时钟偏移，导致多流各自落在不同时间轴上。
        if !self.has_sync_samples {
            self.samples.clear();
            self.has_sync_samples = true;
        }
        let offset_mid = bounds.offset_min_ms.saturating_add(bounds.offset_max_ms) / 2;
        let client_ms = now_ms.saturating_sub(offset_mid);
        self.samples.push_back((client_ms as f64, now_ms as f64));
        while self.samples.len() > 32 {
            self.samples.pop_front();
        }
        self.refit();
    }

    fn observe_arrival(&mut self, capture_ms: i64, server_ms: i64) {
        if !self.samples.is_empty() {
            return;
        }
        self.samples.push_back((capture_ms as f64, server_ms as f64));
        while self.samples.len() > 32 {
            self.samples.pop_front();
        }
        self.refit();
    }

    fn refit(&mut self) {
        if self.samples.len() < 3 {
            self.ready = false;
            return;
        }
        let (mut slope, mut intercept) = fit_clock_line(&self.samples);
        if !(0.9..=1.1).contains(&slope) {
            self.ready = false;
            return;
        }
        // 残差过滤：剔除受抖动污染的样本后重新拟合，避免个别坏点带偏模型。
        let kept = self
            .samples
            .iter()
            .copied()
            .filter(|&(client, server)| {
                (server - (slope * client + intercept)).abs() <= 100.0
            })
            .collect::<VecDeque<_>>();
        if kept.len() >= 3 && kept.len() != self.samples.len() {
            self.samples = kept;
            (slope, intercept) = fit_clock_line(&self.samples);
            if !(0.9..=1.1).contains(&slope) {
                self.ready = false;
                return;
            }
        }
        self.slope = slope;
        self.intercept = intercept;
        self.ready = true;
    }

    fn predict(&self, client_ms: i64) -> Option<i64> {
        if !self.ready {
            return None;
        }
        Some((self.slope * client_ms as f64 + self.intercept).round() as i64)
    }
}

fn fit_clock_line(samples: &VecDeque<(f64, f64)>) -> (f64, f64) {
    // 时间戳是 Unix 毫秒(约 1e12)。直接累加 x*x 会因相近大数相减而
    // 丢掉有效精度，回归结果会随机变成 0 或极端斜率。以首个样本为原点
    // 做中心化回归，再恢复截距，避免数值消减。
    let Some(&(origin_x, origin_y)) = samples.front() else {
        return (1.0, 0.0);
    };
    let mut sum_x = 0.0;
    let mut sum_y = 0.0;
    let mut sum_xx = 0.0;
    let mut sum_xy = 0.0;
    for &(client, server) in samples {
        let x = client - origin_x;
        let y = server - origin_y;
        sum_x += x;
        sum_y += y;
        sum_xx += x * x;
        sum_xy += x * y;
    }
    let count = samples.len() as f64;
    let mean_x = sum_x / count;
    let mean_y = sum_y / count;
    let denominator = sum_xx - count * mean_x * mean_x;
    if denominator.abs() < f64::EPSILON {
        return (1.0, origin_y - origin_x);
    }
    let covariance = sum_xy - count * mean_x * mean_y;
    let slope = covariance / denominator;
    let intercept = origin_y + mean_y - slope * (origin_x + mean_x);
    (slope, intercept)
}

#[derive(Debug)]
struct CompletedFrame {
    frame_id: u32,
    flags: u8,
    capture_epoch_ms: i64,
    encode_epoch_ms: i64,
    pts_us: i64,
    received_at: Instant,
    data: Vec<u8>,
}

#[derive(Debug)]
struct SessionState {
    hello: Hello,
    peer: SocketAddr,
    recording_path: Option<PathBuf>,
    recorder: Option<FragmentedMp4Recorder>,
    recording_waiting_for_keyframe: bool,
    replay_buffer: Option<ReplayBuffer>,
    avc_config: Option<Vec<u8>>,
    aac_config: Option<Vec<u8>>,
    frame_buffer: Arc<FrameBuffer>,
    max_latency: Duration,
    reorder_window: Duration,
    assemblies: HashMap<u32, FrameAssembly>,
    completed: BTreeMap<u32, CompletedFrame>,
    seen_frames: HashSet<u32>,
    seen_order: VecDeque<u32>,
    next_frame_id: Option<u32>,
    started_at: Instant,
    last_stats_at: Instant,
    last_stats_bytes: u64,
    last_stats_frames: u64,
    frames_completed: u64,
    frames_dropped: u64,
    frames_late: u64,
    expected_fragments: u64,
    missing_fragments: u64,
    recovered_fragments: u64,
    bytes_received: u64,
    clock: ClockEstimator,
    latency_samples: VecDeque<(i64, i64)>,
    encode_samples: VecDeque<i64>,
}

impl SessionState {
    fn create(
        hello: Hello,
        peer: SocketAddr,
        options: &Options,
        frame_buffer: Arc<FrameBuffer>,
    ) -> Result<Self> {
        Ok(Self {
            hello,
            peer,
            recording_path: None,
            recorder: None,
            recording_waiting_for_keyframe: false,
            replay_buffer: None,
            avc_config: None,
            aac_config: None,
            frame_buffer,
            max_latency: Duration::from_millis(options.max_latency_ms),
            reorder_window: Duration::from_millis(options.reorder_window_ms),
            assemblies: HashMap::new(),
            completed: BTreeMap::new(),
            seen_frames: HashSet::new(),
            seen_order: VecDeque::new(),
            next_frame_id: None,
            started_at: Instant::now(),
            last_stats_at: Instant::now(),
            last_stats_bytes: 0,
            last_stats_frames: 0,
            frames_completed: 0,
            frames_dropped: 0,
            frames_late: 0,
            expected_fragments: 0,
            missing_fragments: 0,
            recovered_fragments: 0,
            bytes_received: 0,
            clock: ClockEstimator::default(),
            latency_samples: VecDeque::new(),
            encode_samples: VecDeque::new(),
        })
    }

    fn accept_packet(&mut self, packet: MediaPacket<'_>) -> Result<()> {
        if packet.session_id != self.hello.session_id || self.seen_frames.contains(&packet.frame_id)
        {
            return Ok(());
        }
        self.bytes_received = self
            .bytes_received
            .saturating_add(packet.payload.len() as u64);
        let assembly = match self.assemblies.entry(packet.frame_id) {
            std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::hash_map::Entry::Vacant(entry) => {
                entry.insert(FrameAssembly::new(&packet)?)
            }
        };
        let complete = assembly.insert(&packet)?;
        let recovered = if complete { 0 } else { assembly.try_recover() };
        self.recovered_fragments = self.recovered_fragments.saturating_add(recovered as u64);
        if complete || assembly.missing_count() == 0 {
            let assembly = self
                .assemblies
                .remove(&packet.frame_id)
                .expect("assembly exists");
            self.expected_fragments = self
                .expected_fragments
                .saturating_add(assembly.fragments.len() as u64);
            let completed = CompletedFrame {
                frame_id: packet.frame_id,
                flags: assembly.flags,
                capture_epoch_ms: assembly.capture_epoch_ms,
                encode_epoch_ms: assembly.encode_epoch_ms,
                pts_us: assembly.pts_us,
                received_at: Instant::now(),
                data: assembly.assemble()?,
            };
            self.accept_completed(completed)?;
        }
        Ok(())
    }

    fn accept_reliable(&mut self, packet: MediaPacket<'_>) -> Result<()> {
        if packet.packet_type != PACKET_MEDIA || packet.flags & FLAG_AUDIO != 0 {
            return Err(anyhow!("invalid reliable video packet"));
        }
        if packet.session_id != self.hello.session_id || self.seen_frames.contains(&packet.frame_id) {
            return Ok(());
        }
        if packet.frame_size != packet.payload.len() {
            return Err(anyhow!("reliable frame size mismatch"));
        }
        self.bytes_received = self
            .bytes_received
            .saturating_add(packet.payload.len() as u64);
        self.assemblies.remove(&packet.frame_id);
        self.accept_completed(CompletedFrame {
            frame_id: packet.frame_id,
            flags: packet.flags | FLAG_RELIABLE_COPY,
            capture_epoch_ms: packet.capture_epoch_ms,
            encode_epoch_ms: packet.encode_epoch_ms,
            pts_us: packet.pts_us,
            received_at: Instant::now(),
            data: packet.payload.to_vec(),
        })
    }

    fn accept_completed(&mut self, frame: CompletedFrame) -> Result<()> {
        if self.seen_frames.contains(&frame.frame_id) {
            return Ok(());
        }
        if self
            .next_frame_id
            .is_some_and(|expected| sequence_is_before(frame.frame_id, expected))
        {
            // A frame can finish after the reorder deadline has already advanced.
            // Treat it as late instead of letting wrapping subtraction turn the
            // one-frame regression into u32::MAX dropped frames.
            self.frames_late = self.frames_late.saturating_add(1);
            self.mark_seen(frame.frame_id);
            return Ok(());
        }
        self.mark_seen(frame.frame_id);
        self.frames_completed = self.frames_completed.saturating_add(1);
        self.record_latency(&frame);
        if self.next_frame_id.is_none() {
            self.next_frame_id = Some(frame.frame_id);
        }
        self.completed.insert(frame.frame_id, frame);
        self.flush_completed(false)
    }

    fn mark_seen(&mut self, frame_id: u32) {
        self.seen_frames.insert(frame_id);
        self.seen_order.push_back(frame_id);
        while self.seen_order.len() > 4096 {
            if let Some(old) = self.seen_order.pop_front() {
                self.seen_frames.remove(&old);
            }
        }
    }

    fn record_latency(&mut self, frame: &CompletedFrame) {
        let now_ms = epoch_ms();
        self.clock.observe_arrival(frame.capture_epoch_ms, now_ms);
        if let Some(predicted) = self.clock.predict(frame.capture_epoch_ms) {
            let latency = now_ms.saturating_sub(predicted).max(0);
            self.latency_samples.push_back((latency, latency));
        }
        let encode_ms = frame.encode_epoch_ms.saturating_sub(frame.capture_epoch_ms);
        if (0..=60_000).contains(&encode_ms) {
            self.encode_samples.push_back(encode_ms);
        }
        while self.latency_samples.len() > 240 {
            self.latency_samples.pop_front();
        }
        while self.encode_samples.len() > 240 {
            self.encode_samples.pop_front();
        }
    }

    fn flush_completed(&mut self, force: bool) -> Result<()> {
        loop {
            let Some((&first_id, first)) = self.completed.first_key_value() else {
                return Ok(());
            };
            let expected = self.next_frame_id.unwrap_or(first_id);
            let ready =
                first_id == expected || force || first.received_at.elapsed() >= self.reorder_window;
            if !ready {
                return Ok(());
            }
            if first_id != expected {
                let Some(distance) = sequence_forward_distance(expected, first_id) else {
                    self.completed.remove(&first_id);
                    self.frames_late = self.frames_late.saturating_add(1);
                    continue;
                };
                self.frames_dropped = self.frames_dropped.saturating_add(distance as u64);
            }
            let frame = self
                .completed
                .remove(&first_id)
                .expect("completed frame exists");
            self.deliver_frame(&frame)?;
            self.next_frame_id = Some(first_id.wrapping_add(1));
        }
    }

    fn deliver_frame(&mut self, frame: &CompletedFrame) -> Result<()> {
        if frame.flags & FLAG_CONFIG != 0 {
            validate_avc_config(&frame.data)?;
            let capture = self.corrected_capture_epoch_ms(frame.capture_epoch_ms);
            self.frame_buffer
                .publish_video_config(frame.pts_us, capture, &frame.data);
            if let Some(recorder) = &mut self.recorder {
                recorder.set_avc_config(&frame.data)?;
            }
            if let Some(replay_buffer) = &mut self.replay_buffer {
                replay_buffer.set_avc_config(&frame.data);
            }
            self.avc_config = Some(frame.data.clone());
            return Ok(());
        }
        // MediaCodec 的关键帧 flag 在部分厂商实现上并不等价于可随机访问的
        // IDR。回放与录制边界必须以码流本身为准，否则文件可能从依赖帧开始。
        let keyframe = avcc_sample_contains_idr(&frame.data)?;
        let capture = self.corrected_capture_epoch_ms(frame.capture_epoch_ms);
        self.frame_buffer
            .publish_video(frame.pts_us, capture, keyframe, &frame.data);
        if let Some(recorder) = &mut self.recorder {
            if !self.recording_waiting_for_keyframe || keyframe {
                self.recording_waiting_for_keyframe = false;
                recorder.write_sample(frame.pts_us, keyframe, &frame.data)?;
            }
        }
        if let Some(replay_buffer) = &mut self.replay_buffer {
            replay_buffer.push(frame.pts_us, keyframe, &frame.data);
        }
        Ok(())
    }

    fn accept_audio(&mut self, packet: MediaPacket<'_>) -> Result<()> {
        if packet.packet_type != PACKET_MEDIA
            || packet.fragment_count != 1
            || packet.flags & FLAG_AUDIO == 0
            || packet.session_id != self.hello.session_id
        {
            return Err(anyhow!("invalid reliable audio packet"));
        }
        self.bytes_received = self
            .bytes_received
            .saturating_add(packet.payload.len() as u64);
        let capture = self.corrected_capture_epoch_ms(packet.capture_epoch_ms);
        if packet.flags & FLAG_CONFIG != 0 {
            if packet.payload.is_empty() {
                return Err(anyhow!("empty AudioSpecificConfig"));
            }
            self.aac_config = Some(packet.payload.to_vec());
            self.frame_buffer
                .publish_audio_config(packet.pts_us, capture, packet.payload);
            if let Some(recorder) = &mut self.recorder {
                recorder.set_aac_config(
                    packet.payload,
                    self.hello.audio_sample_rate,
                    self.hello.audio_channels,
                    self.hello.audio_bitrate,
                )?;
            }
            if let Some(replay) = &mut self.replay_buffer {
                replay.set_aac_config(packet.payload);
            }
            return Ok(());
        }
        self.frame_buffer
            .publish_audio(packet.pts_us, capture, packet.payload);
        if let Some(recorder) = &mut self.recorder {
            if !self.recording_waiting_for_keyframe {
                recorder.write_audio_sample(packet.pts_us, packet.payload)?;
            }
        }
        if let Some(replay) = &mut self.replay_buffer {
            replay.push_audio(packet.pts_us, packet.payload);
        }
        Ok(())
    }

    fn corrected_capture_epoch_ms(&self, capture_epoch_ms: i64) -> Option<i64> {
        // 用拟合出的服务端时钟模型预测采集时刻对应的服务端墙钟时间，
        // 使各推流端时间戳统一映射到服务端时钟轴上。
        self.clock.predict(capture_epoch_ms)
    }

    fn start_recording(&mut self, directory: &Path) -> Result<Option<PathBuf>> {
        if self.recorder.is_some() {
            return Ok(self.recording_path.clone());
        }
        let path = media_path(directory, "recording", &self.hello);
        let mut recorder = FragmentedMp4Recorder::new(
            path.clone(),
            self.hello.width,
            self.hello.height,
            self.hello.fps,
            self.hello.audio_enabled,
        );
        if let Some(config) = &self.avc_config {
            recorder.set_avc_config(config)?;
        }
        if let Some(config) = &self.aac_config {
            recorder.set_aac_config(
                config,
                self.hello.audio_sample_rate,
                self.hello.audio_channels,
                self.hello.audio_bitrate,
            )?;
        }
        let (_, _, snapshot) = self.frame_buffer.take_frames(0);
        let mut wrote_keyframe = false;
        for frame in snapshot {
            match frame.kind {
                RAW_KEYFRAME => {
                    wrote_keyframe = true;
                    recorder.write_sample(frame.pts_us, true, &frame.data)?;
                }
                RAW_DELTA => {
                    if wrote_keyframe {
                        recorder.write_sample(frame.pts_us, false, &frame.data)?;
                    }
                }
                RAW_AUDIO => {
                    if wrote_keyframe {
                        recorder.write_audio_sample(frame.pts_us, &frame.data)?;
                    }
                }
                _ => {}
            }
        }
        self.recording_path = Some(path.clone());
        self.recorder = Some(recorder);
        self.recording_waiting_for_keyframe = !wrote_keyframe;
        Ok(Some(path))
    }

    fn stop_recording(&mut self) -> Result<Option<PathBuf>> {
        let Some(mut recorder) = self.recorder.take() else {
            return Ok(None);
        };
        self.recording_waiting_for_keyframe = false;
        recorder.finish()?;
        Ok(self.recording_path.clone())
    }

    fn start_replay_buffer(&mut self, duration_ms: u64) {
        self.replay_buffer = Some(ReplayBuffer::new(
            duration_ms,
            self.avc_config.as_deref(),
            self.aac_config.as_deref(),
            self.hello.audio_enabled,
            self.hello.audio_sample_rate,
            self.hello.audio_channels,
            self.hello.audio_bitrate,
        ));
    }

    fn stop_replay_buffer(&mut self) {
        self.replay_buffer = None;
    }

    fn replay_snapshot(&self) -> Option<ReplaySnapshot> {
        self.replay_buffer.as_ref()?.snapshot()
    }

    fn media_status(&self, active: bool) -> RuntimeMediaStatus {
        RuntimeMediaStatus {
            session_id: self.hello.session_id,
            active,
            recording_enabled: self.recorder.is_some(),
            replay_duration_ms: self.replay_buffer.as_ref().map(ReplayBuffer::duration_ms),
            recording_path: self.recording_path.clone(),
        }
    }

    fn finish_recording(&mut self) -> Result<()> {
        self.stop_recording()?;
        Ok(())
    }

    fn cleanup_expired(&mut self) -> Result<()> {
        let expired = self
            .assemblies
            .iter()
            .filter_map(|(&frame_id, frame)| {
                (frame.created_at.elapsed() >= self.max_latency).then_some(frame_id)
            })
            .collect::<Vec<_>>();
        for frame_id in expired {
            if let Some(mut frame) = self.assemblies.remove(&frame_id) {
                let recovered = frame.try_recover();
                self.recovered_fragments =
                    self.recovered_fragments.saturating_add(recovered as u64);
                let missing = frame.missing_count();
                self.expected_fragments = self
                    .expected_fragments
                    .saturating_add(frame.fragments.len() as u64);
                self.missing_fragments = self.missing_fragments.saturating_add(missing as u64);
                if missing == 0 {
                    let completed = CompletedFrame {
                        frame_id,
                        flags: frame.flags,
                        capture_epoch_ms: frame.capture_epoch_ms,
                        encode_epoch_ms: frame.encode_epoch_ms,
                        pts_us: frame.pts_us,
                        received_at: Instant::now(),
                        data: frame.assemble()?,
                    };
                    self.accept_completed(completed)?;
                } else {
                    self.frames_dropped = self.frames_dropped.saturating_add(1);
                    self.frames_late = self.frames_late.saturating_add(1);
                    self.mark_seen(frame_id);
                }
            }
        }
        self.flush_completed(false)
    }

    fn update_clock(&mut self, bounds: ClockBounds) {
        self.clock.observe_sync(bounds, epoch_ms());
    }

    fn stats(&mut self) -> StatsSnapshot {
        let elapsed = self.last_stats_at.elapsed().as_secs_f64().max(0.001);
        let byte_delta = self.bytes_received.saturating_sub(self.last_stats_bytes);
        let frame_delta = self.frames_completed.saturating_sub(self.last_stats_frames);
        self.last_stats_at = Instant::now();
        self.last_stats_bytes = self.bytes_received;
        self.last_stats_frames = self.frames_completed;
        let latency_min = self.latency_samples.iter().map(|sample| sample.0).min();
        let latency_max = self.latency_samples.iter().map(|sample| sample.1).max();
        let encode_min = self.encode_samples.iter().copied().min();
        let encode_max = self.encode_samples.iter().copied().max();
        let encode_average = (!self.encode_samples.is_empty()).then(|| {
            self.encode_samples
                .iter()
                .map(|value| *value as f64)
                .sum::<f64>()
                / self.encode_samples.len() as f64
        });
        let encode_p95 = if self.encode_samples.is_empty() {
            None
        } else {
            let mut sorted = self.encode_samples.iter().copied().collect::<Vec<_>>();
            sorted.sort_unstable();
            let index = ((sorted.len() as f64 * 0.95).ceil() as usize)
                .saturating_sub(1)
                .min(sorted.len() - 1);
            Some(sorted[index])
        };
        let loss_ratio = if self.expected_fragments == 0 {
            0.0
        } else {
            self.missing_fragments as f64 / self.expected_fragments as f64
        };
        StatsSnapshot {
            session_id: self.hello.session_id,
            transport: self.hello.transport,
            path: self.hello.path.clone(),
            recording_path: self.recording_path.clone(),
            recording_enabled: self.recorder.is_some(),
            replay_duration_ms: self.replay_buffer.as_ref().map(ReplayBuffer::duration_ms),
            frames: self.frames_completed,
            dropped_frames: self.frames_dropped,
            late_frames: self.frames_late,
            recovered_fragments: self.recovered_fragments,
            loss_ratio,
            bitrate_kbps: byte_delta as f64 * 8.0 / elapsed / 1000.0,
            fps: frame_delta as f64 / elapsed,
            latency_min_ms: latency_min,
            latency_max_ms: latency_max,
            encode_min_ms: encode_min,
            encode_max_ms: encode_max,
            encode_average_ms: encode_average,
            encode_p95_ms: encode_p95,
            clock_rtt_ms: self.clock.best_rtt_ms,
            uptime_ms: self.started_at.elapsed().as_millis() as u64,
        }
    }
}

#[derive(Clone, Debug)]
struct RuntimeMediaController {
    recording_dir: Arc<PathBuf>,
    inner: Arc<Mutex<RuntimeMediaState>>,
}

#[derive(Debug, Default)]
struct RuntimeMediaState {
    sessions: HashMap<u64, Arc<Mutex<SessionState>>>,
    ended_replays: HashMap<u64, EndedReplay>,
}

#[derive(Clone, Debug)]
struct EndedReplay {
    hello: Hello,
    snapshot: ReplaySnapshot,
    duration_ms: u64,
    recording_path: Option<PathBuf>,
}

#[derive(Clone, Debug)]
struct RuntimeMediaStatus {
    session_id: u64,
    active: bool,
    recording_enabled: bool,
    replay_duration_ms: Option<u64>,
    recording_path: Option<PathBuf>,
}

impl RuntimeMediaStatus {
    fn inactive(session_id: u64) -> Self {
        Self {
            session_id,
            active: false,
            recording_enabled: false,
            replay_duration_ms: None,
            recording_path: None,
        }
    }
}

#[derive(Debug)]
struct ReplayExport {
    path: PathBuf,
    width: u16,
    height: u16,
    fps: u16,
    snapshot: ReplaySnapshot,
}

impl RuntimeMediaController {
    fn new(recording_dir: PathBuf) -> Self {
        Self {
            recording_dir: Arc::new(recording_dir),
            inner: Arc::new(Mutex::new(RuntimeMediaState::default())),
        }
    }

    async fn register(&self, state: SessionState) -> Result<Arc<Mutex<SessionState>>> {
        let mut inner = self.inner.lock().await;
        let session_id = state.hello.session_id;
        let session = Arc::new(Mutex::new(state));
        inner.ended_replays.remove(&session_id);
        inner.sessions.insert(session_id, session.clone());
        Ok(session)
    }

    async fn unregister(
        &self,
        session_id: u64,
        session: &Arc<Mutex<SessionState>>,
    ) -> Option<RuntimeMediaStatus> {
        let (hello, snapshot, duration_ms, recording_path) = {
            let state = session.lock().await;
            (
                state.hello.clone(),
                state.replay_snapshot(),
                state.replay_buffer.as_ref().map(ReplayBuffer::duration_ms),
                state.recording_path.clone(),
            )
        };
        let mut inner = self.inner.lock().await;
        let is_current = inner
            .sessions
            .get(&session_id)
            .is_some_and(|current| Arc::ptr_eq(current, session));
        if !is_current {
            return None;
        }
        inner.sessions.remove(&session_id);
        inner.ended_replays.remove(&session_id);
        let retained_duration_ms = match (duration_ms, snapshot) {
            (Some(duration_ms), Some(snapshot)) => {
                inner.ended_replays.insert(
                    session_id,
                    EndedReplay {
                        hello,
                        snapshot,
                        duration_ms,
                        recording_path: recording_path.clone(),
                    },
                );
                Some(duration_ms)
            }
            _ => None,
        };
        Some(RuntimeMediaStatus {
            session_id,
            active: false,
            recording_enabled: false,
            replay_duration_ms: retained_duration_ms,
            recording_path,
        })
    }

    async fn active_session(&self, session_id: u64) -> Result<Arc<Mutex<SessionState>>> {
        self.inner
            .lock()
            .await
            .sessions
            .get(&session_id)
            .cloned()
            .ok_or_else(|| anyhow!("stream session {:016x} is not active", session_id))
    }

    async fn start_recording(&self, session_id: u64) -> Result<Vec<PathBuf>> {
        let session = self.active_session(session_id).await?;
        fs::create_dir_all(self.recording_dir.as_ref()).with_context(|| {
            format!(
                "failed to create recording directory {}",
                self.recording_dir.display()
            )
        })?;
        let path = session
            .lock()
            .await
            .start_recording(self.recording_dir.as_ref())?;
        Ok(path.into_iter().collect())
    }

    async fn stop_recording(&self, session_id: u64) -> Result<Vec<PathBuf>> {
        let session = self.active_session(session_id).await?;
        let path = session.lock().await.stop_recording()?;
        Ok(path.into_iter().collect())
    }

    async fn start_replay_buffer(&self, session_id: u64, duration_ms: u64) -> Result<()> {
        let session = self.active_session(session_id).await?;
        session.lock().await.start_replay_buffer(duration_ms);
        self.inner.lock().await.ended_replays.remove(&session_id);
        Ok(())
    }

    async fn stop_replay_buffer(&self, session_id: u64) -> Result<()> {
        let session = { self.inner.lock().await.sessions.get(&session_id).cloned() };
        if let Some(session) = session {
            session.lock().await.stop_replay_buffer();
            self.inner.lock().await.ended_replays.remove(&session_id);
            return Ok(());
        }
        if self
            .inner
            .lock()
            .await
            .ended_replays
            .remove(&session_id)
            .is_some()
        {
            return Ok(());
        }
        Err(anyhow!("stream session {:016x} was not found", session_id))
    }

    async fn save_replay_buffer(&self, session_id: u64) -> Result<Vec<PathBuf>> {
        fs::create_dir_all(self.recording_dir.as_ref()).with_context(|| {
            format!(
                "failed to create recording directory {}",
                self.recording_dir.display()
            )
        })?;
        let session = { self.inner.lock().await.sessions.get(&session_id).cloned() };
        let export = if let Some(session) = session {
            let state = session.lock().await;
            let snapshot = state.replay_snapshot().ok_or_else(|| {
                anyhow!("replay buffer does not contain a decodable keyframe yet")
            })?;
            ReplayExport {
                path: media_path(self.recording_dir.as_ref(), "replay", &state.hello),
                width: state.hello.width,
                height: state.hello.height,
                fps: state.hello.fps,
                snapshot,
            }
        } else {
            let replay = self
                .inner
                .lock()
                .await
                .ended_replays
                .get(&session_id)
                .cloned()
                .ok_or_else(|| anyhow!("stream session {:016x} was not found", session_id))?;
            ReplayExport {
                path: media_path(self.recording_dir.as_ref(), "replay", &replay.hello),
                width: replay.hello.width,
                height: replay.hello.height,
                fps: replay.hello.fps,
                snapshot: replay.snapshot,
            }
        };
        tokio::task::spawn_blocking(move || write_replay_exports(vec![export]))
            .await
            .context("replay export task failed")?
    }

    async fn status(&self, session_id: u64) -> RuntimeMediaStatus {
        let session = { self.inner.lock().await.sessions.get(&session_id).cloned() };
        if let Some(session) = session {
            return session.lock().await.media_status(true);
        }
        self.inner
            .lock()
            .await
            .ended_replays
            .get(&session_id)
            .map(|replay| RuntimeMediaStatus {
                session_id,
                active: false,
                recording_enabled: false,
                replay_duration_ms: Some(replay.duration_ms),
                recording_path: replay.recording_path.clone(),
            })
            .unwrap_or_else(|| RuntimeMediaStatus::inactive(session_id))
    }
}

fn write_replay_exports(exports: Vec<ReplayExport>) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::with_capacity(exports.len());
    for export in exports {
        let mut recorder = FragmentedMp4Recorder::new(
            export.path.clone(),
            export.width,
            export.height,
            export.fps,
            export.snapshot.expects_audio,
        );
        recorder.set_avc_config(&export.snapshot.avc_config)?;
        if let Some(config) = &export.snapshot.aac_config {
            recorder.set_aac_config(
                config,
                export.snapshot.audio_sample_rate,
                export.snapshot.audio_channels,
                export.snapshot.audio_bitrate,
            )?;
        }
        for sample in export.snapshot.samples {
            match sample.kind {
                ReplaySampleKind::Video { keyframe } => {
                    recorder.write_sample(sample.pts_us, keyframe, &sample.data)?
                }
                ReplaySampleKind::Audio => {
                    recorder.write_audio_sample(sample.pts_us, &sample.data)?
                }
            }
        }
        recorder.finish()?;
        paths.push(export.path);
    }
    Ok(paths)
}

#[derive(Clone, Debug)]
struct StatsSnapshot {
    session_id: u64,
    transport: &'static str,
    path: String,
    recording_path: Option<PathBuf>,
    recording_enabled: bool,
    replay_duration_ms: Option<u64>,
    frames: u64,
    dropped_frames: u64,
    late_frames: u64,
    recovered_fragments: u64,
    loss_ratio: f64,
    bitrate_kbps: f64,
    fps: f64,
    latency_min_ms: Option<i64>,
    latency_max_ms: Option<i64>,
    encode_min_ms: Option<i64>,
    encode_max_ms: Option<i64>,
    encode_average_ms: Option<f64>,
    encode_p95_ms: Option<i64>,
    clock_rtt_ms: Option<u32>,
    uptime_ms: u64,
}

impl StatsSnapshot {
    fn emit(&self) {
        emit_json(json!({
            "type": "metrics",
            "sessionId": format!("{:016x}", self.session_id),
            "protocol": "quic",
            "transport": self.transport,
            "streamPath": self.path,
            "recordingPath": self.recording_path,
            "active": true,
            "recordingEnabled": self.recording_enabled,
            "replayBuffering": self.replay_duration_ms.is_some(),
            "replayDurationMs": self.replay_duration_ms,
            "frames": self.frames,
            "droppedFrames": self.dropped_frames,
            "lateFrames": self.late_frames,
            "recoveredFragments": self.recovered_fragments,
            "packetLossRatio": self.loss_ratio,
            "bitrateKbps": self.bitrate_kbps,
            "fps": self.fps,
            "latencyMinMs": self.latency_min_ms,
            "latencyMaxMs": self.latency_max_ms,
            "encodeMinMs": self.encode_min_ms,
            "encodeMaxMs": self.encode_max_ms,
            "encodeAverageMs": self.encode_average_ms,
            "encodeP95Ms": self.encode_p95_ms,
            "clockRttMs": self.clock_rtt_ms,
            "uptimeMs": self.uptime_ms,
        }));
    }

    fn control_payload(&self, message_type: u8) -> Vec<u8> {
        let mut data = Vec::with_capacity(64);
        data.push(message_type);
        push_u64(&mut data, self.frames);
        push_u32(&mut data, self.dropped_frames.min(u32::MAX as u64) as u32);
        push_i32(
            &mut data,
            self.latency_min_ms
                .unwrap_or(-1)
                .clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        );
        push_i32(
            &mut data,
            self.latency_max_ms
                .unwrap_or(-1)
                .clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        );
        data.extend_from_slice(&(self.loss_ratio as f32).to_bits().to_be_bytes());
        push_u32(
            &mut data,
            self.recovered_fragments.min(u32::MAX as u64) as u32,
        );
        push_u32(
            &mut data,
            self.bitrate_kbps.round().clamp(0.0, u32::MAX as f64) as u32,
        );
        push_u16(
            &mut data,
            (self.fps * 100.0).round().clamp(0.0, u16::MAX as f64) as u16,
        );
        push_i32(
            &mut data,
            self.encode_min_ms
                .unwrap_or(-1)
                .clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        );
        push_i32(
            &mut data,
            self.encode_max_ms
                .unwrap_or(-1)
                .clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        );
        push_u32(&mut data, self.clock_rtt_ms.unwrap_or(u32::MAX));
        data
    }
}

#[derive(Debug)]
#[allow(dead_code)]
struct RuntimeCommand {
    command_id: String,
    action: String,
    session_id: Option<u64>,
    duration_ms: Option<u64>,
    enabled: Option<bool>,
}

impl RuntimeCommand {
    #[allow(dead_code)]
    fn parse(line: &str) -> Result<Self> {
        let value: Value = serde_json::from_str(line).context("invalid runtime command JSON")?;
        let command_id = value
            .get("commandId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("runtime command is missing commandId"))?
            .to_string();
        let action = value
            .get("action")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("runtime command is missing action"))?
            .to_string();
        let session_id = match value.get("sessionId") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) => Some(
                u64::from_str_radix(value, 16)
                    .with_context(|| format!("invalid runtime sessionId {value}"))?,
            ),
            Some(Value::Number(value)) => Some(
                value
                    .as_u64()
                    .ok_or_else(|| anyhow!("runtime sessionId must be an unsigned integer"))?,
            ),
            Some(_) => return Err(anyhow!("runtime sessionId must be a hexadecimal string")),
        };
        Ok(Self {
            command_id,
            action,
            session_id,
            duration_ms: value.get("durationMs").and_then(Value::as_u64),
            enabled: match value.get("enabled") {
                None | Some(Value::Null) => None,
                Some(Value::Bool(value)) => Some(*value),
                Some(_) => return Err(anyhow!("runtime enabled must be a boolean")),
            },
        })
    }
}

fn create_endpoint(options: &Options) -> Result<quinn::Endpoint> {
    let certified_key = rcgen::generate_simple_self_signed(vec![
        "livesuite.local".to_string(),
        "localhost".to_string(),
    ])?;
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
        certified_key.signing_key.serialize_der(),
    ));
    let cert: CertificateDer<'static> = certified_key.cert.into();
    let mut crypto = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![cert], key)?;
    crypto.alpn_protocols = vec![ALPN.to_vec()];
    let mut server_config =
        quinn::ServerConfig::with_crypto(Arc::new(QuicServerConfig::try_from(crypto)?));
    let transport = Arc::get_mut(&mut server_config.transport).expect("transport config is unique");
    transport.max_concurrent_bidi_streams(4_u32.into());
    transport.max_concurrent_uni_streams(64_u32.into());
    transport.keep_alive_interval(Some(Duration::from_secs(1)));
    transport.max_idle_timeout(Some(Duration::from_secs(5).try_into()?));
    let address = SocketAddr::new(options.bind, options.port);
    quinn::Endpoint::server(server_config, address)
        .with_context(|| format!("failed to bind QUIC on UDP {address}"))
}

async fn finish_media_session(
    session_id: u64,
    session: &Arc<Mutex<SessionState>>,
    frame_hub: &FrameHub,
    media_controller: &RuntimeMediaController,
) -> Result<()> {
    let (hello, peer, cleanup_result, stats, session_buffer) = {
        let mut state = session.lock().await;
        let cleanup_result = state
            .flush_completed(true)
            .and_then(|_| state.finish_recording());
        let stats = state.stats();
        (
            state.hello.clone(),
            state.peer,
            cleanup_result,
            stats,
            state.frame_buffer.clone(),
        )
    };
    stats.emit();
    frame_hub.unregister(&session_buffer);
    if let Some(status) = media_controller.unregister(session_id, session).await {
        emit_publish_ended(&hello, peer, &status);
    }
    cleanup_result
}

async fn handle_quic_connection(
    incoming: quinn::Incoming,
    options: Options,
    frame_hub: FrameHub,
    media_controller: RuntimeMediaController,
) -> Result<()> {
    let connection = incoming.await?;
    let peer = connection.remote_address();
    let (send, mut recv) = tokio::time::timeout(Duration::from_secs(5), connection.accept_bi())
        .await
        .context("timed out waiting for control stream")??;
    let hello_data = read_control_frame(&mut recv).await?;
    let hello = parse_hello(&hello_data, "quic")?;
    let session_buffer = frame_hub.register(
        hello.session_id,
        &hello.path,
        options.include_audio_in_pull,
        hello.audio_enabled,
        hello.audio_channels,
        hello.audio_group_duration_us,
    );
    let session = media_controller
        .register(SessionState::create(
            hello.clone(),
            peer,
            &options,
            session_buffer.clone(),
        )?)
        .await?;
    emit_published(
        &hello,
        peer,
        &frame_hub,
        session.lock().await.recording_path.as_deref(),
    );
    let control_send = Arc::new(Mutex::new(send));
    let ack = hello_ack_payload(hello.session_id);
    write_control_frame(&control_send, &ack).await?;

    let control_future = run_quic_control(recv, control_send.clone(), session.clone());
    let reliable_future = run_quic_reliable_frames(connection.clone(), session.clone());
    let stats_future = run_quic_stats(control_send, session.clone());
    let connection_result = tokio::select! {
        result = control_future => result,
        result = reliable_future => result,
        result = stats_future => result,
        _ = connection.closed() => Ok(()),
    };
    let cleanup_result =
        finish_media_session(hello.session_id, &session, &frame_hub, &media_controller).await;
    connection_result?;
    cleanup_result
}

async fn run_quic_control(
    mut recv: quinn::RecvStream,
    send: Arc<Mutex<quinn::SendStream>>,
    session: Arc<Mutex<SessionState>>,
) -> Result<()> {
    loop {
        let data = read_control_frame(&mut recv).await?;
        if data.is_empty() {
            continue;
        }
        match data[0] {
            CONTROL_SYNC_REQUEST => {
                if data.len() != 1 + 4 + 8 {
                    return Err(anyhow!("invalid sync request"));
                }
                let sequence = read_u32(&data, 1)?;
                let t0 = read_i64(&data, 5)?;
                let t1 = epoch_ms();
                let mut response = Vec::with_capacity(1 + 4 + 8 * 3);
                response.push(CONTROL_SYNC_RESPONSE);
                push_u32(&mut response, sequence);
                push_i64(&mut response, t0);
                push_i64(&mut response, t1);
                push_i64(&mut response, epoch_ms());
                write_control_frame(&send, &response).await?;
            }
            CONTROL_SYNC_RESULT => {
                let bounds = parse_sync_result(&data)?;
                session.lock().await.update_clock(bounds);
            }
            CONTROL_STOP => return Ok(()),
            other => return Err(anyhow!("unknown control message type {other:#x}")),
        }
    }
}

async fn run_quic_reliable_frames(
    connection: quinn::Connection,
    session: Arc<Mutex<SessionState>>,
) -> Result<()> {
    loop {
        let stream = connection.accept_uni().await?;
        let stream_session = session.clone();
        tokio::spawn(async move {
            if let Err(error) = run_reliable_stream(stream, stream_session).await {
                emit_json(json!({
                    "type": "error",
                    "message": format!("QUIC reliable media stream: {error:#}")
                }));
            }
        });
    }
}

async fn run_reliable_stream(
    mut stream: quinn::RecvStream,
    session: Arc<Mutex<SessionState>>,
) -> Result<()> {
    let mut stream_magic = [0_u8; 4];
    stream.read_exact(&mut stream_magic).await?;
    let is_video = &stream_magic == VIDEO_STREAM_MAGIC;
    let is_audio = &stream_magic == AUDIO_STREAM_MAGIC;
    if !is_video && !is_audio {
        return Err(anyhow!("unknown reliable media stream"));
    }

    loop {
        let length = match stream.read_u32().await {
            Ok(length) => length as usize,
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(error) => return Err(error.into()),
        };
        if length < MEDIA_HEADER_SIZE || length > MAX_RELIABLE_FRAME + MEDIA_HEADER_SIZE {
            return Err(anyhow!("invalid reliable media frame length"));
        }
        let mut data = vec![0_u8; length];
        stream.read_exact(&mut data).await?;
        let packet = MediaPacket::parse(&data)?;
        let mut state = session.lock().await;
        if is_video {
            state.accept_reliable(packet)?;
        } else {
            state.accept_audio(packet)?;
        }
    }
    Ok(())
}

async fn run_quic_stats(
    send: Arc<Mutex<quinn::SendStream>>,
    session: Arc<Mutex<SessionState>>,
) -> Result<()> {
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    loop {
        interval.tick().await;
        let stats = {
            let mut state = session.lock().await;
            state.cleanup_expired()?;
            state.stats()
        };
        stats.emit();
        write_control_frame(&send, &stats.control_payload(CONTROL_STATS)).await?;
    }
}

async fn run_udp_server(
    socket: Arc<UdpSocket>,
    options: Options,
    frame_hub: FrameHub,
    media_controller: RuntimeMediaController,
) -> Result<()> {
    let sessions = Arc::new(Mutex::new(HashMap::<u64, Arc<Mutex<SessionState>>>::new()));
    let mut buffer = vec![0_u8; 65_507];
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    loop {
        tokio::select! {
            received = socket.recv_from(&mut buffer) => {
                let (size, peer) = received?;
                let data = &buffer[..size];
                if data.len() < 5 || &data[0..4] != MAGIC {
                    continue;
                }
                match data[4] {
                    PACKET_UDP_HELLO => {
                        let hello = parse_hello(&data[4..], "udp")?;
                        let session_buffer = frame_hub.register(
                            hello.session_id,
                            &hello.path,
                            options.include_audio_in_pull,
                            hello.audio_enabled,
                            hello.audio_channels,
                            hello.audio_group_duration_us,
                        );
                        let session = media_controller
                            .register(SessionState::create(
                                hello.clone(),
                                peer,
                                &options,
                                session_buffer,
                            )?)
                            .await?;
                        emit_published(
                            &hello,
                            peer,
                            &frame_hub,
                            session.lock().await.recording_path.as_deref(),
                        );
                        if let Some(previous) = sessions
                            .lock()
                            .await
                            .insert(hello.session_id, session.clone())
                        {
                            finish_media_session(
                                hello.session_id,
                                &previous,
                                &frame_hub,
                                &media_controller,
                            )
                            .await?;
                        }
                        let mut response = Vec::new();
                        response.extend_from_slice(MAGIC);
                        response.push(PACKET_UDP_HELLO_ACK);
                        push_u64(&mut response, hello.session_id);
                        push_i64(&mut response, epoch_ms());
                        push_u16(&mut response, 1200);
                        socket.send_to(&response, peer).await?;
                    }
                    PACKET_UDP_SYNC_REQUEST => {
                        if data.len() != 4 + 1 + 8 + 4 + 8 {
                            continue;
                        }
                        let session_id = read_u64(data, 5)?;
                        if !sessions.lock().await.contains_key(&session_id) {
                            continue;
                        }
                        let sequence = read_u32(data, 13)?;
                        let t0 = read_i64(data, 17)?;
                        let t1 = epoch_ms();
                        let mut response = Vec::new();
                        response.extend_from_slice(MAGIC);
                        response.push(PACKET_UDP_SYNC_RESPONSE);
                        push_u64(&mut response, session_id);
                        push_u32(&mut response, sequence);
                        push_i64(&mut response, t0);
                        push_i64(&mut response, t1);
                        push_i64(&mut response, epoch_ms());
                        socket.send_to(&response, peer).await?;
                    }
                    PACKET_UDP_SYNC_RESULT => {
                        if data.len() != 4 + 1 + 8 + 4 + 8 + 8 + 4 {
                            continue;
                        }
                        let session_id = read_u64(data, 5)?;
                        let bounds = ClockBounds {
                            offset_min_ms: read_i64(data, 17)?,
                            offset_max_ms: read_i64(data, 25)?,
                            rtt_ms: read_u32(data, 33)?,
                        };
                        if let Some(session) = sessions.lock().await.get(&session_id).cloned() {
                            session.lock().await.update_clock(bounds);
                        }
                    }
                    PACKET_UDP_STOP => {
                        if data.len() < 13 { continue; }
                        let session_id = read_u64(data, 5)?;
                        if let Some(session) = sessions.lock().await.remove(&session_id) {
                            finish_media_session(
                                session_id,
                                &session,
                                &frame_hub,
                                &media_controller,
                            )
                            .await?;
                        }
                    }
                    PACKET_MEDIA | PACKET_PARITY => {
                        let packet = match MediaPacket::parse(data) {
                            Ok(packet) => packet,
                            Err(_) => continue,
                        };
                        if let Some(session) = sessions.lock().await.get(&packet.session_id).cloned() {
                            session.lock().await.accept_packet(packet)?;
                        }
                    }
                    _ => {}
                }
            }
            _ = interval.tick() => {
                let active = sessions.lock().await.values().cloned().collect::<Vec<_>>();
                for session in active {
                    let (peer, stats) = {
                        let mut state = session.lock().await;
                        state.cleanup_expired()?;
                        (state.peer, state.stats())
                    };
                    stats.emit();
                    let mut packet = Vec::new();
                    packet.extend_from_slice(MAGIC);
                    packet.push(PACKET_UDP_STATS);
                    push_u64(&mut packet, stats.session_id);
                    packet.extend_from_slice(&stats.control_payload(CONTROL_STATS)[1..]);
                    let _ = socket.send_to(&packet, peer).await;
                }
            }
        }
    }
}

async fn read_control_frame(recv: &mut quinn::RecvStream) -> Result<Vec<u8>> {
    let length = recv.read_u32().await? as usize;
    if length == 0 || length > MAX_CONTROL_FRAME {
        return Err(anyhow!("invalid control frame length"));
    }
    let mut data = vec![0_u8; length];
    recv.read_exact(&mut data).await?;
    Ok(data)
}

async fn write_control_frame(send: &Arc<Mutex<quinn::SendStream>>, data: &[u8]) -> Result<()> {
    let mut stream = send.lock().await;
    stream.write_u32(data.len() as u32).await?;
    stream.write_all(data).await?;
    Ok(())
}

fn parse_hello(data: &[u8], transport: &'static str) -> Result<Hello> {
    if data.len() < 13 || (data[0] != CONTROL_HELLO && data[0] != PACKET_UDP_HELLO) {
        return Err(anyhow!("invalid hello"));
    }
    if data[1] != PROTOCOL_VERSION {
        return Err(anyhow!("unsupported protocol version {}", data[1]));
    }
    let session_id = read_u64(data, 2)?;
    let path_length = read_u16(data, 11)? as usize;
    let path_start = 13;
    let path_end = path_start + path_length;
    if path_length == 0 || path_length > 1024 {
        return Err(anyhow!("invalid hello path"));
    }
    // 旧推流端不带音频采集组时长字段（20 字节尾）；新推流端带该字段
    // （24 字节尾）。两种都接受，保证对推流端透明。
    let has_audio_group_duration = data.len() == path_end + 24;
    if data.len() != path_end + 20 && !has_audio_group_duration {
        return Err(anyhow!("invalid hello path"));
    }
    let raw_path = std::str::from_utf8(&data[path_start..path_end])?;
    let path = normalize_stream_path(raw_path)?;
    Ok(Hello {
        session_id,
        transport,
        path,
        width: read_u16(data, path_end)?,
        height: read_u16(data, path_end + 2)?,
        fps: read_u16(data, path_end + 4)?,
        bitrate: read_u32(data, path_end + 6)?,
        audio_enabled: data[path_end + 10] != 0,
        audio_sample_rate: read_u32(data, path_end + 11)?,
        audio_channels: data[path_end + 15],
        audio_bitrate: read_u32(data, path_end + 16)?,
        audio_group_duration_us: if has_audio_group_duration {
            read_u32(data, path_end + 20)?
        } else {
            0
        },
    })
}

fn parse_sync_result(data: &[u8]) -> Result<ClockBounds> {
    if data.len() != 1 + 4 + 8 + 8 + 4 || data[0] != CONTROL_SYNC_RESULT {
        return Err(anyhow!("invalid sync result"));
    }
    Ok(ClockBounds {
        offset_min_ms: read_i64(data, 5)?,
        offset_max_ms: read_i64(data, 13)?,
        rtt_ms: read_u32(data, 21)?,
    })
}

fn hello_ack_payload(session_id: u64) -> Vec<u8> {
    let mut data = Vec::with_capacity(20);
    data.push(CONTROL_HELLO_ACK);
    push_u64(&mut data, session_id);
    push_i64(&mut data, epoch_ms());
    // 保留原 ACK 长度，末尾字段作为可靠流协议的保留位。
    push_u16(&mut data, 0);
    data.push(0);
    data
}

fn normalize_stream_path(raw: &str) -> Result<String> {
    let mut path = raw.trim().to_string();
    if path.is_empty() || path.len() > 1024 || path.as_bytes().contains(&0) {
        return Err(anyhow!("invalid stream path"));
    }
    if !path.starts_with('/') {
        path.insert(0, '/');
    }
    Ok(path)
}

fn sanitize_path(path: &str) -> String {
    let mut result = String::with_capacity(path.len().min(80));
    for character in path.chars().take(80) {
        if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
            result.push(character);
        } else if !result.ends_with('-') {
            result.push('-');
        }
    }
    result.trim_matches('-').to_string().if_empty("stream")
}

fn media_path(directory: &Path, kind: &str, hello: &Hello) -> PathBuf {
    directory.join(format!(
        "{}-{}-{}-{:016x}.mp4",
        sanitize_path(&hello.path),
        kind,
        epoch_ms(),
        hello.session_id
    ))
}

trait IfEmpty {
    fn if_empty(self, fallback: &str) -> String;
}

impl IfEmpty for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

fn emit_published(
    hello: &Hello,
    peer: SocketAddr,
    frame_hub: &FrameHub,
    recording_path: Option<&std::path::Path>,
) {
    emit_json(json!({
        "type": "published",
        "sessionId": format!("{:016x}", hello.session_id),
        "protocol": "quic",
        "transport": hello.transport,
        "streamPath": hello.path,
        "ip": peer.ip().to_string(),
        "width": hello.width,
        "height": hello.height,
        "fps": hello.fps,
        "bitrate": hello.bitrate,
        "audioEnabled": hello.audio_enabled,
        "audioSampleRate": hello.audio_sample_rate,
        "audioChannels": hello.audio_channels,
        "audioBitrate": hello.audio_bitrate,
        "audioGroupDurationUs": hello.audio_group_duration_us,
        "httpPlaybackPath": frame_hub.playback_path(&hello.path),
        "recordingPath": recording_path,
        "active": true,
        "recordingEnabled": false,
        "replayBuffering": false,
        "replayDurationMs": null,
    }));
}

fn emit_publish_ended(hello: &Hello, peer: SocketAddr, status: &RuntimeMediaStatus) {
    emit_json(json!({
        "type": "publish-ended",
        "sessionId": format!("{:016x}", status.session_id),
        "protocol": "quic",
        "transport": hello.transport,
        "streamPath": hello.path,
        "ip": peer.ip().to_string(),
        "active": false,
        "recordingEnabled": false,
        "replayBuffering": status.replay_duration_ms.is_some(),
        "replayDurationMs": status.replay_duration_ms,
        "recordingPath": status.recording_path,
    }));
}

fn sequence_forward_distance(expected: u32, actual: u32) -> Option<u32> {
    let distance = actual.wrapping_sub(expected);
    (distance != 0 && distance < (1_u32 << 31)).then_some(distance)
}

fn sequence_is_before(value: u32, reference: u32) -> bool {
    let distance = reference.wrapping_sub(value);
    distance != 0 && distance < (1_u32 << 31)
}

fn epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn read_u16(data: &[u8], offset: usize) -> Result<u16> {
    let bytes: [u8; 2] = data
        .get(offset..offset + 2)
        .ok_or_else(|| anyhow!("truncated u16"))?
        .try_into()
        .unwrap();
    Ok(u16::from_be_bytes(bytes))
}

fn read_u32(data: &[u8], offset: usize) -> Result<u32> {
    let bytes: [u8; 4] = data
        .get(offset..offset + 4)
        .ok_or_else(|| anyhow!("truncated u32"))?
        .try_into()
        .unwrap();
    Ok(u32::from_be_bytes(bytes))
}

fn read_u64(data: &[u8], offset: usize) -> Result<u64> {
    let bytes: [u8; 8] = data
        .get(offset..offset + 8)
        .ok_or_else(|| anyhow!("truncated u64"))?
        .try_into()
        .unwrap();
    Ok(u64::from_be_bytes(bytes))
}

fn read_i64(data: &[u8], offset: usize) -> Result<i64> {
    let bytes: [u8; 8] = data
        .get(offset..offset + 8)
        .ok_or_else(|| anyhow!("truncated i64"))?
        .try_into()
        .unwrap();
    Ok(i64::from_be_bytes(bytes))
}

fn push_u16(data: &mut Vec<u8>, value: u16) {
    data.extend_from_slice(&value.to_be_bytes());
}
fn push_u32(data: &mut Vec<u8>, value: u32) {
    data.extend_from_slice(&value.to_be_bytes());
}
fn push_u64(data: &mut Vec<u8>, value: u64) {
    data.extend_from_slice(&value.to_be_bytes());
}
fn push_i32(data: &mut Vec<u8>, value: i32) {
    data.extend_from_slice(&value.to_be_bytes());
}
fn push_i64(data: &mut Vec<u8>, value: i64) {
    data.extend_from_slice(&value.to_be_bytes());
}

#[cfg(test)]
mod tests {
    use super::{
        parse_hello, push_i64, push_u16, push_u32, push_u64, sequence_forward_distance,
        sequence_is_before, ClockBounds, ClockEstimator, FrameHub, Hello, MediaPacket, Options,
        ReplayBuffer, RuntimeCommand, RuntimeMediaController, SessionState, CONTROL_HELLO,
        FLAG_RELIABLE_COPY, MAGIC, PACKET_MEDIA, PROTOCOL_VERSION,
    };
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    const AVC_CONFIG: &[u8] = &[
        1, 100, 0, 31, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x1f, 1, 0x00, 0x02, 0x68, 0xee,
    ];
    const KEYFRAME: &[u8] = &[0, 0, 0, 2, 0x65, 0x88];

    async fn register_test_session(
        controller: &RuntimeMediaController,
        hub: &FrameHub,
        recording_dir: &Path,
        session_id: u64,
        path: &str,
    ) -> std::sync::Arc<tokio::sync::Mutex<SessionState>> {
        let options = Options {
            bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 1935,
            udp_fallback_port: None,
            recording_dir: recording_dir.to_path_buf(),
            max_latency_ms: 150,
            reorder_window_ms: 12,
            synchronize_pull_streams: false,
            include_audio_in_pull: false,
        };
        let hello = Hello {
            session_id,
            transport: "quic",
            path: path.to_string(),
            width: 1920,
            height: 1080,
            fps: 30,
            bitrate: 8_000_000,
            audio_enabled: false,
            audio_sample_rate: 0,
            audio_channels: 0,
            audio_bitrate: 0,
            audio_group_duration_us: 0,
        };
        let buffer = hub.register(session_id, path, false, false, 0, 0);
        controller
            .register(
                SessionState::create(
                    hello,
                    SocketAddr::from((Ipv4Addr::LOCALHOST, 40000)),
                    &options,
                    buffer,
                )
                .unwrap(),
            )
            .await
            .unwrap()
    }

    #[test]
    fn hello_carries_audio_capture_group_duration() {
        let path = b"/test";
        let mut data = vec![CONTROL_HELLO, PROTOCOL_VERSION];
        push_u64(&mut data, 7);
        data.push(0);
        push_u16(&mut data, path.len() as u16);
        data.extend_from_slice(path);
        push_u16(&mut data, 1920);
        push_u16(&mut data, 1080);
        push_u16(&mut data, 30);
        push_u32(&mut data, 8_000_000);
        data.push(1);
        push_u32(&mut data, 48_000);
        data.push(2);
        push_u32(&mut data, 128_000);
        push_u32(&mut data, 40_000);

        let hello = parse_hello(&data, "quic").unwrap();
        assert_eq!(hello.audio_group_duration_us, 40_000);
    }

    #[test]
    fn sequence_distance_rejects_late_frames() {
        assert_eq!(sequence_forward_distance(10, 12), Some(2));
        assert_eq!(sequence_forward_distance(10, 10), None);
        assert_eq!(sequence_forward_distance(10, 9), None);
        assert!(sequence_is_before(9, 10));
    }

    #[test]
    fn sequence_distance_supports_wraparound() {
        assert_eq!(sequence_forward_distance(u32::MAX, 0), Some(1));
        assert!(!sequence_is_before(0, u32::MAX));
        assert!(sequence_is_before(u32::MAX, 0));
    }

    #[test]
    fn clock_estimator_handles_unix_epoch_values_without_precision_loss() {
        let mut estimator = ClockEstimator::default();
        let client_start = 1_750_000_000_000_i64;
        let offset = 1_234_i64;
        for step in 0..8_i64 {
            let client_ms = client_start + step * 1_000;
            let server_ms = client_ms + offset;
            estimator.observe_sync(
                ClockBounds {
                    offset_min_ms: offset - 2,
                    offset_max_ms: offset + 2,
                    rtt_ms: 8,
                },
                server_ms,
            );
        }

        assert!(estimator.ready);
        assert_eq!(estimator.predict(client_start + 12_345), Some(client_start + 12_345 + offset));
    }

    #[test]
    fn first_sync_sample_replaces_arrival_cold_start_sample() {
        let mut estimator = ClockEstimator::default();
        estimator.observe_arrival(1_750_000_000_000, 1_750_000_000_200);
        estimator.observe_sync(
            ClockBounds {
                offset_min_ms: 1_000,
                offset_max_ms: 1_000,
                rtt_ms: 5,
            },
            1_750_000_001_000,
        );
        assert!(estimator.has_sync_samples);
        assert_eq!(estimator.samples.len(), 1);
        assert_eq!(estimator.samples[0], (1_750_000_000_000_f64, 1_750_000_001_000_f64));
    }

    #[test]
    fn reliable_sequence_wraparound_keeps_frames_in_order() {
        let options = Options {
            bind: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 1935,
            udp_fallback_port: None,
            recording_dir: std::env::temp_dir().join("livesuite-reliable-wrap-test"),
            max_latency_ms: 150,
            reorder_window_ms: 12,
            synchronize_pull_streams: false,
            include_audio_in_pull: false,
        };
        let hub = FrameHub::new(false, 150);
        let buffer = hub.register(7, "/wrap", false, false, 0, 0);
        let hello = Hello {
            session_id: 7,
            transport: "quic",
            path: "/wrap".to_string(),
            width: 1920,
            height: 1080,
            fps: 30,
            bitrate: 8_000_000,
            audio_enabled: false,
            audio_sample_rate: 0,
            audio_channels: 0,
            audio_bitrate: 0,
            audio_group_duration_us: 0,
        };
        let mut state = SessionState::create(
            hello,
            SocketAddr::from((Ipv4Addr::LOCALHOST, 40000)),
            &options,
            buffer.clone(),
        )
        .unwrap();

        for (index, frame_id) in [u32::MAX - 1, u32::MAX, 0, 1].into_iter().enumerate() {
            let nal_type = if index == 0 { 0x65 } else { 0x41 };
            let payload = vec![0, 0, 0, 2, nal_type, index as u8];
            let mut packet = Vec::with_capacity(60 + payload.len());
            packet.extend_from_slice(MAGIC);
            packet.push(PACKET_MEDIA);
            packet.push(FLAG_RELIABLE_COPY);
            push_u16(&mut packet, 60);
            push_u64(&mut packet, 7);
            push_u32(&mut packet, frame_id);
            push_i64(&mut packet, 0);
            push_i64(&mut packet, 0);
            push_i64(&mut packet, index as i64 * 33_333);
            push_u32(&mut packet, payload.len() as u32);
            push_u16(&mut packet, 0);
            push_u16(&mut packet, 1);
            push_u16(&mut packet, 0);
            packet.push(1);
            packet.push(0);
            push_u16(&mut packet, payload.len() as u16);
            push_u16(&mut packet, payload.len() as u16);
            packet.extend_from_slice(&payload);
            let parsed = MediaPacket::parse(&packet).unwrap();
            state.accept_reliable(parsed).unwrap();
        }

        let (_, _, frames) = buffer.take_frames(0);
        assert_eq!(frames.len(), 4);
        assert_eq!(frames[0].pts_us, 0);
        assert_eq!(frames[1].pts_us, 33_333);
        assert_eq!(frames[2].pts_us, 66_666);
        assert_eq!(frames[3].pts_us, 99_999);
    }

    #[test]
    fn runtime_command_parses_a_scoped_session() {
        let command = RuntimeCommand::parse(
            r#"{"commandId":"7","action":"start-recording","sessionId":"00000000000000af"}"#,
        )
        .unwrap();
        assert_eq!(command.session_id, Some(0xaf));

        let unscoped =
            RuntimeCommand::parse(r#"{"commandId":"8","action":"start-recording"}"#).unwrap();
        assert_eq!(unscoped.session_id, None);
        assert!(RuntimeCommand::parse(
            r#"{"commandId":"9","action":"start-recording","sessionId":"not-hex"}"#
        )
        .is_err());
    }

    #[tokio::test]
    async fn media_controls_are_isolated_per_session() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let recording_dir = std::env::temp_dir().join(format!("livesuite-session-media-{suffix}"));
        let controller = RuntimeMediaController::new(PathBuf::from(&recording_dir));
        let hub = FrameHub::new(false, 150);
        let first = register_test_session(&controller, &hub, &recording_dir, 1, "/first").await;
        let second = register_test_session(&controller, &hub, &recording_dir, 2, "/second").await;

        controller.start_recording(1).await.unwrap();
        controller.start_replay_buffer(2, 30_000).await.unwrap();
        {
            let mut state = second.lock().await;
            state.avc_config = Some(AVC_CONFIG.to_vec());
            state.replay_buffer = Some(ReplayBuffer::new(
                30_000,
                Some(AVC_CONFIG),
                None,
                false,
                0,
                0,
                0,
            ));
            state
                .replay_buffer
                .as_mut()
                .unwrap()
                .push(0, true, KEYFRAME);
        }

        let first_status = controller.status(1).await;
        let second_status = controller.status(2).await;
        assert!(first_status.recording_enabled);
        assert!(first_status.replay_duration_ms.is_none());
        assert!(!second_status.recording_enabled);
        assert_eq!(second_status.replay_duration_ms, Some(30_000));

        let ended_status = controller.unregister(2, &second).await.unwrap();
        assert!(!ended_status.active);
        assert_eq!(ended_status.replay_duration_ms, Some(30_000));
        let exported = controller.save_replay_buffer(2).await.unwrap();
        assert_eq!(exported.len(), 1);
        assert!(exported[0].is_file());

        controller.stop_recording(1).await.unwrap();
        controller.stop_replay_buffer(2).await.unwrap();
        assert!(!controller.status(1).await.recording_enabled);
        assert!(controller.status(2).await.replay_duration_ms.is_none());
        drop(first);
        let _ = std::fs::remove_dir_all(recording_dir);
    }
}
