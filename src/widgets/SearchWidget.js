import { Widget } from './Widget.js';
import { invoke } from '../tauri.js';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class SearchWidget extends Widget {
  /**
   * @param {{ onOpen: (path: string, title: string) => void }} opts
   */
  constructor({ onOpen } = {}) {
    super({ id: 'search', title: 'Search', icon: 'ph-magnifying-glass' });
    this._onOpen   = onOpen || (() => {});
    this._input    = null;
    this._clearBtn = null;
    this._results  = null;
    this._debounce = null;
  }

  get wrapperClass() { return 'flex flex-col border-b border-olive-700'; }

  onMount() {
    this._body.classList.add('flex', 'flex-col');
    this._body.classList.remove('overflow-y-auto');

    this._body.innerHTML = `
      <div class="flex items-center gap-2 px-3 py-2 border-b border-olive-700 shrink-0 bg-olive-900">
        <i class="ph ph-magnifying-glass text-olive-600 text-sm leading-none shrink-0"></i>
        <input type="text"
          class="flex-1 bg-transparent text-olive-200 text-xs placeholder-olive-600 outline-none"
          placeholder="Full-text search…"
          autocomplete="off" spellcheck="false" />
        <button class="text-olive-600 hover:text-olive-400 leading-none" style="display:none"
                aria-label="Clear">
          <i class="ph ph-x text-xs"></i>
        </button>
      </div>
      <div id="sw-results" class="overflow-y-auto flex-1 min-h-0"></div>
    `;

    this._input    = this._body.querySelector('input');
    this._clearBtn = this._body.querySelector('button');
    this._results  = this._body.querySelector('#sw-results');

    this._renderEmpty();

    this._input.addEventListener('input', () => {
      const q = this._input.value.trim();
      this._clearBtn.style.display = q ? '' : 'none';
      clearTimeout(this._debounce);
      if (!q) { this._renderEmpty(); return; }
      this._debounce = setTimeout(() => this._search(q), 300);
    });

    this._clearBtn.addEventListener('click', () => {
      this._input.value = '';
      this._clearBtn.style.display = 'none';
      this._renderEmpty();
      this._input.focus();
    });

    this._results.addEventListener('click', e => {
      const item = e.target.closest('[data-path]');
      if (item) this._onOpen(item.dataset.path, item.dataset.title);
    });
  }

  onDestroy() {
    clearTimeout(this._debounce);
  }

  async _search(query) {
    this._results.innerHTML = `
      <div class="flex items-center justify-center py-4 text-olive-700">
        <i class="ph ph-circle-notch animate-spin text-xl leading-none"></i>
      </div>`;
    try {
      const hits = await invoke('search_pages', { query });
      this._renderResults(hits, query);
    } catch (err) {
      console.error('[SearchWidget]', err);
      this._results.innerHTML =
        `<p class="px-3 py-4 text-xs text-red-400">Search failed.</p>`;
    }
  }

  _renderResults(hits, query) {
    if (!hits.length) {
      this._results.innerHTML = `
        <p class="px-3 py-3 text-xs text-olive-600 text-center">
          No results for "<span class="text-olive-400">${esc(query)}</span>"
        </p>`;
      return;
    }
    this._results.innerHTML = hits.map(h => `
      <div data-path="${esc(h.path)}" data-title="${esc(h.title)}"
        class="px-3 py-2 border-b border-olive-800 last:border-0 cursor-pointer
               hover:bg-olive-800 transition-colors">
        <p class="text-xs font-medium text-olive-100 truncate leading-snug">${esc(h.title)}</p>
        <p class="text-[10px] text-olive-500 mt-0.5 leading-snug line-clamp-2">${esc(h.snippet)}</p>
      </div>`).join('');
  }

  _renderEmpty() {
    this._results.innerHTML = `
      <div class="flex flex-col items-center gap-1.5 py-5 text-olive-700">
        <i class="ph ph-text-search text-2xl leading-none"></i>
        <p class="text-[10px] text-olive-600">Search across all pages</p>
      </div>`;
  }
}
