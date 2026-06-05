/**
 * Generate PWA icons using Puppeteer — Windows-flag-style "M" design.
 * Run:  node scripts/generate-icons.js
 *
 * Output:
 *   icons/icon-512.png          (512×512)
 *   icons/icon-192.png          (192×192)
 *   icons/apple-touch-icon.png  (180×180)  ← default iOS
 *   icons/apple-touch-icon-152.png (152×152)
 *   icons/apple-touch-icon-167.png (167×167)
 */
import puppeteer from 'puppeteer';
import fs        from 'fs';
import path      from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = path.join(ROOT, 'icons');
fs.mkdirSync(OUT, { recursive: true });

const ICONS = [
  { size: 512, file: 'icon-512.png'              },
  { size: 192, file: 'icon-192.png'              },
  { size: 180, file: 'apple-touch-icon.png'      },
  { size: 167, file: 'apple-touch-icon-167.png'  },
  { size: 152, file: 'apple-touch-icon-152.png'  },
];

/**
 * Build the HTML for the icon at a given pixel size.
 * Design: dark background · 2×2 colored squares (Windows flag colours)
 *         · large white bold "M" centred on top.
 */
function makeHtml(size) {
  // Squares: each ~32 % of total, gap ~5 %, all centred
  const sq  = Math.round(size * 0.315);   // square side
  const gap = Math.round(size * 0.048);   // gap between squares
  const r   = Math.round(sq * 0.065);     // corner radius on each square

  // "M" font-size: ~42 % of icon size feels balanced
  const fs  = Math.round(size * 0.425);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${size}px; height:${size}px; overflow:hidden; }

  .icon {
    width:${size}px; height:${size}px;
    background:#0d1117;
    position:relative;
    overflow:hidden;
  }

  /* 2×2 grid of coloured squares, centred */
  .grid {
    position:absolute;
    top:50%; left:50%;
    transform:translate(-50%, -50%);
    display:grid;
    grid-template-columns:${sq}px ${sq}px;
    grid-template-rows:${sq}px ${sq}px;
    gap:${gap}px;
  }
  .sq            { border-radius:${r}px; }
  .sq-red        { background:#F25022; }
  .sq-green      { background:#7FBA00; }
  .sq-blue       { background:#00A4EF; }
  .sq-yellow     { background:#FFB900; }

  /* White bold M centred over the grid */
  .letter {
    position:absolute;
    top:50%; left:50%;
    transform:translate(-50%, -48%);
    font-family:'Segoe UI Black','Arial Black','Impact',Arial,sans-serif;
    font-weight:900;
    font-size:${fs}px;
    color:#ffffff;
    line-height:1;
    /* subtle drop-shadow so edges read against any colour */
    text-shadow:0 2px ${Math.round(size*0.04)}px rgba(0,0,0,0.55);
    user-select:none;
    pointer-events:none;
    z-index:2;
    letter-spacing:-0.03em;
  }
</style>
</head>
<body>
<div class="icon">
  <div class="grid">
    <div class="sq sq-red"></div>
    <div class="sq sq-green"></div>
    <div class="sq sq-blue"></div>
    <div class="sq sq-yellow"></div>
  </div>
  <span class="letter">M</span>
</div>
</body>
</html>`;
}

async function main() {
  console.log('Launching Puppeteer…');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  for (const { size, file } of ICONS) {
    const page = await browser.newPage();
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    await page.setContent(makeHtml(size), { waitUntil: 'networkidle0' });
    const dest = path.join(OUT, file);
    await page.screenshot({ path: dest, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    console.log(`  ✓  ${file}  (${size}×${size})`);
  }

  await browser.close();
  console.log('\nDone – icons saved to icons/');
}

main().catch(err => { console.error(err); process.exit(1); });
