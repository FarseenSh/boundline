"""Boundline brand kit generator (python3 brand.py [outDir]; needs fonttools + uharfbuzz and the Archivo variable TTF).

The mark: a lowercase b in the open week; the boundary at Friday 20:00 ET (5/7 of the way across the tile) doubles as
the l; past it, the 48 held hours of the weekend as a hatched band. It reads "bl", for Bound-line.

Writes SVGs to OUT/svg and a preview page; PNGs are rendered by render.js (headless Chrome)."""
import json
import os
import pathlib
import sys

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

HERE = pathlib.Path(__file__).parent
OUT = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent
(OUT / "svg").mkdir(parents=True, exist_ok=True)

CORAL, INK, PAPER = "#FF6B57", "#15171C", "#F4F5F7"
FONT = pathlib.Path(os.environ.get("ARCHIVO_TTF", HERE / "Archivo[wdth,wght].ttf"))  # github.com/google/fonts ofl/archivo
LOC = {"wdth": 125, "wght": 800}
TRACK = -0.012  # em


def f(x):
    s = f"{x:.2f}".rstrip("0").rstrip(".")
    return s if s != "-0" else "0"


# ----------------------------------------------------------------------------- the mark
BOUNDARY = 64 * 5 / 7  # Friday 20:00 ET: five of the feed week's seven days


def mark(fg, *, sw=8.6, top=10.0, base=54.0, R=14.3, gap=3.7, stripe_w=3.5, period=7.8, phase=0.0, scale=1.0, uid="m"):
    """The b, the l and the weekend band, in 64-unit tile coordinates (scaled about the centre by `scale`)."""
    r = R - sw / 2
    lx = BOUNDARY
    sx = (lx - sw / 2) - gap - (2 * r + sw / 2)  # stem centreline so that the bowl ends `gap` before the l
    cy = base - R
    cx = sx + r
    parts = [
        f'<path d="M{f(sx)} {f(top + sw / 2)} V{f(cy)}" stroke="{fg}" stroke-width="{f(sw)}" stroke-linecap="round" fill="none"/>',
        f'<circle cx="{f(cx)}" cy="{f(cy)}" r="{f(r)}" stroke="{fg}" stroke-width="{f(sw)}" fill="none"/>',
        f'<path d="M{f(lx)} {f(top + sw / 2)} V{f(base - sw / 2)}" stroke="{fg}" stroke-width="{f(sw)}" stroke-linecap="round" fill="none"/>',
    ]
    x0 = lx + sw / 2  # the band starts at the l's outer edge
    lines, x = [], x0 - 64 + phase
    while x < 64 + period:
        lines.append(f"M{f(x)} 64 L{f(x + 64)} 0")
        x += period
    parts.append(
        f'<clipPath id="{uid}b"><rect x="{f(x0)}" y="0" width="{f(64 - x0)}" height="64"/></clipPath>'
        f'<path clip-path="url(#{uid}b)" d="{" ".join(lines)}" stroke="{fg}" stroke-width="{f(stripe_w)}" fill="none"/>'
    )
    g = "".join(parts)
    if scale != 1.0:
        g = f'<g transform="translate(32 32) scale({f(scale)}) translate(-32 -32)">{g}</g>'
    return g


def tile_svg(bg, fg, *, rx=14.0, label="Boundline", size=None, **kw):
    uid = kw.pop("uid", "t")
    wh = f' width="{size}" height="{size}"' if size else ""
    clip = f'<clipPath id="{uid}c"><rect width="64" height="64" rx="{f(rx)}"/></clipPath>' if rx else ""
    body = f'<rect width="64" height="64" fill="{bg}"/>' + mark(fg, uid=uid, **kw)
    if rx:
        body = f'<g clip-path="url(#{uid}c)">{body}</g>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"{wh} role="img" aria-label="{label}">{clip}{body}</svg>'


FAVICON = dict(sw=10.4, top=9.0, base=55.0, R=15.4, gap=3.2, stripe_w=4.6, period=10.2, phase=1.5)
AVATAR = dict(scale=0.8)  # keeps the b and l inside a circle crop

# ----------------------------------------------------------------------------- the wordmark, outlined
tt = instantiateVariableFont(TTFont(FONT), LOC)
glyphset = tt.getGlyphSet()
order = tt.getGlyphOrder()
upem = tt["head"].unitsPerEm
hb_font = hb.Font(hb.Face(hb.Blob.from_file_path(str(FONT))))
hb_font.set_variations(LOC)


def shape(text):
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(hb_font, buf, {"kern": True, "liga": True})
    return list(zip(buf.glyph_infos, buf.glyph_positions))


def wordmark_path(text, size, x0, baseline):
    """SVG path data for `text` at `size` units per em, baseline at y=`baseline`, starting at x0."""
    s = size / upem
    pen = SVGPathPen(glyphset)
    x = 0.0
    for info, pos in shape(text):
        name = order[info.codepoint]
        glyphset[name].draw(TransformPen(pen, (s, 0, 0, -s, x0 + (x + pos.x_offset) * s, baseline - pos.y_offset * s)))
        x += pos.x_advance + TRACK * upem
    width = (x - TRACK * upem) * s
    return pen.getCommands(), width


def glyph_bounds(ch):
    bp = BoundsPen(glyphset)
    glyphset[order[hb_font.get_nominal_glyph(ord(ch))]].draw(bp)
    return bp.bounds  # (xMin, yMin, xMax, yMax) in font units


B_ASC = glyph_bounds("b")[3]  # ascender top of the b, font units
TEXT = "boundline"


def lockup_svg(bg, tile_bg, tile_fg, text_color, *, pad=0, label="Boundline"):
    """Tile + wordmark. The wordmark's b and l share the mark's ascender line (y=10) and baseline (y=54)."""
    top, base = 10.0, 54.0
    size = (base - top) / B_ASC * upem
    gap = 17.0
    d, w = wordmark_path(TEXT, size, 64 + gap, base)
    W = 64 + gap + w
    t = tile_svg(tile_bg, tile_fg, uid="lk").replace('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Boundline">', "").replace("</svg>", "")
    bgrect = f'<rect x="{f(-pad)}" y="{f(-pad)}" width="{f(W + 2 * pad)}" height="{f(64 + 2 * pad)}" fill="{bg}"/>' if bg else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{f(-pad)} {f(-pad)} {f(W + 2 * pad)} {f(64 + 2 * pad)}" role="img" aria-label="{label}">'
            f'{bgrect}{t}<path d="{d}" fill="{text_color}"/></svg>'), W


def wordmark_svg(color):
    size = 44 / B_ASC * upem
    d, w = wordmark_path(TEXT, size, 0, 54)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 8 {f(w)} 48" role="img" aria-label="Boundline"><path d="{d}" fill="{color}"/></svg>'


files = {
    "boundline-tile.svg": tile_svg(CORAL, INK),
    "boundline-tile-ink.svg": tile_svg(INK, CORAL),
    "boundline-tile-favicon.svg": tile_svg(CORAL, INK, **FAVICON),
    "boundline-square.svg": tile_svg(CORAL, INK, rx=0),
    "boundline-avatar.svg": tile_svg(CORAL, INK, rx=0, **AVATAR),
    "boundline-wordmark-ink.svg": wordmark_svg(INK),
    "boundline-wordmark-paper.svg": wordmark_svg(PAPER),
}
files["boundline-lockup-light.svg"], LW = lockup_svg(None, CORAL, INK, INK)
files["boundline-lockup-dark.svg"], _ = lockup_svg(None, CORAL, INK, PAPER)
files["boundline-lockup-coral.svg"], _ = lockup_svg(None, INK, CORAL, INK)
for name, svg in files.items():
    (OUT / "svg" / name).write_text(svg + "\n")
json.dump({"lockup_width": LW, "b_ascender": B_ASC}, open(OUT / "meta.json", "w"))
print("wrote", len(files), "svgs; lockup aspect", round(LW / 64, 3))
