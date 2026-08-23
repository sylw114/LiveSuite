//! 会话帧缓冲:接收端(QUIC/UDP)把组装好的媒体帧写入每会话环形缓冲与 GOP 快照,
//! Node 拉流侧通过 `take_frames` 轮询取帧。同步调度所需的帧元数据
//! (ordinal / timeline_us / release_epoch_ms / 延迟样本)仍在 Rust 侧计算,
//! 因为时钟预测与同步设置在这里。HTTP-FLV 封装与连接状态在 Node(`src/main/quicPull.ts`)。

use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// 帧类型常量,与 Node 侧 `quicPull.ts` 保持一致。
pub const RAW_VIDEO_CONFIG: u8 = 1;
pub const RAW_KEYFRAME: u8 = 2;
pub const RAW_DELTA: u8 = 3;
pub const RAW_AUDIO_CONFIG: u8 = 4;
pub const RAW_END: u8 = 5;
pub const RAW_AUDIO: u8 = 6;

/// 环形缓冲与 GOP 缓存上限。
const MAX_CACHED_GOP_FRAMES: usize = 240;
const MAX_CACHED_GOP_BYTES: usize = 32 * 1024 * 1024;
const MAX_RING_FRAMES: usize = 600;
const MAX_RING_BYTES: usize = 32 * 1024 * 1024;
const MAX_AUDIO_GROUP_DURATION_US: i64 = 2_000_000;
const MIN_ALIGNMENT_DELAY_MS: u64 = 60;
// 新流接入或网络恢复时,最慢流可能需要数秒的额外缓冲;环形缓冲和
// 浏览器端的调速闭环会负责让已经播放的流平滑追上这个新延迟。
const MAX_ALIGNMENT_DELAY_MS: u64 = 10_000;

#[derive(Clone, Debug)]
pub struct OutputFrame {
    pub ordinal: u64,
    pub kind: u8,
    pub pts_us: i64,
    /// 统一到服务端时钟轴的采集时刻(微秒)。同步开启且有采集时钟时
    /// 使用预测出的服务端墙钟时间,否则为 None 并回退到编码器 PTS。
    pub timeline_us: Option<i64>,
    pub release_epoch_ms: Option<i64>,
    pub data: Arc<[u8]>,
}

impl OutputFrame {
    /// FLV 时间轴取值:优先服务端时钟轴(音视频共用,天然单调一致),
    /// 无时钟预测时回退到各自编码器 PTS。Node 拉流侧使用等价逻辑。
    #[allow(dead_code)]
    pub fn media_time_us(&self) -> i64 {
        self.timeline_us.unwrap_or(self.pts_us)
    }
}

#[derive(Debug, Default)]
struct StreamGopCache {
    video_config: Option<OutputFrame>,
    audio_config: Option<OutputFrame>,
    gop: VecDeque<OutputFrame>,
    gop_bytes: usize,
}

#[derive(Debug, Default)]
struct FrameRing {
    frames: VecDeque<OutputFrame>,
    bytes: usize,
    cache: StreamGopCache,
    closed: bool,
}

#[derive(Debug, Default)]
struct SyncSettings {
    synchronize: AtomicBool,
    sync_delay_ms: AtomicU64,
}

impl SyncSettings {
    fn new(synchronize: bool, sync_delay_ms: u64) -> Self {
        Self {
            synchronize: AtomicBool::new(synchronize),
            sync_delay_ms: AtomicU64::new(sync_delay_ms),
        }
    }
}

#[derive(Debug)]
pub struct FrameBuffer {
    session_id: u64,
    stream_path: String,
    next_ordinal: AtomicU64,
    ring: Mutex<FrameRing>,
    /// 同步开启时逐帧观测的端到端延迟(服务端收到时刻 - 预测采集时刻)。
    latency_samples: Mutex<VecDeque<i64>>,
    /// 首帧预测出的服务端采集时刻,用于拉流网页把 FLV 时间轴换算回服务端墙钟。
    origin_server_ms: AtomicI64,
    sync: Arc<SyncSettings>,
    include_audio: bool,
    audio_available: bool,
    #[allow(dead_code)]
    audio_channels: u8,
    #[allow(dead_code)]
    audio_group_duration_us: i64,
}

impl FrameBuffer {
    fn new(
        session_id: u64,
        stream_path: String,
        include_audio: bool,
        audio_available: bool,
        audio_channels: u8,
        audio_group_duration_us: u32,
        sync: Arc<SyncSettings>,
    ) -> Self {
        Self {
            session_id,
            stream_path,
            next_ordinal: AtomicU64::new(1),
            ring: Mutex::new(FrameRing::default()),
            latency_samples: Mutex::new(VecDeque::new()),
            origin_server_ms: AtomicI64::new(0),
            sync,
            include_audio,
            audio_available,
            audio_channels,
            audio_group_duration_us: i64::from(audio_group_duration_us)
                .min(MAX_AUDIO_GROUP_DURATION_US),
        }
    }

    #[allow(dead_code)]
    pub fn session_id(&self) -> u64 {
        self.session_id
    }

    #[allow(dead_code)]
    pub fn stream_path(&self) -> &str {
        &self.stream_path
    }

    #[allow(dead_code)]
    pub fn audio_channels(&self) -> u8 {
        self.audio_channels
    }

    #[allow(dead_code)]
    pub fn audio_group_duration_us(&self) -> i64 {
        self.audio_group_duration_us
    }

    /// 当前流观测到的端到端延迟 P95(毫秒),无样本时为 None。
    fn latency_p95_ms(&self) -> Option<i64> {
        let samples = self
            .latency_samples
            .lock()
            .expect("frame buffer latency lock poisoned");
        if samples.is_empty() {
            return None;
        }
        let mut sorted = samples.iter().copied().collect::<Vec<_>>();
        sorted.sort_unstable();
        let index = ((sorted.len() as f64 * 0.95).ceil() as usize)
            .saturating_sub(1)
            .min(sorted.len() - 1);
        Some(sorted[index])
    }

    /// 首帧预测的服务端采集时刻(毫秒),尚未建立时返回 None。
    fn origin_server_ms(&self) -> Option<i64> {
        let value = self.origin_server_ms.load(Ordering::Relaxed);
        (value > 0).then_some(value)
    }

    pub fn publish_video_config(&self, pts_us: i64, capture_epoch_ms: Option<i64>, data: &[u8]) {
        let frame = self.frame(RAW_VIDEO_CONFIG, pts_us, capture_epoch_ms, data);
        let mut ring = self.ring.lock().expect("frame buffer ring lock poisoned");
        ring.cache.video_config = Some(frame.clone());
        ring.cache.gop.clear();
        ring.cache.gop_bytes = 0;
        self.push_locked(&mut ring, frame);
    }

    pub fn publish_video(&self, pts_us: i64, capture_epoch_ms: Option<i64>, keyframe: bool, data: &[u8]) {
        // 同步模式下,时钟模型建立前的到达时刻不能混入公共时间轴。
        // 等预测出的服务端时间可用后再接收媒体,避免同一流的起点从
        // "网络到达时间"跳到"采集时间",也避免不同流各自带入不同网络延迟。
        if self.sync.synchronize.load(Ordering::Relaxed) && capture_epoch_ms.is_none() {
            return;
        }
        let kind = if keyframe { RAW_KEYFRAME } else { RAW_DELTA };
        let frame = self.frame(kind, pts_us, capture_epoch_ms, data);
        let mut ring = self.ring.lock().expect("frame buffer ring lock poisoned");
        if keyframe {
            ring.cache.gop.clear();
            ring.cache.gop_bytes = 0;
        }
        if keyframe || !ring.cache.gop.is_empty() {
            ring.cache.gop_bytes = ring.cache.gop_bytes.saturating_add(frame.data.len());
            ring.cache.gop.push_back(frame.clone());
            if ring.cache.gop.len() > MAX_CACHED_GOP_FRAMES
                || ring.cache.gop_bytes > MAX_CACHED_GOP_BYTES
            {
                ring.cache.gop.clear();
                ring.cache.gop_bytes = 0;
            }
        }
        self.push_locked(&mut ring, frame);
    }

    pub fn publish_audio_config(&self, pts_us: i64, capture_epoch_ms: Option<i64>, data: &[u8]) {
        if !self.include_audio || !self.audio_available {
            return;
        }
        let frame = self.frame(RAW_AUDIO_CONFIG, pts_us, capture_epoch_ms, data);
        let mut ring = self.ring.lock().expect("frame buffer ring lock poisoned");
        ring.cache.audio_config = Some(frame.clone());
        self.push_locked(&mut ring, frame);
    }

    pub fn publish_audio(&self, pts_us: i64, capture_epoch_ms: Option<i64>, data: &[u8]) {
        if !self.include_audio || !self.audio_available {
            return;
        }
        if self.sync.synchronize.load(Ordering::Relaxed) && capture_epoch_ms.is_none() {
            return;
        }
        let frame = self.frame(RAW_AUDIO, pts_us, capture_epoch_ms, data);
        let mut ring = self.ring.lock().expect("frame buffer ring lock poisoned");
        if !ring.cache.gop.is_empty() {
            ring.cache.gop_bytes = ring.cache.gop_bytes.saturating_add(frame.data.len());
            ring.cache.gop.push_back(frame.clone());
            if ring.cache.gop.len() > MAX_CACHED_GOP_FRAMES
                || ring.cache.gop_bytes > MAX_CACHED_GOP_BYTES
            {
                ring.cache.gop.clear();
                ring.cache.gop_bytes = 0;
            }
        }
        self.push_locked(&mut ring, frame);
    }

    pub fn finish(&self) {
        let frame = self.frame(RAW_END, 0, None, &[]);
        let mut ring = self.ring.lock().expect("frame buffer ring lock poisoned");
        ring.closed = true;
        ring.cache.gop.push_back(frame.clone());
        self.push_locked(&mut ring, frame);
    }

    fn frame(&self, kind: u8, pts_us: i64, capture_epoch_ms: Option<i64>, data: &[u8]) -> OutputFrame {
        let now = epoch_ms();
        let synchronize = self.sync.synchronize.load(Ordering::Relaxed);
        let sync_delay_ms = self.sync.sync_delay_ms.load(Ordering::Relaxed) as i64;
        // 采集时刻统一映射到服务端时钟轴:有预测用预测值,否则用到达时刻。
        let base_ms = if synchronize {
            capture_epoch_ms.unwrap_or(now)
        } else {
            now
        };
        if synchronize && matches!(kind, RAW_KEYFRAME | RAW_DELTA | RAW_AUDIO) {
            let latency = now.saturating_sub(base_ms);
            if latency >= 0 && latency < 10_000 {
                let mut samples = self
                    .latency_samples
                    .lock()
                    .expect("frame buffer latency lock poisoned");
                samples.push_back(latency);
                while samples.len() > 240 {
                    samples.pop_front();
                }
            }
            let _ = self.origin_server_ms.compare_exchange(
                0,
                base_ms.max(1),
                Ordering::Relaxed,
                Ordering::Relaxed,
            );
        }
        let release_epoch_ms = if synchronize {
            // 多流同步以校正后的采集时刻为基准;发送端时钟不可用时按到达
            // 时刻延迟,保证拉流端仍获得一致延迟。释放时间有界,避免发送
            // 端时钟异常把释放时刻推到未来很远导致拉流永远等待。
            let release = base_ms.saturating_add(sync_delay_ms);
            let max_hold = sync_delay_ms.saturating_mul(2).max(500);
            Some(release.clamp(now.saturating_sub(max_hold), now.saturating_add(max_hold)))
        } else if self.include_audio
            && self.audio_available
            && matches!(kind, RAW_KEYFRAME | RAW_DELTA | RAW_AUDIO)
        {
            Some(now.saturating_add(50))
        } else {
            None
        };
        OutputFrame {
            ordinal: self.next_ordinal.fetch_add(1, Ordering::Relaxed),
            kind,
            pts_us,
            timeline_us: if synchronize {
                Some(base_ms.saturating_mul(1000))
            } else {
                None
            },
            release_epoch_ms,
            data: Arc::from(data),
        }
    }

    fn push_locked(&self, ring: &mut FrameRing, frame: OutputFrame) {
        ring.bytes = ring.bytes.saturating_add(frame.data.len());
        ring.frames.push_back(frame);
        // 超出环形缓冲预算时从最旧帧淘汰。
        while ring.frames.len() > MAX_RING_FRAMES || ring.bytes > MAX_RING_BYTES {
            if let Some(dropped) = ring.frames.pop_front() {
                ring.bytes = ring.bytes.saturating_sub(dropped.data.len());
            } else {
                break;
            }
        }
    }

    /// 取出 ordinal 大于 `after_ordinal` 的帧。
    /// - `after_ordinal == 0`: 请求初始快照(返回当前配置 + 当前 GOP 帧, resync=false);
    /// - `after_ordinal > 0` 且落后于环形缓冲: 返回最新快照与 resync=true 供拉流端重建状态;
    /// - `after_ordinal > 0` 且正常: 返回大于 after_ordinal 的增量帧与 resync=false;
    /// - `closed=true` 表示流已结束。
    pub fn take_frames(&self, after_ordinal: u64) -> (bool, bool, Vec<OutputFrame>) {
        let ring = self.ring.lock().expect("frame buffer ring lock poisoned");
        if after_ordinal == 0 {
            let mut snapshot = Vec::with_capacity(ring.cache.gop.len() + 2);
            if let Some(config) = &ring.cache.video_config {
                snapshot.push(config.clone());
            }
            if let Some(config) = &ring.cache.audio_config {
                snapshot.push(config.clone());
            }
            let mut media = ring.cache.gop.iter().cloned().collect::<Vec<_>>();
            media.sort_by_key(|frame| (frame.media_time_us(), frame.ordinal));
            snapshot.extend(media);
            return (false, ring.closed, snapshot);
        }

        if let Some(first) = ring.frames.front() {
            if after_ordinal < first.ordinal {
                let mut snapshot = Vec::with_capacity(ring.cache.gop.len() + 2);
                if let Some(config) = &ring.cache.video_config {
                    snapshot.push(config.clone());
                }
                if let Some(config) = &ring.cache.audio_config {
                    snapshot.push(config.clone());
                }
                let mut media = ring.cache.gop.iter().cloned().collect::<Vec<_>>();
                media.sort_by_key(|frame| (frame.media_time_us(), frame.ordinal));
                snapshot.extend(media);
                return (true, ring.closed, snapshot);
            }
        }

        let frames = ring
            .frames
            .iter()
            .filter(|frame| frame.ordinal > after_ordinal)
            .cloned()
            .collect::<Vec<_>>();
        (false, ring.closed, frames)
    }
}

#[derive(Debug, Default)]
struct HubState {
    by_id: HashMap<u64, Arc<FrameBuffer>>,
}

#[derive(Clone, Debug)]
pub struct FrameHub {
    state: Arc<Mutex<HubState>>,
    sync: Arc<SyncSettings>,
}

impl FrameHub {
    pub fn new(synchronize: bool, sync_delay_ms: u64) -> Self {
        Self {
            state: Arc::new(Mutex::new(HubState::default())),
            sync: Arc::new(SyncSettings::new(synchronize, sync_delay_ms)),
        }
    }

    pub fn set_synchronize(&self, enabled: bool) {
        self.sync.synchronize.store(enabled, Ordering::Relaxed);
        if enabled {
            self.update_alignment_delay();
        }
    }

    pub fn synchronize_enabled(&self) -> bool {
        self.sync.synchronize.load(Ordering::Relaxed)
    }

    /// 重新计算对齐延迟:取所有已注册流中端到端延迟 P95 的最大值,
    /// 加上抖动余量后写入共享的同步延迟,保证被选同步的流都有足够缓冲
    /// 平滑播放。延迟有上下界,避免极端样本把延迟推得过高或过低。
    /// 仅同步开启时生效,关闭同步保持原值供播放器参考。
    pub fn update_alignment_delay(&self) {
        if !self.synchronize_enabled() {
            return;
        }
        let mut worst_p95 = 0_i64;
        {
            let state = self.state.lock().expect("frame hub lock poisoned");
            for buffer in state.by_id.values() {
                if let Some(p95) = buffer.latency_p95_ms() {
                    worst_p95 = worst_p95.max(p95);
                }
            }
        }
        let margin = (worst_p95.max(0) as f64 * 0.25).ceil() as u64 + 30;
        let delay = (worst_p95.max(0) as u64)
            .saturating_add(margin)
            .clamp(MIN_ALIGNMENT_DELAY_MS, MAX_ALIGNMENT_DELAY_MS);
        self.sync.sync_delay_ms.store(delay, Ordering::Relaxed);
    }

    /// 当前对齐延迟(毫秒),供拉流端按服务端时钟 + 对齐延迟调度播放。
    pub fn alignment_delay_ms(&self) -> u64 {
        self.sync.sync_delay_ms.load(Ordering::Relaxed)
    }

    /// 同步信息 JSON:服务端墙钟、对齐延迟、各流首帧服务端采集时刻与
    /// 延迟 P95。拉流网页据此把 FLV 时间轴换算回服务端时钟并统一调度。
    pub fn sync_info_json(&self) -> String {
        let mut streams = Vec::new();
        {
            let state = self.state.lock().expect("frame hub lock poisoned");
            for buffer in state.by_id.values() {
                streams.push(json!({
                    "path": buffer.stream_path,
                    "originServerMs": buffer.origin_server_ms().unwrap_or(0),
                    "latencyP95Ms": buffer.latency_p95_ms().unwrap_or(0),
                }));
            }
        }
        serde_json::to_string(&json!({
            "serverEpochMs": epoch_ms(),
            "alignmentDelayMs": self.alignment_delay_ms(),
            "synchronize": self.synchronize_enabled(),
            "streams": streams,
        }))
        .expect("sync info serialization cannot fail")
    }

    pub fn register(
        &self,
        session_id: u64,
        stream_path: &str,
        include_audio: bool,
        audio_available: bool,
        audio_channels: u8,
        audio_group_duration_us: u32,
    ) -> Arc<FrameBuffer> {
        let buffer = Arc::new(FrameBuffer::new(
            session_id,
            stream_path.to_string(),
            include_audio,
            audio_available,
            audio_channels,
            audio_group_duration_us,
            self.sync.clone(),
        ));
        let mut state = self.state.lock().expect("frame hub lock poisoned");
        if let Some(previous) = state.by_id.insert(session_id, buffer.clone()) {
            previous.finish();
        }
        buffer
    }

    pub fn unregister(&self, buffer: &Arc<FrameBuffer>) {
        let mut state = self.state.lock().expect("frame hub lock poisoned");
        let is_current = state
            .by_id
            .get(&buffer.session_id)
            .is_some_and(|current| Arc::ptr_eq(current, buffer));
        if is_current {
            state.by_id.remove(&buffer.session_id);
        }
        buffer.finish();
    }

    pub fn take_frames(
        &self,
        session_id: u64,
        after_ordinal: u64,
    ) -> Option<(bool, bool, Vec<OutputFrame>)> {
        let state = self.state.lock().expect("frame hub lock poisoned");
        state
            .by_id
            .get(&session_id)
            .map(|buffer| buffer.take_frames(after_ordinal))
    }

    pub fn playback_path(&self, stream_path: &str) -> String {
        format!("{}.flv", percent_encode_path(stream_path))
    }
}

fn percent_encode_path(path: &str) -> String {
    let mut output = String::with_capacity(path.len());
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.' | b'~') {
            output.push(byte as char);
        } else {
            output.push('%');
            output.push(hex_digit(byte >> 4));
            output.push(hex_digit(byte & 0x0f));
        }
    }
    output
}

fn hex_digit(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        _ => (b'A' + value - 10) as char,
    }
}

fn epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[cfg(test)]
mod tests {
    use super::{
        percent_encode_path, FrameHub, RAW_AUDIO, RAW_DELTA, RAW_VIDEO_CONFIG,
    };
    use std::sync::Arc;

    fn register_test_buffer(
        hub: &FrameHub,
        session_id: u64,
        stream_path: &str,
    ) -> Arc<crate::frame_hub::FrameBuffer> {
        hub.register(session_id, stream_path, false, false, 2, 0)
    }

    #[test]
    fn stream_paths_round_trip_through_playback() {
        let hub = FrameHub::new(false, 150);
        assert_eq!(
            hub.playback_path("/phone/stream"),
            "/phone/stream.flv".to_string()
        );
        assert_eq!(
            hub.playback_path("/中文/流"),
            "/%E4%B8%AD%E6%96%87/%E6%B5%81.flv".to_string()
        );
    }

    #[test]
    fn percent_encoding_keeps_ascii_path_segments() {
        assert_eq!(percent_encode_path("/a-b_c.d~e"), "/a-b_c.d~e");
        assert_eq!(percent_encode_path("/x y"), "/x%20y");
    }

    #[test]
    fn take_frames_returns_new_frames_only() {
        let hub = FrameHub::new(false, 150);
        let buffer = register_test_buffer(&hub, 7, "/test");
        buffer.publish_video_config(0, None, &[1, 2, 3]);
        buffer.publish_video(40_000, None, true, &[4, 5]);
        buffer.publish_video(73_000, None, false, &[6]);
        let (resync, closed, frames) = buffer.take_frames(0);
        assert!(!closed);
        assert!(!resync);
        assert_eq!(frames.len(), 3);
        let (resync, _, frames) = buffer.take_frames(frames[1].ordinal);
        assert!(!resync);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].kind, RAW_DELTA);
    }

    #[test]
    fn snapshot_contains_config_and_gop() {
        let hub = FrameHub::new(false, 150);
        let buffer = register_test_buffer(&hub, 8, "/late");
        buffer.publish_video_config(0, None, &[1]);
        buffer.publish_video(0, None, true, &[2]);
        buffer.publish_video(33_000, None, false, &[3]);
        // 新拉流方从 0 开始取,应得到全部帧(含配置帧与关键帧起步的 GOP)。
        let (resync, _, frames) = buffer.take_frames(0);
        assert!(!resync);
        assert!(frames.iter().any(|f| f.kind == RAW_VIDEO_CONFIG));
        assert_eq!(frames.len(), 3);
    }

    #[test]
    fn finish_marks_closed_with_end_frame() {
        let hub = FrameHub::new(false, 150);
        let buffer = register_test_buffer(&hub, 9, "/end");
        buffer.publish_video(0, None, true, &[2]);
        buffer.finish();
        let (_, closed, frames) = buffer.take_frames(0);
        assert!(closed);
        assert!(frames.iter().any(|f| f.kind == crate::frame_hub::RAW_END));
        // 再次取帧不再返回新帧。
        let (_, _, frames2) = buffer.take_frames(frames.last().map(|f| f.ordinal).unwrap_or(0));
        assert!(frames2.is_empty());
    }

    #[test]
    fn audio_frames_are_ignored_when_disabled() {
        let hub = FrameHub::new(false, 150);
        let buffer = register_test_buffer(&hub, 10, "/audio");
        buffer.publish_audio(0, None, &[7]);
        let (_, _, frames) = buffer.take_frames(0);
        assert!(frames.iter().all(|f| f.kind != RAW_AUDIO));
    }

    #[test]
    fn synchronized_buffer_drops_media_until_server_clock_is_predicted() {
        let hub = FrameHub::new(true, 150);
        let buffer = hub.register(11, "/synchronized", false, false, 0, 0);
        buffer.publish_video_config(0, None, &[1]);
        buffer.publish_video(0, None, true, &[2]);
        let (_, _, frames_before_clock) = buffer.take_frames(0);
        assert_eq!(frames_before_clock.len(), 1);
        assert_eq!(frames_before_clock[0].kind, RAW_VIDEO_CONFIG);

        buffer.publish_video(33_000, Some(1_750_000_000_000), true, &[3]);
        let (_, _, frames_after_clock) = buffer.take_frames(0);
        assert_eq!(frames_after_clock.len(), 2);
        assert_eq!(frames_after_clock[1].timeline_us, Some(1_750_000_000_000_000));
    }
}
