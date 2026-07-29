#!/usr/bin/env python3
"""Regenerate the PWA / home-screen icons in assets/.

Run: python3 tools/make-icons.py     (stdlib only - no Pillow, no ImageMagick)

Deliberately dependency-free: the repo has no build step, and these icons are
committed binaries, so the only thing that keeps them reproducible is a script
that runs on a bare python3.

The art is the simulator in one glance: a closed-loop freeway seen from
overhead, with three cars colored off the HUD's speed legend (stopped red ->
desired-speed green). Everything is drawn in unit coordinates (0..1 across the
tile) and supersampled 4x4, so any output size is exact.

`scale` shrinks the artwork inside the tile. Maskable icons are cropped by the
launcher to a circle of 80% diameter, so their content has to stay inside
r = 0.40; the plain icons push out to 0.42 because iOS masks to a squircle
that keeps far more of the corners.
"""

import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "assets"

# palette: page slate (index.html body background) -> deeper slate, then the
# asphalt/marking grays and the legend's red/amber/green speed ramp
BG_TOP = (0x4E, 0x62, 0x78)
BG_BOTTOM = (0x22, 0x2C, 0x38)
ASPHALT = (0x3A, 0x43, 0x50)
EDGE = (0xC8, 0xD3, 0xE0)
DASH = (0xE8, 0xC9, 0x5C)
CARS = [(35, (0xE2, 0x4B, 0x4B)), (150, (0xE8, 0xC0, 0x4A)), (255, (0x63, 0xCE, 0x8E))]

SS = 4  # supersample factor per axis


def png(path, size, rows):
    """Write RGB rows (list of bytearrays) as a PNG."""

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    body = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(body)
    print(f"{path.name}: {size}x{size}, {len(body) / 1024:.1f} KB")


def sample(x, y, scale):
    """Color at unit-square point (x, y). Painter's order, back to front."""
    # background: vertical gradient, so the tile still reads as sky-over-road
    t = y
    r = round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t)
    g = round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t)
    b = round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t)

    dx, dy = x - 0.5, y - 0.5
    rad = math.hypot(dx, dy) / scale
    ang = math.degrees(math.atan2(dy, dx)) % 360

    outer, inner = 0.42, 0.24
    if inner <= rad <= outer:
        r, g, b = ASPHALT
        # painted edge lines just inside the pavement boundary
        if rad > outer - 0.022 or rad < inner + 0.022:
            r, g, b = EDGE
        # dashed centerline: 9 deg of paint every 18 deg
        elif abs(rad - (inner + outer) / 2) < 0.011 and ang % 18 < 9:
            r, g, b = DASH

    # cars: axis-aligned boxes in the road-tangent frame at their own angle
    lane = (inner + outer) / 2
    for deg, color in CARS:
        a = math.radians(deg)
        cx, cy = 0.5 + math.cos(a) * lane * scale, 0.5 + math.sin(a) * lane * scale
        px, py = x - cx, y - cy
        # rotate into the car's frame: +tangent is forward, +radial is lateral
        fwd = -px * math.sin(a) + py * math.cos(a)
        lat = px * math.cos(a) + py * math.sin(a)
        if abs(fwd) < 0.055 * scale and abs(lat) < 0.030 * scale:
            r, g, b = color

    return r, g, b


def render(name, size, scale):
    step = 1.0 / (size * SS)
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = 0
            for sy in range(SS):
                y = (py * SS + sy + 0.5) * step
                for sx in range(SS):
                    cr, cg, cb = sample((px * SS + sx + 0.5) * step, y, scale)
                    r += cr
                    g += cg
                    b += cb
            n = SS * SS
            row += bytes((round(r / n), round(g / n), round(b / n)))
        rows.append(row)
    png(OUT / name, size, rows)


if __name__ == "__main__":
    render("icon-180.png", 180, 1.0)  # apple-touch-icon (iOS home screen)
    render("icon-192.png", 192, 1.0)
    render("icon-512.png", 512, 1.0)
    render("icon-maskable-512.png", 512, 0.80)  # content inside the 80% safe circle
