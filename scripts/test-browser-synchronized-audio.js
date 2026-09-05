const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(process.env.LIVESUITE_PLAYER_TEST_HTML
  || 'native/livesuite-quic/src/browser_player.html', 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1].replace(
  '{ buildId: PLAYER_BUILD_ID, sessions }',
  '{ buildId: PLAYER_BUILD_ID, sessions, AudioTimeStretcher, createMainThreadAudioFifo }',
);
const epochMs = 1_780_000_000_000;
const origins = { '/pad/stream': epochMs - 120_000, '/phone/stream': epochMs - 80_000 };

async function player(streamPath, localNowMs) {
  let nowMs = localNowMs;
  const serverOffsetMs = epochMs - localNowMs;
  const intervals = [];
  const clock = { id: 'test-clock', revision: 1, anchorServerMs: epochMs,
    anchorPositionUs: (epochMs - 250) * 1000, playbackRate: 1, rebufferedUs: 0 };
  const info = { synchronize: true, alignmentReady: true, alignmentDelayMs: 250,
    sourceAlignmentDelayMs: 250, sharedPlaybackClock: clock,
    streams: Object.entries(origins).map(([path, originServerMs]) => ({ path, originServerMs })) };
  const element = () => ({ hidden: true, width: 0, height: 0,
    appendChild() {}, addEventListener() {}, getContext: () => ({ clearRect() {}, drawImage() {} }) });
  const window = { crypto: { randomUUID: () => streamPath }, addEventListener() {} };
  vm.runInNewContext(script, {
    window,
    document: { getElementById: element, createElement: element },
    location: { pathname: streamPath, search: '?debug=1', href: 'http://localhost:8080' + streamPath },
    performance: { now: () => nowMs },
    console, URL, URLSearchParams, AbortController,
    setInterval: (callback) => { intervals.push(callback); return intervals.length; },
    setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame() {},
    VideoDecoder: class {}, EncodedVideoChunk: class {},
    EncodedAudioChunk: class { constructor(value) { Object.assign(this, value); } },
    fetch: async (url) => ({ ok: true,
      json: async () => ({ ...info, serverEpochMs: nowMs + serverOffsetMs }),
      body: { getReader: () => ({ read: () => new Promise(() => {}), releaseLock() {} }) },
    }),
  });
  await new Promise(setImmediate);
  const session = window.__livesuitePlayer.sessions[0];
  assert.equal(session.establishTimeline(30_000_000), true);
  return {
    session, info, hooks: window.__livesuitePlayer, now: () => nowMs,
    advance: (milliseconds) => { nowMs += milliseconds; },
    refresh: async () => { intervals[0](); await new Promise(setImmediate); },
    serverPosition: () => origins[streamPath] * 1000 + session.currentTargetUs(nowMs),
  };
}

module.exports = { player, epochMs, origins };

if (require.main === module) (async () => {
  const pad = await player('/pad/stream', 1000);
  const phone = await player('/phone/stream', 80_000);
  assert.equal(pad.serverPosition(), phone.serverPosition());

  // Audio underflow and healthy video must never create independent clocks.
  // Even stale local anchors and contradictory per-page rates cannot cause drift.
  pad.session.startPerfMs -= 5000;
  pad.session.setPlaybackRate(0.99);
  phone.session.setPlaybackRate(1.03);
  for (let minute = 0; minute < 60; minute++) {
    pad.advance(60_000);
    phone.advance(60_000);
    assert.equal(pad.serverPosition(), phone.serverPosition(), 'the streams drifted apart');
  }
  assert.equal(pad.session.playbackRate, 1);
  assert.equal(phone.session.playbackRate, 1);

  const beforeRequest = pad.serverPosition();
  pad.session.shiftAdaptiveLatent(600);
  pad.session.shiftAdaptiveLatent(600);
  assert.equal(pad.session.requiredAlignmentDelayMs, 850);
  assert.equal(pad.session.adaptiveLatentMs, 0);
  assert.equal(pad.serverPosition(), beforeRequest, 'requesting audio reserve moved only one video');

  for (const view of [pad, phone]) {
    view.info.alignmentDelayMs = 850;
    view.info.sharedPlaybackClock = { id: 'test-clock', revision: 2,
      anchorServerMs: epochMs + 3600_000, anchorPositionUs: beforeRequest, playbackRate: 0.99 };
    await view.refresh();
  }
  assert.equal(pad.serverPosition(), beforeRequest, 'a shared rate change must be continuous');
  pad.session.shiftAdaptiveLatent(600);
  assert.equal(pad.session.requiredAlignmentDelayMs, 850,
    'a pending shared budget must not count as delay already acquired by the clock');
  pad.advance(30_000);
  phone.advance(30_000);
  assert.equal(pad.serverPosition(), phone.serverPosition());
  assert.equal(pad.session.playbackRate, 0.99);
  assert.equal(phone.session.playbackRate, 0.99);

  // A delayed sync poll must not undo the newer clock received via feedback.
  pad.info.sharedPlaybackClock = { id: 'test-clock', revision: 1, anchorServerMs: epochMs,
    anchorPositionUs: (epochMs - 250) * 1000, playbackRate: 1.03 };
  await pad.refresh();
  assert.equal(pad.serverPosition(), phone.serverPosition());

  // A video-only page is allowed to impose the shared budget too.
  for (let index = 0; index < 20; index++) {
    phone.advance(50);
    const lateVideoUs = phone.session.currentTargetUs(phone.now() - 400);
    phone.session.observeVideoDecodeLead(lateVideoUs, phone.now());
  }
  assert.ok(phone.session.requiredAlignmentDelayMs >= 900,
    'sustained video decode lateness must constrain the same shared budget as audio');
  const videoReservation = phone.session.requiredAlignmentDelayMs;
  phone.session.shiftAdaptiveLatent(-300);
  assert.equal(phone.session.requiredAlignmentDelayMs, videoReservation,
    'audio reserve recovery must not remove the reservation needed by video');

  // The audio decoder and FIFO must use inverse mappings of the same clock,
  // including actual presentation lag. Previously a valid block could be
  // considered seconds late and dropped repeatedly after a video stall.
  const session = pad.session;
  session.displayLagMs = 2400;
  const targetPerfMs = pad.now() + 200;
  const mediaUs = session.audioTargetUs(targetPerfMs);
  assert.ok(Math.abs(session.audioPerfTimeForMediaUs(mediaUs) - targetPerfMs) < 0.001);
  const messages = [];
  session.audioContext = { state: 'running', currentTime: 10, sampleRate: 48_000, outputLatency: 0 };
  session.audioConfig = { channels: 2, sampleRate: 48_000 };
  session.audioWorkletNode = {};
  session.audioWorkletReady = true;
  session.audioOutputKind = 'worklet';
  session.audioStretcher = { rate: 0.99, inputPositionForOutput: () => 0, reset() {}, setRate() {} };
  session.audioStreamBaseUs = mediaUs;
  session.audioStreamDiscontinuity = true;
  session.audioFreshAppend = false;
  session.postAudioOutput = (message) => messages.push(message);
  session.enqueueAudioOutput([new Float32Array(1024).fill(0.5)], 0);
  assert.equal(messages.length, 2, 'schedulable PCM should be padded and enqueued, not skipped');
  assert.ok(Math.abs(messages[0].frames - 0.192 * 48_000) <= 1);
  assert.equal(messages[1].frames, 1024);
  assert.equal(session.audioLateSkips, 0);

  // Holding output extends its queued duration but does not consume PCM or
  // change the sample-index mapping used to align sound with video.
  const pushedBeforeHold = session.audioFifoPushedFrames;
  session.delayAudioOutput(300);
  assert.equal(messages.at(-1).type, 'hold');
  assert.equal(messages.at(-1).frames, 14_400);
  assert.equal(session.audioFifoPushedFrames, pushedBeforeHold);
  assert.ok(session.audioFifoQueuedFrames() >= 14_400);
  session.audioFifoAssumeEmpty = false;
  session.audioPushedSinceStatus = 0;
  session.audioFifoStatus = { contextTime: 10, consumedFrames: 0, queuedFrames: pushedBeforeHold,
    holdFrames: 14_400, holdFramesRequested: 14_400 };
  session.audioContext.currentTime = 10.1;
  assert.ok(Math.abs(session.audioFifoQueuedFrames() - pushedBeforeHold - 9600) < 0.01);

  // Normal flush acknowledgement has its own timeout. A healthy worklet must
  // not be abandoned just because the first push happened a long time ago.
  let fallbacks = 0;
  session.switchAudioOutputToScriptProcessor = () => { fallbacks++; };
  session.audioFirstPushAt = pad.now() - 10_000;
  session.resetAudioTimeline('test-resync');
  session.watchAudioOutputHealth(pad.now());
  assert.equal(fallbacks, 0);
  session.audioFirstPushAt = pad.now() - 10_000;
  session.audioFifoStatusAt = pad.now() - 20;
  session.watchAudioOutputHealth(pad.now());
  assert.equal(fallbacks, 0, 'recent FIFO status proves the worklet is alive');
  session.audioFifoStatusAt = pad.now() - 3000;
  pad.advance(3000);
  session.watchAudioOutputHealth(pad.now());
  assert.equal(fallbacks, 1, 'a worklet that actually stops reporting must recover');

  // Disabling synchronization retains the standalone adaptive playback mode.
  pad.info.synchronize = false;
  await pad.refresh();
  session.establishTimeline(40_000_000);
  session.shiftAdaptiveLatent(120);
  assert.equal(session.adaptiveLatentMs, 120);
  console.log('Browser synchronized audio, shared clock and recovery tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
