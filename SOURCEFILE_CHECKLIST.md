# Source File Checklist

All files copied from `~/Desktop/FYP/Signal-Desktop/` on 2026-06-01.

---

## Modified source files (`modified_files/`)

| File | Source path | Size |
|------|-------------|------|
| `PQWrapper.ts` | `ts/textsecure/PQWrapper.ts` | 17 KB |
| `OutgoingMessage.preload.ts` | `ts/textsecure/OutgoingMessage.preload.ts` | 25 KB |
| `MessageReceiver.preload.ts` | `ts/textsecure/MessageReceiver.preload.ts` | 124 KB |
| `pqBenchmarkLogger.ts` | `ts/textsecure/pqBenchmarkLogger.ts` | 1.0 KB |

**Note:** `MessageReceiver.preload.ts` is the full original Signal file with PQ unwrap calls added at the relevant decode points. The large size is expected — it handles all incoming message types (data messages, sync messages, calls, stories, etc.).

---

## Benchmark scripts (`scripts/`)

| File | Source path | Size |
|------|-------------|------|
| `pq-bench-attachments.mjs` | `scripts/pq-bench-attachments.mjs` | 8.7 KB |
| `create-test-images.sh` | `scripts/create-test-images.sh` | 2.8 KB |
| `analyze-pq-bench.py` | `scripts/analyze-pq-bench.py` | 6.3 KB |

---

## Results (`results/`)

| File | Source path | Size |
|------|-------------|------|
| `attachment_benchmark.csv` | `~/SignalPQBenchmarks/attachment_bench_summary_1780223742725.csv` | 381 B |

CSV contents (n=6 runs per size, from the final benchmark session):

```
size_label,size_bytes,kem_encap_ms,aes_enc_ms,total_wrap_ms,kem_decap_ms,aes_dec_ms,total_unwrap_ms
100 KB,102400,0.720,2.681,3.416,0.678,2.368,3.049
500 KB,524288,0.364,5.545,5.936,0.383,5.593,5.979
2 MB,2097152,0.316,21.330,21.755,0.394,21.443,21.839
```

---

## Documentation (`docs/` and root)

| File | Size | Description |
|------|------|-------------|
| `README.md` | 5.1 KB | Project overview, results summary, quick start |
| `INTEGRATION_GUIDE.md` | 9.0 KB | Step-by-step integration instructions |
| `docs/EXPERIMENT_METHODOLOGY.md` | 6.1 KB | Hardware setup, measurement methodology, findings |

---

## Files NOT copied (intentionally excluded)

- `pqSharedDir.ts` — small utility, reproduced inline in `INTEGRATION_GUIDE.md` as a one-liner since it has no project-specific logic
- `*.js` compiled outputs — these are build artefacts, not source files
- `.log` and `.jsonl` benchmark raw data — too large for the repo; only the CSV summary is included
- `test-images/` — generated files, reproducible with `create-test-images.sh`
- `bench-results/graphs/` — machine-generated plots
- `energy-monitor.sh`, `energy-power.sh` — energy monitoring scripts not directly related to the PQ crypto layer
