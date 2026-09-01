const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('native/livesuite-quic/src/browser_player.html', 'utf8');
const start = html.indexOf('function audioClockIsReady(');
const end = html.indexOf('function decodeStreamPath(');
assert.ok(start >= 0 && end > start, 'audio lifecycle helpers were not found');

const helpers = new Function(
  'const MAX_AUDIO_LATE_SCHEDULE_SECONDS = 0.25;\n'
    + html.slice(start, end)
    + '\nreturn { audioClockIsReady, retainSchedulableAudioInput };',
)();

assert.strictEqual(helpers.audioClockIsReady({ state: 'running' }, 0, 0), true);
assert.strictEqual(helpers.audioClockIsReady({ state: 'suspended' }, 0, 0), false);
assert.strictEqual(helpers.audioClockIsReady({ state: 'running' }, null, 0), false);
assert.strictEqual(helpers.audioClockIsReady({ state: 'running' }, 0, null), false);

const queued = [
  { timestampUs: 500_000 },
  { timestampUs: 749_999 },
  { timestampUs: 750_000 },
  { timestampUs: 800_000 },
];
assert.deepStrictEqual(
  helpers.retainSchedulableAudioInput(queued, 1_000_000),
  queued.slice(2),
  'audio older than the late window must not delay resumed playback',
);
assert.strictEqual(
  helpers.retainSchedulableAudioInput(queued, Number.NaN),
  queued,
  'audio must be retained until the player has a usable media clock',
);

const watchdogStart = html.indexOf('function audioDecoderRecoveryReason(');
const watchdogEnd = html.indexOf('\n\n    // AudioDecoder', watchdogStart);
assert.ok(watchdogStart >= 0 && watchdogEnd > watchdogStart,
  'audio decoder watchdog helper was not found');
const audioDecoderRecoveryReason = new Function(
  'const AUDIO_DECODER_RECOVERY_COOLDOWN_MS = 250;\n'
    + html.slice(watchdogStart, watchdogEnd)
    + '\nreturn audioDecoderRecoveryReason;',
)();
const activeStall = {
  decoderReady: true,
  clockReady: true,
  inputAgeMs: 20,
  outputAgeMs: 150,
  bufferedSeconds: 0.02,
  graceRemainingMs: 0,
  recoveryAgeMs: 1000,
  stallThresholdMs: 120,
  inputActiveWindowMs: 1000,
  recoveryBufferSeconds: 0.15,
};
assert.strictEqual(audioDecoderRecoveryReason(activeStall), 'output-stalled',
  'recent input without decoder output must recover even when decoder queues read zero');
assert.strictEqual(audioDecoderRecoveryReason({ ...activeStall, inputAgeMs: 1001 }), null,
  'a real source-side audio gap must not rebuild the decoder');
assert.strictEqual(audioDecoderRecoveryReason({ ...activeStall, bufferedSeconds: 0.2 }), null,
  'decoder recovery must wait while already scheduled audio remains safe');
assert.strictEqual(audioDecoderRecoveryReason({ ...activeStall, graceRemainingMs: 1 }), null,
  'a newly configured decoder must receive its output grace period');

const configureStart = html.indexOf('configureAudio() {');
const configureEnd = html.indexOf('\n      pumpAudio() {', configureStart);
const configureMethod = html.slice(configureStart, configureEnd);
assert.ok(
  /output: \(audioData\) => \{[\s\S]*?this\.scheduleAudio\(audioData\);[\s\S]*?this\.pumpAudio\(\);/.test(configureMethod),
  'decoded output must continue draining an already queued audio backlog',
);
const pumpStart = html.indexOf('pumpAudio() {');
const pumpEnd = html.indexOf('\n      realignAudioSchedule(', pumpStart);
const pumpMethod = html.slice(pumpStart, pumpEnd);
assert.ok(!pumpMethod.includes('this.lastAudioOutputAt = performance.now()'),
  'submitting compressed input must not masquerade as decoded audio output');
assert.match(
  html,
  /this\.audioInput = this\.audioInput\.slice\(-MAX_AUDIO_INPUT\);/,
  'audio queue trimming must honor the configured bound',
);
const resumeStart = html.indexOf('resumeAudioFromUserGesture() {');
const resumeEnd = html.indexOf('\n      stop() {', resumeStart);
const resumeMethod = html.slice(resumeStart, resumeEnd);
assert.ok(!resumeMethod.includes('this.closeAudioDecoder()'),
  'unlocking audio must not discard retained compressed audio');

assert.ok(
  !html.includes('PIPELINE_RECYCLE_INTERVAL_MS'),
  'a healthy long-running player must not be interrupted by unconditional periodic recycling',
);
assert.match(
  html,
  /generation !== this\.audioDecoderGeneration[\s\S]*?audioData\.close\(\)/,
  'late AudioDecoder callbacks from an old generation must be released',
);
assert.match(
  html,
  /ownFlvUrl\.searchParams\.set\('livesuite-player', '1'\)/,
  'the built-in player must request browser-side scheduling headroom',
);
assert.match(html, /const PLAYER_BUILD_ID = 'av-independent-v5';/,
  'runtime diagnostics must expose the watchdog build identifier');

const feedbackStart = html.indexOf('async sendPlaybackFeedback() {');
const feedbackEnd = html.indexOf('\n      recoverDegradedVideoPipeline() {', feedbackStart);
const feedbackMethod = html.slice(feedbackStart, feedbackEnd);
assert.ok(
  !feedbackMethod.includes('audioSources.size'),
  'audio node watermarks must never trigger a whole playback-pipeline recovery',
);
assert.match(
  feedbackMethod,
  /this\.recoverAudioScheduleHealth\(\)/,
  'audio scheduling health must be recovered locally before feedback is sent',
);

const audioRecoveryStart = html.indexOf('recoverAudioSchedule(reason,');
const audioRecoveryEnd = html.indexOf('\n      recoverAudioScheduleHealth(', audioRecoveryStart);
const audioRecoveryMethod = html.slice(audioRecoveryStart, audioRecoveryEnd);
assert.match(audioRecoveryMethod, /this\.realignAudioSchedule\(/);
assert.ok(!/resetPipeline|abortController|closeAudioDecoder/.test(audioRecoveryMethod),
  'audio schedule recovery must preserve the decoder, connection, and video pipeline');

const videoRecoveryStart = html.indexOf('recoverDegradedVideoPipeline() {');
const videoRecoveryEnd = html.indexOf('\n      resetForRealignment() {', videoRecoveryStart);
const videoRecoveryMethod = html.slice(videoRecoveryStart, videoRecoveryEnd);
assert.match(videoRecoveryMethod, /this\.closeVideoDecoder\(\)/);
assert.ok(!/closeAudioDecoder|resetPipeline|abortController/.test(videoRecoveryMethod),
  'video backlog recovery must not interrupt already scheduled audio');

console.log('Browser audio lifecycle tests passed');
