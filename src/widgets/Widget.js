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
    container.innerHTML = `
      <div class="flex items-center justify-between px-3 py-1.5 shrink-0 border-b border-olive-700" style="background:#1c1c1c">
        <span class="flex items-center gap-1.5 text-xs font-semibold text-olive-500 tracking-wide uppercase">
          <i class="ph ${this.icon} text-sm leading-none"></i>
          ${this.title}
        </span>
        ${this.headerAction}
      </div>
      <div class="widget-body flex-1 min-h-0 overflow-y-auto"></div>
    `;
    this._body = container.querySelector('.widget-body');
    this.onMount();
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
}
