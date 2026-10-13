// FLV 标签生成工具：时间轴管理与标签封装。
//
// 从 quicPull.ts 提取，职责单一：将 OutputFrame 转为 FLV 二进制标签。
// FLV 时间戳字段只有 32 位;内部时间轴保持完整值,写出时按规范回绕。

import { FLV_TIMESTAMP_MODULUS_MS } from './constants';
import { OutputFrame, RAW_VIDEO_CONFIG, RAW_KEYFRAME, RAW_DELTA, RAW_AUDIO_CONFIG, RAW_AUDIO } from './types';

export function wrapFlvTimestamp(timestampMs: number): number {
  if (!Number.isFinite(timestampMs)) {
    return 0;
  }
  const truncated = Math.floor(timestampMs) % FLV_TIMESTAMP_MODULUS_MS;
  return truncated < 0 ? truncated + FLV_TIMESTAMP_MODULUS_MS : truncated;
}

/** 每个拉流连接独立的 FLV 时间轴。 */
export class FlvTimeline {
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

function mediaTimeUs(frame: OutputFrame): number {
  return frame.timelineUs ?? frame.ptsUs;
}

/** FLV 标签封装;对时间戳进行单调保护避免丢帧。 */
export function flvTag(
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
  const tag = allocFlvTag(9, bodySize, timestamp);
  let offset = 11;
  tag[offset++] = frameAndCodec;
  tag[offset++] = packetType;
  tag[offset++] = 0;
  tag[offset++] = 0;
  tag[offset++] = 0;
  frame.data.copy(tag, offset);
  tag.writeUInt32BE(11 + bodySize, 11 + bodySize);
  return tag;
}

/** 分配 FLV 标签缓冲并写入 11 字节公共头 + 4 字节 previousTagSize 占位。 */
function allocFlvTag(tagType: number, bodySize: number, timestamp: number): Buffer {
  const tag = Buffer.alloc(11 + bodySize + 4);
  tag[0] = tagType;
  pushU24(tag, bodySize, 1);
  pushU24(tag, timestamp & 0x00ff_ffff, 4);
  tag[7] = (timestamp >> 24) & 0xff;
  tag[8] = 0;
  tag[9] = 0;
  tag[10] = 0;
  return tag;
}

function flvAudioTag(frame: OutputFrame, timestamp: number, stereo: boolean): Buffer {
  const packetType = frame.kind === RAW_AUDIO_CONFIG ? 0 : 1;
  const soundHeader = stereo ? 0xaf : 0xae;
  const bodySize = 2 + frame.data.length;
  const tag = allocFlvTag(8, bodySize, timestamp);
  let offset = 11;
  tag[offset++] = soundHeader;
  tag[offset++] = packetType;
  frame.data.copy(tag, offset);
  tag.writeUInt32BE(11 + bodySize, 11 + bodySize);
  return tag;
}

function pushU24(buffer: Buffer, value: number, offset: number): void {
  buffer[offset] = (value >> 16) & 0xff;
  buffer[offset + 1] = (value >> 8) & 0xff;
  buffer[offset + 2] = value & 0xff;
}
