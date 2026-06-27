import { app, BrowserWindow, ipcMain, shell, dialog, Menu } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import {
  createStreamServer,
  DeclarativeStreamServer,
  RtmpProtocol,
  StreamServerDeclaration,
} from '@livesuite/stream-server';

let mainWindow: BrowserWindow | null;
let udpServer: ChildProcess | null = null;
let rtmpServer: DeclarativeStreamServer | null = null;
let udpRunning = false;
let rtmpRunning = false;
let isHighLatency = false;
type AppLanguage = 'zh-CN' | 'en';

let appLanguage: AppLanguage = 'en';

let wasapiStatus = {
  hasDll: false,
  hasConfig: false,
};

const mainMessages = {
  'zh-CN': {
    invalidTcpPort: '无效的 TCP 端口：必须是 1 到 65535 之间的数字',
    invalidUdpPort: '无效的 UDP 端口：必须是 1 到 65535 之间的数字',
    invalidRtmpPort: '无效的 RTMP 端口：必须是 1 到 65535 之间的数字',
    udpHighLatency: 'UDP 服务器：检测到高延迟！',
    udpLatencyNormal: 'UDP 服务器：延迟已恢复正常。',
    rtmpErrorTitle: 'RTMP 服务器错误',
    rtmpStartFailed: 'RTMP 服务器启动失败。请检查端口是否已被占用，或是否存在权限问题。',
  },
  en: {
    invalidTcpPort: 'Invalid TCP Port: Must be a number between 1 and 65535',
    invalidUdpPort: 'Invalid UDP Port: Must be a number between 1 and 65535',
    invalidRtmpPort: 'Invalid RTMP Port: Must be a number between 1 and 65535',
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

function checkWasapiStatus() {
  const buildDir = path.join(__dirname, '../../../subbuild');
  const dllPath = path.join(buildDir, 'wasapi_relink.dll');
  const configPath = path.join(__dirname, '../../../redirect_config.toml');

  wasapiStatus = {
    hasDll: fs.existsSync(dllPath),
    hasConfig: fs.existsSync(configPath),
  };
  mainWindow?.webContents.send('wasapi-status-changed', wasapiStatus);
}

function updateStatus() {
  mainWindow?.webContents.send('server-status-changed', { udpRunning, rtmpRunning });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
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
  return appLanguage;
});

ipcMain.handle('get-server-status', () => ({ udpRunning, rtmpRunning }));

// UDP Server Control
ipcMain.handle('start-udp-server', (_, config) => {
  if (udpRunning) return;

  const tcpPort = parseInt(config.tcpPort, 10);
  const udpPort = parseInt(config.udpPort, 10);

  if (isNaN(tcpPort) || tcpPort < 1 || tcpPort > 65535) {
    throw new Error(mainT('invalidTcpPort'));
  }
  if (isNaN(udpPort) || udpPort < 1 || udpPort > 65535) {
    throw new Error(mainT('invalidUdpPort'));
  }

  const serverPath = path.join(__dirname, '../../../subbuild/audio_server_udp.exe');
  const args = [
    '--tcp', tcpPort.toString(),
    '--udp', udpPort.toString()
  ];
  if (config.discardOutOfOrder) args.push('--discard-out-of-order');
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
    throw err;
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
        mainWindow?.webContents.send('server-warning', mainT('udpHighLatency'));
      } else if (!isCurrentlyHigh && isHighLatency) {
        isHighLatency = false;
        mainWindow?.webContents.send('server-clear', mainT('udpLatencyNormal'));
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
  mainWindow?.webContents.send('rtmp-connections-updated', streams);
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
    dialog.showErrorBox(mainT('rtmpErrorTitle'), mainT('rtmpStartFailed'));
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

Menu.setApplicationMenu(null);
app.whenReady().then(createWindow);
