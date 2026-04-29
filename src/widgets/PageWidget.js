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
  constructor({ onOpenInEditor, onOpenJournal, onEditPage } = {}) {
    super({ id: 'page', title: 'Page', icon: 'ph-file-text' });
    this._onOpenInEditor = onOpenInEditor || (() => {});
    this._onOpenJournal  = onOpenJournal  || (() => {});
    this._onEditPage     = onEditPage     || (() => {});

    this._allPages    = [];
    this._currentPath = null;
    this._searchInput = null;
    this._clearBtn    = null;
    this._contentEl   = null;
  }

  get wrapperClass() { return 'flex flex-col flex-1 min-h-0'; }

  onMount() {
    this._body.innerHTML = `
      <div class="shrink-0 border-b border-olive-700" style="background:var(--color-olive-950)">
        <div class="flex items-center gap-2 px-3 py-2">
          <i class="ph ph-magnifying-glass text-olive-400 text-sm leading-none shrink-0"></i>
          <input id="pw-search" type="text"
            class="flex-1 bg-transparent text-olive-100 text-xs placeholder-olive-500 outline-none"
            placeholder="Filter pages…"
            autocomplete="off" spellcheck="false"
          />
          <button id="pw-clear" class="text-olive-500 hover:text-olive-300 leading-none"
                  style="display:none" aria-label="Clear">
            <i class="ph ph-x text-xs"></i>
          </button>
        </div>
      </div>
      <div id="pw-content" class="max-w-none overflow-y-auto"></div>
    `;

    this._searchInput = this._body.querySelector('#pw-search');
    this._clearBtn    = this._body.querySelector('#pw-clear');
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

    this._searchInput.addEventListener('input', () => {
      const q = this._searchInput.value.trim();
      this._clearBtn.style.display = q ? '' : 'none';
      if (q) this._renderFiltered(q);
      else   this._renderEmpty();
    });

    this._searchInput.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this._searchInput.value = '';
        this._clearBtn.style.display = 'none';
        this._currentPath = null;
        this._renderEmpty();
        this.saveState({ ...(this.loadState() ?? {}), path: null, title: null });
      }
    });

    this._clearBtn.addEventListener('click', () => {
      this._searchInput.value = '';
      this._clearBtn.style.display = 'none';
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

  _slug(path) {
    return path.replace(/\\/g, '/').split('/').pop()
      .replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').toLowerCase();
  }

  /** Render a filtered list of pages matching `q` directly in the content area. */
  _renderFiltered(q) {
    const lq         = q.toLowerCase();
    const parsedDate = parseFlexibleDate(q);
    const rows       = [];

    if (parsedDate) {
      const label = formatJournalDate(parsedDate);
      rows.push(`<div class="pw-page-item flex items-center gap-2 px-3 py-1.5 cursor-pointer
                              hover:bg-olive-800 transition-colors border-b border-olive-800"
                     data-journal="${esc(parsedDate)}" data-title="${esc(label)}">
        <i class="ph ph-calendar-blank text-olive-700 shrink-0 leading-none text-xs"></i>
        <span class="flex-1 text-xs text-olive-600 truncate">${esc(label)}</span>
      </div>`);
    }

    const matches = this._allPages
      .filter(p => {
        const tl = p.title.toLowerCase();
        return tl.includes(lq)
            || this._slug(p.path).includes(lq)
            || (p.aliases || []).some(a => a.toLowerCase().includes(lq));
      })
      .map(p => ({ p, score: p.title.toLowerCase().startsWith(lq) ? 0 : 1 }))
      .sort((a, b) => a.score - b.score || a.p.title.localeCompare(b.p.title))
      .map(({ p }) => p);

    for (const p of matches) {
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

    const exactMatch = this._allPages.some(p => p.title.toLowerCase() === lq);
    if (!exactMatch && !parsedDate) {
      rows.push(`<div class="pw-page-item flex items-center gap-2 px-3 py-1.5 cursor-pointer
                              hover:bg-olive-800 transition-colors border-t border-olive-800 italic"
                     data-new="${esc(q)}">
        <i class="ph ph-plus text-olive-700 shrink-0 leading-none text-xs"></i>
        <span class="text-xs text-olive-600">New page "<span class="not-italic font-semibold text-olive-500">${esc(q)}</span>"</span>
      </div>`);
    }

    if (!rows.length) {
      this._contentEl.innerHTML =
        `<p class="text-xs text-olive-700 text-center mt-6 italic">No pages match.</p>`;
      return;
    }

    this._contentEl.innerHTML = rows.join('');
    this._wireListClicks();
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
  }
}
