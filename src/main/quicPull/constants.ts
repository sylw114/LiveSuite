// 共享常量：从 quicPull.ts 和 browser_player.html 中提取的公共阈值。
//
// 保持单一来源,避免两处各自维护同一数值。

/** 单连接待发队列上限,超过即断开(慢客户端断开重连,不影响其他连接)。 */
export const MAX_QUEUED_FRAMES = 512;
export const FLV_TIMESTAMP_MODULUS_MS = 0x1_0000_0000;
export const PLAYBACK_FEEDBACK_PATH = '/livesuite/playback-feedback';
export const PLAYBACK_FEEDBACK_TTL_MS = 2_500;
export const SHARED_PLAYBACK_CONTROL_INTERVAL_MS = 250;
export const SHARED_RATE_MAX_DEVIATION = 0.005;
export const SHARED_RATE_STEP = 0.0005;
export const SHARED_REBUFFER_MIN_DEFICIT_MS = 100;
export const SHARED_REBUFFER_CONFIRM_MS = SHARED_PLAYBACK_CONTROL_INTERVAL_MS * 2;
export const SHARED_STARTUP_MAX_LAG_MS = 1000;
export const SHARED_STARTUP_RECOVERY_CONFIRM_MS = 300;
export const DEFAULT_ALIGNMENT_DELAY_MS = 180;
export const MAX_REPORTED_POSITION_US = Number.MAX_SAFE_INTEGER;
export const MAX_REPORTED_CLOCK_MS = Number.MAX_SAFE_INTEGER;

/** 位置控制留出超过两帧的死区，避免显示帧的离散 PTS 触发往返调速。 */
export const POSITION_DRIFT_DEADBAND_MS = 55;
export const POSITION_DRIFT_CORRECTION_MS = 100;
export const POSITION_DRIFT_HARD_CORRECTION_MS = 450;
export const POSITION_DRIFT_HARD_RELEASE_MS = 220;

/** 播放端水位阈值:字节和视频 gap 满足任一项即可认为有足够余量。 */
export const MIN_VIDEO_BUFFER_BYTES = 1 * 1024 * 1024;
export const MIN_VIDEO_GAP_COUNT = 1;
export const HIGH_VIDEO_BUFFER_BYTES = 10 * 1024 * 1024;
export const HIGH_VIDEO_GAP_COUNT = 5;
export const MIN_AUDIO_FRAME_COUNT = 3;
export const HIGH_AUDIO_FRAME_COUNT = 20;
export const MIN_AUDIO_BUFFER_MS = 35;
export const RELEASE_AUDIO_BUFFER_MS = 80;
export const HIGH_AUDIO_BUFFER_MS = 320;

export const SLOW_PLAYBACK_RATE = 0.99;
export const NORMAL_PLAYBACK_RATE = 1;
export const FAST_PLAYBACK_RATE = 1.01;
export const HARD_SLOW_PLAYBACK_RATE = 0.97;
export const HARD_FAST_PLAYBACK_RATE = 1.03;
export const MAX_PLAYBACK_RATE_STEP = 0.002;
