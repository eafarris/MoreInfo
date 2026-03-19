import { Widget } from './Widget.js';
import { Readability } from '@mozilla/readability';

const { invoke } = window.__TAURI__.core;

function normalizeUrl(raw) {
  const s = raw.trim();
  if (!s) return '';
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(s)) return s;
  return 'https://' + s;
}

/** Rewrite relative href/src attributes to absolute, given a base URL. */
function rebaseUrls(doc, baseUrl) {
  const base = new URL(baseUrl);
  for (const el of doc.querySelectorAll('[href]')) {
    try { el.setAttribute('href', new URL(el.getAttribute('href'), base).href); } catch { /* skip malformed */ }
  }
  for (const el of doc.querySelectorAll('[src]')) {
    try { el.setAttribute('src', new URL(el.getAttribute('src'), base).href); } catch { /* skip malformed */ }
  }
}

export class BrowserWidget extends Widget {
  constructor() {
    super({ id: 'browser', title: 'Browser', icon: 'ph-globe' });
    this._history      = [];
    this._historyIndex = -1;
    this._urlInput     = null;
    this._btnBack      = null;
    this._btnFwd       = null;
    this._content      = null;
    this._loading      = false;
  }

  get wrapperClass() { return 'flex flex-col flex-1 min-h-0'; }

  onMount() {
    this._body.classList.add('flex', 'flex-col', 'min-h-0');

    this._body.innerHTML = `
      <div class="flex items-center gap-1 px-2 py-1.5 shrink-0 border-b border-olive-700 bg-olive-900">
        <button data-bw="back" title="Back" disabled
          class="flex items-center justify-center w-6 h-6 rounded text-olive-500
                 hover:bg-olive-700 hover:text-olive-200 transition-colors
                 disabled:opacity-30 disabled:pointer-events-none">
          <i class="ph ph-caret-left text-sm leading-none"></i>
        </button>
        <button data-bw="fwd" title="Forward" disabled
          class="flex items-center justify-center w-6 h-6 rounded text-olive-500
                 hover:bg-olive-700 hover:text-olive-200 transition-colors
                 disabled:opacity-30 disabled:pointer-events-none">
          <i class="ph ph-caret-right text-sm leading-none"></i>
        </button>
        <input data-bw="url" type="text" spellcheck="false" autocomplete="off"
          placeholder="Enter a URL…"
          class="flex-1 min-w-0 bg-olive-800 border border-olive-600 rounded px-2 py-0.5
                 text-xs text-olive-200 placeholder-olive-600 outline-none
                 focus:border-amber-600 transition-colors" />
        <button data-bw="go" title="Go"
          class="flex items-center justify-center w-6 h-6 rounded text-olive-500
                 hover:bg-olive-700 hover:text-olive-200 transition-colors">
          <i class="ph ph-arrow-right text-sm leading-none"></i>
        </button>
      </div>
      <div data-bw="content"
        class="flex-1 min-h-0 overflow-y-auto px-4 py-3 text-olive-200 text-sm
               prose prose-sm prose-invert prose-olive max-w-none
               prose-a:text-amber-400 prose-a:no-underline hover:prose-a:underline
               prose-headings:text-olive-100 prose-code:text-amber-300
               prose-pre:bg-olive-950 prose-pre:text-olive-200">
        <p class="text-olive-600 text-xs text-center mt-8">Enter a URL above to read an article.</p>
      </div>
    `;

    this._urlInput = this._body.querySelector('[data-bw="url"]');
    this._btnBack  = this._body.querySelector('[data-bw="back"]');
    this._btnFwd   = this._body.querySelector('[data-bw="fwd"]');
    this._content  = this._body.querySelector('[data-bw="content"]');

    this._btnBack.addEventListener('click', () => this._goBack());
    this._btnFwd.addEventListener('click',  () => this._goFwd());
    this._body.querySelector('[data-bw="go"]').addEventListener('click', () => this._commitUrl());
    this._urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') this._commitUrl(); });

    // Restore last-visited URL
    const state = this.loadState();
    if (state?.url) {
      this._urlInput.value = state.url;
      this._navigate(state.url, false);
    }
  }

  // ── Navigation ───────────────────────────────────────────────

  _commitUrl() {
    const url = normalizeUrl(this._urlInput.value);
    if (!url) return;
    this._urlInput.value = url;
    this._navigate(url, true);
  }

  async _navigate(url, pushHistory = true) {
    if (this._loading) return;
    this._loading = true;

    if (pushHistory) {
      this._history = this._history.slice(0, this._historyIndex + 1);
      this._history.push(url);
      this._historyIndex = this._history.length - 1;
    }
    this._updateButtons();
    this._urlInput.value = url;

    this._content.innerHTML = `
      <div class="flex items-center justify-center gap-2 mt-10 text-olive-600 text-xs">
        <i class="ph ph-spinner-gap animate-spin text-lg leading-none"></i>
        <span>Loading…</span>
      </div>`;

    try {
      const html = await invoke('fetch_page', { url });

      // Parse into a detached document so Readability can work safely
      const parser = new DOMParser();
      const doc    = parser.parseFromString(html, 'text/html');

      // Set base so relative URLs resolve correctly
      let base = doc.querySelector('base');
      if (!base) {
        base = doc.createElement('base');
        doc.head.prepend(base);
      }
      base.setAttribute('href', url);

      const article = new Readability(doc).parse();

      if (!article) {
        this._showError('Could not extract readable content from this page.');
        return;
      }

      // Rebase links in a scratch document so in-widget clicks work
      const scratch = parser.parseFromString(article.content, 'text/html');
      rebaseUrls(scratch, url);

      this._content.innerHTML = `
        <h1 class="text-base font-semibold text-olive-100 mb-1 leading-snug">${article.title ?? ''}</h1>
        ${scratch.body.innerHTML}
      `;

      // Intercept link clicks — open in widget rather than system browser
      this._content.querySelectorAll('a[href]').forEach(a => {
        a.addEventListener('click', e => {
          const href = a.getAttribute('href');
          if (!href || href.startsWith('#')) return;
          e.preventDefault();
          this._urlInput.value = href;
          this._navigate(href, true);
        });
      });

      this.saveState({ url });
    } catch (err) {
      this._showError(`Failed to load page: ${err}`);
    } finally {
      this._loading = false;
    }
  }

  _showError(msg) {
    this._content.innerHTML = `
      <div class="flex flex-col items-center gap-2 mt-10 text-olive-600 text-xs text-center px-4">
        <i class="ph ph-warning text-2xl leading-none"></i>
        <p>${msg}</p>
      </div>`;
  }

  _goBack() {
    if (this._historyIndex <= 0) return;
    const url = this._history[--this._historyIndex];
    this._navigate(url, false);
  }

  _goFwd() {
    if (this._historyIndex >= this._history.length - 1) return;
    const url = this._history[++this._historyIndex];
    this._navigate(url, false);
  }

  _updateButtons() {
    this._btnBack.disabled = this._historyIndex <= 0;
    this._btnFwd.disabled  = this._historyIndex >= this._history.length - 1;
  }
}
