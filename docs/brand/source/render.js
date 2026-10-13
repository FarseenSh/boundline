// Render the Boundline brand kit's PNGs from its SVGs with headless Chrome.
//   node render.js <kitDir>   (then pack favicon.ico from png/favicon-16/32/48.png)
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core"); // uses the system Google Chrome

const kit = process.argv[2];
const svg = (n) => fs.readFileSync(path.join(kit, "svg", n), "utf8");
const png = (n) => path.join(kit, "png", n);
fs.mkdirSync(path.join(kit, "png"), { recursive: true });

const TAG1 = "Borrow against your stocks on Base.";
const TAG2 = "Paid in your currency. Never liquidated while Wall Street is closed.";
const FONT = "<link href='https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&display=swap' rel=stylesheet>";

async function shot(page, html, w, h, out, transparent = true) {
  await page.setViewportSize({ width: Math.max(w, 320), height: Math.max(h, 320) });
  await page.setContent(`<!doctype html><meta charset=utf-8>${FONT}<style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>${html}`, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, omitBackground: transparent, clip: { x: 0, y: 0, width: w, height: h } });
}
const sized = (s, w, h) => s.replace("<svg ", `<svg width="${w}" height="${h}" `);

(async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const tile = svg("boundline-tile.svg"), ink = svg("boundline-tile-ink.svg"), fav = svg("boundline-tile-favicon.svg");
  for (const s of [512, 1024]) await shot(page, sized(tile, s, s), s, s, png(`boundline-tile-${s}.png`));
  await shot(page, sized(ink, 512, 512), 512, 512, png("boundline-tile-ink-512.png"));
  for (const s of [16, 32, 48, 64]) await shot(page, sized(fav, s, s), s, s, png(`favicon-${s}.png`));
  await shot(page, sized(svg("boundline-square.svg"), 180, 180), 180, 180, png("apple-touch-icon.png"), false);
  await shot(page, sized(svg("boundline-square.svg"), 512, 512), 512, 512, png("boundline-square-512.png"), false);
  for (const s of [400, 1024]) await shot(page, sized(svg("boundline-avatar.svg"), s, s), s, s, png(`avatar-${s}.png`), false);

  // Lockups at 128 px tall on transparent ground, plus the submission-form sizes.
  const meta = JSON.parse(fs.readFileSync(path.join(kit, "meta.json"), "utf8"));
  const aspect = meta.lockup_width / 64;
  for (const v of ["light", "dark", "coral"]) {
    const h = 128, w = Math.round(h * aspect);
    await shot(page, sized(svg(`boundline-lockup-${v}.svg`), w, h), w, h, png(`boundline-lockup-${v}.png`));
  }
  // Submission: logo.png 1040x256 (lockup on the app's dark paper) and logo-mark.png 512x512 (the tile).
  {
    const W = 1040, H = 256, lh = 128, lw = Math.round(lh * aspect);
    await shot(page, `<div style="width:${W}px;height:${H}px;background:#15171C;display:flex;align-items:center;justify-content:center">${sized(svg("boundline-lockup-dark.svg"), lw, lh)}</div>`, W, H, png("logo-1040x256.png"), false);
    await shot(page, sized(tile, 512, 512), 512, 512, png("logo-mark-512.png"));
  }
  // Social card 1200x630 (Open Graph / X summary_large_image): the coral poster.
  {
    const lw = Math.round(72 * aspect);
    await shot(page, `<div style="width:1200px;height:630px;background:#FF6B57;color:#15171C;box-sizing:border-box;padding:72px 80px;display:flex;flex-direction:column;justify-content:space-between;font-family:Archivo">
      ${sized(svg("boundline-lockup-coral.svg"), lw, 72)}
      <div><div style="font-stretch:125%;font-weight:800;font-size:68px;line-height:.98;letter-spacing:-.02em">${TAG1}</div>
      <div style="margin-top:22px;font-stretch:100%;font-weight:500;font-size:30px;line-height:1.3;max-width:900px">${TAG2}</div></div></div>`, 1200, 630, png("og-1200x630.png"), false);
  }
  // X header 1500x500: ink ground, the held weekend as a hatched band on the right, the lockup on the left.
  {
    const lw = Math.round(84 * aspect);
    const stripes = Array.from({ length: 40 }, (_, i) => `<line x1="${1080 + i * 22 - 500}" y1="500" x2="${1080 + i * 22}" y2="0" stroke="#FF6B57" stroke-width="9"/>`).join("");
    await shot(page, `<div style="position:relative;width:1500px;height:500px;background:#15171C;overflow:hidden;font-family:Archivo">
      <svg width="1500" height="500" style="position:absolute;inset:0"><clipPath id="w"><rect x="1092" y="0" width="408" height="500"/></clipPath><g clip-path="url(#w)">${stripes}</g><rect x="1071" y="0" width="21" height="500" fill="#FF6B57"/></svg>
      <div style="position:absolute;left:110px;top:150px">${sized(svg("boundline-lockup-dark.svg"), lw, 84)}
      <div style="margin-top:34px;color:#F4F5F7;font-stretch:112%;font-weight:700;font-size:34px;letter-spacing:-.01em;max-width:860px;line-height:1.2">Never liquidated while Wall Street is closed.</div></div></div>`, 1500, 500, png("x-banner-1500x500.png"), false);
  }
  await browser.close();
  console.log("rendered", fs.readdirSync(path.join(kit, "png")).length, "pngs");
})();
