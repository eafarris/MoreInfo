import { Widget } from './Widget.js';
import { invoke } from '../tauri.js';

// Matches the per-keyword colours defined in editor.js / input.css.
const KEYWORD_DOT = {
  TODO:  'bg-amber-400',
  FIXME: 'bg-rose-400',
  NOTE:  'bg-sky-400',
  IDEA:  'bg-emerald-400',
};

// Active pill colour per keyword.
const KEYWORD_PILL_ACTIVE = {
  TODO:  'bg-amber-700 text-white',
  FIXME: 'bg-rose-700 text-white',
  NOTE:  'bg-sky-700 text-white',
  IDEA:  'bg-emerald-700 text-white',
};

const PILL_INACTIVE = 'bg-olive-800 text-olive-400 hover:bg-olive-700 hover:text-olive-200';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class AnnotationsWidget extends Widget {
  constructor({ onOpen } = {}) {
    super({ id: 'annotations', title: 'Annotations', icon: 'ph-bookmark' });
    this._onOpen        = onOpen || (() => {});
    this._list          = null;
    this._filterBar     = null;
    this._activeFilters = new Set(); // empty = show all
    this._allAnnotations = [];
  }

  get wrapperClass() { return 'flex flex-col border-b border-olive-700'; }

  onMount() {
    this._body.classList.add('flex', 'flex-col');

    this._filterBar = document.createElement('div');
    this._filterBar.className = 'flex flex-wrap items-center gap-1 px-2 py-1.5 border-b border-olive-800 shrink-0';
    this._filterBar.style.display = 'none';
    this._body.appendChild(this._filterBar);

    this._filterBar.addEventListener('click', e => {
      const pill = e.target.closest('[data-kw]');
      if (!pill) return;
      const kw = pill.dataset.kw;
      if (this._activeFilters.has(kw)) {
        this._activeFilters.delete(kw);
      } else {
        this._activeFilters.add(kw);
      }
      this._renderFilterBar();
      this._renderList();
    });

    this._list = document.createElement('div');
    this._list.className = 'overflow-y-auto flex-1 min-h-0';
    this._body.appendChild(this._list);

    this._list.addEventListener('click', e => {
      const item = e.target.closest('[data-path]');
      if (item) this._onOpen(item.dataset.path);
    });

    this.refresh();
  }

  onFileSaved() { this.refresh(); }

  refresh() {
    invoke('list_annotations')
      .then(annotations => {
        this._allAnnotations = annotations;
        this._renderFilterBar();
        this._renderList();
      })
      .catch(console.error);
  }

  _renderFilterBar() {
    // Collect keywords present in the current annotation set.
    const presentKws = [...new Set(this._allAnnotations.map(a => a.keyword))]
      .filter(kw => kw in KEYWORD_DOT);

    if (presentKws.length <= 1) {
      // No point showing a filter bar for 0 or 1 keyword types.
      this._filterBar.style.display = 'none';
      return;
    }

    this._filterBar.style.display = '';
    this._filterBar.innerHTML = presentKws.map(kw => {
      const isActive  = this._activeFilters.has(kw);
      const activeCs  = KEYWORD_PILL_ACTIVE[kw] ?? 'bg-olive-700 text-white';
      const colorCls  = isActive ? activeCs : PILL_INACTIVE;
      return `<button data-kw="${esc(kw)}"
        class="text-[10px] font-semibold px-1.5 py-0.5 rounded transition-colors cursor-pointer ${colorCls}"
      >${esc(kw)}</button>`;
    }).join('');
  }

  _renderList() {
    const annotations = this._activeFilters.size
      ? this._allAnnotations.filter(a => this._activeFilters.has(a.keyword))
      : this._allAnnotations;

    if (!annotations.length) {
      this._list.innerHTML = `
        <div class="flex flex-col items-center gap-1.5 py-5">
          <i class="ph ph-bookmark text-2xl leading-none text-olive-700"></i>
          <p class="text-[10px] text-olive-600">No annotations</p>
        </div>`;
      return;
    }

    this._list.innerHTML = annotations.map(a => {
      const dot   = KEYWORD_DOT[a.keyword] ?? 'bg-olive-500';
      const title = esc(a.title || a.path.split('/').pop().replace(/\.md$/, ''));
      const body  = esc(a.text || a.keyword);
      return `
        <div data-path="${esc(a.path)}"
          class="flex items-start gap-2 px-3 py-1.5 cursor-pointer hover:bg-olive-800/50 transition-colors">
          <span class="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${dot}"></span>
          <div class="min-w-0">
            <p class="text-xs text-olive-300 leading-snug">${body}</p>
            <p class="text-[10px] text-olive-600 truncate mt-0.5">${title}</p>
          </div>
        </div>`;
    }).join('');
  }
}
