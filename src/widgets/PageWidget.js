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
    this._acList      = null;
    this._contentEl   = null;
    this._acItems     = [];
    this._acIndex     = 0;
    this._acVisible   = false;
    this._clickOutside = null;
  }

  get wrapperClass() { return 'flex flex-col flex-1 min-h-0'; }

  onMount() {
    this._body.innerHTML = `
      <div id="pw-header" class="relative shrink-0 border-b border-olive-700"
           style="position:sticky; top:0; z-index:10; background:var(--color-olive-900)">
        <div class="flex items-center gap-2 px-3 py-2">
          <i class="ph ph-magnifying-glass text-olive-600 text-sm leading-none shrink-0"></i>
          <input id="pw-search" type="text"
            class="flex-1 bg-transparent text-olive-200 text-xs placeholder-olive-600 outline-none"
            placeholder="Search pages or enter a date…"
            autocomplete="off" spellcheck="false"
          />
          <button id="pw-clear" class="text-olive-600 hover:text-olive-400 leading-none"
                  style="display:none" aria-label="Clear">
            <i class="ph ph-x text-xs"></i>
          </button>
        </div>
        <ul id="pw-ac"
          class="absolute left-0 right-0 top-full
                 bg-olive-800 border border-olive-600 border-t-0
                 rounded-b-md shadow-xl overflow-y-auto"
          style="display:none; max-height:13rem; z-index:50"
        ></ul>
      </div>
      <div id="pw-content" class="prose prose-invert prose-sm max-w-none px-4 py-3"></div>
    `;

    this._searchInput = this._body.querySelector('#pw-search');
    this._clearBtn    = this._body.querySelector('#pw-clear');
    this._acList      = this._body.querySelector('#pw-ac');
    this._contentEl   = this._body.querySelector('#pw-content');

    this._renderEmpty();

    invoke('list_pages')
      .then(pages => {
        this._allPages = pages;
        const state = this.loadState();
        if (state?.path) this.loadPath(state.path, state.title || '');
      }).catch(console.error);

    // ── Input events ────────────────────────────────────────────────────────

    this._searchInput.addEventListener('focus', () => {
      if (!this._searchInput.value.trim()) this._showAllPages();
    });

    this._searchInput.addEventListener('input', () => {
      const q = this._searchInput.value.trim();
      this._clearBtn.style.display = q ? '' : 'none';
      if (!q) { this._showAllPages(); return; }
      const items = this._buildItems(q);
      this._acItems = items;
      this._acIndex = 0;
      this._renderAcItems();
      this._showAc();
    });

    this._searchInput.addEventListener('keydown', e => {
      if (!this._acVisible) return;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          this._acIndex = (this._acIndex + 1) % this._acItems.length;
          this._renderAcItems();
          break;
        case 'ArrowUp':
          e.preventDefault();
          this._acIndex = (this._acIndex - 1 + this._acItems.length) % this._acItems.length;
          this._renderAcItems();
          break;
        case 'Enter':
          e.preventDefault();
          this._commit(this._acIndex);
          break;
        case 'Escape':
          e.preventDefault();
          this._hideAc();
          break;
      }
    });

    this._clearBtn.addEventListener('click', () => {
      this._searchInput.value = '';
      this._clearBtn.style.display = 'none';
      this._hideAc();
      this._renderEmpty();
      const s = this.loadState();
      this.saveState({ ...(s ?? {}), path: null, title: null });
      this._searchInput.focus();
    });

    this._acList.addEventListener('click', e => {
      const li = e.target.closest('[data-ac-idx]');
      if (li) this._commit(parseInt(li.dataset.acIdx, 10));
    });

    this._acList.addEventListener('mousemove', e => {
      const li = e.target.closest('[data-ac-idx]');
      if (!li) return;
      const i = parseInt(li.dataset.acIdx, 10);
      if (i !== this._acIndex) { this._acIndex = i; this._renderAcItems(); }
    });

    this._clickOutside = e => {
      if (this._acVisible && !this._body.contains(e.target)) this._hideAc();
    };
    document.addEventListener('click', this._clickOutside);
  }

  onDestroy() {
    if (this._clickOutside) document.removeEventListener('click', this._clickOutside);
  }

  onFileSaved(path) {
    // Re-fetch the page list so title/slug changes appear in autocomplete.
    invoke('list_pages').then(p => {
      this._allPages = p;
      // If the saved file is the one currently displayed, reload it so the
      // rendered view reflects any content changes (e.g. new H1 title).
      if (path === this._currentPath) {
        this._loadPage(path, this._searchInput?.value.trim() || '');
      }
    }).catch(console.error);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Load a specific page by path (e.g. from a Cmd+Click in the main editor). */
  loadPath(path, title) {
    if (this._searchInput) this._searchInput.value = title || '';
    if (this._clearBtn)    this._clearBtn.style.display = title ? '' : 'none';
    this._hideAc();
    this._loadPage(path, title || '');
  }

  // ── Autocomplete ────────────────────────────────────────────────────────────

  // Returns the filename stem as a human-readable slug, e.g.
  // "/path/to/zoom-tips.md" → "zoom tips"
  _slug(path) {
    return path.replace(/\\/g, '/').split('/').pop()
      .replace(/\.[^.]+$/, '')
      .replace(/[-_]/g, ' ')
      .toLowerCase();
  }

  _buildItems(q) {
    const lq         = q.toLowerCase();
    const parsedDate = parseFlexibleDate(q);
    const items      = [];

    // If the input parses as a date, offer the journal entry at the top
    if (parsedDate) {
      items.push({ _journal: true, date: parsedDate, title: `Journal: ${formatJournalDate(parsedDate)}` });
    }

    // Match against title, filename slug, or any alias.
    // Score: 0 = title starts with query, 1 = title contains it, 2 = slug/alias match only.
    this._allPages
      .filter(p => {
        const titleMatch = p.title.toLowerCase().includes(lq);
        const slugMatch  = this._slug(p.path).includes(lq);
        const aliasMatch = (p.aliases || []).some(a => a.includes(lq));
        return titleMatch || slugMatch || aliasMatch;
      })
      .map(p => {
        const tl = p.title.toLowerCase();
        const score = tl.startsWith(lq) ? 0 : tl.includes(lq) ? 1 : 2;
        return { p, score };
      })
      .sort((a, b) => a.score - b.score || a.p.title.localeCompare(b.p.title))
      .slice(0, 10)
      .forEach(({ p }) => items.push(p));

    // "New page" if no exact title or slug match and not a date-like query
    const exactMatch = this._allPages.some(
      p => p.title.toLowerCase() === lq || this._slug(p.path) === lq
    );
    if (!exactMatch && !parsedDate) {
      items.push({ _new: true, title: q });
    }

    return items;
  }

  _renderAcItems() {
    this._acList.innerHTML = this._acItems.map((item, i) => {
      const sel  = i === this._acIndex;
      const base = 'px-3 py-1.5 text-xs cursor-pointer select-none truncate flex items-center gap-2';
      const hi   = sel ? 'bg-amber-700 text-white' : 'text-olive-200 hover:bg-olive-700';

      if (item._journal) {
        return `<li data-ac-idx="${i}" class="${base} ${hi}">
          <i class="ph ph-calendar-blank shrink-0 leading-none"></i>
          <span>${esc(item.title)}</span>
        </li>`;
      }
      if (item._new) {
        return `<li data-ac-idx="${i}" class="${base} ${hi} italic">
          <i class="ph ph-plus shrink-0 leading-none"></i>
          <span>New page "<span class="not-italic font-semibold">${esc(item.title)}</span>"</span>
        </li>`;
      }
      // Show filename hint when the match came from the slug, not the title
      const lq        = this._searchInput?.value.trim().toLowerCase() ?? '';
      const slugHint  = !item.title.toLowerCase().includes(lq)
        ? `<span class="ml-auto shrink-0 ${sel ? 'text-amber-200' : 'text-olive-600'} font-normal not-italic">${esc(this._slug(item.path))}</span>`
        : '';
      const starIcon  = item.favorite
        ? `<i class="ph-fill ph-star shrink-0 leading-none text-amber-400"></i>`
        : '';
      return `<li data-ac-idx="${i}" class="${base} ${hi}">
        <i class="ph ph-file-text shrink-0 leading-none ${sel ? 'text-amber-200' : 'text-olive-600'}"></i>
        <span class="flex-1 truncate">${esc(item.title)}</span>
        ${slugHint}${starIcon}
      </li>`;
    }).join('');
  }

  _showAllPages() {
    if (!this._allPages.length) return;
    this._acItems = this._allPages
      .filter(p => !p.path.replace(/\\/g, '/').includes('/journal/'))
      .sort((a, b) => a.title.localeCompare(b.title));
    this._acIndex = -1; // no pre-selection when browsing the full list
    this._renderAcItems();
    this._showAc();
  }

  _showAc() { this._acVisible = true;  this._acList.style.display = ''; }
  _hideAc() { this._acVisible = false; this._acList.style.display = 'none'; }

  _commit(i) {
    const item = this._acItems[i];
    if (!item) return;
    this._hideAc();
    if (item._journal) {
      const label = formatJournalDate(item.date);
      this._searchInput.value    = label;
      this._clearBtn.style.display = '';
      this._loadJournal(item.date, label);
      return;
    }
    this._searchInput.value = item.title;
    this._clearBtn.style.display = '';
    if (item._new) {
      this._onOpenInEditor(item.title);
    } else {
      this._loadPage(item.path, item.title);
    }
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
        `<div class="relative">` +
          `<button class="${btnClass} absolute top-3 right-0 z-10" data-pw-edit>` +
            `<i class="ph ph-note-pencil leading-none"></i>Edit` +
          `</button>` +
          html +
        `</div>` +
        `<div class="border-t border-olive-700 mt-4 pt-3 pb-2 flex">` +
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
    this._contentEl.innerHTML = `
      <div class="flex flex-col items-center gap-2 mt-10 text-olive-700">
        <i class="ph ph-file-magnifying-glass text-3xl leading-none"></i>
        <p class="text-xs text-center text-olive-600">
          Search for a page above,<br>or enter a date (YYYY-MM-DD).
        </p>
      </div>`;
  }
}
