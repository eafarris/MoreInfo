import { Widget } from './Widget.js';

const RESERVED_KEYS = new Set(['title']);

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(iso) {
  try {
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  } catch { return iso; }
}

export class MetadataWidget extends Widget {
  /**
   * @param {{ onStateChange: (hasContent: boolean) => void }} config
   *   onStateChange — called with true when metadata exists, false when empty
   */
  constructor({ onStateChange } = {}) {
    super({ id: 'metadata', title: 'Metadata', icon: 'ph-list-dashes' });
    this._onStateChange = onStateChange || (() => {});
    this._hasContent    = false;
    this._countEl       = null;
  }

  get wrapperClass() { return 'flex flex-col flex-1 min-h-0 border-l border-olive-700'; }

  // Adds a variable count at the trailing edge of the header.
  get headerAction() {
    return `<span class="widget-meta-count text-xs text-olive-600 tabular-nums"></span>`;
  }

  onMount() {
    this._countEl = this._container.querySelector('.widget-meta-count');
    this._renderEmpty();
  }

  onDocumentChange(content, metadata) {
    this._render(metadata, content);
  }

  onFileOpen(path, content, metadata) {
    this._render(metadata, content);
  }

  _render(metadata, content = '') {
    if (!this._body || !metadata) return;

    // Merge inline #hashtags from the body into the `tags` entry so they
    // appear alongside front-matter tags in the widget.
    const inlineTags = [...content.matchAll(/(^|[ \t])(#[a-zA-Z][a-zA-Z0-9_-]*)/gm)]
      .map(m => m[2].slice(1).toLowerCase());

    if (inlineTags.length > 0) {
      const existing = metadata.tags?.value ?? [];
      const merged   = [...new Set([...existing.map(t => t.toLowerCase()), ...inlineTags])].sort();
      metadata = { ...metadata, tags: { type: 'array', value: merged } };
    }

    const entries = Object.entries(metadata)
      .filter(([k]) => !RESERVED_KEYS.has(k))
      .sort(([a], [b]) => a.localeCompare(b));

    this._countEl.textContent = entries.length === 0
      ? ''
      : `${entries.length} variable${entries.length !== 1 ? 's' : ''}`;

    const hasContent = entries.length > 0;
    this._body.innerHTML = hasContent
      ? `<div class="flex flex-col gap-2 p-3">${entries.map(([k, v]) => this._renderEntry(k, v)).join('')}</div>`
      : this._emptyState();
    if (hasContent !== this._hasContent) { this._hasContent = hasContent; this._onStateChange(hasContent); }
  }

  _renderEmpty() {
    if (!this._body) return;
    if (this._countEl) this._countEl.textContent = '';
    this._body.innerHTML = this._emptyState();
    if (this._hasContent) { this._hasContent = false; this._onStateChange(false); }
  }

  _emptyState() {
    return `
      <div class="flex items-center gap-2 h-full px-4 text-olive-700">
        <i class="ph ph-note text-lg leading-none shrink-0"></i>
        <p class="text-xs">No metadata found — add a
          <code class="font-mono bg-olive-800 px-1 rounded text-olive-600">--- … ---</code>
          block to define variables.
        </p>
      </div>`;
  }

  _renderEntry(key, val) {
    let valueHtml;
    switch (val.type) {
      case 'date': {
        const human = formatDate(val.value);
        valueHtml = `
          <div class="flex items-center gap-1.5 mt-1">
            <i class="ph ph-calendar-blank text-amber-500 text-xs leading-none shrink-0"></i>
            <span class="text-olive-200 text-sm leading-snug" title="${esc(val.value)}">${esc(human)}</span>
          </div>`;
        break;
      }
      case 'array': {
        if (val.value.length === 0) {
          valueHtml = `<p class="text-olive-600 text-xs italic mt-1">empty</p>`;
        } else {
          const chips = val.value.map(item =>
            `<span class="inline-flex px-1.5 py-px rounded bg-olive-700 border border-olive-600 text-olive-300 text-xs font-mono">${esc(item)}</span>`
          ).join('');
          valueHtml = `<div class="flex flex-wrap gap-1 mt-1">${chips}</div>`;
        }
        break;
      }
      default: {
        valueHtml = `<p class="text-olive-200 text-sm mt-1 wrap-break-word leading-snug">${esc(val.value)}</p>`;
      }
    }
    return `
      <div class="rounded-md px-3 py-2 bg-olive-800/60 border border-olive-700/50">
        <dt class="text-xs font-mono text-olive-500 truncate">${esc(key)}</dt>
        ${valueHtml}
      </div>`;
  }
}
