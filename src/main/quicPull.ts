// HTTP-FLV 拉流服务(原 Rust `http_output.rs` 的 Node 实现)。
//
// 收流端(Rust `.node` addon)负责 QUIC/UDP 收流、组帧、时钟同步与
// 帧缓冲;本模块在 Electron 主进程内提供 HTTP-FLV 输出:
// - 每个拉流连接持有独立的 FLV 时间轴、音视频水位与待发队列,连接之间
//   互不影响(多拉流方异常由此消除);
// - 同步模式下按帧上的 `releaseEpochMs` 与水位调度发送,保证多路流对齐。
import http from 'http';
import fs from 'fs';

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
  videoOriginUs: number | null = null;
  audioOriginUs: number | null = null;
  lastVideoTimestampMs = 0;
  lastAudioTimestampMs = 0;

  constructor(originServerMs: number | null) {
    if (originServerMs != null && originServerMs > 0) {
      const originUs = originServerMs * 1000;
      this.videoOriginUs = originUs;
      this.audioOriginUs = originUs;
    }
  }
}

/** 音视频水位:用于判断帧是否安全(不至于让音频跑在视频前面)。 */
class MediaWatermark {
  latestVideoPtsUs: number | null = null;
  latestAudioPtsUs: number | null = null;

  observe(frame: OutputFrame): void {
    const timeUs = mediaTimeUs(frame);
    if (frame.kind === RAW_KEYFRAME || frame.kind === RAW_DELTA) {
      this.latestVideoPtsUs = this.latestVideoPtsUs == null
        ? timeUs
        : Math.max(this.latestVideoPtsUs, timeUs);
    } else if (frame.kind === RAW_AUDIO) {
      this.latestAudioPtsUs = this.latestAudioPtsUs == null
        ? timeUs
        : Math.max(this.latestAudioPtsUs, timeUs);
    }
  }

  safePts(requireAudio: boolean, audioGroupDurationUs: number, synchronized: boolean): number | null {
    if (requireAudio && synchronized) {
      if (this.latestAudioPtsUs == null || this.latestVideoPtsUs == null) {
        return null;
      }
      const audioReadyPts = this.latestAudioPtsUs + Math.max(audioGroupDurationUs, 0);
      return Math.min(this.latestVideoPtsUs, audioReadyPts);
    }
    return this.latestVideoPtsUs ?? this.latestAudioPtsUs;
  }
}

/** 单个拉流连接:独立队列、时间轴、水位与待发帧。 */
class PullConnection {
  private frames: OutputFrame[] = [];
  private waiter: ((frame: OutputFrame | null) => void) | null = null;
  private closed = false;
  lastOrdinal = 0;
  timeline: FlvTimeline;
  watermark = new MediaWatermark();
  pending: OutputFrame[] = [];

  constructor(
    private readonly stream: http.ServerResponse,
    private readonly session: PullSession,
  ) {
    this.timeline = new FlvTimeline(session.originServerMs);
  }

  get includeAudio(): boolean {
    return this.session.includeAudio;
  }

  get audioChannels(): number {
    return this.session.audioChannels;
  }

  get audioGroupDurationUs(): number {
    return this.session.audioGroupDurationUs;
  }

  push(frame: OutputFrame): void {
    if (this.closed) {
      return;
    }
    if (frame.ordinal <= this.lastOrdinal) {
      return;
    }
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter(frame);
      return;
    }
    this.frames.push(frame);
    if (this.frames.length > MAX_QUEUED_FRAMES) {
      // 拉流端消费太慢:断开让其重连,避免内存无限增长并拖慢整体轮询。
      this.close();
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
    const requireAudio = this.includeAudio && this.session.audioAvailable;
    let ended = false;
    while (!ended && !this.closed) {
      try {
        await this.flushPendingFrames(stereo, false, this.watermark.safePts(
          requireAudio,
          this.audioGroupDurationUs,
          this.session.originServerMs != null,
        ));
      } catch {
        this.close();
        return;
      }
      const now = epochMs();
      let nextRelease: number | null = null;
      for (const frame of this.pending) {
        if (frame.releaseEpochMs != null && frame.releaseEpochMs > now) {
          nextRelease = nextRelease == null
            ? frame.releaseEpochMs
            : Math.min(nextRelease, frame.releaseEpochMs);
        }
      }
      const waitMs = nextRelease != null
        ? Math.min(5_000, Math.max(1, nextRelease - now))
        : (this.frames.length > 0 ? 0 : undefined);
      const frame = await this.nextFrame(waitMs);
      if (frame == null) {
        continue;
      }
      if (frame.ordinal <= this.lastOrdinal) {
        continue;
      }
      this.lastOrdinal = frame.ordinal;
      if (frame.kind === RAW_END) {
        ended = true;
        continue;
      }
      this.watermark.observe(frame);
      if (frame.releaseEpochMs != null) {
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
      await this.flushPendingFrames(stereo, true, null);
      stream.end();
    } catch {
      // 拉流端断开属于正常情况,静默结束。
    }
    this.close();
  }

  private async flushPendingFrames(
    stereo: boolean,
    forceAll: boolean,
    safeMediaPts: number | null,
  ): Promise<void> {
    const { stream } = this;
    const ready = takeReadyFrames(this.pending, epochMs(), forceAll, safeMediaPts);
    for (const frame of ready) {
      const tag = flvTag(frame, this.timeline, stereo);
      if (tag) {
        stream.write(tag);
      }
    }
    await Promise.resolve();
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
    this.sessions.set(info.sessionId, {
      ...info,
      includeAudio: this.includeAudio,
      originServerMs: null,
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
      streams?: Array<{ path: string; originServerMs: number }>;
    } = {};
    try {
      syncInfo = JSON.parse(this.source.syncInfoJson()) as typeof syncInfo;
    } catch {
      return;
    }
    const synchronized = syncInfo.synchronize === true;
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
    const endFrame: OutputFrame = {
      ordinal: Number.MAX_SAFE_INTEGER,
      kind: RAW_END,
      ptsUs: 0,
      timelineUs: null,
      releaseEpochMs: null,
      data: Buffer.alloc(0),
    };
    for (const connection of session.connections) {
      connection.push(endFrame);
    }
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
        const output: OutputFrame = {
          ordinal: frame.ordinal,
          kind: frame.kind,
          ptsUs: frame.ptsUs,
          timelineUs: frame.timelineUs,
          releaseEpochMs: frame.releaseEpochMs,
          data: frame.data,
        };
        for (const connection of session.connections) {
          connection.push(output);
        }
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
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Private-Network': 'true',
        'Content-Length': 0,
        'Connection': 'close',
      });
      res.end();
      return;
    }
    if (method !== 'GET') {
      writeHttpError(res, 405, 'Method Not Allowed');
      return;
    }
    const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
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
        body = JSON.stringify({
          ...info,
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
        'Connection': 'close',
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
    const connection = new PullConnection(res, session);
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
    for (const frame of snapshot.frames) {
      connection.push({
        ordinal: frame.ordinal,
        kind: frame.kind,
        ptsUs: frame.ptsUs,
        timelineUs: frame.timelineUs,
        releaseEpochMs: frame.releaseEpochMs,
        data: frame.data,
      });
      if (frame.ordinal > session.lastPolledOrdinal) {
        session.lastPolledOrdinal = frame.ordinal;
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

/** 取出已到 release 且未超过音视频水位的待发帧,按时间轴排序。 */
function takeReadyFrames(
  pending: OutputFrame[],
  now: number,
  forceAll: boolean,
  safeMediaPts: number | null,
): OutputFrame[] {
  const kept: OutputFrame[] = [];
  const ready: OutputFrame[] = [];
  for (const frame of pending) {
    const released = frame.releaseEpochMs == null || frame.releaseEpochMs <= now;
    const isMedia = frame.kind === RAW_KEYFRAME || frame.kind === RAW_DELTA
      || frame.kind === RAW_AUDIO;
    const mediaIsSafe = !isMedia
      || safeMediaPts == null
      || mediaTimeUs(frame) <= safeMediaPts;
    if (forceAll || (released && mediaIsSafe)) {
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
    if (isAudio) {
      if (frame.timelineUs == null && timeline.audioOriginUs != null && timeline.audioOriginUs > 1_000_000_000_000) {
        timeline.audioOriginUs = null;
      }
      if (timeline.audioOriginUs == null) {
        timeline.audioOriginUs = timeUs;
      }
      let timelineTimestamp = Math.max(0, timeUs - timeline.audioOriginUs) / 1000;
      timelineTimestamp = Math.floor(timelineTimestamp);
      if (timelineTimestamp < timeline.lastAudioTimestampMs) {
        timelineTimestamp = timeline.lastAudioTimestampMs;
      }
      timeline.lastAudioTimestampMs = timelineTimestamp;
      timestamp = wrapFlvTimestamp(timelineTimestamp);
    } else {
      if (frame.timelineUs == null && timeline.videoOriginUs != null && timeline.videoOriginUs > 1_000_000_000_000) {
        timeline.videoOriginUs = null;
      }
      if (timeline.videoOriginUs == null) {
        timeline.videoOriginUs = timeUs;
      }
      let timelineTimestamp = Math.max(0, timeUs - timeline.videoOriginUs) / 1000;
      timelineTimestamp = Math.floor(timelineTimestamp);
      if (timelineTimestamp < timeline.lastVideoTimestampMs) {
        timelineTimestamp = timeline.lastVideoTimestampMs;
      }
      timeline.lastVideoTimestampMs = timelineTimestamp;
      timestamp = wrapFlvTimestamp(timelineTimestamp);
    }
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

function epochMs(): number {
  return Date.now();
}
