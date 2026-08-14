import { describe, it, expect } from 'vitest';
import { popBack, popForward } from '../navHistory.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function page(path) {
  return { path, title: path.replace(/\.md$/, '') };
}

// ── popBack ──────────────────────────────────────────────────────────────

describe('popBack', () => {
  it('pops the most recent back entry and pushes current onto forward', () => {
    const back    = [page('a.md'), page('b.md')];
    const forward = [];
    const current = page('c.md');

    const entry = popBack(back, forward, current);

    expect(entry).toEqual(page('b.md'));
    expect(back).toEqual([page('a.md')]);
    expect(forward).toEqual([page('c.md')]);
  });

  it('going back with an empty back stack is a no-op (edge case: too far back)', () => {
    const back    = [];
    const forward = [page('x.md')];
    const current = page('c.md');

    const entry = popBack(back, forward, current);

    expect(entry).toBeNull();
    expect(back).toEqual([]);
    expect(forward).toEqual([page('x.md')]); // untouched
  });

  it('does not push a null current onto the forward stack', () => {
    const back    = [page('a.md')];
    const forward = [];

    const entry = popBack(back, forward, null);

    expect(entry).toEqual(page('a.md'));
    expect(forward).toEqual([]);
  });

  it('repeatedly going back eventually empties the stack without throwing', () => {
    const back    = [page('a.md'), page('b.md')];
    const forward = [];
    let current   = page('c.md');

    current = popBack(back, forward, current);
    current = popBack(back, forward, current);
    expect(current).toEqual(page('a.md'));
    expect(back).toEqual([]);

    // One more step past the start — no-op, no throw, no undefined leaking through.
    const result = popBack(back, forward, current);
    expect(result).toBeNull();
    expect(back).toEqual([]);
  });
});

// ── popForward ───────────────────────────────────────────────────────────

describe('popForward', () => {
  it('pops the most recent forward entry and pushes current onto back', () => {
    const back    = [];
    const forward = [page('y.md'), page('z.md')];
    const current = page('c.md');

    const entry = popForward(back, forward, current);

    expect(entry).toEqual(page('z.md'));
    expect(forward).toEqual([page('y.md')]);
    expect(back).toEqual([page('c.md')]);
  });

  it('going forward with an empty forward stack is a no-op (edge case: too far forward)', () => {
    const back    = [page('x.md')];
    const forward = [];
    const current = page('c.md');

    const entry = popForward(back, forward, current);

    expect(entry).toBeNull();
    expect(forward).toEqual([]);
    expect(back).toEqual([page('x.md')]); // untouched
  });

  it('does not push a null current onto the back stack', () => {
    const back    = [];
    const forward = [page('z.md')];

    const entry = popForward(back, forward, null);

    expect(entry).toEqual(page('z.md'));
    expect(back).toEqual([]);
  });

  it('repeatedly going forward eventually empties the stack without throwing', () => {
    const back    = [];
    const forward = [page('y.md'), page('z.md')];
    let current   = page('c.md');

    current = popForward(back, forward, current);
    current = popForward(back, forward, current);
    expect(current).toEqual(page('y.md'));
    expect(forward).toEqual([]);

    // One more step past the end — no-op, no throw, no undefined leaking through.
    const result = popForward(back, forward, current);
    expect(result).toBeNull();
    expect(forward).toEqual([]);
  });
});

// ── round trip ───────────────────────────────────────────────────────────

describe('popBack / popForward round trip', () => {
  it('back then forward returns to the same page and restores both stacks', () => {
    const back    = [page('a.md'), page('b.md')];
    const forward = [];
    const current = page('c.md');

    const backEntry = popBack(back, forward, current);
    expect(backEntry).toEqual(page('b.md'));

    const forwardEntry = popForward(back, forward, backEntry);
    expect(forwardEntry).toEqual(current);

    expect(back).toEqual([page('a.md'), page('b.md')]);
    expect(forward).toEqual([]);
  });

  it('navigating back then to a new page clears forward (mirrors navigateTo behavior)', () => {
    // This models what main.js's navigateTo() does: it clears navFuture
    // whenever the user visits a page directly rather than via back/forward.
    const back    = [page('a.md')];
    const forward = [];
    let current   = page('b.md');

    current = popBack(back, forward, current);   // now viewing a.md, b.md sits in forward
    expect(forward).toEqual([page('b.md')]);

    // Simulate navigateTo('new.md'): push current (a.md, from the back()
    // above), then discard forward — same as main.js's navigateTo().
    back.push(current);
    forward.length = 0;

    expect(back).toEqual([page('a.md')]);
    expect(forward).toEqual([]);

    // Forward is gone — going forward now is a no-op.
    const entry = popForward(back, forward, page('new.md'));
    expect(entry).toBeNull();
  });
});
