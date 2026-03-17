/**
 * Flexible date parsing for MoreInfo.
 *
 * Wraps chrono-node to give PHP strtotime()-like behaviour:
 * handles ISO dates, human formats ("March 15"), natural language
 * ("tomorrow", "last Monday", "the first Monday of next month"), etc.
 *
 * All public functions that return a date do so as a YYYY-MM-DD string
 * so they can be passed directly to Tauri's open_journal command.
 */

import * as chrono from 'chrono-node';

const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun',
                    'Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * Attempt to parse `str` as a date.
 *
 * Returns a YYYY-MM-DD string if successful, or null if the input
 * doesn't look enough like a date.
 *
 * Uses a coverage heuristic to avoid false positives: the matched
 * portion of the string must cover at least 60% of the input, so
 * "May Gunderson" won't trigger a match even though "may" parses.
 *
 * @param {string} str
 * @param {Date}  [referenceDate]  Anchor for relative expressions (default: now)
 * @returns {string|null}  YYYY-MM-DD or null
 */
export function parseFlexibleDate(str, referenceDate) {
  const trimmed = (str || '').trim();
  if (!trimmed) return null;

  const results = chrono.parse(trimmed, referenceDate ?? new Date(), { forwardDate: false });
  if (!results.length) return null;

  const best = results[0];

  // Reject if the matched text covers less than 60% of the input —
  // this filters cases where a name or word merely contains a month.
  if (best.text.length < trimmed.length * 0.6) return null;

  return toIso(best.start.date());
}

/**
 * Format a YYYY-MM-DD string as a human-readable label,
 * e.g. "17 Mar 2026".  Returns the input unchanged on parse failure.
 *
 * @param {string} iso  YYYY-MM-DD
 * @returns {string}
 */
export function formatJournalDate(iso) {
  try {
    const d = new Date(iso + 'T12:00:00');
    return `${d.getDate()} ${MONTH_ABBR[d.getMonth()]} ${d.getFullYear()}`;
  } catch {
    return iso;
  }
}

/**
 * Convert a JS Date to a YYYY-MM-DD string in local time.
 * @param {Date} date
 * @returns {string}
 */
export function toIso(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Today's date as YYYY-MM-DD.
 * @returns {string}
 */
export function todayIso() {
  return toIso(new Date());
}
