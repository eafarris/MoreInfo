import { Widget } from './Widget.js';

const HEADING_RE = /^(#{1,6})\s+(.+)$/gm;

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Strip inline markdown from a heading label (bold, italic, code, links). */
function stripInline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .trim();
}

export class OutlineWidget extends Widget {
  /**
   * @param {{ onScrollTo: (pos: number) => void }} config
   *   onScrollTo — called with the document character offset of a heading
   *                when the user clicks it; the caller should scroll the editor.
   */
  constructor({ onScrollTo } = {}) {
    super({ id: 'outline', title: 'Outline', icon: 'ph-list' });
    this._onScrollTo = onScrollTo || (() => {});
    this._headings   = [];   // [{ level, text, pos }]
  }

  get wrapperClass() { return 'flex flex-col flex-1 min-h-0'; }

  onMount() {
    this._body.addEventListener('click', e => {
      const item = e.target.closest('[data-pos]');
      if (item) this._onScrollTo(Number(item.dataset.pos));
    });
    this._renderEmpty();
  }

  onFileOpen(_path, content, _metadata) {
    this._parse(content);
    this._renderList();
  }

  onDocumentChange(content) {
    this._parse(content);
    this._renderList();
  }

  // ── Private ────────────────────────────────────────────────────────────────

  _parse(content) {
    this._headings = [];
    HEADING_RE.lastIndex = 0;
    let m;
    while ((m = HEADING_RE.exec(content)) !== null) {
      this._headings.push({
        level: m[1].length,
        text:  stripInline(m[2]),
        pos:   m.index,
      });
    }
  }

  _renderList() {
    if (!this._body) return;
    if (this._headings.length === 0) { this._renderEmpty(); return; }

    // Indent each heading relative to the minimum level present so a doc that
    // starts at h2 doesn't get a deep first-level indent.
    const minLevel = Math.min(...this._headings.map(h => h.level));

    this._body.innerHTML = `<ul class="py-1">` +
      this._headings.map(({ level, text, pos }) => {
        const depth  = level - minLevel;          // 0-based indent
        const indent = depth * 12;                // px per level
        const size   = level <= 2 ? 'font-medium' : 'text-olive-300';
        return `<li data-pos="${pos}"
          style="padding-left: ${8 + indent}px"
          class="flex items-baseline gap-1.5 py-0.5 pr-3 cursor-pointer
                 text-xs text-olive-200 hover:text-amber-300 hover:bg-olive-800
                 rounded select-none truncate ${size}"
          title="${esc(text)}">
          <span class="shrink-0 text-olive-600" style="font-size:0.6rem">
            ${'#'.repeat(level)}
          </span>
          <span class="truncate">${esc(text)}</span>
        </li>`;
      }).join('') +
      `</ul>`;
  }

  _renderEmpty() {
    if (!this._body) return;
    this._body.innerHTML = `
      <div class="flex items-center gap-2 h-full px-4 text-olive-700">
        <i class="ph ph-list text-lg leading-none shrink-0"></i>
        <p class="text-xs">No headings in this page.</p>
      </div>`;
  }
}
