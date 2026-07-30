#!/usr/bin/env python3
"""
Plot PQ-Signal stress test results.
Reads the most recent stress_*.jsonl from ~/SignalPQBenchmarks/
Writes fig_stress_*.png to the journal paper images directory.

Usage:
    python3 scripts/plot-stress-test.py
    python3 scripts/plot-stress-test.py --log ~/SignalPQBenchmarks/stress_2026-06-14.jsonl
"""

import json
import os
import sys
import glob
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

# ── Same style as generate_figures.py ─────────────────────────────────────────
plt.rcParams.update({
    'figure.figsize': (14, 7),
    'figure.dpi': 150,
    'axes.grid': True,
    'grid.alpha': 0.25,
    'grid.color': '#cccccc',
    'lines.linewidth': 1.2,
    'lines.markersize': 3,
    'font.size': 11,
    'axes.facecolor': 'white',
    'figure.facecolor': 'white',
    'savefig.facecolor': 'white',
    'axes.edgecolor': '#333333',
    'xtick.color': '#333333',
    'ytick.color': '#333333',
    'text.color': '#333333',
    'axes.labelcolor': '#333333',
})

BENCH_DIR = os.path.expanduser('~/SignalPQBenchmarks')
OUT_DIR   = os.path.join(os.path.dirname(__file__), '../../jorurnal paper/images')
os.makedirs(OUT_DIR, exist_ok=True)

# ── Find log file ──────────────────────────────────────────────────────────────
if '--log' in sys.argv:
    log_path = sys.argv[sys.argv.index('--log') + 1]
else:
    files = sorted(glob.glob(os.path.join(BENCH_DIR, 'stress_*.jsonl')))
    if not files:
        print(f'No stress_*.jsonl found in {BENCH_DIR}. Run pq-stress-test.mjs first.')
        sys.exit(1)
    log_path = files[-1]

print(f'Reading: {log_path}')

records = []
summaries = {}
with open(log_path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
            records.append(r)
            if r.get('type') == 'PHASE_SUMMARY':
                summaries[r['phase']] = r
        except json.JSONDecodeError:
            pass

print(f'Loaded {len(records)} records, {len(summaries)} phase summaries')

# ── Split per-message records by phase ────────────────────────────────────────
def msgs(phase):
    return [r for r in records if r.get('phase') == phase and 'wrapMs' in r]

burst     = msgs('BURST')
sustained = msgs('SUSTAINED')
cb        = msgs('COMBINED_BURST')
cs        = msgs('COMBINED_SUSTAINED')

# ── Figure A: Burst — wrap latency per message ────────────────────────────────
if burst:
    fig, ax = plt.subplots()
    wrap_b   = [r['wrapMs']   for r in burst]
    unwrap_b = [r['unwrapMs'] for r in burst]
    x = range(1, len(wrap_b) + 1)

    ax.plot(x, wrap_b,   'o-', color='#E8873B', label='Wrap (send)',   markersize=2, linewidth=0.8)
    ax.plot(x, unwrap_b, 'x-', color='#4A9FD9', label='Unwrap (recv)', markersize=2, linewidth=0.8)
    ax.axhline(np.mean(wrap_b),   color='#E8873B', linestyle='--', alpha=0.5,
               label=f'Wrap avg: {np.mean(wrap_b):.2f} ms')
    ax.axhline(np.mean(unwrap_b), color='#4A9FD9', linestyle='--', alpha=0.5,
               label=f'Unwrap avg: {np.mean(unwrap_b):.2f} ms')

    ax.set_xlabel('Message index')
    ax.set_ylabel('Latency (ms)')
    ax.set_title(f'Burst stress test — per-message PQ latency (n={len(burst)})')
    ax.legend(loc='upper right')
    fig.tight_layout()
    fig.savefig(os.path.join(OUT_DIR, 'fig_stress_burst.png'))
    plt.close(fig)
    print(f'Saved fig_stress_burst.png  (wrap avg={np.mean(wrap_b):.2f}ms, unwrap avg={np.mean(unwrap_b):.2f}ms)')

# ── Figure B: Sustained — latency over time ───────────────────────────────────
if sustained:
    fig, ax = plt.subplots()
    wrap_s   = [r['wrapMs']   for r in sustained]
    unwrap_s = [r['unwrapMs'] for r in sustained]
    x = range(1, len(wrap_s) + 1)

    ax.plot(x, wrap_s,   'o-', color='#E8873B', label='Wrap (send)',   markersize=2, linewidth=0.8)
    ax.plot(x, unwrap_s, 'x-', color='#4A9FD9', label='Unwrap (recv)', markersize=2, linewidth=0.8)
    ax.axhline(np.mean(wrap_s),   color='#E8873B', linestyle='--', alpha=0.5,
               label=f'Wrap avg: {np.mean(wrap_s):.2f} ms')
    ax.axhline(np.mean(unwrap_s), color='#4A9FD9', linestyle='--', alpha=0.5,
               label=f'Unwrap avg: {np.mean(unwrap_s):.2f} ms')

    ax.set_xlabel('Message index')
    ax.set_ylabel('Latency (ms)')
    ax.set_title(f'Sustained stress test — latency stability (n={len(sustained)})')
    ax.legend(loc='upper right')
    fig.tight_layout()
    fig.savefig(os.path.join(OUT_DIR, 'fig_stress_sustained.png'))
    plt.close(fig)
    print(f'Saved fig_stress_sustained.png')

# ── Figure C: Throughput + resource bar chart (summary) ───────────────────────
if summaries:
    phases   = [p for p in ['BURST', 'SUSTAINED'] if p in summaries]
    labels   = {'BURST': 'Burst', 'SUSTAINED': 'Sustained'}

    if len(phases) >= 1:
        fig, axes = plt.subplots(1, 3, figsize=(14, 6))

        # Throughput
        thr = [summaries[p]['throughput'] for p in phases]
        axes[0].bar([labels[p] for p in phases], thr, color=['#E8873B', '#4A9FD9'], width=0.4,
                    edgecolor='#333333', linewidth=0.6)
        for i, v in enumerate(thr):
            axes[0].text(i, v + 1, f'{v:.0f}', ha='center', fontsize=10)
        axes[0].set_ylabel('Throughput (msg/s)')
        axes[0].set_title('Throughput')

        # Avg wrap p99 latency
        p99w = [summaries[p]['wrap']['p99'] for p in phases]
        axes[1].bar([labels[p] for p in phases], p99w, color=['#E8873B', '#4A9FD9'], width=0.4,
                    edgecolor='#333333', linewidth=0.6)
        for i, v in enumerate(p99w):
            axes[1].text(i, v + 0.05, f'{v:.2f} ms', ha='center', fontsize=10)
        axes[1].set_ylabel('Wrap latency p99 (ms)')
        axes[1].set_title('Wrap Latency p99')

        # Peak memory
        peakm = [summaries[p]['mem']['peak'] for p in phases]
        axes[2].bar([labels[p] for p in phases], peakm, color=['#E8873B', '#4A9FD9'], width=0.4,
                    edgecolor='#333333', linewidth=0.6)
        for i, v in enumerate(peakm):
            axes[2].text(i, v + 1, f'{v:.0f} MB', ha='center', fontsize=10)
        axes[2].set_ylabel('Peak memory RSS (MB)')
        axes[2].set_title('Peak Memory')

        fig.suptitle('Stress Test Summary: Burst vs Sustained', fontsize=13)
        fig.tight_layout()
        fig.savefig(os.path.join(OUT_DIR, 'fig_stress_summary.png'), bbox_inches='tight')
        plt.close(fig)
        print('Saved fig_stress_summary.png')

# ── Figure D: Combined — burst then sustained, latency continuity ─────────────
if cb and cs:
    fig, ax = plt.subplots()
    wrap_c   = [r['wrapMs']   for r in cb] + [r['wrapMs']   for r in cs]
    unwrap_c = [r['unwrapMs'] for r in cb] + [r['unwrapMs'] for r in cs]
    x        = range(1, len(wrap_c) + 1)
    split    = len(cb)

    ax.plot(x, wrap_c,   '-', color='#E8873B', linewidth=0.8, label='Wrap (send)')
    ax.plot(x, unwrap_c, '-', color='#4A9FD9', linewidth=0.8, label='Unwrap (recv)')
    ax.axvline(x=split, color='#888888', linestyle=':', linewidth=1.2, label='Burst → Sustained boundary')
    ax.axhline(np.mean([r['wrapMs'] for r in cb]), color='#E8873B', linestyle='--', alpha=0.4,
               label=f'Burst wrap avg: {np.mean([r["wrapMs"] for r in cb]):.2f} ms')
    ax.axhline(np.mean([r['wrapMs'] for r in cs]), color='#4A9FD9', linestyle='--', alpha=0.4,
               label=f'Sustained wrap avg: {np.mean([r["wrapMs"] for r in cs]):.2f} ms')

    ax.set_xlabel('Message index (burst then sustained)')
    ax.set_ylabel('Latency (ms)')
    ax.set_title('Combined stress test — latency across burst→sustained transition')
    ax.legend(loc='upper right')
    fig.tight_layout()
    fig.savefig(os.path.join(OUT_DIR, 'fig_stress_combined.png'))
    plt.close(fig)
    print('Saved fig_stress_combined.png')

print('\nDone.')
