(() => {
  'use strict';

  const INDEX_URL = './public/news/index.json';
  const FAVS_KEY   = 'msroadmap_favorites';
  const cache = {};
  let currentDate = null;

  // ── Product lines: single source of truth for filter chips, digest, colours ──
  const LINES = [
    { key: 'fabric',    label: 'Fabric' },
    { key: 'automate',  label: 'Power Automate' },
    { key: 'dataverse', label: 'Dataverse' },
    { key: 'bi',        label: 'Power BI' },
    { key: 'apps',      label: 'Power Apps' },
    { key: 'copilot',   label: 'Copilot' },
    { key: 'agents',    label: 'Agents' },
  ];
  const LINE_LABEL = Object.fromEntries(LINES.map(l => [l.key, l.label]));

  // Maps a release-notes article's `.product` field to a filter-chip line
  const RELEASE_PRODUCT_TO_LINE = {
    'Fabric':                'fabric',
    'Power BI':               'bi',
    'Power Apps':              'apps',
    'Power Automate':          'automate',
    'Power Pages':              'apps',
    'Power Platform':           'apps',
    'Power Platform Admin':     'apps',
    'Dataverse':              'dataverse',
    'Copilot Studio':          'copilot',
  };

  let activeChip         = 'all';   // 'all' | 'saved' | one of LINES[].key
  let activeFabricStatus = 'all';   // 'all' | 'Planned' | 'Try Now' — only applies when activeChip === 'fabric'
  let searchQuery   = '';
  let unifiedArticles = [];    // deduped articles for the currently loaded day

  const $ = id => document.getElementById(id);
  const updatedLabel    = $('updatedLabel');
  const errorBox        = $('errorBox');
  const spinner         = $('loadingSpinner');
  const gridEl          = $('grid');
  const emptyStateEl    = $('emptyState');
  const resultCountEl   = $('resultCount');
  const searchInputEl   = $('searchInput');
  const digestMonthName = $('digestMonthName');
  const digestStatsEl   = $('digestStats');

  // ── Favourites (localStorage) ────────────────────────────────
  // Stored as a Map: articleId (url|title) → full enriched article object
  let favorites = new Map();

  function loadFavorites() {
    try {
      const stored = JSON.parse(localStorage.getItem(FAVS_KEY) || '[]');
      favorites = new Map(stored.map(a => [a.url || a.title, a]));
    } catch { favorites = new Map(); }
  }

  function saveFavorites() {
    try {
      localStorage.setItem(FAVS_KEY, JSON.stringify([...favorites.values()]));
    } catch { /* storage full – fail silently */ }
  }

  function isFavorite(id) { return favorites.has(id); }

  function toggleFavorite(article) {
    const id = article.url || article.title;
    if (favorites.has(id)) favorites.delete(id);
    else favorites.set(id, article);
    saveFavorites();
    renderGrid();
  }

  loadFavorites();

  // ── Date helpers ─────────────────────────────────────────
  function formatDateLong(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  function formatTimestamp(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
      + ', ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function formatArticleDate(iso) {
    try { return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); }
    catch { return ''; }
  }

  function isThisMonth(iso) {
    try {
      const d = new Date(iso);
      const now = new Date();
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    } catch { return false; }
  }

  // "Qx YYYY" → current calendar quarter, e.g. August 2026 → "Q3 2026".
  // Fabric has no real per-item date, so this is used both to sort Fabric
  // tiles and to count "this quarter" items for the digest.
  function getCurrentQuarterLabel() {
    const now = new Date();
    const q = Math.floor(now.getMonth() / 3) + 1;
    return `Q${q} ${now.getFullYear()}`;
  }

  // Turns "Q3 2026" (or a bare "2026") into a comparable number, farthest-out first.
  function quarterSortKey(q) {
    if (!q) return 0;
    const m = q.match(/Q([1-4])\s*(\d{4})/i);
    if (m) return parseInt(m[2], 10) * 10 + parseInt(m[1], 10);
    const y = q.match(/(\d{4})/);
    return y ? parseInt(y[1], 10) * 10 : 0;
  }

  // Fabric has no meaningful "date added", so it sorts by status (Planned
  // before Try Now) and, within Planned, by target quarter — farthest out
  // first, working toward the nearest quarter. Try Now items keep their
  // original relative order (Array#sort is stable).
  function compareFabricItems(a, b) {
    const rankA = a.status === 'Planned' ? 0 : 1;
    const rankB = b.status === 'Planned' ? 0 : 1;
    if (rankA !== rankB) return rankA - rankB;
    if (rankA !== 0) return 0; // both Try Now — leave as-is
    return quarterSortKey(b.previewDate || b.gaDate) - quarterSortKey(a.previewDate || a.gaDate);
  }

  // All other articles keep normal newest-first date sorting. Only items
  // actually sourced from the Fabric Roadmap API use the status/quarter
  // rule — Fabric *blog* posts share the same "fabric" filter line but have
  // a real publish date, so they're excluded from this special case.
  function compareArticles(a, b) {
    if (a.source === 'Fabric Roadmap' && b.source === 'Fabric Roadmap') return compareFabricItems(a, b);
    return new Date(b.date) - new Date(a.date);
  }

  // ── UI helpers ───────────────────────────────────────────
  function showError(msg) { errorBox.textContent = msg; errorBox.classList.remove('hidden'); spinner.classList.add('hidden'); }
  function clearError()   { errorBox.classList.add('hidden'); errorBox.textContent = ''; }
  function setLoading(on) { spinner.classList.toggle('hidden', !on); }

  // ── Build the unified, deduplicated article list ─────────
  // Same article can appear in multiple source tabs (e.g. an M365 Roadmap
  // item matching both the Copilot and Agents keyword sets) — first tab
  // to claim a URL wins, later duplicates are skipped.
  function releaseNoteLine(article) {
    return RELEASE_PRODUCT_TO_LINE[article.product] || 'apps';
  }

  function buildUnifiedArticles(dayData) {
    const tabs = dayData.tabs || {};
    const seen = new Set();
    const unified = [];

    function addAll(articles, lineFor) {
      for (const a of articles || []) {
        const id = a.url || a.title;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const line = typeof lineFor === 'function' ? lineFor(a) : lineFor;
        unified.push({ ...a, line });
      }
    }

    addAll(tabs.fabricroadmap, 'fabric');
    addAll(tabs.releasenotes,  releaseNoteLine);
    addAll(tabs.copilot,       'copilot');
    addAll(tabs.agents,        'agents');

    return unified;
  }

  // ── Eyebrow label per article (line name + specific detail) ──
  function eyebrowFor(article) {
    if (article.source === 'Fabric Roadmap' && article.product) {
      return `Fabric &middot; ${escapeHtml(article.product)}`;
    }
    if (article.line === 'fabric' && article.product && article.product !== 'Fabric') {
      return `Fabric &middot; ${escapeHtml(article.product)}`;
    }
    // Release-notes items: product name is already descriptive
    if (article.product && RELEASE_PRODUCT_TO_LINE[article.product]) {
      return escapeHtml(article.product);
    }
    // Roadmap-sourced copilot/agents items: no `.product`, use `.source`
    if (article.source) {
      return `${LINE_LABEL[article.line]} &middot; ${escapeHtml(article.source)}`;
    }
    return LINE_LABEL[article.line] || '';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ── Status info per article (colour dot + label) ──────────
  function statusInfoFor(article) {
    if (article.status) {
      const map = {
        'Launched':        { cls: 'status-ga',       label: article.status },
        'Rolling out':      { cls: 'status-rollout', label: article.status },
        'In development':   { cls: 'status-planned', label: article.status },
        'Cancelled':        { cls: 'line-agents',    label: article.status },
      };
      return map[article.status] || { cls: 'status-planned', label: article.status };
    }
    if (article.planned) {
      const m = (article.waveLabel || '').match(/(\d{4})\s+Release\s+Wave\s+(\d)/i);
      return { cls: 'status-planned', label: m ? `Planned &middot; ${m[1]} W${m[2]}` : 'Planned' };
    }
    if (article.isNew) {
      return { cls: 'status-new', label: 'Neu' };
    }
    return null;
  }

  // ── Build a single tile ───────────────────────────────────
  function createTile(article) {
    const tile = document.createElement('article');
    tile.className = 'tile';
    tile.dataset.line = article.line;
    tile.dataset.id = article.url || article.title;
    tile.dataset.search = (article.title + ' ' + (article.summary || '')).toLowerCase();

    const eyebrow = document.createElement('div');
    eyebrow.className = 'tile-eyebrow';
    eyebrow.innerHTML = `<span class="dot line-${article.line}"></span>${eyebrowFor(article)}`;
    tile.appendChild(eyebrow);

    const title = document.createElement('h3');
    title.className = 'tile-title';
    if (article.url) {
      const a = document.createElement('a');
      a.href = article.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = article.title || '';
      title.appendChild(a);
    } else {
      title.textContent = article.title || '';
    }
    tile.appendChild(title);

    if (article.summary) {
      const desc = document.createElement('p');
      desc.className = 'tile-desc';
      desc.textContent = article.summary;
      tile.appendChild(desc);
    }

    const meta = document.createElement('div');
    meta.className = 'tile-meta';

    const statusInfo = statusInfoFor(article);
    if (statusInfo) {
      const status = document.createElement('span');
      status.className = 'status';
      status.innerHTML = `<span class="dot round ${statusInfo.cls}"></span>${statusInfo.label}`;
      meta.appendChild(status);
    } else {
      meta.appendChild(document.createElement('span')); // keep flex spacing
    }

    const actions = document.createElement('div');
    actions.className = 'tile-actions';

    // Fabric Roadmap items have no real "date added" — show their target
    // quarter instead. Fabric blog posts (same filter line, different
    // source) still have a real publish date, so they keep it.
    const date = document.createElement('span');
    date.className = 'date';
    date.textContent = article.source === 'Fabric Roadmap'
      ? (article.previewDate || article.gaDate || '')
      : formatArticleDate(article.date);
    actions.appendChild(date);

    const favId = article.url || article.title;
    const saved = isFavorite(favId);
    const favBtn = document.createElement('button');
    favBtn.className = 'tile-star' + (saved ? ' saved' : '');
    favBtn.setAttribute('aria-pressed', String(saved));
    favBtn.setAttribute('aria-label', saved ? 'Remove from saved' : 'Save');
    favBtn.title = saved ? 'Remove from saved' : 'Save';
    favBtn.textContent = '★';
    favBtn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      toggleFavorite(article);
    });
    actions.appendChild(favBtn);

    meta.appendChild(actions);
    tile.appendChild(meta);

    return tile;
  }

  // ── Digest ("This Month") ─────────────────────────────────
  function renderDigest(articles) {
    const now = new Date();
    digestMonthName.textContent = now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    // Fabric is counted separately below (no real "date added" to go by) —
    // excluded here entirely, including its blog posts, for one consistent rule.
    const monthly = articles.filter(a => a.line !== 'fabric' && isThisMonth(a.date));
    const counts = Object.fromEntries(LINES.map(l => [l.key, 0]));
    for (const a of monthly) if (counts[a.line] !== undefined) counts[a.line]++;

    // Fabric: only items that are Try Now (shipped) AND targeting the
    // current quarter — e.g. in August (Q3), only "Q3 2026" Try Now items count.
    const currentQuarter = getCurrentQuarterLabel();
    counts.fabric = articles.filter(a =>
      a.source === 'Fabric Roadmap' && a.status === 'Try Now' &&
      (a.previewDate === currentQuarter || a.gaDate === currentQuarter)
    ).length;

    digestStatsEl.innerHTML = '';
    for (const line of LINES) {
      const n = counts[line.key];
      const stat = document.createElement('div');
      stat.className = 'digest-stat' + (n === 0 ? ' digest-stat--zero' : '');
      stat.innerHTML = `
        <span class="n">${String(n).padStart(2, '0')}</span>
        <span class="label"><span class="dot line-${line.key}"></span>${line.label}</span>
      `;
      digestStatsEl.appendChild(stat);
    }
  }

  // ── Filter chips ───────────────────────────────────────────
  const fabricStatusBarEl = $('fabricStatusBar');

  function wireFilterChips() {
    document.querySelectorAll('.filterbar-inner .chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.filterbar-inner .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        activeChip = chip.dataset.chip;

        // Fabric status sub-filter only makes sense while viewing Fabric —
        // show/hide it and reset its selection whenever we enter/leave Fabric.
        const isFabric = activeChip === 'fabric';
        if (fabricStatusBarEl) fabricStatusBarEl.hidden = !isFabric;
        if (!isFabric) {
          activeFabricStatus = 'all';
          fabricStatusBarEl?.querySelectorAll('.chip').forEach(c =>
            c.classList.toggle('active', c.dataset.status === 'all')
          );
        }

        renderGrid();
      });
    });

    fabricStatusBarEl?.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        fabricStatusBarEl.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        activeFabricStatus = chip.dataset.status;
        renderGrid();
      });
    });
  }

  searchInputEl?.addEventListener('input', () => {
    searchQuery = searchInputEl.value.trim().toLowerCase();
    renderGrid();
  });

  // ── Render the grid according to current filters ─────────
  function renderGrid() {
    let list;
    if (activeChip === 'saved') {
      list = [...favorites.values()].reverse();
    } else if (activeChip === 'all') {
      list = unifiedArticles;
    } else {
      list = unifiedArticles.filter(a => a.line === activeChip);
      if (activeChip === 'fabric' && activeFabricStatus !== 'all') {
        list = list.filter(a => a.status === activeFabricStatus);
      }
    }

    if (searchQuery) {
      list = list.filter(a =>
        (a.title || '').toLowerCase().includes(searchQuery) ||
        (a.summary || '').toLowerCase().includes(searchQuery)
      );
    }

    gridEl.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const a of list) frag.appendChild(createTile(a));
    gridEl.appendChild(frag);

    resultCountEl.textContent = `${list.length} ${list.length === 1 ? 'Eintrag' : 'Einträge'}`;
    emptyStateEl.classList.toggle('hidden', list.length > 0);
  }

  // ── Render one loaded day ─────────────────────────────────
  function renderDay(dayData) {
    unifiedArticles = buildUnifiedArticles(dayData);
    unifiedArticles.sort(compareArticles);

    renderDigest(unifiedArticles);
    renderGrid();

    if (dayData.updated) updatedLabel.textContent = 'Updated: ' + formatTimestamp(dayData.updated);
  }

  // ── Load a day ───────────────────────────────────────────
  async function loadDay(dateStr) {
    if (cache[dateStr]) { renderDay(cache[dateStr]); return; }
    setLoading(true);
    clearError();
    try {
      const res = await fetch(`./public/news/${dateStr}.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      cache[dateStr] = data;
      renderDay(data);
    } catch (err) {
      showError(`Could not load data for ${formatDateLong(dateStr)}. (${err.message})`);
    } finally {
      setLoading(false);
    }
  }

  // ── Keep filter bar pinned directly below the masthead ────
  // The masthead's height varies (mobile vs desktop, text wrapping, font
  // load reflow), so a hardcoded `top` offset drifts out of sync — measure
  // it live instead and feed it to the filter bar's sticky `top` via a
  // CSS custom property.
  const mastheadEl = document.querySelector('.masthead');
  if (mastheadEl && 'ResizeObserver' in window) {
    const syncMastheadHeight = () => {
      document.documentElement.style.setProperty('--masthead-h', mastheadEl.offsetHeight + 'px');
    };
    new ResizeObserver(syncMastheadHeight).observe(mastheadEl);
    syncMastheadHeight();
  }

  // ── Back-to-top ───────────────────────────────────────────
  const backToTopBtn = $('backToTop');
  if (backToTopBtn) {
    window.addEventListener('scroll', () => {
      backToTopBtn.classList.toggle('back-to-top--visible', window.scrollY > 300);
    }, { passive: true });
    backToTopBtn.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  // ── Bootstrap ────────────────────────────────────────────
  async function init() {
    wireFilterChips();
    setLoading(true);
    clearError();
    let index;
    try {
      const res = await fetch(INDEX_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      index = await res.json();
    } catch (err) {
      showError('Could not load index. Please reload. (' + err.message + ')');
      return;
    }

    const dates  = index.dates  || [];
    const latest = index.latest || (dates[0] ?? null);

    if (!dates.length || !latest) {
      showError('No data yet. Please trigger the GitHub Actions workflow manually.');
      setLoading(false);
      return;
    }

    currentDate = latest;
    await loadDay(latest);
  }

  init();
})();
