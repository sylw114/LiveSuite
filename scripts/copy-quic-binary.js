const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Rust 侧编译为 napi cdylib(Windows 上为 .dll),改名为 .node 由 Electron 主进程加载。
const root = path.resolve(__dirname, '..');
const sourceFileName = process.platform === 'win32'
  ? 'livesuite_quic_server.dll'
  : 'liblivesuite_quic_server.so';
const targetFileName = process.platform === 'win32'
  ? 'livesuite-quic-server.node'
  : 'livesuite-quic-server.node';
const source = path.join(root, 'native', 'livesuite-quic', 'target', 'release', sourceFileName);
const destinationDirectory = path.join(root, 'native-bin');
const destination = path.join(destinationDirectory, targetFileName);

if (!fs.existsSync(source)) {
  throw new Error(`QUIC addon does not exist: ${source}. Run \`npm run build:quic:compile\` first.`);
}

fs.mkdirSync(destinationDirectory, { recursive: true });

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

if (fs.existsSync(destination)) {
  const sourceSize = fs.statSync(source).size;
  const destinationSize = fs.statSync(destination).size;

  if (sourceSize === destinationSize && sha256(source) === sha256(destination)) {
    console.log(`QUIC addon is already up to date: ${destination}`);
    process.exit(0);
  }
}

try {
  fs.copyFileSync(source, destination);
} catch (error) {
  if (process.platform === 'win32' && (error.code === 'EBUSY' || error.code === 'EPERM')) {
    throw new Error(
      `Cannot update the QUIC addon because it is in use: ${destination}. ` +
      'Stop the LiveSuite app and retry.'
    );
  }

  throw error;
}

console.log(`Copied ${source} to ${destination}`);
