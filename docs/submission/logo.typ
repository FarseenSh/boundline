// Renders the Boundline logo as PNGs for upload forms: `typst compile logo.typ logo-{p}.png --ppi 144`.
// Page 1: the square mark (the app icon, apps/app/public/icon.svg). Page 2: mark + wordmark on the app's paper colour.
#let paper = rgb("#0e1116")
#let ink = rgb("#e9ecef")
#let coral = rgb("#ff6b57")
#let mark(s) = box(width: s, height: s, {
  place(rect(width: s, height: s, radius: s * 12 / 64, fill: coral))
  place(dx: s * 14 / 64, dy: s * 18 / 64, rect(width: s * 20 / 64, height: s * 5 / 64, fill: paper))
  place(dx: s * 14 / 64, dy: s * 30 / 64, rect(width: s * 36 / 64, height: s * 5 / 64, fill: paper))
  place(dx: s * 14 / 64, dy: s * 42 / 64, rect(width: s * 28 / 64, height: s * 5 / 64, fill: paper))
})
#set page(width: 256pt, height: 256pt, margin: 0pt, fill: none)
#mark(256pt)
#pagebreak()
#set page(width: 520pt, height: 128pt, margin: 0pt, fill: paper)
#place(dx: 24pt, dy: 24pt, mark(80pt))
#place(dx: 128pt, dy: 22pt, text(font: ("Instrument Serif", "New York", "Georgia"), size: 70pt, fill: ink, tracking: -0.7pt)[Boundline#text(fill: coral)[.]])
