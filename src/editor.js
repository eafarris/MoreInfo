import {
  EditorState,
} from '@codemirror/state';
import {
  EditorView,
  ViewPlugin,
  Decoration,
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
import { autocompletion, closeBrackets, acceptCompletion } from '@codemirror/autocomplete';
import { tags } from '@lezer/highlight';

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
  '.cm-line': {
    padding: '0 0 1.25rem',
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

let _allPages = [];

export function setEditorPages(pages) { _allPages = pages; }

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
      apply(view, _completion, from, to) {
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
      view.dispatch(view.state.replaceSelection('  '));
      return true;
    },
  };

  const spaceKeymap = {
    key: 'Space',
    run: acceptCompletion,
  };

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
      const title = wikiTitleAt(view, pos);
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
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(miHighlightStyle),
      autocompletion({ override: [wikiLinkSource] }),
      wikilinkPlugin,
      hashtagPlugin,
      listMarkerPlugin,
      delimiterPlugin,
      linkPlugin,
      urlPlugin,
      inlineCodePlugin,
      EditorView.lineWrapping,
      surroundHandler,
      wikiLinkPunctHandler,
      keymap.of([
        tabKeymap,
        spaceKeymap,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      miTheme,
      updateListener,
      clickHandler,
    ],
  });

  return new EditorView({ state, parent });
}
