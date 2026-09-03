const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('native/livesuite-quic/src/browser_player.html', 'utf8');

function slice(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `markers not found: ${startMarker} / ${endMarker}`);
  return html.slice(start, end);
}

const constants = [...html.matchAll(/^ {4}const ([A-Z_0-9]+) = ([^;\n]+);$/gm)]
  .map((match) => `const ${match[1]} = ${match[2]};`).join('\n');
const clamp = 'function clampNumber(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }\n';

const audio = new Function(
  constants + '\n' + clamp
  + slice('class LinearResampler', '// AudioWorklet FIFO')
  + slice('function audioSyncDeviationStep', 'function audioDecoderRecoveryReason(')
  + '\nreturn { AudioTimeStretcher, audioSyncDeviationStep, audioEnqueuePlan, audioRenderedOutputFrame };',
)();

// Three minutes of 48 kHz audio through the continuous stretcher while the
// rate changes every 256 ms. Total output must follow the requested schedule
// to within one search window, internal bookkeeping must stay bounded, and
// the output must never contain a splice larger than the source's own steps.
{
  const sampleRate = 48_000;
  const stretcher = new audio.AudioTimeStretcher(1, sampleRate);
  const rates = [0.99, 1, 1.01, 1, 0.97, 1, 1.03, 1];
  const block = 1024;
  const blocks = Math.ceil(180 * sampleRate / block);
  const input = new Float32Array(block);
  let phase = 0;
  let expectedFrames = 0;
  let producedFrames = 0;
  let maxStep = 0;
  let previousSample = 0;
  let maxRetained = 0;
  for (let index = 0; index < blocks; index++) {
    const rate = rates[Math.floor(index / 12) % rates.length];
    stretcher.setRate(rate);
    for (let sample = 0; sample < block; sample++) {
      input[sample] = Math.sin(phase);
      phase += 2 * Math.PI * 330 / sampleRate;
    }
    assert.ok(stretcher.pushInput([input]), 'input ring must not overflow while output is drained');
    expectedFrames += block / rate;
    const planes = stretcher.process();
    if (planes) {
      const output = planes[0];
      for (let sample = 0; sample < output.length; sample++) {
        assert.ok(Number.isFinite(output[sample]));
        maxStep = Math.max(maxStep, Math.abs(output[sample] - previousSample));
        previousSample = output[sample];
      }
      producedFrames += output.length;
    }
    maxRetained = Math.max(maxRetained, stretcher.inputWritten - stretcher.inputKeepFrom);
    assert.ok(stretcher.segments.length <= 512, 'segment history must stay bounded');
  }
  assert.ok(Math.abs(producedFrames - expectedFrames) <= 2 * stretcher.seek + stretcher.hop + block,
    `stretched output drifted: ${producedFrames} vs ${expectedFrames}`);
  assert.ok(maxStep <= Math.sin(2 * Math.PI * 330 / sampleRate) * 1.05, 'no audible splice over three minutes');
  assert.ok(maxRetained < stretcher.capacity / 2, 'the input ring must recycle old samples');
  assert.ok(stretcher.stats.maxSearchDeviation <= stretcher.seek);
}

// FIFO arithmetic after a day of playback stays exact and never runs ahead of
// what was appended.
{
  const framesPerDay = 24 * 60 * 60 * 48_000;
  const rendered = audio.audioRenderedOutputFrame({
    status: { contextTime: 86_400, consumedFrames: framesPerDay },
    appendedFrames: framesPerDay + 4800,
    contextTimeNow: 86_400.05,
    sampleRate: 48_000,
  });
  assert.strictEqual(rendered, framesPerDay + 2400);
  assert.strictEqual(audio.audioRenderedOutputFrame({
    status: { contextTime: 86_400, consumedFrames: framesPerDay },
    appendedFrames: framesPerDay + 100,
    contextTimeNow: 86_401,
    sampleRate: 48_000,
  }), framesPerDay + 100);
}

// The sync controller never leaves its bounds no matter how long it runs.
{
  let deviation = 0;
  for (let step = 0; step < 24 * 60 * 60 * 50; step++) {
    const errorMs = Math.sin(step / 500) * 400;
    deviation = audio.audioSyncDeviationStep({ errorMs, deviation, allowFaster: step % 7 !== 0 });
    if (Math.abs(deviation) > AUDIO_SYNC_MAX_DEVIATION_BOUND()) {
      assert.fail(`deviation escaped its bound: ${deviation}`);
    }
  }
  function AUDIO_SYNC_MAX_DEVIATION_BOUND() { return 0.0150001; }
  assert.ok(Number.isFinite(deviation));
}

// Enqueue policy with far-future and far-past context times. The pure plan
// skips a severely late block; the player promotes sustained lateness only
// after it spans the source-derived observation window.
assert.strictEqual(audio.audioEnqueuePlan({
  fifoEmpty: true,
  discontinuity: false,
  desiredContextTime: 100_000,
  queueEndContextTime: 99_999.5,
}).action, 'pad');
assert.strictEqual(audio.audioEnqueuePlan({
  fifoEmpty: true,
  discontinuity: false,
  desiredContextTime: 100_000,
  queueEndContextTime: 100_003,
}).action, 'skip');

// Worklet counters stay exact near 2^32 rendered frames (about a day at 48 kHz).
{
  const workletSource = new Function(
    slice("const AUDIO_WORKLET_PROCESSOR_NAME = 'livesuite-audio-fifo';", '// 本地音画同步控制')
    + '\nreturn AUDIO_WORKLET_SOURCE;',
  )();
  const registry = {};
  globalThis.__livesuiteTestCurrentTime = 90_000;
  class AudioWorkletProcessor {
    constructor() { this.port = { onmessage: null, posted: [], postMessage(message) { this.posted.push(message); } }; }
  }
  new Function('AudioWorkletProcessor', 'registerProcessor',
    workletSource.replace(/\bcurrentTime\b/g, 'globalThis.__livesuiteTestCurrentTime'))(
    AudioWorkletProcessor, (name, processorClass) => { registry[name] = processorClass; },
  );
  const processor = new registry['livesuite-audio-fifo']();
  processor.renderedFrames = 2 ** 32 - 64;
  processor.consumedFrames = 2 ** 32 - 200;
  processor.port.onmessage({ data: { type: 'push', planes: [new Float32Array(256).fill(0.1)], frames: 256 } });
  processor.port.onmessage({ data: { type: 'configure', statusInterval: 1 } });
  for (let index = 0; index < 3; index++) processor.process([], [[new Float32Array(128)]]);
  assert.strictEqual(processor.renderedFrames, 2 ** 32 - 64 + 384);
  assert.strictEqual(processor.consumedFrames, 2 ** 32 - 200 + 256);
  const status = processor.port.posted[processor.port.posted.length - 1];
  assert.strictEqual(status.renderedFrames, 2 ** 32 - 64 + 256);
}

// Video pacing and FLV timestamps over long sessions.
const video = new Function(
  constants + '\n' + clamp
  + slice('function advanceVideoPresentationDeadline(', 'function evaluateFrameRateControl(')
  + '\nreturn { advanceVideoPresentationDeadline };',
)();
const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
const deadline = video.advanceVideoPresentationDeadline(1, thirtyDaysMs, 53.7);
assert.ok(deadline > thirtyDaysMs);
assert.ok(deadline - thirtyDaysMs <= 1000 / 53.7 + 0.001);

const unwrap = new Function(
  'const FLV_TIMESTAMP_MODULUS_MS = 0x100000000;\n'
  + slice('function unwrapFlvTimestampMs(', 'function signed24(')
  + '\nreturn unwrapFlvTimestampMs;',
)();
const threeWraps = 3 * 0x100000000 + 1234;
assert.strictEqual(unwrap(1234, threeWraps - 16, threeWraps), threeWraps);

assert.ok(!html.includes('PIPELINE_RECYCLE_INTERVAL_MS'));
assert.match(html, /if \(syncRequestInFlight\) return;/);
assert.match(html, /for \(const frame of this\.videoFrames\)[\s\S]*?frame\.close\(\)/);
assert.match(html, /finally \{[\s\S]*?audioData\.close\(\);[\s\S]*?\}/);
assert.match(html, /if \(this\.audioFifoChunks\.length > 512\)/, 'FIFO chunk map must stay bounded');
assert.match(html, /if \(this\.audioDecodeSubmitQueue\.length > 64\)/, 'decode submission queue must stay bounded');

console.log('Browser 24-hour stability simulation passed');
