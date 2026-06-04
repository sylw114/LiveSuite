import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { spawn, fork, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';

let mainWindow: BrowserWindow | null;
let udpServer: ChildProcess | null = null;
let rtmpServer: ChildProcess | null = null;
let udpRunning = false;
let rtmpRunning = false;
let isHighLatency = false;

let wasapiStatus = {
  hasDll: false,
  hasConfig: false,
};

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

ipcMain.handle('get-server-status', () => ({ udpRunning, rtmpRunning }));

// UDP Server Control
ipcMain.handle('start-udp-server', (_, config) => {
  if (udpRunning) return;

  const tcpPort = parseInt(config.tcpPort, 10);
  const udpPort = parseInt(config.udpPort, 10);

  if (isNaN(tcpPort) || tcpPort < 1 || tcpPort > 65535) {
    throw new Error('Invalid TCP Port: Must be a number between 1 and 65535');
  }
  if (isNaN(udpPort) || udpPort < 1 || udpPort > 65535) {
    throw new Error('Invalid UDP Port: Must be a number between 1 and 65535');
  }

  const serverPath = path.join(__dirname, '../../../subbuild/audio_server_udp.exe');
  const args = [
    '--tcp', tcpPort.toString(),
    '--udp', udpPort.toString()
  ];
  if (config.heartbeat) args.push('--heartbeat');
  if (config.discardOutOfOrder) args.push('--discard-out-of-order');

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
        mainWindow?.webContents.send('server-warning', 'UDP Server: High latency detected!');
      } else if (!isCurrentlyHigh && isHighLatency) {
        isHighLatency = false;
        mainWindow?.webContents.send('server-clear', 'UDP Server: Latency normal.');
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
ipcMain.handle('start-rtmp-server', (_, port) => {
  if (rtmpRunning) return;

  const rtmpPort = parseInt(port, 10);
  if (isNaN(rtmpPort) || rtmpPort < 1 || rtmpPort > 65535) {
    throw new Error('Invalid RTMP Port: Must be a number between 1 and 65535');
  }

  rtmpServer = fork(path.join(__dirname, 'nms_worker.js'));

  rtmpServer.on('error', (err) => {
    rtmpRunning = false;
    updateStatus();
    throw err;
  });

  rtmpServer.send({ type: 'start', port: rtmpPort });
  rtmpRunning = true;
  updateStatus();

  rtmpServer.on('exit', (code) => {
    rtmpRunning = false
    rtmpServer = null
    updateStatus()
    if(code === 1){
      dialog.showErrorBox('RTMP Server Error', 'Failed to start RTMP Server. Please check if the port is already in use or if there are permission issues.')
      return
    }
    if (code !== 0 && code !== null) {
      throw new Error(`RTMP Server process exited with code ${code}`)
    }
  });
});

ipcMain.handle('stop-rtmp-server', () => {
  if (!rtmpRunning) return;
  rtmpServer?.kill();
  rtmpServer = null;
  rtmpRunning = false;
  updateStatus();
});

app.whenReady().then(createWindow);
