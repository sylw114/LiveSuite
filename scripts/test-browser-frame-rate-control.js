const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('native/livesuite-quic/src/browser_player.html', 'utf8');
const fullScript = html.match(/<script>([\s\S]*)<\/script>/);
assert.ok(fullScript, 'browser player script was not found');
assert.doesNotThrow(() => new Function(fullScript[1]), 'browser player has invalid JavaScript');
const start = html.indexOf('function cadenceAtOrBelow(');
const end = html.indexOf('// ============ 单流播放会话', start);
assert.ok(start >= 0 && end > start, 'frame-rate control helpers were not found');

const helpers = new Function(
  'const INITIAL_TARGET_VIDEO_FPS = 60;\n'
    + 'const MIN_TARGET_VIDEO_FPS = 12;\n'
    + 'const MAX_TARGET_VIDEO_FPS = 240;\n'
    + 'const REQUIRED_PRESENTATION_RATIO = 0.95;\n'
    + 'const SOURCE_RATE_SHORTFALL_RATIO = 0.80;\n'
    + 'const FRAME_RATE_RAF_TOLERANCE_FPS = 1.5;\n'
    + 'const FRAME_RATE_EPSILON_FPS = 0.25;\n'
    + 'const FRAME_RATE_LIMITED_SAMPLES_BEFORE_DECREASE = 2;\n'
    + 'const STABLE_SAMPLES_BEFORE_INCREASE = 6;\n'
    + 'const FRAME_RATE_RECOVERY_PROBE_SUCCESS_SAMPLES = 6;\n'
    + 'const FRAME_RATE_RECOVERY_BACKOFF_BASE_SAMPLES = 6;\n'
    + 'const FRAME_RATE_RECOVERY_BACKOFF_MAX_SAMPLES = 120;\n'
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

function control(overrides = {}) {
  return helpers.evaluateFrameRateControl({
    targetVideoFps: 60,
    preferredVideoFps: 60,
    rafFps: 60,
    presentationRatio: 1,
    longRafRatio: 0,
    decoderBacklogged: false,
    sourceLimited: false,
    stableSamples: 0,
    limitedSamples: 0,
    recoveryCooldownSamples: 0,
    recoveryBackoffSamples: 0,
    recoveryProbeSamples: 0,
    ...overrides,
  });
}

// 60Hz rAF 本身不应因 95% 的展示成功阈值而永久被压到 57fps。
assert.strictEqual(control().targetVideoFps, 60);
assert.strictEqual(control().reason, 'steady');

const halfSecondAt30 = helpers.measureSourceVideoRate(15, 0.5, 0, 466_667);
assert.ok(Math.abs(halfSecondAt30.measuredSourceFps - 30) < 0.1);
assert.strictEqual(helpers.evaluateSourceAvailability({
  targetVideoFps: 60,
  sourceNominalVideoFps: 60,
  sourceArrivalFps: halfSecondAt30.sourceArrivalFps,
  sourcePtsFps: halfSecondAt30.sourcePtsFps,
}).sourceLimited, true);

// 原本就是 30fps 的流不会被误判为掉帧；只有相对既有源基线不足才保护目标帧率。
assert.strictEqual(helpers.evaluateSourceAvailability({
  targetVideoFps: 60,
  sourceNominalVideoFps: 30,
  sourceArrivalFps: halfSecondAt30.sourceArrivalFps,
  sourcePtsFps: halfSecondAt30.sourcePtsFps,
}).sourceLimited, false);

const sourceLoss = control({ presentationRatio: 0.5, sourceLimited: true });
assert.strictEqual(sourceLoss.targetVideoFps, 60);
assert.strictEqual(sourceLoss.reason, 'source-limited');

// 解码泵会正常地把 decodeQueueSize 维持在高水位；降低 canvas 帧率并不会
// 少解任何 H.264 参考帧，因此持续积压本身不能锁死或下调呈现目标。
let queueHighTarget = 60;
let queueHighStable = 0;
let queueHighLimited = 0;
for (let sample = 0; sample < 30; sample++) {
  const queueHigh = control({
    targetVideoFps: queueHighTarget,
    decoderBacklogged: true,
    stableSamples: queueHighStable,
    limitedSamples: queueHighLimited,
  });
  queueHighTarget = queueHigh.targetVideoFps;
  queueHighStable = queueHigh.stableSamples;
  queueHighLimited = queueHigh.limitedSamples;
}
assert.strictEqual(queueHighTarget, 60);
assert.strictEqual(queueHighLimited, 0);

const pendingSlowdown = control({ rafFps: 30, presentationRatio: 0.5 });
assert.strictEqual(pendingSlowdown.targetVideoFps, 60);
assert.strictEqual(pendingSlowdown.reason, 'display-capacity-pending');
const localSlowdown = control({
  rafFps: 30,
  presentationRatio: 0.5,
  limitedSamples: pendingSlowdown.limitedSamples,
});
assert.ok(localSlowdown.targetVideoFps < 60);
assert.strictEqual(localSlowdown.targetVideoFps, 30);
assert.strictEqual(localSlowdown.reason, 'display-capacity');

let recoveredTarget = 30;
let stableSamples = 0;
let recoveryCooldownSamples = 0;
let recoveryBackoffSamples = 0;
let recoveryProbeSamples = 0;
for (let sample = 0; sample < 6; sample++) {
  const recovered = control({
    targetVideoFps: recoveredTarget,
    presentationRatio: 1,
    decoderBacklogged: true,
    stableSamples,
    recoveryCooldownSamples,
    recoveryBackoffSamples,
    recoveryProbeSamples,
  });
  recoveredTarget = recovered.targetVideoFps;
  stableSamples = recovered.stableSamples;
  recoveryCooldownSamples = recovered.recoveryCooldownSamples;
  recoveryBackoffSamples = recovered.recoveryBackoffSamples;
  recoveryProbeSamples = recovered.recoveryProbeSamples;
}
assert.strictEqual(recoveredTarget, 60,
  'a healthy presentation path must recover even while the decoder queue stays full');

// 一个偶发大帧只扣一格恢复信用；它既不立即降档，也不能让低帧率永久化。
const transientLargeFrame = control({
  targetVideoFps: 30,
  presentationRatio: 0.7,
  stableSamples: 4,
});
assert.strictEqual(transientLargeFrame.targetVideoFps, 30);
assert.strictEqual(transientLargeFrame.stableSamples, 3);
assert.strictEqual(transientLargeFrame.limitedSamples, 1);
let transientState = transientLargeFrame;
for (let sample = 0; sample < 3; sample++) {
  transientState = control({
    targetVideoFps: transientState.targetVideoFps,
    stableSamples: transientState.stableSamples,
    limitedSamples: transientState.limitedSamples,
    recoveryCooldownSamples: transientState.recoveryCooldownSamples,
    recoveryBackoffSamples: transientState.recoveryBackoffSamples,
    recoveryProbeSamples: transientState.recoveryProbeSamples,
  });
}
assert.strictEqual(transientState.targetVideoFps, 60);

// 源侧短缺只暂停恢复，不清除已经通过本地健康窗口建立的信用。
const pausedBySource = control({
  targetVideoFps: 30,
  sourceLimited: true,
  stableSamples: 4,
});
assert.strictEqual(pausedBySource.stableSamples, 4);

// 如果恢复探测很快证明设备确实承载不了高档，则逐级退避下一次探测，
// 避免长期运行中每三秒在 30/60fps 之间振荡。
const failedProbePending = control({
  targetVideoFps: 60,
  presentationRatio: 0.7,
  recoveryProbeSamples: 2,
});
const failedProbe = control({
  targetVideoFps: 60,
  presentationRatio: 0.7,
  limitedSamples: failedProbePending.limitedSamples,
  recoveryProbeSamples: failedProbePending.recoveryProbeSamples,
});
assert.strictEqual(failedProbe.targetVideoFps, 30);
assert.strictEqual(failedProbe.recoveryBackoffSamples, 6);
assert.strictEqual(failedProbe.recoveryCooldownSamples, 6);
let backedOff = failedProbe;
for (let sample = 0; sample < 6; sample++) {
  backedOff = control({
    targetVideoFps: backedOff.targetVideoFps,
    stableSamples: backedOff.stableSamples,
    limitedSamples: backedOff.limitedSamples,
    recoveryCooldownSamples: backedOff.recoveryCooldownSamples,
    recoveryBackoffSamples: backedOff.recoveryBackoffSamples,
    recoveryProbeSamples: backedOff.recoveryProbeSamples,
  });
  assert.strictEqual(backedOff.targetVideoFps, 30);
}
assert.strictEqual(backedOff.recoveryCooldownSamples, 0);
for (let sample = 0; sample < 6; sample++) {
  backedOff = control({
    targetVideoFps: backedOff.targetVideoFps,
    stableSamples: backedOff.stableSamples,
    limitedSamples: backedOff.limitedSamples,
    recoveryCooldownSamples: backedOff.recoveryCooldownSamples,
    recoveryBackoffSamples: backedOff.recoveryBackoffSamples,
    recoveryProbeSamples: backedOff.recoveryProbeSamples,
  });
}
assert.strictEqual(backedOff.targetVideoFps, 60,
  'backoff must delay recovery probes, never disable them permanently');

// 以半秒为一步模拟 24 小时的持续 30fps 本地承载能力。退避计数必须有界；
// 能力随后恢复时，即使已退避到上限，也必须在有限时间内回到 60fps。
let longRunState = {
  targetVideoFps: 60,
  stableSamples: 0,
  limitedSamples: 0,
  recoveryCooldownSamples: 0,
  recoveryBackoffSamples: 0,
  recoveryProbeSamples: 0,
};
let maximumObservedBackoff = 0;
for (let sample = 0; sample < 24 * 60 * 60 * 2; sample++) {
  const result = control({
    ...longRunState,
    presentationRatio: longRunState.targetVideoFps > 30.25 ? 0.5 : 1,
  });
  longRunState = {
    targetVideoFps: result.targetVideoFps,
    stableSamples: result.stableSamples,
    limitedSamples: result.limitedSamples,
    recoveryCooldownSamples: result.recoveryCooldownSamples,
    recoveryBackoffSamples: result.recoveryBackoffSamples,
    recoveryProbeSamples: result.recoveryProbeSamples,
  };
  maximumObservedBackoff = Math.max(maximumObservedBackoff, result.recoveryBackoffSamples);
}
assert.strictEqual(maximumObservedBackoff, 120);
for (let sample = 0; sample < 126; sample++) {
  const result = control({ ...longRunState, presentationRatio: 1 });
  longRunState = {
    targetVideoFps: result.targetVideoFps,
    stableSamples: result.stableSamples,
    limitedSamples: result.limitedSamples,
    recoveryCooldownSamples: result.recoveryCooldownSamples,
    recoveryBackoffSamples: result.recoveryBackoffSamples,
    recoveryProbeSamples: result.recoveryProbeSamples,
  };
}
assert.strictEqual(longRunState.targetVideoFps, 60,
  'even maximum backoff must recover after local capacity returns');

// 60Hz 上的 30fps 降档必须严格每两个 rAF 呈现一次，不允许用 54fps 一类
// 非整数分频制造周期性的 16/33ms 锯齿。
let deadline = null;
const presentationTimes = [];
for (let frame = 0; frame < 120; frame++) {
  const now = frame * 1000 / 60;
  if (deadline === null || now + 0.25 >= deadline) {
    presentationTimes.push(now);
    deadline = helpers.advanceVideoPresentationDeadline(deadline, now, 30);
  }
}
const intervals = presentationTimes.slice(1).map((time, index) => time - presentationTimes[index]);
assert.ok(intervals.every((interval) => Math.abs(interval - 1000 / 30) < 0.01));

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

// A long idle gap must advance the deadline in O(1) arithmetic rather than
// looping once per missed frame.
assert.ok(Number.isFinite(helpers.advanceVideoPresentationDeadline(0, 7 * 24 * 3600 * 1000, 60)));

console.log('Browser frame-rate control tests passed');
