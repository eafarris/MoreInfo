import { Widget } from './Widget.js';
import { invoke } from '../tauri.js';
import { isDeferred, isOverdue, isDueToday, computeEffectivePriority, todayIso } from '../dateUtils.js';
import { priorityPillHTML } from '../ui.js';

let _deferFutureTasks = false;
export function setDeferFutureTasks(val) { _deferFutureTasks = val; }

function isFutureJournalTask(t) {
  const m = t.path.match(/(\d{4}-\d{2}-\d{2})\.md$/);
  return m ? m[1] > todayIso() : false;
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const OVERDUE_RE = /@overdue(?![a-zA-Z0-9_-])/;
const RESERVED_AT = new Set(['done', 'due', 'defer', 'priority', 'overdue', 'waiting', 'someday']);

function taskIsOverdue(task) {
  return OVERDUE_RE.test(task.text) || isOverdue(task.due_date, task.first_seen);
}

export class TasksWidget extends Widget {
  /**
   * @param {{ onOpen: (path: string) => void }} opts
   */
  constructor({ onOpen } = {}) {
    super({ id: 'tasks', title: 'Tasks', icon: 'ph-check-square' });
    this._onOpen    = onOpen || (() => {});
    this._list      = null;
    this._input     = null;
    this._clearBtn  = null;
    this._ac        = null;
    this._acIdx     = -1;
    this._query     = '';
    this._allTasks  = [];
    this._contexts  = [];
  }

  get wrapperClass() { return 'flex flex-col border-b border-olive-700'; }

  onMount() {
    this._body.classList.add('flex', 'flex-col');

    // ── Search bar ──────────────────────────────────────────────────────────
    const bar = document.createElement('div');
    bar.className = 'relative shrink-0 px-2 py-1.5 border-b border-olive-700';
    bar.innerHTML = `
      <div class="flex items-center gap-1.5 bg-olive-800 rounded px-2 py-1">
        <i class="ph ph-magnifying-glass text-olive-600 text-xs leading-none shrink-0"></i>
        <input type="text"
          class="flex-1 bg-transparent text-olive-200 text-xs placeholder-olive-600 outline-none min-w-0"
          placeholder="Filter… (@context)"
          autocomplete="off" spellcheck="false" />
        <button class="tw-clear text-olive-600 hover:text-olive-400 leading-none" style="display:none"
                aria-label="Clear">
          <i class="ph ph-x text-xs"></i>
        </button>
      </div>
      <div class="tw-ac hidden absolute left-2 right-2 bg-olive-800 border border-olive-600
                  rounded-b shadow-lg z-50 overflow-y-auto max-h-36"></div>`;
    this._body.appendChild(bar);

    this._input    = bar.querySelector('input');
    this._clearBtn = bar.querySelector('.tw-clear');
    this._ac       = bar.querySelector('.tw-ac');

    // ── Task list ────────────────────────────────────────────────────────────
    this._list = document.createElement('div');
    this._list.className = 'overflow-y-auto flex-1 min-h-0';
    this._body.appendChild(this._list);

    // ── Input events ─────────────────────────────────────────────────────────
    this._input.addEventListener('input', () => {
      this._query = this._input.value;
      this._clearBtn.style.display = this._query ? '' : 'none';
      this._renderAc();
      this._render();
    });

    this._clearBtn.addEventListener('click', () => {
      this._input.value = '';
      this._query = '';
      this._clearBtn.style.display = 'none';
      this._hideAc();
      this._render();
      this._input.focus();
    });

    // Keyboard navigation for autocomplete.
    this._input.addEventListener('keydown', e => {
      if (this._ac.classList.contains('hidden')) return;
      const items = [...this._ac.querySelectorAll('[data-ctx]')];
      if (!items.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this._acIdx = Math.min(this._acIdx + 1, items.length - 1);
        this._highlightAc(items);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this._acIdx = Math.max(this._acIdx - 1, -1);
        this._highlightAc(items);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        const target = this._acIdx >= 0 ? items[this._acIdx]
                     : items.length === 1 ? items[0] : null;
        if (target) { e.preventDefault(); this._selectAc(target.dataset.ctx); }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this._hideAc();
      }
    });

    // Mousedown (not click) so focus stays in the input.
    this._ac.addEventListener('mousedown', e => {
      e.preventDefault();
      const item = e.target.closest('[data-ctx]');
      if (item) this._selectAc(item.dataset.ctx);
    });

    // ── Task list click ──────────────────────────────────────────────────────
    this._list.addEventListener('click', e => {
      const item = e.target.closest('[data-path]');
      if (item) this._onOpen(item.dataset.path);
    });

    this.refresh();
  }

  onFileSaved() { this.refresh(); }

  refresh() {
    invoke('list_tasks', { checked: false })
      .then(tasks => { this._allTasks = tasks; this._render(); })
      .catch(console.error);
  }

  // ── Autocomplete helpers ────────────────────────────────────────────────────

  /** Returns { prefix, atPos } when the cursor is in a @partial token, else null. */
  _acTrigger() {
    const val = this._input.value;
    const m   = val.match(/(?:^|\s)@([a-zA-Z0-9_-]*)$/);
    if (!m) return null;
    return { prefix: m[1].toLowerCase(), atPos: val.length - m[1].length - 1 };
  }

  _renderAc() {
    const trigger = this._acTrigger();
    if (!trigger) { this._hideAc(); return; }
    const matches = this._contexts.filter(c => c.startsWith(trigger.prefix));
    if (!matches.length) { this._hideAc(); return; }
    this._acIdx = -1;
    this._ac.innerHTML = matches.map(c =>
      `<div data-ctx="${esc(c)}"
        class="px-3 py-1 text-xs text-olive-300 cursor-pointer hover:bg-olive-700 select-none">
        @${esc(c)}
      </div>`
    ).join('');
    this._ac.classList.remove('hidden');
  }

  _hideAc() {
    this._ac.classList.add('hidden');
    this._acIdx = -1;
  }

  _highlightAc(items) {
    items.forEach((el, i) => el.classList.toggle('bg-olive-700', i === this._acIdx));
  }

  _selectAc(ctx) {
    const trigger = this._acTrigger();
    if (!trigger) return;
    const before = this._input.value.slice(0, trigger.atPos);
    this._input.value = `${before}@${ctx} `;
    this._query = this._input.value;
    this._clearBtn.style.display = '';
    this._hideAc();
    this._render();
    this._input.focus();
  }

  // ── Filtering ──────────────────────────────────────────────────────────────

  _extractContexts(tasks) {
    const seen = new Set();
    const re   = /@([a-zA-Z][a-zA-Z0-9_-]*)/g;
    for (const t of tasks) {
      let m; re.lastIndex = 0;
      while ((m = re.exec(t.text)) !== null) {
        const n = m[1].toLowerCase();
        if (!RESERVED_AT.has(n)) seen.add(n);
      }
    }
    return [...seen].sort();
  }

  _filterTasks(tasks) {
    const q = this._query.trim().toLowerCase();
    if (!q) return tasks;

    const contexts = [];
    const terms    = [];
    for (const token of q.split(/\s+/)) {
      if (!token) continue;
      if (token.startsWith('@')) { const c = token.slice(1); if (c) contexts.push(c); }
      else terms.push(token);
    }

    return tasks.filter(t => {
      const text = t.text.toLowerCase();
      for (const ctx of contexts) {
        if (!new RegExp(`@${ctx}[a-zA-Z0-9_-]*`).test(text)) return false;
      }
      for (const term of terms) {
        if (!text.includes(term)) return false;
      }
      return true;
    });
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  _render() {
    if (!this._list) return;

    this._contexts = this._extractContexts(this._allTasks);
    const tasks    = this._filterTasks(this._allTasks);

    // Separate into active and deferred per page → per heading bucket.
    const byPage = new Map();
    for (const task of tasks) {
      if (!byPage.has(task.path)) {
        byPage.set(task.path, { title: task.title, byHeading: new Map(), deferred: [] });
      }
      const entry = byPage.get(task.path);
      task._effectivePriority = computeEffectivePriority(
        task.priority ?? 10, task.due_date, task.first_seen
      );
      if (isDeferred(task.defer_until)) {
        entry.deferred.push(task);
      } else if (_deferFutureTasks && isFutureJournalTask(task)) {
        // hidden — future journal task deferred by preference
      } else {
        const h = task.implicit_heading || '';
        if (!entry.byHeading.has(h)) entry.byHeading.set(h, []);
        entry.byHeading.get(h).push(task);
      }
    }

    const pages = [...byPage.entries()].filter(
      ([, { byHeading, deferred }]) => byHeading.size > 0 || deferred.length > 0
    );

    if (!pages.length) {
      this._list.innerHTML = `
        <div class="flex flex-col items-center gap-1.5 py-5 text-olive-700">
          <i class="ph ph-check-square text-2xl leading-none"></i>
          <p class="text-[10px] text-olive-600">${this._query.trim() ? 'No matching tasks' : 'No open tasks'}</p>
        </div>`;
      return;
    }

    this._list.innerHTML = pages.map(([path, { title, byHeading, deferred }]) => {
      const label = esc(title || path.split('/').pop().replace(/\.md$/, ''));

      const activeRows = [...byHeading.entries()].map(([heading, taskList]) => {
        const headingRow = heading ? `
          <div class="flex items-center gap-1 px-3 pt-1.5 pb-0.5">
            <i class="ph ph-hash text-[9px] text-olive-600 leading-none shrink-0"></i>
            <span class="text-[9px] text-olive-600 truncate italic">${esc(heading)}</span>
          </div>` : '';
        taskList.sort((a, b) => a._effectivePriority - b._effectivePriority);
        const rows = taskList.map(t => {
          const overdue  = taskIsOverdue(t);
          const dueToday = !overdue && isDueToday(t.due_date, t.first_seen);
          const rowCls  = 'flex items-start gap-2 px-3 py-1 hover:bg-olive-800/50 transition-colors';
          const textCls = 'text-xs text-olive-300 leading-snug';
          const cbCls   = overdue
            ? 'cm-task-checkbox cm-task-cb-overdue shrink-0 mt-px'
            : 'cm-task-checkbox shrink-0 mt-px';
          const ep = t._effectivePriority;
          const priBadge = priorityPillHTML(ep);
          return `
          <div class="${rowCls}">
            <span class="${cbCls}" style="pointer-events:none"></span>
            ${priBadge}
            <span class="${textCls}">${esc(t.text || '…')}</span>
          </div>`;
        }).join('');
        return headingRow + rows;
      }).join('');

      const deferredRow = deferred.length ? `
        <div class="flex items-start gap-2 px-3 py-1">
          <span class="cm-task-checkbox shrink-0 mt-px opacity-30" style="pointer-events:none"></span>
          <span class="text-xs text-olive-600 leading-snug italic">(deferred tasks)</span>
        </div>` : '';

      return `
        <div class="border-b border-olive-800 last:border-0">
          <div data-path="${esc(path)}"
            class="flex items-center gap-1.5 px-3 py-1.5 cursor-pointer hover:bg-olive-800
                   transition-colors sticky top-0 z-10 bg-transparent">
            <i class="ph ph-file-text text-[10px] text-olive-600 shrink-0 leading-none"></i>
            <span class="text-[10px] font-semibold text-olive-500 truncate uppercase tracking-wide">
              ${label}
            </span>
          </div>
          ${activeRows}${deferredRow}
        </div>`;
    }).join('');
  }
}
