/**
 * Base class for all MoreInfo widgets.
 *
 * Lifecycle (called by the mounting system):
 *   mount(container, orientation)  — renders the standard shell, then calls onMount()
 *   destroy()                      — calls onDestroy(), then clears the container
 *
 * Document event hooks (called by the app):
 *   onDocumentChange(content, metadata)
 *   onFileOpen(path, content, metadata)
 *
 * Subclass API:
 *   get wrapperClass()   — extra Tailwind classes on the wrapper div
 *   get headerAction()   — HTML string injected at the right of the header (vertical only)
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
    this._container   = null;
    /** @type {HTMLElement|null} The scrollable content area inside the shell */
    this._body        = null;
    /** @type {boolean} Whether the widget body is currently rolled up */
    this._rolled      = false;
    /** @type {HTMLElement|null} The roll toggle button in the header */
    this._rollBtn     = null;
    /** @type {'vertical'|'horizontal'} Set by mount() */
    this._orientation = 'vertical';
    /** @type {number} Header height (vertical) or width (horizontal) in px */
    this._headerSize  = 0;
    /** @type {number|null} Full container size before rolling; null until first roll */
    this._naturalSize = null;
  }

  /**
   * Extra Tailwind classes applied to the wrapper div by the mounting system.
   * Use to control how the widget sizes within its sidebar (e.g. flex-1, shrink-0).
   * @returns {string}
   */
  get wrapperClass() { return ''; }

  /**
   * Optional HTML rendered at the trailing edge of the widget header (vertical only).
   * Use for counters, secondary labels, or action buttons.
   * @returns {string}
   */
  get headerAction() { return ''; }

  /**
   * Mount this widget into a container element.
   * Renders the standard header + body shell, then calls onMount().
   *
   * @param {HTMLElement} container
   * @param {'vertical'|'horizontal'} [orientation='vertical']
   *   'vertical'   — left/right sidebars: horizontal title bar, rolls up/down
   *   'horizontal' — top/bottom sidebars: vertical title strip, rolls left/right
   */
  mount(container, orientation = 'vertical') {
    this._container   = container;
    this._orientation = orientation;
    const savedState  = this.loadState();
    this._rolled      = savedState?._rolled ?? false;

    const horiz = orientation === 'horizontal';

    container.style.display       = 'flex';
    container.style.flexDirection = horiz ? 'row' : 'column';
    container.style.overflow      = 'hidden';

    if (horiz) {
      // ── Horizontal orientation (top / bottom sidebars) ──────────────────
      // Mirrors the vertical header exactly, rotated -90°.
      // flex-col header: roll button flush-top, title+icon pushed to bottom via mt-auto.
      // DOM order inside the writing-mode span: <icon> then title text — after
      // writing-mode:vertical-rl + rotate(180°) the icon lands at the visual
      // bottom and the text reads upward, matching a -90° rotation of the
      // horizontal layout.
      // Padding is the horizontal header's px↔py swapped for the axis change.
      container.innerHTML = `
        <div class="widget-header flex flex-col items-center px-1.5 py-3 shrink-0 border-r border-olive-700 bg-olive-800 cursor-default select-none" style="width:28px">
          <button class="widget-roll-btn text-olive-500 hover:text-olive-300 p-0.5 leading-none bg-transparent border-none cursor-pointer" title="Roll">
            <i class="ph ${this._rolled ? 'ph-caret-line-right' : 'ph-caret-line-left'} text-sm leading-none"></i>
          </button>
          <span class="widget-title mt-auto text-xs font-semibold text-olive-500 tracking-wide uppercase" style="writing-mode:vertical-rl;transform:rotate(180deg)"><i class="ph ${this.icon} text-sm leading-none"></i>${this.title}</span>
        </div>
        <div class="widget-body flex-1 min-w-0 overflow-y-auto"></div>
      `;
    } else {
      // ── Vertical orientation (left / right sidebars) ─────────────────────
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
    }

    this._body    = container.querySelector('.widget-body');
    this._rollBtn = container.querySelector('.widget-roll-btn');

    container.querySelector('.widget-title').addEventListener('dblclick', () => this._toggleRoll());
    this._rollBtn.addEventListener('click', () => this._toggleRoll());

    // Call onMount() before measuring so the body is populated with content,
    // giving accurate natural-size readings.
    this.onMount();

    // Measure sizes with full content rendered.
    const header = container.querySelector('.widget-header');
    this._headerSize  = horiz ? header.offsetWidth  : header.offsetHeight;
    this._naturalSize = horiz ? container.offsetWidth : container.offsetHeight;

    // Apply the initial rolled state synchronously (no transition yet, so it's
    // part of the first paint with no visible flash).
    if (this._rolled) {
      const prop = horiz ? 'maxWidth' : 'maxHeight';
      container.style[prop]        = this._headerSize + 'px';
      this._body.style.opacity     = '0';
      this._body.style.pointerEvents = 'none';
    }

    // Enable transitions only after the initial layout has been painted,
    // so the above constraints don't produce an unwanted animation on load.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const prop = horiz ? 'max-width' : 'max-height';
      container.style.transition        = `${prop} 220ms ease`;
      this._body.style.transition       = 'opacity 180ms ease';
    }));
  }

  _toggleRoll() {
    this._rolled = !this._rolled;
    const horiz  = this._orientation === 'horizontal';
    const prop   = horiz ? 'maxWidth' : 'maxHeight';
    const sizeProp = horiz ? 'offsetWidth' : 'offsetHeight';

    if (this._rolled) {
      // Save the current full size so we can restore it later.
      this._naturalSize = this._container[sizeProp];
      // Set an explicit value first (so the browser has a concrete "from" value),
      // force a reflow, then animate to the header size.
      this._container.style[prop] = this._naturalSize + 'px';
      this._container.offsetHeight; // eslint-disable-line no-unused-expressions
      this._container.style[prop]       = this._headerSize + 'px';
      this._body.style.opacity          = '0';
      this._body.style.pointerEvents    = 'none';
    } else {
      const target = this._naturalSize ?? this._container[sizeProp];
      this._container.style[prop]     = target + 'px';
      this._body.style.opacity        = '1';
      this._body.style.pointerEvents  = '';
      // After the animation completes, clear the explicit constraint so the
      // widget can resize freely (e.g. when the sidebar is resized).
      this._container.addEventListener('transitionend', () => {
        if (!this._rolled) this._container.style[prop] = '';
      }, { once: true });
    }

    const icon = this._rollBtn.querySelector('i');
    if (horiz) {
      icon.className = `ph ${this._rolled ? 'ph-caret-line-right' : 'ph-caret-line-left'} text-sm leading-none`;
    } else {
      icon.className = `ph ${this._rolled ? 'ph-caret-line-down' : 'ph-caret-line-up'} text-sm leading-none`;
    }

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
