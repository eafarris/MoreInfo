import { Widget } from './Widget.js';
import { invoke } from '../tauri.js';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class FavoritesWidget extends Widget {
  /**
   * @param {{ onOpen: (path: string, title: string) => void }} opts
   */
  constructor({ onOpen } = {}) {
    super({ id: 'favorites', title: 'Favorites', icon: 'ph-star' });
    this._onOpen = onOpen || (() => {});
    this._list   = null;
  }

  get wrapperClass() { return 'shrink-0 border-b border-olive-700'; }
  get fixedSize()    { return true; }

  onMount() {
    this._list = document.createElement('div');
    this._list.className = 'overflow-y-auto';
    this._body.classList.add('flex', 'flex-col');
    this._body.appendChild(this._list);

    this._list.addEventListener('click', e => {
      const item = e.target.closest('[data-path]');
      if (item) this._onOpen(item.dataset.path, item.dataset.title);
    });

    this.refresh();
  }

  /** Called by the widget lifecycle after any file save. */
  onFileSaved(_path) { this.refresh(); }

  /** Called externally after a favorite is toggled. */
  refresh() {
    invoke('list_favorites')
      .then(entries => this._render(entries))
      .catch(console.error);
  }

  _render(entries) {
    if (!entries.length) {
      this._list.innerHTML = `
        <div class="flex flex-col items-center gap-1.5 py-5 text-olive-700">
          <i class="ph ph-star text-2xl leading-none"></i>
          <p class="text-[10px] text-olive-600">No favorites yet</p>
        </div>`;
      return;
    }
    this._list.innerHTML = entries.map(e => `
      <div data-path="${esc(e.path)}" data-title="${esc(e.title)}"
        class="flex items-center gap-2 px-3 py-2 border-b border-olive-800 last:border-0
               cursor-pointer hover:bg-olive-800 transition-colors">
        <i class="ph-fill ph-star text-amber-400 text-xs shrink-0 leading-none"></i>
        <p class="text-xs text-olive-200 truncate leading-snug">${esc(e.title)}</p>
      </div>`).join('');
  }
}
