import { invoke } from '../tauri.js';
import { Widget } from './Widget.js';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function basename(path) {
  return path.replace(/\\/g, '/').split('/').pop();
}

export class ReferencesWidget extends Widget {
  /**
   * @param {{ onOpen: (path: string) => void, onHasReferences: () => void }} config
   *   onOpen          — callback invoked when the user clicks a reference link
   *   onHasReferences — callback invoked when the current page has ≥1 reference
   */
  constructor({ onOpen, onHasReferences } = {}) {
    super({ id: 'references', title: 'References', icon: 'ph-arrows-in' });
    this._onOpen           = onOpen          || (() => {});
    this._onHasReferences  = onHasReferences || (() => {});
    this._countEl          = null;
    this._currentPath      = null;
  }

  get wrapperClass() { return 'flex flex-col flex-1 min-h-0'; }

  get headerAction() {
    return `<span class="widget-ref-count text-xs text-olive-600 tabular-nums"></span>`;
  }

  onMount() {
    this._countEl = this._container.querySelector('.widget-ref-count');
    this._body.addEventListener('click', e => {
      const link = e.target.closest('a[data-path]');
      if (link) { e.preventDefault(); this._onOpen(link.dataset.path); }
    });
    this._renderEmpty();
  }

  onFileOpen(path, _content, _metadata) {
    this._currentPath = path;
    this._load(path);
  }

  async _load(path) {
    if (!path) { this._renderEmpty(); return; }

    const stem = basename(path).replace(/\.[^.]+$/, '');
    const slug = slugify(stem);
    if (!slug) { this._renderEmpty(); return; }

    try {
      const entries = await invoke('get_backlinks', { slug });
      if (path !== this._currentPath) return; // stale response
      this._render(entries);
    } catch (e) {
      console.error('[ReferencesWidget] get_backlinks failed:', e);
      this._renderEmpty();
    }
  }

  _render(entries) {
    if (!this._body) return;

    if (this._countEl) {
      this._countEl.textContent = entries.length === 0
        ? '' : `${entries.length}`;
    }

    if (entries.length === 0) {
      this._renderEmpty();
      return;
    }

    this._onHasReferences();

    const items = entries.map(e => {
      const title = e.source_title || basename(e.source_path).replace(/\.[^.]+$/, '');
      const ctx   = e.context
        ? `<p class="mt-0.5 ml-3.5 text-xs text-olive-500 italic leading-snug">${esc(e.context)}</p>`
        : '';
      return `
        <div class="px-3 py-2 border-b border-olive-800/60 last:border-0">
          <a class="text-amber-400 text-xs underline decoration-dotted underline-offset-2
                    hover:text-amber-300 hover:decoration-solid cursor-pointer"
             data-path="${esc(e.source_path)}">${esc(title)}</a>
          ${ctx}
        </div>`;
    }).join('');

    this._body.innerHTML = `<div class="flex flex-col">${items}</div>`;
  }

  _renderEmpty() {
    if (!this._body) return;
    if (this._countEl) this._countEl.textContent = '';
    this._body.innerHTML = `
      <div class="flex items-center gap-2 h-full px-4 text-olive-700">
        <i class="ph ph-arrows-in text-lg leading-none shrink-0"></i>
        <p class="text-xs">No linked references to this page.</p>
      </div>`;
  }
}
