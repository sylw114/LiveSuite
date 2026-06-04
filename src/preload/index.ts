import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  startUdpServer: (config: any) => ipcRenderer.invoke('start-udp-server', config),
  stopUdpServer: () => ipcRenderer.invoke('stop-udp-server'),
  startRtmpServer: (port: number) => ipcRenderer.invoke('start-rtmp-server', port),
  stopRtmpServer: () => ipcRenderer.invoke('stop-rtmp-server'),
  getServerStatus: () => ipcRenderer.invoke('get-server-status'),
  onServerStatusChanged: (callback: (status: { udpRunning: boolean; rtmpRunning: boolean }) => void) => {
    ipcRenderer.on('server-status-changed', (_, status) => callback(status));
  },
  onServerWarning: (callback: (message: string) => void) => {
    ipcRenderer.on('server-warning', (_, message) => callback(message));
  },
  getWasapiStatus: () => ipcRenderer.invoke('get-wasapi-status'),
  onWasapiStatusChanged: (callback: (status: { hasDll: boolean; hasConfig: boolean }) => void) => {
    ipcRenderer.on('wasapi-status-changed', (_, status) => callback(status));
  },
  openWasapiFolder: () => ipcRenderer.invoke('open-wasapi-folder')
});
