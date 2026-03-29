/**
 * @calc block — expression evaluator, formatter, and preview pre-processor.
 *
 * A @calc block starts with a line containing exactly "@calc" and continues
 * until a blank line or end of document. Each non-blank line is treated as an
 * arithmetic expression. math.js handles evaluation, including unit math and
 * conversions.
 *
 * Implicit-prepend rule:
 *   If an expression starts with a binary operator (+  -  *  /  %  **  ^),
 *   the previous result is silently prepended as the left operand.
 *     "+23"   →  (last)+23      (add 23 to previous result)
 *     "* 1.1" →  (last)*1.1    (mark up by 10 %)
 *   The previous result is tracked in the math.js scope as `_last`, so unit
 *   values carry through correctly (e.g. `_last + 5 miles` when last = 10 miles).
 *
 * Unit support (via math.js):
 *   "2 * 5 miles"        → 10 miles
 *   "5 miles / 10 days"  → 0.5 miles / day
 *   "2 miles in km"      → 3.21869 km
 *   "2 miles to km"      → 3.21869 km   (alias for "in")
 *
 * Date math (via chrono-node + Luxon):
 *   "today"                → Mar 28, 2026
 *   "next friday"          → Apr 3, 2026
 *   "today + 3 days"       → Mar 31, 2026
 *   "2026-06-01 - 2 weeks" → May 18, 2026
 *   "2026-06-01 - today"   → 2 months, 4 days  (duration between two dates)
 *   "+ 1 month"            → carry-forward: adds 1 month to the previous date result
 *
 *   `scope._lastDate` tracks the most recent date result.  It is cleared whenever
 *   a numeric/unit result is produced, so switching between date and number lines
 *   within a block works as expected.
 */

import { evaluate as mathEval, format as mathFormat, typeOf } from 'mathjs';
import { DateTime, Duration } from 'luxon';
import * as chrono from 'chrono-node';

// Matches a leading binary operator at the start of a trimmed expression.
// ** must be tested before * so two-character tokens aren't split.
const LEADING_BINOP = /^(\*\*|[-+*/%^])/;

// ── Date math helpers ─────────────────────────────────────────────────────

// Maps singular unit names to Luxon Duration keys.
const DURATION_UNIT_MAP = {
  day: 'days', week: 'weeks', month: 'months', year: 'years',
  hour: 'hours', minute: 'minutes', second: 'seconds',
};
const DURATION_RE = /^(\d+(?:\.\d+)?)\s*(day|week|month|year|hour|minute|second)s?$/i;

function parseDuration(str) {
  const m = str.trim().match(DURATION_RE);
  if (!m) return null;
  return Duration.fromObject({ [DURATION_UNIT_MAP[m[2].toLowerCase()]]: parseFloat(m[1]) });
}

/** Parse `str` as a date via chrono-node. Returns a Luxon DateTime or null. */
function tryParseDate(str) {
  const s = str.trim();
  const hits = chrono.parse(s, new Date());
  if (!hits.length || hits[0].index !== 0) return null;
  return DateTime.fromJSDate(hits[0].date());
}

function formatDateResult(dt) {
  const now = DateTime.now();
  if (dt.hasSame(now, 'day'))                   return 'today';
  if (dt.hasSame(now.plus({ days: 1 }), 'day'))  return 'tomorrow';
  if (dt.hasSame(now.minus({ days: 1 }), 'day')) return 'yesterday';
  const diffDays = Math.abs(dt.diff(now, 'days').days);
  if (diffDays < 7) return dt.toFormat('cccc, MMM d');   // "Saturday, Apr 5"
  return dt.toLocaleString(DateTime.DATE_MED);            // "Apr 5, 2026"
}

function formatDateDiff(from, to) {
  const diff = from.diff(to, ['years', 'months', 'days']).toObject();
  const negative = from < to;
  const abs = {
    years:  Math.abs(Math.round(diff.years  || 0)),
    months: Math.abs(Math.round(diff.months || 0)),
    days:   Math.abs(Math.round(diff.days   || 0)),
  };
  const parts = [];
  if (abs.years)  parts.push(`${abs.years} ${abs.years === 1 ? 'year' : 'years'}`);
  if (abs.months) parts.push(`${abs.months} ${abs.months === 1 ? 'month' : 'months'}`);
  if (abs.days)   parts.push(`${abs.days} ${abs.days === 1 ? 'day' : 'days'}`);
  if (!parts.length) return '0 days';
  return (negative ? '-' : '') + parts.join(', ');
}

/**
 * Try to evaluate `e` as a date expression.  Returns a result object on
 * success, or `null` to signal the caller to fall through to math.js.
 *
 * Handles:
 *   DATE                       → display the date
 *   DATE + DURATION            → date arithmetic
 *   DATE - DURATION            → date arithmetic
 *   DATE - DATE                → duration between two dates
 *   + DURATION / - DURATION    → carry-forward from scope._lastDate
 *
 * Operators must be surrounded by spaces (" + " / " - ") so that hyphens
 * inside ISO dates ("2026-06-01") are never mistaken for subtraction.
 */
function tryDateExpr(e, scope) {
  // Carry-forward: if the previous result was a date and this line opens with
  // + or -, apply the duration to that date.
  if (scope._lastDate && LEADING_BINOP.test(e)) {
    const op   = e[0];
    const rest = e.slice(1).trim();
    const dur  = parseDuration(rest);
    if (dur) {
      const result = op === '+' ? scope._lastDate.plus(dur) : scope._lastDate.minus(dur);
      scope._lastDate = result;
      scope._last = 0;
      return { formatted: formatDateResult(result) };
    }
  }

  // Split on the first spaced operator (" + " or " - ").  Requiring spaces on
  // both sides means the hyphens in "2026-06-01" are never treated as operators.
  for (const sep of [' + ', ' - ']) {
    const idx = e.indexOf(sep);
    if (idx === -1) continue;

    const lhs = e.slice(0, idx);
    const op  = sep.trim();     // '+' or '-'
    const rhs = e.slice(idx + sep.length);

    const leftDate = tryParseDate(lhs);
    if (!leftDate) continue;

    // DATE +/- DURATION → new date
    const dur = parseDuration(rhs);
    if (dur) {
      const result = op === '+' ? leftDate.plus(dur) : leftDate.minus(dur);
      scope._lastDate = result;
      scope._last = 0;
      return { formatted: formatDateResult(result) };
    }

    // DATE - DATE → duration between two dates
    if (op === '-') {
      const rightDate = tryParseDate(rhs);
      if (rightDate) {
        scope._lastDate = null;
        scope._last = 0;
        return { formatted: formatDateDiff(leftDate, rightDate) };
      }
    }
  }

  // Bare date (no operator) — parse and display.
  const bareDate = tryParseDate(e);
  if (bareDate) {
    scope._lastDate = bareDate;
    scope._last = 0;
    return { formatted: formatDateResult(bareDate) };
  }

  return null;
}

// ── Expression evaluator ──────────────────────────────────────────────────

/**
 * Evaluate a single arithmetic expression string.
 *
 * @param {string} expr   Raw text of the expression line.
 * @param {object} scope  math.js scope object shared across a block.
 *                        Must contain `_last` (number or math.js value).
 *                        Mutated in place when a result is produced.
 * @returns {{ formatted: string } | { error: string } | { value: null }}
 */
export function evalCalcExpr(expr, scope) {
  const trimmed = expr.trim();
  if (!trimmed) return { value: null };

  // Strip [[wiki links]] — page references are decorative, not operands.
  let e = trimmed.replace(/\[\[[^\]]*\]\]/g, '').trim();
  if (!e) return { value: null };

  // Try date math before the implicit-prepend transformation so carry-forward
  // (`+ 3 days` when _lastDate is set) is intercepted before it becomes `_last + 3 days`.
  const dateResult = tryDateExpr(e, scope);
  if (dateResult) return dateResult;

  // Implicit prepend: if expression starts with a binary operator OR a unit
  // conversion keyword ("in km", "to miles"), prepend _last so math.js
  // receives a complete expression ("_last in km", "_last + 5 miles", etc.).
  if (LEADING_BINOP.test(e) || /^(in|to)\s+/i.test(e)) e = `_last ${e}`;

  try {
    const result = mathEval(e, scope);
    const t = typeOf(result);
    if (t !== 'number' && t !== 'Unit') return { error: 'Error' };
    scope._last = result;
    scope._lastDate = null;   // clear date context when switching to a number result
    return { formatted: formatResult(result, t) };
  } catch (err) {
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('unit') || msg.includes('dimension')) return { error: 'Unit error' };
    return { error: 'Error' };
  }
}

// ── Number / unit formatter ────────────────────────────────────────────────

function formatResult(result, t) {
  if (t === 'number') {
    if (!Number.isFinite(result)) return result > 0 ? '∞' : '-∞';
    if (Number.isInteger(result)) return result.toLocaleString();
    const stripped = parseFloat(result.toPrecision(6));
    return stripped.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  // Unit — let math.js format it (e.g. "3.21869 km", "0.5 miles / day")
  return mathFormat(result, { precision: 6 });
}

// ── Block scanner (used by the CM6 plugin) ────────────────────────────────

/**
 * Scan a plain-text document and return a map from 1-based line number to its
 * formatted result. Also returns the set of @calc header line numbers.
 *
 * @param {string} text  Full document text.
 * @returns {{
 *   results:     Map<number, { formatted: string|null, error: string|null }>,
 *   headerLines: Set<number>
 * }}
 */
export function scanCalcBlocks(text) {
  const results     = new Map();
  const headerLines = new Set();
  const docLines    = text.split('\n');

  let inBlock = false;
  let scope   = null;

  for (let i = 0; i < docLines.length; i++) {
    const lineNo  = i + 1;
    const trimmed = docLines[i].trim();

    if (!inBlock) {
      if (trimmed === '@calc') {
        inBlock = true;
        scope   = { _last: 0, _lastDate: null };
        headerLines.add(lineNo);
      }
    } else {
      if (trimmed === '') {
        inBlock = false;
        scope   = null;
      } else {
        const res = evalCalcExpr(trimmed, scope);
        results.set(lineNo, {
          formatted: res.formatted ?? null,
          error:     res.error     ?? null,
        });
      }
    }
  }

  return { results, headerLines };
}

// ── Preview pre-processor ─────────────────────────────────────────────────

/**
 * Replace @calc blocks in a markdown string with equivalent HTML for preview.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function preprocessCalcBlocks(markdown) {
  const lines = markdown.split('\n');
  const out   = [];
  let block   = null;
  let scope   = null;

  const flushBlock = () => {
    if (!block || block.length === 0) { block = null; return; }
    out.push('<table class="mi-calc-block"><tbody>');
    for (const row of block) {
      const res = row.error != null
        ? `<td class="mi-calc-result mi-calc-error">${esc(row.error)}</td>`
        : `<td class="mi-calc-result">= ${esc(row.formatted)}</td>`;
      out.push(`<tr><td class="mi-calc-expr">${esc(row.text)}</td>${res}</tr>`);
    }
    out.push('</tbody></table>');
    block = null;
  };

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!block) {
      if (trimmed === '@calc') {
        block = [];
        scope = { _last: 0, _lastDate: null };
      } else {
        out.push(raw);
      }
    } else {
      if (trimmed === '') {
        flushBlock();
        out.push(raw);
      } else {
        const res = evalCalcExpr(trimmed, scope);
        block.push({ text: trimmed, formatted: res.formatted ?? null, error: res.error ?? null });
      }
    }
  }

  flushBlock(); // handle block that runs to EOF
  return out.join('\n');
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
