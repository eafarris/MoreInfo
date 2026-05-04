import { Widget } from './Widget.js';
import { invoke } from '../tauri.js';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Operator tokens shown in the always-visible hint strip.
// color key → Tailwind text class
//   phrase  → emerald   exact phrase search
//   op      → amber     infix operator keyword (NEAR)
//   source  → violet    in: source filters
//   date    → orange    after: / before: date filters
//   taxon   → sky       tag: / category: taxonomy filters
//   meta    → zinc      arbitrary key:value metadata
// cursor: characters to back up from end of final input value (0 = stay at end).
// wrap:   wrap existing input value in `insert`…`insert` (used for phrase quotes).
const OPERATORS = [
  { label: '"exact phrase"', insert: '"',          color: 'phrase', wrap: true, cursor: 1 },
  { label: 'NEAR',           insert: ' NEAR ',     color: 'op' },
  { label: 'in:journal',     insert: 'in:journal', color: 'source' },
  { label: 'in:wiki',        insert: 'in:wiki',    color: 'source' },
  { label: 'after:',         insert: 'after:',     color: 'date' },
  { label: 'before:',        insert: 'before:',    color: 'date' },
  { label: 'tag:',           insert: 'tag:',       color: 'taxon' },
  { label: 'category:',      insert: 'category:',  color: 'taxon' },
  { label: 'field:value',    insert: '',           color: 'meta' },
];

const COLOR = {
  phrase: 'text-emerald-400',
  op:     'text-amber-400',
  source: 'text-violet-400',
  date:   'text-orange-400',
  taxon:  'text-sky-400',
  meta:   'text-zinc-400',
};

function buildHintStrip() {
  const tokens = OPERATORS.map(op => {
    // key:value is a non-interactive hint; all others are clickable buttons.
    if (!op.insert) {
      return `
        <span
          title="Any metadata field: author:jane, status:done, author:* (any value)"
          class="shrink-0 px-1.5 py-px rounded font-mono text-[10px] leading-4
                 border border-dashed border-olive-700
                 cursor-default select-none ${COLOR[op.color]}">
          ${esc(op.label)}
        </span>`;
    }
    return `
      <button
        data-insert="${esc(op.insert)}"
        data-cursor="${op.cursor ?? 0}"
        data-wrap="${op.wrap ?? false}"
        class="shrink-0 px-1.5 py-px rounded font-mono text-[10px] leading-4
               border border-olive-700 bg-olive-800
               hover:bg-olive-700 hover:border-olive-600
               transition-colors cursor-pointer ${COLOR[op.color]}">
        ${esc(op.label)}
      </button>`;
  }).join('');

  return `
    <div class="hint-strip flex flex-wrap items-center gap-1.5 px-3 py-1.5
                border-b border-olive-700 bg-olive-900 shrink-0">
      <span class="shrink-0 text-[9px] font-semibold uppercase tracking-wider
                   text-olive-600 select-none pr-0.5">Operators</span>
      ${tokens}
    </div>`;
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
    this._query    = '';
    this._lastHits = null;   // null = no search yet; [] = search returned no hits
  }

  get wrapperClass() { return 'flex flex-col border-b border-olive-700'; }

  onMount() {
    this._body.classList.add('flex', 'flex-col');
    this._body.classList.remove('overflow-y-auto');

    this._body.innerHTML = `
      <div class="flex items-center gap-2 px-3 py-2 border-b border-olive-700 shrink-0 bg-olive-950">
        <i class="ph ph-magnifying-glass text-olive-400 text-sm leading-none shrink-0"></i>
        <input type="text"
          class="flex-1 bg-transparent text-olive-100 text-xs placeholder-olive-500 outline-none"
          placeholder="Full-text search…"
          autocomplete="off" spellcheck="false" />
        <button class="text-olive-500 hover:text-olive-300 leading-none" style="display:none"
                aria-label="Clear">
          <i class="ph ph-x text-xs"></i>
        </button>
      </div>
      ${buildHintStrip()}
      <div class="sw-results overflow-y-auto flex-1 min-h-0"></div>
    `;

    this._input    = this._body.querySelector('input');
    this._clearBtn = this._body.querySelector('button');
    this._results  = this._body.querySelector('.sw-results');

    // Restore state from before the last move/remount.
    if (this._query) {
      this._input.value            = this._query;
      this._clearBtn.style.display = '';
      if (this._lastHits !== null) {
        this._renderResults(this._lastHits, this._query);
      } else {
        this._search(this._query);
      }
    } else {
      this._renderEmpty();
    }

    // ── Input events ────────────────────────────────────────────────────────

    this._input.addEventListener('input', () => {
      const q = this._input.value.trim();
      this._clearBtn.style.display = q ? '' : 'none';
      clearTimeout(this._debounce);
      if (!q) { this._query = ''; this._lastHits = null; this._renderEmpty(); return; }
      this._debounce = setTimeout(() => this._search(q), 300);
    });

    this._clearBtn.addEventListener('click', () => {
      this._input.value = '';
      this._clearBtn.style.display = 'none';
      this._query    = '';
      this._lastHits = null;
      this._renderEmpty();
      this._input.focus();
    });

    // ── Hint-strip token clicks ──────────────────────────────────────────────

    // Prevent token mousedown from stealing focus from the input.
    this._body.querySelector('.hint-strip').addEventListener('mousedown', e => {
      if (e.target.closest('[data-insert]')) e.preventDefault();
    });

    this._body.querySelector('.hint-strip').addEventListener('click', e => {
      const token = e.target.closest('[data-insert]');
      if (!token) return;

      const op     = token.dataset.insert;
      const wrap   = token.dataset.wrap === 'true';
      const backup = parseInt(token.dataset.cursor, 10) || 0;
      const cur    = this._input.value;

      let next;
      if (wrap) {
        next = cur.trim() ? `${op}${cur.trim()}${op}` : `${op}${op}`;
      } else if (cur.trimEnd()) {
        next = `${cur.trimEnd()} ${op}`;
      } else {
        next = op;
      }

      this._input.value = next;
      this._clearBtn.style.display = '';
      const pos = next.length - backup;
      this._input.setSelectionRange(pos, pos);
      this._input.focus();
      this._input.dispatchEvent(new Event('input'));
    });

    // ── Results click (page open) ────────────────────────────────────────────

    this._results.addEventListener('click', e => {
      const item = e.target.closest('[data-path]');
      if (item) this._onOpen(item.dataset.path, item.dataset.title);
    });
  }

  /** Unroll if needed, then focus the search input and select any existing text. */
  focusSearch() {
    if (this._rolled) this.unrollImmediate();
    if (this._input) {
      this._input.focus();
      this._input.select();
    }
  }

  onDestroy() {
    clearTimeout(this._debounce);
  }

  async _search(query) {
    this._query    = query;
    this._lastHits = null;
    this._results.innerHTML = `
      <div class="flex items-center justify-center py-4 text-olive-700">
        <i class="ph ph-circle-notch animate-spin text-xl leading-none"></i>
      </div>`;
    try {
      const hits = await invoke('search_pages', { query });
      this._lastHits = hits;
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
