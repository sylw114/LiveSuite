const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('native/livesuite-quic/src/browser_player.html', 'utf8');

const audioStart = html.indexOf('function clampNumber(');
const audioEnd = html.indexOf('function audioClockIsReady(', audioStart);
assert.ok(audioStart >= 0 && audioEnd > audioStart, 'audio timing helpers were not found');
const audio = new Function(
  'const AUDIO_STRETCH_GRAIN_SAMPLES = 256;\n'
    + 'const AUDIO_STRETCH_SEARCH_SAMPLES = 32;\n'
    + 'const AUDIO_SCHEDULE_LEAD_SECONDS = 0.015;\n'
    + 'const MAX_AUDIO_SOURCES = 16384;\n'
    + html.slice(audioStart, audioEnd)
    + '\nreturn { stretchedAudioFrameCount, audioScheduleRecoveryReason };',
)();

// Simulate 24 hours of 48 kHz AAC-LC scheduling while the controller changes
// rate every 256 ms. Fractional AudioBuffer rounding must stay bounded forever,
// rather than accumulating a gap on every 1024-sample block.
const audioBlocks = Math.ceil(24 * 60 * 60 * 48_000 / 1024);
const rates = [0.99, 1, 1.01, 1, 0.97, 1, 1.03, 1];
let remainder = 0;
let scheduledFrames = 0;
let exactFrames = 0;
for (let block = 0; block < audioBlocks; block++) {
  const rate = rates[Math.floor(block / 12) % rates.length];
  const result = audio.stretchedAudioFrameCount(1024, rate, remainder);
  scheduledFrames += result.frameCount;
  exactFrames += 1024 / rate;
  remainder = result.remainder;
}
assert.ok(Math.abs(scheduledFrames - exactFrames) <= 0.5);

assert.strictEqual(audio.audioScheduleRecoveryReason({
  anchored: true,
  currentTime: 100,
  scheduleCursor: 220,
  sourceCount: 12000,
  maximumAheadSeconds: 122,
}), null, 'a valid 120-second combined delay must not be mistaken for a stalled pipeline');
assert.strictEqual(audio.audioScheduleRecoveryReason({
  anchored: true,
  currentTime: 100,
  scheduleCursor: 223,
  sourceCount: 10,
  maximumAheadSeconds: 122,
}), 'future-backlog');
assert.strictEqual(audio.audioScheduleRecoveryReason({
  anchored: true,
  currentTime: 100,
  scheduleCursor: 101,
  sourceCount: 16384,
  maximumAheadSeconds: 122,
}), 'source-limit');

const videoStart = html.indexOf('function advanceVideoPresentationDeadline(');
const videoEnd = html.indexOf('function evaluateFrameRateControl(', videoStart);
assert.ok(videoStart >= 0 && videoEnd > videoStart, 'video pacing helper was not found');
const video = new Function(
  'const MIN_TARGET_VIDEO_FPS = 12;\n'
    + 'const MAX_TARGET_VIDEO_FPS = 240;\n'
    + 'const FRAME_RATE_EPSILON_FPS = 0.25;\n'
    + 'const VIDEO_PRESENTATION_EPSILON_MS = 0.25;\n'
    + 'function clampNumber(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }\n'
    + html.slice(videoStart, videoEnd)
    + '\nreturn { advanceVideoPresentationDeadline };',
)();

const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
const deadline = video.advanceVideoPresentationDeadline(1, thirtyDaysMs, 53.7);
assert.ok(deadline > thirtyDaysMs);
assert.ok(deadline - thirtyDaysMs <= 1000 / 53.7 + 0.001);

const unwrapStart = html.indexOf('function unwrapFlvTimestampMs(');
const unwrapEnd = html.indexOf('function signed24(', unwrapStart);
const unwrap = new Function(
  'const FLV_TIMESTAMP_MODULUS_MS = 0x100000000;\n'
    + html.slice(unwrapStart, unwrapEnd)
    + '\nreturn unwrapFlvTimestampMs;',
)();
const threeWraps = 3 * 0x100000000 + 1234;
assert.strictEqual(unwrap(1234, threeWraps - 16, threeWraps), threeWraps);

assert.ok(!html.includes('PIPELINE_RECYCLE_INTERVAL_MS'));
assert.match(html, /if \(syncRequestInFlight\) return;/);
assert.match(html, /for \(const frame of this\.videoFrames\)[\s\S]*?frame\.close\(\)/);
assert.match(html, /finally \{[\s\S]*?audioData\.close\(\);[\s\S]*?\}/);
assert.match(html, /source\.onended = \(\) => this\.releaseAudioEntry\(entry\);/);
assert.match(html, /if \(pendingEntry\) this\.releaseAudioEntry\(pendingEntry\);/);

console.log('Browser 24-hour stability simulation passed');
