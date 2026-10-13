// 播放控制算法：水位评估、速率决策、位置误差计算。
//
// 从 quicPull.ts 提取，职责单一：根据播放端反馈决定播放速率。
// 不依赖 Node.js API，可在测试中直接调用。

import {
  DEFAULT_ALIGNMENT_DELAY_MS,
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
  SHARED_RATE_MAX_DEVIATION,
  SHARED_RATE_STEP,
} from './constants';
import {
  PlaybackFeedback,
  PlaybackControl,
  PlaybackControlReason,
  PlaybackRateState,
} from './types';
import { epochMs } from './http';

/**
 * 根据播放端最新水位和服务端时间轴位置决定播放速率。
 * 视频的字节数/gap 数是"或"关系,音频存在时必须同时满足音频帧阈值。
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
    previousState,
  ));
  if (controls.length === 1) {
    return controls[0];
  }
  const firstNonSteady = controls.find((control) => control.reason !== 'steady');
  if (firstNonSteady) {
    const slowest = controls
      .filter((control) => control.playbackRate < NORMAL_PLAYBACK_RATE)
      .sort((left, right) => left.playbackRate - right.playbackRate)[0];
    if (slowest) {
      return slowest;
    }
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
  const hasVideoReserve = hasVideoReserveFor(feedback);
  const hasAudioReserve = hasAudioReserveFor(
    feedback,
    MIN_AUDIO_FRAME_COUNT,
    previousState?.reason === 'underflow' ? RELEASE_AUDIO_BUFFER_MS : MIN_AUDIO_BUFFER_MS,
  );
  if (!hasVideoReserve || !hasAudioReserve) {
    return controlledPlaybackRate(SLOW_PLAYBACK_RATE, 'underflow', target, previousState);
  }

  if (target.positionErrorMs !== null) {
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

export function controlledPlaybackRate(
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

export function hasAudioReserveFor(
  feedback: PlaybackFeedback,
  frameCount: number,
  bufferedMs: number,
): boolean {
  if (!feedback.hasAudio) {
    return true;
  }
  const scheduledMs = feedback.audioBufferedMs;
  if (scheduledMs != null && Number.isFinite(scheduledMs)) {
    return scheduledMs >= bufferedMs;
  }
  return feedback.audioFrameCount >= frameCount;
}

export function hasVideoReserveFor(feedback: PlaybackFeedback): boolean {
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

/** 内置网页一旦收到帧便自行缓存到实测显示时刻;普通 FLV 客户端保持原行为。 */
export function browserPlayerReleaseLeadMs(alignmentDelayMs: number): number {
  if (!Number.isFinite(alignmentDelayMs)) {
    return 0;
  }
  return Math.max(0, alignmentDelayMs);
}

export function steadyPlaybackControl(): PlaybackControl {
  return {
    playbackRate: NORMAL_PLAYBACK_RATE,
    reason: 'steady',
    targetPositionUs: null,
    positionErrorMs: null,
  };
}
