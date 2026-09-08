import { describe, it, expect } from 'vitest';
import { parseTaskQuery, applyTaskFilter } from '../taskFilter.js';

function task(overrides = {}) {
  return {
    path: '/Users/eafarris/MoreInfo/wiki/euikit.md',
    title: 'Euikit',
    text: 'Fix the toolbar spacing',
    implicit_heading: '',
    due_date: '',
    defer_until: '',
    first_seen: '2026-08-01',
    priority: 10,
    ...overrides,
  };
}

describe('applyTaskFilter', () => {
  it('matches a term found only in the page title', () => {
    const tasks = [task()];
    expect(applyTaskFilter(tasks, parseTaskQuery('euikit'))).toHaveLength(1);
    expect(applyTaskFilter(tasks, parseTaskQuery('nomatch'))).toHaveLength(0);
  });

  it('matches a journal date found only in the filename', () => {
    const tasks = [task({
      path: '/Users/eafarris/MoreInfo/journal/2026-09-04.md',
      title: '2026-09-04',
      text: 'Call the vendor',
    })];
    expect(applyTaskFilter(tasks, parseTaskQuery('2026-09-04'))).toHaveLength(1);
  });

  it('matches a term found only in the implicit heading', () => {
    const tasks = [task({ implicit_heading: 'Backlog' })];
    expect(applyTaskFilter(tasks, parseTaskQuery('backlog'))).toHaveLength(1);
  });

  it('matches a term found only in due_date or defer_until', () => {
    const tasks = [task({ due_date: 'next friday' }), task({ defer_until: 'tomorrow' })];
    expect(applyTaskFilter(tasks, parseTaskQuery('friday'))).toHaveLength(1);
    expect(applyTaskFilter(tasks, parseTaskQuery('tomorrow'))).toHaveLength(1);
  });

  it('still matches plain text within the task line itself', () => {
    const tasks = [task()];
    expect(applyTaskFilter(tasks, parseTaskQuery('toolbar'))).toHaveLength(1);
  });

  it('ANDs multiple terms across different fields', () => {
    const tasks = [task({ implicit_heading: 'Backlog' })];
    expect(applyTaskFilter(tasks, parseTaskQuery('euikit backlog toolbar'))).toHaveLength(1);
    expect(applyTaskFilter(tasks, parseTaskQuery('euikit backlog missing'))).toHaveLength(0);
  });

  it('keeps @context matching scoped to the task text, not the title/path', () => {
    const tasks = [task({ title: '@home', text: 'Call the vendor @phone' })];
    // A page literally titled "@home" should not satisfy a @home context filter.
    expect(applyTaskFilter(tasks, parseTaskQuery('@home'))).toHaveLength(0);
    expect(applyTaskFilter(tasks, parseTaskQuery('@phone'))).toHaveLength(1);
  });
});
