import { computeEffectivePriority } from './dateUtils.js';

// Matches @priority(N) or (N) as a priority filter token.
const PRI_TOKEN_RE = /^@priority\((\d+)\)$|^\((\d+)\)$/i;

/**
 * Parse a free-text task query into structured filter components.
 *
 *   @context    → must contain bare @context tag (AND, word-boundary)
 *   @priority(N)
 *   (N)         → effective priority must equal N (OR across multiple)
 *   other words → full-text match against task text (AND)
 *
 * @param {string} query
 * @returns {{ priorities: number[], contexts: string[], terms: string[] }}
 */
export function parseTaskQuery(query) {
  const priorities = [];
  const contexts   = [];
  const terms      = [];
  for (const token of query.trim().toLowerCase().split(/\s+/)) {
    if (!token) continue;
    const pm = PRI_TOKEN_RE.exec(token);
    if (pm) {
      priorities.push(parseInt(pm[1] ?? pm[2], 10));
    } else if (token.startsWith('@')) {
      const c = token.slice(1);
      if (c) contexts.push(c);
    } else {
      terms.push(token);
    }
  }
  return { priorities, contexts, terms };
}

/**
 * Build the plain-text search surface for a task: its own text plus everything
 * that identifies where it lives (page title, filename, heading, due/defer
 * dates, first-seen date) — so a term like a journal date or a page title
 * matches even though it never appears in the task line itself.
 *
 * @param {Object} t Raw task object from list_tasks
 * @returns {string} lowercased haystack
 */
function taskHaystack(t) {
  const base = t.path.split(/[\\/]/).pop().replace(/\.md$/i, '');
  return [t.text, t.title, base, t.implicit_heading, t.due_date, t.defer_until, t.first_seen]
    .filter(Boolean)
    .join(' \n ')
    .toLowerCase();
}

/**
 * Apply a parsed query to a task list.
 *
 * Priority is matched against the computed effective priority (the badge value).
 * Multiple priority tokens are OR'd; contexts and terms are AND'd. Contexts
 * (bare @word tokens) only match within the task's own text, since that's
 * where @context tags actually live; plain terms match anywhere in the
 * broader task haystack (see taskHaystack).
 *
 * @param {Array}  tasks   Raw task objects from list_tasks
 * @param {{ priorities: number[], contexts: string[], terms: string[] }} parsed
 * @returns {Array}
 */
export function applyTaskFilter(tasks, { priorities, contexts, terms }) {
  if (!priorities.length && !contexts.length && !terms.length) return tasks;
  return tasks.filter(t => {
    if (priorities.length) {
      const ep = computeEffectivePriority(t.priority ?? 10, t.due_date, t.first_seen);
      if (!priorities.includes(ep)) return false;
    }
    if (contexts.length) {
      const text = t.text.toLowerCase();
      for (const ctx of contexts) {
        if (!new RegExp(`@${ctx}(?![a-zA-Z0-9_-])`).test(text)) return false;
      }
    }
    if (terms.length) {
      const haystack = taskHaystack(t);
      for (const term of terms) {
        if (!haystack.includes(term)) return false;
      }
    }
    return true;
  });
}
