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

/**
 * Return true if `deferUntil` (the raw string from an `@defer(...)` tag)
 * represents a date that has not yet passed.
 *
 * Uses forwardDate:true so relative expressions like "friday" or "next week"
 * are always resolved to the next upcoming occurrence rather than the
 * most recent past one.
 *
 * @param {string} deferUntil  Raw value extracted from @defer(...)
 * @returns {boolean}
 */
export function isDeferred(deferUntil) {
  if (!deferUntil || !deferUntil.trim()) return false;
  const trimmed = deferUntil.trim();
  const results = chrono.parse(trimmed, new Date(), { forwardDate: true });
  if (!results.length) return false;
  const best = results[0];
  if (best.text.length < trimmed.length * 0.6) return false;
  return toIso(best.start.date()) > todayIso();
}

/**
 * Resolve a raw @due(...) value to a YYYY-MM-DD string.
 *
 * Relative expressions like "tomorrow" or "friday" are interpreted relative
 * to `referenceDate`.  When called from the editor (live typing), pass
 * `new Date()`.  When called for stored/indexed tasks, pass the task's
 * `first_seen` date so that "tomorrow" written yesterday resolves to today,
 * not to tomorrow again.
 *
 * @param {string}      raw            Raw value from @due(...)
 * @param {Date|string} [referenceDate] Anchor for relative expressions (default: now)
 * @returns {string|null}  YYYY-MM-DD or null on parse failure
 */
export function resolveDueDate(raw, referenceDate) {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  const ref = referenceDate instanceof Date ? referenceDate
    : typeof referenceDate === 'string' ? new Date(referenceDate + 'T12:00:00')
    : new Date();
  const results = chrono.parse(trimmed, ref, { forwardDate: false });
  if (!results.length) return null;
  const best = results[0];
  if (best.text.length < trimmed.length * 0.6) return null;
  return toIso(best.start.date());
}

/**
 * Return true if `dueDate` (the raw string from a `@due(...)` tag)
 * represents a date that is strictly before today.
 *
 * @param {string}      dueDate        Raw value extracted from @due(...)
 * @param {Date|string} [referenceDate] Anchor for relative expressions (default: now)
 * @returns {boolean}
 */
export function isOverdue(dueDate, referenceDate) {
  const iso = resolveDueDate(dueDate, referenceDate);
  return iso != null && iso < todayIso();
}

/**
 * Return true if `dueDate` resolves to today's date.
 *
 * @param {string}      dueDate        Raw value extracted from @due(...)
 * @param {Date|string} [referenceDate] Anchor for relative expressions (default: now)
 * @returns {boolean}
 */
export function isDueToday(dueDate, referenceDate) {
  const iso = resolveDueDate(dueDate, referenceDate);
  return iso != null && iso === todayIso();
}

/**
 * Compute the effective priority of a task, accounting for due-date urgency.
 *
 * Base priority is the explicit value (1–5) or the implicit default (10).
 * When a @due(date) is present, the priority is halved each time the
 * remaining time is cut in half relative to the total span from first_seen
 * to due.  Concretely: at the halfway point the priority is halved, at the
 * 3/4 point halved again, at 7/8 again, etc., with a floor of 1.
 *
 * @param {number} basePriority  Explicit priority (1–5) or 10 (implicit)
 * @param {string} dueDate       Raw @due(...) value (natural language ok)
 * @param {string} firstSeen     YYYY-MM-DD when the task was first indexed
 * @returns {number}  Effective priority (lower = more urgent), minimum 1
 */
export function computeEffectivePriority(basePriority, dueDate, firstSeen) {
  if (!dueDate || !dueDate.trim() || !firstSeen) return basePriority;

  const dueIso = resolveDueDate(dueDate, firstSeen);
  if (!dueIso) return basePriority;

  const dueMs     = new Date(dueIso + 'T00:00:00').getTime();
  const createdMs = new Date(firstSeen + 'T00:00:00').getTime();
  const nowMs     = Date.now();

  const totalSpan     = dueMs - createdMs;
  const remainingSpan = dueMs - nowMs;

  // If due date is in the past or total span is non-positive, max urgency.
  if (remainingSpan <= 0 || totalSpan <= 0) return 1;

  // fraction of time remaining (1.0 = just created, 0.0 = due now)
  const fraction = Math.min(remainingSpan / totalSpan, 1.0);

  // Each halving of remaining time halves the priority.
  // halvings = -log2(fraction): 0 at creation, 1 at halfway, 2 at 3/4, etc.
  const halvings = -Math.log2(fraction);
  const effective = basePriority / Math.pow(2, halvings);
  return Math.max(1, Math.round(effective));
}
