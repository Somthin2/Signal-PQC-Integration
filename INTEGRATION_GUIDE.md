# Integration Guide

This walks through adding the PQ encryption layer to a fresh Signal Desktop checkout. I wrote this after getting the integration working myself, so these are the actual steps rather than guesswork.

Expect about 20–30 minutes if you've built Signal Desktop before, longer if it's your first time getting the build environment set up.

---

## Prerequisites

- **Node.js v20+** — Signal's build toolchain requires this. I used v20.18.0.
- **pnpm** — Signal uses pnpm, not npm or yarn. Install with `npm install -g pnpm`.
- **Git**
- **Python 3.8+** — only needed for the analysis script, not the integration itself
- **macOS** (tested) or Linux. The shared-key filesystem trick uses `~/SignalPQSharedKeys/` which works on both. Windows paths would need adjusting in `pqSharedDir.ts`.

---

## Step 1: Get Signal Desktop v7.81.0

```bash
git clone https://github.com/signalapp/Signal-Desktop.git
cd Signal-Desktop
git checkout v7.81.0
```

Don't use main — Signal's main branch moves fast and the file structure may have changed. This integration was developed and tested against v7.81.0 specifically.

Install dependencies (takes a few minutes the first time):

```bash
pnpm install
```

---

## Step 2: Install the PQ crypto libraries

```bash
pnpm add @noble/post-quantum @noble/ciphers
```

Both are ESM-only packages. The imports in `PQWrapper.ts` use the `.js` extension explicitly (`ml-kem.js`, `aes.js`) because that's what the noble packages expect in their module exports.

---

## Step 3: Copy the modified files

The files below go into `ts/textsecure/` in your Signal Desktop checkout. Copy them from the `modified_files/` directory in this repo:

| File from this repo | Destination in Signal Desktop |
|---------------------|-------------------------------|
| `modified_files/PQWrapper.ts` | `ts/textsecure/PQWrapper.ts` |
| `modified_files/OutgoingMessage.preload.ts` | `ts/textsecure/OutgoingMessage.preload.ts` |
| `modified_files/MessageReceiver.preload.ts` | `ts/textsecure/MessageReceiver.preload.ts` |
| `modified_files/pqBenchmarkLogger.ts` | `ts/textsecure/pqBenchmarkLogger.ts` |

You'll also need to create `pqSharedDir.ts` — it's a small utility module:

```bash
# From the Signal-Desktop root directory
cat > ts/textsecure/pqSharedDir.ts << 'EOF'
import os from 'os';
import path from 'path';

export const PQ_SHARED_DIR =
  process.env.SIGNAL_PQ_SHARED_DIR ??
  path.join(os.homedir(), 'SignalPQSharedKeys');

export function sanitizeServiceId(serviceId: string): string {
  return String(serviceId)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '_');
}

export function keyPathForServiceId(serviceId: string): string {
  const safe = sanitizeServiceId(serviceId);
  return path.join(PQ_SHARED_DIR, `${safe}.mlkem1184.pub`);
}
EOF
```

---

## Step 4: Build Signal

```bash
pnpm run build:esbuild
```

This is the fast build step that transpiles TypeScript. You need to run this every time you change a `.ts` file. The full `pnpm run build` takes much longer and is only needed for packaging.

If the build fails with import errors on the noble packages, check that the `.js` extensions in the import statements match exactly:

```typescript
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { gcm } from '@noble/ciphers/aes.js';
```

---

## Step 5: Set up two test instances

Signal Desktop uses `NODE_APP_INSTANCE` to run multiple isolated instances with separate data directories. You'll need two terminal windows.

**Terminal 1 (Alice):**
```bash
NODE_APP_INSTANCE=alice pnpm start
```

**Terminal 2 (Bob):**
```bash
NODE_APP_INSTANCE=bob pnpm start
```

Each instance will register a separate account. You need real phone numbers for this — Signal's registration requires SMS verification. Once both accounts are registered and you've added each other as contacts, you're ready.

### Linking to your phone (optional)

If you already use Signal on your phone, you can link the desktop app as a secondary device instead of registering a new number. The Alice/Bob approach is cleaner for testing because you can observe both sides.

---

## Step 6: Verify PQ is working

After sending a message from Alice to Bob, check the console output in each terminal. You should see log lines like:

```
[PQ][SEND] sealedSender=false serviceId=<bob's serviceId>
[TIMING][SEND][PREP] { pqMode: 'pq', encodeMs: ..., pqWrapMs: ..., ... }
```

The first message to a new contact will show `pqMode: 'handshake+plaintext'` — that's the key exchange. After the handshake, subsequent messages will show `pqMode: 'pq'`.

Benchmark logs are written to `~/SignalPQBenchmarks/`:
- `pq_bench_pq.log` — JSONL records when `PQ_ENABLED = true`
- `pq_bench_plain.log` — JSONL records when `PQ_ENABLED = false`

---

## Step 7: Running benchmarks

### Standalone attachment benchmark

This runs the PQ crypto code in isolation without needing Signal running. It tests at 100 KB, 500 KB, and 2 MB by default:

```bash
node scripts/pq-bench-attachments.mjs --runs 18 --sizes 102400,524288,2097152
```

You should see output like:

```
PQ Attachment Benchmark — ML-KEM-768 + AES-256-GCM
Runs per size: 18
Output: /Users/<you>/SignalPQBenchmarks/attachment_bench_<timestamp>.jsonl

  100 KB  ..................
  500 KB  ..................
  2 MB    ..................

┌──────────┬───────────┬──────────┬───────────┬──────────┬───────────┐
│  Size    │ KEM Encap │ AES Enc  │ Total Wrap│ KEM Decap│ Total Unwrap│
├──────────┼───────────┼──────────┼───────────┼──────────┼───────────┤
│ 100 KB   │   0.72 ms │   2.68 ms│   3.42 ms │   0.68 ms│   3.05 ms   │
...
```

### Generating test images

To create PNG files at the target sizes for sending through the actual Signal UI:

```bash
chmod +x scripts/create-test-images.sh
./scripts/create-test-images.sh ./test-images
```

This creates `test_100kb.png`, `test_500kb.png`, `test_2mb.png`, and `test_5mb.png` in `./test-images/`.

### Analysing benchmark logs

```bash
python3 scripts/analyze-pq-bench.py --dir ~/SignalPQBenchmarks --out ./results
```

This reads all `.jsonl` and `.log` files from the benchmark directory and prints summary statistics. It also writes a CSV for the attachment size breakdown.

---

## Toggling PQ on/off

To collect baseline (non-PQ) measurements, open `ts/textsecure/PQWrapper.ts` and change:

```typescript
export const PQ_ENABLED = true;
```

to:

```typescript
export const PQ_ENABLED = false;
```

Then rebuild:

```bash
pnpm run build:esbuild
```

When `PQ_ENABLED = false`, `wrapOutgoing` and `unwrapIncoming` are passthroughs — zero overhead. Benchmark logs go to `pq_bench_plain.log` instead.

---

## How key exchange works

When instance A sends its first message to instance B:

1. A checks `~/SignalPQSharedKeys/<b_service_id>.mlkem1184.pub` — doesn't exist yet
2. A sends a handshake message: `[0x01][A's 1184-byte ML-KEM-768 public key][plaintext]`
3. B receives it, extracts A's public key, stores it in memory
4. B writes its own public key to `~/SignalPQSharedKeys/<b_service_id>.mlkem1184.pub` at startup
5. A's next send checks the shared dir, finds B's key, switches to PQ-encrypted format

Both instances write their public keys to the shared directory on startup (once they know their serviceId). The handshake is a fallback for the first message before B's key is loaded.

This shared-filesystem approach only works for local testing. A real deployment would need a proper key distribution mechanism — that's intentionally out of scope for this project, which focuses on the crypto layer itself.

---

## Troubleshooting

**Build fails with "Cannot find module '@noble/post-quantum/ml-kem.js'"**  
Run `pnpm add @noble/post-quantum @noble/ciphers` in the Signal Desktop root. If it still fails, check that your pnpm version is at least 8.x.

**Messages send but PQ isn't activating (pqMode stays 'handshake+plaintext')**  
The handshake path means the receiver's public key isn't loaded yet. Check that:
- Both instances have been running long enough to write their keys to `~/SignalPQSharedKeys/`
- The serviceIds match what's being written (check the log output for `setOurServiceId`)
- You've sent at least one message in each direction

**"Missing PQ secret key" error on receive**  
The `PQCrypto` instance hasn't been initialized yet. This can happen if `initPQ()` is called before the instance is fully constructed. Check that `pqCrypto.initPQ()` isn't being awaited in a cold code path.

**Benchmark logs are empty**  
Check that `~/SignalPQBenchmarks/` exists and is writable. The logger creates it automatically but can fail silently (by design — we don't want benchmark logging to break messaging). Set `BENCH_ENABLED = true` in `pqBenchmarkLogger.ts` if you're not sure.

**Two instances show the same account**  
You're missing the `NODE_APP_INSTANCE` environment variable. Each instance needs a unique value to use a separate data directory.
