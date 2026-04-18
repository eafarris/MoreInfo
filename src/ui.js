/**
 * Shared UI primitives — small, framework-free DOM/HTML helpers used across
 * widgets and editor decorations.
 */

// ── Pill ─────────────────────────────────────────────────────────────────────
// A rounded-pill badge. min-width keeps single-character and multi-character
// pills the same width so columns that hang pills as bullets stay aligned.
//
// PILL_MIN_W must match --taskview-badge-gutter in input.css minus PILL_MR.

const PILL_MIN_W = '1.5rem';
const PILL_MR    = '6px';

const PILL_BASE =
  `display:inline-flex;align-items:center;justify-content:center;` +
  `border-radius:9999px;font-size:11px;font-weight:700;` +
  `line-height:1;padding:3px 5px;min-width:${PILL_MIN_W};` +
  `flex-shrink:0;vertical-align:middle;margin-right:${PILL_MR};`;

/**
 * Returns a pill <span> DOM element.
 * @param {string|number|null} text  Pass null for an invisible alignment spacer.
 * @param {{ color?: string, bg?: string }} opts
 */
export function pillDOM(text, { color = '', bg = 'transparent' } = {}) {
  const span = document.createElement('span');
  span.style.cssText = PILL_BASE;
  if (text != null) {
    span.textContent = String(text);
    span.style.color = color;
    span.style.backgroundColor = bg;
  } else {
    span.textContent = '\u200b'; // zero-width space keeps pill height for alignment
    span.style.color = 'transparent';
    span.style.backgroundColor = 'transparent';
  }
  return span;
}

/**
 * Returns a pill HTML string (for use in innerHTML templates).
 * @param {string|number|null} text  Pass null for an invisible alignment spacer.
 * @param {{ color?: string, bg?: string }} opts
 */
export function pillHTML(text, { color = '', bg = 'transparent' } = {}) {
  if (text != null) {
    const c = color ? `color:${color};` : '';
    return `<span style="${PILL_BASE}${c}background-color:${bg};">${text}</span>`;
  }
  return `<span style="${PILL_BASE}color:transparent;background-color:transparent;">\u200b</span>`;
}

// ── Priority pill ─────────────────────────────────────────────────────────────
// Wraps pillDOM / pillHTML with the app's standard priority colour scheme.

function _priStyle(p) {
  return p <= 1 ? { color: '#fff', bg: 'var(--cm-pri-1, #b91c1c)' } :
         p <= 2 ? { color: '#fff', bg: 'var(--cm-pri-2, #b45309)' } :
         p <= 3 ? { color: '',     bg: 'var(--cm-pri-3, #92400e)' } :
                  { color: '',     bg: 'var(--cm-pri-45, #3f3f46)' };
}

/**
 * Returns a priority pill DOM element (for CodeMirror WidgetType).
 * Returns an invisible spacer when priority > 5.
 */
export function priorityPillDOM(p) {
  if (p <= 5) return pillDOM(String(p), _priStyle(p));
  return pillDOM(null);
}

/**
 * Returns a priority pill HTML string (for widget innerHTML).
 * Returns an invisible spacer when priority > 5.
 */
export function priorityPillHTML(p) {
  if (p <= 5) return pillHTML(String(p), _priStyle(p));
  return pillHTML(null);
}
