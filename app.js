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

  let activeChip    = 'all';   // 'all' | 'saved' | one of LINES[].key
  let searchQuery   = '';
  let unifiedArticles = [];    // deduped articles for the currently loaded day

  const $ = id => document.getElementById(id);
  const datePicker      = $('datePicker');
  const updatedLabel    = $('updatedLabel');
  const errorBox        = $('errorBox');
  const spinner         = $('loadingSpinner');
  const dateToggleBtn   = $('dateToggleBtn');
  const dateToggleLabel = $('dateToggleLabel');
  const dateSheetEl     = $('dateSheet');
  const dateSheetBody   = $('dateSheetBody');
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

  // ── Mobile date bottom sheet ─────────────────────────────
  const isMobileView = () => window.matchMedia('(max-width: 767px)').matches;

  function openDateSheet() {
    if (!dateSheetEl) return;
    dateSheetEl.classList.add('open');
    document.body.classList.add('sheet-open');
    dateToggleBtn?.setAttribute('aria-expanded', 'true');
  }

  function closeDateSheet() {
    if (!dateSheetEl) return;
    dateSheetEl.classList.remove('open');
    document.body.classList.remove('sheet-open');
    dateToggleBtn?.setAttribute('aria-expanded', 'false');
  }

  function updateDateToggleLabel() {
    if (!dateToggleLabel || !currentDate) return;
    const [y, m, d] = currentDate.split('-').map(Number);
    dateToggleLabel.textContent = new Date(y, m - 1, d)
      .toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  function positionDatePicker() {
    const wrap = document.querySelector('.date-picker-wrap');
    if (!wrap || !dateSheetBody) return;
    if (isMobileView()) {
      if (!dateSheetBody.contains(datePicker)) dateSheetBody.appendChild(datePicker);
    } else {
      if (!wrap.contains(datePicker)) wrap.appendChild(datePicker);
      closeDateSheet();
    }
  }

  dateToggleBtn?.addEventListener('click', openDateSheet);
  dateSheetEl?.addEventListener('click', e => {
    if (e.target === dateSheetEl || e.target === $('dateSheetBackdrop')) closeDateSheet();
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDateSheet(); });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(positionDatePicker, 150);
  });

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

    const date = document.createElement('span');
    date.className = 'date';
    date.textContent = formatArticleDate(article.date);
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

    const monthly = articles.filter(a => isThisMonth(a.date));
    const counts = Object.fromEntries(LINES.map(l => [l.key, 0]));
    for (const a of monthly) if (counts[a.line] !== undefined) counts[a.line]++;

    digestStatsEl.innerHTML = '';
    for (const line of LINES) {
      const n = counts[line.key];
      if (!n) continue;
      const stat = document.createElement('div');
      stat.className = 'digest-stat';
      stat.innerHTML = `
        <span class="n">${String(n).padStart(2, '0')}</span>
        <span class="label"><span class="dot line-${line.key}"></span>${line.label}</span>
      `;
      digestStatsEl.appendChild(stat);
    }
  }

  // ── Filter chips ───────────────────────────────────────────
  function wireFilterChips() {
    document.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        activeChip = chip.dataset.chip;
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
    unifiedArticles.sort((a, b) => new Date(b.date) - new Date(a.date));

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

  // ── Date picker ──────────────────────────────────────────
  function buildDatePicker(dates, selected) {
    datePicker.innerHTML = '';
    for (const d of dates) {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = formatDateLong(d);
      if (d === selected) opt.selected = true;
      datePicker.appendChild(opt);
    }
  }

  datePicker.addEventListener('change', async () => {
    const d = datePicker.value;
    if (d && d !== currentDate) {
      currentDate = d;
      updateDateToggleLabel();
      closeDateSheet();
      await loadDay(d);
    }
  });

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

    buildDatePicker(dates, latest);
    currentDate = latest;
    positionDatePicker();
    updateDateToggleLabel();
    await loadDay(latest);
  }

  init();
})();
