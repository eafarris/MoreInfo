import { describe, it, expect, beforeEach } from 'vitest';
import { evalCalcExpr, scanCalcBlocks, normalizeUnicodeMath } from '../calcBlock.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function freshScope() {
  return { _last: 0, _lastDate: null, _lastCurrency: null, _lastDuration: null };
}

// ── evalCalcExpr — date diff "in <unit>" conversion ───────────────────────
// After DATE - DATE produces a duration, "in days" / "in weeks" / etc. should
// convert that duration to a plain number rather than erroring.

describe('evalCalcExpr – date diff unit conversions', () => {
  it('"in days" after a date diff gives total days', () => {
    const scope = freshScope();
    evalCalcExpr('2026-06-08 - 2026-06-01', scope);   // 7-day diff
    const r = evalCalcExpr('in days', scope);
    expect(r.error).toBeUndefined();
    expect(Number(r.formatted?.replace(/,/g, ''))).toBe(7);
    expect(scope._last).toBe(7);
  });

  it('"to days" is an alias for "in days"', () => {
    const scope = freshScope();
    evalCalcExpr('2026-06-08 - 2026-06-01', scope);
    const r = evalCalcExpr('to days', scope);
    expect(r.error).toBeUndefined();
    expect(Number(r.formatted?.replace(/,/g, ''))).toBe(7);
  });

  it('"in weeks" after a 7-day diff gives 1', () => {
    const scope = freshScope();
    evalCalcExpr('2026-06-08 - 2026-06-01', scope);
    const r = evalCalcExpr('in weeks', scope);
    expect(r.error).toBeUndefined();
    expect(Number(r.formatted?.replace(/,/g, ''))).toBe(1);
  });

  it('multiple successive conversions all work from the same duration', () => {
    const scope = freshScope();
    evalCalcExpr('2026-06-15 - 2026-06-01', scope);  // 14-day diff
    const days  = evalCalcExpr('in days',  scope);
    const weeks = evalCalcExpr('in weeks', scope);
    expect(Number(days.formatted?.replace(/,/g, ''))).toBe(14);
    expect(Number(weeks.formatted?.replace(/,/g, ''))).toBe(2);
  });

  it('_lastDuration is cleared after a plain arithmetic result', () => {
    const scope = freshScope();
    evalCalcExpr('2026-06-08 - 2026-06-01', scope);   // sets _lastDuration
    evalCalcExpr('in days', scope);                    // _last = 7, _lastDuration still set
    evalCalcExpr('+ 7', scope);                        // math: _last = 14, clears _lastDuration
    expect(scope._lastDuration).toBeNull();
    const r = evalCalcExpr('in weeks', scope);         // now fails — no duration, _last=14 dimensionless
    expect(r.error).toBeTruthy();
  });

  it('"in days" on a date diff of 86 days', () => {
    const scope = freshScope();
    evalCalcExpr('2026-08-26 - 2026-06-01', scope);
    const r = evalCalcExpr('in days', scope);
    expect(r.error).toBeUndefined();
    expect(Number(r.formatted?.replace(/,/g, ''))).toBe(86);
  });
});

// ── evalCalcExpr — list-delimiter operators ────────────────────────────────
// Regression: lines starting with -, +, or * are valid binary operators in
// @calc blocks (implicit-prepend rule: they are prepended with _last).
// The CodeMirror markdown extension treats these as list-item markers and would
// copy the marker to the next line on Enter.  The fix is addKeymap:false on
// markdown() plus a calc-aware Enter command.  These unit tests
// verify that the *evaluation* side correctly handles all three operators so
// the same regression cannot silently reappear in calcBlock.js.

describe('evalCalcExpr – list-delimiter operators as binary ops', () => {
  it('- N is subtracted from _last', () => {
    const scope = { ...freshScope(), _last: 10 };
    const result = evalCalcExpr('- 3', scope);
    expect(result.formatted).toBe('7');
    expect(scope._last).toBe(7);
  });

  it('+ N is added to _last', () => {
    const scope = { ...freshScope(), _last: 10 };
    const result = evalCalcExpr('+ 4', scope);
    expect(result.formatted).toBe('14');
    expect(scope._last).toBe(14);
  });

  it('* N multiplies _last', () => {
    const scope = { ...freshScope(), _last: 5 };
    const result = evalCalcExpr('* 3', scope);
    expect(result.formatted).toBe('15');
    expect(scope._last).toBe(15);
  });

  it('- with no space still works', () => {
    const scope = { ...freshScope(), _last: 20 };
    const result = evalCalcExpr('-5', scope);
    expect(result.formatted).toBe('15');
  });

  it('+ with no space still works', () => {
    const scope = { ...freshScope(), _last: 20 };
    const result = evalCalcExpr('+5', scope);
    expect(result.formatted).toBe('25');
  });

  it('* with no space still works', () => {
    const scope = { ...freshScope(), _last: 4 };
    const result = evalCalcExpr('*3', scope);
    expect(result.formatted).toBe('12');
  });

  it('carries _last forward through a chain of list-delimiter ops', () => {
    const scope = freshScope();
    evalCalcExpr('100', scope);    // _last = 100
    evalCalcExpr('- 30', scope);   // _last = 70
    evalCalcExpr('+ 5', scope);    // _last = 75
    const r = evalCalcExpr('* 2', scope);  // _last = 150
    expect(r.formatted).toBe('150');
    expect(scope._last).toBe(150);
  });
});

// ── scanCalcBlocks — list-delimiter operators ──────────────────────────────

describe('scanCalcBlocks – list-delimiter operators', () => {
  it('evaluates a block containing -, +, * operator lines', () => {
    const text = [
      '@calc',
      '100',
      '- 30',
      '+ 5',
      '* 2',
    ].join('\n');

    const { results, headerLines } = scanCalcBlocks(text);

    expect(headerLines.has(1)).toBe(true);
    expect(results.get(2)?.formatted).toBe('100');
    expect(results.get(3)?.formatted).toBe('70');   // 100 - 30
    expect(results.get(4)?.formatted).toBe('75');   // 70 + 5
    expect(results.get(5)?.formatted).toBe('150');  // 75 * 2
  });

  it('does not produce results for the @calc header line', () => {
    const text = '@calc\n10\n+ 5';
    const { results } = scanCalcBlocks(text);
    expect(results.has(1)).toBe(false); // header line — no result
    expect(results.has(2)).toBe(true);
    expect(results.has(3)).toBe(true);
  });

  it('a blank line terminates the block; operators after it are not evaluated', () => {
    const text = [
      '@calc',
      '10',
      '',           // block ends here
      '- 5',        // regular markdown — NOT a calc expression
    ].join('\n');

    const { results } = scanCalcBlocks(text);
    expect(results.has(4)).toBe(false);
  });

  it('multiple blocks with list-delimiter ops are independent', () => {
    const text = [
      '@calc',
      '50',
      '- 10',
      '',
      '@calc',
      '200',
      '+ 8',
    ].join('\n');

    const { results } = scanCalcBlocks(text);
    expect(results.get(2)?.formatted).toBe('50');
    expect(results.get(3)?.formatted).toBe('40');   // 50 - 10, first block
    expect(results.get(6)?.formatted).toBe('200');
    expect(results.get(7)?.formatted).toBe('208');  // 200 + 8, second block (fresh _last)
  });
});

// ── normalizeUnicodeMath ───────────────────────────────────────────────────

describe('normalizeUnicodeMath – operator substitution', () => {
  it('replaces × with *', () => {
    expect(normalizeUnicodeMath('3 × 4')).toBe('3 * 4');
  });

  it('replaces ÷ with /', () => {
    expect(normalizeUnicodeMath('10 ÷ 2')).toBe('10 / 2');
  });

  it('replaces Unicode minus sign − with ASCII -', () => {
    expect(normalizeUnicodeMath('10 − 3')).toBe('10 - 3');
  });

  it('replaces middle dot · with *', () => {
    expect(normalizeUnicodeMath('5 · 6')).toBe('5 * 6');
  });

  it('replaces π with pi', () => {
    expect(normalizeUnicodeMath('2 * π')).toBe('2 * pi');
  });

  it('replaces ∞ with Infinity', () => {
    expect(normalizeUnicodeMath('∞')).toBe('Infinity');
  });

  it('replaces ≤ with <=', () => {
    expect(normalizeUnicodeMath('x ≤ 5')).toBe('x <= 5');
  });

  it('replaces ≥ with >=', () => {
    expect(normalizeUnicodeMath('x ≥ 5')).toBe('x >= 5');
  });

  it('replaces ≠ with !=', () => {
    expect(normalizeUnicodeMath('x ≠ 0')).toBe('x != 0');
  });
});

describe('normalizeUnicodeMath – superscript exponents', () => {
  it('² becomes ^2', () => {
    expect(normalizeUnicodeMath('x²')).toBe('x^2');
  });

  it('³ becomes ^3', () => {
    expect(normalizeUnicodeMath('x³')).toBe('x^3');
  });

  it('⁰ becomes ^0', () => {
    expect(normalizeUnicodeMath('x⁰')).toBe('x^0');
  });

  it('consecutive superscripts form a multi-digit exponent', () => {
    expect(normalizeUnicodeMath('x²³')).toBe('x^23');
  });

  it('handles all digits ⁰–⁹', () => {
    expect(normalizeUnicodeMath('x⁰¹²³⁴⁵⁶⁷⁸⁹')).toBe('x^0123456789');
  });
});

describe('normalizeUnicodeMath – mixed expressions', () => {
  it('handles × and ÷ together', () => {
    expect(normalizeUnicodeMath('6 × 4 ÷ 2')).toBe('6 * 4 / 2');
  });

  it('handles superscript in a full expression', () => {
    expect(normalizeUnicodeMath('3² + 4²')).toBe('3^2 + 4^2');
  });

  it('leaves plain ASCII expressions unchanged', () => {
    expect(normalizeUnicodeMath('3 * 4 + 1')).toBe('3 * 4 + 1');
  });
});

describe('evalCalcExpr – Unicode operators evaluate correctly', () => {
  it('3 × 4 evaluates to 12', () => {
    const r = evalCalcExpr('3 × 4', freshScope());
    expect(r.error).toBeUndefined();
    expect(r.formatted).toBe('12');
  });

  it('10 ÷ 2 evaluates to 5', () => {
    const r = evalCalcExpr('10 ÷ 2', freshScope());
    expect(r.error).toBeUndefined();
    expect(r.formatted).toBe('5');
  });

  it('100 − 37 evaluates to 63', () => {
    // Uses values that cannot be parsed as a date by chrono-node.
    const r = evalCalcExpr('100 − 37', freshScope());
    expect(r.error).toBeUndefined();
    expect(r.formatted).toBe('63');
  });

  it('3² evaluates to 9', () => {
    const r = evalCalcExpr('3²', freshScope());
    expect(r.error).toBeUndefined();
    expect(r.formatted).toBe('9');
  });

  it('2³ evaluates to 8', () => {
    const r = evalCalcExpr('2³', freshScope());
    expect(r.error).toBeUndefined();
    expect(r.formatted).toBe('8');
  });

  it('3² + 4² evaluates to 25', () => {
    const r = evalCalcExpr('3² + 4²', freshScope());
    expect(r.error).toBeUndefined();
    expect(r.formatted).toBe('25');
  });
});

// ── calcCopyHandler logic – last-line without trailing blank ─────────────────
// Extracted copy logic (mirrors calcCopyHandler in editor.js) so it can be
// exercised without a real EditorView / DOM clipboard event.

import { EditorState } from '@codemirror/state';

function simulateCopy(docText, rangeFrom, rangeTo) {
  const state = EditorState.create({ doc: docText });
  const doc   = state.doc;
  const { results } = scanCalcBlocks(docText);
  if (!results.size) return null;

  let lineTo = doc.lineAt(Math.min(rangeTo, doc.length)).number;
  if (rangeTo >= doc.length) lineTo++;

  const lineFrom   = doc.lineAt(rangeFrom).number;
  const lineTexts  = [];
  for (let ln = lineFrom; ln <= Math.min(lineTo, doc.lines); ln++) {
    const line   = doc.line(ln);
    const slFrom = ln === lineFrom ? rangeFrom : line.from;
    const slTo   = ln === lineTo   ? rangeTo   : line.to;
    let t = doc.sliceString(slFrom, Math.min(slTo, doc.length));
    const res = results.get(ln);
    if (res && !res.error && res.formatted && slTo >= line.to) {
      t = t.trimEnd() + '  = ' + res.formatted;
    }
    lineTexts.push(t);
  }
  return lineTexts.join('\n');
}

describe('calcCopyHandler – final expression without trailing blank line', () => {
  const doc = '@calc\n5 + 3';

  it('appends result when full selection reaches doc end', () => {
    const output = simulateCopy(doc, 0, doc.length);
    expect(output).toContain('= 8');
    expect(output).toBe('@calc\n5 + 3  = 8');
  });

  it('appends result when selecting just the expression line to doc end', () => {
    const from = EditorState.create({ doc }).doc.line(2).from;
    const output = simulateCopy(doc, from, doc.length);
    expect(output).toBe('5 + 3  = 8');
  });

  it('does NOT append result when selection stops short of line end', () => {
    const from = EditorState.create({ doc }).doc.line(2).from;
    const output = simulateCopy(doc, from, from + 3); // selects "5 +"
    expect(output).not.toContain('= 8');
  });

  it('appends result equivalently with a trailing blank line', () => {
    const docWithBlank = '@calc\n5 + 3\n';
    const outNoBlank   = simulateCopy(doc,          0, doc.length);
    const outBlank     = simulateCopy(docWithBlank, 0, docWithBlank.length);
    // Both should include the result; only differ by trailing newline.
    expect(outNoBlank).toContain('= 8');
    expect(outBlank).toContain('= 8');
  });
});
