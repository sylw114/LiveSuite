const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('native/livesuite-quic/src/browser_player.html', 'utf8');
assert.ok(
  !html.includes('source.playbackRate'),
  'audio sources must not use rate resampling, which changes pitch',
);
const start = html.indexOf('function clampNumber(');
const end = html.indexOf('function decodeStreamPath(');
assert.ok(start >= 0 && end > start, 'audio stretch helpers were not found');

const helpers = new Function(
  'const AUDIO_STRETCH_GRAIN_SAMPLES = 256;\n'
    + 'const AUDIO_STRETCH_SEARCH_SAMPLES = 32;\n'
    + 'const AUDIO_SCHEDULE_LEAD_SECONDS = 0.015;\n'
    + html.slice(start, end)
    + '\nreturn { stretchAudioPlanes, stretchedAudioFrameCount, audioRateTransitionAnchor, audioContextTimeForPerformance, audioOutputLatencySeconds };',
)();

function sine(frameCount, sampleRate, frequency) {
  const samples = new Float32Array(frameCount);
  for (let index = 0; index < frameCount; index++) {
    samples[index] = Math.sin(2 * Math.PI * frequency * index / sampleRate);
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

const sampleRate = 48_000;
const input = sine(1024, sampleRate, 1_000);
for (const rate of [0.9, 0.95, 1.05, 1.1]) {
  const [output] = helpers.stretchAudioPlanes([input], rate);
  assert.strictEqual(output.length, Math.round(input.length / rate));
  assert.ok(Math.abs(estimateFrequency(output, sampleRate) - 1_000) < 150);
  assert.ok(output.some((sample) => Math.abs(sample) > 0.1));
  // 做了末尾颗粒覆盖输入尾部的验证，以防止出现每个 AAC 小块丢尾音或重复一段的情况。
  assert.strictEqual(output[output.length - 1], input[input.length - 1]);
}

// Integer AudioBuffer sizes must carry their fractional remainder forward. If
// every AAC block is rounded independently, a few microseconds of gap/overlap
// accumulate on every block and eventually become audible drift.
for (const rate of [0.98, 1.02]) {
  let remainder = 0;
  let totalFrames = 0;
  const blocks = 100_000;
  for (let block = 0; block < blocks; block++) {
    const result = helpers.stretchedAudioFrameCount(1024, rate, remainder);
    totalFrames += result.frameCount;
    remainder = result.remainder;
  }
  assert.ok(Math.abs(totalFrames - blocks * 1024 / rate) <= 0.5);
}

let variableRemainder = 0;
let variableFrames = 0;
let variableExactFrames = 0;
for (let block = 0; block < 100_000; block++) {
  const rate = block % 4 < 2 ? 0.98 : 1.02;
  const result = helpers.stretchedAudioFrameCount(1024, rate, variableRemainder);
  variableFrames += result.frameCount;
  variableExactFrames += 1024 / rate;
  variableRemainder = result.remainder;
}
assert.ok(Math.abs(variableFrames - variableExactFrames) <= 0.5);

const futureAnchor = helpers.audioRateTransitionAnchor({
  currentContextTime: 10,
  audioScheduleCursor: 10.12,
  audioScheduledUntilPtsUs: 5_000_000,
  currentTargetUs: 4_900_000,
  fallbackContextTime: 10.03,
});
assert.deepStrictEqual(futureAnchor, {
  mediaUs: 5_000_000,
  contextTime: 10.12,
});

const emptyAnchor = helpers.audioRateTransitionAnchor({
  currentContextTime: 10,
  audioScheduleCursor: 9,
  audioScheduledUntilPtsUs: 5_000_000,
  currentTargetUs: 5_100_000,
  fallbackContextTime: 10.05,
});
assert.deepStrictEqual(emptyAnchor, {
  mediaUs: 5_100_000,
  contextTime: 10.05,
});

assert.strictEqual(helpers.audioContextTimeForPerformance({
  state: 'running',
  getOutputTimestamp: () => ({ contextTime: 2, performanceTime: 1000 }),
}, 1050), 2.05);
assert.strictEqual(helpers.audioOutputLatencySeconds({
  state: 'suspended',
  outputLatency: 0.08,
}), 0.08);

const shortInput = sine(256, sampleRate, 1_000);
const [shortOutput] = helpers.stretchAudioPlanes([shortInput], 1.05);
assert.strictEqual(shortOutput, shortInput, 'short PCM blocks must not fall back to pitch-shifting resampling');

console.log('Browser audio WSOLA tests passed');
