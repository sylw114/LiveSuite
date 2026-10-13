// 播放控制与帧源相关类型定义。
//
// 从 quicPull.ts 提取，供所有子模块共享。
// 不包含任何类定义——类留在各自的模块中。

/** 帧类型常量,与 Rust `frame_hub.rs` 保持一致。 */
export const RAW_VIDEO_CONFIG = 1;
export const RAW_KEYFRAME = 2;
export const RAW_DELTA = 3;
export const RAW_AUDIO_CONFIG = 4;
export const RAW_END = 5;
export const RAW_AUDIO = 6;

export interface PlaybackFeedback {
  clientId: string;
  playerBuildId?: string;
  sessionId: string;
  streamPath: string;
  videoBufferBytes: number;
  videoGapCount: number;
  audioFrameCount: number;
  audioBufferedMs?: number | null;
  requiredAlignmentDelayMs?: number | null;
  audioRequiredAlignmentDelayMs?: number | null;
  videoRequiredAlignmentDelayMs?: number | null;
  alignmentRequest?: AlignmentRequestObservation | null;
  hasAudio: boolean;
  playbackPositionUs: number | null;
  audioPlaybackStarted?: boolean;
  audioPlaybackPositionUs?: number | null;
  bufferedStartUs?: number | null;
  bufferedEndUs?: number | null;
  appliedPlaybackRate?: number | null;
  playbackClockMs: number | null;
  updatedAtMs: number;
}

export interface AlignmentRequestObservation {
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

export interface ObservedPlaybackFeedback extends PlaybackFeedback {
  videoUnderflowSinceMs: number | null;
  audioUnderflowSinceMs: number | null;
  videoProgressAtMs: number;
  audioProgressAtMs: number;
}

export interface RebufferObservation {
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

export interface PlaybackRateState {
  playbackRate: number;
  reason: PlaybackControlReason;
}

export interface SharedPlaybackClock {
  id: string;
  alignmentDelayMs: number;
  revision: number;
  anchorServerMs: number;
  anchorPositionUs: number;
  playbackRate: number;
  rebufferedUs: number;
  startupRecoveryRevision: number;
  stalledRecoveryRevision: number;
}

export interface PlaybackControlResponse extends Omit<PlaybackControl, 'playbackRate'> {
  playbackRate?: number;
  desiredPlaybackRate: number;
  sharedPlaybackClock?: SharedPlaybackClock | null;
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
  browserPlayerHtmlPath?: string;
  pollIntervalMs?: number;
}

/** 内部帧（ordinal 用于去重和水位推进）。 */
export interface OutputFrame {
  ordinal: number;
  kind: number;
  ptsUs: number;
  timelineUs: number | null;
  releaseEpochMs: number | null;
  data: Buffer;
}

/** PullConnection 最小接口，避免与 session.ts 的循环依赖。 */
export interface PullConnectionLike {
  includeAudio: boolean;
  audioChannels: number;
  timeline: { mediaOriginUs: number | null; lastVideoTimestampMs: number; lastAudioTimestampMs: number };
  pending: OutputFrame[];
  readonly isClosed: boolean;
  pushFrames(frames: readonly OutputFrame[]): void;
  close(): void;
  run(): Promise<void>;
}

/** 拉流会话状态（由 hub 管理，连接由 session 模块提供）。 */
export interface PullSession {
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
  connections: Set<PullConnectionLike>;
  lastPolledOrdinal: number;
}
