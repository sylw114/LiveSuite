import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  startUdpServer: (config: any) => ipcRenderer.invoke('start-udp-server', config),
  stopUdpServer: () => ipcRenderer.invoke('stop-udp-server'),
  startRtmpServer: (port: number) => ipcRenderer.invoke('start-rtmp-server', port),
  stopRtmpServer: () => ipcRenderer.invoke('stop-rtmp-server'),
  getServerStatus: () => ipcRenderer.invoke('get-server-status'),
  setAppLanguage: (language: string) => ipcRenderer.invoke('set-app-language', language),
  getlocalAddresses: () => ipcRenderer.invoke('get-local-ips'),
  getLicenseContent: (type: 'summary' | 'full') => ipcRenderer.invoke('get-license-content', type),
  onServerStatusChanged: (callback: (status: { udpRunning: boolean; rtmpRunning: boolean }) => void) => {
    ipcRenderer.on('server-status-changed', (_, status) => callback(status));
  },
  onServerWarning: (callback: (message: string) => void) => {
    ipcRenderer.on('server-warning', (_, message) => callback(message));
  },
  onServerClear: (callback: (message: string) => void) => {
    ipcRenderer.on('server-clear', (_, message) => callback(message));
  },
  onRtmpConnectionsUpdated: (callback: (streams: Array<{ streamPath: string; publisherId: string; viewers: string[] }>) => void) => {
    ipcRenderer.on('rtmp-connections-updated', (_, streams) => callback(streams));
  },
  getWasapiStatus: () => ipcRenderer.invoke('get-wasapi-status'),
  onWasapiStatusChanged: (callback: (status: { hasDll: boolean; hasConfig: boolean }) => void) => {
    ipcRenderer.on('wasapi-status-changed', (_, status) => callback(status));
  },
  openWasapiFolder: () => ipcRenderer.invoke('open-wasapi-folder')
});
