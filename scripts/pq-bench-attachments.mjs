#!/usr/bin/env node
/**
 * pq-bench-attachments.mjs
 *
 * Standalone benchmark for PQ (ML-KEM-768 + AES-256-GCM) encryption overhead
 * at image-relevant payload sizes.  Runs in isolation — no Signal app needed.
 *
 * Usage:
 *   node scripts/pq-bench-attachments.mjs [--runs N] [--sizes 102400,524288,2097152]
 *
 * Output: ~/SignalPQBenchmarks/attachment_bench_<timestamp>.jsonl
 *         + a summary table printed to stdout
 */

import { randomBytes } from 'crypto';
import { performance } from 'perf_hooks';
import { appendFile, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

// ── Dynamic import of ESM-only noble libraries ──────────────────────────────
const { ml_kem768 } = await import('@noble/post-quantum/ml-kem.js');
const { gcm }       = await import('@noble/ciphers/aes.js');

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(flag, def) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : def;
}

const RUNS  = parseInt(getArg('--runs', '10'), 10);
const SIZES = (getArg('--sizes', '102400,524288,2097152'))
  .split(',')
  .map(s => parseInt(s.trim(), 10));

const SIZE_LABELS = { 102400: '100 KB', 524288: '500 KB', 2097152: '2 MB' };

// ── Output dir ───────────────────────────────────────────────────────────────
const BENCH_DIR  = join(homedir(), 'SignalPQBenchmarks');
const BENCH_FILE = join(BENCH_DIR, `attachment_bench_${Date.now()}.jsonl`);

await mkdir(BENCH_DIR, { recursive: true });

// ── PQ helpers (mirror of PQWrapper.ts logic) ────────────────────────────────
const NONCE_LEN    = 12;
const KIND_ATTACH  = 0x03;
const PQ_VERSION   = 2;

function encapsulate(theirPub) {
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(theirPub);
  return { kemCt: cipherText, sharedSecret };
}

function decapsulate(secretKey, kemCt) {
  return ml_kem768.decapsulate(kemCt, secretKey);
}

function aesEncrypt(key, nonce, plaintext) {
  return gcm(key, nonce).encrypt(plaintext);
}

function aesDecrypt(key, nonce, ciphertext) {
  return gcm(key, nonce).decrypt(ciphertext);
}

function wrap(theirPub, data) {
  const t0 = performance.now();

  const t1 = performance.now();
  const { kemCt, sharedSecret } = encapsulate(theirPub);
  const encapMs = performance.now() - t1;

  const nonce = randomBytes(NONCE_LEN);

  const t2 = performance.now();
  const encrypted = aesEncrypt(sharedSecret, nonce, data);
  const symMs = performance.now() - t2;

  const out = new Uint8Array(1 + 1 + 2 + kemCt.length + NONCE_LEN + encrypted.length);
  let o = 0;
  out[o++] = KIND_ATTACH;
  out[o++] = PQ_VERSION;
  out[o++] = (kemCt.length >> 8) & 0xff;
  out[o++] =  kemCt.length       & 0xff;
  out.set(kemCt,     o); o += kemCt.length;
  out.set(nonce,     o); o += NONCE_LEN;
  out.set(encrypted, o);

  return { wrapped: out, encapMs, symMs, totalMs: performance.now() - t0 };
}

function unwrap(secretKey, data) {
  let o = 0;
  if (data[o++] !== KIND_ATTACH) throw new Error('bad kind');
  if (data[o++] !== PQ_VERSION)  throw new Error('bad version');

  const kemLen = (data[o++] << 8) | data[o++];
  const kemCt  = data.slice(o, o + kemLen); o += kemLen;
  const nonce  = data.slice(o, o + NONCE_LEN); o += NONCE_LEN;
  const enc    = data.slice(o);

  const t0 = performance.now();

  const t1 = performance.now();
  const ss = decapsulate(secretKey, kemCt);
  const decapMs = performance.now() - t1;

  const t2 = performance.now();
  const plain = aesDecrypt(ss, nonce, enc);
  const symMs = performance.now() - t2;

  return { plain, decapMs, symMs, totalMs: performance.now() - t0 };
}

// ── Run benchmark ─────────────────────────────────────────────────────────────
console.log(`\nPQ Attachment Benchmark — ML-KEM-768 + AES-256-GCM`);
console.log(`Runs per size: ${RUNS}`);
console.log(`Output: ${BENCH_FILE}\n`);

// Pre-generate one key pair (fixed per session, as in real usage)
const { publicKey, secretKey } = ml_kem768.keygen();

const summary = [];

for (const size of SIZES) {
  const label = SIZE_LABELS[size] ?? `${(size / 1024).toFixed(0)} KB`;
  const wrapTimes  = [];
  const unwrapTimes = [];
  const encapTimes  = [];
  const decapTimes  = [];
  const symEncTimes = [];
  const symDecTimes = [];

  process.stdout.write(`  ${label.padEnd(8)}`);

  for (let i = 0; i < RUNS; i++) {
    const payload = randomBytes(size);

    // --- WRAP ---
    const { wrapped, encapMs, symMs: symEncMs, totalMs: wrapMs } =
      wrap(publicKey, payload);

    // --- UNWRAP ---
    const { plain, decapMs, symMs: symDecMs, totalMs: unwrapMs } =
      unwrap(secretKey, wrapped);

    // Verify correctness
    if (plain.length !== payload.length) {
      throw new Error(`Round-trip mismatch at ${label}, run ${i}`);
    }

    wrapTimes.push(wrapMs);
    unwrapTimes.push(unwrapMs);
    encapTimes.push(encapMs);
    decapTimes.push(decapMs);
    symEncTimes.push(symEncMs);
    symDecTimes.push(symDecMs);

    const record = {
      ts: Date.now(),
      side: i % 2 === 0 ? 'send' : 'recv',
      stage: 'PQ_ATTACH_BENCH',
      values: {
        sizeLabel: label,
        sizeBytes: size,
        run: i,
        pqEncapsulateMs:      +encapMs.toFixed(3),
        pqSymmetricEncryptMs: +symEncMs.toFixed(3),
        pqTotalWrapMs:        +wrapMs.toFixed(3),
        pqDecapsulateMs:      +decapMs.toFixed(3),
        pqSymmetricDecryptMs: +symDecMs.toFixed(3),
        pqTotalUnwrapMs:      +unwrapMs.toFixed(3),
        wrappedLen: wrapped.length,
        plainLen:   payload.length,
      },
    };
    await appendFile(BENCH_FILE, JSON.stringify(record) + '\n', 'utf8');
    process.stdout.write('.');
  }

  console.log();

  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const min = arr => Math.min(...arr);
  const max = arr => Math.max(...arr);

  summary.push({
    label,
    sizeBytes: size,
    encapAvg:   avg(encapTimes),
    symEncAvg:  avg(symEncTimes),
    wrapAvg:    avg(wrapTimes),
    decapAvg:   avg(decapTimes),
    symDecAvg:  avg(symDecTimes),
    unwrapAvg:  avg(unwrapTimes),
    wrapMin:    min(wrapTimes),
    wrapMax:    max(wrapTimes),
    unwrapMin:  min(unwrapTimes),
    unwrapMax:  max(unwrapTimes),
  });
}

// ── Print summary table ───────────────────────────────────────────────────────
console.log('\n┌──────────┬───────────┬──────────┬───────────┬──────────┬───────────┐');
console.log('│  Size    │ KEM Encap │ AES Enc  │ Total Wrap│ KEM Decap│ Total Unwrap│');
console.log('├──────────┼───────────┼──────────┼───────────┼──────────┼───────────┤');
for (const r of summary) {
  const f = n => n.toFixed(2).padStart(7);
  console.log(
    `│ ${r.label.padEnd(8)} │${f(r.encapAvg)} ms │${f(r.symEncAvg)} ms │${f(r.wrapAvg)} ms │${f(r.decapAvg)} ms │${f(r.unwrapAvg)} ms    │`
  );
}
console.log('└──────────┴───────────┴──────────┴───────────┴──────────┴───────────┘');
console.log('(all times: avg over', RUNS, 'runs)\n');

// ── Write CSV for plotting ────────────────────────────────────────────────────
const csvPath = join(BENCH_DIR, `attachment_bench_summary_${Date.now()}.csv`);
const csvLines = [
  'size_label,size_bytes,kem_encap_ms,aes_enc_ms,total_wrap_ms,kem_decap_ms,aes_dec_ms,total_unwrap_ms,wrap_min_ms,wrap_max_ms,unwrap_min_ms,unwrap_max_ms',
  ...summary.map(r =>
    [
      r.label, r.sizeBytes,
      r.encapAvg.toFixed(3), r.symEncAvg.toFixed(3), r.wrapAvg.toFixed(3),
      r.decapAvg.toFixed(3), r.symDecAvg.toFixed(3), r.unwrapAvg.toFixed(3),
      r.wrapMin.toFixed(3),  r.wrapMax.toFixed(3),
      r.unwrapMin.toFixed(3),r.unwrapMax.toFixed(3),
    ].join(',')
  ),
];
await writeFile(csvPath, csvLines.join('\n') + '\n', 'utf8');
console.log(`CSV summary written to: ${csvPath}`);
