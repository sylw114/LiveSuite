// QUIC addon 冒烟测试:验证 addon 模式下端口绑定、UDP 收流、
// 事件回调、会话注册与 take_frames 全链路是否工作。
// 用法:node scripts/smoke-quic-addon.js
const dgram = require('dgram');
const os = require('os');
const path = require('path');
const fs = require('fs');

const addonPath = path.join(__dirname, '..', 'native-bin', 'livesuite-quic-server.node');
const addon = require(addonPath);

const QUIC_PORT = 19350;
const UDP_PORT = 19444;
const recordingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livesuite-smoke-'));

function u16(value, out, offset) {
  out.writeUInt16BE(value & 0xffff, offset);
  return offset + 2;
}
function u32(value, out, offset) {
  out.writeUInt32BE(value >>> 0, offset);
  return offset + 4;
}
function u64(value, out, offset) {
  out.writeBigUInt64BE(BigInt(value), offset);
  return offset + 8;
}

// 构造一个合法 hello 包:LSQ1 + PACKET_UDP_HELLO + hello 数据
// hello 布局(与 parse_hello 一致):[0] type, [1] version, [2..10]
// session_id u64, [10] padding, [11..13] path_len u16, [13..] path,
// 之后是 width/height/fps/bitrate/audio_enabled/sample_rate/channels/
// bitrate, 最后 4 字节 audio_group_duration_us。
function buildHello(sessionId, streamPath) {
  const pathBytes = Buffer.from(streamPath, 'utf8');
  const body = Buffer.alloc(13 + pathBytes.length + 20 + 4);
  let offset = 0;
  body[offset++] = 0x12; // PACKET_UDP_HELLO
  body[offset++] = 1; // PROTOCOL_VERSION
  offset = u64(sessionId, body, offset);
  body[offset++] = 0; // padding
  offset = u16(pathBytes.length, body, offset);
  pathBytes.copy(body, offset);
  offset += pathBytes.length;
  offset = u16(1920, body, offset); // width
  offset = u16(1080, body, offset); // height
  offset = u16(30, body, offset); // fps
  offset = u32(8_000_000, body, offset); // bitrate
  body[offset++] = 1; // audio_enabled
  offset = u32(48_000, body, offset); // audio_sample_rate
  body[offset++] = 2; // audio_channels
  offset = u32(128_000, body, offset); // audio_bitrate
  offset = u32(40_000, body, offset); // audio_group_duration_us
  const packet = Buffer.concat([Buffer.from('LSQ1'), body]);
  return packet;
}

let eventLog = [];
const events = new Promise((resolve) => {
  addon.onEvent((json) => {
    eventLog.push(json);
    try {
      const msg = JSON.parse(json);
      if (msg.type === 'published' && msg.sessionId) {
        resolve(msg);
      }
    } catch { /* ignore */ }
  });
});

console.log('starting addon...');
const ready = addon.start({
  bind: '127.0.0.1',
  port: QUIC_PORT,
  udpFallbackPort: UDP_PORT,
  recordingDir,
  maxLatencyMs: 150,
  reorderWindowMs: 12,
  synchronizePullStreams: false,
  includeAudioInPull: false,
});
console.log('ready:', JSON.stringify(ready));

const sessionId = 0xabcdef01;
const streamPath = '/phone/smoke';
const hello = buildHello(sessionId, streamPath);

const socket = dgram.createSocket('udp4');
const timeout = setTimeout(() => {
  console.error('FAIL: 等待 published 事件超时');
  console.error('events so far:', eventLog);
  process.exit(1);
}, 5000);

socket.send(hello, UDP_PORT, '127.0.0.1', (err) => {
  if (err) {
    console.error('FAIL: 发送 hello 失败', err);
    process.exit(1);
  }
  console.log('hello sent to udp:', UDP_PORT);
});

events.then(async (published) => {
  clearTimeout(timeout);
  console.log('published event:', JSON.stringify(published));
  if (published.streamPath !== streamPath) {
    console.error('FAIL: streamPath 不匹配', published.streamPath);
    process.exit(1);
  }
  // 验证 take_frames 可用(空缓冲,resync=true)
  const frames = addon.takeFrames(published.sessionId, 0);
  console.log('takeFrames(0):', JSON.stringify({ resync: frames.resync, closed: frames.closed, count: frames.frames.length }));
  // 验证 sync-info
  const syncInfo = JSON.parse(addon.syncInfoJson());
  console.log('syncInfo streams:', syncInfo.streams.length);
  // 验证命令
  const rec = addon.startRecording(published.sessionId);
  console.log('startRecording ok:', rec.ok, 'recordingEnabled:', rec.recordingEnabled);
  addon.stopRecording(published.sessionId);
  socket.close();
  addon.stop();
  console.log('SMOKE TEST PASSED');
  process.exit(0);
}).catch((error) => {
  console.error('FAIL:', error);
  process.exit(1);
});
