const assert = require('node:assert/strict');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const {
  QuicPullHub,
  RAW_VIDEO_CONFIG,
  RAW_AUDIO_CONFIG,
  RAW_KEYFRAME,
  RAW_DELTA,
  RAW_AUDIO,
} = require('../tscdist/main/quicPull');

async function openPlayer(port, streamPath) {
  const tags = [];
  let buffer = Buffer.alloc(0);
  let headerRead = false;
  const request = http.get({
    host: '127.0.0.1', port,
    path: streamPath + '.flv?livesuite-player=1',
    agent: false,
  });
  const response = await new Promise((resolve, reject) => {
    request.once('response', resolve);
    request.once('error', reject);
  });
  assert.equal(response.statusCode, 200);
  response.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!headerRead) {
      if (buffer.length < 13) return;
      assert.equal(buffer.toString('ascii', 0, 3), 'FLV');
      buffer = buffer.subarray(buffer.readUInt32BE(5) + 4);
      headerRead = true;
    }
    while (buffer.length >= 15) {
      const size = buffer.readUIntBE(1, 3);
      const total = 11 + size + 4;
      if (buffer.length < total) break;
      tags.push({
        type: buffer[0],
        packetType: buffer[12],
        id: buffer[11 + size - 1],
      });
      buffer = buffer.subarray(total);
    }
  });
  return { tags, close: () => { response.destroy(); request.destroy(); } };
}

async function waitForTag(player, id) {
  const deadline = Date.now() + 2000;
  while (!player.tags.some((tag) => tag.id === id) && Date.now() < deadline) {
    await delay(10);
  }
  assert.ok(player.tags.some((tag) => tag.id === id),
    `missing FLV tag ${id}; received ${JSON.stringify(player.tags)}`);
}

async function testSnapshots(synchronize) {
  const originServerMs = Date.now() - 5000;
  const frame = (ordinal, kind, ptsUs) => ({
    ordinal, kind, ptsUs,
    timelineUs: synchronize ? originServerMs * 1000 + ptsUs : null,
    releaseEpochMs: null,
    data: Buffer.from([ordinal]),
  });
  // The cached audio configuration predates a video reconfiguration. Audio
  // arrives later than video, so media-time order also differs from ordinal order.
  const snapshot = [
    frame(7, RAW_VIDEO_CONFIG, 0),
    frame(1, RAW_AUDIO_CONFIG, 0),
    frame(8, RAW_KEYFRAME, 1_000_000),
    frame(12, RAW_AUDIO, 1_010_000),
    frame(9, RAW_DELTA, 1_020_000),
    frame(13, RAW_AUDIO, 1_030_000),
  ];
  const phoneSnapshot = [frame(1, RAW_VIDEO_CONFIG, 0), frame(2, RAW_KEYFRAME, 1_000_000)];
  let padSnapshot = snapshot;
  let sourceDelayMs = 250;
  let incremental = [];
  const pollCursors = [];
  const hub = new QuicPullHub({
    takeFrames: (sessionId, afterOrdinal) => {
      if (sessionId === 'phone') {
        return { resync: false, closed: false,
          frames: afterOrdinal === 0 ? phoneSnapshot : [] };
      }
      pollCursors.push(afterOrdinal);
      return { resync: false, closed: false,
        frames: afterOrdinal === 0 ? padSnapshot
          : incremental.filter((item) => item.ordinal > afterOrdinal) };
    },
    syncInfoJson: () => JSON.stringify({
      synchronize, alignmentReady: true, alignmentDelayMs: sourceDelayMs,
      streams: ['/pad/stream', '/phone/stream'].map((path) => ({ path, originServerMs })),
    }),
  }, { bind: '127.0.0.1', port: 0, pollIntervalMs: 60_000 });
  hub.setIncludeAudio(true);
  for (const [sessionId, streamPath, audioAvailable] of [
    ['pad', '/pad/stream', true], ['phone', '/phone/stream', false],
  ]) {
    hub.registerSession({ sessionId, streamPath, audioAvailable,
      audioChannels: audioAvailable ? 2 : 0, audioGroupDurationUs: audioAvailable ? 40_000 : 0 });
  }
  const players = [];
  try {
    const port = await hub.start();
    const first = await openPlayer(port, '/pad/stream');
    players.push(first);
    await waitForTag(first, 13);
    assert.deepEqual(first.tags.map((tag) => tag.id), [7, 1, 8, 12, 9, 13],
      'snapshot must retain both configurations and every GOP frame in media-time order');
    assert.deepEqual(first.tags.slice(0, 2).map(({ type, packetType }) => ({ type, packetType })),
      [{ type: 9, packetType: 0 }, { type: 8, packetType: 0 }]);
    const phone = await openPlayer(port, '/phone/stream');
    players.push(phone);
    await waitForTag(phone, 2);
    assert.ok(phone.tags.every((tag) => tag.type === 9), 'the silent stream stays video-only');

    // A second browser joins between two hub polls, after new audio arrived.
    // Its newer snapshot must not move the shared cursor past the first player.
    incremental = [frame(14, RAW_AUDIO, 1_040_000), frame(15, RAW_DELTA, 1_050_000)];
    padSnapshot = snapshot.concat(incremental);
    const second = await openPlayer(port, '/pad/stream');
    players.push(second);
    await waitForTag(second, 15);
    hub.poll();
    assert.equal(pollCursors.at(-1), 13, 'a joining player must not consume frames for existing players');
    await waitForTag(first, 15);
    incremental.push(frame(16, RAW_AUDIO, 1_060_000));
    hub.poll();
    await Promise.all([waitForTag(first, 16), waitForTag(second, 16)]);
    for (const player of [first, second]) {
      assert.deepEqual(player.tags.map((tag) => tag.id), [7, 1, 8, 12, 9, 13, 14, 15, 16],
        'snapshot and live polling must deliver all audio/video exactly once to each player');
    }
    if (synchronize) {
      const base = 'http://127.0.0.1:' + port;
      const clock = async () => (await (await fetch(base + '/livesuite/sync-info',
        { signal: AbortSignal.timeout(2000) })).json()).sharedPlaybackClock;
      const reports = [
        { clientId: 'first', streamPath: '/pad/stream', hasAudio: true,
          videoBufferBytes: 0, videoGapCount: 5, audioFrameCount: 10, audioBufferedMs: 180,
          playbackPositionUs: null },
        { clientId: 'second', streamPath: '/pad/stream', hasAudio: true,
          videoBufferBytes: 0, videoGapCount: 5, audioFrameCount: 10, audioBufferedMs: 180,
          playbackPositionUs: null },
        { clientId: 'phone', streamPath: '/phone/stream', hasAudio: false,
          videoBufferBytes: 0, videoGapCount: 5, audioFrameCount: 0,
          playbackPositionUs: null },
      ];
      const report = async (items = reports) => {
        for (const item of items) {
          const response = await fetch(base + '/livesuite/playback-feedback', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(item), signal: AbortSignal.timeout(2000),
          });
          assert.equal(response.status, 200);
          await response.arrayBuffer();
        }
      };
      const sample = async (items = reports) => {
        for (let tick = 0; tick < 3; tick++) { await report(items); await delay(270); await clock(); }
        return clock();
      };
      // A previous large alignment budget is still anchored 30 seconds back,
      // although fresh players have only the current GOP. Recover as a group;
      // one playing page, missing stream report or unready track must veto it.
      sourceDelayMs = 30_000;
      const blocked = await clock();
      assert.ok(blocked.anchorServerMs - blocked.anchorPositionUs / 1000 > 29_000);
      sourceDelayMs = 250;
      await delay(270);
      await clock();
      assert.equal((await sample(reports.slice(0, 2))).startupRecoveryRevision, 0,
        'an active stream without feedback must veto startup recovery');
      reports[2].playbackPositionUs = blocked.anchorPositionUs;
      assert.equal((await sample()).startupRecoveryRevision, 0,
        'a playing page must retain the continuous shared clock');
      reports[2].playbackPositionUs = null;
      reports[0].audioPlaybackStarted = true;
      assert.equal((await sample()).startupRecoveryRevision, 0,
        'audible PCM must veto startup recovery even while its video has not presented');
      reports[0].audioPlaybackStarted = false;
      reports[0].audioBufferedMs = 10;
      assert.equal((await sample()).startupRecoveryRevision, 0, 'the slowest audio track must veto recovery');
      reports[0].audioBufferedMs = 180;
      reports[2].videoGapCount = 0;
      assert.equal((await sample()).startupRecoveryRevision, 0, 'the slowest video track must veto recovery');
      reports[2].videoGapCount = 5;
      const recovered = await sample();
      assert.equal(recovered.startupRecoveryRevision, 1);
      assert.ok(Math.abs(recovered.anchorServerMs - recovered.anchorPositionUs / 1000 - 250) < 5,
        'all waiting players must recover to the same current shared target');
      assert.equal(recovered.rebufferedUs, blocked.rebufferedUs,
        'forward startup recovery must not be reported as an audio hold');
      assert.equal((await sample()).startupRecoveryRevision, 1, 'startup recovery must happen only once');
      console.log('QUIC shared startup recovery and slowest-track veto tests passed');
    }
    console.log(`QUIC pull snapshot tests passed (synchronize=${synchronize})`);
  } finally {
    for (const player of players) player.close();
    await hub.stop();
  }
}

(async () => {
  await testSnapshots(true);
  await testSnapshots(false);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
