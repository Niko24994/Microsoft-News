import Parser from 'rss-parser';
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';

const parser = new Parser({ timeout: 10000 });
const NEWS_DIR = path.resolve('public/news');
const MAX_AGE_DAYS = 180;

// ── M365 Roadmap tabs ────────────────────────────────────────────────────────
// Keywords are checked against both item.categories and item.title (case-insensitive).
// Using explicit PP/Fabric product names instead of just "copilot" keeps results
// focused: Teams Copilot, Outlook Copilot etc. have none of these keywords.
const ROADMAP_FEEDS = {
  copilot: {
    url:      'https://www.microsoft.com/releasecommunications/api/v2/m365/rss',
    // Match anything that mentions a PP / Fabric product in title or categories
    keywords: [
      'copilot studio',
      'power platform',
      'power apps',
      'power automate',
      'power pages',
      'power bi',
      'dataverse',
      'microsoft fabric',
      'fabric copilot',
    ],
  },
  agents: {
    url:      'https://www.microsoft.com/releasecommunications/api/v2/m365/rss',
    keywords: ['copilot studio', 'agent', 'power automate', 'power platform'],
  },
};

// ── Release Notes: product blog feeds ───────────────────────────────────────
// skipFilter: true → show all posts (focused sub-blogs only publish product content)
const RELEASE_FEEDS = [
  { url: 'https://community.fabric.microsoft.com/oxcrx34285/rss/board?board.id=fbc_fabricupdatesblogs', product: 'Fabric' },
  { url: 'https://community.fabric.microsoft.com/oxcrx34285/rss/board?board.id=fbc_pbiupdatesblog',     product: 'Power BI' },
  { url: 'https://www.microsoft.com/en-us/power-platform/blog/feed/',                     product: 'Power Platform' },
  { url: 'https://www.microsoft.com/en-us/power-platform/blog/power-automate/feed/',      product: 'Power Automate', skipFilter: true },
  { url: 'https://www.microsoft.com/en-us/power-platform/blog/power-apps/feed/',          product: 'Power Apps',     skipFilter: true },
  { url: 'https://www.microsoft.com/en-us/power-platform/blog/power-pages/feed/',         product: 'Power Pages',    skipFilter: true },
];

const RELEASE_KEYWORDS = [
  'preview', 'generally available', ' ga ', "what's new", "what's new",
  'feature summary', 'feature update', 'roadmap', 'upcoming', 'retiring',
  'deprecated', 'deprecation', 'release plan', 'public preview', 'private preview',
  'coming soon', 'now available', 'release notes', 'feature release',
  'monthly update', 'desktop update', 'service update', 'update',
  'introducing', 'introduces', 'announcing', 'announced', 'new in', 'now in',
  'launching', 'launched', 'available in', 'rolling out', 'general availability',
  'new feature', 'new connector', 'new capability', 'new experience',
  'enhanced', 'enhancements', 'improved', 'improvements',
  'release wave',
];

// ── Release Wave: official Microsoft release plan feature entries ─────────────
// Each product has a scoped Learn RSS feed updated weekly by Microsoft.
// Scope format: [product-slug]-[YY][W]  e.g. power-apps-261 = 2026 Wave 1
const WAVE_PRODUCTS = [
  { scope: 'power-apps',                            product: 'Power Apps' },
  { scope: 'power-automate',                        product: 'Power Automate' },
  { scope: 'power-pages',                           product: 'Power Pages' },
  { scope: 'microsoft-copilot-studio',              product: 'Copilot Studio' },
  { scope: 'data-platform',                         product: 'Dataverse' },
  { scope: 'power-platform-governance-administration', product: 'Power Platform Admin' },
];

// Title patterns that mark overview / investment-area items (not individual features)
const WAVE_OVERVIEW_RE = [
  /^new and planned features for /i,
  /^overview of /i,
  /^[a-z][a-z\s]+ - (building|enabling|enterprise scale|copilot for|govern)/i,
  /\d{4} release wave \d features available in additional products/i,
];

// ── Roadmap status/category helpers ─────────────────────────────────────────
const STATUS_VALUES = ['In development', 'Rolling out', 'Launched', 'Cancelled'];

const NON_PRODUCT_CATS = new Set([
  ...STATUS_VALUES,
  'Worldwide (Standard Multi-Tenant)', 'GCC', 'GCC High', 'DoD',
  'Web', 'Desktop', 'Mac', 'Android', 'iOS', 'Mobile', 'Developer',
  'Linux', 'Teams and Surface Devices',
  'General Availability', 'Preview', 'Targeted Release', 'Current Channel',
]);


// ── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Shorten verbose M365 Roadmap source names so card chips stay compact.
 * Unrecognised names pass through unchanged.
 */
function normalizeSource(source) {
  const MAP = {
    'Microsoft Copilot (Microsoft 365)': 'M365 Copilot',
    'Copilot for Microsoft 365':         'M365 Copilot',
    'Microsoft 365 Copilot':             'M365 Copilot',
    'Microsoft Copilot Studio':          'Copilot Studio',
    'Microsoft Power Automate':          'Power Automate',
    'Microsoft Power Apps':              'Power Apps',
    'Microsoft Power Pages':             'Power Pages',
    'Microsoft Power BI':                'Power BI',
    'Microsoft Power Platform':          'Power Platform',
    'Microsoft Dataverse':               'Dataverse',
    'Microsoft SharePoint':              'SharePoint',
    'Microsoft Exchange':                'Exchange',
    'Microsoft Loop':                    'Loop',
    'Microsoft 365 App':                 'M365 App',
    'Microsoft 365 Apps':                'M365 Apps',
    'Microsoft 365':                     'M365',
  };
  return MAP[source] || source;
}

/**
 * Calculate the current Microsoft release wave ID.
 * Format: [2-digit year][wave]  →  "261" = 2026 Wave 1
 *   April–September  → Wave 1 of the current year
 *   October–December → Wave 2 of the current year
 *   January–March    → Wave 2 of the previous year (still running)
 */
function getCurrentWave() {
  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1; // 1–12
  if (month >= 4 && month <= 9) return `${year % 100}1`;
  if (month >= 10)              return `${year % 100}2`;
  return `${(year - 1) % 100}2`;   // Jan–Mar: previous year's Wave 2
}

/** Human-readable wave label, e.g. "261" → "2026 Release Wave 1" */
function waveLabel(wave) {
  const year  = `20${wave.slice(0, 2)}`;
  const waveN = wave.slice(2);
  return `${year} Release Wave ${waveN}`;
}

// Parse "Preview date: June CY2026" / "GA date: July CY2026" from roadmap text
function parseRoadmapDates(text) {
  const t     = text || '';
  const MY    = '[A-Za-z]+\\s+(?:CY)?20\\d{2}';
  const clean = s => s.replace(/CY/i, '').trim();

  const previewMatch = t.match(new RegExp(
    `(?:preview\\s+(?:date|available)|preview)\\s*:?\\s*(${MY})`, 'i'
  ));
  const gaMatch = t.match(new RegExp(
    `(?:ga\\s+date|general\\s+availability|rollout\\s+start(?:s)?)\\s*:?\\s*(${MY})`, 'i'
  ));

  const result = {};
  if (previewMatch) result.previewDate = clean(previewMatch[1]);
  if (gaMatch)      result.gaDate      = clean(gaMatch[1]);
  return result;
}

// Build a Set of all article URLs from a saved JSON file (for "new" detection)
function loadUrlSet(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const urls = new Set();
    for (const articles of Object.values(data.tabs || {})) {
      if (!Array.isArray(articles)) continue;
      for (const a of articles) { if (a.url) urls.add(a.url); }
    }
    return urls;
  } catch { return new Set(); }
}

// Fabric Roadmap has no real "date added" per feature — the site only
// exposes status + preview/GA quarter, not a creation timestamp. Without
// this, every item would get re-stamped with today's date on every run.
// Instead, carry the previously-seen date forward day to day so each
// feature's date reflects when we first saw it, not when we last scraped it.
function loadFabricDateMap(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const map = new Map();
    for (const a of data.tabs?.fabricroadmap || []) {
      const key = a.url || a.title;
      if (key && a.date) map.set(key, a.date);
    }
    return map;
  } catch { return new Map(); }
}

async function fetchFeed(url) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout after 8s')), 8000)
  );
  try {
    const feed = await Promise.race([parser.parseURL(url), timeout]);
    return feed.items || [];
  } catch (err) {
    console.warn(`  [WARN] Feed unreachable: ${url} — ${err.message}`);
    return [];
  }
}

// ── Fetch functions ──────────────────────────────────────────────────────────

// Sources to always exclude — non-PP Microsoft 365 apps and unrelated services
const ROADMAP_EXCLUDE_SOURCES = new Set([
  'Microsoft Viva', 'PowerPoint', 'Outlook', 'Microsoft Teams', 'Word',
  'OneNote', 'Microsoft Edge', 'OneDrive', 'Microsoft Clipchamp', 'Forms',
  'Microsoft Kaizala', 'Microsoft Whiteboard', 'Microsoft To Do',
  'Microsoft Planner', 'Planner', 'Yammer', 'Stream', 'Excel', 'Visio',
  // Compliance / security products — not Power Platform
  'Microsoft Purview', 'Microsoft Purview compliance portal',
]);

async function fetchRoadmapTab(tabKey) {
  const { url, keywords } = ROADMAP_FEEDS[tabKey];
  console.log(`\n[${tabKey}] Loading roadmap RSS…`);
  console.log(`  → ${url}`);
  const items = await fetchFeed(url);

  const result = [];
  for (const item of items) {
    const categories = item.categories || [];
    const catText    = categories.join(' ').toLowerCase();
    const titleText  = (item.title || '').toLowerCase();
    if (!keywords.some(kw => catText.includes(kw) || titleText.includes(kw))) continue;

    const status    = categories.find(c => STATUS_VALUES.includes(c)) || null;
    const rawSource = categories.find(c => !NON_PRODUCT_CATS.has(c)) || 'Microsoft 365 Roadmap';
    const source    = normalizeSource(rawSource);

    // Drop non-PP Microsoft 365 app sources
    if (ROADMAP_EXCLUDE_SOURCES.has(rawSource) || ROADMAP_EXCLUDE_SOURCES.has(source)) continue;

    const summary = (item.contentSnippet || item.description || '')
      .replace(/<[^>]+>/g, '').trim().slice(0, 600);

    const entry = {
      title:  (item.title || '').trim(),
      summary,
      source,
      url:    item.link || item.guid || '',
      date:   item.isoDate || item.pubDate || new Date().toISOString(),
    };
    if (status) entry.status = status;
    const parsedDates = parseRoadmapDates(summary);
    if (parsedDates.previewDate) entry.previewDate = parsedDates.previewDate;
    if (parsedDates.gaDate)      entry.gaDate      = parsedDates.gaDate;
    result.push(entry);
  }

  result.sort((a, b) => new Date(b.date) - new Date(a.date));
  console.log(`  → ${result.length} items`);
  return result;
}

async function fetchReleaseNotes() {
  console.log('\n[releasenotes] Loading blog feeds…');
  const allItems = [];

  for (const { url, product, skipFilter } of RELEASE_FEEDS) {
    console.log(`  → ${url} [${product}]${skipFilter ? ' (no filter)' : ''}`);
    const items = await fetchFeed(url);
    for (const item of items) {
      const title = (item.title || '').toLowerCase();
      if (!skipFilter && !RELEASE_KEYWORDS.some(kw => title.includes(kw))) continue;
      allItems.push({
        title:   (item.title || '').trim(),
        summary: (item.contentSnippet || item.summary || item.content || '')
          .replace(/<[^>]+>/g, '').trim().slice(0, 500),
        source:  item.creator || new URL(url).hostname,
        product,
        url:     item.link || item.guid || '',
        date:    item.isoDate || item.pubDate || new Date().toISOString(),
      });
    }
    await sleep(300);
  }

  const seen = new Set();
  const unique = allItems.filter(a => {
    if (!a.url || seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });

  unique.sort((a, b) => new Date(b.date) - new Date(a.date));
  console.log(`  → ${unique.length} release notes`);
  return unique;
}

async function fetchReleasePlan() {
  const wave = getCurrentWave();
  const label = waveLabel(wave);
  console.log(`\n[releasewave] Loading ${label} plan…`);
  const allItems = [];

  for (const { scope, product } of WAVE_PRODUCTS) {
    const scopeId = `${scope}-${wave}`;
    const url = `https://learn.microsoft.com/api/search/rss?locale=en-us&$filter=scopes%2Fany(t%3A%20t%20eq%20%27${scopeId}%27)`;
    console.log(`  → ${product} [${scopeId}]`);
    const items = await fetchFeed(url);

    for (const item of items) {
      const title = (item.title || '').trim();
      // Skip overview / investment-area items (not individual features)
      if (WAVE_OVERVIEW_RE.some(re => re.test(title))) continue;

      allItems.push({
        title,
        summary: (item.contentSnippet || item.summary || item.content || '')
          .replace(/<[^>]+>/g, '').trim().slice(0, 500),
        source:  'Release Wave Plan',
        product,
        url:     item.link || item.guid || '',
        date:    item.isoDate || item.pubDate || new Date().toISOString(),
      });
    }
    await sleep(300);
  }

  const seen = new Set();
  const unique = allItems.filter(a => {
    if (!a.url || seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });

  unique.sort((a, b) => new Date(b.date) - new Date(a.date));
  console.log(`  → ${unique.length} planned features (${label})`);
  return { items: unique, wave, label };
}

// ── Housekeeping ─────────────────────────────────────────────────────────────

function deleteOldFiles() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_AGE_DAYS);
  const files = fs.readdirSync(NEWS_DIR);
  let deleted = 0;
  for (const file of files) {
    if (file === 'index.json') continue;
    const match = file.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
    if (!match) continue;
    if (new Date(match[1]) < cutoff) {
      fs.unlinkSync(path.join(NEWS_DIR, file));
      console.log(`  [ARCHIVE] Deleted: ${file}`);
      deleted++;
    }
  }
  if (deleted === 0) console.log('  [ARCHIVE] No old files to delete');
}

function updateIndex(today) {
  const files = fs.readdirSync(NEWS_DIR);
  const dates = files
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.replace('.json', ''))
    .sort((a, b) => b.localeCompare(a));
  const index = { latest: today, dates };
  fs.writeFileSync(path.join(NEWS_DIR, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`\n[INDEX] ${dates.length} days available, latest: ${today}`);
}

// ── Fabric Roadmap scraper (Puppeteer) ───────────────────────────────────────

// Known roadmap categories from roadmap.fabric.microsoft.com left sidebar.
// These are deliberately hardcoded to avoid accidentally navigating forum pages.
const FABRIC_ROADMAP_CATEGORIES = [
  'Administration, Governance and Security',
  'Cosmos DB',
  'Data Engineering',
  'Data Factory',
  'Data Science',
  'Data Warehouse',
  'Fabric Developer Experiences',
  'Fabric Ecosystem',
  'IQ',
  'OneLake',
  'Power BI',
  'Real-Time Intelligence',
  'Databases',
];

// Titles that are actually UI labels / filter buttons / empty-state messages — not real features
const FABRIC_INVALID_TITLES = new Set([
  'All features planned',
  'All features planned and released',
  'All features recently released',
  'Planned',
  'Try Now',
  'All',
]);
// Prefix patterns that indicate non-feature content
const FABRIC_INVALID_PREFIXES = [
  "we didn't find any results",
  "no results",
  "no features",
];

// Extract feature items currently visible in the DOM for a given category.
// Called repeatedly while scrolling to handle lazy-loaded / virtual-scrolled pages.
function extractVisibleFeatures(catName, invalidTitles, invalidPrefixes) {
  const results    = [];
  const STATUS_ARR = ['Planned', 'Try Now'];

  // Use innerText (rendered text only, ignores SVG titles and display:none)
  // so we reliably find only the visible badge elements.
  const allEls = [...document.querySelectorAll('*')];

  // Pre-filter by textContent (cheap), then verify with innerText (accurate)
  const candidates = allEls.filter(el => {
    const tc = el.textContent.trim();
    return tc === 'Planned' || tc === 'Try Now';
  });

  // Keep only the deepest element in each parent→child chain
  // (avoids processing both a wrapper div AND its inner span for the same badge)
  const badges = candidates.filter(el =>
    !candidates.some(other => other !== el && el.contains(other))
  );

  const seen = new Set();

  for (const badge of badges) {
    // Use innerText for the status text — empty string means element is hidden
    const statusText = (badge.innerText || '').trim();
    if (!STATUS_ARR.includes(statusText)) continue; // hidden or mis-matched

    // Walk up to find a row container that:
    //   • has a link inside (feature titles are links on Fabric Roadmap)
    //   • has reasonable innerText length (not a whole-section wrapper)
    let row = badge.parentElement;
    let found = false;
    for (let i = 0; i < 14 && row; i++) {
      const innerLen = (row.innerText || '').trim().length;
      if (innerLen > 15 && innerLen < 2000 && row.querySelector('a[href]')) {
        found = true;
        break;
      }
      row = row.parentElement;
    }
    if (!found || !row) continue;

    // Title: prefer the first link text in the row
    const rowLink = row.querySelector('a[href]');
    let title = null;
    if (rowLink) {
      const lt = (rowLink.innerText || rowLink.textContent || '').trim();
      if (lt.length > 8 && !STATUS_ARR.includes(lt) &&
          !invalidTitles.includes(lt) &&
          !invalidPrefixes.some(p => lt.toLowerCase().startsWith(p)) &&
          lt !== catName) {
        title = lt;
      }
    }

    // Fallback: first non-date, non-badge line in the row's innerText
    if (!title) {
      const isDateLike = s => /^Q[1-4]\s*\d{4}$|^\d{4}$|^H[12]/.test(s);
      const isBadgeStr = s =>
        ['planned','try now','public preview','general availability','preview','ga']
          .includes(s.toLowerCase());
      const lines = (row.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
      title = lines.find(l =>
        l.length > 8 && !isDateLike(l) && !isBadgeStr(l) &&
        !invalidTitles.includes(l) &&
        !invalidPrefixes.some(p => l.toLowerCase().startsWith(p)) &&
        l !== catName
      );
    }

    if (!title || seen.has(title)) continue;
    seen.add(title);

    const ft = row.innerText || '';
    const pm = ft.match(/Public Preview\s*(Q[1-4]\s*\d{4}|\d{4})/i);
    const gm = ft.match(/General Availability\s*(Q[1-4]\s*\d{4}|\d{4})/i);

    results.push({
      title,
      category:    catName,
      status:      statusText,
      previewDate: pm ? pm[1].replace(/\s+/, ' ') : '',
      gaDate:      gm ? gm[1].replace(/\s+/, ' ') : '',
      url:         rowLink ? rowLink.href : '',
    });
  }

  return results;
}

async function fetchFabricRoadmap() {
  console.log('\n[fabricroadmap] Launching headless browser…');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    // Wider viewport renders more grid columns → more items visible per scroll step
    await page.setViewport({ width: 1440, height: 900 });

    console.log('  → Navigating to roadmap.fabric.microsoft.com…');
    await page.goto('https://roadmap.fabric.microsoft.com/', {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });
    await sleep(3000);

    const allFeatures = [];

    for (const catName of FABRIC_ROADMAP_CATEGORIES) {
      console.log(`  → Category: ${catName}`);

      // Scroll to top so the sidebar link is visible before clicking
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(300);

      const clicked = await page.evaluate((name) => {
        const all = [...document.querySelectorAll('a, button, li, [role="menuitem"]')];
        // Exact match first; then prefix match for "Category (22)" style labels
        const match =
          all.find(el => el.textContent.trim() === name) ||
          all.find(el => {
            const t = el.textContent.trim();
            return t.startsWith(name) && (t.length === name.length || /^[\s(]/.test(t[name.length]));
          });
        if (match) { match.click(); return true; }
        return false;
      }, catName);

      if (!clicked) {
        console.log(`    → Not found, skipping`);
        continue;
      }
      await sleep(2000); // Wait for filtered content to render

      // --- Scroll-based extraction ---
      // Handles lazy-loaded AND virtual-scrolled pages by collecting items
      // at every scroll position and deduplicating by title.
      const seenTitles = new Set();
      const categoryFeatures = [];

      const collectVisible = async () => {
        const visible = await page.evaluate(
          extractVisibleFeatures,
          catName, [...FABRIC_INVALID_TITLES], FABRIC_INVALID_PREFIXES
        );
        let foundNew = false;
        for (const f of visible) {
          if (!seenTitles.has(f.title)) {
            seenTitles.add(f.title);
            categoryFeatures.push(f);
            foundNew = true;
          }
        }
        return foundNew;
      };

      // Initial extraction (top of page)
      await collectVisible();

      // Scroll down in steps; stop when bottom is reached or nothing new appears
      let noNewStreak = 0;
      for (let step = 1; step <= 40; step++) {
        await page.evaluate((s) => window.scrollTo(0, s * 500), step);
        await sleep(700); // Give the SPA time to render newly visible items

        const foundNew = await collectVisible();
        noNewStreak = foundNew ? 0 : noNewStreak + 1;

        const atBottom = await page.evaluate(() =>
          Math.ceil(window.scrollY + window.innerHeight) >= document.body.scrollHeight
        );
        if (atBottom || noNewStreak >= 5) break;
      }

      console.log(`    → ${categoryFeatures.length} features`);
      allFeatures.push(...categoryFeatures);
    }

    console.log(`\n  → Total Fabric Roadmap features: ${allFeatures.length}`);

    return allFeatures.map(f => ({
      title:   f.title,
      summary: [
        f.previewDate ? `Public Preview: ${f.previewDate}` : '',
        f.gaDate      ? `General Availability: ${f.gaDate}` : '',
      ].filter(Boolean).join(' · ') || 'See Microsoft Fabric Roadmap for details.',
      source:      'Fabric Roadmap',
      product:     f.category,
      status:      f.status,
      url:         f.url || 'https://roadmap.fabric.microsoft.com/',
      date:        new Date().toISOString(),
      previewDate: f.previewDate || undefined,
      gaDate:      f.gaDate      || undefined,
    }));

  } catch (err) {
    console.warn(`  [WARN] Fabric Roadmap scrape failed: ${err.message}`);
    return [];
  } finally {
    await browser.close();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n=== Roadmap Fetch: ${today} ===`);
  fs.mkdirSync(NEWS_DIR, { recursive: true });

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayPath = path.join(NEWS_DIR, `${yesterday.toISOString().slice(0, 10)}.json`);
  const yesterdayUrls = loadUrlSet(yesterdayPath);
  const yesterdayFabricDates = loadFabricDateMap(yesterdayPath);
  console.log(`  [NEW] Comparing against ${yesterdayUrls.size} articles from yesterday`);

  // Fetch in priority order — release plan last so it can't block main data
  const copilotItems      = await fetchRoadmapTab('copilot');
  await sleep(800);                                 // breathing room between same-URL requests
  const agentsItems       = await fetchRoadmapTab('agents');
  const releaseNotesItems = await fetchReleaseNotes();
  const releasePlan       = await fetchReleasePlan();

  // Merge Release Wave planned features into Release Notes
  // Mark them with planned:true so the UI can show a badge
  for (const item of releasePlan.items) {
    item.planned    = true;
    item.waveLabel  = releasePlan.label;   // e.g. "2026 Release Wave 1"
  }
  const mergedReleaseNotes = [...releaseNotesItems, ...releasePlan.items]
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const fabricItems = await fetchFabricRoadmap();
  for (const item of fabricItems) {
    const key = item.url || item.title;
    const priorDate = yesterdayFabricDates.get(key);
    if (priorDate) item.date = priorDate; // seen before — keep its original first-seen date
  }

  const tabs = {
    copilot:       copilotItems,
    agents:        agentsItems,
    releasenotes:  mergedReleaseNotes,
    fabricroadmap: fabricItems,
  };

  // Mark articles new vs. yesterday
  for (const articles of Object.values(tabs)) {
    for (const a of articles) {
      if (a.url && !yesterdayUrls.has(a.url)) a.isNew = true;
    }
  }

  const output = {
    date:       today,
    updated:    new Date().toISOString(),
    wave:       releasePlan.wave,       // e.g. "261"
    waveLabel:  releasePlan.label,      // e.g. "2026 Release Wave 1"
    tabs,
  };

  const outPath = path.join(NEWS_DIR, `${today}.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n[OK] Written: ${outPath}`);

  deleteOldFiles();
  updateIndex(today);
  console.log('\n=== Done ===');
  process.exit(0);
}

main().catch(err => { console.error('Error:', err); process.exit(1); });
