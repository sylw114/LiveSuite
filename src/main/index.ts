import { app, BrowserWindow, ipcMain, shell, dialog, Menu } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import {
  LiveSuiteQuicMetrics,
  LiveSuiteQuicServer,
  LiveSuiteQuicSession,
} from './quicServer';
import {
  createStreamServer,
  DeclarativeStreamServer,
  RtmpProtocol,
  StreamServerDeclaration,
} from '@livesuite/stream-server';
import {
  AppLanguage,
  createDefaultPreferences,
  UserPreferenceStore,
} from './preferences';

let mainWindow: BrowserWindow | null;
let udpServer: ChildProcess | null = null;
let rtmpServer: DeclarativeStreamServer | null = null;
let quicServer: LiveSuiteQuicServer | null = null;
let udpRunning = false;
let rtmpRunning = false;
let quicRunning = false;
let isHighLatency = false;
let shuttingDown = false;
let shutdownComplete = false;
let shutdownPromise: Promise<void> | null = null;

let appLanguage: AppLanguage = 'en';
let preferenceStore: UserPreferenceStore | null = null;

let wasapiStatus = {
  hasDll: false,
  hasConfig: false,
};

function sendToRenderer(channel: string, ...args: unknown[]) {
  const window = mainWindow;
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return;
  }
  window.webContents.send(channel, ...args);
}

const mainMessages = {
  'zh-CN': {
    invalidTcpPort: '无效的 TCP 端口：必须是 1 到 65535 之间的数字',
    invalidUdpPort: '无效的音频端口：必须是 1 到 65535 之间的数字',
    invalidRtmpPort: '无效的 RTMP 端口：必须是 1 到 65535 之间的数字',
    invalidQuicPort: '无效的 QUIC 端口：必须是 1 到 65535 之间的数字',
    invalidQuicFallbackPort: '无效的 UDP 回退端口：必须是 1 到 65535 之间的数字',
    invalidHttpOutputPort: '无效的 HTTP 输出端口：必须是 1 到 65535 之间的数字',
    invalidReplayDuration: '回放缓存时长必须是 5 到 300 秒',
    invalidQuicSession: '无效的视频流会话',
    quicNotRunning: 'LiveSuite 低延迟服务器尚未运行',
    quicPortsConflict: 'QUIC 与 UDP 回退端口不能相同',
    quicErrorTitle: 'LiveSuite 低延迟服务器错误',
    quicStartFailed: 'LiveSuite 低延迟服务器启动失败。请检查接收程序、端口占用和防火墙设置。',
    udpHighLatency: 'UDP 服务器：检测到高延迟！',
    udpLatencyNormal: 'UDP 服务器：延迟已恢复正常。',
    rtmpErrorTitle: 'RTMP 服务器错误',
    rtmpStartFailed: 'RTMP 服务器启动失败。请检查端口是否已被占用，或是否存在权限问题。',
  },
  en: {
    invalidTcpPort: 'Invalid TCP Port: Must be a number between 1 and 65535',
    invalidUdpPort: 'Invalid audio port: Must be a number between 1 and 65535',
    invalidRtmpPort: 'Invalid RTMP Port: Must be a number between 1 and 65535',
    invalidQuicPort: 'Invalid QUIC Port: Must be a number between 1 and 65535',
    invalidQuicFallbackPort: 'Invalid UDP fallback port: Must be a number between 1 and 65535',
    invalidHttpOutputPort: 'Invalid HTTP output port: Must be a number between 1 and 65535',
    invalidReplayDuration: 'Replay buffer duration must be between 5 and 300 seconds',
    invalidQuicSession: 'Invalid video stream session',
    quicNotRunning: 'The LiveSuite low-latency server is not running',
    quicPortsConflict: 'QUIC and UDP fallback ports must be different',
    quicErrorTitle: 'LiveSuite Low-Latency Server Error',
    quicStartFailed: 'Failed to start the LiveSuite low-latency server. Check the receiver binary, port usage, and firewall settings.',
    udpHighLatency: 'UDP Server: High latency detected!',
    udpLatencyNormal: 'UDP Server: Latency normal.',
    rtmpErrorTitle: 'RTMP Server Error',
    rtmpStartFailed: 'Failed to start RTMP Server. Please check if the port is already in use or if there are permission issues.',
  },
};

type MainMessageKey = keyof typeof mainMessages.en;

function normalizeAppLanguage(language: unknown): AppLanguage {
  return typeof language === 'string' && language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

function mainT(key: MainMessageKey) {
  return mainMessages[appLanguage][key];
}

function getPreferenceStore(): UserPreferenceStore {
  if (!preferenceStore) {
    const defaults = createDefaultPreferences(normalizeAppLanguage(app.getLocale()));
    preferenceStore = new UserPreferenceStore(
      path.join(app.getPath('userData'), 'preferences.json'),
      defaults,
    );
  }
  return preferenceStore;
}

function checkWasapiStatus() {
  const buildDir = path.join(__dirname, '../../../subbuild');
  const dllPath = path.join(buildDir, 'wasapi_relink.dll');
  const configPath = path.join(__dirname, '../../../redirect_config.toml');

  wasapiStatus = {
    hasDll: fs.existsSync(dllPath),
    hasConfig: fs.existsSync(configPath),
  };
  sendToRenderer('wasapi-status-changed', wasapiStatus);
}

function updateStatus() {
  sendToRenderer('server-status-changed', {
    udpRunning,
    rtmpRunning,
    quicRunning,
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 860,
    minHeight: 640,
    backgroundColor: '#141619',
    title: 'LiveSuite',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('did-finish-load', () => {
    updateStatus();
    checkWasapiStatus();
  });
  mainWindow.on('close', (event) => {
    if (shutdownComplete) {
      return;
    }
    if (shuttingDown) {
      event.preventDefault();
      return;
    }
    if (!hasRunningServices()) return;
    event.preventDefault();
    void shutdownServices().then(() => {
      const window = mainWindow;
      if (window && !window.isDestroyed()) {
        window.close();
      } else {
        app.quit();
      }
    });
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Watch build directory for changes to wasapi_relink.dll
  const buildDir = path.join(__dirname, '../../../subbuild');
  if (fs.existsSync(buildDir)) {
    fs.watch(buildDir, (eventType, filename) => {
      if (filename === 'wasapi_relink.dll') {
        checkWasapiStatus();
      }
    });
  }
}

ipcMain.handle('get-wasapi-status', () => wasapiStatus);
ipcMain.handle('open-wasapi-folder', () => {
  const buildDir = path.join(__dirname, '../../../subbuild/');
  shell.openPath(buildDir);
});
ipcMain.handle('set-app-language', (_, language) => {
  appLanguage = normalizeAppLanguage(language);
  const current = getPreferenceStore().get();
  getPreferenceStore().replace({ ...current, language: appLanguage });
  return appLanguage;
});

ipcMain.handle('get-user-preferences', () => getPreferenceStore().get());
ipcMain.handle('set-user-preferences', (_, preferences) => {
  const saved = getPreferenceStore().replace(preferences);
  appLanguage = saved.language;
  return saved;
});

ipcMain.handle('get-server-status', () => ({
  udpRunning,
  rtmpRunning,
  quicRunning,
}));

// UDP Server Control
ipcMain.handle('start-udp-server', (_, config) => {
  if (udpRunning) return;

  const transport = config.transport === 'udp' ? 'udp' : 'quic';
  const tcpPort = parseInt(config.tcpPort, 10);
  const udpPort = parseInt(config.udpPort, 10);

  if (transport === 'udp' && (isNaN(tcpPort) || tcpPort < 1 || tcpPort > 65535)) {
    throw new Error(mainT('invalidTcpPort'));
  }
  if (isNaN(udpPort) || udpPort < 1 || udpPort > 65535) {
    throw new Error(mainT('invalidUdpPort'));
  }

  const serverPath = path.join(__dirname, '../../../subbuild/audio_server_udp.exe');
  const args = [
    '--transport', transport,
    '--udp', udpPort.toString()
  ];
  if (transport === 'udp') {
    args.push('--tcp', tcpPort.toString());
    if (config.discardOutOfOrder) args.push('--discard-out-of-order');
  }
  const dropBaselineMs = typeof config.dropBaselineMs === 'number' && !isNaN(config.dropBaselineMs)
    ? Math.max(0, config.dropBaselineMs) : 0;
  const protectMs = typeof config.protectMs === 'number' && !isNaN(config.protectMs)
    ? config.protectMs : null;

  if (dropBaselineMs > 0) {
    args.push('--drop-baseline-duration-ms', dropBaselineMs.toString());
    if (protectMs != null) args.push('--protect-ms', protectMs.toString());
  }

  udpServer = spawn(serverPath, args, {cwd: path.dirname(serverPath)});

  udpServer.on('error', (err) => {
    udpRunning = false;
    updateStatus();
    if (!shuttingDown) {
      console.error('[LiveSuite Audio]', err);
      sendToRenderer('server-warning', err.message);
    }
  });

  udpRunning = true;
  updateStatus();

  udpServer.stdout?.on('data', (data) => {
    const output = data.toString();
    const match = output.match(/availableToRead=(\d+)/);
    if (match) {
      const available = parseInt(match[1] || '0');
      const isCurrentlyHigh = available > 8000;

      if (isCurrentlyHigh && !isHighLatency) {
        isHighLatency = true;
        sendToRenderer('server-warning', mainT('udpHighLatency'));
      } else if (!isCurrentlyHigh && isHighLatency) {
        isHighLatency = false;
        sendToRenderer('server-clear', mainT('udpLatencyNormal'));
      }
    }
  });

  udpServer.on('exit', () => {
    udpRunning = false;
    isHighLatency = false;
    udpServer = null;
    updateStatus();
  });
});

ipcMain.handle('stop-udp-server', () => {
  if (!udpRunning) return;
  udpServer?.kill();
  udpServer = null;
  udpRunning = false;
  updateStatus();
});

// LiveSuite private low-latency video server (QUIC + raw UDP fallback)
let activeQuicSessions: Map<string, LiveSuiteQuicSession> = new Map();
let activeQuicMetrics: Map<string, LiveSuiteQuicMetrics> = new Map();

function getSubbuildDirectory(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'subbuild')
    : path.join(app.getAppPath(), 'subbuild');
}

function broadcastQuicConnections() {
  const sessions = [...activeQuicSessions.values()].map((session) => ({
    ...session,
    metrics: activeQuicMetrics.get(session.sessionId) ?? null,
  }));
  sendToRenderer('quic-connections-updated', sessions);
}

ipcMain.handle('start-quic-server', async(_, config) => {
  if (quicRunning) return;

  const quicPort = parseInt(config.quicPort, 10);
  const udpFallbackPort = parseInt(config.udpFallbackPort, 10);
  const httpOutputPort = parseInt(config.httpOutputPort, 10);
  if (isNaN(quicPort) || quicPort < 1 || quicPort > 65535) {
    throw new Error(mainT('invalidQuicPort'));
  }
  if (isNaN(udpFallbackPort) || udpFallbackPort < 1 || udpFallbackPort > 65535) {
    throw new Error(mainT('invalidQuicFallbackPort'));
  }
  if (isNaN(httpOutputPort) || httpOutputPort < 1 || httpOutputPort > 65535) {
    throw new Error(mainT('invalidHttpOutputPort'));
  }
  if (quicPort === udpFallbackPort) {
    throw new Error(mainT('quicPortsConflict'));
  }

  const parsedMaxLatency = Number(config.maxLatencyMs);
  const maxLatencyMs = Number.isFinite(parsedMaxLatency)
    ? Math.min(2000, Math.max(20, Math.round(parsedMaxLatency)))
    : 150;
  const recordingDir = path.join(app.getPath('videos'), 'LiveSuite', 'Recordings');
  // Rust 侧编译为 napi `.node` addon,由主进程内嵌加载(替代原 exe 子进程)。
  const addonPath = app.isPackaged
    ? path.join(process.resourcesPath, 'subbuild', 'livesuite-quic-server.node')
    : path.join(app.getAppPath(), 'native-bin', 'livesuite-quic-server.node');
  const browserPlayerHtmlPath = app.isPackaged
    ? path.join(process.resourcesPath, 'subbuild', 'browser_player.html')
    : path.join(app.getAppPath(), 'native', 'livesuite-quic', 'src', 'browser_player.html');
  activeQuicSessions = new Map();
  activeQuicMetrics = new Map();

  const server = new LiveSuiteQuicServer({
    addonPath,
    browserPlayerHtmlPath,
    port: quicPort,
    udpFallbackPort,
    httpOutputPort,
    recordingDir,
    maxLatencyMs,
    synchronizePullStreams: config.synchronizePullStreams === true,
    includeAudioInPull: config.includeAudioInPull === true,
  });
  quicServer = server;
  server.on('published', (session) => {
    activeQuicSessions.set(session.sessionId, session);
    broadcastQuicConnections();
  });
  server.on('publish-ended', (session) => {
    if (session.replayBuffering) {
      activeQuicSessions.set(session.sessionId, session);
    } else {
      activeQuicSessions.delete(session.sessionId);
      activeQuicMetrics.delete(session.sessionId);
    }
    broadcastQuicConnections();
  });
  server.on('metrics', (metrics) => {
    activeQuicMetrics.set(metrics.sessionId, metrics);
    const session = activeQuicSessions.get(metrics.sessionId);
    if (session) {
      activeQuicSessions.set(metrics.sessionId, {
        ...session,
        active: metrics.active,
        recordingEnabled: metrics.recordingEnabled,
        replayBuffering: metrics.replayBuffering,
        replayDurationMs: metrics.replayDurationMs,
        recordingPath: metrics.recordingPath ?? session.recordingPath,
      });
    }
    broadcastQuicConnections();
  });
  server.on('media-status', (status) => {
    const session = activeQuicSessions.get(status.sessionId);
    if (!session) return;
    const updated = {
      ...session,
      active: status.active,
      recordingEnabled: status.recordingEnabled,
      replayBuffering: status.replayBuffering,
      replayDurationMs: status.replayDurationMs,
      recordingPath: status.recordingPath ?? session.recordingPath,
    };
    if (!updated.active && !updated.replayBuffering) {
      activeQuicSessions.delete(status.sessionId);
      activeQuicMetrics.delete(status.sessionId);
    } else {
      activeQuicSessions.set(status.sessionId, updated);
    }
    broadcastQuicConnections();
  });
  server.on('error', (error) => {
    console.error('[LiveSuite Low Latency]', error);
    if (!shuttingDown) {
      sendToRenderer('server-warning', error.message);
    }
  });

  try {
    await server.start();
    quicRunning = true;
    updateStatus();
  } catch (error) {
    quicServer = null;
    quicRunning = false;
    updateStatus();
    const reason = error instanceof Error ? error.message : String(error);
    if (!shuttingDown) {
      dialog.showErrorBox(
        mainT('quicErrorTitle'),
        `${mainT('quicStartFailed')}\n\n${reason}`,
      );
    }
    throw error;
  }
});

ipcMain.handle('stop-quic-server', async() => {
  const server = quicServer;
  quicServer = null;
  quicRunning = false;
  await server?.stop();
  activeQuicSessions = new Map();
  activeQuicMetrics = new Map();
  broadcastQuicConnections();
  updateStatus();
});

ipcMain.handle('set-quic-synchronize-pull-streams', async(_, enabled) => {
  return requireQuicServer().setSynchronizePullStreams(enabled === true);
});

function requireQuicServer(): LiveSuiteQuicServer {
  if (!quicRunning || !quicServer) {
    throw new Error(mainT('quicNotRunning'));
  }
  return quicServer;
}

function requireQuicSessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{16}$/i.test(value)) {
    throw new Error(mainT('invalidQuicSession'));
  }
  return value.toLowerCase();
}

ipcMain.handle('start-quic-recording', async(_, sessionId) => {
  return requireQuicServer().startRecording(requireQuicSessionId(sessionId));
});

ipcMain.handle('stop-quic-recording', async(_, sessionId) => {
  return requireQuicServer().stopRecording(requireQuicSessionId(sessionId));
});

ipcMain.handle('start-quic-replay-buffer', async(_, sessionId, durationSeconds) => {
  const seconds = Number(durationSeconds);
  if (!Number.isFinite(seconds) || seconds < 5 || seconds > 300) {
    throw new Error(mainT('invalidReplayDuration'));
  }
  return requireQuicServer().startReplayBuffer(
    requireQuicSessionId(sessionId),
    Math.round(seconds * 1000),
  );
});

ipcMain.handle('save-quic-replay-buffer', async(_, sessionId) => {
  return requireQuicServer().saveReplayBuffer(requireQuicSessionId(sessionId));
});

ipcMain.handle('stop-quic-replay-buffer', async(_, sessionId) => {
  return requireQuicServer().stopReplayBuffer(requireQuicSessionId(sessionId));
});

ipcMain.handle('open-quic-folder', async() => {
  const outputDir = path.join(app.getPath('videos'), 'LiveSuite', 'Recordings');
  await fs.promises.mkdir(outputDir, { recursive: true });
  return shell.openPath(outputDir);
});

// RTMP Server Control
interface PublisherInfo {
  streamPath: string;
}

interface ViewerInfo {
  streamPath: string;
  ip: string;
}

let activePublishers: Map<string, PublisherInfo> = new Map();
let activeViewers: Map<string, ViewerInfo> = new Map();

function broadcastRtmpConnections() {
  const streams: Array<{ streamPath: string; publisherId: string; viewers: string[] }> = [];
  for (const [id, pub] of activePublishers) {
    const viewers: string[] = [];
    for (const [, viewer] of activeViewers) {
      if (viewer.streamPath === pub.streamPath) {
        viewers.push(viewer.ip);
      }
    }
    streams.push({ streamPath: pub.streamPath, publisherId: id, viewers });
  }
  sendToRenderer('rtmp-connections-updated', streams);
}

function getViewerIp(session: any): string {
  try {
    const socket = session.socket;
    if (socket && socket.remoteAddress) {
      return socket.remoteAddress;
    }
  } catch {
    // ignore
  }
  return 'unknown';
}

function getlocalAddresses(): string[] {
  const os = require('os');
  const interfaces = os.networkInterfaces();
  const ips: string[] = ['localhost'];
  for (const name of Object.keys(interfaces)) {
    for (const iface of (interfaces[name] || [])) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

ipcMain.handle('get-local-ips', () => getlocalAddresses());

ipcMain.handle('get-license-content', (_, type: 'summary' | 'full') => {
  try {
    const licensesDir = path.join(__dirname, '../../../licenses');
    if (type === 'summary') {
      const summaryPath = path.join(licensesDir, 'LICENSE_SUMMARY.md');
      return fs.readFileSync(summaryPath, 'utf-8');
    } else {
      const textPath = path.join(licensesDir, 'THIRD_PARTY_LICENSES.txt');
      return fs.readFileSync(textPath, 'utf-8');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return `Failed to load license content: ${message}`;
  }
});

ipcMain.handle('start-rtmp-server', async(_, port) => {
  if (rtmpRunning) return;

  const rtmpPort = parseInt(port, 10);
  if (isNaN(rtmpPort) || rtmpPort < 1 || rtmpPort > 65535) {
    throw new Error(mainT('invalidRtmpPort'));
  }

  activePublishers = new Map();
  activeViewers = new Map();

  const declaration: StreamServerDeclaration = {
    name: 'LiveSuite RTMP Server',
    protocols: {
      rtmp: RtmpProtocol.declare({
        port: rtmpPort,
        chunkSize: 30000,
        gopCache: false,
        pingSeconds: 30,
        pingTimeoutSeconds: 60,
        publish: true,
        play: true,
      }),
    },
  };

  rtmpServer = createStreamServer(declaration);
  rtmpServer.on('error', (event) => {
    console.error(event.error);
    rtmpRunning = false;
    rtmpServer = null;
    updateStatus();
    if (!shuttingDown) {
      dialog.showErrorBox(mainT('rtmpErrorTitle'), mainT('rtmpStartFailed'));
    }
  });

  rtmpServer.on('published', (event) => {
    console.log(`[StreamServer] Stream published: ${event.session.streamPath}`);
    activePublishers.set(event.session.id, { streamPath: event.session.streamPath });
    broadcastRtmpConnections();
  });

  rtmpServer.on('publish-ended', (event) => {
    console.log(`[StreamServer] Stream publish ended: ${event.session.streamPath}`);
    activePublishers.delete(event.session.id);
    broadcastRtmpConnections();
  });

  rtmpServer.on('player-connected', (event) => {
    console.log(`[StreamServer] Viewer connected: ${event.session.streamPath} (${event.session.ip})`);
    activeViewers.set(event.session.id, { streamPath: event.session.streamPath, ip: event.session.ip });
    broadcastRtmpConnections();
  });

  rtmpServer.on('player-disconnected', (event) => {
    console.log(`[StreamServer] Viewer disconnected: ${event.session.streamPath}`);
    activeViewers.delete(event.session.id);
    broadcastRtmpConnections();
  });

  await rtmpServer.start();
  rtmpRunning = true;
  updateStatus();
});

ipcMain.handle('stop-rtmp-server', async() => {
  if (!rtmpRunning) return;
  broadcastRtmpConnections();
  await rtmpServer?.stop();
  rtmpRunning = false;
  rtmpServer = null;
  updateStatus();
  activePublishers = new Map();
  activeViewers = new Map();
});

function hasRunningServices() {
  return Boolean(
    udpRunning
    || rtmpRunning
    || quicRunning
    || udpServer
    || rtmpServer
    || quicServer,
  );
}

function stopChildProcess(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, 2000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.once('error', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
}

function shutdownServices(): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }
  shuttingDown = true;
  const audio = udpServer;
  const stream = rtmpServer;
  const quic = quicServer;
  udpServer = null;
  rtmpServer = null;
  quicServer = null;
  udpRunning = false;
  rtmpRunning = false;
  quicRunning = false;
  isHighLatency = false;

  shutdownPromise = Promise.allSettled([
    stopChildProcess(audio),
    stream?.stop() ?? Promise.resolve(),
    quic?.stop() ?? Promise.resolve(),
  ]).then(() => {
    shutdownComplete = true;
  });
  return shutdownPromise;
}

app.on('before-quit', (event) => {
  if (shutdownComplete) {
    return;
  }
  if (shuttingDown) {
    event.preventDefault();
    return;
  }
  if (!hasRunningServices()) return;
  event.preventDefault();
  void shutdownServices().then(() => app.quit());
});

app.on('window-all-closed', () => {
  app.quit();
});

Menu.setApplicationMenu(null);
app.whenReady().then(() => {
  appLanguage = getPreferenceStore().get().language;
  createWindow();
});
