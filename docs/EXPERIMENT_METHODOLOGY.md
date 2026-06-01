# Experiment Methodology

This document describes how the benchmarks in this project were set up and run. I'm writing this partly so the results are reproducible, and partly so the numbers in the thesis make sense without needing to dig through code.

---

## Hardware and software

All measurements were taken on a single machine — no cloud, no VMs:

- **CPU:** Apple M4 Pro (12-core, 4 performance + 4 efficiency + 4 GPU; 38 TOPS NPU but not used here)
- **RAM:** 24 GB unified memory
- **OS:** macOS 26.4 (Tahoe)
- **Runtime:** Node.js v20.18.0 (V8 engine, JIT-compiled)
- **Signal Desktop:** v7.81.0 (Electron-based)

The M4 Pro has hardware AES acceleration via ARM Cryptography Extensions, which affects the AES-GCM timings. The noble/ciphers library does use this where available, so the symmetric encryption numbers here will be faster than on a pure software implementation.

---

## What was measured

There are two distinct sets of measurements:

### 1. Standalone attachment benchmark (`pq-bench-attachments.mjs`)

This runs the PQ crypto code in complete isolation — no Electron, no Signal protocol, no IPC. It directly calls the same `ml_kem768` and `gcm` functions that `PQWrapper.ts` uses, at controlled payload sizes.

**Sizes:** 100 KB (102,400 bytes), 500 KB (524,288 bytes), 2 MB (2,097,152 bytes)  
**Runs per size:** n=18  
**Metric:** wall-clock time in milliseconds using `performance.now()` (sub-millisecond resolution)

Each run measures:
- KEM encapsulation time (`ml_kem768.encapsulate`)
- AES-256-GCM encryption time (`gcm.encrypt`)
- Total wrap time (encap + encrypt + header assembly)
- KEM decapsulation time (`ml_kem768.decapsulate`)
- AES-256-GCM decryption + authentication time (`gcm.decrypt`)
- Total unwrap time

A fresh ML-KEM-768 key pair is generated once per session (not per run), matching how it works in the actual application.

### 2. In-app text message benchmark (`pq_bench_pq.log` / `pq_bench_plain.log`)

These measurements come from instrumentation inside `OutgoingMessage.preload.ts` and `PQWrapper.ts`, running during actual message sends between two local Signal Desktop instances. The timings here include the full context of the Electron process — IPC overhead, event loop contention, etc.

Stages logged:
- `PQ_SEND` — KEM encap + AES encrypt, inside `wrapOutgoing()`
- `PQ_RECV` — KEM decap + AES decrypt, inside `unwrapIncoming()`
- `SEND_PREP` — total plaintext preparation (proto encode + PQ wrap + padding)
- `SIGNAL_SEND` — time for `signalEncrypt()` to run after plaintext is ready

---

## ML-KEM-768 parameters

| Parameter | Value |
|-----------|-------|
| Algorithm | ML-KEM-768 (CRYSTALS-Kyber, FIPS 203 variant) |
| Public key size | 1,184 bytes |
| Secret key size | 2,400 bytes |
| Ciphertext size (KEM output) | 1,088 bytes |
| Shared secret size | 32 bytes |
| Security level | NIST Level 3 (~192-bit classical equivalent) |

The shared secret (32 bytes) is used directly as the AES-256 key. No KDF is applied on top — the shared secret from ML-KEM-768 is already suitable as a symmetric key per the FIPS 203 spec.

AES-256-GCM parameters:
- Nonce: 12 bytes, randomly generated per message
- Authentication tag: 16 bytes (appended to ciphertext by noble/ciphers)

---

## Measurement methodology

### Timing

I used `performance.now()` from Node's `perf_hooks` module, which has microsecond resolution on V8. Times are recorded immediately before and after each operation, with as little code as possible between the two calls.

For the standalone benchmark, the first run in each size category tends to be slower due to JIT warmup. I included all n=18 runs in the averages rather than discarding the first one, on the grounds that the first message in a real session also experiences this warmup cost.

### Correctness verification

After each wrap/unwrap pair in the benchmark, I verify that `plain.length === payload.length`. This doesn't guarantee bit-perfect correctness (AES-GCM would throw on authentication failure anyway) but it catches obvious serialization bugs. I did a manual hex comparison on a few samples early in development to confirm round-trips correctly.

### Baseline comparison

To measure PQ overhead specifically, I ran the same message flow with `PQ_ENABLED = false` in `PQWrapper.ts`. In this mode, `wrapOutgoing` and `unwrapIncoming` return the input unchanged — exact same code paths except the crypto operations are skipped.

---

## Key findings

**KEM cost is nearly constant:** ML-KEM-768 encapsulation/decapsulation takes about 0.3–0.7 ms regardless of payload size. This makes sense — the KEM only operates on a 32-byte seed, not the payload itself.

**AES-GCM scales linearly:** At 100 KB the symmetric encrypt takes ~2.7 ms; at 2 MB it's ~21.3 ms. This is roughly linear as expected (O(n) in plaintext size).

**Total overhead is acceptable for the use case:** For text messages (typically a few hundred bytes), the total PQ wrap is well under 1 ms. For a 2 MB image attachment, it adds about 22 ms per direction — roughly a 2% overhead on a typical attachment upload/download cycle.

**Text message overhead dominates from KEM, not AES:** For small payloads, the KEM encap (0.7 ms) is actually the bigger component. This is an interesting inversion from the attachment case.

---

## Limitations and caveats

**Local test only:** The key exchange mechanism uses the filesystem to share public keys between instances. This is a testing convenience, not a production key distribution scheme. In a real deployment, ML-KEM-768 public keys would need to be distributed through Signal's key server alongside the existing identity keys.

**Single machine:** All measurements were taken on the same M4 Pro. Network latency, different CPU architectures (especially x86-64 without hardware AES), and different memory configurations will give different numbers.

**V8 JIT effects:** Node.js performance can vary between runs as the JIT compiler warms up. The n=18 sample size is enough to get stable averages but probably not enough to characterize the tail distribution well.

**Not a security audit:** The implementation follows the ML-KEM-768 spec and uses well-audited libraries (noble), but has not been independently audited. Treat this as a research prototype.
