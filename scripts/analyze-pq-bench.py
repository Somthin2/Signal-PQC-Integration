#!/usr/bin/env python3
"""
analyze-pq-bench.py
Reads ~/SignalPQBenchmarks/*.jsonl and produces:
  - Per-stage summary statistics (mean, median, std, min, max)
  - Attachment-size breakdown table (for journal paper)
  - CSV files for plotting

Usage:
  python3 scripts/analyze-pq-bench.py [--dir ~/SignalPQBenchmarks] [--out ./results]
"""

import argparse
import json
import os
import statistics
import csv
from glob import glob
from collections import defaultdict


def load_records(bench_dir):
    records = []
    for path in sorted(glob(os.path.join(bench_dir, '*.jsonl')) +
                       glob(os.path.join(bench_dir, '*.log'))):
        with open(path, 'r') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return records


def stats(values):
    if not values:
        return {}
    return {
        'n':      len(values),
        'mean':   statistics.mean(values),
        'median': statistics.median(values),
        'std':    statistics.stdev(values) if len(values) > 1 else 0.0,
        'min':    min(values),
        'max':    max(values),
    }


def fmt(v, decimals=3):
    return f'{v:.{decimals}f}'


def print_stats_table(title, stage_data):
    print(f'\n{"=" * 70}')
    print(f'  {title}')
    print(f'{"=" * 70}')
    header = f'{"Metric":<30} {"n":>5} {"mean":>8} {"median":>8} {"std":>8} {"min":>8} {"max":>8}'
    print(header)
    print('-' * 70)
    for metric, values in sorted(stage_data.items()):
        s = stats(values)
        if not s:
            continue
        print(f'{metric:<30} {s["n"]:>5} {fmt(s["mean"]):>8} {fmt(s["median"]):>8} '
              f'{fmt(s["std"]):>8} {fmt(s["min"]):>8} {fmt(s["max"]):>8}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dir', default=os.path.expanduser('~/SignalPQBenchmarks'))
    parser.add_argument('--out', default='./bench-results')
    args = parser.parse_args()

    os.makedirs(args.out, exist_ok=True)

    records = load_records(args.dir)
    if not records:
        print(f'No records found in {args.dir}')
        return

    print(f'Loaded {len(records)} records from {args.dir}')

    # ── Group by stage ────────────────────────────────────────────────────────
    by_stage = defaultdict(lambda: defaultdict(list))
    for rec in records:
        stage = rec.get('stage', 'UNKNOWN')
        vals  = rec.get('values', {})
        for k, v in vals.items():
            if isinstance(v, (int, float)):
                by_stage[stage][k].append(v)

    # ── Per-stage summary ─────────────────────────────────────────────────────
    for stage, metrics in sorted(by_stage.items()):
        print_stats_table(stage, metrics)

    # ── Attachment benchmark breakdown by size ────────────────────────────────
    attach_records = [r for r in records if r.get('stage') == 'PQ_ATTACH_BENCH']
    if attach_records:
        by_size = defaultdict(lambda: defaultdict(list))
        for rec in attach_records:
            vals  = rec['values']
            label = vals.get('sizeLabel', str(vals.get('sizeBytes', '?')))
            for k, v in vals.items():
                if isinstance(v, (int, float)) and k not in ('sizeBytes', 'run', 'plainLen', 'wrappedLen'):
                    by_size[label][k].append(v)

        print(f'\n{"=" * 90}')
        print('  ATTACHMENT BENCHMARK — size breakdown (ms)')
        print(f'{"=" * 90}')
        col = f'{"Size":<10} {"n":>4} {"KEM Encap":>10} {"AES Enc":>10} {"Total Wrap":>12} {"KEM Decap":>10} {"AES Dec":>10} {"Total Unwrap":>13}'
        print(col)
        print('-' * 90)

        size_order = ['100 KB', '500 KB', '2 MB', '5 MB']
        labels = sorted(by_size.keys(), key=lambda x: size_order.index(x) if x in size_order else 99)

        csv_rows = []
        for lbl in labels:
            m = by_size[lbl]
            n = len(m.get('pqTotalWrapMs', []))
            def avg(key): return statistics.mean(m[key]) if m.get(key) else float('nan')
            encap = avg('pqEncapsulateMs')
            sym_e = avg('pqSymmetricEncryptMs')
            wrap  = avg('pqTotalWrapMs')
            decap = avg('pqDecapsulateMs')
            sym_d = avg('pqSymmetricDecryptMs')
            unwrap= avg('pqTotalUnwrapMs')
            print(f'{lbl:<10} {n:>4} {fmt(encap):>10} {fmt(sym_e):>10} {fmt(wrap):>12} '
                  f'{fmt(decap):>10} {fmt(sym_d):>10} {fmt(unwrap):>13}')
            csv_rows.append({
                'size': lbl, 'n': n,
                'kem_encap_ms': encap, 'aes_enc_ms': sym_e, 'total_wrap_ms': wrap,
                'kem_decap_ms': decap, 'aes_dec_ms': sym_d, 'total_unwrap_ms': unwrap,
            })

        # Write CSV
        csv_path = os.path.join(args.out, 'attachment_benchmark.csv')
        with open(csv_path, 'w', newline='') as f:
            w = csv.DictWriter(f, fieldnames=csv_rows[0].keys())
            w.writeheader()
            w.writerows(csv_rows)
        print(f'\n  CSV written: {csv_path}')

    # ── Text vs attachment message comparison ─────────────────────────────────
    send_prep = [r for r in records if r.get('stage') == 'SEND_PREP']
    if send_prep:
        text_msgs  = [r for r in send_prep if not r['values'].get('hasAttachments')]
        attach_msgs= [r for r in send_prep if r['values'].get('hasAttachments')]
        print(f'\n{"=" * 70}')
        print('  SEND_PREP: text messages vs. attachment messages')
        print(f'{"=" * 70}')
        for label, group in [('Text messages', text_msgs), ('Attachment messages', attach_msgs)]:
            wrap_times = [r['values']['pqWrapMs'] for r in group if 'pqWrapMs' in r['values']]
            if wrap_times:
                s = stats(wrap_times)
                print(f'  {label:<25} n={s["n"]:>4}  pqWrapMs: '
                      f'mean={fmt(s["mean"])} median={fmt(s["median"])} std={fmt(s["std"])}')

    print(f'\nDone. Results in: {args.out}\n')


if __name__ == '__main__':
    main()
