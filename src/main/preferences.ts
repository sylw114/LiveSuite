import fs from 'fs';
import path from 'path';

export type AppLanguage = 'zh-CN' | 'en';
export type AudioTransport = 'quic' | 'udp';

export interface UserPreferences {
  version: 1;
  language: AppLanguage;
  audio: {
    transport: AudioTransport;
    tcpPort: number;
    audioPort: number;
    discardOutOfOrder: boolean;
    dropBaselineMs: number;
    protectMs: number;
  };
  video: {
    quicPort: number;
    udpFallbackPort: number;
    httpOutputPort: number;
    maxLatencyMs: number;
    replayBufferSeconds: number;
    synchronizePullStreams: boolean;
    includeAudioInPull: boolean;
  };
  rtmp: {
    port: number;
  };
}

export function createDefaultPreferences(language: AppLanguage = 'en'): UserPreferences {
  return {
    version: 1,
    language,
    audio: {
      transport: 'quic',
      tcpPort: 9000,
      audioPort: 9000,
      discardOutOfOrder: true,
      dropBaselineMs: 0,
      protectMs: 50,
    },
    video: {
      quicPort: 1935,
      udpFallbackPort: 9444,
      httpOutputPort: 8080,
      maxLatencyMs: 150,
      replayBufferSeconds: 30,
      synchronizePullStreams: false,
      includeAudioInPull: false,
    },
    rtmp: {
      port: 1935,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integerInRange(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, Math.round(parsed)))
    : fallback;
}

export function normalizePreferences(
  value: unknown,
  defaults: UserPreferences = createDefaultPreferences(),
): UserPreferences {
  const root = isRecord(value) ? value : {};
  const audio = isRecord(root.audio) ? root.audio : {};
  const video = isRecord(root.video) ? root.video : {};
  const rtmp = isRecord(root.rtmp) ? root.rtmp : {};

  return {
    version: 1,
    language: root.language === 'zh-CN' ? 'zh-CN' : root.language === 'en' ? 'en' : defaults.language,
    audio: {
      transport: audio.transport === 'udp' ? 'udp' : audio.transport === 'quic'
        ? 'quic' : defaults.audio.transport,
      tcpPort: integerInRange(audio.tcpPort, defaults.audio.tcpPort, 1, 65535),
      audioPort: integerInRange(audio.audioPort, defaults.audio.audioPort, 1, 65535),
      discardOutOfOrder: typeof audio.discardOutOfOrder === 'boolean'
        ? audio.discardOutOfOrder : defaults.audio.discardOutOfOrder,
      dropBaselineMs: integerInRange(audio.dropBaselineMs, defaults.audio.dropBaselineMs, 0, 60_000),
      protectMs: integerInRange(audio.protectMs, defaults.audio.protectMs, 0, 60_000),
    },
    video: {
      quicPort: integerInRange(video.quicPort, defaults.video.quicPort, 1, 65535),
      udpFallbackPort: integerInRange(video.udpFallbackPort, defaults.video.udpFallbackPort, 1, 65535),
      httpOutputPort: integerInRange(
        video.httpOutputPort,
        defaults.video.httpOutputPort,
        1,
        65535,
      ),
      maxLatencyMs: integerInRange(video.maxLatencyMs, defaults.video.maxLatencyMs, 20, 2000),
      replayBufferSeconds: integerInRange(
        video.replayBufferSeconds,
        defaults.video.replayBufferSeconds,
        5,
        300,
      ),
      synchronizePullStreams: typeof video.synchronizePullStreams === 'boolean'
        ? video.synchronizePullStreams : defaults.video.synchronizePullStreams,
      includeAudioInPull: typeof video.includeAudioInPull === 'boolean'
        ? video.includeAudioInPull : defaults.video.includeAudioInPull,
    },
    rtmp: {
      port: integerInRange(rtmp.port, defaults.rtmp.port, 1, 65535),
    },
  };
}

function clonePreferences(preferences: UserPreferences): UserPreferences {
  return JSON.parse(JSON.stringify(preferences)) as UserPreferences;
}

export class UserPreferenceStore {
  private preferences: UserPreferences;

  constructor(
    private readonly filePath: string,
    private readonly defaults: UserPreferences = createDefaultPreferences(),
  ) {
    this.preferences = this.load();
  }

  get(): UserPreferences {
    return clonePreferences(this.preferences);
  }

  replace(value: unknown): UserPreferences {
    const next = normalizePreferences(value, this.defaults);
    if (JSON.stringify(next) !== JSON.stringify(this.preferences)) {
      this.write(next);
      this.preferences = next;
    }
    return this.get();
  }

  private load(): UserPreferences {
    try {
      const content = fs.readFileSync(this.filePath, 'utf8');
      return normalizePreferences(JSON.parse(content), this.defaults);
    } catch (error) {
      const code = error instanceof Error && 'code' in error
        ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== 'ENOENT') {
        console.warn(`[Preferences] Failed to load ${this.filePath}:`, error);
      }
      return clonePreferences(this.defaults);
    }
  }

  private write(preferences: UserPreferences): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8');
    try {
      fs.renameSync(temporaryPath, this.filePath);
    } catch {
      fs.copyFileSync(temporaryPath, this.filePath);
      fs.unlinkSync(temporaryPath);
    }
  }
}
