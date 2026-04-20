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
import { getPref, setPref, removePref } from '../prefs.js';

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
    /** @type {ResizeObserver|null} Defers rolled-state application until container is visible */
    this._rollObserver = null;
    /** @type {boolean} True when this is the last (bottom/right) widget in its sidebar */
    this._isLast = false;
  }

  /**
   * Extra Tailwind classes applied to the wrapper div by the mounting system.
   * Use to control how the widget sizes within its sidebar (e.g. flex-1, shrink-0).
   * @returns {string}
   */
  get wrapperClass() { return ''; }

  /**
   * When true, the mounting system and drag-resize system leave the widget's
   * flex value alone — the widget sizes itself based on its content.
   * @returns {boolean}
   */
  get fixedSize() { return false; }

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
  mount(container, orientation = 'vertical', { isLast = false } = {}) {
    this._container   = container;
    this._orientation = orientation;
    this._isLast      = isLast;
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
        <div class="widget-header flex flex-col items-center px-1.5 py-3 shrink-0 border-r border-olive-700 bg-transparent cursor-default select-none" style="width:28px">
          <button class="widget-roll-btn text-olive-500 hover:text-olive-300 p-0.5 leading-none bg-transparent border-none cursor-pointer" title="Roll">
            <i class="ph ${this._rollIconClass()} text-sm leading-none"></i>
          </button>
          <span class="widget-title mt-auto text-xs font-semibold text-olive-500 tracking-wide uppercase" style="writing-mode:vertical-rl;transform:rotate(180deg)"><i class="ph ${this.icon} text-sm leading-none"></i>${this.title}</span>
        </div>
        <div class="widget-body flex-1 min-w-0 overflow-y-auto"></div>
      `;
    } else {
      // ── Vertical orientation (left / right sidebars) ─────────────────────
      container.innerHTML = `
        <div class="widget-header flex items-center justify-between px-3 py-1 shrink-0 border-b border-olive-700 bg-transparent cursor-default select-none">
          <span class="widget-title flex items-center gap-1.5 text-xs font-semibold text-olive-500 tracking-wide uppercase">
            <i class="ph ${this.icon} text-sm leading-none"></i>
            ${this.title}
          </span>
          <span class="flex items-center gap-1">
            ${this.headerAction}
            <button class="widget-roll-btn text-olive-500 hover:text-olive-300 p-0.5 leading-none bg-transparent border-none cursor-pointer" title="Roll">
              <i class="ph ${this._rollIconClass()} text-sm leading-none"></i>
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

    this.onMount();

    // Measure the header size.  Only update when the container is visible
    // (offsetHeight > 0); if the sidebar is hidden the measurement is 0 and
    // we must not clobber any previously stored value.
    const header = container.querySelector('.widget-header');
    const measuredHeader = horiz ? header.offsetWidth : header.offsetHeight;
    if (measuredHeader > 0) this._headerSize = measuredHeader;

    // Apply the initial rolled state.
    // If the container is hidden (measurements are 0) we can't compute the
    // correct maxHeight/maxWidth yet.  Install a ResizeObserver that fires once
    // the container becomes visible and applies the constraint then (without any
    // transition animation, so there's no visible flash).
    if (this._rolled) {
      const prop       = horiz ? 'maxWidth'   : 'maxHeight';
      const marginProp = horiz ? 'marginLeft' : 'marginTop';
      if (this._headerSize > 0) {
        container.style[prop]          = this._headerSize + 'px';
        container.style.flex           = `0 0 ${this._headerSize}px`;
        if (this._isLast) container.style[marginProp] = 'auto';
        this._body.style.opacity       = '0';
        this._body.style.pointerEvents = 'none';
      } else {
        // Sidebar is hidden — defer until we can measure.
        this._body.style.opacity       = '0';
        this._body.style.pointerEvents = 'none';
        this._rollObserver = new ResizeObserver(() => {
          const hNow = horiz ? header.offsetWidth  : header.offsetHeight;
          if (hNow <= 0) return;           // still not visible
          this._rollObserver.disconnect();
          this._rollObserver = null;
          this._headerSize  = hNow;
          container.style[prop] = this._headerSize + 'px';
          container.style.flex  = `0 0 ${this._headerSize}px`;
          if (this._isLast) container.style[marginProp] = 'auto';
          // Don't enable transitions here — this fires during the reveal paint.
        });
        this._rollObserver.observe(container);
      }
    }

    // Enable transitions only after the initial layout has been painted,
    // so the above constraints don't produce an unwanted animation on load.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const prop = horiz ? 'max-width' : 'max-height';
      container.style.transition        = `${prop} 220ms ease, flex-basis 220ms ease`;
      this._body.style.transition       = 'opacity 180ms ease';
    }));
  }

  /**
   * Returns the Phosphor icon class for the roll button given the current
   * rolled state and position.  For the last widget the caret direction is
   * flipped so it always points toward the sidebar edge the widget rolls to.
   */
  _rollIconClass() {
    const horiz = this._orientation === 'horizontal';
    if (horiz) {
      // Normal (non-last): rolls left → right caret when unrolled, left when rolled.
      // Last: rolls right → left caret when unrolled (slides right), right when rolled.
      return this._rolled
        ? (this._isLast ? 'ph-caret-line-left'  : 'ph-caret-line-right')
        : (this._isLast ? 'ph-caret-line-right' : 'ph-caret-line-left');
    } else {
      // Normal (non-last): rolls up → up caret when unrolled, down when rolled.
      // Last: rolls down → down caret when unrolled (slides down), up when rolled.
      return this._rolled
        ? (this._isLast ? 'ph-caret-line-up'   : 'ph-caret-line-down')
        : (this._isLast ? 'ph-caret-line-down' : 'ph-caret-line-up');
    }
  }

  _toggleRoll() {
    this._rolled = !this._rolled;
    const horiz      = this._orientation === 'horizontal';
    const prop       = horiz ? 'maxWidth'   : 'maxHeight';
    const sizeProp   = horiz ? 'offsetWidth' : 'offsetHeight';
    const marginProp = horiz ? 'marginLeft' : 'marginTop';

    if (this._rolled) {
      // Give the browser a concrete "from" value by locking the current size,
      // force a reflow, then animate to header size.
      const currentSize = this._container[sizeProp];
      this._container.style.flex  = `0 0 ${currentSize}px`;
      this._container.style[prop] = currentSize + 'px';
      this._container.offsetHeight; // eslint-disable-line no-unused-expressions
      // Last widget: set auto-margin before animating so the header stays
      // pinned to the trailing edge as the widget shrinks.
      if (this._isLast) this._container.style[marginProp] = 'auto';
      this._container.style.flex     = `0 0 ${this._headerSize}px`;
      this._container.style[prop]    = this._headerSize + 'px';
      this._body.style.opacity       = '0';
      this._body.style.pointerEvents = 'none';
    } else {
      this._body.style.opacity       = '1';
      this._body.style.pointerEvents = '';

      // Animate to fill the space currently available in the sidebar, then
      // hand off to flex so the widget stays responsive to future resizes.
      const stack        = this._container.parentElement;
      const stackSize    = stack ? stack[sizeProp] : 0;
      const siblingsSize = stack
        ? [...stack.querySelectorAll('[data-widget-id]')]
            .filter(w => w !== this._container)
            .reduce((sum, w) => sum + w[sizeProp], 0)
        : 0;
      const targetSize = Math.max(this._headerSize * 2, stackSize - siblingsSize);

      if (stackSize > 0) {
        this._container.style.flex  = `1 0 ${targetSize}px`;
        this._container.style[prop] = targetSize + 'px';
        this._container.addEventListener('transitionend', () => {
          if (!this._rolled) {
            this._container.style[prop]       = '';
            this._container.style[marginProp] = '';
            this._container.style.flex        = '1 1 0';
          }
        }, { once: true });
      } else {
        // Sidebar not yet visible — skip animation, just clear constraints.
        this._container.style[prop]       = '';
        this._container.style[marginProp] = '';
        this._container.style.flex        = '1 1 0';
      }
    }

    this._rollBtn.querySelector('i').className =
      `ph ${this._rollIconClass()} text-sm leading-none`;

    const existing = this.loadState() ?? {};
    this.saveState({ ...existing, _rolled: this._rolled });
  }

  /**
   * Unroll this widget instantly (no animation) without changing its size.
   * The body becomes visible and the max-height/max-width constraint is cleared,
   * but flex is left alone so the caller (drag-resize) can grow the widget from
   * its current header size via normal drag handling.  A no-op if already unrolled.
   */
  unrollImmediate() {
    if (!this._rolled) return;
    this._rolled = false;

    const horiz      = this._orientation === 'horizontal';
    const prop       = horiz ? 'maxWidth'  : 'maxHeight';
    const marginProp = horiz ? 'marginLeft' : 'marginTop';

    this._container.style.transition  = 'none';
    this._body.style.transition       = 'none';
    this._container.style[prop]       = '';
    this._container.style[marginProp] = '';
    this._body.style.opacity          = '1';
    this._body.style.pointerEvents    = '';

    const cssProp = horiz ? 'max-width' : 'max-height';
    requestAnimationFrame(() => {
      this._container.style.transition = `${cssProp} 220ms ease, flex-basis 220ms ease`;
      this._body.style.transition      = 'opacity 180ms ease';
    });

    this._rollBtn.querySelector('i').className =
      `ph ${this._rollIconClass()} text-sm leading-none`;

    const existing = this.loadState() ?? {};
    this.saveState({ ...existing, _rolled: false });
  }

  /**
   * Remove the widget from the DOM and release resources.
   * Calls onDestroy() before clearing the container.
   */
  destroy() {
    this.onDestroy();
    if (this._rollObserver) { this._rollObserver.disconnect(); this._rollObserver = null; }
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
    setPref(`widget_${this.id}`, data);
  }

  /**
   * Retrieve the last saved state, or null if none exists.
   * @returns {object|null}
   */
  loadState() {
    return getPref(`widget_${this.id}`, null);
  }

  /** Clear persisted state for this widget. */
  clearState() {
    removePref(`widget_${this.id}`);
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
