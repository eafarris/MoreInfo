import { Widget } from './Widget.js';
import { invoke } from '../tauri.js';
import { parseFlexibleDate, formatJournalDate } from '../dateUtils.js';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export class PageWidget extends Widget {
  /**
   * @param {{ onOpenInEditor: (title:string)=>void,
   *            onOpenJournal:  (date:string)=>void,
   *            onEditPage:     (path:string)=>void }} opts
   */
  constructor({ onOpenInEditor, onOpenJournal, onEditPage,
                onPreviewShow, onPreviewHide } = {}) {
    super({ id: 'page', title: 'Page', icon: 'ph-file-text' });
    this._onOpenInEditor = onOpenInEditor || (() => {});
    this._onOpenJournal  = onOpenJournal  || (() => {});
    this._onEditPage     = onEditPage     || (() => {});
    this._onPreviewShow  = onPreviewShow  || (() => {});
    this._onPreviewHide  = onPreviewHide  || (() => {});

    this._allPages    = [];
    this._currentPath = null;
    this._searchInput = null;
    this._clearBtn    = null;
    this._hintBar     = null;
    this._contentEl   = null;
  }

  get wrapperClass() { return 'flex flex-col flex-1 min-h-0'; }

  onMount() {
    const chip = (label, hint, color) =>
      `<button class="pw-hint shrink-0 px-1.5 py-px rounded font-mono text-[10px] leading-4
                      border border-olive-700 bg-olive-800 hover:bg-olive-700 hover:border-olive-600
                      transition-colors cursor-pointer ${color}"
               data-hint="${esc(hint)}">${esc(label)}</button>`;

    this._body.innerHTML = `
      <div class="shrink-0 border-b border-olive-700" style="background:var(--color-olive-950)">
        <div class="flex items-center gap-2 px-3 py-2">
          <i class="ph ph-magnifying-glass text-olive-400 text-sm leading-none shrink-0"></i>
          <input id="pw-search" type="text"
            class="flex-1 bg-transparent text-olive-100 text-xs placeholder-olive-500 outline-none"
            placeholder="Filter pages or key:value…"
            autocomplete="off" spellcheck="false"
          />
          <button id="pw-clear" class="text-olive-500 hover:text-olive-300 leading-none"
                  style="display:none" aria-label="Clear">
            <i class="ph ph-x text-xs"></i>
          </button>
        </div>
        <div class="pw-hint-bar flex flex-wrap items-center gap-1.5 px-3 py-1.5
                    border-t border-olive-700 bg-olive-900 shrink-0">
          <span class="shrink-0 text-[9px] font-semibold uppercase tracking-wider
                       text-olive-600 select-none pr-0.5">Filters</span>
          ${chip('cat:', 'cat:', 'text-sky-400')}
          ${chip('tag:', 'tag:', 'text-sky-400')}
          ${chip('favorite:true', 'favorite:true', 'text-zinc-400')}
        </div>
      </div>
      <div id="pw-content" class="max-w-none overflow-y-auto"></div>
    `;

    this._searchInput = this._body.querySelector('#pw-search');
    this._clearBtn    = this._body.querySelector('#pw-clear');
    this._hintBar     = this._body.querySelector('.pw-hint-bar');
    this._contentEl   = this._body.querySelector('#pw-content');

    this._renderEmpty();

    invoke('list_pages')
      .then(pages => {
        this._allPages = pages;
        const state = this.loadState();
        if (state?.path) this.loadPath(state.path, state.title || '');
        else this._renderEmpty();   // replace spinner with full page list
      }).catch(console.error);

    // ── Input events ────────────────────────────────────────────────────────

    this._searchInput.addEventListener('input', async () => {
      const q = this._searchInput.value.trim();
      this._clearBtn.style.display = q ? '' : 'none';
      this._hintBar.style.display  = q ? 'none' : '';
      if (q) await this._renderFiltered(q);
      else   this._renderEmpty();
    });

    // Hint chips: append the operator text to the input and re-filter.
    this._body.addEventListener('click', async e => {
      const btn = e.target.closest('.pw-hint');
      if (!btn) return;
      const cur = this._searchInput.value;
      const sep = cur && !cur.endsWith(' ') ? ' ' : '';
      this._searchInput.value = cur + sep + btn.dataset.hint;
      this._clearBtn.style.display = '';
      this._hintBar.style.display  = 'none';
      this._searchInput.focus();
      await this._renderFiltered(this._searchInput.value.trim());
    });

    this._searchInput.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this._searchInput.value = '';
        this._clearBtn.style.display = 'none';
        this._hintBar.style.display  = '';
        this._currentPath = null;
        this._renderEmpty();
        this.saveState({ ...(this.loadState() ?? {}), path: null, title: null });
      }
    });

    this._clearBtn.addEventListener('click', () => {
      this._searchInput.value = '';
      this._clearBtn.style.display = 'none';
      this._hintBar.style.display  = '';
      this._currentPath = null;
      this._renderEmpty();
      const s = this.loadState();
      this.saveState({ ...(s ?? {}), path: null, title: null });
      this._searchInput.focus();
    });
  }

  onFileSaved(path) {
    // Re-fetch the page list so title/slug changes appear in autocomplete.
    invoke('list_pages').then(p => {
      this._allPages = p;
      if (path === this._currentPath) {
        // Reload so rendered view reflects any content changes.
        this._loadPage(path, this._searchInput?.value.trim() || '');
      } else if (!this._currentPath) {
        // No page open — refresh the list in case a title changed.
        this._renderEmpty();
      }
    }).catch(console.error);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Load a specific page by path (e.g. from a Cmd+Click in the main editor). */
  loadPath(path, title) {
    if (this._searchInput) this._searchInput.value = title || '';
    if (this._clearBtn)    this._clearBtn.style.display = title ? '' : 'none';
    this._loadPage(path, title || '');
  }

  // ── Filtering ───────────────────────────────────────────────────────────────

  // Mirror the Rust singularize() in front-matter/src/lib.rs so that
  // "tags:work" and "tag:work" both query the database under the canonical key.
  _singularize(word) {
    const w = word.toLowerCase();
    const IRR = {
      aliases: 'alias', children: 'child', people: 'person',
      men: 'man', women: 'woman', mice: 'mouse', geese: 'goose',
      feet: 'foot', teeth: 'tooth', oxen: 'ox',
      alumni: 'alumnus', syllabi: 'syllabus', cacti: 'cactus',
      fungi: 'fungus', nuclei: 'nucleus', radii: 'radius',
      stimuli: 'stimulus', criteria: 'criterion', phenomena: 'phenomenon',
      indices: 'index', vertices: 'vertex', matrices: 'matrix',
    };
    if (IRR[w]) return IRR[w];
    const INV = new Set([
      'series', 'species', 'means', 'news', 'alias', 'status', 'virus',
      'corpus', 'campus', 'nexus', 'census', 'bonus', 'focus', 'circus',
      'axis', 'basis', 'crisis', 'thesis', 'analysis', 'diagnosis',
      'oasis', 'ellipsis', 'emphasis', 'hypothesis', 'synthesis',
      'physics', 'economics', 'mathematics', 'politics', 'athletics',
      'data', 'chess', 'tennis',
    ]);
    if (INV.has(w)) return w;
    if (w.endsWith('ies') && w.length >= 5) return w.slice(0, -3) + 'y';
    if (w.endsWith('sses')) return w.slice(0, -2);
    if (w.endsWith('ches')) return w.slice(0, -2);
    if (w.endsWith('shes')) return w.slice(0, -2);
    if (w.endsWith('xes'))  return w.slice(0, -2);
    if (w.endsWith('s') && w.length >= 3) {
      const stem = w.slice(0, -1);
      if (!stem.endsWith('ss') && !stem.endsWith('is') && !stem.endsWith('us'))
        return stem;
    }
    return w;
  }

  _slug(path) {
    return path.replace(/\\/g, '/').split('/').pop()
      .replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').toLowerCase();
  }

  /** Split a query into { filters: [{key,value}], text } */
  _parseQuery(q) {
    const filters = [];
    const textParts = [];
    const re = /(\w[\w-]*):"([^"]+)"|(\w[\w-]*):(\S+)/g;
    let last = 0, m;
    while ((m = re.exec(q)) !== null) {
      const before = q.slice(last, m.index).trim();
      if (before) textParts.push(before);
      filters.push({
        key:   this._singularize((m[1] ?? m[3]).toLowerCase()),
        value: (m[2] ?? m[4]) === '*' ? null : (m[2] ?? m[4]),
      });
      last = m.index + m[0].length;
    }
    const after = q.slice(last).trim();
    if (after) textParts.push(after);
    return { filters, text: textParts.join(' ') };
  }

  /** Render a filtered list inline. key:value tokens query the metadata index. */
  async _renderFiltered(q) {
    const { filters, text } = this._parseQuery(q);
    const lq = text.toLowerCase();

    // Only show journal shortcut when there are no key:value filters.
    const parsedDate = !filters.length && parseFlexibleDate(text || q);

    // Start from all non-journal pages.
    let pages = this._allPages
      .filter(p => !p.path.replace(/\\/g, '/').includes('/journal/'));

    // Apply each key:value filter; intersect the results.
    // tag: routes through file_tags (covers metadata tags + inline #hashtags,
    // identical to how search_pages handles tag: / tags: queries).
    // Everything else uses file_metadata via search_metadata.
    if (filters.length) {
      const sets = await Promise.all(filters.map(async ({ key, value }) => {
        try {
          if (key === 'tag' && value) {
            const hits = await invoke('list_pages_for_tag', { tag: value });
            return new Set(hits.map(h => h.path));
          }
          const hits = await invoke('search_metadata', { key, value: value ?? null });
          return new Set(hits.map(h => h.path));
        } catch { return new Set(); }
      }));
      pages = pages.filter(p => sets.every(s => s.has(p.path)));
    }

    // Apply text filter on top.
    if (lq) {
      pages = pages.filter(p =>
        p.title.toLowerCase().includes(lq)
        || this._slug(p.path).includes(lq)
        || (p.aliases || []).some(a => a.toLowerCase().includes(lq))
      );
    }

    // Sort: title-starts-with match first, then alphabetical.
    pages = pages
      .map(p => ({ p, score: lq && p.title.toLowerCase().startsWith(lq) ? 0 : 1 }))
      .sort((a, b) => a.score - b.score || a.p.title.localeCompare(b.p.title))
      .map(({ p }) => p);

    const rows = [];

    if (parsedDate) {
      const label = formatJournalDate(parsedDate);
      rows.push(`<div class="pw-page-item flex items-center gap-2 px-3 py-1.5 cursor-pointer
                              hover:bg-olive-800 transition-colors border-b border-olive-800"
                     data-journal="${esc(parsedDate)}" data-title="${esc(label)}">
        <i class="ph ph-calendar-blank text-olive-700 shrink-0 leading-none text-xs"></i>
        <span class="flex-1 text-xs text-olive-600 truncate">${esc(label)}</span>
      </div>`);
    }

    for (const p of pages) {
      const star = p.favorite
        ? `<i class="ph-fill ph-star text-amber-700 shrink-0 leading-none text-xs"></i>` : '';
      rows.push(`<div class="pw-page-item flex items-center gap-2 px-3 py-1.5 cursor-pointer
                              hover:bg-olive-800 transition-colors border-b border-olive-800 last:border-0"
                     data-path="${esc(p.path)}" data-title="${esc(p.title)}">
        <i class="ph ph-file-text text-olive-700 shrink-0 leading-none text-xs"></i>
        <span class="flex-1 text-xs text-olive-600 truncate">${esc(p.title)}</span>
        ${star}
      </div>`);
    }

    // "New page" only for plain-text queries with no key:value filters.
    if (!filters.length && !parsedDate && lq) {
      const exact = this._allPages.some(p => p.title.toLowerCase() === lq);
      if (!exact) {
        rows.push(`<div class="pw-page-item flex items-center gap-2 px-3 py-1.5 cursor-pointer
                                hover:bg-olive-800 transition-colors border-t border-olive-800 italic"
                       data-new="${esc(text || q)}">
          <i class="ph ph-plus text-olive-700 shrink-0 leading-none text-xs"></i>
          <span class="text-xs text-olive-600">New page "<span class="not-italic font-semibold text-olive-500">${esc(text || q)}</span>"</span>
        </div>`);
      }
    }

    if (!rows.length) {
      this._contentEl.innerHTML =
        `<p class="text-xs text-olive-700 text-center mt-6 italic">No pages match.</p>`;
      return;
    }

    this._contentEl.innerHTML = rows.join('');
    this._wireListClicks();
    this._wireListHovers();
  }

  _wireListHovers() {
    this._contentEl.querySelectorAll('.pw-page-item[data-path]').forEach(el => {
      el.addEventListener('mouseover', () => this._onPreviewShow(el.dataset.title, el));
      el.addEventListener('mouseout',  () => this._onPreviewHide());
    });
  }

  _wireListClicks() {
    this._contentEl.querySelectorAll('.pw-page-item').forEach(el => {
      el.addEventListener('click', () => {
        if (el.dataset.journal) {
          const label = el.dataset.title;
          this._searchInput.value = label;
          this._clearBtn.style.display = '';
          this._loadJournal(el.dataset.journal, label);
        } else if (el.dataset.new) {
          this._onOpenInEditor(el.dataset.new);
        } else {
          this._searchInput.value = el.dataset.title;
          this._clearBtn.style.display = '';
          this._loadPage(el.dataset.path, el.dataset.title);
        }
      });
    });
  }

  async _loadJournal(date, label) {
    try {
      const { path } = await invoke('open_journal', { date });
      this._loadPage(path, label);
    } catch (err) {
      console.error('[PageWidget] open_journal failed:', err);
    }
  }

  // ── Page loading ────────────────────────────────────────────────────────────

  async _loadPage(path, title) {
    this._currentPath = path;
    this.saveState({ ...(this.loadState() ?? {}), path, title });
    this._contentEl.innerHTML = `
      <div class="flex items-center justify-center py-10 text-olive-700">
        <i class="ph ph-circle-notch animate-spin text-xl leading-none"></i>
      </div>`;
    try {
      const content = await invoke('read_file', { path });
      const html    = await invoke('parse_markdown', { markdown: content });
      if (path !== this._currentPath) return; // stale

      const btnClass = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium'
        + ' bg-amber-700/80 hover:bg-amber-600 text-white cursor-pointer border-0 leading-none';

      this._contentEl.innerHTML =
        `<div class="prose prose-invert prose-sm max-w-none px-4 pt-3 pb-1 relative">` +
          `<button class="${btnClass} absolute top-3 right-4 z-10" data-pw-edit>` +
            `<i class="ph ph-note-pencil leading-none"></i>Edit` +
          `</button>` +
          html +
        `</div>` +
        `<div class="border-t border-olive-700 px-4 pt-3 pb-3 flex">` +
          `<button class="${btnClass} w-full justify-center" data-pw-open>` +
            `<i class="ph ph-note-pencil leading-none"></i>Open in Editor` +
          `</button>` +
        `</div>`;

      this._contentEl.querySelector('[data-pw-edit]').addEventListener('click', () => {
        this._onEditPage(path);
      });
      this._contentEl.querySelector('[data-pw-open]').addEventListener('click', () => {
        this._onEditPage(path);
      });

      // Wire wiki links: navigate within the widget; non-existent → open in editor
      this._contentEl.querySelectorAll('a.wiki-link').forEach(a => {
        a.addEventListener('click', e => {
          e.preventDefault();
          const linkTitle = a.dataset.wikiTitle;
          const lc = linkTitle.toLowerCase();
          const target = this._allPages.find(
            p => p.title.toLowerCase() === lc ||
                 (p.aliases || []).some(al => al === lc)
          );
          if (target) {
            this._searchInput.value    = target.title;
            this._loadPage(target.path, target.title);
          } else {
            this._onOpenInEditor(linkTitle);
          }
        });
      });
    } catch (err) {
      if (path !== this._currentPath) return;
      this._contentEl.innerHTML =
        `<p class="text-xs text-red-400 mt-4">Could not load "${esc(title)}".</p>`;
      console.error('[PageWidget]', err);
    }
  }

  _renderEmpty() {
    if (!this._allPages.length) {
      // Pages not yet loaded — show a spinner.
      this._contentEl.innerHTML = `
        <div class="flex justify-center mt-10 text-olive-700">
          <i class="ph ph-circle-notch animate-spin text-xl leading-none"></i>
        </div>`;
      return;
    }

    // Show every wiki page (no journals) as a clickable list.
    const pages = this._allPages
      .filter(p => !p.path.replace(/\\/g, '/').includes('/journal/'))
      .sort((a, b) => a.title.localeCompare(b.title));

    if (!pages.length) {
      this._contentEl.innerHTML =
        `<p class="text-xs text-olive-600 text-center mt-8">No pages yet.</p>`;
      return;
    }

    this._contentEl.innerHTML = pages.map(p => {
      const star = p.favorite
        ? `<i class="ph-fill ph-star text-amber-700 shrink-0 leading-none text-xs"></i>`
        : '';
      return `<div class="pw-page-item flex items-center gap-2 px-3 py-1.5 cursor-pointer
                          hover:bg-olive-800 transition-colors border-b border-olive-800 last:border-0"
                   data-path="${esc(p.path)}" data-title="${esc(p.title)}">
        <i class="ph ph-file-text text-olive-700 shrink-0 leading-none text-xs"></i>
        <span class="flex-1 text-xs text-olive-600 truncate">${esc(p.title)}</span>
        ${star}
      </div>`;
    }).join('');

    this._wireListClicks();
    this._wireListHovers();
  }
}
