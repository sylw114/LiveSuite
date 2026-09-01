const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('native/livesuite-quic/src/browser_player.html', 'utf8');
const fullScript = html.match(/<script>([\s\S]*)<\/script>/);
assert.ok(fullScript, 'browser player script was not found');
assert.doesNotThrow(() => new Function(fullScript[1]), 'browser player has invalid JavaScript');

const start = html.indexOf('function advanceVideoPresentationDeadline(');
const end = html.indexOf('// ============ 单流播放会话', start);
assert.ok(start >= 0 && end > start, 'adaptive frame-rate helpers were not found');

const helpers = new Function(
  'const INITIAL_TARGET_VIDEO_FPS = 60;\n'
    + 'const MIN_TARGET_VIDEO_FPS = 12;\n'
    + 'const MAX_TARGET_VIDEO_FPS = 240;\n'
    + 'const REQUIRED_PRESENTATION_RATIO = 0.95;\n'
    + 'const SOURCE_SUPPLY_REQUIRED_RATIO = 0.98;\n'
    + 'const SOURCE_SUPPLY_TOLERANCE_FPS = 1.5;\n'
    + 'const FRAME_RATE_RAF_TOLERANCE_FPS = 1.5;\n'
    + 'const FRAME_RATE_EPSILON_FPS = 0.25;\n'
    + 'const FRAME_RATE_LIMITED_SAMPLES_BEFORE_DECREASE = 2;\n'
    + 'const FRAME_RATE_HEALTHY_SAMPLES_BEFORE_INCREASE = 2;\n'
    + 'const FRAME_RATE_CAPACITY_DECREASE_ALPHA = 0.5;\n'
    + 'const FRAME_RATE_CAPACITY_RECOVERY_ALPHA = 0.08;\n'
    + 'const FRAME_RATE_SOURCE_RECOVERY_ALPHA = 0.5;\n'
    + 'const FRAME_RATE_MAX_DECREASE_FRACTION = 0.15;\n'
    + 'const FRAME_RATE_MAX_INCREASE_FRACTION = 0.20;\n'
    + 'const FRAME_RATE_MIN_ADJUSTMENT_FPS = 0.5;\n'
    + 'const VIDEO_PRESENTATION_EPSILON_MS = 0.25;\n'
    + 'function clampNumber(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }\n'
    + html.slice(start, end)
    + '\nreturn { evaluateFrameRateControl, measureSourceVideoRate, evaluateSourceAvailability, advanceVideoPresentationDeadline };',
)();

const frameRateControlSource = html.slice(
  html.indexOf('function evaluateFrameRateControl(', start),
  html.indexOf('function measureSourceVideoRate(', start),
);
assert.ok(!frameRateControlSource.includes('decoderBacklogged'),
  'decoder backlog cannot control a canvas-only frame-rate limiter');
assert.ok(!html.includes('cadenceAtOrBelow(') && !html.includes('nextHigherCadence('),
  'adaptive control must not use fixed integer-divisor frame-rate tiers');
assert.ok(!html.includes('sourceNominalVideoFps'),
  'a variable-rate source must not become a persistent local frame-rate ceiling');
const observeStart = html.indexOf('observeFrameRate(now) {');
const observeEnd = html.indexOf('\n      playbackMetrics() {', observeStart);
const observeMethod = html.slice(observeStart, observeEnd);
assert.match(observeMethod, /sourceLimited:[\s\S]*?!hasRecentVideoOutput/,
  'no-output/source-static windows must use source-independent recovery');
assert.ok(!/if \(this\.sourceVideoFps/.test(observeMethod),
  'frame-rate control must continue running while the source emits no frames');

function control(overrides = {}) {
  return helpers.evaluateFrameRateControl({
    targetVideoFps: 60,
    preferredVideoFps: 60,
    rafFps: 60,
    presentationRatio: 1,
    longRafRatio: 0,
    sourceLimited: false,
    measurementSuspended: false,
    capacityEstimateFps: 60,
    stableSamples: 0,
    limitedSamples: 0,
    ...overrides,
  });
}

function nextState(state, overrides = {}) {
  const result = control({ ...state, ...overrides });
  return {
    targetVideoFps: result.targetVideoFps,
    capacityEstimateFps: result.capacityEstimateFps,
    stableSamples: result.stableSamples,
    limitedSamples: result.limitedSamples,
    result,
  };
}

const steady = control();
assert.strictEqual(steady.targetVideoFps, 60);
assert.strictEqual(steady.achievementRatio, 1);
assert.strictEqual(steady.reason, 'steady');

const halfSecondAt30 = helpers.measureSourceVideoRate(15, 0.5, 0, 466_667);
assert.ok(Math.abs(halfSecondAt30.measuredSourceFps - 30) < 0.1);
const sourceAt30Against60 = helpers.evaluateSourceAvailability({
  targetVideoFps: 60,
  sourceArrivalFps: halfSecondAt30.sourceArrivalFps,
  sourcePtsFps: halfSecondAt30.sourcePtsFps,
});
assert.strictEqual(sourceAt30Against60.sourceLimited, true,
  'a source-side VFR reduction must be isolated from local performance control');
assert.ok(Math.abs(sourceAt30Against60.expectedFps - 30) < 0.1);
assert.strictEqual(helpers.evaluateSourceAvailability({
  targetVideoFps: 30,
  sourceArrivalFps: halfSecondAt30.sourceArrivalFps,
  sourcePtsFps: halfSecondAt30.sourcePtsFps,
}).sourceLimited, false);
assert.strictEqual(helpers.evaluateSourceAvailability({
  targetVideoFps: 60,
  sourceArrivalFps: 0,
  sourcePtsFps: 0,
}).sourceLimited, true);
assert.strictEqual(helpers.evaluateSourceAvailability({
  targetVideoFps: 60,
  sourceArrivalFps: 2,
  sourcePtsFps: 0,
}).sourceLimited, true);

// A single large frame can miss one window, but it must not change the target.
const transientMiss = control({ presentationRatio: 0.4 });
assert.strictEqual(transientMiss.targetVideoFps, 60);
assert.strictEqual(transientMiss.reason, 'adaptive-decrease-pending');
const afterTransientMiss = control({
  capacityEstimateFps: transientMiss.capacityEstimateFps,
  limitedSamples: transientMiss.limitedSamples,
});
assert.strictEqual(afterTransientMiss.targetVideoFps, 60);
assert.strictEqual(afterTransientMiss.capacityEstimateFps, 60);

// The reduction amount follows the measured achievement instead of selecting
// a fixed 60 -> 30 tier.
const mildPending = control({ presentationRatio: 0.9 });
const mildReduction = control({
  presentationRatio: 0.9,
  capacityEstimateFps: mildPending.capacityEstimateFps,
  limitedSamples: mildPending.limitedSamples,
});
const severePending = control({ presentationRatio: 0.6 });
const severeReduction = control({
  presentationRatio: 0.6,
  capacityEstimateFps: severePending.capacityEstimateFps,
  limitedSamples: severePending.limitedSamples,
});
assert.ok(mildReduction.targetVideoFps > severeReduction.targetVideoFps);
assert.ok(mildReduction.targetVideoFps < 60 && mildReduction.targetVideoFps > 50);
assert.strictEqual(severeReduction.targetVideoFps, 51);
assert.notStrictEqual(mildReduction.targetVideoFps, 30);

// A browser hidden by the user provides no meaningful rAF capacity sample.
const suspended = control({
  targetVideoFps: 47.3,
  capacityEstimateFps: 45,
  rafFps: 1,
  presentationRatio: 0,
  measurementSuspended: true,
  limitedSamples: 1,
});
assert.strictEqual(suspended.targetVideoFps, 47.3);
assert.strictEqual(suspended.capacityEstimateFps, 45);
assert.strictEqual(suspended.reason, 'measurement-suspended');

// Simulate a real local capacity of 24fps. The continuous controller should
// settle near capacity / 95%, not at a hard-coded divisor such as 30 or 20.
let adaptiveState = {
  targetVideoFps: 60,
  capacityEstimateFps: 60,
  stableSamples: 0,
  limitedSamples: 0,
};
for (let sample = 0; sample < 200; sample++) {
  adaptiveState = nextState(adaptiveState, {
    presentationRatio: Math.min(1, 24 / adaptiveState.targetVideoFps),
  });
}
assert.ok(adaptiveState.targetVideoFps > 24.5 && adaptiveState.targetVideoFps < 26,
  `adaptive target should settle near 25.3fps, got ${adaptiveState.targetVideoFps}`);
assert.notStrictEqual(adaptiveState.targetVideoFps, 20);
assert.notStrictEqual(adaptiveState.targetVideoFps, 30);

const locallyLimitedState = {
  targetVideoFps: adaptiveState.targetVideoFps,
  capacityEstimateFps: adaptiveState.capacityEstimateFps,
  stableSamples: adaptiveState.stableSamples,
  limitedSamples: adaptiveState.limitedSamples,
};

// Exercise the actual classifier/controller hand-off while a 60fps source
// switches to a steady 30fps static mode. Recovery must complete even while
// 30fps initially still exceeds the old low local target.
let vfr30State = { ...locallyLimitedState };
for (let sample = 0; sample < 30; sample++) {
  const availability = helpers.evaluateSourceAvailability({
    targetVideoFps: vfr30State.targetVideoFps,
    sourceArrivalFps: 30,
    sourcePtsFps: 30,
  });
  vfr30State = nextState(vfr30State, {
    sourceLimited: availability.sourceLimited,
    presentationRatio: 1,
  });
}
assert.strictEqual(vfr30State.targetVideoFps, 60,
  'an actual 30fps VFR source must not preserve an old low local target');

// When the source becomes static, presentation achievement is intentionally
// ignored. Healthy rAF must recover an old low target before motion resumes.
adaptiveState = { ...locallyLimitedState };
for (let sample = 0; sample < 20; sample++) {
  adaptiveState = nextState(adaptiveState, {
    sourceLimited: true,
    presentationRatio: 0,
  });
}
assert.strictEqual(adaptiveState.targetVideoFps, 60,
  'source-side frame reduction must never freeze the player at a low target');
assert.strictEqual(adaptiveState.result.reason === 'source-independent'
  || adaptiveState.result.reason === 'source-independent-recover', true);

// 24 hours of source-side 2fps static output must leave the local target at
// 60fps and keep every state variable bounded. Motion can then resume at once.
let staticSourceState = {
  targetVideoFps: 60,
  capacityEstimateFps: 60,
  stableSamples: 0,
  limitedSamples: 0,
};
for (let sample = 0; sample < 24 * 60 * 60 * 2; sample++) {
  staticSourceState = nextState(staticSourceState, {
    sourceLimited: true,
    presentationRatio: sample % 2,
  });
}
assert.strictEqual(staticSourceState.targetVideoFps, 60);
assert.strictEqual(staticSourceState.capacityEstimateFps, 60);
staticSourceState = nextState(staticSourceState, {
  sourceLimited: false,
  presentationRatio: 1,
});
assert.strictEqual(staticSourceState.targetVideoFps, 60);

// A continuous target is paced by an absolute deadline. On a 60Hz rAF grid,
// every 53.7fps interval is one or two ticks and phase error stays below one tick.
let deadline = null;
const presentationTimes = [];
for (let frame = 0; frame < 600; frame++) {
  const now = frame * 1000 / 60;
  if (deadline === null || now + 0.25 >= deadline) {
    presentationTimes.push(now);
    deadline = helpers.advanceVideoPresentationDeadline(deadline, now, 53.7);
  }
}
const tickMs = 1000 / 60;
for (let index = 1; index < presentationTimes.length; index++) {
  const intervalTicks = Math.round((presentationTimes[index] - presentationTimes[index - 1]) / tickMs);
  assert.ok(intervalTicks === 1 || intervalTicks === 2);
  const idealElapsed = index * 1000 / 53.7;
  const actualElapsed = presentationTimes[index] - presentationTimes[0];
  assert.ok(Math.abs(actualElapsed - idealElapsed) <= tickMs + 0.01);
}
assert.ok(Math.abs(presentationTimes.length - 53.7 * 10) <= 2);

assert.ok(
  !html.includes('shouldQueueDecodedVideoFrame('),
  'decoded frames must not be sampled by quantized FLV PTS before rAF scheduling',
);

const unwrapStart = html.indexOf('function unwrapFlvTimestampMs(');
const unwrapEnd = html.indexOf('function signed24(', unwrapStart);
const unwrap = new Function(
  'const FLV_TIMESTAMP_MODULUS_MS = 0x100000000;\n'
    + html.slice(unwrapStart, unwrapEnd)
    + '\nreturn unwrapFlvTimestampMs;',
)();
assert.strictEqual(
  unwrap(25, 0x100000000 - 10, 0x100000000 + 25),
  0x100000000 + 25,
  'FLV timestamps must remain monotonic across the 49.7-day wrap',
);

assert.ok(Number.isFinite(
  helpers.advanceVideoPresentationDeadline(0, 7 * 24 * 3600 * 1000, 53.7),
));

console.log('Browser adaptive frame-rate control tests passed');
