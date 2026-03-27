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
 */

import { evaluate as mathEval, format as mathFormat, typeOf } from 'mathjs';

// Matches a leading binary operator at the start of a trimmed expression.
// ** must be tested before * so two-character tokens aren't split.
const LEADING_BINOP = /^(\*\*|[-+*/%^])/;

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

  // Implicit prepend: if expression starts with a binary operator OR a unit
  // conversion keyword ("in km", "to miles"), prepend _last so math.js
  // receives a complete expression ("_last in km", "_last + 5 miles", etc.).
  if (LEADING_BINOP.test(e) || /^(in|to)\s+/i.test(e)) e = `_last ${e}`;

  try {
    const result = mathEval(e, scope);
    const t = typeOf(result);
    if (t !== 'number' && t !== 'Unit') return { error: 'Error' };
    scope._last = result;
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
        scope   = { _last: 0 };
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
        scope = { _last: 0 };
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
