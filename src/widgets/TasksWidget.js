import { Widget } from './Widget.js';
import { invoke } from '../tauri.js';
import { isDeferred, isOverdue, isDueToday, computeEffectivePriority, todayIso } from '../dateUtils.js';

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

function taskIsOverdue(task) {
  return OVERDUE_RE.test(task.text) || isOverdue(task.due_date, task.first_seen);
}

export class TasksWidget extends Widget {
  /**
   * @param {{ onOpen: (path: string) => void }} opts
   */
  constructor({ onOpen } = {}) {
    super({ id: 'tasks', title: 'Tasks', icon: 'ph-check-square' });
    this._onOpen = onOpen || (() => {});
    this._list   = null;
  }

  get wrapperClass() { return 'flex flex-col border-b border-olive-700'; }

  onMount() {
    this._list = document.createElement('div');
    this._list.className = 'overflow-y-auto flex-1 min-h-0';
    this._body.classList.add('flex', 'flex-col');
    this._body.appendChild(this._list);

    this._list.addEventListener('click', e => {
      const item = e.target.closest('[data-path]');
      if (item) this._onOpen(item.dataset.path);
    });

    this.refresh();
  }

  onFileSaved() { this.refresh(); }

  refresh() {
    invoke('list_tasks', { checked: false })
      .then(tasks => this._render(tasks))
      .catch(console.error);
  }

  _render(tasks) {
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

    // Pages with no tasks at all are excluded (checked=false filter handles this upstream).
    const pages = [...byPage.entries()].filter(
      ([, { byHeading, deferred }]) => byHeading.size > 0 || deferred.length > 0
    );

    if (!pages.length) {
      this._list.innerHTML = `
        <div class="flex flex-col items-center gap-1.5 py-5 text-olive-700">
          <i class="ph ph-check-square text-2xl leading-none"></i>
          <p class="text-[10px] text-olive-600">No open tasks</p>
        </div>`;
      return;
    }

    this._list.innerHTML = pages.map(([path, { title, byHeading, deferred }]) => {
      const label = esc(title || path.split('/').pop().replace(/\.md$/, ''));

      // Build task rows, sub-grouped by implicit heading.
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
          const rowCls  = overdue
            ? 'flex items-start gap-2 px-3 py-1 rounded-sm bg-red-800/70 hover:bg-red-700/70 transition-colors'
            : 'flex items-start gap-2 px-3 py-1 hover:bg-olive-800/50 transition-colors';
          const textCls = overdue ? 'text-xs text-white leading-snug'
            : 'text-xs text-olive-300 leading-snug';
          const cbCls   = overdue ? 'shrink-0 mt-px text-white'
            : 'cm-task-checkbox shrink-0 mt-px';
          const ep = t._effectivePriority;
          const priBadge = ep <= 5
            ? `<span class="shrink-0 size-5 text-xs font-bold leading-none inline-flex items-center justify-center ${
                ep <= 1 ? 'text-red-400' :
                ep <= 2 ? 'text-amber-400' :
                ep <= 3 ? 'text-amber-600' :
                          'text-olive-500'
              }">${ep}</span>`
            : `<span class="shrink-0 size-5"></span>`;
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
