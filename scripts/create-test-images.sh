#!/usr/bin/env bash
# create-test-images.sh
# Creates test PNG images of target sizes for PQ attachment benchmarking.
# Requires: python3 (standard library only) or dd + fallback.
#
# Usage:  ./scripts/create-test-images.sh [output_dir]
# Output: <output_dir>/test_100kb.png, test_500kb.png, test_2mb.png, test_5mb.png

set -euo pipefail

OUT_DIR="${1:-$(dirname "$0")/../test-images}"
mkdir -p "$OUT_DIR"

echo "Creating test images in: $OUT_DIR"

# Use Python to emit valid-ish PNG files of target sizes.
# The images are a 1×1 white pixel PNG header followed by random IDAT chunks
# padded to the target size. Signal will accept any file as an "image" in tests.

python3 - "$OUT_DIR" <<'EOF'
import sys, os, struct, zlib, random

def make_png(path, target_bytes):
    """Write a minimal valid-ish PNG padded to ~target_bytes with random pixel data."""
    # PNG signature
    sig = b'\x89PNG\r\n\x1a\n'

    def chunk(name, data):
        c = name + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    # IHDR: width x height, 8-bit RGB
    # Use a square image whose raw size is close to target
    pixels_needed = max(1, (target_bytes - 200) // 3)
    side = max(1, int(pixels_needed ** 0.5))
    width = height = side

    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    ihdr = chunk(b'IHDR', ihdr_data)

    # IDAT: raw scanlines (filter byte 0x00 per row + RGB pixels)
    raw = bytearray()
    for _ in range(height):
        raw.append(0)  # filter byte
        row_data = os.urandom(width * 3)
        raw.extend(row_data)

    compressed = zlib.compress(bytes(raw), level=1)
    idat = chunk(b'IDAT', compressed)

    iend = chunk(b'IEND', b'')

    body = sig + ihdr + idat + iend

    # Pad with a comment chunk if we're still short
    while len(body) < target_bytes:
        pad_needed = target_bytes - len(body) - 12  # 12 = chunk overhead
        if pad_needed <= 0:
            break
        pad_data = os.urandom(min(pad_needed, 65536))
        body += chunk(b'tEXt', pad_data)

    with open(path, 'wb') as f:
        f.write(body[:target_bytes] if len(body) > target_bytes else body)

    actual = os.path.getsize(path)
    print(f'  {os.path.basename(path):25s}  {actual:>10,} bytes  ({actual/1024:.1f} KB)')

out_dir = sys.argv[1]

targets = [
    ('test_100kb.png',  100 * 1024),
    ('test_500kb.png',  500 * 1024),
    ('test_2mb.png',   2048 * 1024),
    ('test_5mb.png',   5120 * 1024),
]

print(f"{'File':25s}  {'Size':>10}  (Target)")
for name, size in targets:
    make_png(os.path.join(out_dir, name), size)

print(f"\nAll test images written to: {out_dir}")
EOF

echo ""
echo "You can now:"
echo "  1. Run the PQ benchmark:  node scripts/pq-bench-attachments.mjs"
echo "  2. Send test images from $OUT_DIR via Alice/Bob Signal instances"
echo "  3. Check logs in ~/SignalPQBenchmarks/"
