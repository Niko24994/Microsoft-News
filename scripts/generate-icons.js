/**
 * Generate PWA icons using Puppeteer.
 * Run once:  node scripts/generate-icons.js
 * Output:    icons/icon-192.png, icon-512.png,
 *            icons/apple-touch-icon-{180,167,152}.png
 */
import puppeteer from 'puppeteer';
import fs        from 'fs';
import path      from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = path.join(ROOT, 'icons');
fs.mkdirSync(OUT, { recursive: true });

const ICONS = [
  { size: 512,  file: 'icon-512.png' },
  { size: 192,  file: 'icon-192.png' },
  { size: 180,  file: 'apple-touch-icon-180.png' },
  { size: 167,  file: 'apple-touch-icon-167.png' },
  { size: 152,  file: 'apple-touch-icon-152.png' },
];

function makeHtml(size) {
  const fs  = Math.round(size * 0.50);   // font-size
  const pad = Math.round(size * 0.12);   // inner padding for the diamond ring

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body {
    width:${size}px; height:${size}px; overflow:hidden;
    background:#0078d4;
    display:flex; align-items:center; justify-content:center;
  }
  /* Two-letter stacked "MR" mark */
  .mark {
    display:flex; flex-direction:column;
    align-items:center; justify-content:center;
    line-height:1;
    gap: ${Math.round(size * 0.02)}px;
  }
  .top {
    color:#ffffff;
    font-family:'Segoe UI','Arial',sans-serif;
    font-size:${fs}px;
    font-weight:800;
    letter-spacing:-0.03em;
  }
  .sub {
    color:rgba(255,255,255,0.72);
    font-family:'Segoe UI','Arial',sans-serif;
    font-size:${Math.round(size * 0.14)}px;
    font-weight:500;
    letter-spacing:0.18em;
    text-transform:uppercase;
  }
</style>
</head>
<body>
  <div class="mark">
    <span class="top">MR</span>
    <span class="sub">News</span>
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
    console.log(`  ✓ ${file}  (${size}×${size})`);
  }

  await browser.close();
  console.log('\nDone – icons saved to icons/');
}

main().catch(err => { console.error(err); process.exit(1); });
