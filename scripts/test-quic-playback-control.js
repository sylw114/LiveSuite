const assert = require('assert');
const {
  evaluatePlaybackControl,
  QuicPullHub,
  FAST_PLAYBACK_RATE,
  HARD_FAST_PLAYBACK_RATE,
  HARD_SLOW_PLAYBACK_RATE,
  MAX_PLAYBACK_RATE_STEP,
  NORMAL_PLAYBACK_RATE,
  RAW_AUDIO,
  RAW_DELTA,
  SLOW_PLAYBACK_RATE,
  browserPlayerReleaseLeadMs,
  takeReadyFrames,
} = require('../tscdist/main/quicPull');

const nowMs = 1_000_000;
const alignmentDelayMs = 180;
const targetPositionUs = (nowMs - alignmentDelayMs) * 1000;

const pendingTracks = [
  {
    ordinal: 2,
    kind: RAW_AUDIO,
    ptsUs: 2_000,
    timelineUs: 2_000,
    releaseEpochMs: nowMs,
    data: Buffer.alloc(0),
  },
  {
    ordinal: 1,
    kind: RAW_DELTA,
    ptsUs: 1_000,
    timelineUs: 1_000,
    releaseEpochMs: nowMs,
    data: Buffer.alloc(0),
  },
  {
    ordinal: 3,
    kind: RAW_DELTA,
    ptsUs: 3_000,
    timelineUs: 3_000,
    releaseEpochMs: nowMs + 1,
    data: Buffer.alloc(0),
  },
];
const readyTracks = takeReadyFrames(
  pendingTracks,
  nowMs,
  false,
  (frame) => frame.releaseEpochMs,
);
assert.deepStrictEqual(readyTracks.map((frame) => frame.ordinal), [1, 2],
  'due video and audio must be released independently and in media-time order');
assert.deepStrictEqual(pendingTracks.map((frame) => frame.ordinal), [3],
  'only frames whose own release time is in the future may remain pending');

function feedback(positionErrorMs, overrides = {}) {
  return {
    clientId: 'test-client',
    sessionId: 'test-session',
    streamPath: '/test',
    videoBufferBytes: 0,
    videoGapCount: 1,
    audioFrameCount: 3,
    audioBufferedMs: 70,
    hasAudio: true,
    playbackPositionUs: targetPositionUs + positionErrorMs * 1000,
    appliedPlaybackRate: NORMAL_PLAYBACK_RATE,
    playbackClockMs: nowMs,
    updatedAtMs: nowMs,
    ...overrides,
  };
}

function control(positionErrorMs, overrides, previousState) {
  return evaluatePlaybackControl(
    [feedback(positionErrorMs, overrides)],
    alignmentDelayMs,
    nowMs,
    previousState,
  );
}

assert.strictEqual(control(54).playbackRate, NORMAL_PLAYBACK_RATE);
assert.strictEqual(control(-54).playbackRate, NORMAL_PLAYBACK_RATE);

const projectedControl = control(-200, {
  projectedPlaybackPositionUs: targetPositionUs,
});
assert.strictEqual(projectedControl.reason, 'behind');
assert.strictEqual(projectedControl.positionErrorMs, -200);
assert.strictEqual(projectedControl.playbackRate, NORMAL_PLAYBACK_RATE + MAX_PLAYBACK_RATE_STEP);
// 推演位置不得覆盖真实显示位置，否则校速只持续一个反馈周期并形成脉冲。
assert.strictEqual(control(-200, {
  projectedPlaybackPositionUs: targetPositionUs,
  videoGapCount: 0,
}).reason, 'underflow');

const ahead = control(120);
assert.strictEqual(ahead.reason, 'ahead');
assert.strictEqual(ahead.playbackRate, NORMAL_PLAYBACK_RATE - MAX_PLAYBACK_RATE_STEP);

let hardAhead = control(500);
for (let index = 0; index < 20; index++) {
  hardAhead = control(500, {}, {
    playbackRate: hardAhead.playbackRate,
    reason: hardAhead.reason,
  });
}
assert.strictEqual(hardAhead.playbackRate, HARD_SLOW_PLAYBACK_RATE);
assert.strictEqual(control(250, {}, {
  playbackRate: HARD_SLOW_PLAYBACK_RATE,
  reason: 'ahead',
}).reason, 'ahead');
assert.strictEqual(control(180, {}, {
  playbackRate: HARD_SLOW_PLAYBACK_RATE,
  reason: 'ahead',
}).playbackRate, HARD_SLOW_PLAYBACK_RATE + MAX_PLAYBACK_RATE_STEP);

const heldAhead = control(60, {}, {
  playbackRate: SLOW_PLAYBACK_RATE,
  reason: 'ahead',
});
assert.strictEqual(heldAhead.playbackRate, SLOW_PLAYBACK_RATE);
assert.strictEqual(control(44, {}, {
  playbackRate: SLOW_PLAYBACK_RATE,
  reason: 'ahead',
}).playbackRate, SLOW_PLAYBACK_RATE + MAX_PLAYBACK_RATE_STEP);

const behind = control(-120);
assert.strictEqual(behind.reason, 'behind');
assert.strictEqual(behind.playbackRate, NORMAL_PLAYBACK_RATE + MAX_PLAYBACK_RATE_STEP);
let hardBehind = control(-500);
for (let index = 0; index < 20; index++) {
  hardBehind = control(-500, {}, {
    playbackRate: hardBehind.playbackRate,
    reason: hardBehind.reason,
  });
}
assert.strictEqual(hardBehind.playbackRate, HARD_FAST_PLAYBACK_RATE);
assert.strictEqual(control(-250, {}, {
  playbackRate: HARD_FAST_PLAYBACK_RATE,
  reason: 'behind',
}).reason, 'behind');
assert.strictEqual(control(-60, {}, {
  playbackRate: FAST_PLAYBACK_RATE,
  reason: 'behind',
}).playbackRate, FAST_PLAYBACK_RATE);

const underflow = control(0, { videoGapCount: 0 });
assert.strictEqual(underflow.reason, 'underflow');
assert.strictEqual(underflow.playbackRate, NORMAL_PLAYBACK_RATE - MAX_PLAYBACK_RATE_STEP);

const audioDurationReserve = control(0, {
  audioFrameCount: 0,
  audioBufferedMs: 70,
});
assert.strictEqual(audioDurationReserve.playbackRate, NORMAL_PLAYBACK_RATE);
assert.strictEqual(control(0, {
  audioFrameCount: 0,
  audioBufferedMs: 20,
}).reason, 'underflow');
assert.strictEqual(control(0, {
  audioFrameCount: 0,
  audioBufferedMs: 70,
}, {
  playbackRate: SLOW_PLAYBACK_RATE,
  reason: 'underflow',
}).reason, 'underflow');

const overbuffered = control(0, {
  videoGapCount: 6,
  audioFrameCount: 21,
  audioBufferedMs: 500,
  playbackPositionUs: null,
});
assert.strictEqual(overbuffered.reason, 'overbuffered');
assert.strictEqual(overbuffered.playbackRate, NORMAL_PLAYBACK_RATE + MAX_PLAYBACK_RATE_STEP);

assert.strictEqual(browserPlayerReleaseLeadMs(180), 120);
assert.strictEqual(browserPlayerReleaseLeadMs(100), 100);
assert.strictEqual(browserPlayerReleaseLeadMs(30), 30);

// Closed-loop simulation: a 150ms lead must converge monotonically without the
// old 1x/correction/1x pulse train. The per-poll rate delta remains inaudible.
let simulatedErrorMs = 150;
let simulatedState;
let previousRate = NORMAL_PLAYBACK_RATE;
let previousDirection = 0;
let directionChanges = 0;
for (let sample = 0; sample < 400; sample++) {
  const simulated = control(simulatedErrorMs, {}, simulatedState);
  assert.ok(Math.abs(simulated.playbackRate - previousRate) <= MAX_PLAYBACK_RATE_STEP + 1e-9);
  const direction = Math.sign(simulated.playbackRate - NORMAL_PLAYBACK_RATE);
  if (direction !== 0 && previousDirection !== 0 && direction !== previousDirection) {
    directionChanges++;
  }
  if (direction !== 0) previousDirection = direction;
  simulatedErrorMs += (simulated.playbackRate - NORMAL_PLAYBACK_RATE) * 250;
  simulatedState = {
    playbackRate: simulated.playbackRate,
    reason: simulated.reason,
  };
  previousRate = simulated.playbackRate;
}
assert.ok(Math.abs(simulatedErrorMs) < 55);
assert.strictEqual(simulatedState.playbackRate, NORMAL_PLAYBACK_RATE);
assert.strictEqual(directionChanges, 0);

const hub = new QuicPullHub({
  takeFrames: () => ({ resync: false, closed: false, frames: [] }),
  syncInfoJson: () => JSON.stringify({ synchronize: false, alignmentDelayMs }),
}, {
  bind: '127.0.0.1',
  port: 0,
});
hub.registerSession({
  sessionId: 'test-session',
  streamPath: '/test',
  audioAvailable: true,
  audioChannels: 2,
  audioGroupDurationUs: 21_333,
});
hub.sessions.get('test-session').connections.add({});

function liveFeedback(positionErrorMs, appliedPlaybackRate = NORMAL_PLAYBACK_RATE) {
  const clockMs = Date.now();
  return {
    ...feedback(0),
    playbackPositionUs: (clockMs - alignmentDelayMs + positionErrorMs) * 1000,
    appliedPlaybackRate,
    playbackClockMs: clockMs,
  };
}

const firstCommand = hub.acceptPlaybackFeedback(liveFeedback(0));
assert.strictEqual(firstCommand.playbackRate, NORMAL_PLAYBACK_RATE);
assert.strictEqual(firstCommand.desiredPlaybackRate, NORMAL_PLAYBACK_RATE);

const steadyCommand = hub.acceptPlaybackFeedback(liveFeedback(0));
assert.strictEqual(steadyCommand.playbackRate, undefined);
assert.strictEqual(steadyCommand.desiredPlaybackRate, NORMAL_PLAYBACK_RATE);
assert.ok(!JSON.stringify(steadyCommand).includes('"playbackRate"'));

const slowCommand = hub.acceptPlaybackFeedback(liveFeedback(120));
assert.strictEqual(slowCommand.playbackRate, NORMAL_PLAYBACK_RATE - MAX_PLAYBACK_RATE_STEP);
// 未确认的斜坡点会补发；确认后继续按每个反馈周期 0.5% 平滑靠近目标。
assert.strictEqual(
  hub.acceptPlaybackFeedback(liveFeedback(60, NORMAL_PLAYBACK_RATE)).playbackRate,
  NORMAL_PLAYBACK_RATE - MAX_PLAYBACK_RATE_STEP * 2,
);
let acknowledgedRate = NORMAL_PLAYBACK_RATE - MAX_PLAYBACK_RATE_STEP * 2;
while (acknowledgedRate > SLOW_PLAYBACK_RATE) {
  const response = hub.acceptPlaybackFeedback(liveFeedback(60, acknowledgedRate));
  acknowledgedRate = response.desiredPlaybackRate;
  assert.strictEqual(response.playbackRate, acknowledgedRate);
}
assert.strictEqual(acknowledgedRate, SLOW_PLAYBACK_RATE);
assert.strictEqual(hub.acceptPlaybackFeedback(
  liveFeedback(60, SLOW_PLAYBACK_RATE),
).playbackRate, undefined);
assert.strictEqual(
  hub.acceptPlaybackFeedback(liveFeedback(44, SLOW_PLAYBACK_RATE)).playbackRate,
  SLOW_PLAYBACK_RATE + MAX_PLAYBACK_RATE_STEP,
);

console.log('QUIC playback control tests passed');
