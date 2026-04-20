import './input.css';
import { preprocessCalcBlocks } from './calcBlock.js';
import { invoke } from './tauri.js';
import { initPrefs, getPref, setPref, setPrefs } from './prefs.js';
import { EditorView } from '@codemirror/view';
import { restoreStateCurrent, StateFlags } from '@tauri-apps/plugin-window-state';
import { CalendarWidget }    from './widgets/CalendarWidget.js';
import { MetadataWidget }    from './widgets/MetadataWidget.js';
import { ReferencesWidget }  from './widgets/ReferencesWidget.js';
import { PageWidget }        from './widgets/PageWidget.js';
import { ScratchPadWidget }  from './widgets/ScratchPadWidget.js';
import { FavoritesWidget }  from './widgets/FavoritesWidget.js';
import { TasksWidget, setDeferFutureTasks } from './widgets/TasksWidget.js';
import { TagsWidget }           from './widgets/TagsWidget.js';
import { AnnotationsWidget }   from './widgets/AnnotationsWidget.js';
import { CounterWidget }     from './widgets/CounterWidget.js';
import { OutlineWidget }     from './widgets/OutlineWidget.js';
import { SearchWidget }      from './widgets/SearchWidget.js';
import { createEditor, createTasksEditor, createTaskPriorityPlugin, createReadOnlyEditor, setEditorPages, setEditorJournalDates, placeholderCompartment } from './editor.js';
import { initWidgetDrag } from './widgetDrag.js';
import { placeholder } from '@codemirror/view';
import { formatJournalDate, isDeferred, todayIso, computeEffectivePriority } from './dateUtils.js';

// ── State ─────────────────────────────────────────

let currentFile   = null;
let currentTitle  = '';
let datastorePath = null;  // set during init via get_datastore_path

// ── User preferences ──────────────────────────────
await initPrefs();
// 'page' = open in Page Widget (default), 'editor' = open in main editor
let searchOpenIn     = getPref('searchOpenIn',     'page');
// When true, tasks on future-dated journal pages are hidden from task lists.
let deferFutureTasks = getPref('deferFutureTasks', false);

// ── Editor mono font ──────────────────────────────────────────────────────────
const MONO_FONTS = [
  { name: 'JetBrains Mono', css: '"JetBrains Mono", monospace' },
  { name: 'IBM Plex Mono',  css: '"IBM Plex Mono", monospace'  },
  { name: 'Fira Code',      css: '"Fira Code", monospace'       },
  { name: 'System Mono',    css: 'ui-monospace, "Cascadia Mono", "SF Mono", Consolas, Menlo, monospace' },
];
function applyEditorFont(name) {
  const font = MONO_FONTS.find(f => f.name === name) ?? MONO_FONTS[0];
  document.documentElement.style.setProperty('--font-family-mono', font.css);
}
function applyEditorFontSize(px) {
  document.documentElement.style.setProperty('--editor-font-size', `${px}px`);
}
applyEditorFont(getPref('editorFont', 'JetBrains Mono'));
applyEditorFontSize(getPref('editorFontSize', 14));

let changeTimer   = null;
let saveTimer     = null;
let mdTimer       = null;

// Sentinel paths used when pseudo-pages are active.
const TASKS_PSEUDO_PAGE    = '::tasks::';
const METADATA_PSEUDO_PAGE = '::metadata::';
const TAG_PSEUDO_PAGE      = '::tag::';

// Tasks pseudo-page state.
let tasksEditorView  = null;
let taskLineMap      = new Map(); // syntheticLineNo (1-based) → {path, sourceLineNo, originalText} | null
const pendingWrites  = new Map(); // syntheticLineNo → setTimeout id
const tasksContextFilter = new Set(); // active @context toggles; empty = show all
let   tasksSearchQuery   = '';        // plain-text filter for the pseudo-page search bar

// Metadata pseudo-page state.
let metadataEditorView = null;
let metadataLineMap    = new Map(); // syntheticLineNo → { path } | null
let metadataQuery      = null;      // { key, value } currently displayed

let tagEditorView = null;
let tagQuery      = null;           // tag string currently displayed

// Strips the checkbox prefix from a synthetic task line to get the task text.
const TASK_TEXT_RE = /^(?:[ \t]*(?:[-*+]|\d+[.)]) +)?\[[xX ]?\]\s*/;
function extractTaskText(line) { return line.replace(TASK_TEXT_RE, ''); }

// ── DOM refs ──────────────────────────────────────

const editorDiv           = document.getElementById('editor');
const editorArea          = document.getElementById('editor-area');
const editorPane          = document.getElementById('editor-pane');
const tasksView           = document.getElementById('tasks-view');
const tasksFilterBar      = document.getElementById('tasks-filter-bar');
const tasksSearchInput    = document.getElementById('tasks-search-input');
const tasksSearchClear    = document.getElementById('tasks-search-clear');
const tasksEditorContainer= document.getElementById('tasks-editor-container');
const metadataView    = document.getElementById('metadata-view');
const tagView         = document.getElementById('tag-view');
const vDivider        = document.getElementById('v-divider');
const markdownPane    = document.getElementById('markdown-pane');
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

// Nav destination buttons (Today, Tasks)
const btnToday = document.getElementById('btn-today');
const btnTasks = document.getElementById('btn-tasks');

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

/**
 * Set any metadata key in `content`, following the MI metadata manipulation rule:
 * - If the key already exists, update it in place.
 * - If absent, append to the sig block (creating one if needed).
 * @param {string} content  Raw document text
 * @param {string} key      Metadata key (case-insensitive match)
 * @param {string} rawValue The raw value string to write after "key: "
 * @returns {string} Updated content
 */
function setMetadataInContent(content, key, rawValue) {
  const existingRe = new RegExp(`^(${key}\\s*:\\s*)(.*)$`, 'mi');
  if (existingRe.test(content)) {
    return content.replace(existingRe, `$1${rawValue}`);
  }
  // Key absent → append to last sig block or create one
  const allSigs = [...content.matchAll(/^-- $/mg)];
  if (allSigs.length > 0) {
    const last = allSigs[allSigs.length - 1];
    const nlIdx = content.indexOf('\n', last.index + last[0].length);
    const insertAt = nlIdx !== -1 ? nlIdx + 1 : content.length;
    return content.slice(0, insertAt) + `${key}: ${rawValue}\n` + content.slice(insertAt);
  }
  const trailing = content.endsWith('\n') ? '' : '\n';
  return `${content}${trailing}\n-- \n${key}: ${rawValue}\n`;
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

  currentTitle = title || (currentFile ? basename(currentFile).replace(/\.[^.]+$/, '') : '');
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
        .then(() => widgetRegistry.get('favorites')?.refresh())
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
  onPageClick(title, coords) {
    openWikiPage(title, coords);
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
  invoke('list_journal_dates').then(setEditorJournalDates).catch(console.error);
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

// ── CamelCase link preprocessor ────────────────────────────────────────────
// Converts CamelCase words that match a known page title into [[bracket]] links
// before the markdown is sent to the Rust renderer. Skips existing [[...]] spans,
// fenced code blocks, and @calc blocks. Never creates pages — only expands words
// whose titles already exist in allPages.

const CAMELCASE_RE_PREVIEW = /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g;

function camelToTitlePreview(camel) {
  return camel.replace(/([A-Z])/g, ' $1').trim();
}

function preprocessCamelLinks(markdown) {
  const titleSet = new Set(allPages.map(p => p.title));
  if (titleSet.size === 0) return markdown;

  const lines = markdown.split('\n');
  const out   = [];
  let inFence = false;
  let inCalc  = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inCalc && /^(`{3,}|~{3,})/.test(trimmed)) inFence = !inFence;
    if (!inFence) {
      if (trimmed === '@calc') inCalc = true;
      else if (inCalc && trimmed === '') inCalc = false;
    }

    if (inFence || inCalc) {
      out.push(line);
      continue;
    }

    // Split on [[...]] spans; only process the text parts (even indices).
    const parts = line.split(/(\[\[[^\]]*\]\])/);
    out.push(parts.map((part, i) => {
      if (i % 2 === 1) return part; // inside [[...]] — leave untouched
      CAMELCASE_RE_PREVIEW.lastIndex = 0;
      return part.replace(CAMELCASE_RE_PREVIEW, match => {
        const title = camelToTitlePreview(match);
        return titleSet.has(title) ? `[[${title}]]` : match;
      });
    }).join(''));
  }

  return out.join('\n');
}

async function renderMarkdown() {
  try {
    const raw  = cmView.state.doc.toString();
    const html = await invoke('parse_markdown', { markdown: preprocessCalcBlocks(preprocessCamelLinks(raw)) });
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

// Highlight Today/Tasks buttons when the matching destination is current.
// Also clears Edit/Render active state while Tasks is displayed.
function updateNavButtonStates() {
  const isTodayJournal = currentFile && basename(currentFile) === `${todayIso()}.md`;
  const isTasksPage    = currentFile === TASKS_PSEUDO_PAGE;

  if (isTodayJournal) btnToday.dataset.active = '';
  else                delete btnToday.dataset.active;

  if (isTasksPage) btnTasks.dataset.active = '';
  else             delete btnTasks.dataset.active;

  // Suppress Edit/Render highlight while Tasks is showing.
  document.querySelectorAll('[data-mode]').forEach(btn => {
    if (isTasksPage) delete btn.dataset.active;
    else if (btn.dataset.mode === editorArea.dataset.mode) btn.dataset.active = '';
    else delete btn.dataset.active;
  });
}

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

function saveUiState() {
  setPrefs({ sbState, sbSizes, widgetLayout, widgetSizes });
}

function loadUiState() {
  const savedSbState    = getPref('sbState',      null);
  const savedSbSizes    = getPref('sbSizes',      null);
  const savedLayout     = getPref('widgetLayout', null);
  const savedSizes      = getPref('widgetSizes',  null);

  // Restore sidebar states (top is disabled, always keep hidden)
  const validStates = ['hidden', 'pinned'];
  for (const k of ['left', 'right', 'bottom']) {
    if (validStates.includes(savedSbState?.[k])) sbState[k] = savedSbState[k];
  }
  // Restore sidebar sizes
  for (const k of ['left', 'right', 'top', 'bottom']) {
    if (typeof savedSbSizes?.[k] === 'number') sbSizes[k] = savedSbSizes[k];
  }
  // Restore widget layout and sizes
  if (savedLayout) widgetLayout = savedLayout;
  if (savedSizes)  widgetSizes  = savedSizes;
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
  // When a sidebar becomes pinned, ensure its widgets are mounted.
  // This handles the case where the sidebar was hidden at startup
  // (widgets were never mounted) and the user pins it.
  if (state === 'pinned') {
    const { sidebar } = sbConfig[name];
    const stack = sidebar?.querySelector('.widget-stack');
    const hasWidgets = stack?.querySelector('[data-widget-id]');
    const hasLayout  = (widgetLayout[name] || []).length > 0;
    if (!hasWidgets && hasLayout) remountSidebar(name);
  }
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

  const manageBtn = sidebar.querySelector('.sb-manage-btn');
  manageBtn.addEventListener('click', e => {
    e.stopPropagation();
    showWidgetPicker(name, manageBtn);
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

// Widget registry: id → widget instance (survives remounts).
const widgetRegistry = new Map();

// Layout: which widget IDs live in each sidebar, in order.
let widgetLayout = { left: [], right: [], top: [], bottom: [] };

// User-set widget sizes (px) keyed by widget ID.
let widgetSizes = {};

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
  const horiz = orientation === 'horizontal';
  // Pre-filter so isLast is correct even if some instances are already mounted.
  const toMount = widgets.filter(w => !mountedWidgets.includes(w));
  for (let i = 0; i < toMount.length; i++) {
    const widget  = toMount[i];
    const wrapper = document.createElement('div');
    // Guard: a savedSize smaller than MIN_WIDGET_SIZE (e.g. a header-strip
    // width saved from a rolled-up widget) is treated as absent so the widget
    // can size itself freely rather than being locked to a tiny sliver.
    const savedSize = (widgetSizes[widget.id] >= 48) ? widgetSizes[widget.id] : 0;
    const isLast = i === toMount.length - 1;

    // wrapperClass (borders, colours, etc.) always applied; the inline flex
    // below overrides any sizing classes it contains.
    widget.wrapperClass.split(/\s+/).filter(Boolean).forEach(cls => wrapper.classList.add(cls));
    // min-size 0 prevents flex items from refusing to shrink below content size.
    wrapper.style[horiz ? 'minWidth' : 'minHeight'] = '0';

    // Use 1 1 (grow + shrink) for all widgets so that when total saved sizes
    // exceed the container, they shrink proportionally rather than crowding out
    // any widget that has no saved size yet (e.g. a freshly added widget).
    // The last widget gets a 150px default basis so it's always visible even
    // when all other widgets have large saved sizes.
    if (savedSize) {
      wrapper.style.flex = `1 1 ${savedSize}px`;
    } else {
      wrapper.style.flex = isLast ? '1 1 150px' : '1 1 0';
    }
    wrapper.dataset.widgetId = widget.id;
    stack.appendChild(wrapper);

    // Isolate each widget's mount so an exception in one never silently
    // prevents the remaining widgets from mounting.
    try {
      widget.mount(wrapper, orientation, { isLast });
      mountedWidgets.push(widget);
      widgetRegistry.set(widget.id, widget);
      if (!widgetLayout[sidebarName].includes(widget.id)) {
        widgetLayout[sidebarName].push(widget.id);
      }
    } catch (err) {
      console.error(`[mountWidgets] widget "${widget.id}" mount() threw:`, err);
      stack.removeChild(wrapper);
    }
  }
  if (_widgetDrag) _widgetDrag.wireUp(sidebarName);
}

/** Destroy all widgets in a sidebar's stack and remove them from mountedWidgets. */
function teardownSidebar(sidebarName) {
  const { sidebar } = sbConfig[sidebarName];
  const stack = sidebar.querySelector('.widget-stack');
  if (!stack) return;
  for (const wrapper of [...stack.querySelectorAll('[data-widget-id]')]) {
    const w = widgetRegistry.get(wrapper.dataset.widgetId);
    if (w) {
      w.destroy();
      const idx = mountedWidgets.indexOf(w);
      if (idx !== -1) mountedWidgets.splice(idx, 1);
    }
  }
  stack.innerHTML = '';
}

/**
 * Tear down and remount all widgets in a sidebar from the layout registry.
 */
function remountSidebar(sidebarName) {
  teardownSidebar(sidebarName);
  const ids = widgetLayout[sidebarName] || [];
  const widgets = ids.map(id => widgetRegistry.get(id)).filter(Boolean);
  widgetLayout[sidebarName] = [];
  mountWidgets(sidebarName, widgets);
  saveUiState();
}

/**
 * Tear down ALL sidebars, then remount all from the current layout.
 * Required when widgets move between sidebars: tearing down one sidebar at a
 * time leaves moving widgets still in mountedWidgets when their target sidebar
 * is processed, causing the dedup guard to skip them.
 */
function rebuildAllSidebars() {
  const sbs = Object.keys(widgetLayout);
  for (const sb of sbs) teardownSidebar(sb);
  for (const sb of sbs) {
    const ids = widgetLayout[sb] || [];
    const widgets = ids.map(id => widgetRegistry.get(id)).filter(Boolean);
    widgetLayout[sb] = [];
    mountWidgets(sb, widgets);
  }
  saveUiState();
}

// Drag system handle — initialised after sbConfig is ready.
let _widgetDrag = null;

// ── Navigation history (breadcrumbs) ─────────────

const navHistory = [];  // [ { path, title }, … ]

function renderBreadcrumbs() {
  const trail = navHistory.map((entry, i) => {
    const label = escapeHtml(entry.title || basename(entry.path).replace(/\.[^.]+$/, ''));
    return `<a class="bc-item hover:text-olive-300 cursor-pointer transition-colors" data-index="${i}">${label}</a>`
         + `<span class="bc-sep mx-1 text-olive-700">›</span>`;
  }).join('');
  const cur = currentTitle ? `<span class="text-olive-400">${escapeHtml(currentTitle)}</span>` : '';
  breadcrumbsEl.innerHTML = trail + cur;
}

breadcrumbsEl.addEventListener('click', async e => {
  const item = e.target.closest('.bc-item');
  if (!item) return;
  const idx   = parseInt(item.dataset.index, 10);
  const entry = navHistory[idx];
  if (!entry) return;
  navHistory.splice(idx);          // truncate — this entry becomes current
  try {
    if (entry.path === TASKS_PSEUDO_PAGE) {
      await loadTasksView(/* pushHistory= */ false);
    } else if (entry.path === METADATA_PSEUDO_PAGE && metadataQuery) {
      await loadMetadataView(metadataQuery.key, metadataQuery.value, false);
    } else if (entry.path === TAG_PSEUDO_PAGE && tagQuery) {
      await loadTagView(tagQuery, false);
    } else {
      const content = await invoke('read_file', { path: entry.path });
      await loadFile(entry.path, content);
    }
  } catch (err) {
    console.error('breadcrumb nav failed:', err);
  }
});

// ── Core file loader (does NOT touch navHistory) ──

const JOURNAL_RE = /\d{4}-\d{2}-\d{2}\.md$/;

async function loadFile(path, content) {
  // Leaving a pseudo-page view: restore normal editor layout.
  if (currentFile === TASKS_PSEUDO_PAGE) {
    tasksView.style.display    = 'none';
    editorPane.style.display   = '';
    vDivider.style.display     = '';
    markdownPane.style.display = '';
  } else if (currentFile === METADATA_PSEUDO_PAGE) {
    metadataView.style.display = 'none';
    editorPane.style.display   = '';
    vDivider.style.display     = '';
    markdownPane.style.display = '';
  } else if (currentFile === TAG_PSEUDO_PAGE) {
    tagView.style.display      = 'none';
    editorPane.style.display   = '';
    vDivider.style.display     = '';
    markdownPane.style.display = '';
  }

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
  mountedWidgets.forEach(w => { try { w.onFileOpen(path, content, metadata); } catch(e) { console.error(`Widget ${w.id} onFileOpen failed:`, e); } });
  if (editorArea.dataset.mode === 'render') await renderMarkdown();
  renderBreadcrumbs();
  updateNavButtonStates();
  cmView.focus();
}

// Push current page onto history, then load `path`.
async function navigateTo(path, content) {
  if (currentFile) {
    navHistory.push({
      path:  currentFile,
      title: currentTitle || (currentFile === TASKS_PSEUDO_PAGE ? 'Tasks' : currentFile === METADATA_PSEUDO_PAGE ? (metadataQuery ? `${metadataQuery.key}` : 'Metadata') : currentFile === TAG_PSEUDO_PAGE ? (tagQuery ? `#${tagQuery}` : 'Tags') : basename(currentFile).replace(/\.[^.]+$/, '')),
    });
  }
  await loadFile(path, content);
}

// ── Wiki pages ────────────────────────────────────

async function openWikiPage(title, coords) {
  if (title.toLowerCase() === 'tasks') { await loadTasksView(); return; }

  // If the page already exists, navigate directly.
  const lc = title.toLowerCase();
  const existing = allPages.find(
    p => p.title.toLowerCase() === lc ||
         (p.aliases || []).some(a => a === lc)
  );
  if (existing) {
    try {
      const content = await invoke('read_file', { path: existing.path });
      await navigateTo(existing.path, content);
    } catch (e) { console.error('Failed to open existing page:', e); }
    return;
  }

  // Page doesn't exist — offer templates or a blank page.
  try {
    const templates = await invoke('list_templates');
    const options = templates.map(t => ({ value: `tpl:${t.slug}`, label: `New ${t.title}` }));
    options.push({ value: 'blank', label: 'New page' });

    let choice;
    if (options.length === 1) {
      choice = 'blank'; // no templates, skip the menu
    } else if (coords) {
      choice = await popupMenu(coords, options);
    } else {
      choice = await pickModal(`Create "${title}"`, options);
    }
    if (!choice) return;

    let path, content;
    if (choice === 'blank') {
      ({ path, content } = await invoke('open_wiki_page', { title }));
    } else {
      const slug = choice.slice(4); // strip "tpl:" prefix
      ({ path, content } = await invoke('new_from_template', { templateSlug: slug, title }));
    }
    await navigateTo(path, content);
    refreshPages();
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

// ── Tasks pseudo-page ─────────────────────────────

/**
 * Show the Tasks view. When `pushHistory` is true (default), the current
 * page is pushed onto navHistory first.
 */
async function loadTasksView(pushHistory = true, contextFilter = null) {
  if (pushHistory && currentFile && currentFile !== TASKS_PSEUDO_PAGE) {
    navHistory.push({
      path:  currentFile,
      title: currentTitle || basename(currentFile).replace(/\.[^.]+$/, ''),
    });
  }

  // Seed the filter: replace current selection with the provided context, or clear.
  tasksContextFilter.clear();
  if (contextFilter) tasksContextFilter.add(contextFilter.toLowerCase());

  // Reset search bar.
  tasksSearchQuery = '';
  tasksSearchInput.value = '';
  tasksSearchClear.style.display = 'none';

  editorPane.style.display     = 'none';
  vDivider.style.display       = 'none';
  markdownPane.style.display   = 'none';
  metadataView.style.display   = 'none';
  tasksView.style.display      = 'flex';

  currentFile  = TASKS_PSEUDO_PAGE;
  currentTitle = 'Tasks';
  fileNameEl.textContent = 'Tasks';
  document.title = 'MoreInfo \u2014 Tasks';
  docTitle.textContent = 'Tasks';

  // Create the CM instance once and reuse it.
  if (!tasksEditorView) {
    const priPlugin = createTaskPriorityPlugin(lineNo => taskLineMap.get(lineNo)?.effectivePriority);
    tasksEditorView = createTasksEditor({
      parent:         tasksEditorContainer,
      onUpdate:       onTasksDocChanged,
      onPageClick:    openWikiPage,
      priorityPlugin: priPlugin,
    });
  }

  mountedWidgets.forEach(w => { try { w.onFileOpen(TASKS_PSEUDO_PAGE, '', {}); } catch(e) {} });
  renderBreadcrumbs();
  updateNavButtonStates();

  await refreshTasksView();
}

function isFutureJournalTask(t) {
  const m = t.path.match(/(\d{4}-\d{2}-\d{2})\.md$/);
  return m ? m[1] > todayIso() : false;
}

// Build a synthetic markdown document from the task list and return it along
// with a line map.  The map keys are 1-based line numbers in the synthetic doc;
// values are {path, sourceLineNo, originalText} for task lines, null otherwise.
function buildSyntheticDoc(tasks) {
  const groups  = [];
  const pathIdx = new Map();
  for (const t of tasks) {
    if (isDeferred(t.defer_until)) continue;
    if (deferFutureTasks && isFutureJournalTask(t)) continue;
    if (!pathIdx.has(t.path)) {
      pathIdx.set(t.path, groups.length);
      groups.push({ path: t.path, title: t.title, byHeading: new Map() });
    }
    const g = groups[pathIdx.get(t.path)];
    const h = t.implicit_heading || '';
    if (!g.byHeading.has(h)) g.byHeading.set(h, []);
    g.byHeading.get(h).push(t);
  }

  const lines   = [];
  const lineMap = new Map();
  let   lineNo  = 1;

  for (const g of groups) {
    const pageLabel = g.title || basename(g.path).replace(/\.md$/, '');
    lines.push(`## ${pageLabel}`);
    lineMap.set(lineNo++, { type: 'page', path: g.path });
    lines.push('');
    lineMap.set(lineNo++, null);

    for (const [heading, bucket] of g.byHeading) {
      if (heading) {
        lines.push(`### ${heading}`);
        lineMap.set(lineNo++, { type: 'heading', path: g.path, heading });
        lines.push('');
        lineMap.set(lineNo++, null);
      }
      bucket.sort((a, b) => {
        const pa = computeEffectivePriority(a.priority ?? 10, a.due_date, a.first_seen);
        const pb = computeEffectivePriority(b.priority ?? 10, b.due_date, b.first_seen);
        return pa - pb;
      });
      for (const t of bucket) {
        const ep = computeEffectivePriority(t.priority ?? 10, t.due_date, t.first_seen);
        lines.push(`[ ] ${t.text}`);
        lineMap.set(lineNo++, { path: t.path, sourceLineNo: t.line_number, originalText: t.text, effectivePriority: ep });
      }
      lines.push('');
      lineMap.set(lineNo++, null);
    }
  }

  return { doc: lines.join('\n'), lineMap };
}

/** Extract all unique @context tokens from a task list (excludes reserved params). */
const RESERVED_AT_NAMES = new Set(['done', 'due', 'defer', 'priority', 'overdue', 'waiting', 'someday']);
function extractContexts(tasks) {
  const seen = new Set();
  const atRe = /@([a-zA-Z][a-zA-Z0-9_-]*)/g;
  for (const t of tasks) {
    let m;
    atRe.lastIndex = 0;
    while ((m = atRe.exec(t.text)) !== null) {
      const name = m[1].toLowerCase();
      if (!RESERVED_AT_NAMES.has(name)) seen.add(name);
    }
  }
  return [...seen].sort();
}

/** Render the filter chip bar above the tasks editor. */
function renderTasksFilterBar(contexts) {
  if (!contexts.length) { tasksFilterBar.innerHTML = ''; return; }

  const label = `<span class="text-xs text-olive-600 font-semibold tracking-wider uppercase shrink-0">Contexts</span>`;
  const chips = contexts.map(c => {
    const isActive = tasksContextFilter.has(c);
    return `<button data-ctx="${escapeHtml(c)}"
      class="tasks-filter-chip shrink-0 px-2 py-0.5 rounded text-xs font-mono leading-5 transition-colors select-none whitespace-nowrap
             ${isActive
               ? 'bg-amber-700 text-white'
               : 'bg-olive-800 text-olive-400 hover:bg-olive-700 hover:text-olive-200'}"
    >@${escapeHtml(c)}</button>`;
  }).join('');
  tasksFilterBar.innerHTML = label + chips;
}

async function refreshTasksView() {
  const scrollTop = tasksEditorView ? tasksEditorView.scrollDOM.scrollTop : 0;
  try {
    const allTasks = await invoke('list_tasks', { checked: false });

    // Render filter bar from the full unfiltered set.
    const contexts = extractContexts(allTasks);
    renderTasksFilterBar(contexts);

    // Apply context filter (OR: task must have at least one active context).
    let tasks = allTasks;
    if (tasksContextFilter.size > 0) {
      tasks = tasks.filter(t => {
        const atRe = /@([a-zA-Z][a-zA-Z0-9_-]*)/g;
        let m;
        while ((m = atRe.exec(t.text)) !== null) {
          if (tasksContextFilter.has(m[1].toLowerCase())) return true;
        }
        return false;
      });
    }

    // Apply text search filter.
    const sq = tasksSearchQuery.trim().toLowerCase();
    if (sq) {
      const terms = sq.split(/\s+/).filter(Boolean);
      tasks = tasks.filter(t => {
        const text = t.text.toLowerCase();
        return terms.every(term => text.includes(term));
      });
    }

    const { doc, lineMap } = buildSyntheticDoc(tasks);
    taskLineMap = lineMap;
    tasksEditorView.dispatch({
      changes: { from: 0, to: tasksEditorView.state.doc.length, insert: doc },
    });
  } catch(e) {
    console.error('list_tasks failed:', e);
  }
  requestAnimationFrame(() => { if (tasksEditorView) tasksEditorView.scrollDOM.scrollTop = scrollTop; });
}

// Called by the tasks CM updateListener on every doc change.
function onTasksDocChanged(update) {
  const changedLines = new Set();
  update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    const doc  = update.state.doc;
    const lFrom = doc.lineAt(fromB).number;
    const lTo   = doc.lineAt(Math.min(toB, doc.length)).number;
    for (let l = lFrom; l <= lTo; l++) changedLines.add(l);
  });

  for (const lineNo of changedLines) {
    const entry = taskLineMap.get(lineNo);
    if (!entry || entry.type === 'page' || entry.type === 'heading') continue;

    const newLineText  = update.state.doc.line(lineNo).text;
    const newTaskText  = extractTaskText(newLineText);
    const isCompletion = newTaskText.includes('@done') && !entry.originalText.includes('@done');

    if (pendingWrites.has(lineNo)) clearTimeout(pendingWrites.get(lineNo));

    const doWrite = async () => {
      pendingWrites.delete(lineNo);
      try {
        await invoke('write_task_line', {
          path:         entry.path,
          lineNumber:   entry.sourceLineNo,
          originalText: entry.originalText,
          newText:      newTaskText,
        });
        entry.originalText = newTaskText;
        if (isCompletion) await refreshTasksView();
      } catch(err) {
        console.error('write_task_line failed:', err);
      }
    };

    if (isCompletion) {
      doWrite();
    } else {
      pendingWrites.set(lineNo, setTimeout(doWrite, 1500));
    }
  }
}

document.getElementById('btn-tasks').addEventListener('click', () => loadTasksView());

// Double-clicking a @context tag in the main editor opens the Tasks view filtered to that context.
editorDiv.addEventListener('dblclick', e => {
  const span = e.target.closest('.cm-at-context');
  if (!span) return;
  const context = span.textContent.replace(/^@/, '').trim();
  if (context) loadTasksView(true, context);
});

function scrollToHeading(heading) {
  const doc = cmView.state.doc;
  const target = heading.toLowerCase();
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text.replace(/^#{1,6}\s+/, '').trim().toLowerCase();
    if (text === target) {
      cmView.dispatch({ selection: { anchor: doc.line(i).from }, scrollIntoView: true });
      break;
    }
  }
}

async function navigateToPathAndHeading(path, heading) {
  try {
    const content = await invoke('read_file', { path });
    await navigateTo(path, content);
    if (heading) scrollToHeading(heading);
  } catch(e) {
    console.error('Failed to navigate to heading:', e);
  }
}

// Double-clicking a @context tag toggles that context filter;
// double-clicking a ## or ### header navigates to the source page (and heading).
tasksEditorContainer.addEventListener('dblclick', e => {
  const span = e.target.closest('.cm-at-context');
  if (span) {
    const context = span.textContent.replace(/^@/, '').trim().toLowerCase();
    if (!context) return;
    if (tasksContextFilter.has(context)) tasksContextFilter.delete(context);
    else tasksContextFilter.add(context);
    refreshTasksView();
    return;
  }

  if (!tasksEditorView) return;
  const pos = tasksEditorView.posAtCoords({ x: e.clientX, y: e.clientY });
  if (pos == null) return;
  const lineNo = tasksEditorView.state.doc.lineAt(pos).number;
  const entry  = taskLineMap.get(lineNo);
  if (!entry || (entry.type !== 'page' && entry.type !== 'heading')) return;
  navigateToPathAndHeading(entry.path, entry.heading ?? null);
});

// Tasks pseudo-page search bar.
tasksSearchInput.addEventListener('input', () => {
  tasksSearchQuery = tasksSearchInput.value;
  tasksSearchClear.style.display = tasksSearchQuery ? '' : 'none';
  refreshTasksView();
});

tasksSearchClear.addEventListener('click', () => {
  tasksSearchInput.value = '';
  tasksSearchQuery = '';
  tasksSearchClear.style.display = 'none';
  refreshTasksView();
  tasksSearchInput.focus();
});

// Clicking a filter chip toggles that context.
tasksFilterBar.addEventListener('click', e => {
  const chip = e.target.closest('.tasks-filter-chip');
  if (!chip) return;
  const ctx = chip.dataset.ctx;
  if (tasksContextFilter.has(ctx)) tasksContextFilter.delete(ctx);
  else tasksContextFilter.add(ctx);
  refreshTasksView();
});

// ── Metadata pseudo-page ──────────────────────────

async function loadMetadataView(key, value, pushHistory = true) {
  if (pushHistory && currentFile && currentFile !== METADATA_PSEUDO_PAGE) {
    navHistory.push({
      path:  currentFile,
      title: currentTitle || basename(currentFile).replace(/\.[^.]+$/, ''),
    });
  }

  // Hide normal editor, show metadata view.
  editorPane.style.display   = 'none';
  vDivider.style.display     = 'none';
  markdownPane.style.display = 'none';
  tasksView.style.display    = 'none';
  metadataView.style.display = 'block';

  metadataQuery = { key, value };
  const label = value != null ? `${key}: ${value}` : key;
  currentFile  = METADATA_PSEUDO_PAGE;
  currentTitle = label;
  fileNameEl.textContent = label;
  document.title = `MoreInfo \u2014 ${label}`;
  docTitle.textContent = label;

  if (!metadataEditorView) {
    metadataEditorView = createReadOnlyEditor({
      parent:      metadataView,
      onPageClick: openWikiPage,
    });
  }

  mountedWidgets.forEach(w => { try { w.onFileOpen(METADATA_PSEUDO_PAGE, '', {}); } catch(e) {} });
  renderBreadcrumbs();
  updateNavButtonStates();

  await refreshMetadataView();
}

async function refreshMetadataView() {
  if (!metadataQuery || !metadataEditorView) return;
  try {
    const hits = await invoke('search_metadata', {
      key:   metadataQuery.key,
      value: metadataQuery.value ?? null,
    });
    const { doc, lineMap } = buildMetadataDoc(hits, metadataQuery);
    metadataLineMap = lineMap;
    metadataEditorView.dispatch({
      changes: { from: 0, to: metadataEditorView.state.doc.length, insert: doc },
    });
  } catch(e) {
    console.error('search_metadata failed:', e);
  }
}

function buildMetadataDoc(hits, query) {
  const lines   = [];
  const lineMap = new Map();
  let lineNo    = 1;

  if (query.value != null) {
    // Showing all pages where key = value.
    lines.push(`# ${query.key}: ${query.value}`);
    lineMap.set(lineNo++, null);
    lines.push('');
    lineMap.set(lineNo++, null);

    if (hits.length === 0) {
      lines.push('*No pages found.*');
      lineMap.set(lineNo++, null);
    } else {
      for (const h of hits) {
        lines.push(`- [[${h.title}]]`);
        lineMap.set(lineNo++, { path: h.path });
      }
    }
  } else {
    // Showing all distinct values for a key, grouped.
    const byValue = new Map();
    for (const h of hits) {
      // For arrays, split into individual values.
      const vals = h.vtype === 'array'
        ? h.value.split(',').map(v => v.trim()).filter(Boolean)
        : [h.value];
      for (const v of vals) {
        if (!byValue.has(v)) byValue.set(v, []);
        byValue.get(v).push(h);
      }
    }

    lines.push(`# ${query.key}`);
    lineMap.set(lineNo++, null);
    lines.push('');
    lineMap.set(lineNo++, null);

    const sortedValues = [...byValue.keys()].sort((a, b) => a.localeCompare(b));
    for (const val of sortedValues) {
      const pages = byValue.get(val);
      lines.push(`## ${val} (${pages.length})`);
      lineMap.set(lineNo++, null);
      lines.push('');
      lineMap.set(lineNo++, null);
      for (const h of pages) {
        lines.push(`- [[${h.title}]]`);
        lineMap.set(lineNo++, { path: h.path });
      }
      lines.push('');
      lineMap.set(lineNo++, null);
    }
  }

  return { doc: lines.join('\n'), lineMap };
}

// ── Tag pseudo-page ───────────────────────────────

async function loadTagView(tag, pushHistory = true) {
  if (pushHistory && currentFile && currentFile !== TAG_PSEUDO_PAGE) {
    navHistory.push({
      path:  currentFile,
      title: currentTitle || basename(currentFile).replace(/\.[^.]+$/, ''),
    });
  }

  editorPane.style.display   = 'none';
  vDivider.style.display     = 'none';
  markdownPane.style.display = 'none';
  tasksView.style.display    = 'none';
  metadataView.style.display = 'none';
  tagView.style.display      = 'block';

  tagQuery     = tag;
  currentFile  = TAG_PSEUDO_PAGE;
  currentTitle = `#${tag}`;
  fileNameEl.textContent = `#${tag}`;
  document.title = `MoreInfo \u2014 #${tag}`;
  docTitle.textContent = `#${tag}`;

  if (!tagEditorView) {
    tagEditorView = createReadOnlyEditor({
      parent:      tagView,
      onPageClick: openWikiPage,
    });
  }

  mountedWidgets.forEach(w => { try { w.onFileOpen(TAG_PSEUDO_PAGE, '', {}); } catch(e) {} });
  renderBreadcrumbs();
  updateNavButtonStates();

  await refreshTagView();
}

async function refreshTagView() {
  if (!tagQuery || !tagEditorView) return;
  try {
    const hits = await invoke('list_pages_for_tag', { tag: tagQuery });
    const doc  = buildTagDoc(hits, tagQuery);
    tagEditorView.dispatch({
      changes: { from: 0, to: tagEditorView.state.doc.length, insert: doc },
    });
  } catch(e) {
    console.error('list_pages_for_tag failed:', e);
  }
}

function buildTagDoc(hits, tag) {
  const lines = [];
  lines.push(`# #${tag}`);
  lines.push('');

  if (hits.length === 0) {
    lines.push('*No pages found.*');
  } else {
    lines.push(`${hits.length} ${hits.length === 1 ? 'page' : 'pages'}`);
    lines.push('');
    for (const h of hits) {
      lines.push(`- [[${h.title}]]`);
    }
  }
  return lines.join('\n');
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

/**
 * Show a small popup menu anchored near {x, y} screen coordinates.
 * Returns the chosen option's `value`, or null if dismissed.
 * `options` is an array of `{ value, label }` objects.
 */
function popupMenu(coords, options) {
  return new Promise(resolve => {
    if (!options.length) { resolve(null); return; }

    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[9999]';
    overlay.tabIndex = -1;

    const menu = document.createElement('div');
    menu.className =
      'absolute bg-olive-900 border border-olive-700 rounded-lg shadow-xl py-1 min-w-[10rem] max-h-64 overflow-y-auto';

    menu.innerHTML = options.map(o => `
      <div data-value="${o.value}"
        class="px-3 py-1.5 text-sm text-olive-100 cursor-pointer hover:bg-olive-700
               hover:text-amber-300 select-none whitespace-nowrap">
        ${o.label}
      </div>`).join('');

    overlay.appendChild(menu);
    document.body.appendChild(overlay);

    // Position: prefer below-right of click, flip if it would overflow.
    const pad = 4;
    const { innerWidth: vw, innerHeight: vh } = window;
    const rect = menu.getBoundingClientRect();
    let left = coords.x;
    let top  = coords.y + pad;
    if (left + rect.width > vw - pad) left = vw - rect.width - pad;
    if (top + rect.height > vh - pad) top = coords.y - rect.height - pad;
    if (left < pad) left = pad;
    if (top < pad) top = pad;
    menu.style.left = `${left}px`;
    menu.style.top  = `${top}px`;

    overlay.focus();

    const finish = val => { overlay.remove(); resolve(val); };

    overlay.addEventListener('click', e => {
      if (e.target === overlay) { finish(null); return; }
      const item = e.target.closest('[data-value]');
      if (item) finish(item.dataset.value);
    });
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') finish(null); });
    overlay.addEventListener('blur', () => finish(null), true);
  });
}

/**
 * Show a checkmark menu of all widgets, positioned below `anchorEl`.
 * Checked items are currently in `sidebarName`.
 * Clicking a checked item removes it; clicking an unchecked item adds it
 * (moving from any other sidebar it currently occupies).
 */
function showWidgetPicker(sidebarName, anchorEl) {
  // Build labels from the live registry so no widget is ever missing.
  const WIDGET_LABELS = Object.fromEntries(
    [...widgetRegistry.entries()].map(([id, w]) => [id, w.title])
  );

  const current = new Set(widgetLayout[sidebarName] || []);

  // All widgets alphabetically by title, regardless of visibility.
  const ordered = Object.keys(WIDGET_LABELS)
    .sort((a, b) => WIDGET_LABELS[a].localeCompare(WIDGET_LABELS[b]));

  const rect = anchorEl.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.className = 'fixed inset-0 z-[9999]';
  overlay.tabIndex  = -1;

  const menu = document.createElement('div');
  menu.className = 'absolute bg-olive-900 border border-olive-700 rounded-lg shadow-xl py-1 min-w-[11rem]';

  menu.innerHTML = ordered.map(id => {
    const isChecked = current.has(id);
    return `
      <div data-widget-id="${id}"
        class="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-olive-700 select-none whitespace-nowrap
               ${isChecked ? 'text-olive-100' : 'text-olive-500'}">
        <i class="ph ${isChecked ? 'ph-check-square text-amber-400' : 'ph-square text-olive-700'} text-sm leading-none shrink-0"></i>
        ${WIDGET_LABELS[id]}
      </div>`;
  }).join('');

  overlay.appendChild(menu);
  document.body.appendChild(overlay);

  // Position below the anchor button, flush-right.
  const pad = 4;
  const { innerWidth: vw, innerHeight: vh } = window;
  menu.style.top  = `${rect.bottom + pad}px`;
  // After measuring width, right-align to anchor.
  requestAnimationFrame(() => {
    const mw = menu.offsetWidth;
    let left = rect.right - mw;
    if (left < pad) left = pad;
    if (left + mw > vw - pad) left = vw - mw - pad;
    menu.style.left = `${left}px`;
  });

  overlay.focus();

  const finish = () => overlay.remove();

  overlay.addEventListener('click', e => {
    if (e.target === overlay) { finish(); return; }
    const item = e.target.closest('[data-widget-id]');
    if (!item) return;
    finish();

    const id  = item.dataset.widgetId;
    const inCurrent = current.has(id);

    if (inCurrent) {
      // Remove from this sidebar.
      widgetLayout[sidebarName] = widgetLayout[sidebarName].filter(w => w !== id);
    } else {
      // Remove from any other sidebar it may occupy.
      for (const sb of Object.keys(widgetLayout)) {
        if (sb !== sidebarName) {
          widgetLayout[sb] = widgetLayout[sb].filter(w => w !== id);
        }
      }
      // Add to the end of this sidebar.
      widgetLayout[sidebarName] = [...(widgetLayout[sidebarName] || []), id];
    }

    rebuildAllSidebars();
  });

  overlay.addEventListener('keydown', e => { if (e.key === 'Escape') finish(); });
  overlay.addEventListener('blur', () => finish(), true);
}

// ── Settings dialog ───────────────────────────────

async function showSettingsDialog() {
  const { open: openDialog, ask } = window.__TAURI__.dialog;
  const { restart } = window.__TAURI__.process;

  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[9999] flex items-center justify-center bg-black/60';

    const currentPath = datastorePath || '(not set)';
    const soiPage   = searchOpenIn === 'page';
    const soiEditor = searchOpenIn === 'editor';
    overlay.innerHTML = `
      <div class="bg-olive-900 border border-olive-700 rounded-lg shadow-xl p-5 w-[480px] flex flex-col gap-4">
        <h2 class="text-sm font-semibold text-olive-100">Settings</h2>
        <div class="flex flex-col gap-1.5">
          <label class="text-xs text-olive-500 font-mono">Datastore location</label>
          <div class="flex items-center gap-2">
            <input id="mi-settings-path" type="text" readonly
              value="${currentPath.replace(/"/g, '&quot;')}"
              class="flex-1 bg-olive-800 border border-olive-600 rounded px-3 py-1.5 text-sm text-olive-200
                     font-mono focus:outline-none cursor-default truncate" />
            <button id="mi-settings-choose"
              class="shrink-0 px-3 py-1.5 text-xs rounded bg-olive-700 text-olive-200 hover:bg-olive-600 whitespace-nowrap">
              Choose\u2026
            </button>
          </div>
          <p class="text-xs text-olive-600">The folder where MoreInfo stores all your pages, journals, and templates.</p>
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-xs text-olive-500 font-mono">Search results open in</label>
          <div class="flex items-center gap-4">
            <label class="flex items-center gap-1.5 cursor-pointer text-xs text-olive-200">
              <input type="radio" name="mi-search-open-in" value="page"
                ${soiPage ? 'checked' : ''}
                class="accent-amber-500 cursor-pointer" />
              Page Widget
            </label>
            <label class="flex items-center gap-1.5 cursor-pointer text-xs text-olive-200">
              <input type="radio" name="mi-search-open-in" value="editor"
                ${soiEditor ? 'checked' : ''}
                class="accent-amber-500 cursor-pointer" />
              Main editor
            </label>
          </div>
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-xs text-olive-500 font-mono">Defer future tasks by default</label>
          <div class="flex items-center gap-4">
            <label class="flex items-center gap-1.5 cursor-pointer text-xs text-olive-200">
              <input type="radio" name="mi-defer-future" value="yes"
                ${deferFutureTasks ? 'checked' : ''}
                class="accent-amber-500 cursor-pointer" />
              Yes
            </label>
            <label class="flex items-center gap-1.5 cursor-pointer text-xs text-olive-200">
              <input type="radio" name="mi-defer-future" value="no"
                ${!deferFutureTasks ? 'checked' : ''}
                class="accent-amber-500 cursor-pointer" />
              No
            </label>
          </div>
          <p class="text-xs text-olive-600">When Yes, tasks on future-dated journal pages are hidden from the Tasks Widget and Tasks page.</p>
        </div>
        <div class="flex flex-col gap-1.5">
          <label class="text-xs text-olive-500 font-mono">Editor appearance</label>
          <div class="flex items-center gap-3">
            <select name="mi-editor-font"
              class="flex-1 bg-olive-800 border border-olive-600 rounded px-2 py-1.5 text-xs text-olive-200 focus:outline-none cursor-pointer">
              ${MONO_FONTS.map(f => `<option value="${f.name}" style="font-family:${f.css}"
                ${getPref('editorFont', 'JetBrains Mono') === f.name ? 'selected' : ''}>${f.name}</option>`).join('')}
            </select>
            <select name="mi-editor-font-size"
              class="bg-olive-800 border border-olive-600 rounded px-2 py-1.5 text-xs text-olive-200 focus:outline-none cursor-pointer">
              ${[11,12,13,14,15,16,18,20].map(s => `<option value="${s}"
                ${getPref('editorFontSize', 14) === s ? 'selected' : ''}>${s}px</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="flex justify-end gap-2 pt-1">
          <button id="mi-settings-cancel"
            class="px-3 py-1.5 text-xs rounded bg-olive-700 text-olive-200 hover:bg-olive-600">
            Cancel
          </button>
          <button id="mi-settings-ok"
            class="px-3 py-1.5 text-xs rounded bg-amber-700 text-white hover:bg-amber-600">
            Done
          </button>
        </div>
      </div>`;

    document.body.appendChild(overlay);
    const pathInput = overlay.querySelector('#mi-settings-path');
    const chooseBtn = overlay.querySelector('#mi-settings-choose');
    const okBtn     = overlay.querySelector('#mi-settings-ok');
    const cancelBtn = overlay.querySelector('#mi-settings-cancel');

    let pendingPath = null;  // set if user picked a new path

    chooseBtn.addEventListener('click', async () => {
      const chosen = await openDialog({ directory: true, multiple: false, title: 'Choose Datastore Folder' });
      if (!chosen) return;
      const newPath = Array.isArray(chosen) ? chosen[0] : chosen;
      pendingPath = newPath;
      pathInput.value = newPath;
      pathInput.title = newPath;
    });

    const finish = async (save) => {
      overlay.remove();
      if (save) {
        const picked = overlay.querySelector('input[name="mi-search-open-in"]:checked')?.value ?? 'page';
        if (picked !== searchOpenIn) {
          searchOpenIn = picked;
          setPref('searchOpenIn', searchOpenIn);
        }
        const newDefer = overlay.querySelector('input[name="mi-defer-future"]:checked')?.value === 'yes';
        if (newDefer !== deferFutureTasks) {
          deferFutureTasks = newDefer;
          setDeferFutureTasks(deferFutureTasks);
          setPref('deferFutureTasks', deferFutureTasks);
          allWidgetInstances.tasks?.refresh();
          refreshTasksView();
        }
        const newFont = overlay.querySelector('select[name="mi-editor-font"]')?.value ?? 'JetBrains Mono';
        if (newFont !== getPref('editorFont', 'JetBrains Mono')) {
          setPref('editorFont', newFont);
          applyEditorFont(newFont);
        }
        const newSize = parseInt(overlay.querySelector('select[name="mi-editor-font-size"]')?.value ?? '14', 10);
        if (newSize !== getPref('editorFontSize', 14)) {
          setPref('editorFontSize', newSize);
          applyEditorFontSize(newSize);
        }
      }
      if (!save || !pendingPath || pendingPath === datastorePath) { resolve(); return; }

      try {
        await invoke('init_datastore', { path: pendingPath });
        await invoke('set_datastore_path', { path: pendingPath });
        datastorePath = pendingPath;

        const confirmed = await ask(
          'The datastore location has been changed. MoreInfo needs to restart to use the new location.\n\nRestart now?',
          { title: 'Restart Required', kind: 'info', okLabel: 'Restart', cancelLabel: 'Later' }
        );
        if (confirmed) await restart();
      } catch (err) {
        console.error('Settings save failed:', err);
      }
      resolve();
    };

    okBtn.addEventListener('click',    () => finish(true));
    cancelBtn.addEventListener('click',() => finish(false));
    overlay.addEventListener('click',  e => { if (e.target === overlay) finish(false); });
    overlay.addEventListener('keydown', e => {
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Enter')  finish(true);
    });
  });
}

// ── Menu event handling ───────────────────────────

window.__TAURI__.event.listen('menu', async e => {
  switch (e.payload) {
    case 'toggle-left':   togglePin('left');   break;
    case 'toggle-right':  togglePin('right');  break;
    case 'toggle-top':    togglePin('top');    break;
    case 'toggle-bottom': togglePin('bottom'); break;

    case 'view-today': {
      const d = new Date();
      const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      openJournalDate(dateStr);
      break;
    }
    case 'view-tasks':  loadTasksView(); break;
    case 'view-render': {
      const next = editorArea.dataset.mode === 'render' ? 'edit' : 'render';
      setMode(next);
      break;
    }

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

    case 'file-settings': {
      await showSettingsDialog();
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


// ── Widget instantiation ──────────────────────────
// Create all widgets up front and register them.  The layout (which sidebar
// each widget lives in, and in what order) is either restored from
// preferences.json (in the datastore) or falls back to the defaults below.

const pageWidget = new PageWidget({
  onOpenInEditor: openWikiPage,
  onOpenJournal:  openJournalDate,
  onEditPage:     openFilePath,
});

const bottomContentState = { refs: false, meta: false };
function updateBottomVisibility() {
  const hasAny = bottomContentState.refs || bottomContentState.meta;
  setSbState('bottom', hasAny ? 'pinned' : 'hidden');
}

const allWidgetInstances = {
  search:      new SearchWidget({ onOpen: (path, title) => {
    if (searchOpenIn === 'editor') { openFilePath(path); } else { pageWidget.loadPath(path, title); }
  }}),
  page:        pageWidget,
  outline:     new OutlineWidget({ onScrollTo: pos => {
    if (cmView) cmView.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 32 }) });
  }}),
  counter:     new CounterWidget(),
  annotations: new AnnotationsWidget({ onOpen: openFilePath }),
  calendar:    new CalendarWidget({ onDateSelected: openJournalDate }),
  scratchPad:  new ScratchPadWidget(),
  tasks:       new TasksWidget({ onOpen: openFilePath }),
  favorites:   new FavoritesWidget({ onOpen: openFilePath }),
  tags:        new TagsWidget({ onTag: tag => loadTagView(tag) }),
  references:  new ReferencesWidget({
    onOpen: openFilePath,
    onStateChange: has => { bottomContentState.refs = has; updateBottomVisibility(); },
  }),
  metadata:    new MetadataWidget({
    onStateChange: has => { bottomContentState.meta = has; updateBottomVisibility(); },
    onEdit: (key, rawValue) => {
      const newContent = setMetadataInContent(cmView.state.doc.toString(), key, rawValue);
      cmView.dispatch({
        changes: { from: 0, to: cmView.state.doc.length, insert: newContent },
        userEvent: 'metadata.edit',
      });
      if (currentFile) {
        invoke('write_file', { path: currentFile, content: newContent }).catch(console.error);
      }
    },
    onNavigate: (key, value) => loadMetadataView(key, value),
  }),
};

// Register all instances.
for (const [id, inst] of Object.entries(allWidgetInstances)) {
  widgetRegistry.set(id, inst);
}

setDeferFutureTasks(deferFutureTasks);

const defaultLayout = {
  left:   ['search', 'page', 'annotations'],
  right:  ['calendar', 'scratchPad', 'tasks', 'favorites', 'tags'],
  top:    [],
  bottom: ['references', 'metadata'],
};

// Use saved layout if valid; otherwise fall back to defaults.
const hasSavedLayout = Object.values(widgetLayout).some(arr => arr.length > 0);
if (!hasSavedLayout) {
  widgetLayout = JSON.parse(JSON.stringify(defaultLayout));
} else {
  // Merge: any widget in the default layout that is absent from every saved
  // sidebar gets inserted into its default sidebar (handles newly-added widgets).
  const allSaved = new Set(Object.values(widgetLayout).flat());
  for (const [sb, ids] of Object.entries(defaultLayout)) {
    for (const id of ids) {
      if (!allSaved.has(id)) {
        widgetLayout[sb] = [...(widgetLayout[sb] || []), id];
      }
    }
  }
}

// Initialise drag system.
_widgetDrag = initWidgetDrag({
  sbConfig,
  getLayout:      () => widgetLayout,
  setLayout:      l  => { widgetLayout = l; saveUiState(); },
  getRegistry:    () => widgetRegistry,
  remountSidebar,
  getWidgetSizes: () => widgetSizes,
  setWidgetSizes: s  => { widgetSizes = s; saveUiState(); },
});

// Deduplicate: a widget ID may appear in multiple sidebars in stale preferences
// (e.g. from a move that was saved before the dedup fix). First-seen wins so
// the dedup guard in mountWidgets doesn't silently skip the second occurrence.
{
  const seen = new Set();
  for (const sb of ['left', 'right', 'top', 'bottom']) {
    widgetLayout[sb] = (widgetLayout[sb] || []).filter(id => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
}

// Mount widgets per layout.
for (const sidebarName of ['left', 'right', 'top', 'bottom']) {
  const ids = widgetLayout[sidebarName] || [];
  const widgets = ids.map(id => widgetRegistry.get(id)).filter(Boolean);
  widgetLayout[sidebarName] = []; // cleared so mountWidgets repopulates
  mountWidgets(sidebarName, widgets);
}

setMode('edit');
updateCursor(1, 1);

const _d = new Date();
const _todayStr = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`;

// Open today's journal first so the editor is populated before indexing starts.
// Indexing runs on a Rust thread but holds an SQLite write lock while processing
// files; deferring it until after the initial file load prevents widget queries
// (get_backlinks, etc.) from waiting behind that lock.
openJournalDate(_todayStr).then(() => {
  // Index after the initial paint — journal content is visible to the user.
  (async function () {
    function setIndexStatus(html) { indexStatusEl.innerHTML = html; }

    setIndexStatus('<i class="ph ph-circle-notch animate-spin leading-none"></i><span>Indexing…</span>');

    // Count files as they come in, but throttle DOM updates to ≤ 1 per 150 ms
    // to avoid excessive repaints on large datastores.
    let indexed = 0;
    let lastPaint = 0;
    const unlisten = await window.__TAURI__.event.listen('index-progress', () => {
      indexed++;
      const now = Date.now();
      if (now - lastPaint > 150) {
        lastPaint = now;
        setIndexStatus(`<i class="ph ph-circle-notch animate-spin leading-none"></i><span>Indexing… ${indexed}</span>`);
      }
    });

    invoke('index_datastore')
      .then(n => {
        unlisten();
        if (n > 0) {
          setIndexStatus(`<i class="ph ph-check leading-none"></i><span>Indexed ${n} file${n !== 1 ? 's' : ''}</span>`);
        } else {
          setIndexStatus('<i class="ph ph-check leading-none"></i><span>Index up to date</span>');
        }
      })
      .catch(err => {
        unlisten();
        console.warn('[MI] index_datastore failed:', err);
        setIndexStatus('<i class="ph ph-warning leading-none text-yellow-300"></i><span class="text-yellow-300">Index failed</span>');
      });
  }());
});
