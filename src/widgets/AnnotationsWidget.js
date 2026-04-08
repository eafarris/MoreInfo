import { Widget } from './Widget.js';
import { invoke } from '../tauri.js';

// Matches the per-keyword colours defined in editor.js / input.css.
const KEYWORD_DOT = {
  TODO:  'bg-amber-400',
  FIXME: 'bg-rose-400',
  NOTE:  'bg-sky-400',
  IDEA:  'bg-emerald-400',
};

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class AnnotationsWidget extends Widget {
  constructor({ onOpen } = {}) {
    super({ id: 'annotations', title: 'Annotations', icon: 'ph-bookmark' });
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
    invoke('list_annotations')
      .then(annotations => this._render(annotations))
      .catch(console.error);
  }

  _render(annotations) {
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
