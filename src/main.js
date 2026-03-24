import './input.css';
import { preprocessCalcBlocks } from './calcBlock.js';
import { invoke } from './tauri.js';
import { restoreStateCurrent, StateFlags } from '@tauri-apps/plugin-window-state';
import { CalendarWidget }    from './widgets/CalendarWidget.js';
import { MetadataWidget }    from './widgets/MetadataWidget.js';
import { ReferencesWidget }  from './widgets/ReferencesWidget.js';
import { PageWidget }        from './widgets/PageWidget.js';
import { ScratchPadWidget }  from './widgets/ScratchPadWidget.js';
import { FavoritesWidget }  from './widgets/FavoritesWidget.js';
import { BrowserWidget }     from './widgets/BrowserWidget.js';
import { CounterWidget }     from './widgets/CounterWidget.js';
import { SearchWidget }      from './widgets/SearchWidget.js';
import { createEditor, setEditorPages, placeholderCompartment } from './editor.js';
import { placeholder } from '@codemirror/view';
import { formatJournalDate } from './dateUtils.js';

// ── State ─────────────────────────────────────────

let currentFile   = null;
let datastorePath = null;  // set during init via get_datastore_path
let changeTimer   = null;
let saveTimer     = null;
let mdTimer       = null;

// ── DOM refs ──────────────────────────────────────

const editorDiv           = document.getElementById('editor');
const editorArea          = document.getElementById('editor-area');
const editorPane          = document.getElementById('editor-pane');
const vDivider        = document.getElementById('v-divider');
const markdownContent = document.getElementById('markdown-content');
const docTitle        = document.getElementById('doc-title');
const breadcrumbsEl   = document.getElementById('breadcrumbs');
const fileNameEl      = document.getElementById('file-name');
const modifiedEl      = document.getElementById('modified-indicator');
const indexStatusEl   = document.getElementById('index-status');
const cursorEl        = document.getElementById('cursor-info');

// Resize containers (used to cap sidebar sizes)
const contentRow   = document.getElementById('content-row');
const centerColumn = document.getElementById('center-column');

// Sidebar panel elements
const leftSidebar   = document.getElementById('left-sidebar');
const rightSidebar  = document.getElementById('right-sidebar');
const topSidebar    = document.getElementById('top-sidebar');
const bottomSidebar = document.getElementById('bottom-sidebar');

// Toolbar toggle buttons
const btnToggleLeft   = document.getElementById('btn-toggle-left');
const btnToggleRight  = document.getElementById('btn-toggle-right');
const btnToggleTop    = document.getElementById('btn-toggle-top');
const btnToggleBottom = document.getElementById('btn-toggle-bottom');

// Collapsed edge tabs (shown in place of hidden sidebars)
const collapsedLeft   = document.getElementById('collapsed-left');
const collapsedRight  = document.getElementById('collapsed-right');
const collapsedTop    = document.getElementById('collapsed-top');
const collapsedBottom = document.getElementById('collapsed-bottom');

// ── Helpers ───────────────────────────────────────

function basename(path) {
  return path.replace(/\\/g, '/').split('/').pop();
}

function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}


function setCurrentFile(path) {
  currentFile = path;
  const name = path ? basename(path) : 'Untitled';
  fileNameEl.textContent = name;
  document.title = `MoreInfo — ${name}`;
}

function setModified(val) {
  modifiedEl.textContent = val ? '●' : '';
}

function updateCursor(line, col) {
  cursorEl.textContent = `Ln ${line}, Col ${col}`;
}

// ── Date formatting ───────────────────────────────
// formatJournalDate() imported from dateUtils.js — use that as the single source.
const formatDateLong = formatJournalDate;

// ── Favorite helpers ──────────────────────────────

/** Returns true if the parsed metadata marks this page as a favorite. */
function isFavoritePage(fm) {
  if (!fm || !fm.favorite) return false;
  const v = fm.favorite;
  if (v.type === 'bool') return v.value === true;
  if (v.type === 'text') return v.value.toLowerCase() === 'true';
  return false;
}

/**
 * Toggle `favorite` in `content`.
 * - If `favorite: <bool>` already exists anywhere, flip it in place.
 * - If absent, append a sig block at the end (per MI metadata manipulation rule).
 */
function setFavoriteInContent(content, newVal) {
  const valStr = newVal ? 'true' : 'false';
  const existingRe = /^(favorite\s*:\s*)(?:true|false)(\s*)$/mi;
  if (existingRe.test(content)) {
    return content.replace(existingRe, `$1${valStr}$2`);
  }
  // Variable absent → find last sig delimiter and insert after it
  const allSigs = [...content.matchAll(/^-- $/mg)];
  if (allSigs.length > 0) {
    const last = allSigs[allSigs.length - 1];
    const nlIdx = content.indexOf('\n', last.index + last[0].length);
    const insertAt = nlIdx !== -1 ? nlIdx + 1 : content.length;
    return content.slice(0, insertAt) + `favorite: ${valStr}\n` + content.slice(insertAt);
  }
  // No sig block → create one
  const trailing = content.endsWith('\n') ? '' : '\n';
  return `${content}${trailing}\n-- \nfavorite: ${valStr}\n`;
}

// ── Title derivation ──────────────────────────────

function isJournalFile(path) {
  if (!path) return false;
  const norm = path.replace(/\\/g, '/');
  if (datastorePath) {
    const ds = datastorePath.replace(/\\/g, '/');
    return norm.startsWith(ds + '/journal/') && /\d{4}-\d{2}-\d{2}\.md$/.test(norm);
  }
  return /[/\\]journal[/\\]\d{4}-\d{2}-\d{2}\.md$/.test(norm);
}

let currentFav = false;

function updateDocTitle(fm, content) {
  let title = '';
  if (fm.title) {
    title = fm.title.type === 'date'
      ? formatDateLong(fm.title.value)
      : String(fm.title.value);
  } else if (isJournalFile(currentFile)) {
    title = formatDateLong(basename(currentFile).slice(0, 10));
  } else {
    const tagMatch = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (tagMatch) {
      title = tagMatch[1].trim();
    } else {
      const h1Match = content.match(/^#\s+(.+)$/m);
      if (h1Match) {
        title = h1Match[1].trim();
      } else if (currentFile) {
        title = basename(currentFile).replace(/\.[^.]+$/, '');
      }
    }
  }

  currentFav = isFavoritePage(fm);
  const icon    = isJournalFile(currentFile) ? 'ph-calendar-dot' : 'ph-file-text';
  const starCls = currentFav
    ? 'ph-fill ph-star text-amber-400'
    : 'ph ph-star text-olive-600 hover:text-olive-400';

  docTitle.innerHTML = `
    <div class="flex items-start justify-between gap-2 w-full">
      <span><i class="ph-bold ${icon} leading-none mr-2"></i>${escapeHtml(title)}</span>
      <button id="btn-favorite" title="${currentFav ? 'Remove from favorites' : 'Add to favorites'}"
        class="shrink-0 mt-0.5 transition-colors" style="pointer-events:auto">
        <i class="${starCls} text-base leading-none"></i>
      </button>
    </div>`;

  document.getElementById('btn-favorite').addEventListener('click', () => {
    const newFav = !currentFav;
    const newContent = setFavoriteInContent(cmView.state.doc.toString(), newFav);
    cmView.dispatch({
      changes: { from: 0, to: cmView.state.doc.length, insert: newContent },
      userEvent: 'favorite.toggle',
    });
    // Immediate save so the DB is updated right away
    if (currentFile) {
      invoke('write_file', { path: currentFile, content: newContent })
        .then(() => favoritesWidget?.refresh())
        .catch(console.error);
    }
  });
}

// ── Floating title bar: keep CM content paddingTop in sync ─────────────────
{
  const syncTitlePad = () => {
    const pt = docTitle.offsetHeight + 'px';
    const content = editorDiv.querySelector('.cm-content');
    if (content) content.style.paddingTop = pt;
  };
  new ResizeObserver(syncTitlePad).observe(docTitle);
  // Also observe the CM editor itself so we retry once CM is mounted
  new ResizeObserver(syncTitlePad).observe(editorDiv);
}

// ── CodeMirror editor ─────────────────────────────────────────────────────

let cmDocChangeTimer = null;
let cmAutoSaveTimer  = null;

const cmView = createEditor({
  parent: editorDiv,
  onDocChange(content) {
    setModified(true);
    clearTimeout(cmDocChangeTimer);
    cmDocChangeTimer = setTimeout(() => handleDocumentChange(content), 200);
    clearTimeout(cmAutoSaveTimer);
    cmAutoSaveTimer  = setTimeout(() => { if (currentFile) autoSave(content); }, 1000);
    if (editorArea.dataset.mode === 'render') scheduleMarkdown();
  },
  onCursorChange(line, col) {
    updateCursor(line, col);
  },
  onPageClick(title) {
    openWikiPage(title);
  },
  onCmdClick(title) {
    const lc   = title.toLowerCase();
    const page = allPages.find(
      p => p.title.toLowerCase() === lc ||
           (p.aliases || []).some(a => a === lc)
    );
    if (page) {
      const pw = mountedWidgets.find(w => w.id === 'page');
      if (pw) { pw.loadPath(page.path, page.title); return; }
    }
    // Page doesn't exist (or no PageWidget) — create/open in editor.
    openWikiPage(title);
  },
});

// Populate wiki-link autocomplete and keep a local copy for Cmd+Click resolution.
let allPages = [];
function refreshPages() {
  invoke('list_pages').then(pages => {
    allPages = pages;
    setEditorPages(pages);
  }).catch(console.error);
}
refreshPages();

// ── Render-mode v-divider resize ──────────────────

const MIN_W = 120;
const MAX_W = () => Math.floor(editorArea.offsetWidth * 0.85);

let vDragStartX = 0;
let vDragStartW = 0;

function onVDrag(e) {
  const delta = e.clientX - vDragStartX;
  const newW  = Math.max(MIN_W, Math.min(vDragStartW + delta, MAX_W()));
  editorPane.style.flex = `0 0 ${newW}px`;
}

function stopVDrag() {
  document.removeEventListener('mousemove', onVDrag);
  document.removeEventListener('mouseup',   stopVDrag);
  document.body.style.cursor     = '';
  document.body.style.userSelect = '';
}

vDivider.addEventListener('mousedown', e => {
  vDragStartX = e.clientX;
  vDragStartW = editorPane.offsetWidth;
  document.addEventListener('mousemove', onVDrag);
  document.addEventListener('mouseup',   stopVDrag);
  document.body.style.cursor     = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});

// ── Markdown rendering ─────────────────────────────

/**
 * Insert a blank line between every pair of consecutive non-blank lines so that
 * single newlines in the source act as paragraph breaks in the rendered output.
 * Fenced code blocks and @calc blocks are left untouched.
 */
function singleNewlinesToParagraphs(markdown) {
  const lines = markdown.split('\n');
  const out   = [];
  let inFence     = false;
  let inCalcBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i];
    const trimmed = line.trim();

    // Track fenced code blocks (``` or ~~~).
    if (!inCalcBlock && /^(`{3,}|~{3,})/.test(trimmed)) inFence = !inFence;

    // Track @calc blocks (only outside fences).
    if (!inFence) {
      if (trimmed === '@calc')  inCalcBlock = true;
      else if (inCalcBlock && trimmed === '') inCalcBlock = false;
    }

    out.push(line);

    // Insert a blank separator between consecutive non-blank content lines.
    if (!inFence && !inCalcBlock && i < lines.length - 1) {
      if (line !== '' && lines[i + 1] !== '') out.push('');
    }
  }

  return out.join('\n');
}

async function renderMarkdown() {
  try {
    const raw  = cmView.state.doc.toString();
    const html = await invoke('parse_markdown', { markdown: preprocessCalcBlocks(singleNewlinesToParagraphs(raw)) });
    markdownContent.innerHTML = html;
  } catch (e) {
    console.error('parse_markdown failed:', e);
  }
}


function scheduleMarkdown() {
  clearTimeout(mdTimer);
  mdTimer = setTimeout(renderMarkdown, 200);
}

// ── Document change routing ────────────────────────
//
// Single path for editor content changes. Parses metadata once and
// distributes the result to the doc title + all mounted widgets.

async function handleDocumentChange(content) {
  try {
    const metadata = await invoke('get_metadata', { content });
    updateDocTitle(metadata, content);
    mountedWidgets.forEach(w => w.onDocumentChange(content, metadata));
  } catch (e) {
    console.error('get_metadata failed:', e);
  }
}


// ── Auto-save ─────────────────────────────────────
//
// MI does not use an explicit open/save model. All pages live inside the
// datastore. Auto-save fires 1500 ms after the last keystroke.
//
// Path resolution:
//   Journal pages — currentFile is already set by open_journal.
//   New wiki pages — derive a slug from the title (metadata > <title> > h1),
//                    save to <datastore>/wiki/<slug>.md, then set currentFile.

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')   // strip punctuation
    .replace(/[\s_]+/g, '-')    // spaces/underscores → hyphen
    .replace(/-+/g, '-')        // collapse runs
    .replace(/^-+|-+$/g, '');   // trim edges
}

function deriveWikiSlug(content, metadata) {
  if (metadata.title && metadata.title.type !== 'date') {
    const s = slugify(String(metadata.title.value));
    if (s) return s;
  }
  const tagMatch = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (tagMatch) {
    const s = slugify(tagMatch[1].trim());
    if (s) return s;
  }
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) {
    const s = slugify(h1Match[1].trim());
    if (s) return s;
  }
  return null;
}

async function autoSave(content) {
  if (!content.trim()) return;

  let path = currentFile;

  if (!path) {
    if (!datastorePath) return;
    const metadata = await invoke('get_metadata', { content });
    const slug = deriveWikiSlug(content, metadata);
    if (!slug) return;  // no title yet — wait for the user to give it one
    path = `${datastorePath}/wiki/${slug}.md`;
  }

  try {
    await invoke('write_file', { path, content });
    if (!currentFile) setCurrentFile(path);
    setModified(false);
    mountedWidgets.forEach(w => w.onFileSaved(path));
    refreshPages();
  } catch (e) {
    console.error('autoSave failed:', e);
  }
}


// ── View mode ─────────────────────────────────────

function setMode(mode) {
  editorArea.dataset.mode = mode;
  document.querySelectorAll('[data-mode]').forEach(btn => {
    if (btn.dataset.mode === mode) btn.dataset.active = '';
    else                           delete btn.dataset.active;
  });
  if (mode === 'render') renderMarkdown();
  if (mode !== 'render') editorPane.style.flex = '';
}

// ── Sidebar state management ───────────────────────
//
// States per sidebar:
//   'hidden'  — sidebar gone; collapsed edge tab shown as hover affordance
//   'flyout'  — overlays the editor (position:absolute); backdrop-blur behind
//   'pinned'  — takes layout space; editor resizes; ph-x close button shown

const sbConfig = {
  left:   { sidebar: leftSidebar,   collapsed: collapsedLeft,   btn: btnToggleLeft   },
  right:  { sidebar: rightSidebar,  collapsed: collapsedRight,  btn: btnToggleRight  },
  top:    { sidebar: topSidebar,    collapsed: collapsedTop,    btn: btnToggleTop    },
  bottom: { sidebar: bottomSidebar, collapsed: collapsedBottom, btn: btnToggleBottom },
};

// ── UI state persistence ──────────────────────────

const UI_STATE_KEY = 'mi-ui-state';

function saveUiState() {
  try {
    localStorage.setItem(UI_STATE_KEY, JSON.stringify({ sbState, sbSizes }));
  } catch { /* storage unavailable */ }
}

function loadUiState() {
  try {
    const saved = JSON.parse(localStorage.getItem(UI_STATE_KEY) || 'null');
    if (!saved) return;
    // Restore sidebar states (top is disabled, always keep hidden)
    const validStates = ['hidden', 'pinned'];
    for (const k of ['left', 'right', 'bottom']) {
      if (validStates.includes(saved.sbState?.[k])) sbState[k] = saved.sbState[k];
    }
    // Restore sidebar sizes
    for (const k of ['left', 'right', 'top', 'bottom']) {
      if (typeof saved.sbSizes?.[k] === 'number') sbSizes[k] = saved.sbSizes[k];
    }
  } catch { /* ignore corrupt storage */ }
}

// ─────────────────────────────────────────────────

const sbState = { left: 'hidden', right: 'pinned', top: 'hidden', bottom: 'hidden' };

const flyoutTimers = {};
let   isResizing   = false;

function applySbState(name) {
  const state = sbState[name];
  const { sidebar, collapsed, btn } = sbConfig[name];

  sidebar.dataset.sbState = state;
  collapsed.classList.toggle('sb-visible', state === 'hidden');
  if (state !== 'hidden') collapsed.classList.remove('sb-peek');

  if (state === 'pinned') btn.dataset.active = '';
  else                    delete btn.dataset.active;
}

function setSbState(name, state) {
  sbState[name] = state;
  applySbState(name);
  saveUiState();
}

function togglePin(name) {
  setSbState(name, sbState[name] === 'pinned' ? 'hidden' : 'pinned');
}

function startFlyout(name) {
  clearTimeout(flyoutTimers[name]);
  if (sbState[name] === 'hidden') setSbState(name, 'flyout');
}

function scheduleDismiss(name) {
  if (isResizing) return;
  flyoutTimers[name] = setTimeout(() => {
    if (sbState[name] === 'flyout') setSbState(name, 'hidden');
  }, 150);
}

Object.keys(sbConfig).forEach(name => {
  const { sidebar, collapsed } = sbConfig[name];

  collapsed.addEventListener('mouseenter', () => {
    collapsed.classList.add('sb-peek');
    clearTimeout(flyoutTimers[name]);
    flyoutTimers[name] = setTimeout(() => startFlyout(name), 300);
  });
  collapsed.addEventListener('mouseleave', () => {
    collapsed.classList.remove('sb-peek');
    clearTimeout(flyoutTimers[name]);
  });

  sidebar.addEventListener('mouseenter', () => clearTimeout(flyoutTimers[name]));
  sidebar.addEventListener('mouseleave', () => scheduleDismiss(name));

  const actionBtn = sidebar.querySelector('.sb-action-btn');
  actionBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (sbState[name] === 'pinned') setSbState(name, 'hidden');
    else if (sbState[name] === 'flyout') setSbState(name, 'pinned');
  });
});

btnToggleLeft.addEventListener('click',   () => togglePin('left'));
btnToggleRight.addEventListener('click',  () => togglePin('right'));
btnToggleTop.addEventListener('click',    () => togglePin('top'));
btnToggleBottom.addEventListener('click', () => togglePin('bottom'));

document.getElementById('btn-today').addEventListener('click', () => {
  const d = new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  openJournalDate(dateStr);
});

// ── Sidebar resize ────────────────────────────────

const sbSizes = { left: 208, right: 208, top: 160, bottom: 180 };

function setSbSize(name, size) {
  sbSizes[name] = size;
  const { sidebar } = sbConfig[name];
  if (name === 'left' || name === 'right') sidebar.style.width  = size + 'px';
  else                                     sidebar.style.height = size + 'px';
  saveUiState();
}

function initSbResize(name, handle) {
  const horiz = (name === 'left' || name === 'right');
  const dir   = (name === 'right' || name === 'bottom') ? -1 : 1;

  let dragStart = 0;
  let sizeStart = 0;

  function onDrag(e) {
    const cur   = horiz ? e.clientX : e.clientY;
    const delta = (cur - dragStart) * dir;
    const max   = horiz
      ? Math.floor(contentRow.offsetWidth * 0.7)
      : Math.floor(centerColumn.offsetHeight * 0.6);
    const min   = horiz ? 120 : 80;
    setSbSize(name, Math.max(min, Math.min(sizeStart + delta, max)));
  }

  function stopDrag() {
    isResizing = false;
    handle.classList.remove('is-resizing');
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup',   stopDrag);
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
  }

  handle.addEventListener('mousedown', e => {
    isResizing = true;
    handle.classList.add('is-resizing');
    dragStart  = horiz ? e.clientX : e.clientY;
    sizeStart  = sbSizes[name];
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup',   stopDrag);
    document.body.style.cursor     = horiz ? 'ew-resize' : 'ns-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
    e.stopPropagation();
  });
}

Object.keys(sbConfig).forEach(name => {
  const handle = sbConfig[name].sidebar.querySelector('.sb-resize');
  if (handle) initSbResize(name, handle);
});

// ── Widget system ─────────────────────────────────
//
// mountedWidgets is the authoritative list of all active widget instances.
// The app broadcasts document events to all of them via this array.

const mountedWidgets = [];

/**
 * Mount an ordered list of widgets into a sidebar's .widget-stack element.
 * Each widget gets a wrapper div; the widget's wrapperClass controls sizing.
 * @param {string}   sidebarName  Key in sbConfig ('left', 'right', 'top', 'bottom')
 * @param {Widget[]} widgets
 */
function mountWidgets(sidebarName, widgets) {
  const { sidebar } = sbConfig[sidebarName];
  const stack = sidebar.querySelector('.widget-stack');
  if (!stack) return;
  const orientation = (sidebarName === 'top' || sidebarName === 'bottom') ? 'horizontal' : 'vertical';
  widgets.forEach(widget => {
    const wrapper = document.createElement('div');
    widget.wrapperClass.split(/\s+/).filter(Boolean).forEach(cls => wrapper.classList.add(cls));
    wrapper.dataset.widgetId = widget.id;
    stack.appendChild(wrapper);
    widget.mount(wrapper, orientation);
    mountedWidgets.push(widget);
  });
}

// ── Navigation history (breadcrumbs) ─────────────

const navHistory = [];  // [ { path, title }, … ]

function renderBreadcrumbs() {
  if (navHistory.length === 0) {
    breadcrumbsEl.style.display = 'none';
    return;
  }
  breadcrumbsEl.style.display = 'flex';
  breadcrumbsEl.innerHTML = navHistory.map((entry, i) => {
    const label = escapeHtml(entry.title || basename(entry.path).replace(/\.[^.]+$/, ''));
    return `<a class="bc-item hover:text-olive-300 cursor-pointer transition-colors" data-index="${i}">${label}</a>`
         + `<span class="bc-sep mx-1 text-olive-700">›</span>`;
  }).join('') + `<span class="text-olive-400">${escapeHtml(docTitle.textContent || basename(currentFile || '').replace(/\.[^.]+$/, ''))}</span>`;
}

breadcrumbsEl.addEventListener('click', async e => {
  const item = e.target.closest('.bc-item');
  if (!item) return;
  const idx   = parseInt(item.dataset.index, 10);
  const entry = navHistory[idx];
  if (!entry) return;
  navHistory.splice(idx);          // truncate — this entry becomes current
  try {
    const content = await invoke('read_file', { path: entry.path });
    await loadFile(entry.path, content);
  } catch (err) {
    console.error('breadcrumb nav failed:', err);
  }
});

// ── Core file loader (does NOT touch navHistory) ──

const JOURNAL_RE = /\d{4}-\d{2}-\d{2}\.md$/;

async function loadFile(path, content) {
  const journalPlaceholder = JOURNAL_RE.test(path) && content.length === 0
    ? placeholder('Tell me about your day\u2026')
    : [];
  cmView.dispatch({
    changes: { from: 0, to: cmView.state.doc.length, insert: content },
    selection: { anchor: 0 },
    effects: placeholderCompartment.reconfigure(journalPlaceholder),
  });
  setCurrentFile(path);
  setModified(false);
  const metadata = await invoke('get_metadata', { content });
  updateDocTitle(metadata, content);
  mountedWidgets.forEach(w => w.onFileOpen(path, content, metadata));
  if (editorArea.dataset.mode === 'render') await renderMarkdown();
  renderBreadcrumbs();
  cmView.focus();
}

// Push current page onto history, then load `path`.
async function navigateTo(path, content) {
  if (currentFile) {
    navHistory.push({
      path:  currentFile,
      title: docTitle.textContent || basename(currentFile).replace(/\.[^.]+$/, ''),
    });
  }
  await loadFile(path, content);
}

// ── Wiki pages ────────────────────────────────────

async function openWikiPage(title) {
  try {
    const { path, content } = await invoke('open_wiki_page', { title });
    await navigateTo(path, content);
  } catch (e) {
    console.error('open_wiki_page failed:', e);
  }
}

// ── File navigation (linked-reference clicks) ─────

async function openFilePath(path) {
  try {
    const content = await invoke('read_file', { path });
    await navigateTo(path, content);
  } catch (e) {
    console.error('read_file failed:', e);
  }
}

// ── Journal ───────────────────────────────────────

async function openJournalDate(dateStr) {
  try {
    navHistory.length = 0;        // journal opens reset the trail
    const { path, content } = await invoke('open_journal', { date: dateStr });
    await loadFile(path, content);
  } catch (e) {
    console.error('open_journal failed:', e);
  }
}

// ── Wiki link navigation ──────────────────────────

// Render mode: click on a rendered wiki-link anchor
markdownContent.addEventListener('click', e => {
  const wikiLink = e.target.closest('a.wiki-link');
  if (wikiLink) { e.preventDefault(); openWikiPage(wikiLink.dataset.wikiTitle); }
});


document.querySelectorAll('[data-mode]').forEach(btn => {
  btn.addEventListener('click', () => setMode(btn.dataset.mode));
});

// ── Modal helpers ─────────────────────────────────

/**
 * Show a lightweight in-app prompt dialog (window.prompt is blocked by WKWebView).
 * Returns the trimmed string the user entered, or null if they cancelled.
 */
function promptModal(message, placeholder = '') {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[9999] flex items-center justify-center bg-black/60';

    overlay.innerHTML = `
      <div class="bg-olive-900 border border-olive-700 rounded-lg shadow-xl p-5 w-80 flex flex-col gap-4">
        <p class="text-sm text-olive-200">${message}</p>
        <input id="mi-prompt-input" type="text" placeholder="${placeholder}"
          class="bg-olive-800 border border-olive-600 rounded px-3 py-1.5 text-sm text-olive-100
                 placeholder-olive-600 focus:outline-none focus:border-amber-500 w-full" />
        <div class="flex justify-end gap-2">
          <button id="mi-prompt-cancel"
            class="px-3 py-1.5 text-xs rounded bg-olive-700 text-olive-200 hover:bg-olive-600">
            Cancel
          </button>
          <button id="mi-prompt-ok"
            class="px-3 py-1.5 text-xs rounded bg-amber-700 text-white hover:bg-amber-600">
            OK
          </button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    const input  = overlay.querySelector('#mi-prompt-input');
    const btnOk  = overlay.querySelector('#mi-prompt-ok');
    const btnCan = overlay.querySelector('#mi-prompt-cancel');
    input.focus();

    const finish = val => { overlay.remove(); resolve(val); };

    btnOk.addEventListener('click',  () => finish(input.value.trim() || null));
    btnCan.addEventListener('click', () => finish(null));
    overlay.addEventListener('click', e => { if (e.target === overlay) finish(null); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter')  finish(input.value.trim() || null);
      if (e.key === 'Escape') finish(null);
    });
  });
}

/**
 * Show a pick-list modal.  Returns the chosen option's value, or null if
 * cancelled.  `options` is an array of `{ value, label }` objects.
 */
function pickModal(message, options) {
  return new Promise(resolve => {
    if (!options.length) { resolve(null); return; }

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[9999] flex items-center justify-center bg-black/60';

    overlay.innerHTML = `
      <div class="bg-olive-900 border border-olive-700 rounded-lg shadow-xl p-5 w-80 flex flex-col gap-3">
        <p class="text-sm text-olive-200">${message}</p>
        <ul class="flex flex-col gap-0.5 max-h-64 overflow-y-auto">
          ${options.map(o => `
            <li data-value="${o.value}"
              class="px-3 py-2 text-sm text-olive-100 rounded cursor-pointer hover:bg-olive-700 hover:text-amber-300 select-none">
              ${o.label}
            </li>`).join('')}
        </ul>
        <div class="flex justify-end">
          <button id="mi-pick-cancel"
            class="px-3 py-1.5 text-xs rounded bg-olive-700 text-olive-200 hover:bg-olive-600">
            Cancel
          </button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    const finish = val => { overlay.remove(); resolve(val); };

    overlay.querySelector('#mi-pick-cancel').addEventListener('click', () => finish(null));
    overlay.addEventListener('click', e => { if (e.target === overlay) finish(null); });
    overlay.querySelector('ul').addEventListener('click', e => {
      const li = e.target.closest('li[data-value]');
      if (li) finish(li.dataset.value);
    });
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') finish(null); });
  });
}

// ── Menu event handling ───────────────────────────

window.__TAURI__.event.listen('menu', async e => {
  switch (e.payload) {
    case 'toggle-left':   togglePin('left');   break;
    case 'toggle-right':  togglePin('right');  break;
    case 'toggle-top':    togglePin('top');    break;
    case 'toggle-bottom': togglePin('bottom'); break;

    case 'file-new': {
      const title = await promptModal('New page title:');
      if (title) await openWikiPage(title);
      break;
    }

    case 'file-new-template': {
      const name = await promptModal('Template name:', 'e.g. person, meeting, room');
      if (name) {
        try {
          const { path, content } = await invoke('open_template', { name });
          await navigateTo(path, content);
        } catch (e) {
          console.error('open_template failed:', e);
        }
      }
      break;
    }

    case 'file-from-template': {
      try {
        const templates = await invoke('list_templates');
        if (!templates.length) {
          await promptModal('No templates found.\nCreate one via File → New Template.');
          break;
        }
        const slug = await pickModal(
          'Choose a template:',
          templates.map(t => ({ value: t.slug, label: t.title })),
        );
        if (!slug) break;
        const title = await promptModal(`New page title:`);
        if (!title) break;
        const { path, content } = await invoke('new_from_template', { templateSlug: slug, title });
        await navigateTo(path, content);
      } catch (e) {
        console.error('new_from_template failed:', e);
      }
      break;
    }

    case 'file-edit-template': {
      try {
        const templates = await invoke('list_templates');
        if (!templates.length) {
          await promptModal('No templates found.\nCreate one via File → New Template.');
          break;
        }
        const template = await pickModal(
          'Edit template:',
          templates.map(t => ({ value: t.path, label: t.title })),
        );
        if (template) {
          const content = await invoke('read_file', { path: template });
          await navigateTo(template, content);
        }
      } catch (e) {
        console.error('edit_template failed:', e);
      }
      break;
    }

    case 'file-reindex': {
      const count = await invoke('full_reindex');
      console.log(`Reindex complete — ${count} files indexed.`);
      break;
    }
  }
});

// ── Init ──────────────────────────────────────────

loadUiState(); // restore persisted sidebar state + sizes before applying

Object.keys(sbConfig).forEach(name => {
  setSbSize(name, sbSizes[name]);
  applySbState(name);
});

// Plugin handles maximised/fullscreen only; we own size+position.
restoreStateCurrent(StateFlags.MAXIMIZED | StateFlags.FULLSCREEN)
  .then(() => invoke('restore_window_size'))
  .catch(() => {});

// Save size+position on a 1-second debounce after any resize or move.
// Saving is skipped by the Rust side when the window is maximised.
{
  let _winSaveTimer = null;
  const scheduleWinSave = () => {
    clearTimeout(_winSaveTimer);
    _winSaveTimer = setTimeout(() => invoke('save_window_size').catch(() => {}), 1000);
  };
  window.__TAURI__.event.listen('tauri://resize', scheduleWinSave);
  window.__TAURI__.event.listen('tauri://move',   scheduleWinSave);
}

invoke('get_datastore_path').then(p => { datastorePath = p; }).catch(console.error);

// Index the datastore on startup (runs in background; does not block the UI).
// Status is permanently visible in the status bar.
(function () {
  function setIndexStatus(html) {
    indexStatusEl.innerHTML = html;
  }

  setIndexStatus('<i class="ph ph-circle-notch animate-spin leading-none"></i><span>Indexing…</span>');

  invoke('index_datastore')
    .then(n => {
      if (n > 0) {
        setIndexStatus(`<i class="ph ph-check leading-none"></i><span>Indexed ${n} file${n !== 1 ? 's' : ''}</span>`);
      } else {
        setIndexStatus('<i class="ph ph-check leading-none"></i><span>Index up to date</span>');
      }
    })
    .catch(e => {
      console.warn('[MI] index_datastore failed:', e);
      setIndexStatus('<i class="ph ph-warning leading-none text-yellow-300"></i><span class="text-yellow-300">Index failed</span>');
    });
}());

const pageWidget = new PageWidget({
  onOpenInEditor: openWikiPage,
  onOpenJournal:  openJournalDate,
  onEditPage:     openFilePath,
});

mountWidgets('left', [
  new SearchWidget({ onOpen: (path, title) => pageWidget.loadPath(path, title) }),
  pageWidget,
  // new OutlineWidget(),  // available but not in default layout
  // new BrowserWidget(),  // available but not in default layout
]);

const favoritesWidget = new FavoritesWidget({
  onOpen: openFilePath,
});

mountWidgets('right', [
  new CalendarWidget({ onDateSelected: openJournalDate }),
  new ScratchPadWidget(),
  favoritesWidget,
]);

// Auto-show/hide the bottom sidebar based on whether either bottom widget
// has content.  Both widgets report their state via onStateChange(bool).
const bottomContentState = { refs: false, meta: false };
function updateBottomVisibility() {
  const hasAny = bottomContentState.refs || bottomContentState.meta;
  setSbState('bottom', hasAny ? 'pinned' : 'hidden');
}

mountWidgets('bottom', [
  new ReferencesWidget({
    onOpen: openFilePath,
    onStateChange: has => { bottomContentState.refs = has; updateBottomVisibility(); },
  }),
  new MetadataWidget({
    onStateChange: has => { bottomContentState.meta = has; updateBottomVisibility(); },
  }),
  // new CounterWidget(),  // hidden by default
]);

setMode('edit');
updateCursor(1, 1);

const _d = new Date();
const _todayStr = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`;
openJournalDate(_todayStr);
