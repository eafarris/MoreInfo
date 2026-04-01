# Task Management

Tasks in MoreInfo are plain-text items that can appear anywhere in a page — scattered through journal entries, embedded in project notes, or grouped under headings. The goal is low friction: a bare checkbox is a valid task, and every additional attribute is optional.

---

## Task syntax

A task is any line that begins with a checkbox marker, optionally preceded by a list marker:

```text
[ ] Buy milk
[] Buy milk
- [ ] Buy milk
```

All three forms are equivalent. The checkbox renders as a clickable UI element in both the editor and the preview pane. Checking a box marks the task done.

---

## Attributes

Attributes appear after the task text, in any order. There is no required field ordering.

### Priority

A parenthesised integer ranks the task.

```text
[ ] Send proposal  (1)
[ ] Archive old files  (3)
```

Lower numbers are higher priority. Unprioritised tasks are treated as lowest priority.

### Context

A bare `@word` tag (no parentheses) marks the GTD-style context in which the task should be done.

```text
[ ] Call the client  @phone
[ ] Pick up dry cleaning  @errands
[ ] Draft the intro section  @computer
```

A context tag is a plain label — it does not reference any page. Tasks can be filtered by context in the TasksWidget.

### Page references

Associating a task with a MoreInfo page (a project, person, meeting, etc.) is done with a standard wiki link on the task line. The backlink system takes care of the rest: the task appears automatically in the References widget of the linked page.

```text
[ ] Send proposal draft  (1)  @email  [[Anderson Contract]]  @due(friday)
[ ] Follow up with client  @phone  [[Jane Smith]]  [[Anderson Contract]]
[ ] Book conference room  [[Q1 Planning]]  @due(monday)
```

**CamelCase shorthand**: a CamelCase word that resolves to an existing page title is treated as a wiki link. This keeps task lines compact.

```text
[ ] Send proposal draft  (1)  @email  AndersonContract  @due(friday)
[ ] Follow up  @phone  JaneSmith  AndersonContract
```

`AndersonContract` is resolved by splitting on case boundaries: `Anderson Contract`. If no page with that title exists, the word renders as plain text — CamelCase **never creates a page**. Page creation requires the explicit `[[bracket]]` form.

### Parameter tags

Reserved tags carry a value in parentheses.

| Tag | Meaning |
| --- | --- |
| `@due(date)` | Due date; parsed by chrono-node, so natural language works: `@due(friday)`, `@due(2026-04-01)`, `@due(next month)` |
| `@priority(n)` | Alternate priority form; equivalent to `(n)` |
| `@defer(date)` | Hide the task until this date |

The full list of reserved tag names (never treated as page category references): `due`, `priority`, `done`, `cancelled`, `waiting`, `defer`, `repeat`.

---

## Task states

| State | How to set |
| --- | --- |
| Open | Default — unchecked box |
| Done | Check the box, or add `@done` |
| Waiting | `@waiting` — blocked on someone or something else |
| Someday | `@someday` — not actionable now, not forgotten |
| Deferred | `@defer(date)` — snoozed until a date |

---

## Implicit context

A task inherits context from its location with zero markup required.

**From page**: a task written on a wiki page implicitly belongs to that page. No `[[link]]` needed.

**From heading**: a task written under a Markdown heading inherits that heading as its project context. If a page exists with that title, the task is treated as referencing it.

```markdown
## Anderson Contract

[ ] Send proposal draft  (1)  @email  @due(friday)
[ ] Follow up with client  @phone
```

Both tasks above are implicitly associated with `Anderson Contract` without any explicit link. An explicit `[[Anderson Contract]]` or `AndersonContract` on the task line overrides or supplements this.

Explicit attributes always take precedence over implicit context.

---

## Tasks widget

The Tasks widget shows all open tasks across the datastore, with a filter UI at the top. Filters can narrow by:

- Context (`@phone`, `@errands`, …)
- Page / project (`[[Anderson Contract]]`)
- Due date (overdue, due today, due this week)
- State (open, waiting, someday)
- Priority

Tasks from journal pages and wiki pages are both included. Template pages are excluded.

---

## Minimum valid task

```text
[ ] Buy milk
```

No attributes required. Every attribute is additive.

---
Other features

Annotations vs. Tasks
: Inline markers like TODO, FIXME, NOTE, and IDEA are **annotations** — not tasks. They are highlighted and indexed but carry no completion state, checkbox, or deadline. An annotation captures a thought in passing; a task is an explicit commitment to act. Promote an annotation to a task manually by adding a `[ ]` checkbox.

TaskWidget
: Exposes all incomplete tasks across the datastore. Filter UI planned for context, page/project, due date, state, and priority. Tasks from journal and wiki pages are included; templates are excluded.
