/**
 * Shared CamelCase wiki-link utilities.
 *
 * All consumers (editor.js, main.js, TasksWidget.js) import from here so the
 * regex, title-conversion logic, and enabled flag live in exactly one place.
 */

// Returns a fresh /g regex each time — callers must not share one instance
// across calls because /g regexes carry mutable lastIndex state.
export function camelRe() {
  return /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g;
}

// "AndersonContract" → "Anderson Contract"
export function camelToTitle(camel) {
  return camel.replace(/([A-Z])/g, ' $1').trim();
}

let _enabled = true;

export function setCamelEnabled(enabled) { _enabled = !!enabled; }
export function isCamelEnabled()         { return _enabled; }
