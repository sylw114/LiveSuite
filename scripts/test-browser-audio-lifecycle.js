const assert = require('assert');
const fs = require('fs');

const html = fs.readFileSync('native/livesuite-quic/src/browser_player.html', 'utf8');

function slice(startMarker, endMarker) {
  const start = html.indexOf(startMarker);
  const end = html.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `markers not found: ${startMarker} / ${endMarker}`);
  return html.slice(start, end);
}

function method(name, nextMarker) {
  const start = html.indexOf(`      ${name} {`);
  assert.ok(start >= 0, `method ${name} was not found`);
  const end = html.indexOf(nextMarker, start + 1);
  assert.ok(end > start, `end of method ${name} was not found`);
  return html.slice(start, end);
}

const constants = [...html.matchAll(/^ {4}const ([A-Z_0-9]+) = ([^;\n]+);$/gm)]
  .map((match) => `const ${match[1]} = ${match[2]};`).join('\n');

// ---- audio output architecture ----
assert.match(html, /const PLAYER_BUILD_ID = 'av-gapless-v\d+';/,
  'runtime diagnostics must expose the build identifier');
assert.ok(html.includes('audioWorklet.addModule('), 'audio must be rendered by an AudioWorklet FIFO');
assert.ok(html.includes("registerProcessor('${AUDIO_WORKLET_PROCESSOR_NAME}'"), 'worklet processor must be registered');
assert.ok(!html.includes('createBufferSource') && !html.includes('source.playbackRate'),
  'AudioBufferSourceNode scheduling was replaced by the gapless FIFO');
assert.ok(!html.includes('PIPELINE_RECYCLE_INTERVAL_MS'),
  'a healthy long-running player must not be interrupted by unconditional periodic recycling');
assert.match(html, /ownFlvUrl\.searchParams\.set\('livesuite-player', '1'\)/,
  'the built-in player must request browser-side scheduling headroom');
assert.match(html, /<button id="audio-unlock"[^>]*>开启声音<\/button>/,
  'autoplay rejection must retain an explicit audio-unlock fallback');
assert.match(html, /audioUnlockButton\.hidden = !needsUnlock/,
  'the audio-unlock fallback must become visible while AudioContext is suspended');
assert.match(html, /generation !== this\.audioDecoderGeneration[\s\S]*?audioData\.close\(\)/,
  'late AudioDecoder callbacks from an old generation must be released');
assert.match(html, /finally \{[\s\S]*?audioData\.close\(\);[\s\S]*?\}/,
  'every decoded AudioData must be closed');

// Decoded media time comes from the submitted chunk, never from the decoder's
// synthesised output timestamp.
const decoderOutput = slice('this.audioDecoder = new AudioDecoder({', 'this.audioDecoder.configure({');
assert.match(decoderOutput, /const submitted = this\.takeAudioDecodeSubmission\(\);/);
assert.match(decoderOutput, /this\.appendDecodedAudio\(audioData, mediaTimestampUs\);/);
const appendDecoded = method('appendDecodedAudio(audioData, mediaTimestampUs = audioData.timestamp)', '\n      startAudioStream(');
assert.ok(!/Number\.isFinite\(audioData\.timestamp\)\s*\?\s*audioData\.timestamp/.test(appendDecoded),
  'AudioData.timestamp must not decide the media position');

// Stream restarts keep the FIFO; only genuine resyncs flush it.
const startStream = method('startAudioStream(timestampUs)', '\n      // PCM 流装配');
assert.ok(!startStream.includes('resetAudioTimeline'), 'a stream restart must not flush queued audio');
assert.match(startStream, /this\.audioStreamDiscontinuity = true;/);
const resetTimeline = method('resetAudioTimeline(reason)', '\n      closeAudioDecoder() {');
assert.match(resetTimeline, /postAudioOutput\(\{ type: 'flush' \}\)/, 'a resync flushes the output FIFO');
const appendStream = method('appendAudioStream(timestampUs, planes)', '\n      drainAudioStretcher() {');
assert.ok(!appendStream.includes('resetAudioTimeline'),
  'holes, overflow and restarts inside the PCM assembler must not flush the FIFO');
assert.match(appendStream, /pushSilence\(holeFrames\)/, 'source holes are filled with silence to keep the timeline');

// Unlocking, feedback and video recovery must not discard audio state.
const resume = method('resumeAudioFromUserGesture()', '\n      stop() {');
assert.ok(!resume.includes('closeAudioDecoder'), 'unlocking audio must not discard retained compressed audio');
const feedback = method('async sendPlaybackFeedback()', '\n      recoverDegradedVideoPipeline() {');
assert.match(feedback, /this\.recoverAudioSyncHealth\(\)/);
assert.match(feedback, /this\.reconcileAudioDecodeSubmissions\(\)/);
assert.match(feedback, /this\.evaluateAdaptiveLatent\(\)/);
assert.match(feedback, /this\.watchAudioOutputHealth\(\)/, 'the output host is watched on every feedback tick');
assert.ok(html.includes('createScriptProcessorOutput(') && html.includes("'processor-error'")
  && html.includes("'worklet-silent'") && html.includes("'module-load-failed'"),
  'a ScriptProcessorNode fallback must cover worklet load failure, processor errors and silent worklets');
assert.ok(html.includes("pageParams.get('audioout')"), 'audioout=script must force the fallback output');
assert.ok(!feedback.includes('audioSources'), 'audio node watermarks no longer exist');
const videoRecovery = method('recoverDegradedVideoPipeline()', '\n      resetForRealignment() {');
assert.match(videoRecovery, /this\.closeVideoDecoder\(\)/);
assert.ok(!/closeAudioDecoder|resetAudioTimeline|abortController/.test(videoRecovery),
  'video backlog recovery must not interrupt already queued audio');
const metrics = method('playbackMetrics()', '\n      async sendPlaybackFeedback() {');
assert.match(metrics, /EXTRA_LATENT_MS \+ this\.adaptiveLatentMs/,
  'the adaptive playback delay must be reported like the page latent so the server does not fight it');
const audioTarget = method('audioTargetUs(nowPerfMs = performance.now())', '\n      destroyAudioOutput() {');
assert.match(audioTarget, /this\.displayLagMs/, 'audio follows the actually presented video');

// A server-side alignment increase replaces matching local emergency latency.
// It must not be added twice, and a timeline that has not presented a frame may
// adopt the remaining delta directly without causing a visible pause.
const refreshSync = slice('function refreshSyncInfo()', '    refreshSyncInfo();');
assert.match(refreshSync, /session\.applyServerAlignmentDelay\(alignmentDeltaMs\)/,
  'live sessions must be notified when the shared alignment delay changes');
const applyAlignment = method('applyServerAlignmentDelay(deltaMs)', '\n      // 视频时间轴');
assert.match(applyAlignment, /this\.adaptiveLatentMs -= transferredMs/,
  'server alignment growth must consume equivalent temporary local latency');
assert.match(applyAlignment, /this\.lastDisplayedPtsUs === null/,
  'only a not-yet-visible timeline may shift immediately');
const maxVideoFrames = method('maxVideoInputFrames()', '\n      maxVideoInputBytes() {');
assert.match(maxVideoFrames, /this\.adaptiveLatentMs/,
  'emergency playback latency must expand the compressed video queue budget');
const observeArrival = method('observeAudioArrivalLead(timestampUs, nowPerfMs)', '\n      evaluateAdaptiveLatent(');
assert.match(observeArrival, /audioArrivalGroupStep\(/,
  'AAC tags must be reduced to one observation per sender capture group');
assert.match(observeArrival, /evaluateAdaptiveLatent\(group\.completed\.observedAtMs, true\)/,
  'only a completed capture group may advance the adaptive arrival window');
const adaptiveLatent = method('evaluateAdaptiveLatent(nowPerfMs = performance.now(), hasNewArrivalEvidence = false)', '\n      // 整体平移本地播放时间轴');
assert.ok(!html.includes('ADAPTIVE_LATENT_DEFICIT_SAMPLES'),
  'adaptive arrival reserve must not depend on a poll/sample count');
assert.match(adaptiveLatent, /audioLateWindowStep\(/,
  'adaptive arrival reserve must use elapsed arrival time');
assert.match(adaptiveLatent, /if \(!hasNewArrivalEvidence\) return;/,
  'feedback polling must not be counted as new arrival evidence');
assert.match(adaptiveLatent, /this\.adaptiveLatentDeficitWindowMs = Math\.max\([\s\S]*?deficitMs,[\s\S]*?this\.requiredAudioLeadMs\(\),[\s\S]*?sourceCadenceMs/,
  'the adaptive arrival window must be derived from measured deficit and pipeline cadence');
const enqueueOutput = method('enqueueAudioOutput(planes, outputIndex)', '\n      // FIFO 序号');
assert.match(enqueueOutput, /plan\.action === 'skip'/,
  'an isolated seconds-late PCM block must be skipped instead of pausing video');
assert.match(enqueueOutput, /audioArrivalCadenceMs\(frames, sampleRate\)/,
  'fresh-start margin must come from the measured audio arrival cadence');
const severeSkip = enqueueOutput.slice(enqueueOutput.indexOf("if (plan.action === 'skip')"));
assert.ok(!severeSkip.includes('shiftAdaptiveLatent('),
  'a severe decoded block is dropped locally instead of rebuilding the A/V timeline');
assert.ok(!html.includes('audioSevereLateWindow') && !html.includes('audioPersistentLateRebases'),
  'persistent baseline changes belong to the compressed arrival-time window only');
assert.match(html, /this\.oldestPendingAudioSubmitAt = 0;/,
  'decoder watchdog state must be initialized before the first connection');
assert.match(refreshSync, /audioArrivalCadenceP95Ms/,
  'the browser must consume server-measured audio arrival cadence');

// ---- pure helpers ----
const helpers = new Function(
  constants + '\n'
  + 'function clampNumber(value, minimum, maximum) { return Math.min(maximum, Math.max(minimum, value)); }\n'
  + slice('function audioLateWindowStep(', '    // 由 worklet 最近一次状态')
  + slice('function audioDecoderRecoveryReason(', '// ============ 视频呈现控制')
  + '\nreturn { audioArrivalGroupStep, audioDecoderRecoveryReason, retainFreshAudioInput, retainSchedulableAudioInput };',
)();

const futureAudio = [
  { timestampUs: 1_000_000 },
  { timestampUs: 1_100_000 },
  { timestampUs: 1_200_000 },
];
assert.strictEqual(helpers.retainFreshAudioInput(futureAudio, 0, 40), futureAudio,
  'fresh playback must retain all future audio even when shared alignment is large');
assert.deepStrictEqual(helpers.retainFreshAudioInput(futureAudio, 1_150_000, 40), futureAudio.slice(2),
  'fresh playback may discard only audio that has already missed the target by a full cadence');
assert.strictEqual(helpers.retainFreshAudioInput(futureAudio, Number.NaN, 40), futureAudio,
  'fresh audio must be retained until the player has a usable media clock');

let arrivalGroup = helpers.audioArrivalGroupStep({
  anchorUs: null,
  groupIndex: null,
  minLeadMs: null,
  minLeadObservedAtMs: 0,
  timestampUs: 0,
  leadMs: 100,
  observedAtMs: 1000,
  groupDurationMs: 40,
});
arrivalGroup = helpers.audioArrivalGroupStep({
  ...arrivalGroup,
  timestampUs: 21_000,
  leadMs: 80,
  observedAtMs: 1030,
  groupDurationMs: 40,
});
assert.strictEqual(arrivalGroup.completed, null,
  'multiple AAC tags from one capture group remain one observation');
arrivalGroup = helpers.audioArrivalGroupStep({
  ...arrivalGroup,
  timestampUs: 42_000,
  leadMs: 90,
  observedAtMs: 1040,
  groupDurationMs: 40,
});
assert.deepStrictEqual(arrivalGroup.completed, { leadMs: 80, observedAtMs: 1030 },
  'the completed group reports its true minimum lead and the matching arrival time');

const queued = [
  { timestampUs: 500_000 },
  { timestampUs: 749_999 },
  { timestampUs: 750_000 },
  { timestampUs: 800_000 },
];
assert.deepStrictEqual(helpers.retainSchedulableAudioInput(queued, 1_000_000), queued.slice(2),
  'audio older than the late window must not delay resumed playback');
assert.strictEqual(helpers.retainSchedulableAudioInput(queued, Number.NaN), queued,
  'audio must be retained until the player has a usable media clock');

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
  pendingAgeMs: 150,
};
assert.strictEqual(helpers.audioDecoderRecoveryReason(activeStall), 'output-stalled',
  'recent input without decoder output must recover even when decoder queues read zero');
assert.strictEqual(helpers.audioDecoderRecoveryReason({ ...activeStall, inputAgeMs: 1001 }), null,
  'a real source-side audio gap must not rebuild the decoder');
assert.strictEqual(helpers.audioDecoderRecoveryReason({ ...activeStall, bufferedSeconds: 0.2 }), null,
  'decoder recovery must wait while already queued audio remains safe');
assert.strictEqual(helpers.audioDecoderRecoveryReason({ ...activeStall, graceRemainingMs: 1 }), null,
  'a newly configured decoder must receive its output grace period');
assert.strictEqual(helpers.audioDecoderRecoveryReason({ ...activeStall, pendingAgeMs: 5 }), null,
  'an input burst right after a network gap is not a decoder stall');

// ---- worklet FIFO processor ----
const workletSource = new Function(
  slice("const AUDIO_WORKLET_PROCESSOR_NAME = 'livesuite-audio-fifo';", '// 本地音画同步控制')
  + '\nreturn AUDIO_WORKLET_SOURCE;',
)();
const registry = {};
globalThis.__livesuiteTestCurrentTime = 0;
class AudioWorkletProcessor {
  constructor() {
    this.port = { onmessage: null, posted: [], postMessage(message) { this.posted.push(message); } };
  }
}
new Function('AudioWorkletProcessor', 'registerProcessor',
  workletSource.replace(/\bcurrentTime\b/g, 'globalThis.__livesuiteTestCurrentTime'))(
  AudioWorkletProcessor, (name, processorClass) => { registry[name] = processorClass; },
);
const Processor = registry['livesuite-audio-fifo'];
assert.strictEqual(typeof Processor, 'function', 'worklet processor must register under its declared name');
const processor = new Processor();
const quantum = () => [[new Float32Array(128), new Float32Array(128)]];
processor.port.onmessage({ data: { type: 'push', frames: 100 } });
processor.port.onmessage({ data: {
  type: 'push',
  planes: [new Float32Array(300).fill(0.5), new Float32Array(300).fill(-0.5)],
  frames: 300,
} });
const rendered = [];
for (let index = 0; index < 6; index++) {
  const output = quantum();
  processor.process([], output);
  rendered.push(...output[0][0]);
  globalThis.__livesuiteTestCurrentTime += 128 / 48_000;
}
assert.ok(rendered.slice(0, 100).every((value) => value === 0), 'silence padding renders as silence');
assert.ok(rendered[100] < 0.05 && rendered[227] > 0.45 && Math.abs(rendered[300] - 0.5) < 1e-6,
  'data after silence fades in over a few milliseconds');
assert.ok(Math.abs(rendered[400]) < 0.5 && Math.abs(rendered[420]) < 0.06,
  'an underrun decays the last sample instead of cutting hard');
assert.strictEqual(processor.consumedFrames, 400);
assert.strictEqual(processor.underruns, 1, 'one audible underrun');
assert.strictEqual(processor.underrunFrames, 6 * 128 - 400);
const status = processor.port.posted.filter((message) => message.type === 'status');
assert.ok(status.length >= 0);
processor.port.onmessage({ data: {
  type: 'push',
  planes: [new Float32Array(256).fill(0.25), new Float32Array(256).fill(0.25)],
  frames: 256,
} });
processor.port.onmessage({ data: { type: 'flush' } });
assert.strictEqual(processor.queuedFrames, 0, 'flush discards queued audio');
assert.strictEqual(processor.flushes, 1);
processor.port.onmessage({ data: {
  type: 'push',
  planes: [new Float32Array(128).fill(0.5), new Float32Array(128).fill(0.5)],
  frames: 128,
} });
const afterFlush = quantum();
processor.process([], afterFlush);
assert.ok(afterFlush[0][0][0] < 0.05 && afterFlush[0][0][127] > 0.45, 'audio after a flush fades in again');
processor.port.onmessage({ data: { type: 'configure', statusInterval: 1 } });
processor.process([], quantum());
const lastStatus = processor.port.posted[processor.port.posted.length - 1];
assert.strictEqual(lastStatus.type, 'status');
for (const field of ['contextTime', 'consumedFrames', 'queuedFrames', 'underrunFrames', 'underruns', 'flushes', 'renderedFrames', 'starving']) {
  assert.ok(field in lastStatus, `status must report ${field}`);
}

console.log('Browser audio lifecycle tests passed');
