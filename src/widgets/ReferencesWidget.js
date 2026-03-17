import { invoke } from '../tauri.js';
import { Widget } from './Widget.js';

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

  onFileSaved(_path) {
    // Re-query on every save: the saved file may have gained/lost aliases
    // (changing what counts as a reference to it) or new links to the
    // current page (changing what shows as a backlink here).
    this._load(this._currentPath);
  }

  async _load(path) {
    if (!path) { this._renderEmpty(); return; }

    try {
      const [linked, unlinked] = await Promise.all([
        invoke('get_backlinks',           { path }),
        invoke('get_unlinked_references', { path }),
      ]);
      if (path !== this._currentPath) return; // stale response
      this._render(linked, unlinked);
    } catch (e) {
      console.error('[ReferencesWidget] load failed:', e);
      this._renderEmpty();
    }
  }

  _render(linked, unlinked) {
    if (!this._body) return;

    const total = linked.length + unlinked.length;
    if (this._countEl) {
      this._countEl.textContent = total === 0 ? '' : `${total}`;
    }

    if (total === 0) {
      this._renderEmpty();
      return;
    }

    this._onHasReferences();

    const renderItem = (e) => {
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
    };

    const renderSection = (label, count, items) =>
      `<div class="flex-1 min-w-44 flex flex-col border-r border-olive-700/50 last:border-r-0">
         <div class="px-3 py-1 text-xs font-semibold tracking-wide uppercase text-olive-600
                     border-b border-olive-700 bg-olive-900/60 shrink-0">${label}
           <span class="font-normal normal-case">(${count})</span>
         </div>
         <div class="flex flex-col">${items.map(renderItem).join('')}</div>
       </div>`;

    let sections = '';
    if (linked.length > 0)   sections += renderSection('Linked',   linked.length,   linked);
    if (unlinked.length > 0) sections += renderSection('Unlinked', unlinked.length, unlinked);

    this._body.innerHTML = `<div class="flex flex-wrap">${sections}</div>`;
  }

  _renderEmpty() {
    if (!this._body) return;
    if (this._countEl) this._countEl.textContent = '';
    this._body.innerHTML = `
      <div class="flex items-center gap-2 h-full px-4 text-olive-700">
        <i class="ph ph-arrows-in text-lg leading-none shrink-0"></i>
        <p class="text-xs">No references to this page.</p>
      </div>`;
  }
}
