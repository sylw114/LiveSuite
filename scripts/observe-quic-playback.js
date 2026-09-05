// Read-only sampling of the receiver clock and playback feedback diagnostics.
// node scripts/observe-quic-playback.js [base URL] [seconds] [JSONL output path]
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

async function observe() {
  const base = new URL(process.argv[2] || 'http://127.0.0.1:8080');
  const seconds = Number(process.argv[3] || 60);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('Duration must be positive seconds');
  const output = path.resolve(process.argv[4]
    || path.join('tmp-quic-playback-observation', `sync-${Date.now()}.jsonl`));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  console.log(`Playback observations: ${output}`);
  const deadline = performance.now() + seconds * 1000;
  let previous = null;
  let samples = 0;
  let rebufferEvents = 0;
  let failures = 0;
  let maxActualDelayMs = 0;
  let maxExcessDelayMs = 0;
  while (performance.now() < deadline) {
    const startedAt = performance.now();
    try {
      const response = await fetch(new URL('/livesuite/sync-info', base),
        { signal: AbortSignal.timeout(2500), cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const info = await response.json();
      fs.appendFileSync(output, JSON.stringify({ observedAtMs: Date.now(), ...info }) + '\n');
      const clock = info.sharedPlaybackClock;
      if (!clock) {
        if (samples === 0) console.log('Shared playback clock is inactive.');
      } else {
        const actualMs = clock.anchorServerMs - clock.anchorPositionUs / 1000;
        const targetMs = clock.alignmentDelayMs;
        const heldMs = previous && previous.id === clock.id
          ? Math.max(0, clock.rebufferedUs - previous.rebufferedUs) / 1000 : 0;
        const recovered = previous && (clock.startupRecoveryRevision !== previous.startupRecoveryRevision
          || clock.stalledRecoveryRevision !== previous.stalledRecoveryRevision);
        maxActualDelayMs = Math.max(maxActualDelayMs, actualMs);
        maxExcessDelayMs = Math.max(maxExcessDelayMs, actualMs - targetMs);
        if (heldMs > 0) rebufferEvents++;
        if (samples === 0 || heldMs > 0 || recovered
          || Math.abs(targetMs - (previous?.alignmentDelayMs ?? targetMs)) >= 100) {
          console.log(JSON.stringify({ sample: samples, actualDelayMs: Math.round(actualMs),
            targetDelayMs: Math.round(targetMs), sourceDelayMs: info.sourceAlignmentDelayMs,
            addedHoldMs: Math.round(heldMs), recovered: Boolean(recovered), rate: clock.playbackRate,
            lastRebuffer: heldMs > 0 ? info.playbackDiagnostics?.lastRebuffer ?? 'Receiver update needed for trigger details' : undefined }));
        }
        previous = clock;
      }
      samples++;
    } catch (error) {
      failures++;
      console.error(`Playback observation failed: ${error.message}`);
      fs.appendFileSync(output, JSON.stringify({ observedAtMs: Date.now(), error: error.message }) + '\n');
    }
    const remainingMs = Math.min(1000 - (performance.now() - startedAt), deadline - performance.now());
    if (remainingMs > 0) await delay(remainingMs);
  }
  console.log(JSON.stringify({ samples, failures, rebufferEvents,
    maxActualDelayMs: Math.round(maxActualDelayMs), maxExcessDelayMs: Math.round(maxExcessDelayMs), output }));
  if (failures > 0) process.exitCode = 1;
}

observe().catch((error) => { console.error(error.message); process.exitCode = 1; });
