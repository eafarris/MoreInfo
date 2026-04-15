import { describe, it, expect } from 'vitest';
import { EditorState, EditorSelection } from '@codemirror/state';
import { getSpecialBlockType } from '../editor.js';

// Build an EditorState with the given text and cursor placed at the end of
// the specified 1-based line number.
function stateAt(text, lineNumber) {
  const state = EditorState.create({ doc: text });
  const line  = state.doc.line(lineNumber);
  return state.update({
    selection: EditorSelection.cursor(line.to),
  }).state;
}

// ── getSpecialBlockType ────────────────────────────────────────────────────

describe('getSpecialBlockType', () => {
  it('returns "calc" when cursor is on an expression line inside @calc', () => {
    const text = '@calc\n100\n- 30\n+ 5';
    expect(getSpecialBlockType(stateAt(text, 3))).toBe('calc'); // "- 30"
    expect(getSpecialBlockType(stateAt(text, 4))).toBe('calc'); // "+ 5"
  });

  it('returns "calc" on the first expression line immediately after @calc', () => {
    const text = '@calc\n100';
    expect(getSpecialBlockType(stateAt(text, 2))).toBe('calc');
  });

  it('returns "calc" when cursor is on the @calc header line itself', () => {
    // The header line matches the SPECIAL_BLOCKS key, so the function returns
    // 'calc' here too.  This is harmless: markdown never adds continuation
    // markers to an "@calc" line, so Enter behaviour is identical either way.
    const text = '@calc\n100';
    expect(getSpecialBlockType(stateAt(text, 1))).toBe('calc');
  });

  it('returns null when there is no @calc block anywhere above', () => {
    const text = 'just some text\n- not a calc line';
    expect(getSpecialBlockType(stateAt(text, 2))).toBeNull();
  });

  it('returns null when a blank line separates the cursor from @calc', () => {
    const text = '@calc\n100\n\n- this is outside the block';
    expect(getSpecialBlockType(stateAt(text, 4))).toBeNull();
  });

  it('returns null for text before the first @calc block', () => {
    const text = 'preamble\n\n@calc\n100';
    expect(getSpecialBlockType(stateAt(text, 1))).toBeNull();
  });

  it('handles multiple independent @calc blocks correctly', () => {
    const text = '@calc\n50\n\n@calc\n200\n+ 8';
    // cursor in second block
    expect(getSpecialBlockType(stateAt(text, 6))).toBe('calc');
    // cursor in gap between blocks
    expect(getSpecialBlockType(stateAt(text, 3))).toBeNull();
  });

  it('returns null when cursor is at the very start of an empty document', () => {
    const state = EditorState.create({ doc: '' });
    expect(getSpecialBlockType(state)).toBeNull();
  });

  it('operator lines starting with - + * are still detected inside @calc', () => {
    const lines = ['@calc', '100', '- 30', '+ 5', '* 2'];
    const text  = lines.join('\n');
    expect(getSpecialBlockType(stateAt(text, 3))).toBe('calc'); // "- 30"
    expect(getSpecialBlockType(stateAt(text, 4))).toBe('calc'); // "+ 5"
    expect(getSpecialBlockType(stateAt(text, 5))).toBe('calc'); // "* 2"
  });

  it('> and / lines inside @calc are detected (blockquote / division)', () => {
    const text = '@calc\n100\n> 50\n/ 4';
    expect(getSpecialBlockType(stateAt(text, 3))).toBe('calc');
    expect(getSpecialBlockType(stateAt(text, 4))).toBe('calc');
  });
});
