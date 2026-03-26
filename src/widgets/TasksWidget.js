import { Widget } from './Widget.js';
import { invoke } from '../tauri.js';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

  get wrapperClass() { return 'flex flex-col shrink-0 border-b border-olive-700'; }

  onMount() {
    this._body.classList.remove('flex-1', 'min-h-0');
    this._body.style.maxHeight = '20rem';

    this._list = document.createElement('div');
    this._list.className = 'overflow-y-auto';
    this._list.style.maxHeight = '20rem';
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
    if (!tasks.length) {
      this._list.innerHTML = `
        <div class="flex flex-col items-center gap-1.5 py-5 text-olive-700">
          <i class="ph ph-check-square text-2xl leading-none"></i>
          <p class="text-[10px] text-olive-600">No open tasks</p>
        </div>`;
      return;
    }

    // Group by host page
    const byPage = new Map();
    for (const task of tasks) {
      if (!byPage.has(task.path)) {
        byPage.set(task.path, { title: task.title, tasks: [] });
      }
      byPage.get(task.path).tasks.push(task);
    }

    this._list.innerHTML = [...byPage.entries()].map(([path, { title, tasks: pageTasks }]) => `
      <div class="border-b border-olive-800 last:border-0">
        <div data-path="${esc(path)}"
          class="flex items-center gap-1.5 px-3 py-1.5 cursor-pointer hover:bg-olive-800
                 transition-colors sticky top-0 z-10 bg-olive-900">
          <i class="ph ph-file-text text-[10px] text-olive-600 shrink-0 leading-none"></i>
          <span class="text-[10px] font-semibold text-olive-500 truncate uppercase tracking-wide">
            ${esc(title || path.split('/').pop().replace(/\.md$/, ''))}
          </span>
        </div>
        ${pageTasks.map(t => `
          <div class="flex items-start gap-2 px-3 py-1 hover:bg-olive-800/50 transition-colors">
            <span class="cm-task-checkbox shrink-0 mt-px" style="pointer-events:none"></span>
            <span class="text-xs text-olive-300 leading-snug">${esc(t.text || '…')}</span>
          </div>`).join('')}
      </div>`).join('');
  }
}
