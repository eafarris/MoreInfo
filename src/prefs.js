/**
 * Datastore-backed user preferences.
 *
 * All UI state and user settings live in <datastore>/preferences.json (the
 * `ui` key, managed by the `get_ui_prefs` / `save_ui_prefs` Tauri commands).
 * The ONLY thing stored outside the datastore is the datastore path itself
 * (app-level config in OS Application Support).
 *
 * Usage:
 *   1. `await initPrefs()` once at app startup, before any getPref() call.
 *   2. `getPref(key, default)` — synchronous read from the in-memory cache.
 *   3. `setPref(key, value)` — synchronous write to cache + debounced disk flush.
 *   4. `setPrefs(obj)` — bulk update, single debounced flush.
 *   5. `removePref(key)` — delete a key from the cache + debounced flush.
 *   6. `flushPrefs()` — force an immediate write (e.g. before app quits).
 */

import { invoke } from './tauri.js';

let _cache = null;   // null = uninitialised
let _timer = null;

/** Load prefs from the datastore. Must be awaited before any getPref() call. */
export async function initPrefs() {
  try {
    const raw = await invoke('get_ui_prefs');
    _cache = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  } catch {
    _cache = {};
  }
}

/**
 * Synchronous read. Returns `defaultVal` if the key is absent.
 * Throws if initPrefs() has not been awaited.
 */
export function getPref(key, defaultVal = undefined) {
  if (_cache === null) {
    console.warn('getPref() called before initPrefs(); returning default');
    return defaultVal;
  }
  return key in _cache ? _cache[key] : defaultVal;
}

/** Write one key and schedule a debounced persist. */
export function setPref(key, value) {
  if (_cache === null) _cache = {};
  _cache[key] = value;
  _schedule();
}

/** Write multiple keys at once and schedule a debounced persist. */
export function setPrefs(obj) {
  if (_cache === null) _cache = {};
  Object.assign(_cache, obj);
  _schedule();
}

/** Remove a key and schedule a debounced persist. */
export function removePref(key) {
  if (_cache === null) return;
  delete _cache[key];
  _schedule();
}

/** Flush immediately — use before the app window closes. */
export function flushPrefs() {
  clearTimeout(_timer);
  _timer = null;
  return invoke('save_ui_prefs', { prefs: _cache ?? {} }).catch(console.error);
}

function _schedule() {
  clearTimeout(_timer);
  _timer = setTimeout(() => {
    _timer = null;
    invoke('save_ui_prefs', { prefs: _cache }).catch(console.error);
  }, 300);
}
