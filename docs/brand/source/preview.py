import pathlib, sys
K = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "kit")
s = lambda n: (K / "svg" / n).read_text()
def sized(svg, w=None, h=None):
    attrs = (f' width="{w}"' if w else "") + (f' height="{h}"' if h else "")
    return svg.replace("<svg ", f"<svg{attrs} ", 1)
tile, ink, fav, sq, av = s("boundline-tile.svg"), s("boundline-tile-ink.svg"), s("boundline-tile-favicon.svg"), s("boundline-square.svg"), s("boundline-avatar.svg")
html = f"""<!doctype html><meta charset=utf-8><style>
body{{margin:0;padding:28px;background:#fff;font:13px/1.4 -apple-system,sans-serif;color:#15171C}}
.row{{display:flex;gap:28px;align-items:flex-end;margin-bottom:28px;flex-wrap:wrap}}
.cap{{margin-top:6px;color:#667}} .c{{border-radius:50%;overflow:hidden;line-height:0}}
.band{{padding:28px 32px;border-radius:16px;line-height:0}}
</style>
<div class=row><div>{sized(tile,260,260)}<div class=cap>tile</div></div><div>{sized(ink,260,260)}<div class=cap>ink tile</div></div>
<div>{sized(fav,64,64)} {sized(fav,48,48)} {sized(fav,32,32)} {sized(fav,16,16)}<div class=cap>favicon cut 64/48/32/16</div></div>
<div>{sized(tile,48,48)} {sized(tile,32,32)} {sized(tile,16,16)}<div class=cap>tile 48/32/16</div></div>
<div><div class=c>{sized(av,160,160)}</div><div class=cap>avatar, circle crop</div></div><div>{sized(sq,160,160)}<div class=cap>square</div></div></div>
<div class=band style="background:#F4F5F7">{sized(s('boundline-lockup-light.svg'),h=84)}</div><br>
<div class=band style="background:#15171C">{sized(s('boundline-lockup-dark.svg'),h=84)}</div><br>
<div class=band style="background:#FF6B57">{sized(s('boundline-lockup-coral.svg'),h=84)}</div><br>
<div class=row><div class=band style="background:#0B1733">{sized(s('boundline-lockup-dark.svg'),h=40)}</div>
<div class=band style="background:#fff;border:1px solid #ddd">{sized(s('boundline-lockup-light.svg'),h=28)}</div>
<div class=band style="background:#FF6B57">{sized(s('boundline-lockup-coral.svg'),h=34)}</div></div>
"""
(K / "preview.html").write_text(html); print(K / "preview.html")
