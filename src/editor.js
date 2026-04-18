import {
  EditorState,
  Compartment,
  Prec,
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
import {
  markdown,
  markdownLanguage,
} from '@codemirror/lang-markdown';
import { autocompletion, acceptCompletion } from '@codemirror/autocomplete';
import { tags } from '@lezer/highlight';
import { scanCalcBlocks } from './calcBlock.js';
import { isOverdue, isDueToday } from './dateUtils.js';
import { priorityPillDOM } from './ui.js';

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
  '.cm-calc-expr span:not(.cm-calc-result):not(.cm-calc-comment)': {
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
    cursor:        'text',
  },
  '.cm-calc-result.cm-calc-result-error': {
    color: 'oklch(70% 0.19 27)',             // muted red
  },
  '.cm-calc-comment': {
    color:     'oklch(39.4% 0.023 107.4)',   // olive-700 — dimmed like header
    fontStyle: 'italic',
  },
  // Thematic break (---): hide the raw dashes; draw a rule across the text
  // column via ::before.  left/right 0 aligns to .cm-line edges, which sit
  // inside .cm-content's padding — the full width of the text area.
  '.cm-hr': {
    position: 'relative',
  },
  // Hide all child spans (the dashes coloured by the syntax highlighter).
  '.cm-hr span': {
    color: 'transparent',
  },
  '.cm-hr::before': {
    content:        '""',
    display:        'block',
    position:       'absolute',
    top:            '50%',
    left:           '0',
    right:          '0',
    borderTop:      '1px solid oklch(39.4% 0.023 107.4)',  // olive-700
    pointerEvents:  'none',
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
  // @context tags on task lines (bare @word, not a reserved param)
  '.cm-at-context': {
    color: 'oklch(87.9% 0.169 91.605)',   // amber-300
  },
  // reserved param tags (@due, @defer, @priority, @done, etc.) — de-emphasized
  '.cm-at-param': {
    color: 'oklch(52% 0.025 107)',        // olive-600ish — readable but recedes
  },
  // Overdue tasks — red highlight on checkbox only; task text stays normal
  '.cm-task-overdue .cm-task-checkbox': {
    backgroundColor: 'oklch(50% 0.19 27)',  // muted red
    color:           '#fff',
    borderRadius:    '3px',
    padding:         '0 1px',
  },
  // Due-today tasks — amber background
  '.cm-task-due-today': {
    backgroundColor: 'oklch(45% 0.12 75)',  // muted amber
    color:           'oklch(90% 0.12 85)',   // warm light text
    borderRadius:    '2px',
  },
  '.cm-task-due-today .cm-task-checkbox': {
    color: 'oklch(87.9% 0.169 91.605)',  // amber-300
  },
  '.cm-task-due-today .cm-at-context': {
    color: 'oklch(90% 0.08 85)',  // light amber — visible on amber bg
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
  // Wiki link bracket + title decorations.  Defined in the theme so the
  // editor-root scope selector raises specificity above the generated
  // HighlightStyle heading rules — otherwise headings override the color.
  // CM6 nests syntax-highlight spans inside decoration spans, so a heading
  // class on the inner span overrides the parent's color.  The `*` selector
  // forces all descendants to inherit the wikilink color.
  '.cm-wikilink-bracket, .cm-wikilink-bracket *': {
    color: 'oklch(46.6% 0.025 107.3) !important',  // olive-600
    cursor: 'pointer',
  },
  '.cm-wikilink-title, .cm-wikilink-title *': {
    color: '#fbbf24 !important',                    // amber-400
    cursor: 'pointer',
  },
}, { dark: true });

// ── Syntax highlighting ────────────────────────────────────────────────────

const BASE_HIGHLIGHT_RULES = [
  { tag: tags.strong,          fontWeight: 'bold'                                         },
  { tag: tags.emphasis,        fontStyle: 'italic'                                        },
  { tag: tags.strikethrough,   textDecoration: 'line-through'                             },
  { tag: tags.link,            color: 'inherit'                                           }, // via linkPlugin
  { tag: tags.url,             color: 'inherit'                                           }, // via linkPlugin
  { tag: tags.monospace,       color: 'inherit'                                           }, // colored via inlineCodePlugin
  { tag: tags.meta,                  color: 'oklch(46.6% 0.025 107.3)' /* fallback */   },
  { tag: tags.comment,               color: 'oklch(46.6% 0.025 107.3)', fontStyle: 'italic' },
  { tag: tags.processingInstruction, color: 'oklch(46.6% 0.025 107.3)' /* fallback */   },
  { tag: tags.contentSeparator, color: 'oklch(39.4% 0.023 107.4)' /* olive-700 */       },
  { tag: tags.list,             color: 'inherit'                                         }, // colored via listMarkerPlugin instead
  { tag: tags.atom,            color: '#fbbf24'                                           },
  { tag: tags.squareBracket,   color: 'inherit'                                           }, // defer to wikilinkPlugin decoration
];

export const miHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, color: '#fbbf24', fontWeight: 'bold', fontSize: '1.2em' },
  { tag: tags.heading2, color: '#fcd34d', fontWeight: 'bold', fontSize: '1.1em' },
  { tag: tags.heading3, color: '#fde68a', fontWeight: 'bold'                    },
  { tag: [tags.heading4, tags.heading5, tags.heading6], color: '#fde68a'        },
  ...BASE_HIGHLIGHT_RULES,
]);

const tasksHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, color: 'var(--taskview-page-color)',    fontWeight: 'var(--taskview-page-font-weight)'    },
  { tag: tags.heading2, color: 'var(--taskview-page-color)',    fontWeight: 'var(--taskview-page-font-weight)'    },
  { tag: tags.heading3, color: 'var(--taskview-section-color)', fontWeight: 'var(--taskview-section-font-weight)' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], color: 'var(--taskview-section-color)', fontWeight: 'var(--taskview-section-font-weight)' },
  ...BASE_HIGHLIGHT_RULES,
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

// ── Thematic-break (---) decoration ───────────────────────────────────────
// Finds HorizontalRule nodes in the syntax tree and:
//   • gives the whole line class cm-hr so ::before can draw the visible rule
//   • marks the raw dash characters with color:transparent so they disappear

const hrPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged) this.decorations = this._build(u.view);
  }
  _build(view) {
    const deco = [];
    const tree = syntaxTree(view.state);
    const doc  = view.state.doc;

    // Identify front-matter delimiter lines so they are not styled as <hr>.
    // Front matter is an opening --- on line 1 followed by a matching closing ---.
    let fmOpenLine  = 0;
    let fmCloseLine = 0;
    if (doc.lines >= 2 && doc.line(1).text.trim() === '---') {
      for (let n = 2; n <= doc.lines; n++) {
        if (doc.line(n).text.trim() === '---') { fmOpenLine = 1; fmCloseLine = n; break; }
      }
    }

    for (const { from, to } of view.visibleRanges) {
      tree.iterate({
        from, to,
        enter(node) {
          if (node.name !== 'HorizontalRule') return;
          const line = doc.lineAt(node.from);
          if (line.number === fmOpenLine || line.number === fmCloseLine) return;
          deco.push(Decoration.line({ class: 'cm-hr' }).range(line.from));
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
          // Skip wiki links — [[title]] is handled by wikilinkPlugin.
          const linkText = view.state.doc.sliceString(node.from, Math.min(node.from + 2, node.to));
          if (linkText === '[[') return;
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

const ANNOTATION_RE = /\b(TODO|FIXME|NOTE|IDEA)(:?)(?!\w)/g;

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
          .range(start, start + m[0].length));
      }
    }
    return Decoration.set(deco, true);
  }
}, { decorations: v => v.decorations });

// ── Task @-parameter parser ─────────────────────────────────────────────────
// Parses @word and @word(value) tokens from a string.
// Returns [{name, value, from, to}] where value is null for a bare @word.
// `from`/`to` are character offsets within `text`.
export function parseAtParams(text) {
  const re = /@([a-zA-Z][a-zA-Z0-9_-]*)(\([^)]*\))?/g;
  const params = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    params.push({
      name:  m[1],
      value: m[2] ? m[2].slice(1, -1) : null,  // strip surrounding parens
      from:  m.index,
      to:    m.index + m[0].length,
    });
  }
  return params;
}

// @-tag names with reserved meaning — never treated as plain context tags.
const RESERVED_AT = new Set([
  'done', 'cancelled', 'waiting', 'someday',
  'due', 'priority', 'defer', 'repeat',
]);

// ── Task @context decoration ────────────────────────────────────────────────
// Highlights bare @word tokens on task lines that are not reserved params.
const taskAtPlugin = ViewPlugin.fromClass(class {
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
        if (TASK_CB_RE.test(line.text)) {
          for (const p of parseAtParams(line.text)) {
            const reserved = RESERVED_AT.has(p.name.toLowerCase());
            if (reserved) {
              deco.push(Decoration.mark({ class: 'cm-at-param' })
                .range(line.from + p.from, line.from + p.to));
            } else if (p.value === null) {
              deco.push(Decoration.mark({ class: 'cm-at-context' })
                .range(line.from + p.from, line.from + p.to));
            }
          }
        }
        pos = line.to + 1;
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
const DUE_VALUE_RE  = /@due\(([^)]*)\)/;
const OVERDUE_RE    = /@overdue(?![a-zA-Z0-9_-])/;

export function doneStamp() {
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
          if (checked) {
            deco.push(Decoration.line({ class: 'cm-task-done-line' }).range(line.from));
          } else {
            const dueMatch = DUE_VALUE_RE.exec(line.text);
            if (OVERDUE_RE.test(line.text) || (dueMatch && isOverdue(dueMatch[1]))) {
              deco.push(Decoration.line({ class: 'cm-task-overdue' }).range(line.from));
            } else if (dueMatch && isDueToday(dueMatch[1])) {
              deco.push(Decoration.line({ class: 'cm-task-due-today' }).range(line.from));
            }
          }
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

const calcCommentMark = Decoration.mark({ class: 'cm-calc-comment' });

export const calcBlockPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged) this.decorations = this._build(u.view);
  }
  _build(view) {
    const doc   = view.state.doc;
    const text  = doc.toString();
    const { results, headerLines, commentLines } = scanCalcBlocks(text);

    const deco = [];

    for (const { from, to } of view.visibleRanges) {
      let pos = from;
      while (pos <= to) {
        const line = doc.lineAt(pos);

        if (headerLines.has(line.number)) {
          deco.push(Decoration.line({ class: 'cm-calc-header' }).range(line.from));
        } else if (commentLines.has(line.number)) {
          deco.push(Decoration.line({ class: 'cm-calc-expr cm-calc-comment' }).range(line.from));
        } else if (results.has(line.number)) {
          const res = results.get(line.number);
          deco.push(Decoration.line({ class: 'cm-calc-expr' }).range(line.from));
          // Mark inline comment portion (from ';' to end of line text).
          const lineText = doc.sliceString(line.from, line.to);
          const semiIdx  = lineText.indexOf(';');
          if (semiIdx >= 0) {
            deco.push(calcCommentMark.range(line.from + semiIdx, line.to));
          }
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

let _allPages     = [];
let _pageTitleSet = new Set();
let _journalDates = [];   // YYYY-MM-DD strings from list_journal_dates

export function setEditorPages(pages) {
  _allPages     = pages;
  _pageTitleSet = new Set(pages.map(p => p.title));
}

export function setEditorJournalDates(dates) {
  // Keep sorted descending (most-recent first) so autocomplete shows newest dates at top.
  _journalDates = [...dates].sort().reverse();
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

// ── Module-level click resolvers (shared by createEditor + createTasksEditor) ──

// Resolve a [[wiki link]] title at a given document position, or null.
// Constrained to the current line so cross-line false positives are impossible.
function wikiTitleAt(view, pos) {
  const line    = view.state.doc.lineAt(pos);
  const text    = line.text;
  const linePos = pos - line.from;

  let s = linePos;
  while (s > 1 && !(text[s - 2] === '[' && text[s - 1] === '[')) s--;
  if (s < 2) return null;
  s -= 2;

  if (text.slice(s + 2, linePos).includes(']]')) return null;

  let e = linePos;
  while (e + 1 < text.length && !(text[e] === ']' && text[e + 1] === ']')) e++;
  if (!(text[e] === ']' && text[e + 1] === ']')) return null;

  return text.slice(s + 2, e).trim() || null;
}

// Resolve a CamelCase link at a given document position, or null.
// Only matches if a page with that title actually exists.
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

// ── Journal placeholder ────────────────────────────────────────────────────
// Reconfigure via placeholderCompartment.reconfigure(placeholder('…')) or []
export const placeholderCompartment = new Compartment();

function wikiLinkSource(context) {
  const match = context.matchBefore(/\[\[[^\]]*$/);
  if (!match) return null;
  // Trim leading spaces so "[[ foo" matches pages starting with "foo".
  // If nothing remains after trimming (e.g. "[[" or "[[ "), don't suggest —
  // this prevents an immediate space from completing the first item.
  const query = match.text.slice(2).trimStart().toLowerCase();
  if (!query) return null;
  const pageOptions = _allPages
    .filter(p => p.title.toLowerCase().startsWith(query))
    .map(p => ({
      label:  p.title,
      detail: '[[link]]',
      apply(view, _completion, _from, to) {
        const insert = `[[${p.title}]] `;
        view.dispatch({
          changes: { from: match.from, to, insert },
          selection: { anchor: match.from + insert.length },
          userEvent: 'input.complete',
        });
      },
    }));

  const journalOptions = _journalDates
    .filter(d => d.startsWith(query))
    .map(d => ({
      label:  d,
      detail: 'journal',
      apply(view, _completion, _from, to) {
        const insert = `[[${d}]] `;
        view.dispatch({
          changes: { from: match.from, to, insert },
          selection: { anchor: match.from + insert.length },
          userEvent: 'input.complete',
        });
      },
    }));

  const options = [...pageOptions, ...journalOptions].slice(0, 12);
  return { from: match.from + 2, options, validFor: /^[^\]]*$/ };
}

// ── Special-block registry ─────────────────────────────────────────────────
//
// Maps a block header line (exact trimmed text) to a block-type name.
// Any block type listed here suppresses markdown key continuation (Enter,
// Backspace) for lines inside that block, and can be used by other subsystems
// (syntax highlighting, language plugins, etc.) as an extension point.
//
// To add a new block type — e.g. Mermaid diagrams — add an entry here:
//   '```mermaid': 'mermaid',
// and handle 'mermaid' wherever getSpecialBlockType() is consumed.
const SPECIAL_BLOCKS = {
  '@calc': 'calc',
};

/**
 * Return the special-block type name if the cursor is currently inside a
 * registered special block, or null if it is not.
 *
 * Detection walks backward from the cursor line.  A blank line terminates the
 * search (blank lines close MI special blocks).  The first matching header wins.
 *
 * @param {import('@codemirror/state').EditorState} state
 * @returns {string|null}
 */
export function getSpecialBlockType(state) {
  const lineNo = state.doc.lineAt(state.selection.main.head).number;
  for (let n = lineNo; n >= 1; n--) {
    const t = state.doc.line(n).text.trim();
    if (t in SPECIAL_BLOCKS) return SPECIAL_BLOCKS[t];
    if (t === '') return null;
  }
  return null;
}

// ── Special-block Enter guard ──────────────────────────────────────────────
// Inside a special block (e.g. @calc), Enter must insert a plain newline
// rather than triggering markdown continuation (list markers, blockquotes,
// indentation).  Registered at Prec.highest so it runs before markdown()'s
// insertNewlineContinueMarkup (which is Prec.high).
//
// Include this in any editor that uses markdown() and may contain @calc blocks.
// In editors that also have autocompletion(), place this AFTER autocompletion()
// in the extensions array so acceptCompletion gets priority when a popup is open.

export const specialBlockEnterKey = Prec.highest(keymap.of([
  {
    key: 'Enter',
    run(view) {
      if (!getSpecialBlockType(view.state)) return false;
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: '\n' },
        selection: { anchor: from + 1 },
        scrollIntoView: true,
        userEvent: 'input',
      });
      return true;
    },
  },
]));

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
    run(view) {
      // Expand a lone '[' at the start of a line into '[ ] ' so the user can
      // immediately start typing a task description.
      const { from, to } = view.state.selection.main;
      if (from === to) {
        const line = view.state.doc.lineAt(from);
        if (from - line.from === 1 && line.text[0] === '[') {
          view.dispatch({
            changes:   { from: line.from, to: from, insert: '[ ] ' },
            selection: { anchor: line.from + 4 },
            userEvent: 'input',
          });
          return true;
        }
      }
      return acceptCompletion(view);
    },
  };

  const clickHandler = EditorView.domEventHandlers({
    click(event, view) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const title = wikiTitleAt(view, pos) || camelTitleAt(view, pos);
      if (!title) return false;
      if (event.metaKey || event.ctrlKey) {
        onCmdClick(title);
      } else {
        onPageClick(title, { x: event.clientX, y: event.clientY });
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
      hrPlugin,
      linkPlugin,
      urlPlugin,
      fencedCodePlugin,
      inlineCodePlugin,
      annotationPlugin,
      taskAtPlugin,
      taskCheckboxPlugin,
      calcBlockPlugin,
      specialBlockEnterKey,
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

// ── Read-only pseudo-page editor ─────────────────────────────────────────────
// A read-only CM6 instance for pseudo-pages that display formatted markdown
// with clickable wiki links but no editing.

export function createReadOnlyEditor({ parent, onPageClick }) {
  const clickHandler = EditorView.domEventHandlers({
    click(event, view) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const title = wikiTitleAt(view, pos) || camelTitleAt(view, pos);
      if (!title) return false;
      onPageClick(title);
      return true;
    },
  });

  const state = EditorState.create({
    doc: '',
    extensions: [
      EditorState.readOnly.of(true),
      markdown({ base: { parser: markdownLanguage.parser.configure({ remove: ['SetextHeading'] }) } }),
      syntaxHighlighting(miHighlightStyle),
      wikilinkPlugin,
      camelLinkPlugin,
      hashtagPlugin,
      EditorView.lineWrapping,
      clickHandler,
      miTheme,
      EditorView.theme({
        '&':            { height: '100%' },
        '.cm-scroller': { overflow: 'auto', padding: '1.5rem 2rem' },
      }),
    ],
  });

  return new EditorView({ state, parent });
}

// ── Tasks pseudo-page editor ─────────────────────────────────────────────────
// A read-write CM6 instance sharing all visual extensions with the main editor.
// Enter is blocked (task lines only; no new-line creation from the view).
// checkboxClickHandler + autoDoneStampListener are included so the checkbox
// experience is identical.  onUpdate receives every ViewUpdate where the doc
// changed; the caller drives write-back.  onPageClick is called for wiki-link
// clicks.

// ── Task priority badge decoration (tasks pseudo-page only) ─────────────────
// Renders a small circular badge before each task line showing effective
// priority.  `getPriority(lineNo)` returns a number or undefined.

class PriorityBadgeWidget extends WidgetType {
  constructor(priority) { super(); this.priority = priority; }
  eq(other) { return this.priority === other.priority; }
  toDOM() {
    const el = priorityPillDOM(this.priority);
    el.className = 'cm-priority-badge';
    return el;
  }
}

export function createTaskPriorityPlugin(getPriority) {
  return ViewPlugin.fromClass(class {
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
          if (TASK_CB_RE.test(line.text)) {
            const p = getPriority(line.number);
            if (p != null) {
              deco.push(Decoration.widget({ widget: new PriorityBadgeWidget(p), side: -1 })
                .range(line.from));
            }
          }
          pos = line.to + 1;
        }
      }
      return Decoration.set(deco, true);
    }
  }, { decorations: v => v.decorations });
}


// Indents ### section headers and the tasks beneath them using the
// --taskview-section-indent CSS variable, so themes can control it.
const tasksIndentPlugin = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged) this.decorations = this._build(u.view);
  }
  _build(view) {
    const deco      = [];
    const doc       = view.state.doc;
    let   inSection = false; // true once a ### heading has been seen under the current ##
    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const text = line.text;
      if      (text.startsWith('## '))  { inSection = false; }
      else if (text.startsWith('### ')) { inSection = true;
        deco.push(Decoration.line({ class: 'cm-tv-indented' }).range(line.from)); }
      else if (TASK_CB_RE.test(text))   {
        deco.push(Decoration.line({ class: inSection ? 'cm-tv-task' : 'cm-tv-task-root' }).range(line.from)); }
    }
    return Decoration.set(deco, true);
  }
}, { decorations: v => v.decorations });

export function createTasksEditor({ parent, onUpdate, onPageClick, priorityPlugin }) {
  // Uses module-level wikiTitleAt + camelTitleAt for consistent link resolution.
  const clickHandler = EditorView.domEventHandlers({
    click(event, view) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const title = wikiTitleAt(view, pos) || camelTitleAt(view, pos);
      if (!title) return false;
      onPageClick(title);
      return true;
    },
  });

  const tasksUpdateListener = EditorView.updateListener.of(update => {
    if (update.docChanged) onUpdate(update);
  });

  const state = EditorState.create({
    doc: '',
    extensions: [
      history(),
      drawSelection(),
      markdown({ base: { parser: markdownLanguage.parser.configure({ remove: ['SetextHeading'] }) } }),
      syntaxHighlighting(tasksHighlightStyle),
      wikilinkPlugin,
      camelLinkPlugin,
      hashtagPlugin,
      annotationPlugin,
      taskAtPlugin,
      taskCheckboxPlugin,
      autoDoneStampListener,
      ...(priorityPlugin ? [priorityPlugin] : []),
      tasksIndentPlugin,
      EditorView.lineWrapping,
      checkboxClickHandler,
      keymap.of([
        { key: 'Enter',     run: () => true },
        { key: 'Mod-Enter', run: () => true },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      miTheme,
      EditorView.theme({
        '&':            { height: '100%' },
        '.cm-scroller': { overflow: 'auto', padding: '1.5rem 2rem' },
        // ### section headers
        '.cm-tv-indented': { paddingLeft: 'var(--taskview-section-indent)' },
        // tasks under ### — checkbox aligns with ### text; badge hangs left as bullet
        '.cm-tv-task':     { paddingLeft: 'var(--taskview-section-indent)' },
        // tasks under ## with no ### — badge sits at content edge, checkbox at badge-gutter
        '.cm-tv-task-root': { paddingLeft: 'var(--taskview-badge-gutter)' },
        // badge hangs left by exactly its own width + right-margin in both cases
        '.cm-tv-task .cm-priority-badge':      { marginLeft: 'calc(-1 * var(--taskview-badge-gutter))' },
        '.cm-tv-task-root .cm-priority-badge': { marginLeft: 'calc(-1 * var(--taskview-badge-gutter))' },
      }),
      tasksUpdateListener,
      clickHandler,
    ],
  });

  return new EditorView({ state, parent });
}
