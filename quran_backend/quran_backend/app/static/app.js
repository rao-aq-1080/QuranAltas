const API_BASE = '';
const STORAGE_KEYS = {
  bookmarks: 'quran-atlas-bookmarks',
  history: 'quran-atlas-history',
  theme: 'quran-atlas-theme',
  translation: 'quran-atlas-translation'
};

const state = {
  bookmarks: loadJson(STORAGE_KEYS.bookmarks, []),
  history: loadJson(STORAGE_KEYS.history, []),
  searchResults: [],
  surahs: [],
  currentSurah: null,
  currentTheme: null,
  compareVerses: [],
  assistantAnswer: '',
  assistantSources: [],
  assistantModel: 'Ready',
  assistantBusy: false,
  translationEnabled: loadJson(STORAGE_KEYS.translation, true)
};

function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function verseKey(v) {
  return `${v.surah}:${v.ayah}`;
}

function tabButtons() {
  return Array.from(document.querySelectorAll('.tab-btn'));
}

function panels() {
  return Array.from(document.querySelectorAll('.tab-panel'));
}

function setActiveTab(tab) {
  tabButtons().forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
  panels().forEach(panel => panel.classList.toggle('active', panel.id === tab));
}

tabButtons().forEach(btn => {
  btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
});

function showLoading(container, label = 'Loading...') {
  container.innerHTML = `<div class="loading-state">${esc(label)}</div>`;
}

function showError(container, message) {
  container.innerHTML = `<div class="error-state">${esc(message)}</div>`;
}

function showEmpty(container, message) {
  container.innerHTML = `<div class="empty-state">${esc(message)}</div>`;
}

function getVisibleTranslation(v) {
  return state.translationEnabled ? `<div class="verse-translation">${esc(v.translation || '')}</div>` : '';
}

function isBookmarked(v) {
  return state.bookmarks.some(item => verseKey(item) === verseKey(v));
}

function addBookmark(v) {
  if (isBookmarked(v)) return;
  state.bookmarks = [{ ...v, savedAt: new Date().toISOString() }, ...state.bookmarks].slice(0, 50);
  saveJson(STORAGE_KEYS.bookmarks, state.bookmarks);
  renderLibrary();
  renderHeroCounts();
  if (state.searchResults.length) renderSearchResults();
}

function removeBookmark(key) {
  state.bookmarks = state.bookmarks.filter(item => verseKey(item) !== key);
  saveJson(STORAGE_KEYS.bookmarks, state.bookmarks);
  renderLibrary();
  renderHeroCounts();
  renderSearchResults();
}

function addHistory(query) {
  if (!query) return;
  state.history = [
    { query, at: new Date().toISOString() },
    ...state.history.filter(item => item.query !== query)
  ].slice(0, 12);
  saveJson(STORAGE_KEYS.history, state.history);
  renderLibrary();
  renderHeroCounts();
}

function clearHistory() {
  state.history = [];
  saveJson(STORAGE_KEYS.history, state.history);
  renderLibrary();
  renderHeroCounts();
}

function clearBookmarks() {
  state.bookmarks = [];
  saveJson(STORAGE_KEYS.bookmarks, state.bookmarks);
  renderLibrary();
  renderHeroCounts();
  renderSearchResults();
}

function verseCardHtml(v) {
  const scoreHtml = v.score !== undefined && v.score !== null ? `<span class="verse-score">${Number(v.score).toFixed(2)}</span>` : '';
  const surahLabel = v.surah_name ? `${esc(v.surah_name)} ` : '';
  const bookmarkLabel = isBookmarked(v) ? 'Saved' : 'Save';
  return `
    <article class="verse-card">
      <div class="verse-meta">
        <span class="verse-title">${surahLabel}${v.surah}:${v.ayah}</span>
        <span>${scoreHtml}</span>
      </div>
      <div class="verse-arabic">${esc(v.arabic || '')}</div>
      ${getVisibleTranslation(v)}
      <div class="verse-actions">
        <button class="small-btn" data-action="bookmark" data-key="${verseKey(v)}">${bookmarkLabel}</button>
        <button class="small-btn" data-action="copy" data-key="${verseKey(v)}">Copy verse</button>
      </div>
    </article>
  `;
}

function renderHeroCounts() {
  document.getElementById('bookmark-count').textContent = String(state.bookmarks.length);
  document.getElementById('history-count').textContent = String(state.history.length);
}

function renderLibrary() {
  const bookmarkList = document.getElementById('bookmark-list');
  const historyList = document.getElementById('history-list');
  const bookmarkHtml = state.bookmarks.length ? state.bookmarks.map(v => `
    <div class="bookmark-item">
      <div class="bookmark-top">
        <div class="bookmark-title">${esc(v.surah_name || 'Verse')} ${v.surah}:${v.ayah}</div>
        <button class="small-btn" data-action="remove-bookmark" data-key="${verseKey(v)}">Remove</button>
      </div>
      <div class="muted">${esc(v.translation || '')}</div>
    </div>
  `).join('') : '<div class="empty-state">No bookmarks yet.</div>';

  const historyHtml = state.history.length ? state.history.map(item => `
    <div class="history-item">
      <div class="history-top">
        <div class="history-query">${esc(item.query)}</div>
        <div class="history-time">${new Date(item.at).toLocaleString()}</div>
      </div>
      <button class="small-btn" data-action="reuse-history" data-query="${esc(item.query)}">Search again</button>
    </div>
  `).join('') : '<div class="empty-state">No recent searches.</div>';

  bookmarkList.innerHTML = bookmarkHtml;
  historyList.innerHTML = historyHtml;

  bookmarkList.querySelectorAll('[data-action="remove-bookmark"]').forEach(btn => {
    btn.addEventListener('click', () => removeBookmark(btn.dataset.key));
  });
  historyList.querySelectorAll('[data-action="reuse-history"]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('search-input').value = btn.dataset.query;
      runSearch();
      setActiveTab('search');
    });
  });
}

function renderSearchResults() {
  const searchResults = document.getElementById('search-results');
  const filterSurah = document.getElementById('filter-surah').value.trim().toLowerCase();
  const filtered = state.searchResults.filter(v => !filterSurah || String(v.surah_name || '').toLowerCase().includes(filterSurah));
  if (!filtered.length) {
    showEmpty(searchResults, 'No results found for the current filters.');
    return;
  }
  searchResults.innerHTML = filtered.map(verseCardHtml).join('');
  attachVerseActions(searchResults);
}

function renderCompare() {
  const compareResults = document.getElementById('compare-results');
  if (!state.compareVerses.length) {
    compareResults.innerHTML = '<div class="empty-state">Enter two verse references and compare them here.</div>';
    return;
  }
  compareResults.innerHTML = `
    <div class="compare-grid">
      <div class="compare-card">${verseCardHtml(state.compareVerses[0])}</div>
      <div class="compare-card">${verseCardHtml(state.compareVerses[1])}</div>
    </div>
  `;
  attachVerseActions(compareResults);
}

function renderAssistant() {
  document.getElementById('assistant-answer').innerHTML = esc(state.assistantAnswer || 'Your answer will appear here.');
  document.getElementById('assistant-model').textContent = state.assistantModel || 'Ready';
  const assistantSources = document.getElementById('assistant-sources');
  if (!state.assistantSources.length) {
    assistantSources.innerHTML = '<div class="empty-state">No sources yet. Ask a Quran or Islam question to see grounded verses.</div>';
    return;
  }
  assistantSources.innerHTML = state.assistantSources.map(source => `
    <article class="assistant-source-card">
      <div class="assistant-source-top">
        <strong>${esc(source.surah_name || 'Verse')} ${source.surah}:${source.ayah}</strong>
        <span class="assistant-source-meta">${esc(source.cluster_label || '')}</span>
      </div>
      <div class="assistant-source-arabic">${esc(source.arabic || '')}</div>
      <div class="assistant-source-translation">${esc(source.translation || '')}</div>
    </article>
  `).join('');
}

function attachVerseActions(container) {
  container.querySelectorAll('[data-action="bookmark"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const verse = state.searchResults.find(item => verseKey(item) === btn.dataset.key) || state.currentSurahVerses?.find(item => verseKey(item) === btn.dataset.key) || state.themeVerses?.find(item => verseKey(item) === btn.dataset.key) || state.compareVerses?.find(item => verseKey(item) === btn.dataset.key);
      if (verse) addBookmark(verse);
    });
  });
  container.querySelectorAll('[data-action="copy"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const verse = state.searchResults.find(item => verseKey(item) === btn.dataset.key) || state.currentSurahVerses?.find(item => verseKey(item) === btn.dataset.key) || state.themeVerses?.find(item => verseKey(item) === btn.dataset.key) || state.compareVerses?.find(item => verseKey(item) === btn.dataset.key);
      if (verse) {
        await navigator.clipboard.writeText(`${verse.surah}:${verse.ayah} ${verse.arabic}\n${verse.translation || ''}`);
      }
    });
  });
}

// Search tab
const searchInput = document.getElementById('search-input');
const searchLimit = document.getElementById('search-limit');
const searchBtn = document.getElementById('search-btn');
const searchResults = document.getElementById('search-results');
const searchStatus = document.getElementById('search-status');
const translationToggle = document.getElementById('translation-toggle');

function setSearchStatus(message) {
  if (searchStatus) {
    searchStatus.textContent = message;
  }
}

async function runSearch() {
  const q = searchInput.value.trim();
  if (!q) return;
  showLoading(searchResults);
  setSearchStatus('Searching with the cloud semantic index…');
  try {
    const topK = Number(searchLimit.value || 10);
    const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(q)}&top_k=${topK}`);
    if (!res.ok) throw new Error(`Search failed (${res.status})`);
    const data = await res.json();
    state.searchResults = Array.isArray(data) ? data : [];
    addHistory(q);
    renderSearchResults();
    setSearchStatus('Semantic search completed using the configured vector backend.');
  } catch (e) {
    showError(searchResults, e.message);
    setSearchStatus('Search failed.');
  }
}

searchBtn.addEventListener('click', runSearch);
searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
document.getElementById('filter-surah').addEventListener('input', renderSearchResults);
translationToggle.checked = state.translationEnabled;
translationToggle.addEventListener('change', () => {
  state.translationEnabled = translationToggle.checked;
  saveJson(STORAGE_KEYS.translation, state.translationEnabled);
  renderSearchResults();
  renderSurahVerses();
  renderThemeVerses();
  renderCompare();
  renderAssistant();
});
document.getElementById('clear-search-history').addEventListener('click', clearHistory);
document.getElementById('clear-bookmarks').addEventListener('click', clearBookmarks);

// Surah browser
const surahList = document.getElementById('surah-list');
const surahStatus = document.getElementById('surah-status');
const surahNumber = document.getElementById('surah-number');
const loadSurahBtn = document.getElementById('load-surah-btn');
const surahResults = document.getElementById('surah-results');

async function loadSurahs() {
  showLoading(surahList, 'Loading surahs...');
  try {
    const res = await fetch(`${API_BASE}/surahs`);
    if (!res.ok) throw new Error(`Failed to load surahs (${res.status})`);
    state.surahs = await res.json();
    document.getElementById('surah-count').textContent = String(state.surahs.length || 114);
    surahStatus.textContent = `${state.surahs.length} surahs ready`;
    surahList.innerHTML = state.surahs.map(item => `
      <div class="browse-item${state.currentSurah === item.surah ? ' active' : ''}" data-surah="${item.surah}">
        <div>
          <div class="verse-title">${esc(item.surah_name)}</div>
          <div class="meta">Surah ${item.surah}</div>
        </div>
        <div class="theme-id">${item.ayah_count} ayahs</div>
      </div>
    `).join('');
    surahList.querySelectorAll('[data-surah]').forEach(btn => {
      btn.addEventListener('click', () => loadSurah(Number(btn.dataset.surah)));
    });
  } catch (e) {
    showError(surahList, e.message);
  }
}

async function loadSurah(surahId) {
  showLoading(surahResults);
  try {
    const res = await fetch(`${API_BASE}/surahs/${surahId}?limit=50`);
    if (!res.ok) throw new Error(`Failed to load surah ${surahId} (${res.status})`);
    const data = await res.json();
    state.currentSurah = surahId;
    state.currentSurahVerses = data.verses || [];
    surahNumber.value = surahId;
    surahList.querySelectorAll('[data-surah]').forEach(item => item.classList.toggle('active', Number(item.dataset.surah) === surahId));
    renderSurahVerses();
  } catch (e) {
    showError(surahResults, e.message);
  }
}

function renderSurahVerses() {
  if (!state.currentSurahVerses?.length) {
    showEmpty(surahResults, 'Pick a surah to begin reading.');
    return;
  }
  surahResults.innerHTML = state.currentSurahVerses.map(verseCardHtml).join('');
  attachVerseActions(surahResults);
}

loadSurahBtn.addEventListener('click', () => {
  const value = Number(surahNumber.value);
  if (value > 0) loadSurah(value);
});
surahNumber.addEventListener('keydown', e => { if (e.key === 'Enter') loadSurahBtn.click(); });

// Root lookup tab
const rootInput = document.getElementById('root-input');
const rootBtn = document.getElementById('root-btn');
const rootResults = document.getElementById('root-results');
const rootMeanings = document.getElementById('root-meanings');

async function runRootLookup() {
  const root = rootInput.value.trim();
  if (!root) return;
  showLoading(rootResults);
  rootMeanings.innerHTML = '';
  try {
    const res = await fetch(`${API_BASE}/root/${encodeURIComponent(root)}?limit=20`);
    if (!res.ok) throw new Error(`No results for root "${root}" (${res.status})`);
    const data = await res.json();
    rootMeanings.innerHTML = (data.meaning_candidates || [])
      .map(m => `<span class="chip">${esc(m.title)}: ${esc(m.translation)}</span>`).join('');
    rootResults.innerHTML = (data.verses || []).map(verseCardHtml).join('') || '<div class="empty-state">No verses found.</div>';
    attachVerseActions(rootResults);
  } catch (e) {
    showError(rootResults, e.message);
  }
}

rootBtn.addEventListener('click', runRootLookup);
rootInput.addEventListener('keydown', e => { if (e.key === 'Enter') runRootLookup(); });

// Themes tab
const themeList = document.getElementById('theme-list');
const themeResults = document.getElementById('theme-results');

async function loadThemes() {
  showLoading(themeList);
  try {
    const res = await fetch(`${API_BASE}/clusters`);
    if (!res.ok) throw new Error(`Failed to load themes (${res.status})`);
    const data = await res.json();
    themeList.innerHTML = Object.entries(data).map(([id, label]) => `
      <div class="theme-item${state.currentTheme === id ? ' active' : ''}" data-cluster-id="${id}">
        <div>
          <div class="verse-title">${esc(label)}</div>
          <div class="theme-id">Theme ${esc(id)}</div>
        </div>
      </div>
    `).join('');
    themeList.querySelectorAll('.theme-item').forEach(el => {
      el.addEventListener('click', () => loadThemeVerses(el.dataset.clusterId));
    });
  } catch (e) {
    showError(themeList, e.message);
  }
}

async function loadThemeVerses(clusterId) {
  showLoading(themeResults);
  try {
    const res = await fetch(`${API_BASE}/clusters/${clusterId}?limit=20`);
    if (!res.ok) throw new Error(`Failed to load verses (${res.status})`);
    const data = await res.json();
    state.currentTheme = String(clusterId);
    state.themeVerses = data.verses || [];
    themeResults.innerHTML = state.themeVerses.map(verseCardHtml).join('') || '<div class="empty-state">No verses found.</div>';
    attachVerseActions(themeResults);
  } catch (e) {
    showError(themeResults, e.message);
  }
}

function renderThemeVerses() {
  if (state.themeVerses?.length) {
    themeResults.innerHTML = state.themeVerses.map(verseCardHtml).join('');
    attachVerseActions(themeResults);
  }
}

// Compare tab
const compareABtn = document.getElementById('compare-btn');
const compareResults = document.getElementById('compare-results');

async function loadVerse(surah, ayah) {
  const res = await fetch(`${API_BASE}/verse/${surah}/${ayah}`);
  if (!res.ok) throw new Error(`Missing verse ${surah}:${ayah}`);
  return res.json();
}

async function runCompare() {
  const aSurah = Number(document.getElementById('compare-a-surah').value);
  const aAyah = Number(document.getElementById('compare-a-ayah').value);
  const bSurah = Number(document.getElementById('compare-b-surah').value);
  const bAyah = Number(document.getElementById('compare-b-ayah').value);
  if (!aSurah || !aAyah || !bSurah || !bAyah) {
    showError(compareResults, 'Enter two complete verse references.');
    return;
  }

  showLoading(compareResults, 'Comparing verses...');
  try {
    const [verseA, verseB] = await Promise.all([loadVerse(aSurah, aAyah), loadVerse(bSurah, bAyah)]);
    state.compareVerses = [verseA, verseB];
    compareResults.innerHTML = `
      <div class="compare-grid">
        <div class="compare-card">${verseCardHtml(verseA)}</div>
        <div class="compare-card">${verseCardHtml(verseB)}</div>
      </div>
    `;
    attachVerseActions(compareResults);
  } catch (e) {
    showError(compareResults, e.message);
  }
}

compareABtn.addEventListener('click', runCompare);

// Assistant tab
const assistantInput = document.getElementById('assistant-input');
const assistantBtn = document.getElementById('assistant-btn');

async function runAssistant() {
  const question = assistantInput.value.trim();
  if (!question) return;

  state.assistantBusy = true;
  state.assistantModel = 'Thinking...';
  state.assistantAnswer = 'Searching the Quran data and preparing a grounded answer...';
  state.assistantSources = [];
  renderAssistant();

  try {
    const res = await fetch(`${API_BASE}/assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, top_k: 6 })
    });
    if (!res.ok) {
      throw new Error(`Assistant request failed (${res.status})`);
    }
    const data = await res.json();
    state.assistantAnswer = data.answer || 'No answer returned.';
    state.assistantSources = data.sources || [];
    state.assistantModel = data.model ? `Model: ${data.model}` : 'Answered';
  } catch (e) {
    state.assistantAnswer = e.message;
    state.assistantModel = 'Error';
    state.assistantSources = [];
  } finally {
    state.assistantBusy = false;
    renderAssistant();
  }
}

assistantBtn.addEventListener('click', runAssistant);
assistantInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    runAssistant();
  }
});

document.querySelectorAll('[data-prompt]').forEach(btn => {
  btn.addEventListener('click', () => {
    assistantInput.value = btn.dataset.prompt;
    runAssistant();
    setActiveTab('assistant');
  });
});

// Library and initial state
renderHeroCounts();
renderLibrary();
loadSurahs();
loadThemes();
renderCompare();
renderAssistant();
setActiveTab('search');

// Make actions available from dynamically rendered content.
document.addEventListener('click', async event => {
  const action = event.target?.dataset?.action;
  if (action === 'bookmark') {
    const key = event.target.dataset.key;
    const verse = [state.searchResults, state.currentSurahVerses || [], state.themeVerses || [], state.compareVerses || []]
      .flat()
      .find(item => verseKey(item) === key);
    if (verse) addBookmark(verse);
  }
});
