import { invoke } from './tauri.js';
import { CalendarWidget }    from './widgets/CalendarWidget.js';
import { MetadataWidget }    from './widgets/MetadataWidget.js';
import { ReferencesWidget }  from './widgets/ReferencesWidget.js';

// ── State ─────────────────────────────────────────

let currentFile   = null;
let datastorePath = null;  // set during init via get_datastore_path
let changeTimer   = null;
let saveTimer     = null;
let mdTimer       = null;

// ── DOM refs ──────────────────────────────────────

const editor          = document.getElementById('editor');
const editorArea      = document.getElementById('editor-area');
const editorPane      = document.getElementById('editor-pane');
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

function updateCursor() {
  const val    = editor.value;
  const pos    = editor.selectionStart;
  const before = val.slice(0, pos);
  const line   = before.split('\n').length;
  const col    = before.length - before.lastIndexOf('\n');
  cursorEl.textContent = `Ln ${line}, Col ${col}`;
}

// ── Date formatting ───────────────────────────────

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function formatDateLong(iso) {
  try {
    const d = new Date(iso + 'T12:00:00');
    return `${d.getDate()} ${MONTH_ABBR[d.getMonth()]} ${d.getFullYear()}`;
  } catch { return iso; }
}

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
    const html = await invoke('parse_markdown', { markdown: editor.value });
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

function scheduleDocumentChange() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => handleDocumentChange(editor.value), 200);
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

async function autoSave() {
  const content = editor.value;
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
  } catch (e) {
    console.error('autoSave failed:', e);
  }
}

function scheduleAutoSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(autoSave, 1500);
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
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup',   stopDrag);
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
  }

  handle.addEventListener('mousedown', e => {
    isResizing = true;
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
    return `<a class="bc-item hover:text-neutral-300 cursor-pointer transition-colors" data-index="${i}">${label}</a>`
         + `<span class="bc-sep mx-1 text-neutral-700">›</span>`;
  }).join('') + `<span class="text-neutral-400">${escapeHtml(docTitle.textContent || basename(currentFile || '').replace(/\.[^.]+$/, ''))}</span>`;
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
  editor.value = content;
  setCurrentFile(path);
  setModified(false);
  const metadata = await invoke('get_metadata', { content });
  updateDocTitle(metadata, content);
  mountedWidgets.forEach(w => w.onFileOpen(path, content, metadata));
  if (editorArea.dataset.mode === 'render') await renderMarkdown();
  renderBreadcrumbs();
  editor.focus();
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


// Edit mode: Cmd/Ctrl+Click anywhere in the textarea detects [[...]] at cursor
editor.addEventListener('click', e => {
  if (!e.metaKey && !e.ctrlKey) return;
  const val = editor.value;
  const pos = editor.selectionStart;

  // Search backward for [[
  let start = pos;
  while (start > 1 && !(val[start - 2] === '[' && val[start - 1] === '[')) start--;
  if (start < 2) return;
  start -= 2; // point at first [

  // Search forward for ]]
  let end = pos;
  while (end + 1 < val.length && !(val[end] === ']' && val[end + 1] === ']')) end++;
  if (end + 1 >= val.length && !(val[end] === ']' && val[end + 1] === ']')) return;

  const title = val.slice(start + 2, end).trim();
  if (title) openWikiPage(title);
});

// ── Wiki-link autocomplete ────────────────────────

const acPopup  = document.getElementById('wiki-ac');
const acList   = document.getElementById('wiki-ac-list');
let   allPages = [];
let   ac       = { active: false, items: [], index: 0 };

invoke('list_pages').then(pages => { allPages = pages; }).catch(console.error);

// Returns { query, bracketStart } if the cursor is inside an open [[...
// The [[ must be preceded by whitespace or be at position 0.
function getAcContext() {
  const pos    = editor.selectionStart;
  const before = editor.value.slice(0, pos);
  const idx    = before.lastIndexOf('[[');
  if (idx === -1) return null;
  if (before.slice(idx + 2).includes(']]')) return null;
  if (idx > 0 && !/[\s\n]/.test(before[idx - 1])) return null;
  return { query: before.slice(idx + 2), bracketStart: idx };
}

function filterPages(query) {
  if (!allPages.length) return [];
  const q = query.toLowerCase();
  return allPages.filter(p => p.title.toLowerCase().startsWith(q)).slice(0, 8);
}

// Mirror-div trick: returns { top, left } in viewport coords for the caret.
function caretCoords() {
  const ta    = editor;
  const cs    = window.getComputedStyle(ta);
  const m     = document.createElement('div');
  for (const p of ['fontFamily','fontSize','fontWeight','lineHeight',
                    'letterSpacing','paddingTop','paddingRight','paddingBottom','paddingLeft',
                    'borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth',
                    'boxSizing']) {
    m.style[p] = cs[p];
  }
  m.style.position     = 'absolute';
  m.style.visibility   = 'hidden';
  m.style.top          = '-9999px';
  m.style.left         = '-9999px';
  m.style.width        = ta.clientWidth + 'px';
  m.style.whiteSpace   = 'pre-wrap';
  m.style.wordBreak    = 'break-word';
  m.style.overflowWrap = 'break-word';
  m.style.overflow     = 'hidden';

  const pos  = ta.selectionStart;
  const span = document.createElement('span');
  span.textContent = ta.value.slice(pos) || '\u200b';
  m.textContent = ta.value.slice(0, pos);
  m.appendChild(span);
  document.body.appendChild(m);

  const rect = ta.getBoundingClientRect();
  const top  = rect.top  + span.offsetTop  - ta.scrollTop;
  const left = rect.left + span.offsetLeft - ta.scrollLeft;
  document.body.removeChild(m);
  return { top, left };
}

function renderAcItems() {
  acList.innerHTML = ac.items.map((p, i) => {
    const sel = i === ac.index;
    return `<li data-ac-index="${i}"
      class="px-3 py-1.5 text-xs cursor-pointer select-none truncate
             ${sel ? 'bg-sky-700 text-white' : 'text-neutral-200 hover:bg-neutral-700'}"
    >${escapeHtml(p.title)}</li>`;
  }).join('');
}

function showAc(items) {
  ac.active = true;
  ac.items  = items;
  ac.index  = 0;
  renderAcItems();
  acPopup.style.display = 'block';

  const lh     = parseFloat(window.getComputedStyle(editor).lineHeight) || 20;
  const coords = caretCoords();
  const popW   = 192; // min-w-48
  let top  = coords.top  + lh + 4;
  let left = coords.left;
  if (left + popW > window.innerWidth  - 8) left = window.innerWidth  - popW - 8;
  if (top  + 208  > window.innerHeight - 8) top  = coords.top - 208 - 4;
  acPopup.style.top  = top  + 'px';
  acPopup.style.left = left + 'px';
}

function hideAc() {
  ac.active = false;
  ac.items  = [];
  ac.index  = 0;
  acPopup.style.display = 'none';
}

function commitAc(item) {
  const ctx = getAcContext();
  if (!ctx) { hideAc(); return; }
  const val    = editor.value;
  const pos    = editor.selectionStart;
  const insert = `[[${item.title}]] `;
  editor.value = val.slice(0, ctx.bracketStart) + insert + val.slice(pos);
  const newPos = ctx.bracketStart + insert.length;
  editor.setSelectionRange(newPos, newPos);
  hideAc();
  scheduleDocumentChange();
  scheduleAutoSave();
}

acList.addEventListener('click', e => {
  const li = e.target.closest('[data-ac-index]');
  if (!li) return;
  commitAc(ac.items[parseInt(li.dataset.acIndex, 10)]);
  editor.focus();
});

acList.addEventListener('mousemove', e => {
  const li = e.target.closest('[data-ac-index]');
  if (!li) return;
  const i = parseInt(li.dataset.acIndex, 10);
  if (i !== ac.index) { ac.index = i; renderAcItems(); }
});

document.addEventListener('click', e => {
  if (ac.active && !acPopup.contains(e.target)) hideAc();
});

// ── Event listeners ───────────────────────────────

editor.addEventListener('input', () => {
  setModified(true);
  scheduleDocumentChange();
  scheduleAutoSave();
  if (editorArea.dataset.mode === 'render') scheduleMarkdown();
  // Autocomplete: check context after every keystroke
  const ctx = getAcContext();
  if (!ctx) { hideAc(); return; }
  const items = filterPages(ctx.query);
  if (items.length) showAc(items); else hideAc();
});

editor.addEventListener('keyup',   updateCursor);
editor.addEventListener('click',   updateCursor);
editor.addEventListener('mouseup', updateCursor);

// Autocomplete keyboard navigation (capture phase — runs before all other handlers).
editor.addEventListener('keydown', e => {
  if (!ac.active) return;
  switch (e.key) {
    case 'Escape':
      e.preventDefault();
      hideAc();
      break;
    case 'ArrowDown':
      e.preventDefault();
      ac.index = (ac.index + 1) % ac.items.length;
      renderAcItems();
      break;
    case 'ArrowUp':
      e.preventDefault();
      ac.index = (ac.index - 1 + ac.items.length) % ac.items.length;
      renderAcItems();
      break;
    case 'Enter':
    case ' ':
    case 'Tab':
      e.preventDefault();
      commitAc(ac.items[ac.index]);
      break;
  }
}, true);

editor.addEventListener('keydown', e => {
  if (e.key !== 'Tab') return;
  e.preventDefault();
  const s   = editor.selectionStart;
  const end = editor.selectionEnd;
  editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(end);
  editor.selectionStart = editor.selectionEnd = s + 2;
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
updateCursor();

const _d = new Date();
const _todayStr = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, '0')}-${String(_d.getDate()).padStart(2, '0')}`;
openJournalDate(_todayStr);
