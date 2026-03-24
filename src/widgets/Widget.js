/**
 * Base class for all MoreInfo widgets.
 *
 * Lifecycle (called by the mounting system):
 *   mount(container)  — renders the standard shell, then calls onMount()
 *   destroy()         — calls onDestroy(), then clears the container
 *
 * Document event hooks (called by the app):
 *   onDocumentChange(content, metadata)
 *   onFileOpen(path, content, metadata)
 *
 * Subclass API:
 *   get wrapperClass()   — extra Tailwind classes on the wrapper div
 *   get headerAction()   — HTML string injected at the right of the header
 *   onMount()            — set up listeners, render initial state
 *   onDestroy()          — cancel timers, remove global listeners
 *   onDocumentChange()   — react to editor content changes (debounced)
 *   onFileOpen()         — react to a new file being opened
 */
export class Widget {
  /**
   * @param {{ id: string, title: string, icon: string }} config
   *   id    — unique camelCase identifier (e.g. 'calendar', 'metadata')
   *   title — display label in the widget header
   *   icon  — full Phosphor icon class (e.g. 'ph-calendar-blank')
   */
  constructor({ id, title, icon }) {
    this.id    = id;
    this.title = title;
    this.icon  = icon;

    /** @type {HTMLElement|null} The wrapper element passed to mount() */
    this._container = null;
    /** @type {HTMLElement|null} The scrollable content area inside the shell */
    this._body = null;
    /** @type {boolean} Whether the widget body is currently rolled up */
    this._rolled = false;
    /** @type {HTMLElement|null} The roll toggle button in the header */
    this._rollBtn = null;
  }

  /**
   * Extra Tailwind classes applied to the wrapper div by the mounting system.
   * Use to control how the widget sizes within its sidebar (e.g. flex-1, shrink-0).
   * @returns {string}
   */
  get wrapperClass() { return ''; }

  /**
   * Optional HTML rendered at the trailing edge of the widget header.
   * Use for counters, secondary labels, or action buttons.
   * @returns {string}
   */
  get headerAction() { return ''; }

  /**
   * Mount this widget into a container element.
   * Renders the standard header + body shell, then calls onMount().
   * @param {HTMLElement} container
   */
  mount(container) {
    this._container = container;
    const savedState = this.loadState();
    this._rolled = savedState?._rolled ?? false;

    container.innerHTML = `
      <div class="widget-header flex items-center justify-between px-3 py-1.5 shrink-0 border-b border-olive-700 bg-olive-800 cursor-default select-none">
        <span class="widget-title flex items-center gap-1.5 text-xs font-semibold text-olive-500 tracking-wide uppercase">
          <i class="ph ${this.icon} text-sm leading-none"></i>
          ${this.title}
        </span>
        <span class="flex items-center gap-1">
          ${this.headerAction}
          <button class="widget-roll-btn text-olive-500 hover:text-olive-300 p-0.5 leading-none bg-transparent border-none cursor-pointer" title="Roll up">
            <i class="ph ${this._rolled ? 'ph-caret-line-down' : 'ph-caret-line-up'} text-sm leading-none"></i>
          </button>
        </span>
      </div>
      <div class="widget-body flex-1 min-h-0 overflow-y-auto"></div>
    `;

    this._body    = container.querySelector('.widget-body');
    this._rollBtn = container.querySelector('.widget-roll-btn');

    // Apply rolled state instantly on mount (no animation on first paint).
    if (this._rolled) {
      this._body.style.maxHeight = '0';
      this._body.style.opacity   = '0';
      this._body.style.overflow  = 'hidden';
    }
    Object.assign(this._body.style, {
      transition: 'max-height 220ms ease, opacity 180ms ease',
    });

    container.querySelector('.widget-title').addEventListener('dblclick', () => this._toggleRoll());
    this._rollBtn.addEventListener('click', () => this._toggleRoll());

    this.onMount();

    // Set a concrete max-height baseline after content has rendered so the
    // collapse animation has a real "from" value.
    if (!this._rolled) {
      requestAnimationFrame(() => {
        this._body.style.maxHeight = this._body.scrollHeight + 'px';
      });
    }
  }

  _toggleRoll() {
    this._rolled = !this._rolled;

    if (this._rolled) {
      // Snapshot current height so the transition has a "from" value.
      this._body.style.maxHeight = this._body.scrollHeight + 'px';
      // Force a reflow so the browser registers the explicit value before we
      // transition to 0.
      this._body.offsetHeight; // eslint-disable-line no-unused-expressions
      this._body.style.maxHeight = '0';
      this._body.style.opacity   = '0';
      this._body.style.overflow  = 'hidden';
    } else {
      this._body.style.maxHeight = this._body.scrollHeight + 'px';
      this._body.style.opacity   = '1';
      // Restore scrolling once the animation finishes.
      this._body.addEventListener('transitionend', () => {
        if (!this._rolled) {
          this._body.style.maxHeight = '';
          this._body.style.overflow  = '';
        }
      }, { once: true });
    }

    const icon = this._rollBtn.querySelector('i');
    icon.className = `ph ${this._rolled ? 'ph-caret-line-down' : 'ph-caret-line-up'} text-sm leading-none`;
    const existing = this.loadState() ?? {};
    this.saveState({ ...existing, _rolled: this._rolled });
  }

  /**
   * Remove the widget from the DOM and release resources.
   * Calls onDestroy() before clearing the container.
   */
  destroy() {
    this.onDestroy();
    if (this._container) this._container.innerHTML = '';
    this._container = null;
    this._body      = null;
  }

  // ── State persistence ────────────────────────────────────────

  /**
   * Persist arbitrary state for this widget across relaunches.
   * @param {object} data  Must be JSON-serialisable.
   */
  saveState(data) {
    try { localStorage.setItem(`mi-widget-${this.id}`, JSON.stringify(data)); } catch { /* ignore */ }
  }

  /**
   * Retrieve the last saved state, or null if none exists.
   * @returns {object|null}
   */
  loadState() {
    try { return JSON.parse(localStorage.getItem(`mi-widget-${this.id}`) || 'null'); } catch { return null; }
  }

  /** Clear persisted state for this widget. */
  clearState() {
    try { localStorage.removeItem(`mi-widget-${this.id}`); } catch { /* ignore */ }
  }

  // ── Lifecycle hooks (override in subclasses) ────────────────

  /** Called after mount(). Set up event listeners and render initial state. */
  onMount() {}

  /** Called before destroy(). Cancel timers, remove global listeners, etc. */
  onDestroy() {}

  // ── Document event hooks ─────────────────────────────────────

  /**
   * Called (debounced) whenever the editor content changes.
   * @param {string} content   Raw markdown text
   * @param {object} metadata  Parsed front-matter key→{type, value} map
   */
  onDocumentChange(content, metadata) {}

  /**
   * Called when a file is opened (including journal pages created on demand).
   * @param {string} path      Absolute file path
   * @param {string} content   File content
   * @param {object} metadata  Parsed front-matter key→{type, value} map
   */
  onFileOpen(path, content, metadata) {}

  /**
   * Called after a file is successfully saved (auto-save or explicit).
   * The DB index is already updated by the time this fires.
   * @param {string} path  Absolute path of the file that was saved
   */
  onFileSaved(path) {}
}
