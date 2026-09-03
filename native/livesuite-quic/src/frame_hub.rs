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
// 新流接入或网络恢复时,最慢流可能需要数秒的额外缓冲;环形缓冲和
// 浏览器端的调速闭环会负责让已经播放的流平滑追上这个新延迟。
const MAX_ALIGNMENT_DELAY_MS: u64 = 10_000;
/// P95 的尾概率是 5%；统计窗口覆盖其倒数个实测 cadence，使单个异常批次
/// 在窗口成熟后不会决定 P95。这里定义的是无量纲统计比例，不是设备时延。
const LATENCY_P95_WINDOW_CADENCES: i64 = 20;
/// 共享延迟回落速度使用剩余差值的比例而不是固定毫秒数；1%/秒与播放器的
/// 无感校速档一致，较大的错误预算能尽快收回，接近目标时又不会来回抖动。
const ALIGNMENT_DECREASE_DIVISOR: u64 = 100;

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
    /// 启动配置的默认延迟：关闭同步时对齐延迟不会低于它。
    configured_delay_ms: u64,
    /// 当前对齐延迟扣除最慢稳定轨 P95 到达延迟后的处理余量(毫秒)。
    pull_lead_ms: AtomicU64,
}

impl SyncSettings {
    fn new(synchronize: bool, sync_delay_ms: u64) -> Self {
        let configured_delay_ms = sync_delay_ms.min(MAX_ALIGNMENT_DELAY_MS);
        Self {
            synchronize: AtomicBool::new(synchronize),
            // 同步模式先校准真实到达窗口，不能拿网络重排上限冒充显示预留。
            sync_delay_ms: AtomicU64::new(if synchronize { 0 } else { configured_delay_ms }),
            configured_delay_ms,
            pull_lead_ms: AtomicU64::new(0),
        }
    }

    /// 到达时间窗口确认新延迟水平后可以立即抬高对齐延迟；回落仍由全局
    /// 周期统计完成，不必在确认后再额外等待一次周期任务。
    fn raise_alignment_delay(&self, required_ms: i64, pull_lead_ms: i64) {
        let floor_ms = if self.synchronize.load(Ordering::Relaxed) {
            0
        } else {
            self.configured_delay_ms as i64
        };
        let required_ms = required_ms
            .max(floor_ms)
            .clamp(0, MAX_ALIGNMENT_DELAY_MS as i64) as u64;
        self.sync_delay_ms.fetch_max(required_ms, Ordering::Relaxed);
        self.pull_lead_ms.fetch_max(
            pull_lead_ms.max(0).min(MAX_ALIGNMENT_DELAY_MS as i64) as u64,
            Ordering::Relaxed,
        );
    }
}

#[derive(Clone, Copy, Debug)]
struct LatencyProfile {
    p50_ms: i64,
    p95_ms: i64,
    /// 相邻有效到达批次的 P95 间隔；音频还会取发送端采集组时长的较大者。
    cadence_ms: i64,
}

#[derive(Clone, Copy, Debug)]
struct LatencySample {
    observed_at_ms: i64,
    /// 由 `到达时刻 - 延迟` 还原出的服务端采集时刻。确认窗口同时要求
    /// 到达时钟和采集时钟都向前走，积压旧帧不能伪装成新的稳定延迟。
    capture_at_ms: i64,
    latency_ms: i64,
}

#[derive(Clone, Copy, Debug)]
struct AlignmentRequirement {
    required_ms: i64,
    pull_lead_ms: i64,
    increase_confirmed: bool,
    observation_complete: bool,
}

#[derive(Debug)]
pub struct FrameBuffer {
    session_id: u64,
    stream_path: String,
    next_ordinal: AtomicU64,
    ring: Mutex<FrameRing>,
    /// 逐帧观测的端到端延迟(服务端收到时刻 - 预测采集时刻)，按轨分开：
    /// 音频采集设备的固有延迟只出现在音频轨上，对齐延迟必须按最慢的轨预留。
    video_latency_samples: Mutex<VecDeque<LatencySample>>,
    audio_latency_samples: Mutex<VecDeque<LatencySample>>,
    /// 新流只有在实际到达时间窗口确认过当前延迟水平后才允许同步起播。
    /// 校准一旦完成不会因单个运行时异常样本重新阻塞新连接。
    video_alignment_calibrated: AtomicBool,
    audio_alignment_calibrated: AtomicBool,
    /// 首帧预测出的服务端采集时刻,用于拉流网页把 FLV 时间轴换算回服务端墙钟。
    origin_server_ms: AtomicI64,
    sync: Arc<SyncSettings>,
    include_audio: bool,
    audio_available: bool,
    #[allow(dead_code)]
    audio_channels: u8,
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
            video_latency_samples: Mutex::new(VecDeque::new()),
            audio_latency_samples: Mutex::new(VecDeque::new()),
            video_alignment_calibrated: AtomicBool::new(false),
            audio_alignment_calibrated: AtomicBool::new(!include_audio || !audio_available),
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

    /// 当前流观测到的端到端延迟 P95(毫秒)：取音视频两轨中较慢者，无样本时为 None。
    fn latency_p95_ms(&self) -> Option<i64> {
        match (self.video_latency_profile(), self.audio_latency_profile()) {
            (Some(video), Some(audio)) => Some(video.p95_ms.max(audio.p95_ms)),
            (Some(video), None) => Some(video.p95_ms),
            (None, Some(audio)) => Some(audio.p95_ms),
            (None, None) => None,
        }
    }

    fn video_latency_profile(&self) -> Option<LatencyProfile> {
        latency_profile(&self.video_latency_samples, 0)
    }

    fn audio_latency_profile(&self) -> Option<LatencyProfile> {
        latency_profile(
            &self.audio_latency_samples,
            self.audio_group_duration_us / 1000,
        )
    }

    fn video_latency_p95_ms(&self) -> Option<i64> {
        self.video_latency_profile().map(|profile| profile.p95_ms)
    }

    fn audio_latency_p95_ms(&self) -> Option<i64> {
        self.audio_latency_profile().map(|profile| profile.p95_ms)
    }

    fn video_arrival_cadence_ms(&self) -> Option<i64> {
        self.video_latency_profile()
            .map(|profile| profile.cadence_ms)
    }

    fn audio_arrival_cadence_ms(&self) -> Option<i64> {
        self.audio_latency_profile()
            .map(|profile| profile.cadence_ms)
    }

    /// 预算只使用稳定 P95 一次，再加一路真实到达批次的 P95 间隔作为拉流、
    /// 解码和 FIFO 提前量。尾部异常不再通过 `P99 + (P99-P50)` 被重复放大；
    /// 对音频，cadence 至少是发送端上报的实际 PCM 采集组时长。
    fn video_alignment_requirement(&self, current_ms: i64) -> Option<AlignmentRequirement> {
        alignment_requirement(&self.video_latency_samples, current_ms, 0)
    }

    fn audio_alignment_requirement(&self, current_ms: i64) -> Option<AlignmentRequirement> {
        alignment_requirement(
            &self.audio_latency_samples,
            current_ms,
            self.audio_group_duration_us / 1000,
        )
    }

    fn alignment_requirement(&self, current_ms: i64) -> Option<AlignmentRequirement> {
        match (
            self.video_alignment_requirement(current_ms),
            self.audio_alignment_requirement(current_ms),
        ) {
            (Some(video), Some(audio)) if video.required_ms == audio.required_ms => {
                Some(AlignmentRequirement {
                    required_ms: video.required_ms,
                    pull_lead_ms: video.pull_lead_ms.max(audio.pull_lead_ms),
                    increase_confirmed: video.increase_confirmed || audio.increase_confirmed,
                    observation_complete: video.observation_complete || audio.observation_complete,
                })
            }
            (Some(video), Some(audio)) => Some(if video.required_ms > audio.required_ms {
                video
            } else {
                audio
            }),
            (video, audio) => video.or(audio),
        }
    }

    fn alignment_ready(&self) -> bool {
        self.video_alignment_calibrated.load(Ordering::Relaxed)
            && self.audio_alignment_calibrated.load(Ordering::Relaxed)
    }

    fn record_latency(&self, kind: u8, latency_ms: i64, observed_at_ms: i64) {
        if latency_ms >= 10_000 {
            return;
        }
        // 四舍五入或最小 RTT 时钟模型可能让预测采集时刻领先本机约 1ms；
        // 物理到达延迟下界为零，不能因此永远卡住同步校准。
        let latency_ms = latency_ms.max(0);
        let samples = if kind == RAW_AUDIO {
            &self.audio_latency_samples
        } else {
            &self.video_latency_samples
        };
        let mut samples = samples.lock().expect("frame buffer latency lock poisoned");
        let source_group_ms = if kind == RAW_AUDIO {
            self.audio_group_duration_us / 1000
        } else {
            0
        };
        push_latency_sample(
            &mut samples,
            LatencySample {
                observed_at_ms,
                capture_at_ms: observed_at_ms.saturating_sub(latency_ms),
                latency_ms,
            },
            source_group_ms,
        );
        // 统计行为按真实到达时间而不是帧数定义；10 秒是全局允许的最大对齐
        // 范围，因此更旧的样本不可能再参与一次合法的延迟上调判定。
        let oldest_at_ms = observed_at_ms.saturating_sub(MAX_ALIGNMENT_DELAY_MS as i64);
        while samples
            .front()
            .is_some_and(|sample| sample.observed_at_ms < oldest_at_ms)
        {
            samples.pop_front();
        }
        drop(samples);

        let current_ms = self.sync.sync_delay_ms.load(Ordering::Relaxed) as i64;
        let requirement = if kind == RAW_AUDIO {
            let requirement = self.audio_alignment_requirement(current_ms);
            if requirement.is_some_and(|requirement| requirement.observation_complete) {
                self.audio_alignment_calibrated
                    .store(true, Ordering::Relaxed);
            }
            requirement
        } else {
            let requirement = self.video_alignment_requirement(current_ms);
            if requirement.is_some_and(|requirement| requirement.observation_complete) {
                self.video_alignment_calibrated
                    .store(true, Ordering::Relaxed);
            }
            requirement
        };
        if let Some(requirement) = requirement.filter(|requirement| {
            requirement.increase_confirmed && requirement.required_ms > current_ms
        }) {
            self.sync
                .raise_alignment_delay(requirement.required_ms, requirement.pull_lead_ms);
        }
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

    pub fn publish_video(
        &self,
        pts_us: i64,
        capture_epoch_ms: Option<i64>,
        keyframe: bool,
        data: &[u8],
    ) {
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

    fn frame(
        &self,
        kind: u8,
        pts_us: i64,
        capture_epoch_ms: Option<i64>,
        data: &[u8],
    ) -> OutputFrame {
        let now = epoch_ms();
        let synchronize = self.sync.synchronize.load(Ordering::Relaxed);
        // 采集时刻统一映射到服务端时钟轴:有预测用预测值,否则用到达时刻。
        let base_ms = if synchronize {
            capture_epoch_ms.unwrap_or(now)
        } else {
            now
        };
        if matches!(kind, RAW_KEYFRAME | RAW_DELTA | RAW_AUDIO) {
            if synchronize {
                let _ = self.origin_server_ms.compare_exchange(
                    0,
                    base_ms.max(1),
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                );
            }
            // 无论是否开启同步，只要时钟模型给出了预测采集时刻就记录到达延迟：
            // 关闭同步时它同样决定播放器需要预留多少显示延迟。
            if let Some(predicted_ms) = capture_epoch_ms {
                self.record_latency(kind, now.saturating_sub(predicted_ms), now);
            }
        }
        // record_latency 可能依据本帧的真实到达时间立即抬高共享延迟；在它
        // 之后重新读取，确保触发校准的首个慢音频帧也使用新释放时刻。
        let sync_delay_ms = self.sync.sync_delay_ms.load(Ordering::Relaxed) as i64;
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

    /// 重新计算对齐延迟：只让到达时钟与采集时钟都稳定推进的轨道参与共享
    /// 预算。持续发送旧时间戳的断流/积压轨由播放器丢帧恢复，不能拖着所有
    /// 正常流一起增加延迟。record_latency 会在真实时间窗口确认后立即抬高；
    /// 这里负责全局重算与按差值比例平滑回落。
    pub fn update_alignment_delay(&self) {
        let mut worst_p95 = 0_i64;
        let mut transition_pending = false;
        let mut required = if self.synchronize_enabled() {
            0
        } else {
            self.sync.configured_delay_ms as i64
        };
        let current = self.sync.sync_delay_ms.load(Ordering::Relaxed);
        {
            let state = self.state.lock().expect("frame hub lock poisoned");
            for buffer in state.by_id.values() {
                if let Some(requirement) = buffer.alignment_requirement(current as i64) {
                    if !requirement.increase_confirmed {
                        // 新延迟窗口尚在形成时维持现有预算，不能因为一个尚未
                        // 分类的异常批次反向触发回落；确认是陈旧时间戳后再忽略。
                        transition_pending |= !requirement.observation_complete;
                        continue;
                    }
                    worst_p95 = worst_p95.max(
                        requirement
                            .required_ms
                            .saturating_sub(requirement.pull_lead_ms),
                    );
                    if requirement.required_ms > required {
                        required = requirement.required_ms;
                    }
                }
            }
        }
        let worst_p95 = worst_p95.max(0);
        if transition_pending {
            required = required.max(current as i64);
        }
        let required = required.clamp(0, MAX_ALIGNMENT_DELAY_MS as i64) as u64;
        let next = if required >= current {
            required
        } else {
            let excess = current - required;
            let decrease =
                excess.saturating_add(ALIGNMENT_DECREASE_DIVISOR - 1) / ALIGNMENT_DECREASE_DIVISOR;
            required.max(current.saturating_sub(decrease.max(1)))
        };
        self.sync.sync_delay_ms.store(next, Ordering::Relaxed);
        self.sync.pull_lead_ms.store(
            (next as i64).saturating_sub(worst_p95).max(0) as u64,
            Ordering::Relaxed,
        );
    }

    /// 当前对齐延迟(毫秒),供拉流端按服务端时钟 + 对齐延迟调度播放。
    pub fn alignment_delay_ms(&self) -> u64 {
        self.sync.sync_delay_ms.load(Ordering::Relaxed)
    }

    /// 最慢稳定轨的 P95 帧到达拉流端后仍保证拥有的处理余量(毫秒)。
    pub fn pull_lead_ms(&self) -> u64 {
        self.sync.pull_lead_ms.load(Ordering::Relaxed)
    }

    /// 同步起播只有在每条已注册流的视频轨、以及声明有音频的音频轨都完成
    /// 实际到达时间窗口校准后才就绪。等待的是持续观测，不是包数或固定定时器。
    pub fn alignment_ready(&self) -> bool {
        if !self.synchronize_enabled() {
            return true;
        }
        let state = self.state.lock().expect("frame hub lock poisoned");
        !state.by_id.is_empty() && state.by_id.values().all(|buffer| buffer.alignment_ready())
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
                    "videoLatencyP95Ms": buffer.video_latency_p95_ms().unwrap_or(0),
                    "audioLatencyP95Ms": buffer.audio_latency_p95_ms().unwrap_or(0),
                    "videoArrivalCadenceP95Ms": buffer.video_arrival_cadence_ms().unwrap_or(0),
                    "audioArrivalCadenceP95Ms": buffer.audio_arrival_cadence_ms().unwrap_or(0),
                    "audioGroupDurationMs": buffer.audio_group_duration_us / 1000,
                    "alignmentReady": buffer.alignment_ready(),
                }));
            }
        }
        serde_json::to_string(&json!({
            "serverEpochMs": epoch_ms(),
            "alignmentDelayMs": self.alignment_delay_ms(),
            "pullLeadMs": self.pull_lead_ms(),
            "alignmentReady": self.alignment_ready(),
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
        // 重连会创建新的 session id；同一路径的旧 UDP 会话若来不及发送 STOP，
        // 不能继续留在共享对齐统计里拖住或抬高其他正常播放器。路径代表唯一
        // 发布槽，新会话接管后关闭旧缓冲；迟到的旧包仍只写它持有的孤立 Arc。
        let superseded_ids = state
            .by_id
            .iter()
            .filter_map(|(id, previous)| (previous.stream_path == stream_path).then_some(*id))
            .collect::<Vec<_>>();
        for id in superseded_ids {
            if let Some(previous) = state.by_id.remove(&id) {
                previous.finish();
            }
        }
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

/// 把同一真实采集组内的 AAC 块合为一个延迟观测，取“组内最早采集到最后
/// 到达”的最坏值；视频在同一毫秒成批补到时也只占一个观测。这样批量补发
/// 不会仅凭包数把 P95 顶到极端值。
fn push_latency_sample(
    samples: &mut VecDeque<LatencySample>,
    sample: LatencySample,
    source_group_ms: i64,
) {
    if let Some(previous) = samples.back_mut() {
        let capture_delta_ms = sample.capture_at_ms.saturating_sub(previous.capture_at_ms);
        let same_audio_group =
            source_group_ms > 0 && capture_delta_ms >= 0 && capture_delta_ms < source_group_ms;
        let same_video_burst =
            source_group_ms <= 0 && sample.observed_at_ms == previous.observed_at_ms;
        if same_audio_group || same_video_burst {
            previous.capture_at_ms = previous.capture_at_ms.min(sample.capture_at_ms);
            previous.observed_at_ms = previous.observed_at_ms.max(sample.observed_at_ms);
            previous.latency_ms = previous
                .observed_at_ms
                .saturating_sub(previous.capture_at_ms)
                .max(previous.latency_ms)
                .max(sample.latency_ms);
            return;
        }
    }
    samples.push_back(sample);
}

fn percentile_nearest_rank(values: &mut [i64], numerator: usize, denominator: usize) -> i64 {
    values.sort_unstable();
    let index = values
        .len()
        .saturating_mul(numerator)
        .saturating_add(denominator - 1)
        / denominator;
    values[index.saturating_sub(1).min(values.len() - 1)]
}

fn observed_cadence_p95_ms(samples: &VecDeque<LatencySample>) -> i64 {
    let mut gaps = samples
        .iter()
        .zip(samples.iter().skip(1))
        .filter_map(|(left, right)| {
            let gap = right.observed_at_ms.saturating_sub(left.observed_at_ms);
            (gap > 0).then_some(gap)
        })
        .collect::<Vec<_>>();
    if gaps.is_empty() {
        0
    } else {
        percentile_nearest_rank(&mut gaps, 95, 100)
    }
}

fn latency_profile(
    samples: &Mutex<VecDeque<LatencySample>>,
    source_cadence_ms: i64,
) -> Option<LatencyProfile> {
    let samples = samples.lock().expect("frame buffer latency lock poisoned");
    let latest = samples.back()?;
    let cadence_ms = observed_cadence_p95_ms(&samples)
        .max(source_cadence_ms)
        .max(0);
    // 使用以真实 cadence 换算的时间窗口，而不是固定包数。窗口成熟后恰好
    // 覆盖 P95 尾概率的倒数个到达周期，单个严重迟到批次自然落在尾部之外。
    let profile_window_ms = cadence_ms.saturating_mul(LATENCY_P95_WINDOW_CADENCES);
    let earliest_at_ms = latest.observed_at_ms.saturating_sub(profile_window_ms);
    let mut sorted = samples
        .iter()
        .filter(|sample| profile_window_ms <= 0 || sample.observed_at_ms >= earliest_at_ms)
        .map(|sample| sample.latency_ms)
        .collect::<Vec<_>>();
    if sorted.is_empty() {
        return None;
    }
    let mut median_values = sorted.clone();
    let p50_ms = percentile_nearest_rank(&mut median_values, 50, 100);
    let p95_ms = percentile_nearest_rank(&mut sorted, 95, 100);
    Some(LatencyProfile {
        p50_ms,
        p95_ms,
        cadence_ms,
    })
}

/// 判断候选延迟是否覆盖了足够长的真实时间窗口，并确认这段时间里媒体采集
/// 时钟也以相同速度推进。若到达时钟走了很久而采集时钟基本不动，说明收到的
/// 是断流后的旧帧/积压，应丢弃这些帧而不是移动所有流的共享时间轴。
fn latency_window_status(
    samples: &Mutex<VecDeque<LatencySample>>,
    current_ms: i64,
    observed_required_ms: i64,
    pull_lead_ms: i64,
    cadence_ms: i64,
) -> (bool, bool) {
    let required_window_ms = observed_required_ms
        .saturating_sub(current_ms)
        .abs()
        .max(cadence_ms);
    let samples = samples.lock().expect("frame buffer latency lock poisoned");
    let Some(latest) = samples.back() else {
        return (false, false);
    };
    if required_window_ms == 0 {
        return (true, true);
    }
    let mut earliest = latest;
    for sample in samples.iter().rev() {
        if observed_required_ms > current_ms
            && sample.latency_ms.saturating_add(pull_lead_ms) <= current_ms
        {
            break;
        }
        earliest = sample;
        if latest
            .observed_at_ms
            .saturating_sub(earliest.observed_at_ms)
            >= required_window_ms
        {
            break;
        }
    }
    let arrival_span_ms = latest
        .observed_at_ms
        .saturating_sub(earliest.observed_at_ms);
    if arrival_span_ms >= required_window_ms {
        let capture_span_ms = latest.capture_at_ms.saturating_sub(earliest.capture_at_ms);
        let stable =
            capture_span_ms >= 0 && capture_span_ms.saturating_add(cadence_ms) >= arrival_span_ms;
        return (true, stable);
    }

    // 陈旧时间戳的延迟会与到达时间一起增长，因此上面的候选增量窗口会被它
    // 永远向前推。另用 P95 统计本身所覆盖的实测 cadence 窗口确认轨道健康：
    // 到达时钟已走完整窗口而采集时钟没有同步前进，即可结束冷启动校准并把
    // 此轨标成不稳定；它之后的旧帧由播放器丢弃，不阻塞其他正常流。
    let health_window_ms = cadence_ms.saturating_mul(LATENCY_P95_WINDOW_CADENCES);
    if health_window_ms > 0 {
        let mut health_earliest = latest;
        for sample in samples.iter().rev() {
            health_earliest = sample;
            if latest
                .observed_at_ms
                .saturating_sub(health_earliest.observed_at_ms)
                >= health_window_ms
            {
                break;
            }
        }
        let health_arrival_span_ms = latest
            .observed_at_ms
            .saturating_sub(health_earliest.observed_at_ms);
        if health_arrival_span_ms >= health_window_ms {
            let health_capture_span_ms = latest
                .capture_at_ms
                .saturating_sub(health_earliest.capture_at_ms);
            if health_capture_span_ms < 0
                || health_capture_span_ms.saturating_add(cadence_ms) < health_arrival_span_ms
            {
                return (true, false);
            }
        }
    }
    (false, false)
}

fn alignment_requirement(
    samples: &Mutex<VecDeque<LatencySample>>,
    current_ms: i64,
    source_cadence_ms: i64,
) -> Option<AlignmentRequirement> {
    let profile = latency_profile(samples, source_cadence_ms)?;
    // P95 尾差最多贡献一个真实 cadence；更长的尾部是偶发严重迟到，交给
    // 对应播放器丢块。正常批次的完整到达间隔再作为解码/FIFO 提前量。
    let stable_tail_ms = profile
        .p95_ms
        .saturating_sub(profile.p50_ms)
        .max(0)
        .min(profile.cadence_ms);
    let stable_p95_ms = profile.p50_ms.saturating_add(stable_tail_ms);
    // 到达 cadence 覆盖“等下一批”的时间；音频还需留出发送端一个完整 PCM
    // 采集组，避免第一批 AAC 到达后 FIFO 尚未形成就开始消耗。两者都来自
    // 当前流的实测/上报值，不依赖设备型号或固定毫秒常量。
    let pull_lead_ms = profile.cadence_ms.saturating_add(source_cadence_ms.max(0));
    let required_ms = stable_p95_ms
        .saturating_add(pull_lead_ms)
        .clamp(0, MAX_ALIGNMENT_DELAY_MS as i64);
    // 尾部只影响“需要观察多久”，不直接重复放大共享预算。一次极晚批次会
    // 要求同样长的后续时间证据；若它没有持续到这个窗口就只丢该批音频。
    let observed_required_ms = profile
        .p95_ms
        .saturating_add(pull_lead_ms)
        .clamp(0, MAX_ALIGNMENT_DELAY_MS as i64);
    let (observation_complete, stable) = latency_window_status(
        samples,
        current_ms,
        observed_required_ms,
        pull_lead_ms,
        profile.cadence_ms,
    );
    Some(AlignmentRequirement {
        required_ms,
        pull_lead_ms,
        increase_confirmed: observation_complete && stable,
        observation_complete,
    })
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
    use super::{percent_encode_path, FrameHub, RAW_AUDIO, RAW_DELTA, RAW_VIDEO_CONFIG};
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
    fn synchronized_alignment_waits_for_measured_audio_and_video() {
        let hub = FrameHub::new(true, 20);
        let buffer = hub.register(20, "/calibrating", true, true, 2, 40_000);
        assert!(!hub.alignment_ready());
        assert_eq!(hub.alignment_delay_ms(), 0);
        let observed_at_ms = super::epoch_ms();
        for index in 0..=2_i64 {
            buffer.record_latency(RAW_DELTA, 30, observed_at_ms + index * 30);
        }
        assert!(
            !hub.alignment_ready(),
            "declared audio must be observed before synchronized start"
        );
        buffer.record_latency(RAW_AUDIO, 130, observed_at_ms + 80);
        assert!(
            !hub.alignment_ready(),
            "one audio sample is not an arrival-time window"
        );
        for index in 1..=5_i64 {
            buffer.record_latency(RAW_AUDIO, 130, observed_at_ms + 80 + index * 40);
        }
        assert!(hub.alignment_ready());
        // 130ms 实测到达 + 两个 40ms 实际采集组；窗口长度来自本次所需
        // 增量，持续证据形成后立即抬高，不依赖固定冷启动时长或周期任务。
        assert!(hub.alignment_delay_ms() >= 130 + 2 * 40);
    }

    #[test]
    fn alignment_delay_reserves_pull_lead_for_the_slowest_track() {
        let hub = FrameHub::new(true, 150);
        let buffer = hub.register(21, "/late-audio", true, true, 2, 40_000);
        let observed_at_ms = super::epoch_ms() - 2_000;
        for index in 0..40_i64 {
            buffer.record_latency(RAW_DELTA, 30, observed_at_ms + index * 33);
            buffer.record_latency(RAW_AUDIO, 130, observed_at_ms + index * 21);
        }
        hub.update_alignment_delay();
        let delay = hub.alignment_delay_ms() as i64;
        // 音频轨 P95 约 130ms，处理余量来自实测到达间隔和 40ms 采集组。
        assert!(delay >= 130 + 80, "delay {delay}");
        assert!(hub.pull_lead_ms() >= 80, "pull lead {}", hub.pull_lead_ms());
        let info: serde_json::Value = serde_json::from_str(&hub.sync_info_json()).unwrap();
        assert!(info["pullLeadMs"].as_u64().unwrap() >= 80);
        assert_eq!(info["alignmentReady"], true);
        let stream = &info["streams"][0];
        assert!(stream["audioLatencyP95Ms"].as_i64().unwrap() >= 125);
        assert!(stream["videoLatencyP95Ms"].as_i64().unwrap() <= 40);
        assert!(stream["audioArrivalCadenceP95Ms"].as_i64().unwrap() >= 40);
        assert!(stream["videoArrivalCadenceP95Ms"].as_i64().unwrap() >= 30);
        assert_eq!(stream["audioGroupDurationMs"].as_i64().unwrap(), 40);
    }

    #[test]
    fn multiple_streams_share_the_slowest_audio_alignment() {
        let hub = FrameHub::new(true, 20);
        let fast = hub.register(25, "/fast-video", false, false, 0, 0);
        let slow = hub.register(26, "/slow-audio", true, true, 2, 40_000);
        let observed_at_ms = super::epoch_ms() - 2_000;
        for index in 0..40_i64 {
            fast.record_latency(RAW_DELTA, 25, observed_at_ms + index * 33);
            slow.record_latency(RAW_DELTA, 35, observed_at_ms + index * 33);
            slow.record_latency(RAW_AUDIO, 130, observed_at_ms + index * 21);
        }
        hub.update_alignment_delay();
        assert!(hub.alignment_ready());
        assert!(hub.alignment_delay_ms() >= 210);

        // 更新后的新帧无论属于快视频还是慢音频，都使用同一个共享显示时刻。
        let capture_ms = super::epoch_ms();
        fast.publish_video(2_000_000, Some(capture_ms), true, &[3]);
        slow.publish_video(2_000_000, Some(capture_ms), true, &[3]);
        slow.publish_audio(2_000_000, Some(capture_ms), &[4]);
        let (_, _, fast_frames) = fast.take_frames(0);
        let (_, _, slow_frames) = slow.take_frames(0);
        assert_eq!(
            fast_frames.last().unwrap().release_epoch_ms,
            slow_frames.last().unwrap().release_epoch_ms,
        );
    }

    #[test]
    fn alignment_delay_reserves_two_audio_groups() {
        let hub = FrameHub::new(true, 20);
        let buffer = hub.register(24, "/long-groups", true, true, 2, 60_000);
        let observed_at_ms = super::epoch_ms();
        for index in 0..=3_i64 {
            buffer.record_latency(RAW_AUDIO, 20, observed_at_ms + index * 60);
        }
        hub.update_alignment_delay();
        // 处理余量直接来自 60ms 实际到达间隔和 60ms 采集组，而不是固定毫秒常量。
        assert!(hub.alignment_delay_ms() >= 20 + 120);
    }

    #[test]
    fn alignment_delay_falls_back_slowly() {
        let hub = FrameHub::new(true, 150);
        let buffer = hub.register(22, "/settle", true, true, 2, 0);
        let observed_at_ms = super::epoch_ms();
        for index in 0..=14_i64 {
            buffer.record_latency(RAW_DELTA, 400, observed_at_ms + index * 33);
        }
        hub.update_alignment_delay();
        let high = hub.alignment_delay_ms();
        assert!(high >= 400, "high {high}");
        hub.unregister(&buffer);
        hub.update_alignment_delay();
        let proportional_step = high.saturating_add(super::ALIGNMENT_DECREASE_DIVISOR - 1)
            / super::ALIGNMENT_DECREASE_DIVISOR;
        assert_eq!(hub.alignment_delay_ms(), high - proportional_step.max(1));
    }

    #[test]
    fn unsynchronized_alignment_reserves_but_never_drops_below_configuration() {
        let hub = FrameHub::new(false, 150);
        let buffer = hub.register(23, "/plain", true, true, 2, 40_000);
        hub.update_alignment_delay();
        assert_eq!(hub.alignment_delay_ms(), 150);
        let observed_at_ms = super::epoch_ms();
        for index in 0..=4_i64 {
            buffer.record_latency(RAW_AUDIO, 200, observed_at_ms + index * 40);
        }
        hub.update_alignment_delay();
        // 关闭同步时也按到达延迟预留：音频晚到 200ms 时显示延迟必须超过它。
        assert!(hub.alignment_delay_ms() >= 200 + 80);
    }

    #[test]
    fn alignment_increase_uses_arrival_time_window_not_sample_count() {
        let hub = FrameHub::new(true, 20);
        let buffer = hub.register(27, "/windowed", false, false, 0, 0);
        let observed_at_ms = super::epoch_ms();
        for index in 0..=2_i64 {
            buffer.record_latency(RAW_DELTA, 30, observed_at_ms + index * 30);
        }
        assert_eq!(hub.alignment_delay_ms(), 60);

        // 任意多个同时到达的严重迟到帧仍只占时间窗口中的一个瞬间，不能
        // 为它们把所有流的共享视频时间轴从 30ms 一次抬到 300ms。
        for _ in 0..100 {
            buffer.record_latency(RAW_DELTA, 300, observed_at_ms + 70);
        }
        hub.update_alignment_delay();
        assert_eq!(hub.alignment_delay_ms(), 60);

        // 同一延迟水平实际持续覆盖所需的 270ms 增量后才确认上调；窗口
        // 成熟前即使已经有很多帧，包数也不能替代经过的时间。
        for offset_ms in [100_i64, 130, 160, 190, 220, 250, 280, 310, 339] {
            buffer.record_latency(RAW_DELTA, 300, observed_at_ms + offset_ms);
        }
        assert_eq!(hub.alignment_delay_ms(), 60);
        buffer.record_latency(RAW_DELTA, 300, observed_at_ms + 340);
        assert_eq!(hub.alignment_delay_ms(), 330);
    }

    #[test]
    fn isolated_late_audio_does_not_move_the_shared_video_timeline() {
        let hub = FrameHub::new(true, 20);
        let buffer = hub.register(28, "/audio-windowed", true, true, 2, 40_000);
        let observed_at_ms = super::epoch_ms();
        for index in 0..=2_i64 {
            buffer.record_latency(RAW_DELTA, 30, observed_at_ms + index * 30);
        }
        for offset_ms in [80_i64, 120, 160] {
            buffer.record_latency(RAW_AUDIO, 50, observed_at_ms + offset_ms);
        }
        assert_eq!(hub.alignment_delay_ms(), 130);
        assert!(hub.alignment_ready());

        // 即使一批严重迟到音频含很多块，只要它们在同一到达时刻出现，就
        // 只丢对应声音，不值得让所有已经播放的视频改变节奏。
        for _ in 0..100 {
            buffer.record_latency(RAW_AUDIO, 400, observed_at_ms + 170);
        }
        assert_eq!(buffer.audio_latency_samples.lock().unwrap().len(), 4);
        hub.update_alignment_delay();
        assert_eq!(hub.alignment_delay_ms(), 130);
        buffer.record_latency(RAW_AUDIO, 50, observed_at_ms + 200);
        assert_eq!(hub.alignment_delay_ms(), 130);

        // 只有新的 400ms 水平在后续真实到达时间内持续覆盖完整 350ms
        // 增量窗口，才把共享预算提高到 400ms + 两个 40ms 音频组。
        for offset_ms in [240_i64, 280, 320, 360, 400, 440, 480, 520, 560] {
            buffer.record_latency(RAW_AUDIO, 400, observed_at_ms + offset_ms);
        }
        assert_eq!(hub.alignment_delay_ms(), 130);
        buffer.record_latency(RAW_AUDIO, 400, observed_at_ms + 600);
        assert_eq!(hub.alignment_delay_ms(), 480);
    }

    #[test]
    fn stale_capture_clock_finishes_calibration_but_is_ignored() {
        let hub = FrameHub::new(true, 20);
        let stable = hub.register(29, "/stable", false, false, 0, 0);
        let stale = hub.register(30, "/reconnected-stale", false, false, 0, 0);
        let observed_at_ms = super::epoch_ms();
        for index in 0..=2_i64 {
            stable.record_latency(RAW_DELTA, 30, observed_at_ms + index * 30);
        }
        assert_eq!(hub.alignment_delay_ms(), 60);
        assert!(!hub.alignment_ready());

        // 到达时钟每 33ms 前进，但延迟也每次增加 33ms，还原出的采集时钟
        // 完全不动。这是断线后的旧时间戳/积压，不可能靠增加共享延迟修好。
        for index in 0..=20_i64 {
            stale.record_latency(RAW_DELTA, 100 + index * 33, observed_at_ms + index * 33);
        }
        assert!(hub.alignment_ready());
        hub.update_alignment_delay();
        assert_eq!(hub.alignment_delay_ms(), 60);
    }

    #[test]
    fn reconnect_on_the_same_path_supersedes_the_old_alignment_source() {
        let hub = FrameHub::new(true, 20);
        let old = hub.register(31, "/reconnected", false, false, 0, 0);
        let observed_at_ms = super::epoch_ms();
        for index in 0..=2_i64 {
            old.record_latency(RAW_DELTA, 300, observed_at_ms + index * 30);
        }

        let replacement = hub.register(32, "/reconnected", false, false, 0, 0);
        assert!(old.take_frames(0).1, "superseded buffer must be closed");
        assert!(hub.take_frames(31, 0).is_none());
        assert!(hub.take_frames(32, 0).is_some());

        for index in 0..=2_i64 {
            replacement.record_latency(RAW_DELTA, 30, observed_at_ms + 100 + index * 30);
        }
        hub.update_alignment_delay();
        assert_eq!(hub.alignment_delay_ms(), 60);
        let info: serde_json::Value = serde_json::from_str(&hub.sync_info_json()).unwrap();
        assert_eq!(info["streams"].as_array().unwrap().len(), 1);
        assert_eq!(info["streams"][0]["path"], "/reconnected");
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
        assert_eq!(
            frames_after_clock[1].timeline_us,
            Some(1_750_000_000_000_000)
        );
    }
}
