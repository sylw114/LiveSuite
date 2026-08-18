// LiveSuite QUIC 收流服务封装。
//
// 原来以子进程方式运行 Rust 二进制并通过 stdin/stdout JSON 通信;现在
// Rust 侧编译为 napi `.node` addon 内嵌加载,本类负责:
// - 加载 addon、注册事件回调、启动/停止收流服务;
// - 把 addon 事件(JSON 字符串)解析为 publish/metrics/error 事件;
// - 录制/回放缓存命令直接调用 addon 的同步方法;
// - 管理 HTTP-FLV 拉流 Hub(quicPull.ts),addon 作为帧源被轮询。
import { createRequire } from 'module';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import {
  QuicFrameSource,
  QuicPullHub,
  TakeFramesResult,
} from './quicPull';

export interface LiveSuiteQuicServerOptions {
  /** `.node` addon 绝对路径(替代原 binaryPath)。 */
  addonPath: string;
  bind?: string;
  port: number;
  udpFallbackPort?: number;
  httpOutputPort: number;
  recordingDir: string;
  maxLatencyMs?: number;
  reorderWindowMs?: number;
  synchronizePullStreams?: boolean;
  includeAudioInPull?: boolean;
  /** 内置浏览器播放器 HTML 路径(可选)。 */
  browserPlayerHtmlPath?: string;
}

export interface LiveSuiteQuicSession {
  sessionId: string;
  streamPath: string;
  ip: string;
  transport: 'quic' | 'udp';
  width?: number;
  height?: number;
  fps?: number;
  bitrate?: number;
  audioEnabled: boolean;
  audioSampleRate?: number;
  audioChannels?: number;
  audioBitrate?: number;
  audioGroupDurationUs?: number;
  httpPlaybackPath: string;
  recordingPath?: string;
  active: boolean;
  recordingEnabled: boolean;
  replayBuffering: boolean;
  replayDurationMs: number | null;
}

export interface LiveSuiteMediaStatus {
  sessionId: string;
  active: boolean;
  recordingEnabled: boolean;
  replayBuffering: boolean;
  replayDurationMs: number | null;
  recordingPath?: string;
}

export interface LiveSuiteMediaCommandResult extends LiveSuiteMediaStatus {
  paths: string[];
}

export interface LiveSuiteQuicMetrics extends LiveSuiteMediaStatus {
  protocol: 'quic';
  transport: 'quic' | 'udp';
  streamPath: string;
  frames: number;
  droppedFrames: number;
  lateFrames: number;
  recoveredFragments: number;
  packetLossRatio: number;
  bitrateKbps: number;
  fps: number;
  latencyMinMs: number | null;
  latencyMaxMs: number | null;
  encodeMinMs: number | null;
  encodeMaxMs: number | null;
  encodeAverageMs: number | null;
  encodeP95Ms: number | null;
  clockRttMs: number | null;
  finalLatencyMs: number | null;
  uptimeMs: number;
}

/** addon 侧对象结构(与 Rust `addon.rs` 的 napi 导出对应)。 */
interface AddonStartOptions {
  bind: string;
  port: number;
  udpFallbackPort?: number;
  recordingDir: string;
  maxLatencyMs: number;
  reorderWindowMs: number;
  synchronizePullStreams: boolean;
  includeAudioInPull: boolean;
}

interface AddonReadyInfo {
  port: number;
  udpFallbackPort?: number;
  recordingDir: string;
  synchronizePullStreams: boolean;
  includeAudioInPull: boolean;
}

interface AddonCommandResult {
  sessionId: string;
  ok: boolean;
  active: boolean;
  recordingEnabled: boolean;
  replayBuffering: boolean;
  replayDurationMs: number | null;
  recordingPath?: string;
  paths: string[];
  synchronizePullStreams: boolean;
  message?: string;
}

interface AddonEventMessage {
  type?: string;
  [key: string]: unknown;
}

interface QuicAddon {
  onEvent(callback: (json: string) => void): void;
  start(options: AddonStartOptions): AddonReadyInfo;
  stop(): void;
  takeFrames(sessionId: string, afterOrdinal: number): TakeFramesResult;
  syncInfoJson(): string;
  startRecording(sessionId: string): AddonCommandResult;
  stopRecording(sessionId: string): AddonCommandResult;
  startReplayBuffer(sessionId: string, durationMs: number): AddonCommandResult;
  saveReplayBuffer(sessionId: string): AddonCommandResult;
  stopReplayBuffer(sessionId: string): AddonCommandResult;
  setSynchronizePullStreams(enabled: boolean): AddonCommandResult;
}

function finiteNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function transport(value: unknown): 'quic' | 'udp' {
  return value === 'udp' ? 'udp' : 'quic';
}

export class LiveSuiteQuicServer extends EventEmitter {
  private addon: QuicAddon | null = null;
  private pullHub: QuicPullHub | null = null;
  private stopping = false;
  private readonly sessions = new Map<string, LiveSuiteQuicSession>();
  private started = false;

  constructor(private readonly options: LiveSuiteQuicServerOptions) {
    super();
  }

  override on(event: 'published', listener: (session: LiveSuiteQuicSession) => void): this;
  override on(event: 'publish-ended', listener: (session: LiveSuiteQuicSession) => void): this;
  override on(event: 'metrics', listener: (metrics: LiveSuiteQuicMetrics) => void): this;
  override on(event: 'media-status', listener: (status: LiveSuiteMediaStatus) => void): this;
  override on(event: 'error', listener: (error: Error) => void): this;
  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  snapshot(): LiveSuiteQuicSession[] {
    return [...this.sessions.values()];
  }

  get running(): boolean {
    return this.started;
  }

  get httpOutputPort(): number {
    return this.pullHub?.port() ?? this.options.httpOutputPort;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    const resolvedPath = path.resolve(this.options.addonPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`LiveSuite QUIC addon 不存在:${resolvedPath}`);
    }
    const require = createRequire(__filename);
    let addon: QuicAddon;
    try {
      addon = require(resolvedPath) as QuicAddon;
    } catch (error) {
      throw new Error(
        `加载 LiveSuite QUIC addon 失败:${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.stopping = false;
    addon.onEvent((json) => {
      try {
        const message = JSON.parse(json) as AddonEventMessage;
        this.handleMessage(message);
      } catch (error) {
        this.emit('error', new Error(
          `无法解析 QUIC addon 事件:${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    });
    let ready: AddonReadyInfo;
    try {
      ready = addon.start({
        bind: this.options.bind ?? '0.0.0.0',
        port: this.options.port,
        udpFallbackPort: this.options.udpFallbackPort,
        recordingDir: this.options.recordingDir,
        maxLatencyMs: this.options.maxLatencyMs ?? 150,
        reorderWindowMs: this.options.reorderWindowMs ?? 12,
        synchronizePullStreams: this.options.synchronizePullStreams === true,
        includeAudioInPull: this.options.includeAudioInPull === true,
      });
    } catch (error) {
      throw new Error(
        `启动 LiveSuite QUIC 收流端失败:${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.addon = addon;
    this.started = true;

    // HTTP-FLV 拉流服务:addon 作为帧源,由 Hub 轮询并分发。
    const frameSource: QuicFrameSource = {
      takeFrames: (sessionId, afterOrdinal) => addon.takeFrames(sessionId, afterOrdinal),
      syncInfoJson: () => addon.syncInfoJson(),
    };
    const pullHub = new QuicPullHub(frameSource, {
      bind: this.options.bind ?? '0.0.0.0',
      port: this.options.httpOutputPort,
      browserPlayerHtmlPath: this.options.browserPlayerHtmlPath,
    });
    await pullHub.start();
    pullHub.setIncludeAudio(this.options.includeAudioInPull === true);
    this.pullHub = pullHub;
    this.emit('started', {
      port: ready.port,
      udpFallbackPort: ready.udpFallbackPort,
      httpOutputPort: pullHub.port(),
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const pullHub = this.pullHub;
    this.pullHub = null;
    if (pullHub) {
      await pullHub.stop();
    }
    const addon = this.addon;
    this.addon = null;
    this.started = false;
    if (addon) {
      try {
        addon.stop();
      } catch (error) {
        this.emit('error', new Error(
          `停止 LiveSuite QUIC addon 失败:${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    }
    for (const session of this.sessions.values()) {
      this.emit('publish-ended', {
        ...session,
        active: false,
        recordingEnabled: false,
        replayBuffering: false,
        replayDurationMs: null,
      });
    }
    this.sessions.clear();
  }

  startRecording(sessionId: string): LiveSuiteMediaCommandResult {
    return this.runCommand((addon) => addon.startRecording(sessionId), sessionId);
  }

  stopRecording(sessionId: string): LiveSuiteMediaCommandResult {
    return this.runCommand((addon) => addon.stopRecording(sessionId), sessionId);
  }

  startReplayBuffer(sessionId: string, durationMs: number): LiveSuiteMediaCommandResult {
    return this.runCommand((addon) => addon.startReplayBuffer(sessionId, durationMs), sessionId);
  }

  saveReplayBuffer(sessionId: string): LiveSuiteMediaCommandResult {
    return this.runCommand((addon) => addon.saveReplayBuffer(sessionId), sessionId);
  }

  stopReplayBuffer(sessionId: string): LiveSuiteMediaCommandResult {
    return this.runCommand((addon) => addon.stopReplayBuffer(sessionId), sessionId);
  }

  setSynchronizePullStreams(enabled: boolean): LiveSuiteMediaCommandResult {
    if (!this.addon) {
      throw new Error('LiveSuite 低延迟服务器尚未运行');
    }
    return this.applyCommandResult(this.addon.setSynchronizePullStreams(enabled === true));
  }

  private runCommand(
    invoke: (addon: QuicAddon) => AddonCommandResult,
    sessionId: string,
  ): LiveSuiteMediaCommandResult {
    const addon = this.addon;
    if (!addon) {
      throw new Error('LiveSuite 低延迟服务器尚未运行');
    }
    let result: AddonCommandResult;
    try {
      result = invoke(addon);
    } catch (error) {
      const status = this.sessions.get(sessionId);
      const failed: LiveSuiteMediaCommandResult = {
        sessionId,
        active: status?.active ?? false,
        recordingEnabled: status?.recordingEnabled ?? false,
        replayBuffering: status?.replayBuffering ?? false,
        replayDurationMs: status?.replayDurationMs ?? null,
        recordingPath: status?.recordingPath,
        paths: [],
      };
      this.emit('error', new Error(
        error instanceof Error ? error.message : String(error),
      ));
      return failed;
    }
    return this.applyCommandResult(result);
  }

  private applyCommandResult(result: AddonCommandResult): LiveSuiteMediaCommandResult {
    const commandResult: LiveSuiteMediaCommandResult = {
      sessionId: result.sessionId,
      active: result.active === true,
      recordingEnabled: result.recordingEnabled === true,
      replayBuffering: result.replayBuffering === true,
      replayDurationMs: nullableNumber(result.replayDurationMs),
      recordingPath: result.recordingPath,
      paths: Array.isArray(result.paths)
        ? result.paths.filter((value): value is string => typeof value === 'string')
        : [],
    };
    this.applyMediaStatus(commandResult);
    this.emit('media-status', commandResult);
    if (result.ok !== true) {
      throw new Error(result.message || 'LiveSuite 运行时操作失败');
    }
    return commandResult;
  }

  private handleMessage(message: AddonEventMessage): void {
    if (message.type === 'published' && typeof message.sessionId === 'string'
      && typeof message.streamPath === 'string' && typeof message.httpPlaybackPath === 'string') {
      const session: LiveSuiteQuicSession = {
        sessionId: message.sessionId,
        streamPath: message.streamPath,
        ip: typeof message.ip === 'string' ? message.ip : 'unknown',
        transport: transport(message.transport),
        width: finiteNumber(message.width) || undefined,
        height: finiteNumber(message.height) || undefined,
        fps: finiteNumber(message.fps) || undefined,
        bitrate: finiteNumber(message.bitrate) || undefined,
        audioEnabled: message.audioEnabled === true,
        audioSampleRate: finiteNumber(message.audioSampleRate) || undefined,
        audioChannels: finiteNumber(message.audioChannels) || undefined,
        audioBitrate: finiteNumber(message.audioBitrate) || undefined,
        audioGroupDurationUs: finiteNumber(message.audioGroupDurationUs) || undefined,
        httpPlaybackPath: message.httpPlaybackPath,
        recordingPath: typeof message.recordingPath === 'string'
          ? message.recordingPath : undefined,
        active: message.active !== false,
        recordingEnabled: message.recordingEnabled === true,
        replayBuffering: message.replayBuffering === true,
        replayDurationMs: nullableNumber(message.replayDurationMs),
      };
      this.sessions.set(session.sessionId, session);
      this.pullHub?.registerSession({
        sessionId: session.sessionId,
        streamPath: session.streamPath,
        audioAvailable: session.audioEnabled,
        audioChannels: session.audioChannels ?? 0,
        audioGroupDurationUs: session.audioGroupDurationUs ?? 0,
      });
      this.emit('published', session);
      return;
    }
    if (message.type === 'publish-ended' && typeof message.sessionId === 'string') {
      const session = this.sessions.get(message.sessionId);
      if (session) {
        const endedSession: LiveSuiteQuicSession = {
          ...session,
          active: false,
          recordingEnabled: false,
          replayBuffering: message.replayBuffering === true,
          replayDurationMs: nullableNumber(message.replayDurationMs),
          recordingPath: typeof message.recordingPath === 'string'
            ? message.recordingPath : session.recordingPath,
        };
        if (endedSession.replayBuffering) {
          this.sessions.set(session.sessionId, endedSession);
        } else {
          this.sessions.delete(session.sessionId);
        }
        this.pullHub?.unregisterSession(session.sessionId);
        this.emit('publish-ended', endedSession);
      }
      return;
    }
    if (message.type === 'metrics' && typeof message.sessionId === 'string'
      && typeof message.streamPath === 'string') {
      const metrics: LiveSuiteQuicMetrics = {
        sessionId: message.sessionId,
        protocol: 'quic',
        transport: transport(message.transport),
        streamPath: message.streamPath,
        recordingPath: typeof message.recordingPath === 'string'
          ? message.recordingPath : undefined,
        active: message.active !== false,
        recordingEnabled: message.recordingEnabled === true,
        replayBuffering: message.replayBuffering === true,
        replayDurationMs: nullableNumber(message.replayDurationMs),
        frames: finiteNumber(message.frames),
        droppedFrames: finiteNumber(message.droppedFrames),
        lateFrames: finiteNumber(message.lateFrames),
        recoveredFragments: finiteNumber(message.recoveredFragments),
        packetLossRatio: finiteNumber(message.packetLossRatio),
        bitrateKbps: finiteNumber(message.bitrateKbps),
        fps: finiteNumber(message.fps),
        latencyMinMs: nullableNumber(message.latencyMinMs),
        latencyMaxMs: nullableNumber(message.latencyMaxMs),
        encodeMinMs: nullableNumber(message.encodeMinMs),
        encodeMaxMs: nullableNumber(message.encodeMaxMs),
        encodeAverageMs: nullableNumber(message.encodeAverageMs),
        encodeP95Ms: nullableNumber(message.encodeP95Ms),
        clockRttMs: nullableNumber(message.clockRttMs),
        finalLatencyMs: nullableNumber(message.finalLatencyMs),
        uptimeMs: finiteNumber(message.uptimeMs),
      };
      this.applyMediaStatus(metrics);
      this.emit('metrics', metrics);
      return;
    }
    if ((message.type === 'error' || message.type === 'fatal')
      && typeof message.message === 'string') {
      this.emit('error', new Error(message.message));
    }
  }

  private applyMediaStatus(status: LiveSuiteMediaStatus): void {
    if (!status.sessionId) {
      return;
    }
    const session = this.sessions.get(status.sessionId);
    if (!session) {
      return;
    }
    const updated: LiveSuiteQuicSession = {
      ...session,
      active: status.active,
      recordingEnabled: status.recordingEnabled,
      replayBuffering: status.replayBuffering,
      replayDurationMs: status.replayDurationMs,
      recordingPath: status.recordingPath ?? session.recordingPath,
    };
    if (!updated.active && !updated.replayBuffering) {
      this.sessions.delete(status.sessionId);
    } else {
      this.sessions.set(status.sessionId, updated);
    }
  }
}
