const assert = require('node:assert/strict');
const { player, epochMs } = require('./test-browser-synchronized-audio');
const { evaluateSharedPlaybackControl, QuicPullHub } = require('../tscdist/main/quicPull');

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const deviation = (values) => Math.sqrt(mean(values.map((value) => (value - mean(values)) ** 2)));

async function videoCadence(fps, playbackRate = 1) {
  const view = await player('/pad/stream', 1000);
  view.info.sharedPlaybackClock = { ...view.info.sharedPlaybackClock, revision: 2, playbackRate };
  await view.refresh();
  const session = view.session;
  session.waitingForKeyframe = false;
  session.sourceVideoFps = fps;
  const start = view.now();
  // Quantized FLV PTS at the vsync eligibility boundary, with real callback
  // jitter. Exercise renderFrame, not just its detached phase helper.
  const mediaStart = session.currentTargetUs(start) + 8000;
  const shown = [];
  session.context.drawImage = () => shown.push(view.now() - start);
  let nextSource = 0;
  for (let tick = 0; tick < 60 * 45; tick++) {
    const now = start + tick * 1000 / 60 + [0, 0.35, -0.4, 0.6, -0.55][tick % 5];
    view.advance(now - view.now());
    while (nextSource / fps * 1000 <= now - start + 120) {
      const timestamp = Math.round((mediaStart + nextSource * 1e6 / fps) / 1000) * 1000;
      session.observeSourceVideoRate(timestamp);
      session.queueDecodedVideoFrame({ timestamp, displayWidth: 320, displayHeight: 180, close() {} });
      session.lastVideoOutputAt = now;
      nextSource++;
    }
    session.renderFrame(now);
  }
  const settled = shown.filter((time) => time >= 5000);
  const intervals = settled.slice(1).map((time, index) => time - settled[index]);
  const measuredFps = 1000 / mean(intervals);
  const stdDevMs = deviation(intervals);
  console.log(JSON.stringify({ sourceFps: fps, playbackRate, presentationFps: measuredFps,
    frameTimeStdDevMs: stdDevMs, phaseOffsetMs: session.presentationOffsetMs }));
  assert.ok(Math.abs(measuredFps - fps * playbackRate) < 0.15, `${fps}fps source lost presentation rate`);
  assert.ok(stdDevMs < 1.5, `${fps}fps frame-time jitter: ${stdDevMs.toFixed(2)}ms`);
  assert.ok(Math.abs(session.presentationOffsetMs) <= session.displayIntervalMs / 2 + 0.001);
  assert.ok(Math.abs(view.serverPosition() - ((epochMs - 250) * 1000
    + (view.now() - start) * playbackRate * 1000)) < 1, 'presentation centring moved the shared media clock');
}

function sharedBufferQuality() {
  const hub = new QuicPullHub({ takeFrames: () => ({ frames: [], closed: false, resync: false }),
    syncInfoJson: () => JSON.stringify({ synchronize: true, alignmentDelayMs: 250 }) }, {});
  for (const path of ['/pad/stream', '/phone/stream']) {
    hub.registerSession({ sessionId: path, streamPath: path, audioAvailable: path.includes('pad') });
    hub.sessions.get(path).connections.add({ pushFrames() {}, close() {} });
  }
  hub.refreshOriginServerMs();
  const feedback = (path, extra = {}) => ({ clientId: path, streamPath: path,
    hasAudio: path.includes('pad'), audioBufferedMs: 150, audioFrameCount: 7,
    videoGapCount: 6, videoBufferBytes: 0, ...extra });
  hub.acceptPlaybackFeedback(feedback('/phone/stream'));
  const clock = hub.acceptPlaybackFeedback(feedback('/pad/stream')).sharedPlaybackClock;
  let previous = clock;
  for (let tick = 1; tick <= 40; tick++) {
    // P95/adaptive budget grows by small steps while both tracks remain healthy.
    hub.acceptPlaybackFeedback(feedback('/pad/stream', { requiredAlignmentDelayMs: 250 + tick * 2 }));
    const next = hub.updateSharedPlaybackClock(true, clock.anchorServerMs + tick * 250);
    const expected = previous.anchorPositionUs + 250 * previous.playbackRate * 1000;
    assert.ok(Math.abs(next.anchorPositionUs - expected) < 1,
      'healthy budget growth inserted a media-clock pause (and an audio gap)');
    assert.ok(Math.abs(next.playbackRate - 1) <= 0.005001);
    assert.ok(Math.abs(next.playbackRate - previous.playbackRate) <= 0.000501);
    previous = next;
  }
  const healthy = [feedback('/pad/stream'), feedback('/phone/stream')];
  for (const slowTrack of ['audio', 'video']) {
    let state;
    const entries = healthy.map((entry) => ({ ...entry }));
    if (slowTrack === 'audio') entries[0].audioBufferedMs = 10;
    else entries[1].videoGapCount = 0;
    for (let tick = 0; tick < 30; tick++) {
      state = evaluateSharedPlaybackControl(entries, (10000 - 1000) * 1000, 250, 10000, state);
    }
    assert.ok(state.playbackRate < 1, `the slowest ${slowTrack} track must veto group acceleration`);
  }
}

async function audioContinuity(withSourceLoss = false, withPacketBatches = false) {
  const view = await player('/pad/stream', 1000);
  if (withPacketBatches) {
    view.info.streams[0].audioGroupDurationMs = 40;
    view.info.streams[0].audioArrivalCadenceP95Ms = 86;
    await view.refresh();
  }
  const session = view.session;
  const sampleRate = 48000;
  const quantum = 128;
  const outputs = [];
  const context = { state: 'running', sampleRate, currentTime: 0, outputLatency: 0.025,
    getOutputTimestamp: () => ({ contextTime: context.currentTime - 0.025, performanceTime: view.now() }) };
  session.audioContext = context;
  session.audioConfig = { channels: 1, sampleRate };
  session.audioStretcher = new view.hooks.AudioTimeStretcher(1, sampleRate);
  const fifo = view.hooks.createMainThreadAudioFifo((status) => session.handleAudioFifoStatus(status));
  session.audioWorkletNode = {};
  session.audioWorkletReady = true;
  session.audioOutputKind = 'script';
  session.postAudioOutput = (message) => fifo.handleMessage(message);
  const start = view.now();
  const firstMediaUs = session.audioTargetUs(start + (withPacketBatches ? 320 : 160));
  let inputFrames = 0;
  let minimumRate = 1;
  let maximumRate = 1;
  let underrunsAtStart = null;
  for (let tick = 0; tick < 12 * sampleRate / quantum; tick++) {
    const elapsedMs = tick * quantum / sampleRate * 1000;
    view.advance(start + elapsedMs - view.now());
    context.currentTime = elapsedMs / 1000;
    // 80ms network stalls followed by bursts, plus +/-12ms arrival jitter.
    const phaseMs = elapsedMs % 3000;
    const arrivalElapsedMs = phaseMs >= 1000 && phaseMs < 1080
      ? elapsedMs - phaseMs + 1000 : elapsedMs;
    let availableFrames = Math.floor((arrivalElapsedMs + 100 + 12 * Math.sin(tick / 7)) / 1000 * sampleRate);
    if (withPacketBatches) availableFrames = Math.floor(availableFrames / 4096) * 4096;
    while (inputFrames + 1024 <= availableFrames) {
      if (withSourceLoss && inputFrames === Math.ceil(4 * sampleRate / 1024) * 1024) {
        inputFrames += 1024;
        continue;
      }
      const plane = Float32Array.from({ length: 1024 }, (_, index) =>
        0.5 * Math.sin(2 * Math.PI * 440 * (inputFrames + index) / sampleRate));
      const blockIndex = inputFrames / 1024;
      const phase = blockIndex % 47;
      const jitterUs = !withPacketBatches ? 0 : phase === 8 ? -18000 : phase === 17 ? 17000
        : phase === 27 || phase === 28 ? -14000 : 0;
      session.appendAudioStream(firstMediaUs + inputFrames / sampleRate * 1e6 + jitterUs, [plane]);
      inputFrames += 1024;
    }
    // A continuous shared rate ramp must preserve pitch, avoid silence, and
    // settle to transparent 1x despite output-latency and status quantization.
    if (tick % 96 === 0) {
      const previous = view.info.sharedPlaybackClock;
      const serverNow = epochMs + elapsedMs;
      view.info.sharedPlaybackClock = { ...previous, revision: previous.revision + 1,
        anchorServerMs: serverNow,
        anchorPositionUs: previous.anchorPositionUs
          + (serverNow - previous.anchorServerMs) * previous.playbackRate * 1000,
        playbackRate: elapsedMs > 2000 && elapsedMs < 6000 ? 0.998 : 1 };
      await view.refresh();
    }
    fifo.hostTime = context.currentTime;
    const plane = new Float32Array(quantum);
    fifo.process([], [[plane]]);
    if (elapsedMs >= 1000) {
      if (underrunsAtStart === null) underrunsAtStart = fifo.underruns;
      outputs.push(plane);
      minimumRate = Math.min(minimumRate, session.audioStretchRate);
      maximumRate = Math.max(maximumRate, session.audioStretchRate);
    }
  }
  const samples = Float32Array.from(outputs.flatMap((plane) => Array.from(plane)));
  let crossings = 0;
  let maxStep = 0;
  let silentRun = 0;
  let maxSilentRun = 0;
  for (let index = 1; index < samples.length; index++) {
    if ((!withSourceLoss || index >= samples.length - 2 * sampleRate)
      && samples[index - 1] <= 0 && samples[index] > 0) crossings++;
    maxStep = Math.max(maxStep, Math.abs(samples[index] - samples[index - 1]));
    silentRun = Math.abs(samples[index]) < 0.00001 ? silentRun + 1 : 0;
    maxSilentRun = Math.max(maxSilentRun, silentRun);
  }
  const pitchHz = crossings / (withSourceLoss ? 2 : samples.length / sampleRate);
  console.log(JSON.stringify({ withSourceLoss, withPacketBatches, pitchHz, maximumGapMs: maxSilentRun / sampleRate * 1000,
    minimumRate, maximumRate, syncErrorMs: session.audioSyncErrorMs }));
  assert.equal(fifo.underruns, underrunsAtStart, 'jitter caused an audible FIFO underrun');
  assert.equal(session.audioHardResyncs, 0, 'output-latency quantization caused a flush');
  assert.equal(fifo.holdFramesRequested, 0, 'continuous clock updates inserted silent holds');
  if (withSourceLoss) {
    assert.ok(maxSilentRun <= 1024, 'source audio loss must not be extended into a larger gap');
    assert.ok(Math.abs(session.audioHolesUs - 1024 / sampleRate * 1e6) < 1,
      'source gap must retain its actual media duration');
    assert.equal(session.audioStreamRestarts, 0, 'one lost AAC block must not restart the PCM stream');
  } else {
    assert.ok(maxSilentRun < sampleRate * 0.001, 'PCM output contains an inserted gap');
    assert.equal(session.audioHolesUs, 0, 'timestamp jitter created a false source gap');
    assert.equal(session.audioOverlapDrops, 0, 'timestamp jitter cut real PCM');
  }
  assert.ok(Math.abs(pitchHz - 440) < 0.5, 'pitch shifted during synchronization');
  assert.ok(maxStep <= Math.sin(2 * Math.PI * 440 / sampleRate) * 0.53, 'audible PCM splice');
  assert.ok(minimumRate >= 0.99 && maximumRate <= 1.01, 'combined tempo correction is too large');
  assert.ok(session.audioFifoStatusHistory.length <= 128, 'output clock history grew without bound');
}

async function audioStartupAndClockDelivery() {
  const view = await player('/pad/stream', 1000);
  const session = view.session;
  const decoded = [];
  let stamp = { contextTime: 0, performanceTime: 0 };
  session.audioContext = { state: 'running', sampleRate: 48000, currentTime: 0,
    outputLatency: 0.025, getOutputTimestamp: () => stamp };
  session.audioConfig = { channels: 1, sampleRate: 48000 };
  session.audioWorkletNode = {};
  session.audioWorkletReady = true;
  session.audioStretcher = new view.hooks.AudioTimeStretcher(1, 48000);
  session.audioDecoder = { decodeQueueSize: 0, decode: (chunk) => decoded.push(chunk) };
  const mediaNowUs = session.audioTargetUs();
  session.audioInput = Array.from({ length: 30 }, (_, index) =>
    ({ timestampUs: mediaNowUs + index * 24000, data: new Uint8Array(8) }));
  session.pumpAudio();
  view.advance(200);
  session.pumpAudio();
  assert.equal(decoded.length, 0, 'running context with no output quantum must not queue stale PCM');
  session.audioFifoStatus = { contextTime: 0.02, consumedFrames: 0, queuedFrames: 0 };
  session.audioContext.currentTime = 0.02;
  session.pumpAudio();
  assert.equal(decoded.length, 0, 'startup must wait for a usable output timestamp');
  stamp = { contextTime: 0.005, performanceTime: view.now() };
  session.pumpAudio();
  assert.ok(decoded.length > 0);
  assert.ok(decoded[0].timestamp >= session.audioTargetUs(view.now() + 23),
    'first audio must target the first audible output time, not context creation time');
  decoded.length = 0;
  stamp = { contextTime: 0, performanceTime: 0 };
  session.audioContext.currentTime = 0.3;
  session.audioInput = [{ timestampUs: session.audioTargetUs(view.now() + 100), data: new Uint8Array(8) }];
  session.pumpAudio();
  assert.equal(decoded.length, 1,
    'a progressing FIFO with an unavailable output timestamp must use the latency fallback');

  const holds = [];
  session.delayAudioOutput = (milliseconds) => holds.push(milliseconds);
  const original = view.info.sharedPlaybackClock;
  view.info.sharedPlaybackClock = { ...original, revision: original.revision + 5,
    anchorPositionUs: original.anchorPositionUs - 5000, playbackRate: 0.999 };
  await view.refresh();
  assert.equal(holds.length, 0, 'missing intermediate rate responses is not a rebuffer command');
  view.info.sharedPlaybackClock = { ...view.info.sharedPlaybackClock, revision: original.revision + 6,
    anchorPositionUs: original.anchorPositionUs - 255000, rebufferedUs: 250000 };
  await view.refresh();
  assert.equal(holds.length, 1, 'a real shared rebuffer must still align the queued audio');
  view.info.sharedPlaybackClock = { ...view.info.sharedPlaybackClock, revision: original.revision + 7 };
  await view.refresh();
  assert.equal(holds.length, 1, 'a rebuffer command must not be repeated');

  let startupRecoveries = 0;
  session.resetAudioTimeline = (reason) => {
    assert.equal(reason, 'shared-startup-recovery');
    startupRecoveries++;
  };
  view.info.sharedPlaybackClock = { ...view.info.sharedPlaybackClock, revision: original.revision + 8,
    anchorPositionUs: original.anchorPositionUs + 30000000, startupRecoveryRevision: 1 };
  await view.refresh();
  assert.equal(startupRecoveries, 1, 'all queued startup audio must follow an explicit common recovery');
  assert.equal(holds.length, 1, 'a forward startup recovery must not insert silent holds');
  view.info.sharedPlaybackClock = { ...view.info.sharedPlaybackClock, revision: original.revision + 9 };
  await view.refresh();
  assert.equal(startupRecoveries, 1, 'delivered startup recovery must not repeatedly flush PCM');

  const delayed = await player('/pad/stream', 1000);
  const lateSession = delayed.session;
  const messages = [];
  lateSession.audioContext = { state: 'running', sampleRate: 48000, currentTime: 10, outputLatency: 0.025 };
  lateSession.audioConfig = { channels: 1, sampleRate: 48000 };
  lateSession.audioWorkletNode = {};
  lateSession.audioWorkletReady = true;
  lateSession.audioStreamBaseUs = lateSession.audioTargetUs() - 200000;
  lateSession.audioStretcher = { rate: 1, inputPositionForOutput: (index) => index };
  lateSession.postAudioOutput = (message) => messages.push(message);
  lateSession.enqueueAudioOutput([new Float32Array(1024)], 0);
  assert.equal(messages.length, 0, 'a delayed first decoder callback must not start with obsolete audio');
  lateSession.enqueueAudioOutput([new Float32Array(1024)], 10704);
  assert.equal(messages.length, 1);
  assert.ok(Math.abs(messages[0].frames - 544) <= 1, 'only the late prefix of the first audible block is trimmed');
  assert.ok(Math.abs(lateSession.audioFifoChunks[0].mediaUs
    - lateSession.audioTargetUs(delayed.now() + 33)) < 25);
  assert.equal(lateSession.requiredAlignmentDelayMs, 0,
    'one startup decoder delay must not unnecessarily expand the entire group buffer');
}

async function videoJitterAndSourceLoss() {
  const view = await player('/phone/stream', 1000);
  const session = view.session;
  session.waitingForKeyframe = false;
  session.sourceVideoFps = 60;
  const start = view.now();
  const mediaStart = session.currentTargetUs(start) + 8000;
  const deliveries = [];
  const missing = new Set();
  for (let index = 0; index < 60 * 35; index++) {
    // A source-side 350ms gap and isolated missing frames preserve real PTS.
    if (index % 41 === 0 || (index >= 720 && index < 741)) { missing.add(index); continue; }
    const mediaMs = index * 1000 / 60;
    let arrivalMs = Math.ceil((mediaMs - 200 + (index % 7) * 11) / 40) * 40;
    // One network stall exceeds the reserve; all old frames arrive together.
    if (arrivalMs >= 20000 && arrivalMs < 20350) arrivalMs = 20350;
    deliveries.push({ index, arrivalMs });
  }
  deliveries.sort((left, right) => left.arrivalMs - right.arrivalMs || left.index - right.index);
  const shown = [];
  session.context.drawImage = (frame) => shown.push({ now: view.now() - start, index: frame.index });
  let next = 0;
  for (let tick = 0; tick < 60 * 34; tick++) {
    const elapsed = tick * 1000 / 60 + [0, 0.35, -0.4, 0.6, -0.55][tick % 5];
    view.advance(start + elapsed - view.now());
    while (next < deliveries.length && deliveries[next].arrivalMs <= elapsed) {
      const index = deliveries[next++].index;
      const timestamp = Math.round((mediaStart + index * 1e6 / 60) / 1000) * 1000;
      session.observeSourceVideoRate(timestamp);
      session.observeVideoDecodeLead(timestamp, view.now());
      session.queueDecodedVideoFrame({ index, timestamp, displayWidth: 320, displayHeight: 180, close() {} });
      session.lastVideoOutputAt = view.now();
    }
    session.renderFrame(view.now());
  }
  const recovery = shown.filter((frame) => frame.now >= 23000);
  const recoveredRate = (recovery.length - 1) * 1000 / (recovery.at(-1).now - recovery[0].now);
  assert.ok(recoveredRate >= 58, 'source recovery must immediately restore the available frame rate');
  assert.equal(session.targetVideoFps, 60, 'network/source loss must not reduce local display capacity');
  assert.equal(session.requiredAlignmentDelayMs, 0, 'one stale burst must not inflate the group buffer');
  assert.ok(shown.every((frame, index) => !missing.has(frame.index)
    && (index === 0 || frame.index > shown[index - 1].index)), 'source gaps must not rewind/replay video');
  const timely = shown.filter((frame) => frame.now > 5000 && frame.now < 11000);
  assert.ok(timely.length >= 349, 'jitter inside the reserve must not discard otherwise playable video');
  console.log(JSON.stringify({ jitteredVideoRecoveryFps: recoveredRate,
    targetFps: session.targetVideoFps, extraAlignmentMs: session.requiredAlignmentDelayMs }));
}

(async () => {
  sharedBufferQuality();
  await videoCadence(30);
  await videoCadence(60);
  await videoCadence(60, 0.998);
  await audioContinuity();
  await audioContinuity(true);
  await audioContinuity(false, true);
  await audioContinuity(true, true);
  await audioStartupAndClockDelivery();
  await videoJitterAndSourceLoss();
  console.log('Browser playback quality tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
