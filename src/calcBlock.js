/**
 * @calc block — expression evaluator, formatter, and preview pre-processor.
 *
 * A @calc block starts with a line containing exactly "@calc" and continues
 * until a blank line or end of document. Each non-blank line is treated as an
 * arithmetic expression whose result becomes the implicit left operand for
 * the next line — but only when the next line begins with a binary operator.
 *
 * Implicit-prepend rule:
 *   If an expression starts with a binary operator (+  -  *  /  %  **  ^),
 *   the previous result is silently prepended as the left operand.
 *     "+23"   →  (last)+23      (add 23 to previous result)
 *     "* 1.1" →  (last)*1.1    (mark up by 10 %)
 *     "32^2"  →  32**2         (standalone — no prepend)
 *   "-" at the start is treated as binary (subtract from last), never unary.
 *
 * Supported syntax:
 *   Basic operators:  + - * / % ** (also ^ as alias for **)
 *   Grouping:         ( )
 *   Constants:        pi
 *   Functions:        sqrt abs round floor ceil min max log sin cos tan
 */

// Matches a leading binary operator at the start of a trimmed expression.
// ** must be tested before * so two-character tokens aren't split.
const LEADING_BINOP = /^(\*\*|[-+*/%^])/;

// ── Expression evaluator ──────────────────────────────────────────────────

/**
 * Evaluate a single arithmetic expression string.
 *
 * @param {string} expr  Raw text of the expression line.
 * @param {number} last  Result of the previous expression (default 0).
 * @returns {{ value: number } | { error: string } | { value: null }}
 */
export function evalCalcExpr(expr, last = 0) {
  const trimmed = expr.trim();
  if (!trimmed) return { value: null };

  // Reject characters with no place in arithmetic that could enable JS injection.
  if (/[{}"'`;=><!\[\]&|\\@]/.test(trimmed)) return { error: 'Invalid expression' };

  // If the expression starts with a binary operator, prepend the last result
  // as the implicit left operand.
  let e = LEADING_BINOP.test(trimmed) ? `(${last})${trimmed}` : trimmed;

  // Operator aliases and math-function expansions.
  e = e
    .replace(/\^/g,        '**')          // ^ → ** (power alias)
    .replace(/\bsqrt\b/g,  'Math.sqrt')
    .replace(/\babs\b/g,   'Math.abs')
    .replace(/\bround\b/g, 'Math.round')
    .replace(/\bfloor\b/g, 'Math.floor')
    .replace(/\bceil\b/g,  'Math.ceil')
    .replace(/\bmin\b/g,   'Math.min')
    .replace(/\bmax\b/g,   'Math.max')
    .replace(/\blog\b/g,   'Math.log')
    .replace(/\bsin\b/g,   'Math.sin')
    .replace(/\bcos\b/g,   'Math.cos')
    .replace(/\btan\b/g,   'Math.tan')
    .replace(/\bpi\b/gi,   'Math.PI');

  try {
    // eslint-disable-next-line no-new-func
    const result = new Function('"use strict"; return (' + e + ')')();
    if (typeof result !== 'number' || isNaN(result)) return { error: 'NaN' };
    if (!isFinite(result)) return { error: result > 0 ? '∞' : '-∞' };
    return { value: result };
  } catch {
    return { error: 'Error' };
  }
}

// ── Number formatter ──────────────────────────────────────────────────────

/**
 * Format a numeric result for display.
 * Integers use locale-aware thousands separators. Floats are shown up to 6
 * significant digits with trailing zeros stripped.
 * @param {number} value
 * @returns {string}
 */
export function formatCalcResult(value) {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return value.toLocaleString();
  const stripped = parseFloat(value.toPrecision(6));
  return stripped.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

// ── Block scanner (used by the CM6 plugin) ────────────────────────────────

/**
 * Scan a plain-text document and return a map from 1-based line number to its
 * calculation result.  Also returns the set of @calc header line numbers.
 *
 * @param {string} text  Full document text.
 * @returns {{
 *   results:     Map<number, { value: number|null, error: string|null }>,
 *   headerLines: Set<number>
 * }}
 */
export function scanCalcBlocks(text) {
  const results     = new Map();
  const headerLines = new Set();
  const docLines    = text.split('\n');

  let inBlock = false;
  let last    = 0;

  for (let i = 0; i < docLines.length; i++) {
    const lineNo  = i + 1;
    const trimmed = docLines[i].trim();

    if (!inBlock) {
      if (trimmed === '@calc') {
        inBlock = true;
        last    = 0;
        headerLines.add(lineNo);
      }
    } else {
      if (trimmed === '') {
        inBlock = false;
      } else {
        const res = evalCalcExpr(trimmed, last);
        if (res.value != null) last = res.value;
        results.set(lineNo, {
          value: res.value  ?? null,
          error: res.error  ?? null,
        });
      }
    }
  }

  return { results, headerLines };
}

// ── Preview pre-processor ─────────────────────────────────────────────────

/**
 * Replace @calc blocks in a markdown string with equivalent HTML that renders
 * correctly in the preview pane.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function preprocessCalcBlocks(markdown) {
  const lines = markdown.split('\n');
  const out   = [];
  let block   = null;  // null | Array<{text, value, error}>
  let last    = 0;

  const flushBlock = () => {
    if (!block || block.length === 0) { block = null; return; }
    // Use a table so the result column auto-aligns flush-right across all rows
    // without needing to know the widest expression ahead of time.
    out.push('<table class="mi-calc-block"><tbody>');
    for (const row of block) {
      const res = row.error != null
        ? `<td class="mi-calc-result mi-calc-error">${esc(row.error)}</td>`
        : `<td class="mi-calc-result">= ${esc(formatCalcResult(row.value))}</td>`;
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
        last  = 0;
      } else {
        out.push(raw);
      }
    } else {
      if (trimmed === '') {
        flushBlock();
        out.push(raw);
      } else {
        const res = evalCalcExpr(trimmed, last);
        if (res.value != null) last = res.value;
        block.push({ text: trimmed, value: res.value ?? null, error: res.error ?? null });
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
