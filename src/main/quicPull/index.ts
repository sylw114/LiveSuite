// quicPull 模块统一入口。
//
// 从 quicServer.ts 的 `import { ... } from './quicPull'` 保持完全兼容。
// 各子模块按职责拆分后通过此文件重新导出。

// 帧类型常量
export {
  RAW_VIDEO_CONFIG,
  RAW_KEYFRAME,
  RAW_DELTA,
  RAW_AUDIO_CONFIG,
  RAW_END,
  RAW_AUDIO,
} from './types';

// 类型
export type {
  PlaybackFeedback,
  AlignmentRequestObservation,
  ObservedPlaybackFeedback,
  RebufferObservation,
  PlaybackControlReason,
  PlaybackControl,
  PlaybackRateState,
  SharedPlaybackClock,
  PlaybackControlResponse,
  PullFrame,
  TakeFramesResult,
  QuicFrameSource,
  QuicPullHubOptions,
  OutputFrame,
} from './types';

// 常量（原 quicPull.ts 中 export 的阈值）
export {
  POSITION_DRIFT_DEADBAND_MS,
  POSITION_DRIFT_CORRECTION_MS,
  POSITION_DRIFT_HARD_CORRECTION_MS,
  POSITION_DRIFT_HARD_RELEASE_MS,
  MIN_VIDEO_BUFFER_BYTES,
  MIN_VIDEO_GAP_COUNT,
  HIGH_VIDEO_BUFFER_BYTES,
  HIGH_VIDEO_GAP_COUNT,
  MIN_AUDIO_FRAME_COUNT,
  HIGH_AUDIO_FRAME_COUNT,
  MIN_AUDIO_BUFFER_MS,
  RELEASE_AUDIO_BUFFER_MS,
  HIGH_AUDIO_BUFFER_MS,
  SLOW_PLAYBACK_RATE,
  NORMAL_PLAYBACK_RATE,
  FAST_PLAYBACK_RATE,
  HARD_SLOW_PLAYBACK_RATE,
  HARD_FAST_PLAYBACK_RATE,
  MAX_PLAYBACK_RATE_STEP,
} from './constants';

// FLV 工具
export { wrapFlvTimestamp } from './flv';

// 播放控制算法
export { evaluatePlaybackControl, evaluateSharedPlaybackControl, browserPlayerReleaseLeadMs } from './playbackControl';

// 帧调度
export { takeReadyFrames } from './session';

// Hub 主类
export { QuicPullHub } from './hub';
