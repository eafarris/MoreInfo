import {
  EditorState,
  Compartment,
} from '@codemirror/state';
import {
  EditorView,
  ViewPlugin,
  Decoration,
  WidgetType,
  keymap,
  drawSelection,
  highlightActiveLine,
} from '@codemirror/view';
import {
  history,
  defaultKeymap,
  historyKeymap,
} from '@codemirror/commands';
import {
  syntaxHighlighting,
  HighlightStyle,
  indentOnInput,
  bracketMatching,
  syntaxTree,
} from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { autocompletion, acceptCompletion } from '@codemirror/autocomplete';
import { tags } from '@lezer/highlight';
import { scanCalcBlocks } from './calcBlock.js';

// ── Theme ──────────────────────────────────────────────────────────────────
// Matches the olive/amber palette used throughout the app.

export const miTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    fontSize: '0.875rem',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-family-mono)',
    lineHeight: '1.625',
    overflow: 'auto',
  },
  '.cm-content': {
    padding: '0 1.5rem 1.5rem',
    caretColor: '#fbbf24',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: '#fbbf24',
    borderLeftWidth: '2px',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'rgba(251,191,36,0.18) !important',
  },
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: 'rgba(251,191,36,0.22) !important',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(255,255,255,0.025)',
  },
  // No gutters (line numbers) — note editor, not code editor
  '.cm-gutters': { display: 'none' },
  // Fenced code block lines (fences + content): left indent + amber left border.
  '.cm-code-block-line': {
    paddingLeft: '1.5rem',
    borderLeft: '2px solid oklch(47.1% 0.104 83.5)', /* amber-700 */
  },
  // @calc block
  '.cm-calc-header': {
    color:     'oklch(39.4% 0.023 107.4)',   // olive-700 — dimmed marker line
    fontStyle: 'italic',
  },
  '.cm-calc-expr': {
    position:    'relative',               // containing block for result widget
    borderLeft:  '2px solid oklch(47.1% 0.104 83.5)',  // amber-700
    paddingLeft: '0.75rem',
  },
  // Reset all Markdown-driven styling inside @calc expression lines.
  // Expressions like "- 50" or "* 1.1" are arithmetic, not list items or
  // emphasis marks. We target every span except the result widget, which
  // catches both the explicit cm-meta/cm-list-marker classes set by our own
  // plugins and the generated Lezer highlight classes set by miHighlightStyle.
  '.cm-calc-expr span:not(.cm-calc-result)': {
    color:      'inherit',
    fontWeight: 'inherit',
    fontStyle:  'inherit',
  },
  '.cm-calc-result': {
    position:      'absolute',
    right:         '0',
    top:           '0',
    color:         'oklch(79.5% 0.184 86.5)',  // amber-400
    fontSize:      '0.85em',
    fontFamily:    'var(--font-family-mono)',
    pointerEvents: 'none',
    userSelect:    'none',
  },
  '.cm-calc-result.cm-calc-result-error': {
    color: 'oklch(70% 0.19 27)',             // muted red
  },
  // Task checkboxes — plain-text [ ] / [X] made clickable
  '.cm-task-checkbox': {
    cursor:    'pointer',
    color:     'oklch(65% 0.08 107)',   // slightly brighter than body text
  },
  '.cm-task-checked': {
    color:     'oklch(79.5% 0.184 86.5)',  // amber-400
  },
  '.cm-task-done-line': {
    color:     'oklch(47.1% 0.025 107)',   // olive-600 — two steps dimmer than body
  },
  // Journal placeholder ("Tell me about your day…")
  '.cm-placeholder': {
    color: 'oklch(47.1% 0.057 100)',  // ~olive-600
    fontStyle: 'italic',
  },
  // Autocomplete popup styling
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--color-olive-800)',
    border: '1px solid var(--color-olive-600)',
    borderRadius: '6px',
    boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
    overflow: 'hidden',
  },
  '.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--font-family-mono)',
    fontSize: '0.75rem',
    maxHeight: '13rem',
  },
  '.cm-tooltip-autocomplete > ul > li': {
    color: 'var(--color-olive-200)',
    padding: '4px 12px',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--color-amber-700, #b45309)',
    color: '#fff',
  },
}, { dark: true });

// ── Syntax highlighting ────────────────────────────────────────────────────

export const miHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1,        color: '#fbbf24', fontWeight: 'bold',   fontSize: '1.2em'  },
  { tag: tags.heading2,        color: '#fcd34d', fontWeight: 'bold',   fontSize: '1.1em'  },
  { tag: tags.heading3,        color: '#fde68a', fontWeight: 'bold'                       },
  { tag: [tags.heading4, tags.heading5, tags.heading6], color: '#fde68a'                  },
  { tag: tags.strong,          fontWeight: 'bold'                                         },
  { tag: tags.emphasis,        fontStyle: 'italic'                                        },
  { tag: tags.strikethrough,   textDecoration: 'line-through'                             },
  { tag: tags.link,            color: 'inherit'                                           }, // via linkPlugin
  { tag: tags.url,             color: 'inherit'                                           }, // via linkPlugin
  { tag: tags.monospace,       color: 'inherit'                                          }, // colored via inlineCodePlugin
  { tag: tags.meta,                  color: 'oklch(46.6% 0.025 107.3)' /* fallback */   },
  { tag: tags.comment,               color: 'oklch(46.6% 0.025 107.3)', fontStyle: 'italic' },
  { tag: tags.processingInstruction, color: 'oklch(46.6% 0.025 107.3)' /* fallback */   },
  { tag: tags.contentSeparator, color: 'oklch(39.4% 0.023 107.4)' /* olive-700 */       },
  { tag: tags.list,             color: 'inherit'                                         }, // colored via listMarkerPlugin instead
  { tag: tags.atom,            color: '#fbbf24'                                           },
]);

// ── Wiki-link decoration ───────────────────────────────────────────────────
// Applies precise per-segment classes to [[title]] patterns so both bracket
// pairs render in the dim bracket colour and the title renders in amber.
// Using !important in CSS ensures these override whatever the Markdown parser
// assigns to those token ranges.

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

const wikilinkPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged) this.decorations = this._build(u.view);
  }
  _build(view) {
    const deco = [];
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.doc.sliceString(from, to);
      WIKILINK_RE.lastIndex = 0;
      let m;
      while ((m = WIKILINK_RE.exec(text)) !== null) {
        const start = from + m.index;
        const end   = start + m[0].length;
        deco.push(Decoration.mark({ class: 'cm-wikilink-bracket' }).range(start,     start + 2));
        deco.push(Decoration.mark({ class: 'cm-wikilink-title'   }).range(start + 2, end   - 2));
        deco.push(Decoration.mark({ class: 'cm-wikilink-bracket' }).range(end   - 2, end      ));
      }
    }
    return Decoration.set(deco, true);
  }
}, { decorations: v => v.decorations });

// ── CamelCase link decoration ──────────────────────────────────────────────
// Highlights CamelCase words that resolve to a known page title in the same
// amber as [[bracket]] links. Never highlights unknown words — so MacBook,
// WiFi, etc. are left as plain text unless a page by that title exists.
// CamelCase links never create pages; [[bracket]] form is required for that.

const camelLinkPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged) this.decorations = this._build(u.view);
  }
  _build(view) {
    const deco = [];
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.doc.sliceString(from, to);
      CAMELCASE_RE.lastIndex = 0;
      let m;
      while ((m = CAMELCASE_RE.exec(text)) !== null) {
        if (!_pageTitleSet.has(camelToTitle(m[0]))) continue;
        const start = from + m.index;
        deco.push(Decoration.mark({ class: 'cm-wikilink-title' }).range(start, start + m[0].length));
      }
    }
    return Decoration.set(deco, true);
  }
}, { decorations: v => v.decorations });

// ── Hashtag decoration ─────────────────────────────────────────────────────
// Marks #hashtag tokens (preceded by whitespace or start-of-line) with
// the class cm-hashtag so they render in amber.

const HASHTAG_RE = /(^|[ \t])(#[a-zA-Z][a-zA-Z0-9_-]*)/gm;

const hashtagPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged) this.decorations = this._build(u.view);
  }
  _build(view) {
    const deco = [];
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.doc.sliceString(from, to);
      HASHTAG_RE.lastIndex = 0;
      let m;
      while ((m = HASHTAG_RE.exec(text)) !== null) {
        const octStart = from + m.index + m[1].length;  // position of #
        const txtStart = octStart + 1;                  // position of word
        const tagEnd   = octStart + m[2].length;
        deco.push(Decoration.mark({ class: 'cm-hashtag-punct' }).range(octStart, txtStart));
        deco.push(Decoration.mark({ class: 'cm-hashtag'       }).range(txtStart, tagEnd));
      }
    }
    return Decoration.set(deco, true);
  }
}, { decorations: v => v.decorations });


// ── List marker decoration ─────────────────────────────────────────────────
// Colors only the bullet/number at the start of a list item, not the content.

const LIST_MARKER_RE = /^([ \t]*)([-*+]|\d+[.)]) /;

const listMarkerPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged) this.decorations = this._build(u.view);
  }
  _build(view) {
    const deco = [];
    for (const { from, to } of view.visibleRanges) {
      let pos = from;
      while (pos <= to) {
        const line = view.state.doc.lineAt(pos);
        const m    = LIST_MARKER_RE.exec(line.text);
        if (m) {
          const start = line.from + m[1].length;        // after any indent
          const end   = start    + m[2].length;         // just the - / * / 1.
          deco.push(Decoration.mark({ class: 'cm-list-marker' }).range(start, end));
        }
        pos = line.to + 1;
      }
    }
    return Decoration.set(deco, true);
  }
}, { decorations: v => v.decorations });

// ── Delimiter (decorative markup) decoration ───────────────────────────────
// Stamps cm-meta on delimiter nodes so they are dimmed consistently whether
// they appear in normal paragraphs or inside list items.  The HighlightStyle
// entries for tags.meta / tags.processingInstruction serve as fallback only.

const DELIMITER_NODES = new Set([
  'EmphasisMark',      // * _ ** __
  'StrikethroughMark', // ~~
  'CodeMark',          // `  (backtick — inside InlineCode)
]);

const delimiterPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged) this.decorations = this._build(u.view);
  }
  _build(view) {
    const deco = [];
    const tree = syntaxTree(view.state);
    for (const { from, to } of view.visibleRanges) {
      tree.iterate({
        from, to,
        enter(node) {
          if (DELIMITER_NODES.has(node.name)) {
            deco.push(Decoration.mark({ class: 'cm-meta' }).range(node.from, node.to));
          }
        },
      });
    }
    return Decoration.set(deco, true);
  }
}, { decorations: v => v.decorations });

// ── Markdown link decoration ───────────────────────────────────────────────
// [link text](url)
//  ↑         ↑↑↑ — cm-meta (dimmed)
//   ↑↑↑↑↑↑↑↑    — cm-link-text (amber)
// Not handled by delimiterPlugin so LinkMark is not in DELIMITER_NODES.

const linkPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged) this.decorations = this._build(u.view);
  }
  _build(view) {
    const deco = [];
    const tree = syntaxTree(view.state);
    for (const { from, to } of view.visibleRanges) {
      tree.iterate({
        from, to,
        enter(node) {
          if (node.name !== 'Link') return;
          const cursor = node.node.cursor();
          if (!cursor.firstChild()) return;
          let textEnd = null;
          do {
            if (cursor.name === 'LinkMark') {
              deco.push(Decoration.mark({ class: 'cm-meta' }).range(cursor.from, cursor.to));
              // First ']' marks the end of the link text
              if (textEnd === null &&
                  view.state.doc.sliceString(cursor.from, cursor.to) === ']') {
                textEnd = cursor.from;
              }
            } else if (cursor.name === 'URL') {
              deco.push(Decoration.mark({ class: 'cm-meta' }).range(cursor.from, cursor.to));
            }
          } while (cursor.nextSibling());
          // Highlight the link display text (between [ and ])
          if (textEnd !== null && node.from + 1 < textEnd) {
            deco.push(Decoration.mark({ class: 'cm-link-text' }).range(node.from + 1, textEnd));
          }
        },
      });
    }
    return Decoration.set(deco, true);
  }
}, { decorations: v => v.decorations });

// ── URL decoration ─────────────────────────────────────────────────────────
// Styles bare URLs (GFM autolinks) and <angle-bracket> autolinks.
// URL nodes that are children of Link are handled by linkPlugin — skip them.
//
// GFM bare URL  →  URL node directly in inline content  →  cm-url
// <url> autolink → Autolink wrapping URL child;
//                  '<' / '>' are outside URL bounds     →  cm-meta

const urlPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged) this.decorations = this._build(u.view);
  }
  _build(view) {
    const deco = [];
    const tree = syntaxTree(view.state);
    for (const { from, to } of view.visibleRanges) {
      tree.iterate({
        from, to,
        enter(node) {
          if (node.name !== 'URL') return;
          const parent = node.node.parent;
          if (parent && parent.name === 'Link') return; // handled by linkPlugin
          deco.push(Decoration.mark({ class: 'cm-url' }).range(node.from, node.to));
          // Dim the < > angle brackets of <url> autolinks
          if (parent && parent.name === 'Autolink') {
            if (parent.from < node.from)
              deco.push(Decoration.mark({ class: 'cm-meta' }).range(parent.from, node.from));
            if (node.to < parent.to)
              deco.push(Decoration.mark({ class: 'cm-meta' }).range(node.to, parent.to));
          }
        },
      });
    }
    return Decoration.set(deco, true);
  }
}, { decorations: v => v.decorations });

// ── Fenced code block decoration ───────────────────────────────────────────
// ``` marks and CodeInfo label → cm-meta (dimmed), via this plugin.
// Content lines                → cm-code-block (mark, for color)
//                              + cm-code-block-line (line, for left indent)
//
// Decoration.mark is inline-level; it can color but can't block-indent lines.
// Decoration.line adds a class to the .cm-line element, which the miTheme
// (injected with two-class specificity) rules use to apply padding-left safely.

const fencedCodePlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged) this.decorations = this._build(u.view);
  }
  _build(view) {
    const deco = [];
    const tree = syntaxTree(view.state);
    for (const { from, to } of view.visibleRanges) {
      tree.iterate({
        from, to,
        enter(node) {
          if (node.name !== 'FencedCode') return;
          const cursor = node.node.cursor();
          if (!cursor.firstChild()) return;

          let openEnd    = null;
          let closeStart = null;

          do {
            if (cursor.name === 'CodeMark') {
              deco.push(Decoration.mark({ class: 'cm-meta' }).range(cursor.from, cursor.to));
              if (openEnd === null) openEnd = cursor.to;
              else                  closeStart = cursor.from;
            } else if (cursor.name === 'CodeInfo') {
              deco.push(Decoration.mark({ class: 'cm-meta' }).range(cursor.from, cursor.to));
            }
          } while (cursor.nextSibling());

          if (openEnd === null || closeStart === null) return;

          // Content range: line after opening fence up to line before closing fence.
          const contentFrom = view.state.doc.lineAt(openEnd).to + 1;
          const contentTo   = view.state.doc.lineAt(closeStart).from;
          if (contentFrom >= contentTo) return;

          // Color the content span.
          deco.push(Decoration.mark({ class: 'cm-code-block' }).range(contentFrom, contentTo - 1));

          // Left-border line decoration on every line of the block — fences included.
          let pos = view.state.doc.lineAt(node.from).from;
          while (pos <= node.to) {
            const line = view.state.doc.lineAt(pos);
            deco.push(Decoration.line({ class: 'cm-code-block-line' }).range(line.from));
            pos = line.to + 1;
          }

        },
      });
    }
    return Decoration.set(deco, true);
  }
}, { decorations: v => v.decorations });

// ── Annotation keyword highlight ───────────────────────────────────────────
// Marks reserved annotation keywords (TODO, FIXME, NOTE, IDEA) inline.
// Each keyword gets a shared `cm-annotation` base class plus a keyword-specific
// modifier class for per-keyword colour.  Never creates tasks.

const ANNOTATION_RE = /\b(TODO|FIXME|NOTE|IDEA)\b/g;

const annotationPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged) this.decorations = this._build(u.view);
  }
  _build(view) {
    const deco = [];
    for (const { from, to } of view.visibleRanges) {
      const text = view.state.doc.sliceString(from, to);
      ANNOTATION_RE.lastIndex = 0;
      let m;
      while ((m = ANNOTATION_RE.exec(text)) !== null) {
        const start = from + m.index;
        const kw    = m[1].toLowerCase();
        deco.push(Decoration.mark({ class: `cm-annotation cm-annotation-${kw}` })
          .range(start, start + m[1].length));
      }
    }
    return Decoration.set(deco, true);
  }
}, { decorations: v => v.decorations });

// ── Task checkbox decoration ────────────────────────────────────────────────
// Marks [] / [ ] / [X] / [x] at the start of a task line (optionally after
// a list marker like "- ") as clickable plain text.
// @done or @done(timestamp) on a task line also counts as checked.
// Click unchecked → [X] + appends @done(timestamp)
// Click checked   → [ ] + removes @done(...)

const TASK_CB_RE    = /^([ \t]*(?:[-*+]|\d+[.)]) +)?\[([xX ]?)\]/;
const DONE_STAMP_RE = /@done\([^)]*\)/;
const DONE_BARE_RE  = /@done(?!\()/;

function doneStamp() {
  const d   = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `@done(${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())})`;
}

const taskCheckboxPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged) this.decorations = this._build(u.view);
  }
  _build(view) {
    const deco = [];
    for (const { from, to } of view.visibleRanges) {
      let pos = from;
      while (pos <= to) {
        const line    = view.state.doc.lineAt(pos);
        const m       = TASK_CB_RE.exec(line.text);
        if (m) {
          const prefix  = m[1] ? m[1].length : 0;
          const cbFrom  = line.from + prefix;
          const cbLen   = 2 + m[2].length;
          const checked = m[2] === 'X' || m[2] === 'x'
                       || DONE_STAMP_RE.test(line.text)
                       || DONE_BARE_RE.test(line.text);
          const cls     = checked ? 'cm-task-checkbox cm-task-checked' : 'cm-task-checkbox';
          deco.push(Decoration.mark({ class: cls }).range(cbFrom, cbFrom + cbLen));
          if (checked) deco.push(Decoration.line({ class: 'cm-task-done-line' }).range(line.from));
        }
        pos = line.to + 1;
      }
    }
    return Decoration.set(deco, true);
  }
}, { decorations: v => v.decorations });

const checkboxClickHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target.closest('.cm-task-checkbox');
    if (!target) return false;
    event.preventDefault();
    const pos  = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos == null) return false;
    const line = view.state.doc.lineAt(pos);
    const m    = TASK_CB_RE.exec(line.text);
    if (!m) return false;

    const prefix    = m[1] ? m[1].length : 0;
    const cbFrom    = line.from + prefix;
    const cbLen     = 2 + m[2].length;
    const cbChecked = m[2] === 'X' || m[2] === 'x';
    const sm        = DONE_STAMP_RE.exec(line.text);
    const bm        = DONE_BARE_RE.exec(line.text);
    const checked   = cbChecked || !!sm || !!bm;
    const changes   = [];

    if (checked) {
      // ── Uncheck ──────────────────────────────────────────────────────────
      if (cbChecked) changes.push({ from: cbFrom, to: cbFrom + cbLen, insert: '[ ]' });
      // Remove ' @done(...)' preferring the leading-space form, else bare
      const rm = (/ @done\([^)]*\)/.exec(line.text))
              || (/@done\([^)]*\)/.exec(line.text))
              || (/ @done(?!\()/.exec(line.text))
              || (/@done(?!\()/.exec(line.text));
      if (rm) changes.push({ from: line.from + rm.index, to: line.from + rm.index + rm[0].length, insert: '' });
    } else {
      // ── Check ────────────────────────────────────────────────────────────
      changes.push({ from: cbFrom, to: cbFrom + cbLen, insert: '[X]' });
      if (sm) {
        // already stamped — nothing extra needed
      } else if (bm) {
        // upgrade bare @done → @done(timestamp)
        changes.push({ from: line.from + bm.index, to: line.from + bm.index + bm[0].length, insert: doneStamp() });
      } else {
        changes.push({ from: line.to, to: line.to, insert: ' ' + doneStamp() });
      }
    }

    // changes are ordered: checkbox is near line start, @done near line end
    view.dispatch({ changes, userEvent: 'checkbox.toggle' });
    return true;
  },
});

// Auto-stamp bare @done on task lines when the cursor leaves that line.
// Fires on doc changes AND cursor movement so cursoring off the line is enough.
// Also writes [X] into the document so the checkbox marker matches.
const autoDoneStampListener = EditorView.updateListener.of(update => {
  if (!update.docChanged && !update.selectionSet) return;
  const { state } = update;
  const cursorLine = state.doc.lineAt(state.selection.main.head).number;
  const changes = [];

  for (let i = 1; i <= state.doc.lines; i++) {
    if (i === cursorLine) continue;          // leave the line alone while cursor is on it
    const line = state.doc.line(i);
    const cbm  = TASK_CB_RE.exec(line.text);
    if (!cbm) continue;
    const bm = DONE_BARE_RE.exec(line.text);
    if (!bm) continue;

    // Mark checkbox [X] if not already
    if (cbm[2] !== 'X' && cbm[2] !== 'x') {
      const prefix = cbm[1] ? cbm[1].length : 0;
      const cbFrom = line.from + prefix;
      changes.push({ from: cbFrom, to: cbFrom + 2 + cbm[2].length, insert: '[X]' });
    }
    // Stamp @done → @done(timestamp)  (checkbox change is earlier in doc, order is fine)
    changes.push({ from: line.from + bm.index, to: line.from + bm.index + bm[0].length, insert: doneStamp() });
  }

  if (!changes.length) return;
  requestAnimationFrame(() => update.view.dispatch({ changes, userEvent: 'done.stamp' }));
});

// ── @calc block decoration ─────────────────────────────────────────────────
// Scans the entire document to evaluate all @calc blocks (so that @-implicit
// prepend state is correct for lines above the viewport), then decorates only
// visible lines.
//
// Each @calc header line gets class cm-calc-header (dimmed, italic).
// Each expression line gets class cm-calc-expr (left border) plus a
// CalcResultWidget anchored at the end of the line showing the result
// flush-right via position:sticky.

class CalcResultWidget extends WidgetType {
  constructor(formatted, error) {
    super();
    this.formatted = formatted;
    this.error     = error;
  }
  toDOM() {
    const el = document.createElement('span');
    if (this.error != null) {
      el.className = 'cm-calc-result cm-calc-result-error';
      el.textContent = this.error;
    } else {
      el.className = 'cm-calc-result';
      el.textContent = '= ' + this.formatted;
    }
    return el;
  }
  eq(other) { return this.formatted === other.formatted && this.error === other.error; }
  ignoreEvent() { return true; }
}

export const calcBlockPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged) this.decorations = this._build(u.view);
  }
  _build(view) {
    const doc   = view.state.doc;
    const text  = doc.toString();
    const { results, headerLines } = scanCalcBlocks(text);

    const deco = [];

    for (const { from, to } of view.visibleRanges) {
      let pos = from;
      while (pos <= to) {
        const line = doc.lineAt(pos);

        if (headerLines.has(line.number)) {
          deco.push(Decoration.line({ class: 'cm-calc-header' }).range(line.from));
        } else if (results.has(line.number)) {
          const res = results.get(line.number);
          deco.push(Decoration.line({ class: 'cm-calc-expr' }).range(line.from));
          deco.push(
            Decoration.widget({
              widget: new CalcResultWidget(res.formatted, res.error),
              side: 1,
            }).range(line.to),
          );
        }

        pos = line.to + 1;
      }
    }

    // Decorations must be sorted; line.from < line.to guarantees order within
    // each line, and we process lines in document order.
    return Decoration.set(deco, true);
  }
}, { decorations: v => v.decorations });

// ── Inline code decoration ─────────────────────────────────────────────────
// Applies cm-inline-code to every InlineCode node in the syntax tree,
// regardless of whether it sits inside a list item or regular paragraph.
// Sharing one class makes theming straightforward.

const inlineCodePlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged) this.decorations = this._build(u.view);
  }
  _build(view) {
    const deco = [];
    const tree = syntaxTree(view.state);
    for (const { from, to } of view.visibleRanges) {
      tree.iterate({
        from, to,
        enter(node) {
          if (node.name === 'InlineCode') {
            deco.push(Decoration.mark({ class: 'cm-inline-code' }).range(node.from, node.to));
          }
        },
      });
    }
    return Decoration.set(deco, true);
  }
}, { decorations: v => v.decorations });

// ── Auto-surround ──────────────────────────────────────────────────────────
// When text is selected and an opening char is typed, wrap the selection.
// Uses EditorView.inputHandler (fires on beforeinput) rather than a keymap,
// because CM6's contenteditable input bypasses keydown for printable chars.

const WRAP_PAIRS = {
  '(': ')', '[': ']', '{': '}',
  '"': '"', "'": "'", '`': '`',
  '*': '*', '_': '_', '~': '~',
};

const surroundHandler = EditorView.domEventHandlers({
  beforeinput(event, view) {
    if (event.inputType !== 'insertText') return false;
    const text = event.data;
    if (!text || text.length !== 1) return false;
    const close = WRAP_PAIRS[text];
    if (!close) return false;
    const { from, to } = view.state.selection.main;
    if (from === to) return false;
    event.preventDefault();
    view.dispatch({
      changes: [{ from, insert: text }, { from: to, insert: close }],
      selection: { anchor: from + 1, head: to + 1 },
      userEvent: 'input',
    });
    return true;
  },
});

// ── Post-autocomplete punctuation cleanup ──────────────────────────────────
// When the user types punctuation immediately after a completed [[link]] ,
// remove the trailing space that the autocomplete inserted.

const PUNCT_AFTER_LINK = /^[.,;:!?)\]]/;

const wikiLinkPunctHandler = EditorView.domEventHandlers({
  beforeinput(event, view) {
    if (event.inputType !== 'insertText') return false;
    const ch = event.data;
    if (!ch || !PUNCT_AFTER_LINK.test(ch)) return false;
    const { from, to } = view.state.selection.main;
    if (from !== to || from < 3) return false;
    const doc = view.state.doc;
    if (doc.sliceString(from - 1, from) !== ' ')  return false;
    if (doc.sliceString(from - 3, from - 1) !== ']]') return false;
    event.preventDefault();
    view.dispatch({
      changes:   { from: from - 1, to: from, insert: ch },
      selection: { anchor: from },
      userEvent: 'input',
    });
    return true;
  },
});

// ── Wiki-link autocomplete source ──────────────────────────────────────────
// Activated by typing [[ and filters pages by prefix.

let _allPages    = [];
let _pageTitleSet = new Set();

export function setEditorPages(pages) {
  _allPages     = pages;
  _pageTitleSet = new Set(pages.map(p => p.title));
}

// CamelCase → "Title Case" by splitting on uppercase boundaries.
// "AndersonContract" → "Anderson Contract"
function camelToTitle(camel) {
  return camel.replace(/([A-Z])/g, ' $1').trim();
}

// Matches CamelCase words: at least two segments, each one uppercase + lowercase+.
// Only highlights against known page titles, so false positives (WiFi, MacBook)
// are silently ignored unless a page by that title actually exists.
const CAMELCASE_RE = /\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b/g;

// ── Journal placeholder ────────────────────────────────────────────────────
// Reconfigure via placeholderCompartment.reconfigure(placeholder('…')) or []
export const placeholderCompartment = new Compartment();

function wikiLinkSource(context) {
  const match = context.matchBefore(/\[\[[^\]]*$/);
  if (!match) return null;
  const query = match.text.slice(2).toLowerCase();
  const options = _allPages
    .filter(p => p.title.toLowerCase().startsWith(query))
    .slice(0, 8)
    .map(p => ({
      label:  p.title,
      detail: '[[link]]',
      apply(view, _completion, _from, to) {
        // Read the actual typed text from the doc (not match.text, which may
        // be stale if CM6 used client-side validFor filtering after the last
        // source invocation). Append only the untyped suffix from the title.
        const typed  = view.state.doc.sliceString(match.from + 2, to);
        const rest   = p.title.slice(typed.length);
        const insert = `[[${typed}${rest}]] `;
        view.dispatch({
          changes: { from: match.from, to, insert },
          selection: { anchor: match.from + insert.length },
          userEvent: 'input.complete',
        });
      },
    }));
  return { from: match.from + 2, options, validFor: /^[^\]]*$/ };
}

// ── Editor factory ─────────────────────────────────────────────────────────

export function createEditor({ parent, onDocChange, onCursorChange, onPageClick, onCmdClick }) {
  const tabKeymap = {
    key: 'Tab',
    run(view) {
      if (acceptCompletion(view)) return true;
      const line = view.state.doc.lineAt(view.state.selection.main.from);
      if (LIST_MARKER_RE.test(line.text)) {
        view.dispatch({ changes: { from: line.from, insert: '  ' }, userEvent: 'indent' });
        return true;
      }
      view.dispatch(view.state.replaceSelection('  '));
      return true;
    },
  };

  const shiftTabKeymap = {
    key: 'Shift-Tab',
    run(view) {
      const line = view.state.doc.lineAt(view.state.selection.main.from);
      if (!LIST_MARKER_RE.test(line.text)) return false;
      const leading = line.text.match(/^( +)/);
      if (!leading) return false;
      const removeCount = Math.min(2, leading[1].length);
      view.dispatch({ changes: { from: line.from, to: line.from + removeCount, insert: '' }, userEvent: 'dedent' });
      return true;
    },
  };

  const spaceKeymap = {
    key: 'Space',
    run: acceptCompletion,
  };

  // Resolve a CamelCase link at a given document position, or null.
  function camelTitleAt(view, pos) {
    const line    = view.state.doc.lineAt(pos);
    const text    = line.text;
    const linePos = pos - line.from;
    CAMELCASE_RE.lastIndex = 0;
    let m;
    while ((m = CAMELCASE_RE.exec(text)) !== null) {
      if (m.index <= linePos && linePos <= m.index + m[0].length) {
        const title = camelToTitle(m[0]);
        if (_pageTitleSet.has(title)) return title;
      }
    }
    return null;
  }

  // Resolve the wiki-link title at a given document position, or null.
  // Constrained to the current line so cross-line false positives are impossible.
  function wikiTitleAt(view, pos) {
    const line    = view.state.doc.lineAt(pos);
    const text    = line.text;
    const linePos = pos - line.from;   // click offset within this line

    // Scan backward within the line for [[
    let s = linePos;
    while (s > 1 && !(text[s - 2] === '[' && text[s - 1] === '[')) s--;
    if (s < 2) return null;
    s -= 2; // s now points at the first [

    // If there is a ]] between [[ and the click, pos is outside any link
    if (text.slice(s + 2, linePos).includes(']]')) return null;

    // Scan forward within the line for ]]
    let e = linePos;
    while (e + 1 < text.length && !(text[e] === ']' && text[e + 1] === ']')) e++;
    if (!(text[e] === ']' && text[e + 1] === ']')) return null;

    return text.slice(s + 2, e).trim() || null;
  }

  const clickHandler = EditorView.domEventHandlers({
    click(event, view) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const title = wikiTitleAt(view, pos) || camelTitleAt(view, pos);
      if (!title) return false;
      if (event.metaKey || event.ctrlKey) {
        onCmdClick(title);
      } else {
        onPageClick(title);
      }
      return true;
    },
  });

  const updateListener = EditorView.updateListener.of(update => {
    if (update.docChanged) onDocChange(update.state.doc.toString());
    if (update.selectionSet || update.docChanged) {
      const sel  = update.state.selection.main;
      const line = update.state.doc.lineAt(sel.head);
      onCursorChange(line.number, sel.head - line.from + 1);
    }
  });

  const state = EditorState.create({
    doc: '',
    extensions: [
      history(),
      drawSelection(),
      highlightActiveLine(),
      indentOnInput(),
      bracketMatching(),
      markdown({ base: { parser: markdownLanguage.parser.configure({ remove: ['SetextHeading'] }) } }),
      syntaxHighlighting(miHighlightStyle),
      autocompletion({ override: [wikiLinkSource] }),
      wikilinkPlugin,
      camelLinkPlugin,
      hashtagPlugin,
      listMarkerPlugin,
      delimiterPlugin,
      linkPlugin,
      urlPlugin,
      fencedCodePlugin,
      inlineCodePlugin,
      annotationPlugin,
      taskCheckboxPlugin,
      calcBlockPlugin,
      EditorView.lineWrapping,
      surroundHandler,
      wikiLinkPunctHandler,
      checkboxClickHandler,
      keymap.of([
        tabKeymap,
        shiftTabKeymap,
        spaceKeymap,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      placeholderCompartment.of([]),
      miTheme,
      updateListener,
      autoDoneStampListener,
      clickHandler,
    ],
  });

  return new EditorView({ state, parent });
}
