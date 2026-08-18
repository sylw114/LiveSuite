// 启动供 Android 长稳测试使用的 LiveSuite QUIC 收流端。
// 事件按 JSON Lines 输出，便于 PowerShell 测试脚本持续监控。
const fs = require('fs');
const os = require('os');
const path = require('path');

const addonPath = path.resolve(__dirname, '..', 'native-bin', 'livesuite-quic-server.node');
const addon = require(addonPath);
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const port = Number(args.get('--port') || 1935);
const udpFallbackPort = Number(args.get('--udp-fallback-port') || port + 1);
const recordingDir = path.resolve(
  args.get('--recording-dir') || fs.mkdtempSync(path.join(os.tmpdir(), 'livesuite-quic-longrun-')),
);

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

addon.onEvent((json) => {
  process.stdout.write(`${json}\n`);
});

try {
  const ready = addon.start({
    bind: args.get('--bind') || '0.0.0.0',
    port,
    udpFallbackPort,
    recordingDir,
    maxLatencyMs: 150,
    reorderWindowMs: 12,
    synchronizePullStreams: false,
    includeAudioInPull: false,
  });
  emit({ type: 'test-server-ready', ...ready });
} catch (error) {
  emit({ type: 'test-server-error', message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}

function stop() {
  try {
    addon.stop();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1000);
