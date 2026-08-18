import { contextBridge, ipcRenderer } from 'electron';
import type { UserPreferences } from '../main/preferences';

contextBridge.exposeInMainWorld('api', {
  startUdpServer: (config: any) => ipcRenderer.invoke('start-udp-server', config),
  stopUdpServer: () => ipcRenderer.invoke('stop-udp-server'),
  startRtmpServer: (port: number) => ipcRenderer.invoke('start-rtmp-server', port),
  stopRtmpServer: async () => await ipcRenderer.invoke('stop-rtmp-server'),
  startQuicServer: (config: {
    quicPort: number;
    udpFallbackPort: number;
    httpOutputPort: number;
    maxLatencyMs: number;
    synchronizePullStreams: boolean;
    includeAudioInPull: boolean;
  }) =>
    ipcRenderer.invoke('start-quic-server', config),
  stopQuicServer: () => ipcRenderer.invoke('stop-quic-server'),
  setQuicSynchronizePullStreams: (enabled: boolean) =>
    ipcRenderer.invoke('set-quic-synchronize-pull-streams', enabled),
  startQuicRecording: (sessionId: string) =>
    ipcRenderer.invoke('start-quic-recording', sessionId),
  stopQuicRecording: (sessionId: string) =>
    ipcRenderer.invoke('stop-quic-recording', sessionId),
  startQuicReplayBuffer: (sessionId: string, durationSeconds: number) =>
    ipcRenderer.invoke('start-quic-replay-buffer', sessionId, durationSeconds),
  saveQuicReplayBuffer: (sessionId: string) =>
    ipcRenderer.invoke('save-quic-replay-buffer', sessionId),
  stopQuicReplayBuffer: (sessionId: string) =>
    ipcRenderer.invoke('stop-quic-replay-buffer', sessionId),
  openQuicFolder: () => ipcRenderer.invoke('open-quic-folder'),
  getServerStatus: () => ipcRenderer.invoke('get-server-status'),
  getUserPreferences: (): Promise<UserPreferences> => ipcRenderer.invoke('get-user-preferences'),
  setUserPreferences: (preferences: UserPreferences): Promise<UserPreferences> =>
    ipcRenderer.invoke('set-user-preferences', preferences),
  setAppLanguage: (language: string) => ipcRenderer.invoke('set-app-language', language),
  getlocalAddresses: () => ipcRenderer.invoke('get-local-ips'),
  getLicenseContent: (type: 'summary' | 'full') => ipcRenderer.invoke('get-license-content', type),
  onServerStatusChanged: (callback: (status: {
    udpRunning: boolean;
    rtmpRunning: boolean;
    quicRunning: boolean;
  }) => void) => {
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
  onQuicConnectionsUpdated: (callback: (sessions: unknown[]) => void) => {
    ipcRenderer.on('quic-connections-updated', (_, sessions) => callback(sessions));
  },
  getWasapiStatus: () => ipcRenderer.invoke('get-wasapi-status'),
  onWasapiStatusChanged: (callback: (status: { hasDll: boolean; hasConfig: boolean }) => void) => {
    ipcRenderer.on('wasapi-status-changed', (_, status) => callback(status));
  },
  openWasapiFolder: () => ipcRenderer.invoke('open-wasapi-folder'),
});
