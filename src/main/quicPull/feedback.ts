// 反馈体解析辅助：从 HTTP 请求体安全提取播放端指标。
//
// 从 quicPull.ts 的 acceptPlaybackFeedback 提取，避免每次调用重建闭包。

import { AlignmentRequestObservation } from './types';

export function readMetric(body: Record<string, unknown>, name: string, integer: boolean): number {
  const raw = body[name];
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return 0;
  }
  const value = Math.max(0, Math.min(256 * 1024 * 1024, raw));
  return integer ? Math.floor(value) : value;
}

export function readNullableMetric(body: Record<string, unknown>, name: string, maximum: number): number | null {
  const raw = body[name];
  if (raw == null || typeof raw !== 'number' || !Number.isFinite(raw)) {
    return null;
  }
  return Math.max(0, Math.min(maximum, raw));
}

export function readAppliedPlaybackRate(body: Record<string, unknown>): number | null {
  const raw = body.appliedPlaybackRate;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return null;
  }
  return raw >= 0.9 && raw <= 1.1 ? raw : null;
}

export function readAlignmentRequest(body: Record<string, unknown>): AlignmentRequestObservation | null {
  if (!body.alignmentRequest || typeof body.alignmentRequest !== 'object') return null;
  const request = body.alignmentRequest as Record<string, unknown>;
  if (request.track !== 'audio' && request.track !== 'video') return null;
  const detail = (name: string): number | null => typeof request[name] === 'number'
    && Number.isFinite(request[name]) ? request[name] as number : null;
  return {
    track: request.track,
    deltaMs: detail('deltaMs'),
    actualDelayMs: detail('actualDelayMs'),
    requestedDelayMs: detail('requestedDelayMs'),
    clockRevision: detail('clockRevision'),
    audioArrivalLeadMs: detail('audioArrivalLeadMs'),
    audioRequiredLeadMs: detail('audioRequiredLeadMs'),
    audioDecodeLatencyMs: detail('audioDecodeLatencyMs'),
    videoDecodeLeadMs: detail('videoDecodeLeadMs'),
  };
}
