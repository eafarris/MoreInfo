/**
 * Pure stack mechanics for back/forward navigation.
 *
 * Kept separate from main.js (rather than inlined) so the edge cases —
 * going back/forward past the end of a stack, navigating with no current
 * page yet — are unit-testable without the rest of the app's DOM/Tauri
 * wiring. `main.js` still owns the actual `navHistory`/`navFuture` arrays
 * (they're also used directly for breadcrumb rendering); these functions
 * just operate on whatever arrays are passed in.
 */

/**
 * Move one step back. Mutates `backStack`/`forwardStack` in place.
 * @param {Array} backStack     entries older than the current page
 * @param {Array} forwardStack  entries newer than the current page
 * @param {{path: string, title: string}|null} current  the page being left, or null if none
 * @returns {{path: string, title: string}|null} the entry to load, or null if `backStack` is empty
 */
export function popBack(backStack, forwardStack, current) {
  if (!backStack.length) return null;
  if (current) forwardStack.push(current);
  return backStack.pop();
}

/**
 * Move one step forward. Mutates `backStack`/`forwardStack` in place.
 * @param {Array} backStack     entries older than the current page
 * @param {Array} forwardStack  entries newer than the current page
 * @param {{path: string, title: string}|null} current  the page being left, or null if none
 * @returns {{path: string, title: string}|null} the entry to load, or null if `forwardStack` is empty
 */
export function popForward(backStack, forwardStack, current) {
  if (!forwardStack.length) return null;
  if (current) backStack.push(current);
  return forwardStack.pop();
}
