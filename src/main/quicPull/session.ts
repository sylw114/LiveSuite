// 拉流连接与帧调度：PullConnection 管理单个 HTTP-FLV 连接的生命周期。
//
// 从 quicPull.ts 提取，包含：
// - PullConnection：独立队列、时间轴与待发帧
// - takeReadyFrames：按 release 时刻取出就绪帧

import http from 'http';
import {
  MAX_QUEUED_FRAMES,
  DEFAULT_ALIGNMENT_DELAY_MS,
} from './constants';
import {
  OutputFrame,
  PullSession,
  RAW_END,
} from './types';
import { FlvTimeline, flvTag } from './flv';
import { writeStreamHeaders, epochMs } from './http';
import { browserPlayerReleaseLeadMs } from './playbackControl';

export { FlvTimeline } from './flv';

/** 单个拉流连接:独立队列、时间轴与待发帧。 */
export class PullConnection {
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
    const releaseLeadMs = this.builtInBrowserPlayer
      ? browserPlayerReleaseLeadMs(this.session.alignmentDelayMs)
      : 0;
    const release = frame.timelineUs / 1000 + this.session.alignmentDelayMs
      - releaseLeadMs;
    return Math.min(now + maxHold, Math.max(now - maxHold, release));
  }
}

/**
 * 所有轨道只按各自 release 时刻独立取出。这里刻意不接收另一轨道的水位，
 * 防止音频/视频互相等待后成批释放,破坏音频连续性和视频帧时间方差。
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
  ready.sort((a, b) => ((a.timelineUs ?? a.ptsUs) - (b.timelineUs ?? b.ptsUs)) || (a.ordinal - b.ordinal));
  pending.length = 0;
  pending.push(...kept);
  return ready;
}
