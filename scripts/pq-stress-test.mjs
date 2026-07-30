#!/usr/bin/env node
/**
 * PQ-Signal Stress Test
 * ---------------------
 * Three phases:
 *   1. Burst  — 1000 messages as fast as possible
 *   2. Sustained — steady 10 msg/s for 60 seconds
 *   3. Combined — burst immediately followed by sustained
 *
 * Measures per-message wrap/unwrap latency, throughput (msg/s),
 * memory RSS growth, and CPU usage at 1-second intervals.
 *
 * Usage (from Signal-Desktop/):
 *   node scripts/pq-stress-test.mjs
 *   node scripts/pq-stress-test.mjs --burst-n 500 --sustained-rate 5 --sustained-secs 30
 *
 * Output: ~/SignalPQBenchmarks/stress_<timestamp>.jsonl
 */

import { randomBytes } from 'crypto';
import { performance } from 'perf_hooks';
import { appendFile, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { gcm } from '@noble/ciphers/aes.js';

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 ? Number(args[i + 1]) : def;
};
const BURST_N          = getArg('--burst-n',         1000);
const SUSTAINED_RATE   = getArg('--sustained-rate',    10);   // msg/s
const SUSTAINED_SECS   = getArg('--sustained-secs',    60);
const MSG_SIZE_BYTES   = getArg('--msg-bytes',          60);   // typical protobuf text msg

const BENCH_DIR  = join(process.env.HOME, 'SignalPQBenchmarks');
const TIMESTAMP  = new Date().toISOString().replace(/[:.]/g, '-');
const LOG_FILE   = join(BENCH_DIR, `stress_${TIMESTAMP}.jsonl`);
const NONCE_LEN  = 12;

// ── Helpers ──────────────────────────────────────────────────────────────────
async function ensureDir() {
  await mkdir(BENCH_DIR, { recursive: true });
}

async function log(record) {
  await appendFile(LOG_FILE, JSON.stringify(record) + '\n', 'utf8');
}

function wrap(theirPub, plaintext) {
  const t0 = performance.now();

  const tK0 = performance.now();
  const { cipherText: kemCt, sharedSecret } = ml_kem768.encapsulate(theirPub);
  const kemMs = +(performance.now() - tK0).toFixed(3);

  const nonce = randomBytes(NONCE_LEN);

  const tA0 = performance.now();
  const encrypted = gcm(sharedSecret, nonce).encrypt(plaintext);
  const aesMs = +(performance.now() - tA0).toFixed(3);

  const out = new Uint8Array(1 + 1 + 2 + kemCt.length + nonce.length + encrypted.length);
  let o = 0;
  out[o++] = 0x02; out[o++] = 0x02;
  out[o++] = (kemCt.length >> 8) & 0xff; out[o++] = kemCt.length & 0xff;
  out.set(kemCt, o); o += kemCt.length;
  out.set(nonce, o); o += nonce.length;
  out.set(encrypted, o);

  const totalMs = +(performance.now() - t0).toFixed(3);
  return { out, kemMs, aesMs, totalMs };
}

function unwrap(ourSecretKey, ciphertext) {
  const t0 = performance.now();

  let offset = 2; // skip kind + version
  const kemLen = (ciphertext[offset++] << 8) | ciphertext[offset++];
  const kemCt  = ciphertext.slice(offset, offset + kemLen); offset += kemLen;
  const nonce  = ciphertext.slice(offset, offset + NONCE_LEN); offset += NONCE_LEN;
  const enc    = ciphertext.slice(offset);

  const tK0 = performance.now();
  const sharedSecret = ml_kem768.decapsulate(kemCt, ourSecretKey);
  const kemMs = +(performance.now() - tK0).toFixed(3);

  const tA0 = performance.now();
  const plain = gcm(sharedSecret, nonce).decrypt(enc);
  const aesMs = +(performance.now() - tA0).toFixed(3);

  const totalMs = +(performance.now() - t0).toFixed(3);
  return { plain, kemMs, aesMs, totalMs };
}

function memMB() {
  return +(process.memoryUsage().rss / 1024 / 1024).toFixed(2);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Resource sampler ─────────────────────────────────────────────────────────
class ResourceSampler {
  constructor(phase) {
    this.phase    = phase;
    this.samples  = [];
    this._timer   = null;
    this._cpuPrev = process.cpuUsage();
    this._tPrev   = Date.now();
  }

  start() {
    this._timer = setInterval(() => {
      const now      = Date.now();
      const cpuNow   = process.cpuUsage();
      const elapsed  = (now - this._tPrev) / 1000;
      const userMs   = (cpuNow.user   - this._cpuPrev.user)   / 1000;
      const sysMs    = (cpuNow.system - this._cpuPrev.system) / 1000;
      const cpuPct   = +((userMs + sysMs) / elapsed / 10).toFixed(2); // approx %
      this._cpuPrev  = cpuNow;
      this._tPrev    = now;
      this.samples.push({ ts: now, cpuPct, memMB: memMB() });
    }, 1000);
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  summary() {
    if (!this.samples.length) return { avgCpuPct: 0, peakCpuPct: 0, avgMemMB: 0, peakMemMB: 0 };
    const cpus = this.samples.map(s => s.cpuPct);
    const mems = this.samples.map(s => s.memMB);
    return {
      avgCpuPct:  +(cpus.reduce((a, b) => a + b, 0) / cpus.length).toFixed(2),
      peakCpuPct: +Math.max(...cpus).toFixed(2),
      avgMemMB:   +(mems.reduce((a, b) => a + b, 0) / mems.length).toFixed(2),
      peakMemMB:  +Math.max(...mems).toFixed(2),
      samples:    this.samples,
    };
  }
}

// ── Phase runner ─────────────────────────────────────────────────────────────
async function runPhase(phase, { alicePub, aliceSk, bobPub, bobSk }, n, rateHz = 0) {
  console.log(`\n▶  Phase: ${phase}  (n=${n}, rate=${rateHz || 'max'} msg/s)`);

  const sampler = new ResourceSampler(phase);
  sampler.start();

  const plaintext  = randomBytes(MSG_SIZE_BYTES);
  const wrapMs     = [];
  const unwrapMs   = [];
  const kemEncMs   = [];
  const kemDecMs   = [];

  const phaseStart = performance.now();
  const intervalMs = rateHz > 0 ? 1000 / rateHz : 0;

  for (let i = 0; i < n; i++) {
    const loopStart = performance.now();

    // Alice wraps → Bob unwraps
    const w = wrap(bobPub, plaintext);
    const u = unwrap(bobSk, w.out);

    wrapMs.push(w.totalMs);
    unwrapMs.push(u.totalMs);
    kemEncMs.push(w.kemMs);
    kemDecMs.push(u.kemMs);

    await log({
      ts: Date.now(), phase, i,
      wrapMs: w.totalMs, unwrapMs: u.totalMs,
      kemEncMs: w.kemMs, kemDecMs: u.kemMs,
      aesEncMs: w.aesMs, aesDecMs: u.aesMs,
      memMB: memMB(),
    });

    if (rateHz > 0) {
      const elapsed = performance.now() - loopStart;
      const wait    = intervalMs - elapsed;
      if (wait > 0) await sleep(wait);
    }
  }

  const totalMs    = +(performance.now() - phaseStart).toFixed(1);
  const throughput = +(n / (totalMs / 1000)).toFixed(1);

  sampler.stop();
  const res = sampler.summary();

  const avg   = arr => +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(3);
  const p99   = arr => { const s = [...arr].sort((a,b) => a-b); return +s[Math.floor(s.length*0.99)].toFixed(3); };
  const pMax  = arr => +Math.max(...arr).toFixed(3);

  const summary = {
    phase, n, totalMs, throughput,
    wrap:   { avg: avg(wrapMs),   p99: p99(wrapMs),   max: pMax(wrapMs)   },
    unwrap: { avg: avg(unwrapMs), p99: p99(unwrapMs), max: pMax(unwrapMs) },
    kemEnc: { avg: avg(kemEncMs), p99: p99(kemEncMs)  },
    kemDec: { avg: avg(kemDecMs), p99: p99(kemDecMs)  },
    cpu:    { avg: res.avgCpuPct,  peak: res.peakCpuPct },
    mem:    { avg: res.avgMemMB,   peak: res.peakMemMB  },
  };

  console.log(`   Done in ${totalMs}ms  →  ${throughput} msg/s`);
  console.log(`   Wrap  avg=${summary.wrap.avg}ms  p99=${summary.wrap.p99}ms  max=${summary.wrap.max}ms`);
  console.log(`   Unwrap avg=${summary.unwrap.avg}ms  p99=${summary.unwrap.p99}ms  max=${summary.unwrap.max}ms`);
  console.log(`   CPU avg=${res.avgCpuPct}%  peak=${res.peakCpuPct}%  |  RAM avg=${res.avgMemMB}MB  peak=${res.peakMemMB}MB`);

  await log({ ts: Date.now(), type: 'PHASE_SUMMARY', ...summary });
  return summary;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  await ensureDir();
  console.log('PQ-Signal Stress Test');
  console.log(`Log → ${LOG_FILE}`);
  console.log(`Config: burst=${BURST_N} msgs, sustained=${SUSTAINED_RATE} msg/s × ${SUSTAINED_SECS}s, msgSize=${MSG_SIZE_BYTES}B`);

  // Generate one key pair per "peer"
  console.log('\nGenerating ML-KEM-768 key pairs...');
  const alice = ml_kem768.keygen();
  const bob   = ml_kem768.keygen();
  const peers = { alicePub: alice.publicKey, aliceSk: alice.secretKey,
                  bobPub:   bob.publicKey,   bobSk:   bob.secretKey };
  console.log('  Key pairs ready.');

  await log({ ts: Date.now(), type: 'CONFIG',
    burstN: BURST_N, sustainedRate: SUSTAINED_RATE,
    sustainedSecs: SUSTAINED_SECS, msgSizeBytes: MSG_SIZE_BYTES });

  const results = {};

  // Phase 1: Burst
  results.burst = await runPhase('BURST', peers, BURST_N, 0);

  // Phase 2: Sustained
  results.sustained = await runPhase('SUSTAINED', peers, SUSTAINED_RATE * SUSTAINED_SECS, SUSTAINED_RATE);

  // Phase 3: Combined (burst then sustained back-to-back)
  console.log('\n▶  Phase: COMBINED (burst + sustained, no pause)');
  const combinedStart = performance.now();
  const b = await runPhase('COMBINED_BURST',     peers, BURST_N,                     0);
  const s = await runPhase('COMBINED_SUSTAINED', peers, SUSTAINED_RATE * SUSTAINED_SECS, SUSTAINED_RATE);
  results.combined = {
    phase: 'COMBINED',
    totalMs: +(performance.now() - combinedStart).toFixed(1),
    burst: b, sustained: s,
  };

  // Final summary
  await log({ ts: Date.now(), type: 'FINAL_SUMMARY', results });
  console.log('\n✓ Stress test complete. Results saved to:');
  console.log(`  ${LOG_FILE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
