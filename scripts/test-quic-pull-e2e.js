// 端到端测试: 验证 QUIC/UDP 收流与 HTTP-FLV 拉流全链路。
const http = require('http');
const dgram = require('dgram');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { LiveSuiteQuicServer } = require('../tscdist/main/quicServer');

const QUIC_PORT = 29350;
const UDP_PORT = 29444;
const HTTP_PORT = 28080;
const recordingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livesuite-pull-test-'));

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
  offset = u16(1920, body, offset);
  offset = u16(1080, body, offset);
  offset = u16(30, body, offset);
  offset = u32(8_000_000, body, offset);
  body[offset++] = 0; // audio_enabled: 0 for pure video test
  offset = u32(0, body, offset);
  body[offset++] = 0;
  offset = u32(0, body, offset);
  offset = u32(0, body, offset);
  return Buffer.concat([Buffer.from('LSQ1'), body]);
}

function buildMediaPacket({
  sessionId,
  frameId,
  flags,
  ptsUs,
  payload,
}) {
  const header = Buffer.alloc(60);
  let offset = 0;
  header.write('LSQ1', 0, 4, 'ascii');
  offset = 4;
  header[offset++] = 0x10; // [4] packet_type (PACKET_MEDIA)
  header[offset++] = flags; // [5] flags
  header.writeUInt16BE(60, offset); // [6..8] header_size = 60
  offset += 2;
  offset = u64(sessionId, header, offset); // [8..16] session_id
  offset = u32(frameId, header, offset); // [16..20] frame_id
  const now = Date.now();
  header.writeBigInt64BE(BigInt(now), offset); // [20..28] capture_epoch_ms
  offset += 8;
  header.writeBigInt64BE(BigInt(now), offset); // [28..36] encode_epoch_ms
  offset += 8;
  header.writeBigInt64BE(BigInt(ptsUs), offset); // [36..44] pts_us
  offset += 8;
  offset = u32(payload.length, header, offset); // [44..48] frame_size
  offset = u16(0, header, offset); // [48..50] fragment_index
  offset = u16(1, header, offset); // [50..52] fragment_count
  offset = u16(0, header, offset); // [52..54] fec_group_start
  header[offset++] = 1; // [54] fec_group_size
  header[offset++] = 0; // [55] reserved
  offset = u16(payload.length, header, offset); // [56..58] shard_size
  offset = u16(payload.length, header, offset); // [58..60] payload_size

  return Buffer.concat([header, payload]);
}

async function runTest() {
  console.log('--- Starting LiveSuite QUIC Pull E2E Test ---');

  const addonPath = path.join(__dirname, '..', 'native-bin', 'livesuite-quic-server.node');
  const server = new LiveSuiteQuicServer({
    addonPath,
    bind: '127.0.0.1',
    port: QUIC_PORT,
    udpFallbackPort: UDP_PORT,
    httpOutputPort: HTTP_PORT,
    recordingDir,
    synchronizePullStreams: false,
    includeAudioInPull: false,
  });

  let publishedSession = null;
  server.on('published', (session) => {
    console.log('[Server Event] Stream published:', session.streamPath);
    publishedSession = session;
  });

  await server.start();
  console.log('QUIC Server started on UDP:', UDP_PORT, 'HTTP:', HTTP_PORT);

  const sessionId = 0x11223344;
  const streamPath = '/phone/test';
  const udpSocket = dgram.createSocket('udp4');

  // 1. 发送 Hello
  const helloPacket = buildHello(sessionId, streamPath);
  await new Promise((resolve, reject) => {
    udpSocket.send(helloPacket, UDP_PORT, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
  });

  // 等待 published 事件
  const deadline = Date.now() + 3000;
  while (!publishedSession && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!publishedSession) {
    throw new Error('Timeout waiting for stream published event');
  }

  // 2. 发送 AVC Config 帧
  const avcConfigPayload = Buffer.from([
    0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x08,
    0x67, 0x64, 0x00, 0x1f, 0xac, 0x56, 0x80, 0x50,
    0x01, 0x00, 0x04, 0x68, 0xee, 0x3c, 0x80
  ]);
  const configPacket = buildMediaPacket({
    sessionId,
    frameId: 1,
    flags: 0x02, // FLAG_CONFIG
    ptsUs: 0,
    payload: avcConfigPayload,
  });
  await new Promise((resolve) => udpSocket.send(configPacket, UDP_PORT, '127.0.0.1', resolve));

  // 3. 发送 AVC IDR 关键帧
  const idrNalu = Buffer.from([0x65, 0x88, 0x84, 0x00, 0x10, 0x20, 0x30, 0x40]);
  const idrPayload = Buffer.alloc(4 + idrNalu.length);
  idrPayload.writeUInt32BE(idrNalu.length, 0);
  idrNalu.copy(idrPayload, 4);

  const keyframePacket = buildMediaPacket({
    sessionId,
    frameId: 2,
    flags: 0x00,
    ptsUs: 33333,
    payload: idrPayload,
  });
  await new Promise((resolve) => udpSocket.send(keyframePacket, UDP_PORT, '127.0.0.1', resolve));

  // 4. 发送 Delta 帧
  const deltaNalu = Buffer.from([0x41, 0x9a, 0x01, 0x02, 0x03, 0x04]);
  const deltaPayload = Buffer.alloc(4 + deltaNalu.length);
  deltaPayload.writeUInt32BE(deltaNalu.length, 0);
  deltaNalu.copy(deltaPayload, 4);

  const deltaPacket = buildMediaPacket({
    sessionId,
    frameId: 3,
    flags: 0x00,
    ptsUs: 66666,
    payload: deltaPayload,
  });
  await new Promise((resolve) => udpSocket.send(deltaPacket, UDP_PORT, '127.0.0.1', resolve));

  await new Promise((r) => setTimeout(r, 100));

  // 5. 启动并发拉流测试
  console.log('Testing concurrent HTTP-FLV pulling...');

  function pullFlv(clientName) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      const req = http.get(`http://127.0.0.1:${HTTP_PORT}${streamPath}.flv`, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`${clientName}: HTTP status ${res.statusCode}`));
        }
        if (res.headers['content-type'] !== 'video/x-flv') {
          return reject(new Error(`${clientName}: invalid content-type ${res.headers['content-type']}`));
        }
        res.on('data', (chunk) => {
          chunks.push(chunk);
          const totalBytes = chunks.reduce((acc, c) => acc + c.length, 0);
          if (totalBytes >= 50) {
            req.destroy();
            resolve(Buffer.concat(chunks));
          }
        });
        res.on('error', (err) => {
          if (err.code !== 'ECONNRESET') reject(err);
        });
      });
      req.on('error', (err) => {
        if (err.code !== 'ECONNRESET') reject(err);
      });
    });
  }

  const [flvData1, flvData2] = await Promise.all([
    pullFlv('Client 1'),
    pullFlv('Client 2'),
  ]);

  console.log('Client 1 received FLV bytes:', flvData1.length);
  console.log('Client 2 received FLV bytes:', flvData2.length);

  for (const [idx, flvData] of [flvData1, flvData2].entries()) {
    if (flvData.length < 13) {
      throw new Error(`Client ${idx + 1}: FLV data too short`);
    }
    const signature = flvData.slice(0, 3).toString('utf8');
    if (signature !== 'FLV') {
      throw new Error(`Client ${idx + 1}: Invalid FLV signature: ${signature}`);
    }
    const version = flvData[3];
    if (version !== 1) {
      throw new Error(`Client ${idx + 1}: Invalid FLV version: ${version}`);
    }
    console.log(`Client ${idx + 1} FLV Header verified successfully.`);
  }

  // 6. 验证 HTML 页面与 Sync Info 端点
  const syncInfoRes = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${HTTP_PORT}/livesuite/sync-info`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
  console.log('Sync info response:', JSON.stringify(syncInfoRes));
  if (!syncInfoRes.streams || syncInfoRes.streams.length === 0) {
    throw new Error('Sync info streams empty');
  }

  udpSocket.close();
  await server.stop();
  console.log('--- ALL TESTS PASSED SUCCESSFULLY! ---');
  process.exit(0);
}

runTest().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
