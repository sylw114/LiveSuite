const assert = require('node:assert/strict');
const { player } = require('./test-browser-synchronized-audio');

const sampleRate = 48000;
const blockFrames = 1024;
const durationUs = blockFrames / sampleRate * 1e6;

async function assembler() {
  const view = await player('/pad/stream', 1000);
  view.info.streams[0].audioGroupDurationMs = 40;
  view.info.streams[0].audioArrivalCadenceP95Ms = 85;
  await view.refresh();
  const session = view.session;
  session.audioContext = { state: 'running', currentTime: 0, sampleRate };
  session.audioConfig = { sampleRate, channels: 2 };
  session.audioStretcher = new view.hooks.AudioTimeStretcher(2, sampleRate);
  const outputs = [];
  session.drainAudioStretcher = () => {
    const planes = session.audioStretcher.process();
    if (planes) outputs.push(planes);
  };
  return { ...view, outputs };
}

function signal(frame) {
  return [0.24 * Math.sin(frame * 2 * Math.PI * 311 / sampleRate)
    + 0.08 * Math.sin(frame * 2 * Math.PI * 997 / sampleRate),
  -0.2 * Math.sin(frame * 2 * Math.PI * 311 / sampleRate)
    + 0.06 * Math.sin(frame * 2 * Math.PI * 173 / sampleRate)];
}

function block(index) {
  return [0, 1].map((channel) => Float32Array.from({ length: blockFrames }, (_, offset) =>
    signal(index * blockFrames + offset)[channel]));
}

function verifyTransparent(outputs, blockCount) {
  let frames = 0;
  for (const planes of outputs) {
    for (let index = 0; index < planes[0].length; index++, frames++) {
      for (let channel = 0; channel < 2; channel++) {
        assert.equal(planes[channel][index], Math.fround(signal(frames)[channel]),
          `timestamp jitter cut or padded real PCM at frame ${frames}, channel ${channel}`);
      }
    }
  }
  assert.equal(frames, blockCount * blockFrames, 'valid PCM must not be stranded in timestamp confirmation');
}

(async () => {
  // Real /pad/stream capture: AAC has 1024 samples at 48 kHz, but isolated
  // timestamp errors of -18..+17 ms turn into paired short/long packet deltas.
  // Also cover two consecutive displaced timestamps from one 40 ms capture.
  const view = await assembler();
  for (let index = 0; index < 500; index++) {
    const phase = index % 47;
    const jitterUs = phase === 8 ? -18000 : phase === 17 ? 17000
      : phase === 27 || phase === 28 ? -14000 : 0;
    view.session.appendAudioStream(Math.round(index * durationUs / 1000) * 1000 + jitterUs, block(index));
  }
  assert.equal(view.session.audioHolesUs, 0, 'capture timestamp jitter was mistaken for source loss');
  assert.equal(view.session.audioOverlapDrops, 0, 'capture timestamp jitter discarded real samples');
  verifyTransparent(view.outputs, 500);
  assert.ok(view.session.requiredAudioLeadMs() >= 85 + 18 + 8 + 30,
    'reserve must cover an entire arrival batch in addition to decode/stretch/output lead');
  assert.equal(view.session.audioMediaGroupDurationMs(blockFrames, sampleRate), 40,
    'network cadence must not change the sender capture-group duration');

  // A genuinely missing access unit leaves a persistent timestamp step. Its
  // exact duration must be retained even when the missing unit is only 21 ms.
  const loss = await assembler();
  for (let index = 0; index < 150; index++) {
    if (index === 50) continue;
    loss.session.appendAudioStream(index * durationUs, block(index));
  }
  assert.ok(Math.abs(loss.session.audioHolesUs - durationUs) < 1);
  assert.equal(loss.session.audioOverlapDrops, 0);
  assert.equal(loss.session.audioStreamRestarts, 0);
  const duplicate = await assembler();
  for (let index = 0; index < 150; index++) {
    duplicate.session.appendAudioStream(index * durationUs, block(index));
    if (index === 50) duplicate.session.appendAudioStream(index * durationUs, block(index));
  }
  assert.equal(duplicate.session.audioOverlapDrops, 1);
  assert.equal(duplicate.session.audioHolesUs, 0);
  verifyTransparent(duplicate.outputs, 150);

  const drift = await assembler();
  for (let index = 0; index < 1000; index++) {
    drift.session.appendAudioStream(index * durationUs * 1.0003, block(index));
  }
  verifyTransparent(drift.outputs, 1000);
  assert.equal(drift.session.audioHolesUs, 0, 'small capture-clock drift must not insert silence');
  assert.equal(drift.session.audioOverlapDrops, 0, 'small capture-clock drift must not cut samples');
  assert.ok(Math.abs(drift.session.audioStreamExpectedUs - 1000 * durationUs * 1.0003) < 3000,
    'continuous sample assembly must still track slow source-clock drift');

  const stalled = await assembler();
  stalled.session.appendAudioStream(0, block(0));
  stalled.session.appendAudioStream(durationUs + 17000, block(1));
  assert.equal(stalled.session.audioPendingPcmFrames, blockFrames);
  assert.ok(stalled.session.audioBufferedSeconds() >= durationUs / 1e6,
    'timestamp confirmation must remain part of the shared audio watermark');
  stalled.advance(171);
  stalled.session.pumpAudio();
  verifyTransparent(stalled.outputs, 2);
  assert.equal(stalled.session.audioPendingPcmFrames, 0, 'a stalled source stranded its last valid PCM');
  stalled.session.appendAudioStream(2 * durationUs + 17000, block(2));
  stalled.session.resetAudioTimeline('test-reset');
  assert.equal(stalled.session.audioPendingPcmFrames, 0);
  assert.equal(stalled.session.audioPendingPcm.length, 0);
  const terminalLoss = await assembler();
  terminalLoss.session.appendAudioStream(0, block(0));
  terminalLoss.session.appendAudioStream(2 * durationUs, block(2));
  terminalLoss.advance(171);
  terminalLoss.session.pumpAudio();
  assert.ok(Math.abs(terminalLoss.session.audioHolesUs - durationUs) < 1,
    'a stalled source must retain a whole missing AAC frame before its final PCM');
  console.log('Browser AAC packetization, timestamp jitter, real loss and duplicate tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
