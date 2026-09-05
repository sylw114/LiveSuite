// HTTP-FLV 拉流服务(原 Rust `http_output.rs` 的 Node 实现)。
//
// 收流端(Rust `.node` addon)负责 QUIC/UDP 收流、组帧、时钟同步与
// 帧缓冲;本模块在 Electron 主进程内提供 HTTP-FLV 输出:
// - 每个拉流连接持有独立的 FLV 时间轴与待发队列,连接之间
//   互不影响(多拉流方异常由此消除);
// - 同步模式下只按每帧自己的 `releaseEpochMs` 调度发送,保证多路流对齐，
//   同时避免音视频轨道互相等待后成批释放。
import http from 'http';
import fs from 'fs';
import { randomUUID } from 'crypto';

// 帧类型常量,与 Rust `frame_hub.rs` 保持一致。
export const RAW_VIDEO_CONFIG = 1;
export const RAW_KEYFRAME = 2;
export const RAW_DELTA = 3;
export const RAW_AUDIO_CONFIG = 4;
export const RAW_END = 5;
export const RAW_AUDIO = 6;

/** 单连接待发队列上限,超过即断开(慢客户端断开重连,不影响其他连接)。 */
const MAX_QUEUED_FRAMES = 512;
const FLV_TIMESTAMP_MODULUS_MS = 0x1_0000_0000;
const PLAYBACK_FEEDBACK_PATH = '/livesuite/playback-feedback';
const PLAYBACK_FEEDBACK_TTL_MS = 2_500;
const SHARED_PLAYBACK_CONTROL_INTERVAL_MS = 250;
const SHARED_RATE_MAX_DEVIATION = 0.005;
const SHARED_RATE_STEP = 0.0005;
const SHARED_REBUFFER_MIN_DEFICIT_MS = 100;
const SHARED_REBUFFER_CONFIRM_MS = SHARED_PLAYBACK_CONTROL_INTERVAL_MS * 2;
const SHARED_STARTUP_MAX_LAG_MS = 1000;
const SHARED_STARTUP_RECOVERY_CONFIRM_MS = 300;
const DEFAULT_ALIGNMENT_DELAY_MS = 180;
const MAX_REPORTED_POSITION_US = Number.MAX_SAFE_INTEGER;
const MAX_REPORTED_CLOCK_MS = Number.MAX_SAFE_INTEGER;
/** 位置控制留出超过两帧的死区，避免显示帧的离散 PTS 触发往返调速。 */
export const POSITION_DRIFT_DEADBAND_MS = 55;
export const POSITION_DRIFT_CORRECTION_MS = 100;
export const POSITION_DRIFT_HARD_CORRECTION_MS = 450;
/** 大偏差档位使用独立释放阈值，避免临界点附近切换控制强度。 */
export const POSITION_DRIFT_HARD_RELEASE_MS = 220;

/** 播放端水位阈值:字节和视频 gap 满足任一项即可认为有足够余量。 */
export const MIN_VIDEO_BUFFER_BYTES = 1 * 1024 * 1024;
export const MIN_VIDEO_GAP_COUNT = 1;
export const HIGH_VIDEO_BUFFER_BYTES = 10 * 1024 * 1024;
export const HIGH_VIDEO_GAP_COUNT = 5;
export const MIN_AUDIO_FRAME_COUNT = 3;
export const HIGH_AUDIO_FRAME_COUNT = 20;
/** 做了按实际已排程音频时长判断水位，以防止出现 AAC 帧长变化时误判音频余量的情况。 */
export const MIN_AUDIO_BUFFER_MS = 35;
export const RELEASE_AUDIO_BUFFER_MS = 80;
export const HIGH_AUDIO_BUFFER_MS = 320;

/**
 * 小幅校速只改变运动相位，不应形成肉眼可见的丢/复帧脉冲。每次反馈还会
 * 经过 MAX_PLAYBACK_RATE_STEP 限速，从而把阶跃变成连续斜坡。
 */
export const SLOW_PLAYBACK_RATE = 0.99;
export const NORMAL_PLAYBACK_RATE = 1;
export const FAST_PLAYBACK_RATE = 1.01;
export const HARD_SLOW_PLAYBACK_RATE = 0.97;
export const HARD_FAST_PLAYBACK_RATE = 1.03;
export const MAX_PLAYBACK_RATE_STEP = 0.002;

export interface PlaybackFeedback {
  clientId: string;
  playerBuildId?: string;
  sessionId: string;
  streamPath: string;
  videoBufferBytes: number;
  videoGapCount: number;
  audioFrameCount: number;
  /** 做了 Web Audio 实际排程时长上报，以防止出现只按音频帧数误判水位的情况。 */
  audioBufferedMs?: number | null;
  /** 浏览器持续缺少音视频处理余量时请求的公共播放延迟，不是单路偏移。 */
  requiredAlignmentDelayMs?: number | null;
  audioRequiredAlignmentDelayMs?: number | null;
  videoRequiredAlignmentDelayMs?: number | null;
  alignmentRequest?: AlignmentRequestObservation | null;
  hasAudio: boolean;
  /** 已补回浏览器页面额外 latent 的服务端时间轴播放位置。 */
  playbackPositionUs: number | null;
  /** 当前音频时间轴是否已有实际出声位置；视频尚未起播也不能打断声音。 */
  audioPlaybackStarted?: boolean;
  audioPlaybackPositionUs?: number | null;
  /** 所有必要轨道共同覆盖的可播放范围，已补回页面额外延迟。 */
  bufferedStartUs?: number | null;
  bufferedEndUs?: number | null;
  /**
   * 浏览器已接受的主播放时钟速率，用于控制响应确认和丢包后的补发。
   */
  appliedPlaybackRate?: number | null;
  /** 浏览器 performance 时钟映射到服务端墙钟后的值,与 latent 无关。 */
  playbackClockMs: number | null;
  updatedAtMs: number;
}

interface AlignmentRequestObservation {
  track: 'audio' | 'video';
  deltaMs: number | null;
  actualDelayMs: number | null;
  requestedDelayMs: number | null;
  clockRevision: number | null;
  audioArrivalLeadMs: number | null;
  audioRequiredLeadMs: number | null;
  audioDecodeLatencyMs: number | null;
  videoDecodeLeadMs: number | null;
}

interface ObservedPlaybackFeedback extends PlaybackFeedback {
  videoUnderflowSinceMs: number | null;
  audioUnderflowSinceMs: number | null;
  videoProgressAtMs: number;
  audioProgressAtMs: number;
}

interface RebufferObservation {
  atMs: number;
  streamPath: string;
  clientId: string;
  track: 'video' | 'audio';
  missingForMs: number;
  actualDelayMs: number;
  requiredDelayMs: number;
  heldMs: number;
  videoGapCount: number;
  audioBufferedMs: number | null;
  alignmentRequest: AlignmentRequestObservation | null;
}

export type PlaybackControlReason =
  | 'underflow'
  | 'overbuffered'
  | 'ahead'
  | 'behind'
  | 'steady';

export interface PlaybackControl {
  playbackRate: number;
  reason: PlaybackControlReason;
  targetPositionUs: number | null;
  positionErrorMs: number | null;
}

/** 做了按播放端保存最近控速状态，以防止出现纠偏滞回在多个客户端之间串扰的情况。 */
export interface PlaybackRateState {
  playbackRate: number;
  reason: PlaybackControlReason;
}

interface SharedPlaybackClock {
  id: string;
  alignmentDelayMs: number;
  revision: number;
  anchorServerMs: number;
  anchorPositionUs: number;
  playbackRate: number;
  /** 仅累计明确的公共重新蓄水量，客户端不能把漏收校速响应误判成暂停。 */
  rebufferedUs: number;
  /** 整组尚未起播且旧时钟已不可用时，共同重新定位；不能当作音频暂停。 */
  startupRecoveryRevision: number;
  /** 曾经播放过但整组已停滞、旧位置不在缓冲内时的公共向前恢复。 */
  stalledRecoveryRevision: number;
}

interface PlaybackControlResponse extends Omit<PlaybackControl, 'playbackRate'> {
  /** 做了仅在速率变化时下发字段，以防止出现无变化时重复触发播放端控速的情况。 */
  playbackRate?: number;
  /** 当前服务端计算出的目标速率，仅用于诊断。 */
  desiredPlaybackRate: number;
  sharedPlaybackClock?: SharedPlaybackClock | null;
}

/**
 * 根据播放端最新水位和服务端时间轴位置决定播放速率。
 * 视频的字节数/gap 数是“或”关系,音频存在时必须同时满足音频帧阈值。
 *
 * 一个页面的 latent 只影响它实际看到的画面位置,浏览器回报时会把这段
 * 意图延迟补回。因此服务端可以直接把回报位置和
 * `服务端当前时间 - alignmentDelay` 比较,处理新流加入和长时间时钟漂移。
 */
export function evaluatePlaybackControl(
  feedback: readonly PlaybackFeedback[],
  alignmentDelayMs = DEFAULT_ALIGNMENT_DELAY_MS,
  nowMs = epochMs(),
  previousState?: PlaybackRateState,
): PlaybackControl {
  if (feedback.length === 0) {
    return steadyPlaybackControl();
  }

  const controls = feedback.map((entry) => evaluateSinglePlaybackControl(
    entry,
    alignmentDelayMs,
    nowMs,
    // 聚合控制使用同一历史状态：最慢音频或视频轨限制整个同步播放组。
    previousState,
  ));
  if (controls.length === 1) {
    return controls[0];
  }
  const firstNonSteady = controls.find((control) => control.reason !== 'steady');
  if (firstNonSteady) {
    // 任意音频或视频不足都优先限制公共速率，不能被另一条快流的余量抵消。
    const slowest = controls
      .filter((control) => control.playbackRate < NORMAL_PLAYBACK_RATE)
      .sort((left, right) => left.playbackRate - right.playbackRate)[0];
    if (slowest) {
      return slowest;
    }
    // 加速也必须得到最慢轨的允许，不能用最快页面的高水位催快整组。
    return controls.reduce((slowest, control) => control.playbackRate < slowest.playbackRate
      ? control : slowest);
  }

  return steadyPlaybackControl();
}

function evaluateSinglePlaybackControl(
  feedback: PlaybackFeedback,
  alignmentDelayMs: number,
  nowMs: number,
  previousState?: PlaybackRateState,
): PlaybackControl {
  const target = targetPlaybackPosition(feedback, alignmentDelayMs, nowMs);
  const hasVideoReserve = feedback.videoBufferBytes >= MIN_VIDEO_BUFFER_BYTES
    || feedback.videoGapCount >= MIN_VIDEO_GAP_COUNT;
  const hasAudioReserve = hasAudioReserveFor(
    feedback,
    MIN_AUDIO_FRAME_COUNT,
    previousState?.reason === 'underflow' ? RELEASE_AUDIO_BUFFER_MS : MIN_AUDIO_BUFFER_MS,
  );
  if (!hasVideoReserve || !hasAudioReserve) {
    return controlledPlaybackRate(SLOW_PLAYBACK_RATE, 'underflow', target, previousState);
  }

  if (target.positionErrorMs !== null) {
    // 做了纠偏方向与档位的滞回，以防止出现误差在相邻阈值附近来回切换速率的情况。
    if (target.positionErrorMs >= POSITION_DRIFT_HARD_CORRECTION_MS
      || (previousState?.reason === 'ahead'
        && previousState.playbackRate < SLOW_PLAYBACK_RATE
        && target.positionErrorMs >= POSITION_DRIFT_HARD_RELEASE_MS)) {
      return controlledPlaybackRate(HARD_SLOW_PLAYBACK_RATE, 'ahead', target, previousState);
    }
    if (target.positionErrorMs >= POSITION_DRIFT_CORRECTION_MS
      || (previousState?.reason === 'ahead'
        && target.positionErrorMs >= POSITION_DRIFT_DEADBAND_MS)) {
      return controlledPlaybackRate(SLOW_PLAYBACK_RATE, 'ahead', target, previousState);
    }
    if (target.positionErrorMs <= -POSITION_DRIFT_HARD_CORRECTION_MS
      || (previousState?.reason === 'behind'
        && previousState.playbackRate > FAST_PLAYBACK_RATE
        && target.positionErrorMs <= -POSITION_DRIFT_HARD_RELEASE_MS)) {
      return controlledPlaybackRate(HARD_FAST_PLAYBACK_RATE, 'behind', target, previousState);
    }
    if (target.positionErrorMs <= -POSITION_DRIFT_CORRECTION_MS
      || (previousState?.reason === 'behind'
        && target.positionErrorMs <= -POSITION_DRIFT_DEADBAND_MS)) {
      return controlledPlaybackRate(FAST_PLAYBACK_RATE, 'behind', target, previousState);
    }
  }

  const hasHighVideoReserve = feedback.videoBufferBytes > HIGH_VIDEO_BUFFER_BYTES
    || feedback.videoGapCount > HIGH_VIDEO_GAP_COUNT;
  const hasHighAudioReserve = hasAudioReserveFor(
    feedback,
    HIGH_AUDIO_FRAME_COUNT,
    HIGH_AUDIO_BUFFER_MS,
  );
  if (hasHighVideoReserve && hasHighAudioReserve
    && (target.positionErrorMs === null
      || target.positionErrorMs <= -POSITION_DRIFT_DEADBAND_MS)) {
    return controlledPlaybackRate(FAST_PLAYBACK_RATE, 'overbuffered', target, previousState);
  }
  return controlledPlaybackRate(NORMAL_PLAYBACK_RATE, 'steady', target, previousState);
}

function controlledPlaybackRate(
  desiredRate: number,
  reason: PlaybackControlReason,
  target: Pick<PlaybackControl, 'targetPositionUs' | 'positionErrorMs'>,
  previousState?: PlaybackRateState,
): PlaybackControl {
  const previousRate = previousState?.playbackRate ?? NORMAL_PLAYBACK_RATE;
  const delta = Math.max(
    -MAX_PLAYBACK_RATE_STEP,
    Math.min(MAX_PLAYBACK_RATE_STEP, desiredRate - previousRate),
  );
  return {
    playbackRate: Math.round((previousRate + delta) * 1000) / 1000,
    reason,
    ...target,
  };
}

function hasAudioReserveFor(
  feedback: PlaybackFeedback,
  frameCount: number,
  bufferedMs: number,
): boolean {
  if (!feedback.hasAudio) {
    return true;
  }
  const scheduledMs = feedback.audioBufferedMs;
  if (scheduledMs != null && Number.isFinite(scheduledMs)) {
    // 做了优先使用真实排程时长的判断，以防止出现 AAC 帧长变化导致水位误判的情况。
    return scheduledMs >= bufferedMs;
  }
  return feedback.audioFrameCount >= frameCount;
}

function hasVideoReserveFor(feedback: PlaybackFeedback): boolean {
  return feedback.videoBufferBytes >= MIN_VIDEO_BUFFER_BYTES
    || feedback.videoGapCount >= MIN_VIDEO_GAP_COUNT;
}

/** 公共时钟自身没有离散视频 PTS 的量化误差，只根据最慢轨水位平滑蓄水/回收。 */
export function evaluateSharedPlaybackControl(
  feedback: readonly PlaybackFeedback[],
  positionUs: number,
  alignmentDelayMs: number,
  nowMs: number,
  previousState?: PlaybackRateState,
): PlaybackControl {
  const targetPositionUs = (nowMs - alignmentDelayMs) * 1000;
  const positionErrorMs = (positionUs - targetPositionUs) / 1000;
  const underflow = feedback.some((entry) => !hasVideoReserveFor(entry)
    || !hasAudioReserveFor(entry, MIN_AUDIO_FRAME_COUNT,
      previousState?.reason === 'underflow' ? RELEASE_AUDIO_BUFFER_MS : MIN_AUDIO_BUFFER_MS));
  const canAccelerate = feedback.length > 0 && feedback.every((entry) =>
    hasVideoReserveFor(entry)
    && hasAudioReserveFor(entry, MIN_AUDIO_FRAME_COUNT, RELEASE_AUDIO_BUFFER_MS));
  let reason: PlaybackControlReason = 'steady';
  let desiredRate = NORMAL_PLAYBACK_RATE;
  if (underflow) {
    reason = 'underflow';
    desiredRate -= SHARED_RATE_MAX_DEVIATION;
  } else if (feedback.length > 0 && positionErrorMs > 8) {
    reason = 'ahead';
    desiredRate -= Math.min(SHARED_RATE_MAX_DEVIATION, (positionErrorMs - 8) / 10_000);
  } else if (canAccelerate && positionErrorMs < -20) {
    reason = 'behind';
    desiredRate += Math.min(SHARED_RATE_MAX_DEVIATION, (-positionErrorMs - 20) / 10_000);
  }
  const previousRate = previousState?.playbackRate ?? NORMAL_PLAYBACK_RATE;
  return {
    playbackRate: Math.round((previousRate + Math.max(-SHARED_RATE_STEP,
      Math.min(SHARED_RATE_STEP, desiredRate - previousRate))) * 1_000_000) / 1_000_000,
    reason,
    targetPositionUs,
    positionErrorMs,
  };
}

function targetPlaybackPosition(
  feedback: PlaybackFeedback,
  alignmentDelayMs: number,
  nowMs: number,
): Pick<PlaybackControl, 'targetPositionUs' | 'positionErrorMs'> {
  // 控制必须基于真正已经展示的位置。若在收到非 1x 指令后立即改用主时钟
  // 推演值，误差会在物理画面追上前被瞬间抹成 0，随后形成 1x/校速交替脉冲。
  // 重复指令由 per-client 状态和 appliedPlaybackRate 确认去重，无需伪造位置。
  const playbackPositionUs = feedback.playbackPositionUs;
  if (playbackPositionUs === null) {
    return { targetPositionUs: null, positionErrorMs: null };
  }
  const playbackClockMs = feedback.playbackClockMs !== null
    && Math.abs(feedback.playbackClockMs - nowMs) <= 5_000
    ? feedback.playbackClockMs
    : nowMs;
  const targetPositionUs = (playbackClockMs - Math.max(0, alignmentDelayMs)) * 1000;
  return {
    targetPositionUs,
    positionErrorMs: (playbackPositionUs - targetPositionUs) / 1000,
  };
}

/** 内置网页一旦收到帧便自行缓存到实测显示时刻；普通 FLV 客户端保持原行为。 */
export function browserPlayerReleaseLeadMs(alignmentDelayMs: number): number {
  if (!Number.isFinite(alignmentDelayMs)) {
    return 0;
  }
  // 不写死浏览器处理余量：服务端时间轴本身来自实际到达分布，内置播放器
  // 立即取得已到达帧并把完整剩余量用于解码、WSOLA 和 FIFO。
  return Math.max(0, alignmentDelayMs);
}

function steadyPlaybackControl(): PlaybackControl {
  return {
    playbackRate: NORMAL_PLAYBACK_RATE,
    reason: 'steady',
    targetPositionUs: null,
    positionErrorMs: null,
  };
}

export interface PullFrame {
  ordinal: number;
  kind: number;
  ptsUs: number;
  timelineUs: number | null;
  releaseEpochMs: number | null;
  data: Buffer;
}

export interface TakeFramesResult {
  resync: boolean;
  closed: boolean;
  frames: PullFrame[];
}

/** addon 拉流相关的最小接口(由 quicServer.ts 传入)。 */
export interface QuicFrameSource {
  takeFrames(sessionId: string, afterOrdinal: number): TakeFramesResult;
  syncInfoJson(): string;
}

export interface QuicPullHubOptions {
  bind: string;
  port: number;
  /** 内置浏览器播放器 HTML 路径,读取失败时回退到 404。 */
  browserPlayerHtmlPath?: string;
  /** 轮询周期,默认 10ms。 */
  pollIntervalMs?: number;
}

interface OutputFrame {
  ordinal: number;
  kind: number;
  ptsUs: number;
  timelineUs: number | null;
  releaseEpochMs: number | null;
  data: Buffer;
}

function mediaTimeUs(frame: OutputFrame): number {
  return frame.timelineUs ?? frame.ptsUs;
}

/** FLV 时间戳字段只有 32 位;内部时间轴保持完整值,写出时按规范回绕。 */
export function wrapFlvTimestamp(timestampMs: number): number {
  if (!Number.isFinite(timestampMs)) {
    return 0;
  }
  const truncated = Math.floor(timestampMs) % FLV_TIMESTAMP_MODULUS_MS;
  return truncated < 0 ? truncated + FLV_TIMESTAMP_MODULUS_MS : truncated;
}

/** 每个拉流连接独立的 FLV 时间轴。 */
class FlvTimeline {
  /** 做了音视频共用 FLV 原点，以防止出现各轨各自归零后丢失原有相对偏移的情况。 */
  mediaOriginUs: number | null = null;
  lastVideoTimestampMs = 0;
  lastAudioTimestampMs = 0;

  constructor(originServerMs: number | null) {
    if (originServerMs != null && originServerMs > 0) {
      const originUs = originServerMs * 1000;
      this.mediaOriginUs = originUs;
    }
  }
}

/** 单个拉流连接:独立队列、时间轴与待发帧。 */
class PullConnection {
  private frames: OutputFrame[] = [];
  private waiter: ((frame: OutputFrame | null) => void) | null = null;
  private closed = false;
  private lastQueuedOrdinal = 0;
  timeline: FlvTimeline;
  pending: OutputFrame[] = [];

  constructor(
    private readonly stream: http.ServerResponse,
    private readonly session: PullSession,
    private readonly builtInBrowserPlayer = false,
  ) {
    this.timeline = new FlvTimeline(session.originServerMs);
  }

  get includeAudio(): boolean {
    return this.session.includeAudio;
  }

  get audioChannels(): number {
    return this.session.audioChannels;
  }

  pushFrames(frames: readonly OutputFrame[]): void {
    if (this.closed) {
      return;
    }
    // 快照先给配置，再按媒体时间给 GOP；其 ordinal 并不递增（例如音频
    // 配置早于最新视频配置）。整批只和上一批的水位去重，保留批内原顺序。
    const previousOrdinal = this.lastQueuedOrdinal;
    for (const frame of frames) {
      if (frame.ordinal <= previousOrdinal) {
        continue;
      }
      this.lastQueuedOrdinal = Math.max(this.lastQueuedOrdinal, frame.ordinal);
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = null;
        waiter(frame);
      } else {
        this.frames.push(frame);
        if (this.frames.length > MAX_QUEUED_FRAMES) {
          // 拉流端消费太慢:断开让其重连,避免内存无限增长并拖慢整体轮询。
          this.close();
          return;
        }
      }
    }
  }

  /** 等待下一帧;超时返回 null。 */
  private nextFrame(timeoutMs?: number): Promise<OutputFrame | null> {
    if (this.frames.length > 0) {
      const frame = this.frames.shift();
      return Promise.resolve(frame ?? null);
    }
    if (this.closed) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      this.waiter = (frame) => {
        if (timer) {
          clearTimeout(timer);
        }
        resolve(frame);
      };
      if (timeoutMs != null && timeoutMs > 0) {
        timer = setTimeout(() => {
          const waiter = this.waiter;
          this.waiter = null;
          if (waiter) {
            waiter(null);
          }
        }, timeoutMs);
      }
    });
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const waiter = this.waiter;
    this.waiter = null;
    if (waiter) {
      waiter(null);
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** 主循环:发送 FLV header、消化快照与实时帧,按 release/水位调度。 */
  async run(): Promise<void> {
    const { stream } = this;
    const stereo = this.audioChannels > 1;
    const flags = this.includeAudio && this.session.audioAvailable ? 0x05 : 0x01;
    try {
      writeStreamHeaders(stream, 'video/x-flv');
      const header = Buffer.from([0x46, 0x4c, 0x56, 1, flags, 0, 0, 0, 9, 0, 0, 0, 0]);
      stream.write(header);
    } catch {
      this.close();
      return;
    }
    let ended = false;
    while (!ended && !this.closed) {
      try {
        await this.flushPendingFrames(stereo, false);
      } catch {
        this.close();
        return;
      }
      const now = epochMs();
      let nextRelease: number | null = null;
      for (const frame of this.pending) {
        const releaseEpochMs = this.releaseEpochMs(frame);
        if (releaseEpochMs != null && releaseEpochMs > now) {
          nextRelease = nextRelease == null
            ? releaseEpochMs
            : Math.min(nextRelease, releaseEpochMs);
        }
      }
      const waitMs = nextRelease != null
        ? Math.min(5_000, Math.max(1, nextRelease - now))
        : (this.frames.length > 0 ? 0 : undefined);
      const frame = await this.nextFrame(waitMs);
      if (frame == null) {
        continue;
      }
      if (frame.kind === RAW_END) {
        ended = true;
        continue;
      }
      if (this.releaseEpochMs(frame) != null) {
        this.pending.push(frame);
      } else {
        const tag = flvTag(frame, this.timeline, stereo);
        if (tag) {
          try {
            stream.write(tag);
          } catch {
            this.close();
            return;
          }
        }
      }
    }
    try {
      await this.flushPendingFrames(stereo, true);
      stream.end();
    } catch {
      // 拉流端断开属于正常情况,静默结束。
    }
    this.close();
  }

  private async flushPendingFrames(
    stereo: boolean,
    forceAll: boolean,
  ): Promise<void> {
    const { stream } = this;
    const ready = takeReadyFrames(
      this.pending,
      epochMs(),
      forceAll,
      (frame) => this.releaseEpochMs(frame),
    );
    for (const frame of ready) {
      const tag = flvTag(frame, this.timeline, stereo);
      if (tag) {
        stream.write(tag);
      }
    }
    await Promise.resolve();
  }

  /** 同步模式下按当前对齐延迟重算,覆盖缓存帧生成时的旧 release。 */
  private releaseEpochMs(frame: OutputFrame): number | null {
    if (!this.session.synchronized || frame.timelineUs == null) {
      return frame.releaseEpochMs;
    }
    const now = epochMs();
    const maxHold = Math.max(500, this.session.alignmentDelayMs * 2);
    // 对齐延迟会在音频到达窗口形成后动态增长。内置播放器的提前量也必须
    // 跟随当前值重算；若在连接建立时固定，冷启动值偏小时该连接会永久缺少
    // 音频解码/伸缩余量，即使服务端后来已经把共享对齐延迟抬高。
    const releaseLeadMs = this.builtInBrowserPlayer
      ? browserPlayerReleaseLeadMs(this.session.alignmentDelayMs)
      : 0;
    const release = frame.timelineUs / 1000 + this.session.alignmentDelayMs
      - releaseLeadMs;
    return Math.min(now + maxHold, Math.max(now - maxHold, release));
  }
}

interface PullSession {
  sessionId: string;
  streamPath: string;
  audioAvailable: boolean;
  audioChannels: number;
  audioGroupDurationUs: number;
  includeAudio: boolean;
  originServerMs: number | null;
  synchronized: boolean;
  alignmentDelayMs: number;
  closed: boolean;
  connections: Set<PullConnection>;
  lastPolledOrdinal: number;
}

/** HTTP-FLV 拉流 Hub:维护会话、轮询 addon 帧并分发。 */
export class QuicPullHub {
  private readonly sessions = new Map<string, PullSession>();
  private readonly source: QuicFrameSource;
  private readonly options: QuicPullHubOptions;
  private server: http.Server | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private browserPlayerHtml: string | null = null;
  private includeAudio = false;
  private synchronizedPullStreams: boolean | null = null;
  private alignmentReady = false;
  private alignmentDelayMs = DEFAULT_ALIGNMENT_DELAY_MS;
  private readonly playbackFeedback = new Map<string, ObservedPlaybackFeedback>();
  /** 做了每个浏览器的最近控速状态保存，以防止出现重复下发和纠偏滞回失效的情况。 */
  private readonly playbackRateStates = new Map<string, PlaybackRateState>();
  private sharedPlaybackClock: SharedPlaybackClock | null = null;
  private readonly sharedPlaybackClockId = randomUUID();
  private sharedPlaybackClockRevision = 0;
  private sharedPlaybackControlAtMs = 0;
  private sharedStartupRecoverySinceMs: number | null = null;
  private sharedRebufferUntilMs = 0;
  private lastRebuffer: RebufferObservation | null = null;
  private rebufferCount = 0;
  private sharedPlaybackControl: PlaybackControl = steadyPlaybackControl();
  private playbackControl: PlaybackControl = {
    playbackRate: NORMAL_PLAYBACK_RATE,
    reason: 'steady',
    targetPositionUs: null,
    positionErrorMs: null,
  };

  constructor(source: QuicFrameSource, options: QuicPullHubOptions) {
    this.source = source;
    this.options = options;
  }

  /** 启动 HTTP 服务器并开始轮询,返回实际绑定的端口。 */
  async start(): Promise<number> {
    if (this.server) {
      return this.port();
    }
    if (this.options.browserPlayerHtmlPath) {
      try {
        this.browserPlayerHtml = fs.readFileSync(this.options.browserPlayerHtmlPath, 'utf8');
      } catch {
        this.browserPlayerHtml = null;
      }
    }
    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    server.on('clientError', (_err, socket) => {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port, this.options.bind, () => resolve());
    });
    this.server = server;
    const interval = this.options.pollIntervalMs ?? 10;
    this.pollTimer = setInterval(() => this.poll(), interval);
    if (this.pollTimer.unref) {
      this.pollTimer.unref();
    }
    return this.port();
  }

  /** 当前实际监听端口。 */
  port(): number {
    const address = this.server?.address();
    return typeof address === 'object' && address != null ? address.port : this.options.port;
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const session of this.sessions.values()) {
      session.closed = true;
      for (const connection of session.connections) {
        connection.close();
      }
      session.connections.clear();
    }
    this.sessions.clear();
    this.playbackFeedback.clear();
    this.playbackRateStates.clear();
    this.sharedPlaybackClock = null;
    this.sharedPlaybackControlAtMs = 0;
    this.sharedStartupRecoverySinceMs = null;
    this.sharedRebufferUntilMs = 0;
    this.lastRebuffer = null;
    this.rebufferCount = 0;
    this.sharedPlaybackControl = steadyPlaybackControl();
    this.playbackControl = {
      playbackRate: NORMAL_PLAYBACK_RATE,
      reason: 'steady',
      targetPositionUs: null,
      positionErrorMs: null,
    };
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
  }

  /** 会话建立(由 quicServer 的 published 事件调用)。 */
  registerSession(info: {
    sessionId: string;
    streamPath: string;
    audioAvailable: boolean;
    audioChannels: number;
    audioGroupDurationUs: number;
  }): void {
    const previous = this.sessions.get(info.sessionId);
    if (previous) {
      this.endSession(previous);
    }
    // 发送端进程重建后 sessionId 会变化，但同一路径仍是同一个发布槽。
    // 立即结束旧拉流会话，避免 findByPath 继续命中断流前的缓冲并让刷新后的
    // 播放器挂在永远不会再出帧的连接上。
    for (const [sessionId, session] of this.sessions) {
      if (sessionId !== info.sessionId && session.streamPath === info.streamPath) {
        this.endSession(session);
        this.sessions.delete(sessionId);
      }
    }
    this.sessions.set(info.sessionId, {
      ...info,
      includeAudio: this.includeAudio,
      originServerMs: null,
      synchronized: this.synchronizedPullStreams === true,
      alignmentDelayMs: this.alignmentDelayMs,
      closed: false,
      connections: new Set(),
      lastPolledOrdinal: 0,
    });
  }

  /** 会话结束(由 quicServer 的 publish-ended 事件调用)。 */
  unregisterSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      this.endSession(session);
      this.sessions.delete(sessionId);
    }
  }

  /** includeAudioInPull 变更时同步到所有会话。 */
  setIncludeAudio(enabled: boolean): void {
    this.includeAudio = enabled;
    for (const session of this.sessions.values()) {
      session.includeAudio = enabled;
    }
  }

  /** 首帧预测的服务端采集时刻(来自 sync-info),用于新连接的时间轴原点。 */
  refreshOriginServerMs(): void {
    let syncInfo: {
      synchronize?: boolean;
      alignmentReady?: boolean;
      alignmentDelayMs?: number;
      streams?: Array<{ path: string; originServerMs: number }>;
    } = {};
    try {
      syncInfo = JSON.parse(this.source.syncInfoJson()) as typeof syncInfo;
    } catch {
      return;
    }
    if (Number.isFinite(syncInfo.alignmentDelayMs) && syncInfo.alignmentDelayMs! >= 0) {
      this.alignmentDelayMs = Math.min(60_000, Math.max(0, syncInfo.alignmentDelayMs!));
    }
    const synchronized = syncInfo.synchronize === true;
    // Older native addons do not expose alignmentReady. Preserve their previous
    // behavior while a newly built addon can explicitly hold synchronized starts.
    this.alignmentReady = !synchronized || syncInfo.alignmentReady !== false;
    if (this.synchronizedPullStreams !== null && this.synchronizedPullStreams !== synchronized) {
      // FLV 时间戳的原点和服务端时间轴在开关切换时都会改变,旧连接不能
      // 继续混发两种时间轴;让网页从最新 GOP 重连并丢弃已播放分片。
      for (const session of this.sessions.values()) {
        for (const connection of session.connections) connection.close();
        session.connections.clear();
        session.lastPolledOrdinal = 0;
      }
    }
    this.synchronizedPullStreams = synchronized;
    for (const session of this.sessions.values()) {
      session.synchronized = synchronized;
      session.alignmentDelayMs = this.alignmentDelayMs;
    }
    for (const entry of syncInfo.streams ?? []) {
      for (const session of this.sessions.values()) {
        if (session.streamPath === entry.path) {
          session.originServerMs = entry.originServerMs > 0 ? entry.originServerMs : null;
        }
      }
    }
  }

  private endSession(session: PullSession): void {
    session.closed = true;
    for (const [key, feedback] of this.playbackFeedback) {
      if (feedback.sessionId === session.sessionId) {
        this.playbackFeedback.delete(key);
        this.playbackRateStates.delete(key);
      }
    }
    this.refreshPlaybackControl();
    const endFrame: OutputFrame = {
      ordinal: Number.MAX_SAFE_INTEGER,
      kind: RAW_END,
      ptsUs: 0,
      timelineUs: null,
      releaseEpochMs: null,
      data: Buffer.alloc(0),
    };
    for (const connection of session.connections) {
      connection.pushFrames([endFrame]);
    }
  }

  /** 取出仍对应活跃 HTTP-FLV 连接的最新播放端反馈,并清理过期项。 */
  private freshPlaybackFeedback(): ObservedPlaybackFeedback[] {
    const now = epochMs();
    for (const [key, feedback] of this.playbackFeedback) {
      const session = this.sessions.get(feedback.sessionId);
      if (now - feedback.updatedAtMs > PLAYBACK_FEEDBACK_TTL_MS
        || !session || session.closed || session.connections.size === 0) {
        this.playbackFeedback.delete(key);
        this.playbackRateStates.delete(key);
      }
    }
    return [...this.playbackFeedback.values()];
  }

  private refreshPlaybackControl(): PlaybackControl {
    this.playbackControl = evaluatePlaybackControl(
      this.freshPlaybackFeedback(),
      this.browserAlignmentDelayMs(),
    );
    return this.playbackControl;
  }

  /** 同步网页共享最慢音频或视频轨已确认的处理预算；失活反馈不再占用预算。 */
  private browserAlignmentDelayMs(synchronized = this.synchronizedPullStreams === true): number {
    let delayMs = this.alignmentDelayMs;
    if (synchronized) {
      for (const feedback of this.freshPlaybackFeedback()) {
        if (feedback.requiredAlignmentDelayMs != null) {
          delayMs = Math.max(delayMs, feedback.requiredAlignmentDelayMs);
        }
      }
    }
    return delayMs;
  }

  /** 同步组只有一个连续时钟。更新频率与客户端数量无关，所有页面外推同一锚点。 */
  private updateSharedPlaybackClock(
    synchronized = this.synchronizedPullStreams === true,
    nowMs = epochMs(),
  ): SharedPlaybackClock | null {
    if (!synchronized) {
      this.sharedPlaybackClock = null;
      this.sharedStartupRecoverySinceMs = null;
      this.sharedRebufferUntilMs = 0;
      return null;
    }
    if (this.sharedPlaybackClock
      && nowMs - this.sharedPlaybackControlAtMs < SHARED_PLAYBACK_CONTROL_INTERVAL_MS) {
      return this.sharedPlaybackClock;
    }
    const feedback = this.freshPlaybackFeedback();
    const delayMs = this.browserAlignmentDelayMs(true);
    const previous = this.sharedPlaybackClock;
    const activeSessions = [...this.sessions.values()].filter((session) => !session.closed
      && session.connections.size > 0);
    const active = activeSessions.length > 0;
    let positionUs = previous && active
      ? previous.anchorPositionUs + (nowMs - previous.anchorServerMs) * previous.playbackRate * 1000
      : (nowMs - delayMs) * 1000;
    let rebufferedUs = previous?.rebufferedUs ?? 0;
    let startupRecoveryRevision = previous?.startupRecoveryRevision ?? 0;
    let stalledRecoveryRevision = previous?.stalledRecoveryRevision ?? 0;
    const targetPositionUs = (nowMs - delayMs) * 1000;
    // 临时的大预算回落后，新页面可能只拿到当前 GOP，公共时钟却还落后
    // 数十秒。仅靠 0.5% 校速会永久等不到首帧。整组都尚未呈现、每条必要
    // 音视频轨已就绪并持续确认时统一恢复起播；任何已呈现页面都会否决。
    const startupBlocked = this.alignmentReady && previous && feedback.length > 0
      && (targetPositionUs - positionUs) / 1000 > SHARED_STARTUP_MAX_LAG_MS
      && activeSessions.every((session) => feedback.some((entry) => entry.sessionId === session.sessionId))
      && feedback.every((entry) => {
        const session = this.sessions.get(entry.sessionId);
        const needsAudio = session?.includeAudio && session.audioAvailable;
        return entry.playbackPositionUs === null && entry.audioPlaybackStarted !== true
          && hasVideoReserveFor(entry)
          && (!needsAudio || entry.hasAudio)
          && hasAudioReserveFor(entry, MIN_AUDIO_FRAME_COUNT, RELEASE_AUDIO_BUFFER_MS);
      });
    // 首帧状态是历史事实，不能用它永久否决故障恢复。整组当前已无实际
    // 音视频进度且旧位置在缓存之前时，只有共同范围覆盖新目标才向前恢复。
    const stalledRecoveryPositionUs = Math.min(targetPositionUs,
      ...feedback.map((entry) => entry.bufferedEndUs ?? -Infinity));
    const stalledBlocked = this.alignmentReady && previous && feedback.length > 0
      && targetPositionUs - positionUs > SHARED_STARTUP_MAX_LAG_MS * 1000
      && targetPositionUs - stalledRecoveryPositionUs < SHARED_STARTUP_MAX_LAG_MS * 1000
      && activeSessions.every((session) => feedback.some((entry) => entry.sessionId === session.sessionId))
      && feedback.every((entry) => {
        const session = this.sessions.get(entry.sessionId);
        const needsAudio = session?.includeAudio && session.audioAvailable;
        return nowMs - entry.videoProgressAtMs >= SHARED_STARTUP_MAX_LAG_MS
          && (!needsAudio || (entry.hasAudio
            && nowMs - entry.audioProgressAtMs >= SHARED_STARTUP_MAX_LAG_MS))
          && entry.bufferedStartUs != null && entry.bufferedEndUs != null
          && entry.bufferedStartUs <= stalledRecoveryPositionUs && entry.bufferedEndUs >= stalledRecoveryPositionUs;
      })
      && feedback.some((entry) => entry.bufferedStartUs! - positionUs > SHARED_STARTUP_MAX_LAG_MS * 1000);
    if (startupBlocked || stalledBlocked) {
      this.sharedStartupRecoverySinceMs ??= nowMs;
      if (nowMs - this.sharedStartupRecoverySinceMs >= SHARED_STARTUP_RECOVERY_CONFIRM_MS) {
        positionUs = startupBlocked ? targetPositionUs : stalledRecoveryPositionUs;
        if (startupBlocked) startupRecoveryRevision++;
        else stalledRecoveryRevision++;
        this.sharedRebufferUntilMs = 0;
        this.sharedStartupRecoverySinceMs = null;
      }
    } else {
      this.sharedStartupRecoverySinceMs = null;
    }
    const actualDelayMs = nowMs - positionUs / 1000;
    let rebuffer: RebufferObservation | null = null;
    for (const entry of feedback) {
      for (const track of ['video', 'audio'] as const) {
        const since = track === 'video' ? entry.videoUnderflowSinceMs : entry.audioUnderflowSinceMs;
        if (since == null || since < this.sharedRebufferUntilMs
          || entry.updatedAtMs - since < SHARED_REBUFFER_CONFIRM_MS) continue;
        const trackDelayMs = track === 'video'
          ? entry.videoRequiredAlignmentDelayMs : entry.audioRequiredAlignmentDelayMs;
        // 旧页面只有合并预算时仍兼容；新页面必须由缺数据的同一轨申请。
        const requiredDelayMs = Math.max(this.alignmentDelayMs,
          trackDelayMs ?? entry.requiredAlignmentDelayMs ?? 0);
        const heldMs = requiredDelayMs - actualDelayMs;
        if (heldMs < SHARED_REBUFFER_MIN_DEFICIT_MS || heldMs <= (rebuffer?.heldMs ?? 0)) continue;
        rebuffer = { atMs: nowMs, streamPath: entry.streamPath, clientId: entry.clientId,
          track, missingForMs: entry.updatedAtMs - since, actualDelayMs, requiredDelayMs, heldMs,
          videoGapCount: entry.videoGapCount, audioBufferedMs: entry.audioBufferedMs ?? null,
          alignmentRequest: entry.alignmentRequest ?? null };
      }
    }
    if (rebuffer) {
      rebufferedUs += rebuffer.heldMs * 1000;
      positionUs -= rebuffer.heldMs * 1000;
      this.sharedRebufferUntilMs = nowMs + rebuffer.heldMs / (previous?.playbackRate ?? 1);
      this.lastRebuffer = rebuffer;
      this.rebufferCount++;
      console.warn('[LiveSuite] shared playback rebuffer', JSON.stringify(rebuffer));
    }
    this.sharedPlaybackControl = evaluateSharedPlaybackControl(
      feedback, positionUs, delayMs, nowMs, previous ? this.sharedPlaybackControl : undefined,
    );
    this.sharedPlaybackControlAtMs = nowMs;
    this.sharedPlaybackClock = {
      id: this.sharedPlaybackClockId,
      alignmentDelayMs: delayMs,
      revision: ++this.sharedPlaybackClockRevision,
      anchorServerMs: nowMs,
      // 反馈短暂超时只影响控速证据，不能重置仍在播放的组时钟。
      anchorPositionUs: positionUs,
      playbackRate: this.sharedPlaybackControl.playbackRate,
      rebufferedUs,
      startupRecoveryRevision,
      stalledRecoveryRevision,
    };
    return this.sharedPlaybackClock;
  }

  private feedbackKey(clientId: string, sessionId: string): string {
    return `${clientId}\u0000${sessionId}`;
  }

  /** 仅提供状态快照；观测不能续期反馈或改变公共时钟。 */
  private playbackDiagnostics(): Record<string, unknown> {
    const nowMs = epochMs();
    const clock = this.sharedPlaybackClock;
    const positionUs = clock ? clock.anchorPositionUs
      + (nowMs - clock.anchorServerMs) * clock.playbackRate * 1000 : null;
    return {
      actualDelayMs: positionUs == null ? null : nowMs - positionUs / 1000,
      targetDelayMs: clock?.alignmentDelayMs ?? this.alignmentDelayMs,
      reason: this.sharedPlaybackControl.reason,
      rebufferCount: this.rebufferCount,
      rebufferRemainingMs: Math.max(0, this.sharedRebufferUntilMs - nowMs),
      lastRebuffer: this.lastRebuffer,
      clients: this.freshPlaybackFeedback().map((entry) => ({
        clientId: entry.clientId, streamPath: entry.streamPath,
        playerBuildId: entry.playerBuildId,
        feedbackAgeMs: nowMs - entry.updatedAtMs,
        videoGapCount: entry.videoGapCount, audioBufferedMs: entry.audioBufferedMs,
        videoProgressAgeMs: nowMs - entry.videoProgressAtMs,
        audioProgressAgeMs: entry.hasAudio ? nowMs - entry.audioProgressAtMs : null,
        videoUnderflowMs: entry.videoUnderflowSinceMs == null ? 0 : entry.updatedAtMs - entry.videoUnderflowSinceMs,
        audioUnderflowMs: entry.audioUnderflowSinceMs == null ? 0 : entry.updatedAtMs - entry.audioUnderflowSinceMs,
        requiredAlignmentDelayMs: entry.requiredAlignmentDelayMs,
        videoRequiredAlignmentDelayMs: entry.videoRequiredAlignmentDelayMs,
        audioRequiredAlignmentDelayMs: entry.audioRequiredAlignmentDelayMs,
        alignmentRequest: entry.alignmentRequest,
        playbackPositionUs: entry.playbackPositionUs, audioPlaybackPositionUs: entry.audioPlaybackPositionUs,
        bufferedStartUs: entry.bufferedStartUs, bufferedEndUs: entry.bufferedEndUs,
      })),
    };
  }

  /** 记录一个浏览器播放端的水位/时间轴位置并返回该路播放控制。 */
  private acceptPlaybackFeedback(value: unknown): PlaybackControlResponse | null {
    if (typeof value !== 'object' || value == null) {
      return null;
    }
    const body = value as Record<string, unknown>;
    const clientId = typeof body.clientId === 'string' ? body.clientId : '';
    const streamPath = typeof body.streamPath === 'string' ? body.streamPath : '';
    if (clientId.length === 0 || clientId.length > 128
      || streamPath.length === 0 || streamPath.length > 2048) {
      return null;
    }
    const session = this.findByPath(streamPath);
    if (!session || session.closed || session.connections.size === 0) {
      return null;
    }
    const metric = (name: string, integer: boolean): number => {
      const raw = body[name];
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return 0;
      }
      const value = Math.max(0, Math.min(256 * 1024 * 1024, raw));
      return integer ? Math.floor(value) : value;
    };
    const nullableMetric = (name: string, maximum: number): number | null => {
      const raw = body[name];
      if (raw == null) {
        return null;
      }
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return null;
      }
      return Math.max(0, Math.min(maximum, raw));
    };
    const appliedPlaybackRate = (): number | null => {
      const raw = body.appliedPlaybackRate;
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        return null;
      }
      return raw >= 0.9 && raw <= 1.1 ? raw : null;
    };
    const updatedAtMs = epochMs();
    const readAlignmentRequest = (): AlignmentRequestObservation | null => {
      if (!body.alignmentRequest || typeof body.alignmentRequest !== 'object') return null;
      const request = body.alignmentRequest as Record<string, unknown>;
      if (request.track !== 'audio' && request.track !== 'video') return null;
      const detail = (name: string): number | null => typeof request[name] === 'number'
        && Number.isFinite(request[name]) ? request[name] as number : null;
      return { track: request.track, deltaMs: detail('deltaMs'), actualDelayMs: detail('actualDelayMs'),
        requestedDelayMs: detail('requestedDelayMs'), clockRevision: detail('clockRevision'),
        audioArrivalLeadMs: detail('audioArrivalLeadMs'), audioRequiredLeadMs: detail('audioRequiredLeadMs'),
        audioDecodeLatencyMs: detail('audioDecodeLatencyMs'), videoDecodeLeadMs: detail('videoDecodeLeadMs') };
    };
    const key = this.feedbackKey(clientId, session.sessionId);
    const oldFeedback = this.playbackFeedback.get(key);
    const previousFeedback = oldFeedback && updatedAtMs - oldFeedback.updatedAtMs <= PLAYBACK_FEEDBACK_TTL_MS
      ? oldFeedback : undefined;
    const feedback: ObservedPlaybackFeedback = {
      clientId,
      playerBuildId: typeof body.playerBuildId === 'string' ? body.playerBuildId.slice(0, 64) : undefined,
      sessionId: session.sessionId,
      streamPath,
      videoBufferBytes: metric('videoBufferBytes', false),
      videoGapCount: metric('videoGapCount', true),
      audioFrameCount: metric('audioFrameCount', true),
      audioBufferedMs: nullableMetric('audioBufferedMs', 60_000),
      requiredAlignmentDelayMs: nullableMetric('requiredAlignmentDelayMs', 60_000),
      audioRequiredAlignmentDelayMs: nullableMetric('audioRequiredAlignmentDelayMs', 60_000),
      videoRequiredAlignmentDelayMs: nullableMetric('videoRequiredAlignmentDelayMs', 60_000),
      alignmentRequest: readAlignmentRequest(),
      hasAudio: body.hasAudio === true,
      playbackPositionUs: nullableMetric('playbackPositionUs', MAX_REPORTED_POSITION_US),
      audioPlaybackStarted: body.audioPlaybackStarted === true,
      audioPlaybackPositionUs: nullableMetric('audioPlaybackPositionUs', MAX_REPORTED_POSITION_US),
      bufferedStartUs: nullableMetric('bufferedStartUs', MAX_REPORTED_POSITION_US),
      bufferedEndUs: nullableMetric('bufferedEndUs', MAX_REPORTED_POSITION_US),
      appliedPlaybackRate: appliedPlaybackRate(),
      playbackClockMs: nullableMetric('playbackClockMs', MAX_REPORTED_CLOCK_MS),
      updatedAtMs,
      videoUnderflowSinceMs: null,
      audioUnderflowSinceMs: null,
      videoProgressAtMs: updatedAtMs,
      audioProgressAtMs: updatedAtMs,
    };
    const videoProgressed = feedback.playbackPositionUs != null
      && (previousFeedback?.playbackPositionUs == null || feedback.playbackPositionUs > previousFeedback.playbackPositionUs);
    const audioProgressed = feedback.audioPlaybackPositionUs != null
      && (previousFeedback?.audioPlaybackPositionUs == null || feedback.audioPlaybackPositionUs > previousFeedback.audioPlaybackPositionUs);
    if (!videoProgressed) feedback.videoProgressAtMs = previousFeedback?.videoProgressAtMs ?? updatedAtMs;
    if (!audioProgressed) feedback.audioProgressAtMs = previousFeedback?.audioProgressAtMs ?? updatedAtMs;
    // 只累计新反馈中连续欠载且输出未前进的时间。轮询命中正常帧间空档、
    // 恢复出声或旧反馈反复被读取，都不能成为公共暂停的证据。
    if (updatedAtMs >= this.sharedRebufferUntilMs && !hasVideoReserveFor(feedback) && !videoProgressed) {
      const since = previousFeedback?.videoUnderflowSinceMs;
      feedback.videoUnderflowSinceMs = since != null && since >= this.sharedRebufferUntilMs ? since : updatedAtMs;
    }
    if (updatedAtMs >= this.sharedRebufferUntilMs
      && !hasAudioReserveFor(feedback, MIN_AUDIO_FRAME_COUNT, MIN_AUDIO_BUFFER_MS) && !audioProgressed) {
      const since = previousFeedback?.audioUnderflowSinceMs;
      feedback.audioUnderflowSinceMs = since != null && since >= this.sharedRebufferUntilMs ? since : updatedAtMs;
    }
    this.playbackFeedback.set(key, feedback);
    const previousState = this.playbackRateStates.get(key);
    const sharedPlaybackClock = this.updateSharedPlaybackClock();
    const control = sharedPlaybackClock ? this.sharedPlaybackControl : evaluatePlaybackControl(
      [feedback],
      this.browserAlignmentDelayMs(),
      updatedAtMs,
      previousState,
    );
    // 做了同一目标速率的按需下发，以防止出现每次反馈都重复下发并频繁触发
    // 播放端控速的情况。首次反馈仍显式下发一次 1x，确保服务端重启后曾被
    // 旧控制调速的页面能够恢复正常节奏。
    const needsAcknowledgement = feedback.appliedPlaybackRate != null
      && Math.abs(feedback.appliedPlaybackRate - control.playbackRate) >= 0.001;
    // 做了客户端确认前的补发，以防止出现 HTTP 控制响应丢失后客户端收不到
    // 目标速率的情况。
    const playbackRate = previousState == null
      || Math.abs(previousState.playbackRate - control.playbackRate) >= 0.001
      || needsAcknowledgement
      ? control.playbackRate
      : undefined;
    this.playbackRateStates.set(key, {
      playbackRate: control.playbackRate,
      reason: control.reason,
    });
    this.playbackControl = evaluatePlaybackControl(
      this.freshPlaybackFeedback(),
      this.browserAlignmentDelayMs(),
      updatedAtMs,
    );
    return {
      ...control,
      desiredPlaybackRate: control.playbackRate,
      playbackRate,
      sharedPlaybackClock,
    };
  }

  /** 轮询 addon 取新帧并分发给会话下的所有连接。 */
  private poll(): void {
    this.refreshOriginServerMs();
    for (const session of this.sessions.values()) {
      if (session.closed || session.connections.size === 0) {
        continue;
      }
      let result: TakeFramesResult;
      try {
        result = this.source.takeFrames(session.sessionId, session.lastPolledOrdinal);
      } catch {
        continue;
      }
      if (result.resync) {
        // Node 侧落后于 addon 环形缓冲: 断开当前连接让拉流端重连并获取最新关键帧快照
        for (const connection of session.connections) {
          connection.close();
        }
        session.connections.clear();
        session.lastPolledOrdinal = 0;
        continue;
      }
      for (const frame of result.frames) {
        if (frame.ordinal > session.lastPolledOrdinal) {
          session.lastPolledOrdinal = frame.ordinal;
        }
      }
      for (const connection of session.connections) {
        connection.pushFrames(result.frames);
      }
      if (result.closed) {
        this.endSession(session);
      }
    }
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Private-Network': 'true',
        'Content-Length': 0,
        'Connection': 'close',
      });
      res.end();
      return;
    }
    const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
    if (method === 'POST' && rawPath === PLAYBACK_FEEDBACK_PATH) {
      let body: string;
      try {
        body = await readRequestBody(req, 16 * 1024);
      } catch {
        writeHttpError(res, 413, 'Playback feedback is too large');
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(body) as unknown;
      } catch {
        writeHttpError(res, 400, 'Invalid playback feedback');
        return;
      }
      const control = this.acceptPlaybackFeedback(value);
      if (!control) {
        writeHttpError(res, 400, 'Invalid or inactive playback feedback');
        return;
      }
      const responseBody = JSON.stringify(control);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(responseBody),
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Private-Network': 'true',
      });
      res.end(responseBody);
      return;
    }
    if (method !== 'GET') {
      writeHttpError(res, 405, 'Method Not Allowed');
      return;
    }
    if (rawPath === '/' || rawPath === '') {
      writeHttpError(res, 404, 'Stream path is required');
      return;
    }
    if (rawPath === '/livesuite/sync-info') {
      let body: string;
      try {
        const syncUrl = new URL(req.url ?? '/', 'http://livesuite.local');
        const clientSendPerfMs = Number(syncUrl.searchParams.get('t0'));
        const serverReceiveEpochMs = epochMs();
        const info = JSON.parse(this.source.syncInfoJson()) as Record<string, unknown>;
        const serverSendEpochMs = epochMs();
        if (typeof info.alignmentDelayMs === 'number' && Number.isFinite(info.alignmentDelayMs)) {
          this.alignmentDelayMs = Math.min(60_000, Math.max(0, info.alignmentDelayMs));
        }
        this.alignmentReady = info.synchronize !== true || info.alignmentReady !== false;
        // 时钟轮询和反馈返回同一公共锚点及版本；非同步页面的独立控速仍
        // 只通过反馈下发。客户端可据版本忽略较晚到达的旧响应。
        body = JSON.stringify({
          ...info,
          sourceAlignmentDelayMs: this.alignmentDelayMs,
          alignmentDelayMs: this.browserAlignmentDelayMs(info.synchronize === true),
          sharedPlaybackClock: this.updateSharedPlaybackClock(info.synchronize === true, serverSendEpochMs),
          playbackDiagnostics: this.playbackDiagnostics(),
          serverReceiveEpochMs,
          serverSendEpochMs,
          ...(Number.isFinite(clientSendPerfMs) ? { clientSendPerfMs } : {}),
        });
      } catch {
        writeHttpError(res, 503, 'Sync info unavailable');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Private-Network': 'true',
      });
      res.end(body);
      return;
    }
    if (rawPath.endsWith('.flv')) {
      const streamPath = percentDecodePath(rawPath.slice(0, -'.flv'.length));
      if (streamPath == null) {
        writeHttpError(res, 400, 'Invalid stream path');
        return;
      }
      const session = this.findByPath(streamPath);
      if (!session || session.closed) {
        writeHttpError(res, 404, 'Stream Not Found');
        return;
      }
      await this.streamFlv(req, res, session);
      return;
    }
    percentDecodePath(rawPath);
    this.streamBrowserPlayer(res);
  }

  private findByPath(streamPath: string): PullSession | null {
    for (const session of this.sessions.values()) {
      if (session.streamPath === streamPath && !session.closed) {
        return session;
      }
    }
    return null;
  }

  private async streamFlv(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    session: PullSession,
  ): Promise<void> {
    const requestUrl = new URL(req.url ?? '/', 'http://livesuite.local');
    const isBuiltInBrowserPlayer = requestUrl.searchParams.get('livesuite-player') === '1';
    // Do not rely on the background poll having run between page load and this
    // request. Refresh synchronously so a just-registered synchronized stream
    // cannot slip past the arrival-calibration gate during that short race.
    this.refreshOriginServerMs();
    if (isBuiltInBrowserPlayer && session.synchronized && !this.alignmentReady) {
      // 等待真实音视频到达样本形成共享时间轴。浏览器会短退避重连并从最新
      // GOP 起播，避免先按猜测值出画、首个慢音频到来后再大幅停顿校正。
      writeHttpError(res, 425, 'Synchronizing media arrival');
      return;
    }
    const connection = new PullConnection(res, session, isBuiltInBrowserPlayer);
    res.on('close', () => {
      session.connections.delete(connection);
      connection.close();
    });
    req.on('aborted', () => {
      session.connections.delete(connection);
      connection.close();
    });
    // 先取一次完整快照(配置 + GOP),让新连接能立即从关键帧起播。
    let snapshot: TakeFramesResult;
    try {
      snapshot = this.source.takeFrames(session.sessionId, 0);
    } catch {
      writeHttpError(res, 503, 'Frame source unavailable');
      return;
    }
    if (snapshot.closed && snapshot.frames.length === 0) {
      writeHttpError(res, 410, 'Stream Ended');
      return;
    }
    connection.pushFrames(snapshot.frames);
    // 仅首个连接用快照初始化共享轮询水位。新连接取得的较新快照不能推进
    // 已有连接的水位，否则两次轮询之间到达的音视频只会交给新连接。
    if (session.connections.size === 0) {
      session.lastPolledOrdinal = 0;
      for (const frame of snapshot.frames) {
        session.lastPolledOrdinal = Math.max(session.lastPolledOrdinal, frame.ordinal);
      }
    }
    session.connections.add(connection);
    await connection.run();
    session.connections.delete(connection);
  }

  private streamBrowserPlayer(res: http.ServerResponse): void {
    const html = this.browserPlayerHtml;
    if (html == null) {
      writeHttpError(res, 404, 'Browser player not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(html),
      'Content-Disposition': 'inline',
      'Cache-Control': 'no-cache, no-store',
      'Pragma': 'no-cache',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Private-Network': 'true',
      'Connection': 'close',
    });
    res.end(html);
  }
}

function writeStreamHeaders(res: http.ServerResponse, contentType: string): void {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Disposition': 'inline',
    'Cache-Control': 'no-cache, no-store',
    'Pragma': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
    'Connection': 'close',
  });
}

function writeHttpError(res: http.ServerResponse, status: number, message: string): void {
  const body = `${message}\n`;
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Connection': 'close',
  });
  res.end(body);
}

/**
 * 所有轨道只按各自 release 时刻独立取出。这里刻意不接收另一轨道的水位，
 * 防止音频/视频互相等待后成批释放，破坏音频连续性和视频帧时间方差。
 */
export function takeReadyFrames(
  pending: OutputFrame[],
  now: number,
  forceAll: boolean,
  releaseEpochMs: (frame: OutputFrame) => number | null,
): OutputFrame[] {
  const kept: OutputFrame[] = [];
  const ready: OutputFrame[] = [];
  for (const frame of pending) {
    const releasedAt = releaseEpochMs(frame);
    const released = releasedAt == null || releasedAt <= now;
    if (forceAll || released) {
      ready.push(frame);
    } else {
      kept.push(frame);
    }
  }
  ready.sort((a, b) => (mediaTimeUs(a) - mediaTimeUs(b)) || (a.ordinal - b.ordinal));
  pending.length = 0;
  pending.push(...kept);
  return ready;
}

/** FLV 标签封装;对时间戳进行单调保护避免丢帧。 */
function flvTag(
  frame: OutputFrame,
  timeline: FlvTimeline,
  stereo: boolean,
): Buffer | null {
  const isConfig = frame.kind === RAW_VIDEO_CONFIG || frame.kind === RAW_AUDIO_CONFIG;
  const isAudio = frame.kind === RAW_AUDIO_CONFIG || frame.kind === RAW_AUDIO;
  if (!isConfig && frame.kind !== RAW_KEYFRAME && frame.kind !== RAW_DELTA
    && frame.kind !== RAW_AUDIO) {
    return null;
  }
  let timestamp: number;
  if (isConfig) {
    timestamp = 0;
  } else {
    const timeUs = mediaTimeUs(frame);
    // 做了旧流相对 PTS 的原点回退，以防止出现未携带服务端绝对时间轴时
    // 沿用 epoch 原点而把所有时间戳夹到 0 的情况。
    if (frame.timelineUs == null && timeline.mediaOriginUs != null
      && timeline.mediaOriginUs > 1_000_000_000_000) {
      timeline.mediaOriginUs = null;
    }
    if (timeline.mediaOriginUs == null) {
      timeline.mediaOriginUs = timeUs;
    }
    let timelineTimestamp = Math.max(0, timeUs - timeline.mediaOriginUs) / 1000;
    timelineTimestamp = Math.floor(timelineTimestamp);
    if (isAudio) {
      if (timelineTimestamp < timeline.lastAudioTimestampMs) {
        timelineTimestamp = timeline.lastAudioTimestampMs;
      }
      timeline.lastAudioTimestampMs = timelineTimestamp;
    } else if (timelineTimestamp < timeline.lastVideoTimestampMs) {
      timelineTimestamp = timeline.lastVideoTimestampMs;
    } else {
      timeline.lastVideoTimestampMs = timelineTimestamp;
    }
    timestamp = wrapFlvTimestamp(timelineTimestamp);
  }
  if (isAudio) {
    return flvAudioTag(frame, timestamp, stereo);
  }
  const packetType = frame.kind === RAW_VIDEO_CONFIG ? 0 : 1;
  const frameAndCodec = frame.kind === RAW_DELTA ? 0x27 : 0x17;
  const bodySize = 5 + frame.data.length;
  const tag = Buffer.alloc(11 + bodySize + 4);
  let offset = 0;
  tag[offset++] = 9;
  pushU24(tag, bodySize, offset);
  offset += 3;
  pushU24(tag, timestamp & 0x00ff_ffff, offset);
  offset += 3;
  tag[offset++] = (timestamp >> 24) & 0xff;
  tag[offset++] = 0;
  tag[offset++] = 0;
  tag[offset++] = 0;
  tag[offset++] = frameAndCodec;
  tag[offset++] = packetType;
  tag[offset++] = 0;
  tag[offset++] = 0;
  tag[offset++] = 0;
  frame.data.copy(tag, offset);
  offset += frame.data.length;
  tag.writeUInt32BE(11 + bodySize, offset);
  return tag;
}

function flvAudioTag(frame: OutputFrame, timestamp: number, stereo: boolean): Buffer {
  const packetType = frame.kind === RAW_AUDIO_CONFIG ? 0 : 1;
  const soundHeader = stereo ? 0xaf : 0xae;
  const bodySize = 2 + frame.data.length;
  const tag = Buffer.alloc(11 + bodySize + 4);
  let offset = 0;
  tag[offset++] = 8;
  pushU24(tag, bodySize, offset);
  offset += 3;
  pushU24(tag, timestamp & 0x00ff_ffff, offset);
  offset += 3;
  tag[offset++] = (timestamp >> 24) & 0xff;
  tag[offset++] = 0;
  tag[offset++] = 0;
  tag[offset++] = 0;
  tag[offset++] = soundHeader;
  tag[offset++] = packetType;
  frame.data.copy(tag, offset);
  offset += frame.data.length;
  tag.writeUInt32BE(11 + bodySize, offset);
  return tag;
}

function pushU24(buffer: Buffer, value: number, offset: number): void {
  buffer[offset] = (value >> 16) & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
  buffer[offset + 2] = value & 0xff;
}

function percentDecodePath(path: string): string | null {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

function readRequestBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        reject(error);
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    };
    req.on('data', (chunk: Buffer | string) => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += data.length;
      if (totalBytes > maxBytes) {
        req.resume();
        finish(new Error('request body exceeds limit'));
        return;
      }
      chunks.push(data);
    });
    req.once('end', () => finish());
    req.once('error', (error) => finish(error));
    req.once('aborted', () => finish(new Error('request aborted')));
  });
}

function epochMs(): number {
  return Date.now();
}
