import { Widget } from './Widget.js';
import { invoke } from '../tauri.js';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class TagsWidget extends Widget {
  /**
   * @param {{ onTag: (tag: string) => void }} opts
   */
  constructor({ onTag } = {}) {
    super({ id: 'tags', title: 'Tags', icon: 'ph-hash' });
    this._onTag   = onTag || (() => {});
    this._all     = [];   // { tag, count }[]
    this._query   = '';
    this._list    = null;
    this._input   = null;
    this._clearBtn = null;
  }

  get wrapperClass() { return 'flex flex-col border-b border-olive-700'; }

  onMount() {
    this._body.classList.add('flex', 'flex-col');

    // ── Search bar ──────────────────────────────────────────────────────────
    const bar = document.createElement('div');
    bar.className = 'shrink-0 px-2 py-1.5 border-b border-olive-700';
    bar.innerHTML = `
      <div class="flex items-center gap-1.5 bg-olive-800 rounded px-2 py-1">
        <i class="ph ph-magnifying-glass text-olive-600 text-xs leading-none shrink-0"></i>
        <input type="text"
          class="flex-1 bg-transparent text-olive-200 text-xs placeholder-olive-600 outline-none min-w-0"
          placeholder="Filter tags…"
          autocomplete="off" spellcheck="false" />
        <button class="tw-clear text-olive-600 hover:text-olive-400 leading-none" style="display:none"
                aria-label="Clear">
          <i class="ph ph-x text-xs"></i>
        </button>
      </div>`;
    this._body.appendChild(bar);
    this._input    = bar.querySelector('input');
    this._clearBtn = bar.querySelector('.tw-clear');

    this._input.addEventListener('input', () => {
      this._query = this._input.value;
      this._clearBtn.style.display = this._query ? '' : 'none';
      this._render();
    });
    this._clearBtn.addEventListener('click', () => {
      this._input.value = '';
      this._query = '';
      this._clearBtn.style.display = 'none';
      this._render();
      this._input.focus();
    });

    // ── Tag list ─────────────────────────────────────────────────────────────
    this._list = document.createElement('div');
    this._list.className = 'overflow-y-auto flex-1 min-h-0 p-2';
    this._body.appendChild(this._list);

    this._list.addEventListener('click', e => {
      const btn = e.target.closest('[data-tag]');
      if (btn) this._onTag(btn.dataset.tag);
    });

    this.refresh();
  }

  onFileSaved() { this.refresh(); }

  refresh() {
    invoke('list_tags')
      .then(tags => { this._all = tags; this._render(); })
      .catch(console.error);
  }

  _render() {
    if (!this._list) return;

    const q = this._query.trim().toLowerCase();
    const tags = q
      ? this._all.filter(t => t.tag.includes(q))
      : this._all;

    if (!tags.length) {
      this._list.innerHTML = `
        <div class="flex flex-col items-center gap-1.5 py-5 text-olive-700">
          <i class="ph ph-hash text-2xl leading-none"></i>
          <p class="text-[10px] text-olive-600">${q ? 'No matching tags' : 'No tags yet'}</p>
        </div>`;
      return;
    }

    this._list.innerHTML = `
      <div class="flex flex-wrap gap-1.5">
        ${tags.map(({ tag, count }) => `
          <button data-tag="${esc(tag)}"
            class="flex items-center gap-1 px-2 py-0.5 rounded-full bg-olive-700 hover:bg-amber-700
                   text-olive-200 hover:text-white text-xs transition-colors cursor-pointer leading-snug">
            <span class="ph ph-hash text-[10px] leading-none opacity-60"></span>
            <span>${esc(tag)}</span>
            <span class="text-[10px] opacity-50">${count}</span>
          </button>`).join('')}
      </div>`;
  }
}
