# Boundline brand mark

**bl, with the weekend held.** A lowercase b sits in the open trading week; the boundary at Friday 20:00 ET, five of the
feed week's seven days across the tile, doubles as the l; past it, the 48 hours the price feeds hold Friday's close are a
hatched band, 2/7 of the tile, the weekend's share of the week. It reads "bl", for Bound-line, and it draws the one line
the product enforces. The hatch is the same "feeds held" pattern the site, the Observatory and the charts use. Adopted
13 October 2026.

## Files

| Use | File |
|---|---|
| Primary mark (rounded tile) | `svg/boundline-tile.svg`, `png/boundline-tile-512.png`, `png/boundline-tile-1024.png` |
| On coral or busy grounds (ink tile) | `svg/boundline-tile-ink.svg`, `png/boundline-tile-ink-512.png` |
| Favicon cut (heavier, for 32 px and below) | `svg/boundline-tile-favicon.svg`, `favicon.ico` (16, 32, 48), `png/favicon-16/32/48/64.png` |
| Lockup, tile + wordmark | `svg/boundline-lockup-light.svg` (ink text), `-dark.svg` (paper text), `-coral.svg` (ink tile, ink text, for coral grounds); PNGs 128 px tall |
| Wordmark alone | `svg/boundline-wordmark-ink.svg`, `svg/boundline-wordmark-paper.svg` |
| Profile picture (X, GitHub, Farcaster; safe inside a circle crop) | `png/avatar-1024.png`, `png/avatar-400.png`, `svg/boundline-avatar.svg` |
| App icon, full bleed (iOS rounds it) | `png/apple-touch-icon.png` (180), `png/boundline-square-512.png`, `svg/boundline-square.svg` |
| Submission forms | `png/logo-1040x256.png` (lockup on ink), `png/logo-mark-512.png` (tile) |
| Social cards | `png/og-1200x630.png` (link previews), `png/x-banner-1500x500.png` (X header) |
| Every variant on one page | `preview.html` |

## Colours

| Role | Hex |
|---|---|
| Coral: the tile, the brand | `#FF6B57` |
| Ink: the b, the l and the stripes; the wordmark on light and coral grounds | `#15171C` |
| Paper: the wordmark on dark grounds | `#F4F5F7` |

## Wordmark

Archivo (variable), width 125, weight 800, tracking -0.012 em, lowercase: `boundline`. The SVGs have it converted to
outlines. In the lockup the wordmark's b and l sit on the mark's ascender line and baseline, and the gap between tile and
wordmark is 17/64 of the tile. In prose the name stays "Boundline".

## Construction (64-unit tile)

- Tile 64 × 64, corner radius 14.
- Letters: stroke 8.6, ascender line y = 10, baseline y = 54; the bowl's outer radius 14.3; 3.7 between the bowl and the l.
- The l's centreline at x = 45.71 = 64 × 5/7: Friday 20:00 ET in the week that runs Sunday 20:00 ET to Sunday 20:00 ET.
- The band runs from the l's outer edge to the tile's right edge: stripes at 45°, 3.5 wide, every 7.8, leaning forward.
- Favicon cut: stroke 10.4, ascender 9, baseline 55, bowl 15.4, stripes 4.6 every 10.2.
- Avatar: the mark at 80% so the b and the l stay inside a circle crop.

## Rules

- The tile is the logo. Coral tile with ink, or the ink tile with coral on coral grounds; never other colours.
- Keep the stripes: without them it is only two letters. Don't rotate, mirror or re-angle them, and don't outline the
  tile or add shadows or glows.
- At 32 px and below, use the favicon cut.
- Keep clear space of at least a quarter of the tile's width on every side.

## Rebuild

`source/brand.py` writes every SVG (Python with `fonttools` and `uharfbuzz`; set `ARCHIVO_TTF` to `Archivo[wdth,wght].ttf`
from github.com/google/fonts, `ofl/archivo`). `source/render.js` renders the PNGs with `playwright-core` and the system
Google Chrome; `source/preview.py` writes `preview.html`. The SVGs regenerate byte for byte.
