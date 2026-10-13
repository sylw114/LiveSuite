// HTTP-FLV 拉流 Hub:维护会话、轮询 addon 帧并分发。
//
// 重构后仅保留会话生命周期、HTTP 路由与共享时钟编排;
// FLV 编码、播放控制算法、反馈解析、连接管理已拆到同级模块。

import http from 'http';
import fs from 'fs';
import { randomUUID } from 'crypto';

import {
  MAX_REPORTED_POSITION_US,
  MAX_REPORTED_CLOCK_MS,
  DEFAULT_ALIGNMENT_DELAY_MS,
  PLAYBACK_FEEDBACK_TTL_MS,
  SHARED_PLAYBACK_CONTROL_INTERVAL_MS,
  SHARED_REBUFFER_CONFIRM_MS,
  SHARED_REBUFFER_MIN_DEFICIT_MS,
  SHARED_STARTUP_MAX_LAG_MS,
  SHARED_STARTUP_RECOVERY_CONFIRM_MS,
  MIN_AUDIO_FRAME_COUNT,
  RELEASE_AUDIO_BUFFER_MS,
  MIN_AUDIO_BUFFER_MS,
} from './constants';
import {
  OutputFrame,
  ObservedPlaybackFeedback,
  RebufferObservation,
  PlaybackControl,
  PlaybackControlResponse,
  SharedPlaybackClock,
  PlaybackRateState,
  TakeFramesResult,
  QuicFrameSource,
  QuicPullHubOptions,
  PullSession,
  RAW_END,
} from './types';
import { epochMs, writeHttpError, writeJsonResponse, writeCorsPreflight, readRequestBody, percentDecodePath, CORS_HEADERS, NO_CACHE_HEADERS } from './http';
import { evaluatePlaybackControl, evaluateSharedPlaybackControl, steadyPlaybackControl, hasVideoReserveFor, hasAudioReserveFor, browserPlayerReleaseLeadMs } from './playbackControl';
import { readMetric, readNullableMetric, readAppliedPlaybackRate, readAlignmentRequest } from './feedback';
import { PullConnection } from './session';
import { FlvTimeline } from './flv';

// 重新导出 session 模块中的 takeReadyFrames 供外部测试使用。
export { takeReadyFrames } from './session';

const PLAYBACK_FEEDBACK_PATH = '/livesuite/playback-feedback';

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
  private playbackControl: PlaybackControl = steadyPlaybackControl();

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
    this.playbackControl = steadyPlaybackControl();
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
    this.alignmentReady = !synchronized || syncInfo.alignmentReady !== false;
    if (this.synchronizedPullStreams !== null && this.synchronizedPullStreams !== synchronized) {
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
    const updatedAtMs = epochMs();
    const key = this.feedbackKey(clientId, session.sessionId);
    const oldFeedback = this.playbackFeedback.get(key);
    const previousFeedback = oldFeedback && updatedAtMs - oldFeedback.updatedAtMs <= PLAYBACK_FEEDBACK_TTL_MS
      ? oldFeedback : undefined;
    const feedback: ObservedPlaybackFeedback = {
      clientId,
      playerBuildId: typeof body.playerBuildId === 'string' ? body.playerBuildId.slice(0, 64) : undefined,
      sessionId: session.sessionId,
      streamPath,
      videoBufferBytes: readMetric(body, 'videoBufferBytes', false),
      videoGapCount: readMetric(body, 'videoGapCount', true),
      audioFrameCount: readMetric(body, 'audioFrameCount', true),
      audioBufferedMs: readNullableMetric(body, 'audioBufferedMs', 60_000),
      requiredAlignmentDelayMs: readNullableMetric(body, 'requiredAlignmentDelayMs', 60_000),
      audioRequiredAlignmentDelayMs: readNullableMetric(body, 'audioRequiredAlignmentDelayMs', 60_000),
      videoRequiredAlignmentDelayMs: readNullableMetric(body, 'videoRequiredAlignmentDelayMs', 60_000),
      alignmentRequest: readAlignmentRequest(body),
      hasAudio: body.hasAudio === true,
      playbackPositionUs: readNullableMetric(body, 'playbackPositionUs', MAX_REPORTED_POSITION_US),
      audioPlaybackStarted: body.audioPlaybackStarted === true,
      audioPlaybackPositionUs: readNullableMetric(body, 'audioPlaybackPositionUs', MAX_REPORTED_POSITION_US),
      bufferedStartUs: readNullableMetric(body, 'bufferedStartUs', MAX_REPORTED_POSITION_US),
      bufferedEndUs: readNullableMetric(body, 'bufferedEndUs', MAX_REPORTED_POSITION_US),
      appliedPlaybackRate: readAppliedPlaybackRate(body),
      playbackClockMs: readNullableMetric(body, 'playbackClockMs', MAX_REPORTED_CLOCK_MS),
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
    const needsAcknowledgement = feedback.appliedPlaybackRate != null
      && Math.abs(feedback.appliedPlaybackRate - control.playbackRate) >= 0.001;
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
      writeCorsPreflight(res);
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
      writeJsonResponse(res, JSON.stringify(control));
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
      writeJsonResponse(res, body);
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
    this.refreshOriginServerMs();
    if (isBuiltInBrowserPlayer && session.synchronized && !this.alignmentReady) {
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
      ...NO_CACHE_HEADERS,
      'Connection': 'close',
    });
    res.end(html);
  }
}
