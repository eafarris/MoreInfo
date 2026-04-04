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

/**
 * Serialize a metadata value back to the raw string form that belongs after "key: ".
 * @param {{ type: string, value: * }} val
 * @returns {string}
 */
function serializeValue(val) {
  switch (val.type) {
    case 'bool':  return val.value ? 'true' : 'false';
    case 'array': return val.value.join(', ');
    case 'date':  return val.value;
    default:      return String(val.value);
  }
}

export class MetadataWidget extends Widget {
  /**
   * @param {{ onStateChange: (hasContent: boolean) => void, onEdit?: (key: string, rawValue: string) => void }} config
   */
  constructor({ onStateChange, onEdit } = {}) {
    super({ id: 'metadata', title: 'Metadata', icon: 'ph-list-dashes' });
    this._onStateChange = onStateChange || (() => {});
    this._onEdit        = onEdit || null;
    this._hasContent    = false;
    this._countEl       = null;
    this._lastMetadata  = null;
    this._lastContent   = '';
    this._editingKey    = null;   // key currently being edited, or null
  }

  get wrapperClass() { return 'flex flex-col flex-1 min-h-0 border-l border-olive-700'; }

  get headerAction() {
    return `<span class="widget-meta-count text-xs text-olive-600 tabular-nums"></span>`;
  }

  onMount() {
    this._countEl = this._container.querySelector('.widget-meta-count');
    this._renderEmpty();
  }

  onDocumentChange(content, metadata) {
    this._lastContent  = content;
    this._lastMetadata = metadata;
    this._render(metadata, content);
  }

  onFileOpen(path, content, metadata) {
    this._lastContent  = content;
    this._lastMetadata = metadata;
    this._editingKey   = null;
    this._render(metadata, content);
  }

  _render(metadata, content = '') {
    if (!this._body || !metadata) return;

    // Merge inline #hashtags into tags entry.
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

    if (this._countEl) {
      this._countEl.textContent = entries.length === 0
        ? ''
        : `${entries.length} variable${entries.length !== 1 ? 's' : ''}`;
    }

    const hasContent = entries.length > 0;
    this._body.innerHTML = hasContent
      ? `<div class="flex flex-col gap-2 p-3">${entries.map(([k, v]) => this._renderEntry(k, v)).join('')}</div>`
      : this._emptyState();

    // Wire up click-to-edit on value cells.
    if (hasContent && this._onEdit) {
      for (const el of this._body.querySelectorAll('[data-meta-key]')) {
        el.addEventListener('click', e => {
          // Don't re-enter if already editing this key.
          if (el.querySelector('input, select')) return;
          this._startEdit(el.dataset.metaKey, el);
        });
      }
    }

    // If we were editing a key, re-open the editor.
    if (this._editingKey && hasContent) {
      const el = this._body.querySelector(`[data-meta-key="${this._editingKey}"]`);
      if (el) this._startEdit(this._editingKey, el);
    }

    if (hasContent !== this._hasContent) { this._hasContent = hasContent; this._onStateChange(hasContent); }
  }

  _startEdit(key, el) {
    const meta = this._lastMetadata;
    if (!meta || !meta[key]) return;
    const val = meta[key];
    this._editingKey = key;

    if (val.type === 'bool') {
      // Toggle immediately.
      const newVal = !val.value;
      this._editingKey = null;
      this._onEdit(key, newVal ? 'true' : 'false');
      return;
    }

    const raw = val.type === 'array' ? val.value.join(', ') : String(val.value);

    el.innerHTML = `<input type="text"
      class="w-full bg-olive-900 text-olive-200 text-sm border border-amber-600 rounded px-2 py-1 font-mono outline-none"
      value="${esc(raw)}" />`;

    const input = el.querySelector('input');
    input.focus();
    input.select();

    const commit = () => {
      const newRaw = input.value;
      this._editingKey = null;
      if (newRaw !== raw) {
        this._onEdit(key, newRaw);
      } else {
        // Re-render to restore display view.
        this._render(this._lastMetadata, this._lastContent);
      }
    };

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { e.preventDefault(); this._editingKey = null; this._render(this._lastMetadata, this._lastContent); }
    });
    input.addEventListener('blur', commit);
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
    const editable = this._onEdit ? 'cursor-pointer hover:bg-olive-700/50 rounded transition-colors' : '';

    switch (val.type) {
      case 'date': {
        const human = formatDate(val.value);
        valueHtml = `
          <div data-meta-key="${esc(key)}" class="flex items-center gap-1.5 mt-1 px-1 py-0.5 ${editable}">
            <i class="ph ph-calendar-blank text-amber-500 text-xs leading-none shrink-0"></i>
            <span class="text-olive-200 text-sm leading-snug" title="${esc(val.value)}">${esc(human)}</span>
          </div>`;
        break;
      }
      case 'bool': {
        const label = val.value ? 'true' : 'false';
        const color = val.value ? 'text-amber-400' : 'text-olive-500';
        const icon  = val.value ? 'ph-toggle-right' : 'ph-toggle-left';
        valueHtml = `
          <div data-meta-key="${esc(key)}" class="flex items-center gap-1.5 mt-1 px-1 py-0.5 ${editable}">
            <i class="ph ${icon} ${color} text-base leading-none shrink-0"></i>
            <span class="${color} text-sm leading-snug">${label}</span>
          </div>`;
        break;
      }
      case 'array': {
        if (val.value.length === 0) {
          valueHtml = `<div data-meta-key="${esc(key)}" class="mt-1 px-1 py-0.5 ${editable}"><p class="text-olive-600 text-xs italic">empty</p></div>`;
        } else {
          const chips = val.value.map(item =>
            `<span class="inline-flex px-1.5 py-px rounded bg-olive-700 border border-olive-600 text-olive-300 text-xs font-mono">${esc(item)}</span>`
          ).join('');
          valueHtml = `<div data-meta-key="${esc(key)}" class="flex flex-wrap gap-1 mt-1 px-1 py-0.5 ${editable}">${chips}</div>`;
        }
        break;
      }
      default: {
        valueHtml = `<div data-meta-key="${esc(key)}" class="mt-1 px-1 py-0.5 ${editable}"><p class="text-olive-200 text-sm wrap-break-word leading-snug">${esc(val.value)}</p></div>`;
      }
    }
    return `
      <div class="rounded-md px-3 py-2 bg-olive-800/60 border border-olive-700/50">
        <dt class="text-xs font-mono text-olive-500 truncate">${esc(key)}</dt>
        ${valueHtml}
      </div>`;
  }
}
