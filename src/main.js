(function () {
  'use strict';

  // Tauri v2 injects window.__TAURI__ when withGlobalTauri is true.
  function invoke(cmd, args) {
    return window.__TAURI__.core.invoke(cmd, args);
  }

  function dialog() {
    return window.__TAURI__.dialog;
  }

  // ── State ─────────────────────────────────────────

  let currentFile  = null;

  let metaTimer    = null;
  let mdTimer      = null;

  // ── DOM refs ──────────────────────────────────────

  const editor          = document.getElementById('editor');
  const metadataList    = document.getElementById('metadata-list');
  const metadataCount   = document.getElementById('metadata-count');
  const editorArea      = document.getElementById('editor-area');
  const editorPane      = document.getElementById('editor-pane');
  const vDivider        = document.getElementById('v-divider');
  const markdownContent = document.getElementById('markdown-content');
  const fileNameEl      = document.getElementById('file-name');
  const modifiedEl      = document.getElementById('modified-indicator');
  const cursorEl        = document.getElementById('cursor-info');

  // ── Helpers ───────────────────────────────────────

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function basename(path) {
    return path.replace(/\\/g, '/').split('/').pop();
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

  function formatDate(iso) {
    // Add a noon time so timezone offsets never flip the calendar day.
    try {
      const d = new Date(iso + 'T12:00:00');
      return d.toLocaleDateString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
      });
    } catch {
      return iso;
    }
  }

  // ── Metadata rendering ────────────────────────────

  // ── Resize ────────────────────────────────────────

  const MIN_W  = 120;
  const MAX_W  = () => Math.floor(editorArea.offsetWidth * 0.85);

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

  // ── Metadata rendering ────────────────────────────

  function renderEntry(key, val) {
    let valueHtml;

    switch (val.type) {

      case 'date': {
        const human = formatDate(val.value);
        valueHtml = `
          <div class="flex items-center gap-1.5 mt-1">
            <i class="ph ph-calendar-blank text-sky-500 text-xs leading-none flex-shrink-0"></i>
            <span class="text-neutral-200 text-sm leading-snug" title="${esc(val.value)}">${esc(human)}</span>
          </div>`;
        break;
      }

      case 'array': {
        if (val.value.length === 0) {
          valueHtml = `<p class="text-neutral-600 text-xs italic mt-1">empty</p>`;
        } else {
          const chips = val.value.map(item =>
            `<span class="inline-flex px-1.5 py-px rounded bg-neutral-700 border border-neutral-600 text-neutral-300 text-xs font-mono">${esc(item)}</span>`
          ).join('');
          valueHtml = `<div class="flex flex-wrap gap-1 mt-1">${chips}</div>`;
        }
        break;
      }

      default: { // text
        valueHtml = `<p class="text-neutral-200 text-sm mt-1 break-words leading-snug">${esc(val.value)}</p>`;
      }
    }

    return `
      <div class="rounded-md px-3 py-2 bg-neutral-800/60 border border-neutral-700/50">
        <dt class="text-xs font-mono text-neutral-500 truncate">${esc(key)}</dt>
        ${valueHtml}
      </div>`;
  }

  function renderEmptyState() {
    return `
      <div class="flex items-center gap-2 h-full px-4 text-neutral-700">
        <i class="ph ph-note text-lg leading-none flex-shrink-0"></i>
        <p class="text-xs">No front matter found — add a
          <code class="font-mono bg-neutral-800 px-1 rounded text-neutral-600">--- … ---</code>
          block to define variables.
        </p>
      </div>`;
  }

  async function renderMetadata() {
    try {
      const fm      = await invoke('get_front_matter', { content: editor.value });
      const entries = Object.entries(fm).sort(([a], [b]) => a.localeCompare(b));

      metadataCount.textContent = entries.length === 0
        ? ''
        : `${entries.length} variable${entries.length !== 1 ? 's' : ''}`;

      metadataList.innerHTML = entries.length === 0
        ? renderEmptyState()
        : `<div class="flex flex-col gap-2 p-3">${entries.map(([k, v]) => renderEntry(k, v)).join('')}</div>`;

    } catch (e) {
      console.error('get_front_matter failed:', e);
    }
  }

  function scheduleMetadata() {
    clearTimeout(metaTimer);
    metaTimer = setTimeout(renderMetadata, 200);
  }

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

  // ── File operations ───────────────────────────────

  async function openFile() {
    try {
      const selected = await dialog().open({
        multiple: false,
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'txt'] }],
      });
      if (!selected) return;
      const path = Array.isArray(selected) ? selected[0] : selected;
      editor.value = await invoke('read_file', { path });
      setCurrentFile(path);
      setModified(false);
      await renderMetadata();
      if (editorArea.dataset.mode === 'render') await renderMarkdown();
      editor.focus();
    } catch (e) {
      console.error('openFile failed:', e);
      alert('Could not open file:\n' + e);
    }
  }

  async function saveFile() {
    if (!currentFile) { await saveFileAs(); return; }
    try {
      await invoke('write_file', { path: currentFile, content: editor.value });
      setModified(false);
    } catch (e) {
      console.error('saveFile failed:', e);
      alert('Could not save file:\n' + e);
    }
  }

  async function saveFileAs() {
    try {
      const path = await dialog().save({
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
      });
      if (!path) return;
      await invoke('write_file', { path, content: editor.value });
      setCurrentFile(path);
      setModified(false);
    } catch (e) {
      console.error('saveFileAs failed:', e);
      alert('Could not save file:\n' + e);
    }
  }

  // ── View mode ─────────────────────────────────────

  function setMode(mode) {
    editorArea.dataset.mode = mode;
    document.querySelectorAll('[data-mode]').forEach(btn => {
      if (btn.dataset.mode === mode) {
        btn.dataset.active = '';
      } else {
        delete btn.dataset.active;
      }
    });
    if (mode === 'render') renderMarkdown();
    if (mode !== 'render') editorPane.style.flex = '';
  }

  // ── Event listeners ───────────────────────────────

  editor.addEventListener('input', () => {
    setModified(true);
    scheduleMetadata();
    if (editorArea.dataset.mode === 'render') scheduleMarkdown();
  });

  editor.addEventListener('keyup',   updateCursor);
  editor.addEventListener('click',   updateCursor);
  editor.addEventListener('mouseup', updateCursor);

  // Tab → two spaces
  editor.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const s   = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(end);
    editor.selectionStart = editor.selectionEnd = s + 2;
  });

  document.getElementById('btn-open').addEventListener('click', openFile);
  document.getElementById('btn-save').addEventListener('click', saveFile);
  document.getElementById('btn-save-as').addEventListener('click', saveFileAs);

  document.querySelectorAll('[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  });

  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if      (e.key === 'o' && !e.shiftKey) { e.preventDefault(); openFile(); }
    else if (e.key === 's' &&  e.shiftKey) { e.preventDefault(); saveFileAs(); }
    else if (e.key === 's' && !e.shiftKey) { e.preventDefault(); saveFile(); }
  });

  // ── Calendar widget ───────────────────────────────

  const CAL_MONTHS = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December',
  ];
  const CAL_DAYS = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  const calWidget = document.getElementById('calendar-widget');

  const _now = new Date();
  const calState = {
    year:       _now.getFullYear(),
    month:      _now.getMonth(),      // 0-based
    view:       'days',               // 'days' | 'picker'
    pickerYear: _now.getFullYear(),
  };

  function renderCalDays() {
    const { year, month } = calState;
    const today = new Date();
    const todayY = today.getFullYear();
    const todayM = today.getMonth();
    const todayD = today.getDate();

    const firstDow = new Date(year, month, 1).getDay();   // 0=Sun
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrev  = new Date(year, month, 0).getDate();

    let cells = '';
    // leading cells from previous month
    for (let i = firstDow - 1; i >= 0; i--) {
      cells += `<span class="text-neutral-600">${daysInPrev - i}</span>`;
    }
    // current month days
    for (let d = 1; d <= daysInMonth; d++) {
      const isToday = (year === todayY && month === todayM && d === todayD);
      cells += isToday
        ? `<span class="rounded-full bg-sky-600 text-white font-semibold w-6 h-6 flex items-center justify-center mx-auto">${d}</span>`
        : `<span class="text-neutral-300 hover:text-white cursor-default">${d}</span>`;
    }
    // trailing cells to fill final row
    const total = firstDow + daysInMonth;
    const trailing = total % 7 === 0 ? 0 : 7 - (total % 7);
    for (let d = 1; d <= trailing; d++) {
      cells += `<span class="text-neutral-600">${d}</span>`;
    }

    const dayHeaders = CAL_DAYS.map(d =>
      `<span class="text-neutral-500 text-xs font-semibold">${d}</span>`
    ).join('');

    return `
      <div class="flex items-center justify-between px-3 py-2">
        <button id="cal-prev" class="text-neutral-400 hover:text-white px-1">&#8249;</button>
        <button id="cal-title" class="text-xs font-semibold text-neutral-200 hover:text-sky-400 transition-colors">
          ${CAL_MONTHS[month]} ${year}
        </button>
        <button id="cal-next" class="text-neutral-400 hover:text-white px-1">&#8250;</button>
      </div>
      <div class="grid grid-cols-7 gap-y-1 px-2 pb-3 text-center text-xs">
        ${dayHeaders}
        ${cells}
      </div>`;
  }

  function renderCalPicker() {
    const { pickerYear } = calState;
    const monthBtns = CAL_MONTHS.map((m, i) =>
      `<button data-pick-month="${i}"
        class="text-xs py-1 rounded hover:bg-neutral-700 text-neutral-300 hover:text-white transition-colors">
        ${m.slice(0, 3)}
      </button>`
    ).join('');

    return `
      <div class="flex items-center justify-between px-3 py-2">
        <button id="cal-picker-prev" class="text-neutral-400 hover:text-white px-1">&#8249;</button>
        <span class="text-xs font-semibold text-neutral-200">${pickerYear}</span>
        <button id="cal-picker-next" class="text-neutral-400 hover:text-white px-1">&#8250;</button>
      </div>
      <div class="grid grid-cols-3 gap-1 px-2 pb-3">
        ${monthBtns}
      </div>
      <div class="px-2 pb-2 flex gap-1.5">
        <button id="cal-picker-today" class="flex-1 text-xs py-1 rounded bg-sky-700 hover:bg-sky-600 text-white transition-colors">Today</button>
        <button id="cal-picker-cancel" class="flex-1 text-xs py-1 rounded bg-neutral-800 hover:bg-neutral-700 text-neutral-400 hover:text-white transition-colors">Cancel</button>
      </div>`;
  }

  function renderCal() {
    calWidget.innerHTML = `
      <div class="border-b border-neutral-700 px-3 py-1.5 flex items-center gap-1.5">
        <i class="ph ph-calendar-blank text-neutral-500 text-sm leading-none"></i>
        <span class="text-xs font-semibold text-neutral-500 tracking-wide uppercase">Calendar</span>
      </div>
      <div id="cal-body">
        ${calState.view === 'days' ? renderCalDays() : renderCalPicker()}
      </div>`;

    // Bind events
    if (calState.view === 'days') {
      document.getElementById('cal-prev').addEventListener('click', () => {
        calState.month--;
        if (calState.month < 0) { calState.month = 11; calState.year--; }
        renderCal();
      });
      document.getElementById('cal-next').addEventListener('click', () => {
        calState.month++;
        if (calState.month > 11) { calState.month = 0; calState.year++; }
        renderCal();
      });
      document.getElementById('cal-title').addEventListener('click', () => {
        calState.view = 'picker';
        calState.pickerYear = calState.year;
        renderCal();
      });
      document.getElementById('cal-title').addEventListener('dblclick', e => {
        e.stopPropagation();
        const now = new Date();
        calState.year  = now.getFullYear();
        calState.month = now.getMonth();
        calState.view  = 'days';
        renderCal();
      });
    } else {
      document.getElementById('cal-picker-prev').addEventListener('click', () => {
        calState.pickerYear--;
        renderCal();
      });
      document.getElementById('cal-picker-next').addEventListener('click', () => {
        calState.pickerYear++;
        renderCal();
      });
      document.getElementById('cal-picker-today').addEventListener('click', () => {
        const now = new Date();
        calState.year  = now.getFullYear();
        calState.month = now.getMonth();
        calState.view  = 'days';
        renderCal();
      });
      document.getElementById('cal-picker-cancel').addEventListener('click', () => {
        calState.view = 'days';
        renderCal();
      });
      document.querySelectorAll('[data-pick-month]').forEach(btn => {
        btn.addEventListener('click', () => {
          calState.year  = calState.pickerYear;
          calState.month = parseInt(btn.dataset.pickMonth, 10);
          calState.view  = 'days';
          renderCal();
        });
      });
    }
  }

  // ── Init ──────────────────────────────────────────

  setCurrentFile(null);
  setMode('edit');
  updateCursor();
  renderMetadata();
  renderCal();
  editor.focus();
})();
