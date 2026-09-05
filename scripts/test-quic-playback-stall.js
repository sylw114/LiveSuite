const assert = require('node:assert/strict');
const { QuicPullHub } = require('../tscdist/main/quicPull');
const { player, epochMs } = require('./test-browser-synchronized-audio');

function withHub(run) {
  const originalNow = Date.now;
  let now = epochMs;
  let sourceDelayMs = 250;
  Date.now = () => now;
  const hub = new QuicPullHub({
    takeFrames: () => ({ frames: [], closed: false, resync: false }),
    syncInfoJson: () => JSON.stringify({ synchronize: true, alignmentReady: true,
      alignmentDelayMs: sourceDelayMs }),
  }, { bind: '127.0.0.1', port: 0 });
  hub.setIncludeAudio(true);
  for (const path of ['/pad/stream', '/phone/stream']) {
    hub.registerSession({ sessionId: path, streamPath: path, audioAvailable: path.includes('pad'),
      audioChannels: 2, audioGroupDurationUs: 40_000 });
    hub.sessions.get(path).connections.add({ close() {}, pushFrames() {} });
  }
  hub.refreshOriginServerMs();
  const report = (path, extra = {}) => hub.acceptPlaybackFeedback({
    clientId: path, streamPath: path, hasAudio: path.includes('pad'),
    videoGapCount: 6, videoBufferBytes: 0, audioFrameCount: 8, audioBufferedMs: 160,
    playbackPositionUs: (now - 250) * 1000,
    audioPlaybackPositionUs: path.includes('pad') ? (now - 250) * 1000 : null,
    audioPlaybackStarted: path.includes('pad'),
    ...extra,
  });
  report('/pad/stream');
  const initial = report('/phone/stream').sharedPlaybackClock;
  try {
    run({ hub, initial, report, now: () => now, advance: (ms = 250) => { now += ms; },
      sourceDelay: (ms) => { sourceDelayMs = ms; hub.refreshOriginServerMs(); } });
  } finally {
    Date.now = originalNow;
  }
}

function rebufferEvidence() {
  withHub(({ hub, initial, report, advance, sourceDelay }) => {
    sourceDelay(800);
    for (let tick = 0; tick < 16; tick++) {
      advance();
      // A 250ms poll can repeatedly land just after a video was presented.
      // Empty queues with advancing presentation are not an output stall.
      report('/phone/stream', { videoGapCount: 0 });
      report('/pad/stream');
      assert.equal(hub.sharedPlaybackClock.rebufferedUs, initial.rebufferedUs,
        'a frame boundary or transient empty queue must not pause the entire group');
    }
  });
  withHub(({ hub, initial, report, advance }) => {
    for (let tick = 0; tick < 8; tick++) {
      advance();
      report('/pad/stream', { audioBufferedMs: 0, audioFrameCount: 0,
        audioPlaybackPositionUs: initial.anchorPositionUs });
      report('/phone/stream', { requiredAlignmentDelayMs: 1200,
        videoRequiredAlignmentDelayMs: 1200, audioRequiredAlignmentDelayMs: 0 });
    }
    assert.equal(hub.sharedPlaybackClock.rebufferedUs, initial.rebufferedUs,
      'audio starvation must not spend a different healthy stream\'s video reservation');
  });
  withHub(({ hub, initial, report, advance, now }) => {
    for (let tick = 0; tick < 4; tick++) {
      advance();
      report('/phone/stream');
      report('/pad/stream', { audioBufferedMs: 0, audioFrameCount: 0,
        audioPlaybackPositionUs: initial.anchorPositionUs,
        requiredAlignmentDelayMs: 900, audioRequiredAlignmentDelayMs: 900,
        videoRequiredAlignmentDelayMs: 0 });
      hub.updateSharedPlaybackClock(true, now());
      if (tick === 0) assert.equal(hub.sharedPlaybackClock.rebufferedUs, 0);
    }
    assert.ok(hub.sharedPlaybackClock.rebufferedUs > 500_000,
      'confirmed audio starvation must still acquire the needed common reserve');
    const total = hub.sharedPlaybackClock.rebufferedUs;
    advance();
    report('/pad/stream', { audioBufferedMs: 0, audioFrameCount: 0,
      audioPlaybackPositionUs: initial.anchorPositionUs, requiredAlignmentDelayMs: 1500,
      audioRequiredAlignmentDelayMs: 1500, videoRequiredAlignmentDelayMs: 0 });
    assert.equal(hub.sharedPlaybackClock.rebufferedUs, total,
      'an outstanding hold must finish before new starvation evidence can trigger another hold');
    assert.equal(hub.playbackDiagnostics().lastRebuffer.streamPath, '/pad/stream');
    assert.equal(hub.playbackDiagnostics().lastRebuffer.track, 'audio');
    const lastFeedbackAt = hub.playbackFeedback.get('/pad/stream\u0000/pad/stream').updatedAtMs;
    advance(900);
    hub.playbackDiagnostics();
    hub.updateSharedPlaybackClock();
    assert.equal(hub.playbackFeedback.get('/pad/stream\u0000/pad/stream').updatedAtMs, lastFeedbackAt);
    assert.equal(hub.sharedPlaybackClock.rebufferedUs, total,
      'observing or repeatedly reading old feedback must not confirm another underflow');
  });
}

async function recoveryInvalidatesEvidence() {
  const view = await player('/pad/stream', 1000);
  const session = view.session;
  session.audioRequiredAlignmentDelayMs = 41_000;
  session.videoRequiredAlignmentDelayMs = 40_000;
  session.audioArrivalLeadMs = -40_000;
  session.audioDecodeLatencyMs = 20_000;
  session.adaptiveLatentDeficitSince = view.now() - 40_000;
  session.videoLeadDeficitSince = view.now() - 40_000;
  const clock = view.info.sharedPlaybackClock;
  view.info.sharedPlaybackClock = { ...clock, revision: 2, startupRecoveryRevision: 1 };
  await view.refresh();
  assert.equal(session.requiredAlignmentDelayMs, 0,
    'a forward recovery must invalidate the old 41s reservation rather than reapply it');
  assert.equal(session.audioArrivalLeadMs, null);
  assert.equal(session.audioDecodeLatencyMs, null);
  assert.equal(session.adaptiveLatentDeficitSince, null);
  assert.equal(session.videoLeadDeficitSince, null);
  session.audioRequiredAlignmentDelayMs = 41_000;
  session.resetPipeline();
  assert.equal(session.requiredAlignmentDelayMs, 0, 'a replacement source must not inherit stale budgets');
}

async function actualQueueBudget() {
  const view = await player('/pad/stream', 1000);
  const session = view.session;
  const clock = view.info.sharedPlaybackClock;
  session.lastDisplayedPtsUs = session.currentTargetUs();
  view.info.alignmentDelayMs = 331;
  view.info.sharedPlaybackClock = { ...clock, revision: 2, alignmentDelayMs: 331,
    anchorPositionUs: (epochMs - 44_000) * 1000, rebufferedUs: 43_750_000 };
  await view.refresh();
  assert.ok(session.maxVideoInputFrames() >= 44 * 60,
    'queue limits must cover the actual 44s clock delay after the target shrinks to 331ms');
  let resets = 0;
  session.configureVideo = () => { resets++; };
  session.videoConfig = new Uint8Array([1]);
  session.videoDecoder = { decodeQueueSize: 0, decode() {}, close() {} };
  session.waitingForKeyframe = false;
  const recentPtsUs = session.currentTargetUs() + 43_800_000;
  for (let index = 0; index < 120; index++) {
    view.advance(1000 / 60);
    session.enqueueVideo(recentPtsUs + index * 1e6 / 60, index % 60 === 0, new Uint8Array([1]));
  }
  assert.equal(resets, 0, 'a shared hold must not repeatedly reset the video decoder at every keyframe');
  assert.equal(session.videoInput.length, 120, 'valid future GOP data must remain available');
  session.audioContext = { state: 'running', sampleRate: 48000, currentTime: 0 };
  session.audioWorkletNode = {};
  session.audioWorkletReady = true;
  session.audioStretcher = { reset() {}, setRate() {} };
  session.audioFifoQueuedFrames = () => 42 * 48_000;
  assert.equal(session.recoverAudioSyncHealth(), null,
    'the corresponding legitimate audio hold must not trigger repeated future-backlog flushes');
}

function stalledGroupRecovery() {
  withHub(({ hub, initial, report, now, advance }) => {
    hub.sharedPlaybackClock = { ...initial, anchorPositionUs: initial.anchorPositionUs - 44_000_000 };
    const frozenPositionUs = hub.sharedPlaybackClock.anchorPositionUs;
    const reports = (audioPlaying = false) => {
      for (const path of ['/pad/stream', '/phone/stream']) {
        report(path, { playbackPositionUs: frozenPositionUs,
          audioPlaybackPositionUs: audioPlaying && path.includes('pad') ? now() * 1000 : frozenPositionUs,
          bufferedStartUs: (now() - 700) * 1000, bufferedEndUs: (now() - 100) * 1000 });
      }
    };
    for (let tick = 0; tick < 8; tick++) { advance(); reports(true); }
    assert.equal(hub.sharedPlaybackClock.stalledRecoveryRevision, 0,
      'ongoing audio output must veto a seek, even when video stopped');
    for (let tick = 0; tick < 10; tick++) { advance(); reports(); }
    const recovered = hub.sharedPlaybackClock;
    assert.equal(recovered.stalledRecoveryRevision, 1,
      'a previously playing group with no progress and only current GOPs must recover together');
    assert.ok(recovered.anchorServerMs - recovered.anchorPositionUs / 1000 < 1000);
    assert.equal(recovered.rebufferedUs, 0, 'a forward recovery must not issue another audio hold');
  });
}

(async () => {
  rebufferEvidence();
  await actualQueueBudget();
  await recoveryInvalidatesEvidence();
  stalledGroupRecovery();
  console.log('QUIC transient underflow, actual queue budget and stalled group recovery tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
