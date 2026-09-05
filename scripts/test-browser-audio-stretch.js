const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('native/livesuite-quic/src/browser_player.html', 'utf8');
assert.ok(
  !html.includes('source.playbackRate') && !html.includes('createBufferSource'),
  'audio must not use AudioBufferSourceNode rate resampling, which changes pitch',
);
assert.ok(html.includes('class AudioTimeStretcher'), 'continuous WSOLA stretcher was not found');
assert.ok(html.includes('audioWorklet.addModule('), 'audio output must be a gapless AudioWorklet FIFO');

function slice(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `markers not found: ${startMarker} / ${endMarker}`);
  return html.slice(start, end);
}

// Every single-line top-level constant of the player script.
const constants = [...html.matchAll(/^ {4}const ([A-Z_0-9]+) = ([^;\n]+);$/gm)]
  .map((match) => `const ${match[1]} = ${match[2]};`).join('\n');

const helpers = new Function(
  constants + '\n'
  + 'function clampNumber(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }\n'
  + slice('class LinearResampler', '// AudioWorklet FIFO')
  + slice('function audioSyncDeviationStep', 'function audioDecoderRecoveryReason(')
  + '\nreturn { LinearResampler, AudioTimeStretcher, audioSyncDeviationStep, audioEnqueuePlan, audioLateWindowStep, audioRenderedOutputFrame, AUDIO_SYNC_MAX_DEVIATION };',
)();

function sine(frameCount, sampleRate, frequency, phase = 0) {
  const samples = new Float32Array(frameCount);
  for (let index = 0; index < frameCount; index++) {
    samples[index] = Math.sin(phase + 2 * Math.PI * frequency * index / sampleRate);
  }
  return samples;
}

function noise(frameCount, seed = 1) {
  const samples = new Float32Array(frameCount);
  let state = seed >>> 0;
  for (let index = 0; index < frameCount; index++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    samples[index] = (state / 4294967296) * 2 - 1;
  }
  return samples;
}

function estimateFrequency(samples, sampleRate) {
  let crossings = 0;
  for (let index = 1; index < samples.length; index++) {
    if (samples[index - 1] <= 0 && samples[index] > 0) crossings++;
  }
  return crossings * sampleRate / samples.length;
}

function maxStep(samples) {
  let maximum = 0;
  for (let index = 1; index < samples.length; index++) {
    maximum = Math.max(maximum, Math.abs(samples[index] - samples[index - 1]));
  }
  return maximum;
}

function runStretcher(stretcher, planes, blockFrames, onBlock) {
  const chunks = [];
  for (let offset = 0; offset < planes[0].length; offset += blockFrames) {
    if (onBlock) onBlock(offset);
    assert.ok(
      stretcher.pushInput(planes.map((plane) => plane.subarray(offset, offset + blockFrames))),
      'stretcher input must not overflow while output is drained',
    );
    const output = stretcher.process();
    if (output) chunks.push(output);
  }
  return planes.map((_, channel) => Float32Array.from(
    chunks.flatMap((chunk) => Array.from(chunk[channel])),
  ));
}

const sampleRate = 48_000;
const seconds = 3;

// A stretch ratio must change tempo without changing pitch, must not add any
// discontinuity beyond the source's own sample-to-sample steps, and must hit
// the requested ratio to within one search window over the whole run.
for (const rate of [1, 0.97, 1.03, 0.9, 1.1, 1.005, 0.995]) {
  const stretcher = new helpers.AudioTimeStretcher(2, sampleRate);
  stretcher.setRate(rate);
  const left = sine(sampleRate * seconds, sampleRate, 440);
  const right = sine(sampleRate * seconds, sampleRate, 660, 1);
  const [outLeft, outRight] = runStretcher(stretcher, [left, right], 1024);
  const expectedFrames = left.length / rate;
  assert.ok(
    Math.abs(outLeft.length - expectedFrames) <= 2 * stretcher.seek + stretcher.hop,
    `rate ${rate}: produced ${outLeft.length} frames, expected about ${expectedFrames}`,
  );
  assert.ok(Math.abs(estimateFrequency(outLeft, sampleRate) - 440) < 3, `rate ${rate}: left pitch changed`);
  assert.ok(Math.abs(estimateFrequency(outRight, sampleRate) - 660) < 3, `rate ${rate}: right pitch changed`);
  assert.ok(maxStep(outLeft) <= maxStep(left) * 1.05, `rate ${rate}: splice discontinuity`);
  if (rate === 1) {
    assert.strictEqual(outLeft.length, left.length);
    for (let index = 0; index < left.length; index++) {
      assert.strictEqual(outLeft[index], left[index], 'rate 1 must be bit-exact pass-through');
    }
    assert.strictEqual(stretcher.stats.searches, 0, 'rate 1 must not search');
  }
}

// Noise has no periodicity to hide behind: the controlled position must still
// be followed, i.e. the search window is centred on an absolute schedule.
for (const rate of [0.97, 1.03, 0.99, 1.01]) {
  const stretcher = new helpers.AudioTimeStretcher(1, sampleRate);
  stretcher.setRate(rate);
  const input = noise(sampleRate * seconds);
  const [output] = runStretcher(stretcher, [input], 1024);
  assert.ok(
    Math.abs(output.length - input.length / rate) <= 2 * stretcher.seek + stretcher.hop,
    `noise rate ${rate}: produced ${output.length} frames`,
  );
  assert.ok(stretcher.stats.maxSearchDeviation <= stretcher.seek, 'search must stay inside the seek window');
}

// Rate changes mid-stream stay continuous, and returning to rate 1 makes the
// stretcher transparent again.
{
  const stretcher = new helpers.AudioTimeStretcher(1, sampleRate);
  const input = sine(sampleRate * 8, sampleRate, 330);
  const schedule = [[1, 1.03], [2, 1], [3, 0.97], [4, 1.1], [5, 0.9], [6, 1], [7, 1.002]];
  const [output] = runStretcher(stretcher, [input], 1024, (offset) => {
    for (const [atSecond, rate] of schedule) {
      if (offset >= atSecond * sampleRate && offset < atSecond * sampleRate + 1024) stretcher.setRate(rate);
    }
  });
  assert.ok(Array.from(output).every(Number.isFinite));
  assert.ok(maxStep(output) <= maxStep(input) * 1.05, 'rate switches must not splice audibly');
  assert.ok(Math.abs(estimateFrequency(output, sampleRate) - 330) < 3);

  const excursion = new helpers.AudioTimeStretcher(1, sampleRate);
  const noiseInput = noise(sampleRate * 3, 7);
  runStretcher(excursion, [noiseInput], 1024, (offset) => {
    if (offset >= sampleRate && offset < sampleRate + 1024) excursion.setRate(1.03);
    if (offset >= sampleRate * 2 && offset < sampleRate * 2 + 1024) excursion.setRate(1);
  });
  assert.ok(excursion.stats.transparentGrains > 30, 'rate 1 after an excursion must return to pass-through grains');
}

// Output does not depend on how the decoder happens to chunk its input.
{
  function outputWithBlock(blockFrames) {
    const stretcher = new helpers.AudioTimeStretcher(1, sampleRate);
    stretcher.setRate(1.03);
    const input = sine(sampleRate * 2, sampleRate, 220);
    const output = [];
    for (let offset = 0; offset < input.length; offset += blockFrames) {
      stretcher.pushInput([input.subarray(offset, Math.min(input.length, offset + blockFrames))]);
      const planes = stretcher.process();
      if (planes) output.push(...planes[0]);
    }
    return output;
  }
  const a = outputWithBlock(1024);
  const b = outputWithBlock(480);
  const c = outputWithBlock(2048);
  const length = Math.min(a.length, b.length, c.length);
  for (let index = 0; index < length; index++) {
    assert.ok(a[index] === b[index] && a[index] === c[index], 'stretcher output depends on chunk size');
  }
}

// The output-to-input mapping used for A/V sync is monotonic and follows the
// controlled rate rather than the per-grain search jitter.
{
  const stretcher = new helpers.AudioTimeStretcher(1, sampleRate);
  stretcher.setRate(0.95);
  const input = sine(sampleRate, sampleRate, 300);
  const [output] = runStretcher(stretcher, [input], 1024);
  let previous = -1;
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 97) {
    const inputIndex = stretcher.inputPositionForOutput(outputIndex);
    assert.ok(inputIndex >= previous, 'mapping must be monotonic');
    previous = inputIndex;
  }
  assert.ok(Math.abs(stretcher.inputPositionForOutput(output.length - 1) - output.length * 0.95) < 2);
}

// Fallback resampler for an AudioContext that could not adopt the AAC rate.
{
  const resampler = new helpers.LinearResampler(2, 44_100, 48_000);
  const input = sine(44_100, 44_100, 1_000);
  const left = [];
  const right = [];
  for (let offset = 0; offset < input.length; offset += 1024) {
    const chunk = input.subarray(offset, offset + 1024);
    const output = resampler.process([chunk, chunk]);
    left.push(...output[0]);
    right.push(...output[1]);
  }
  assert.ok(Math.abs(left.length - 48_000) < 3);
  assert.ok(Math.abs(estimateFrequency(Float32Array.from(left), 48_000) - 1_000) < 3);
  assert.deepStrictEqual(right, left, 'all resampled channels must share one timeline phase');
}

// Local A/V sync controller: dead band, proportional pull, slew and clamp.
{
  assert.strictEqual(helpers.audioSyncDeviationStep({ errorMs: 1.5, deviation: 0 }), 0);
  let deviation = 0;
  for (let step = 0; step < 200; step++) deviation = helpers.audioSyncDeviationStep({ errorMs: 60, deviation });
  assert.ok(Math.abs(deviation + helpers.AUDIO_SYNC_MAX_DEVIATION) < 1e-9,
    'audio far ahead must slow by the maximum deviation only');
  assert.ok(helpers.AUDIO_SYNC_MAX_DEVIATION <= 0.01, 'local corrections must stay inaudible');
  deviation = 0;
  const first = helpers.audioSyncDeviationStep({ errorMs: -60, deviation });
  assert.ok(Math.abs(first - 0.00004) < 1e-9, '20ms may only change tempo by 0.004%');
  for (let step = 0; step < 100; step++) deviation = helpers.audioSyncDeviationStep({ errorMs: -10, deviation });
  assert.ok(Math.abs(deviation - 4 / 5000) < 1e-9, 'small errors converge to a proportional deviation');
  // A starving FIFO cannot be caught up by playing faster: speed-ups are
  // withheld (and an existing speed-up is wound down) until reserve returns.
  deviation = 0.004;
  for (let step = 0; step < 100; step++) {
    deviation = helpers.audioSyncDeviationStep({ errorMs: -60, deviation, allowFaster: false });
  }
  assert.strictEqual(deviation, 0, 'no speed-up while the FIFO has no reserve');
  assert.ok(helpers.audioSyncDeviationStep({ errorMs: 60, deviation: 0, allowFaster: false }) < 0,
    'slowing down remains allowed without reserve');
  const ramp = (elapsedMs) => {
    let value = 0;
    for (let elapsed = 0; elapsed < 1000; elapsed += elapsedMs) {
      value = helpers.audioSyncDeviationStep({ errorMs: 60, deviation: value, elapsedMs });
    }
    return value;
  };
  assert.ok(Math.abs(ramp(10) - ramp(20)) < 1e-9,
    'sample rate and status callback frequency must not change tempo slew');
}

// Enqueue policy: contiguous streams append; an empty FIFO or a discontinuity
// primes with silence, plays slightly late audio and skips an isolated severely late block.
{
  const actions = [
    { fifoEmpty: false, discontinuity: false, desiredContextTime: 5, queueEndContextTime: 1 },
    { fifoEmpty: false, discontinuity: true, desiredContextTime: 1.2, queueEndContextTime: 1 },
    { fifoEmpty: false, discontinuity: true, desiredContextTime: 0.96, queueEndContextTime: 1 },
    { fifoEmpty: true, discontinuity: false, desiredContextTime: 1.15, queueEndContextTime: 1 },
    { fifoEmpty: true, discontinuity: false, desiredContextTime: 0.95, queueEndContextTime: 1 },
    { fifoEmpty: true, discontinuity: false, desiredContextTime: 0.7, queueEndContextTime: 1 },
    { fifoEmpty: true, discontinuity: false, desiredContextTime: -2, queueEndContextTime: 1 },
  ].map((input) => helpers.audioEnqueuePlan(input));
  assert.deepStrictEqual(actions.map((plan) => plan.action), ['append', 'pad', 'append', 'pad', 'append', 'append', 'skip']);
  assert.ok(Math.abs(actions[1].padSeconds - 0.2) < 1e-9);
  assert.ok(Math.abs(actions[4].lateSeconds - 0.05) < 1e-9);
}

// Persistent lateness is decided by elapsed arrival time, not packet count:
// any number of old blocks arriving in one batch remains an isolated skip.
{
  const first = helpers.audioLateWindowStep({ nowMs: 1000, startedAtMs: null, windowMs: 40 });
  const sameBatch = helpers.audioLateWindowStep({
    nowMs: 1000,
    startedAtMs: first.startedAtMs,
    windowMs: 40,
  });
  const insideWindow = helpers.audioLateWindowStep({
    nowMs: 1039,
    startedAtMs: first.startedAtMs,
    windowMs: 40,
  });
  const sustained = helpers.audioLateWindowStep({
    nowMs: 1040,
    startedAtMs: first.startedAtMs,
    windowMs: 40,
  });
  assert.strictEqual(first.sustained, false);
  assert.strictEqual(sameBatch.sustained, false);
  assert.strictEqual(insideWindow.sustained, false);
  assert.strictEqual(sustained.sustained, true);
}

// The rendered-frame estimate never runs past what has been appended.
assert.strictEqual(helpers.audioRenderedOutputFrame({
  status: { contextTime: 10, consumedFrames: 1000 },
  appendedFrames: 1200,
  contextTimeNow: 10.5,
  sampleRate: 48_000,
}), 1200);
assert.ok(Math.abs(helpers.audioRenderedOutputFrame({
  status: { contextTime: 10, consumedFrames: 1000 },
  appendedFrames: 100_000,
  contextTimeNow: 10.01,
  sampleRate: 48_000,
}) - 1480) < 1e-6);

console.log('Browser audio stretch tests passed');
