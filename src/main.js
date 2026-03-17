import './input.css';
import { invoke } from './tauri.js';
import { CalendarWidget }    from './widgets/CalendarWidget.js';
import { MetadataWidget }    from './widgets/MetadataWidget.js';
import { ReferencesWidget }  from './widgets/ReferencesWidget.js';
import { PageWidget }        from './widgets/PageWidget.js';
import { createEditor, setEditorPages } from './editor.js';
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

// ── Title derivation ──────────────────────────────

function isJournalFile(path) {
  return path ? /[/\\]\.moreinfo[/\\]journal[/\\]\d{4}-\d{2}-\d{2}\.md$/.test(path) : false;
}

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
  docTitle.textContent = title;
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
  onCmdClick(title) {
    openWikiPage(title);
  },
});

// Populate wiki-link autocomplete with all pages from DB
invoke('list_pages').then(pages => setEditorPages(pages)).catch(console.error);

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

async function renderMarkdown() {
  try {
    const html = await invoke('parse_markdown', { markdown: cmView.state.doc.toString() });
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

const sbState = { left: 'hidden', right: 'pinned', top: 'hidden', bottom: 'hidden' };

const flyoutTimers = {};
let   isResizing   = false;

function applySbState(name) {
  const state = sbState[name];
  const { sidebar, collapsed, btn } = sbConfig[name];

  sidebar.dataset.sbState = state;
  collapsed.classList.toggle('sb-visible', state === 'hidden');

  if (state === 'pinned') btn.dataset.active = '';
  else                    delete btn.dataset.active;
}

function setSbState(name, state) {
  sbState[name] = state;
  applySbState(name);
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

  collapsed.addEventListener('mouseenter', () => startFlyout(name));
  collapsed.addEventListener('mouseleave', () => scheduleDismiss(name));

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

// ── Sidebar resize ────────────────────────────────

const sbSizes = { left: 208, right: 208, top: 160, bottom: 180 };

function setSbSize(name, size) {
  sbSizes[name] = size;
  const { sidebar } = sbConfig[name];
  if (name === 'left' || name === 'right') sidebar.style.width  = size + 'px';
  else                                     sidebar.style.height = size + 'px';
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
  widgets.forEach(widget => {
    const wrapper = document.createElement('div');
    widget.wrapperClass.split(/\s+/).filter(Boolean).forEach(cls => wrapper.classList.add(cls));
    wrapper.dataset.widgetId = widget.id;
    stack.appendChild(wrapper);
    widget.mount(wrapper);
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

async function loadFile(path, content) {
  cmView.dispatch({
    changes: { from: 0, to: cmView.state.doc.length, insert: content },
    selection: { anchor: 0 },
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

// ── Menu event handling ───────────────────────────

window.__TAURI__.event.listen('menu', e => {
  switch (e.payload) {
    case 'toggle-left':   togglePin('left');   break;
    case 'toggle-right':  togglePin('right');  break;
    case 'toggle-top':    togglePin('top');    break;
    case 'toggle-bottom': togglePin('bottom'); break;
  }
});

// ── Init ──────────────────────────────────────────

Object.keys(sbConfig).forEach(name => {
  setSbSize(name, sbSizes[name]);
  applySbState(name);
});

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

mountWidgets('left', [
  new PageWidget({
    onOpenInEditor: openWikiPage,
    onOpenJournal:  openJournalDate,
    onEditPage:     openFilePath,
  }),
]);

mountWidgets('right', [
  new CalendarWidget({ onDateSelected: openJournalDate }),
  new MetadataWidget(),
]);

mountWidgets('bottom', [
  new ReferencesWidget({
    onOpen: openFilePath,
    onHasReferences: () => { if (sbState.bottom !== 'pinned') setSbState('bottom', 'pinned'); },
  }),
]);

setMode('edit');
updateCursor(1, 1);

const _d = new Date();
const _todayStr = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`;
openJournalDate(_todayStr);
