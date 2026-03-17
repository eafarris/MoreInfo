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
    padding: '0',
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
  { tag: tags.link,            color: '#fbbf24'                                           },
  { tag: tags.url,             color: '#fbbf24', textDecoration: 'underline'              },
  { tag: tags.monospace,       color: 'oklch(73.7% 0.021 106.9)'  /* olive-400 */        },
  { tag: tags.meta,            color: 'oklch(46.6% 0.025 107.3)'  /* olive-600 */        },
  { tag: tags.comment,         color: 'oklch(46.6% 0.025 107.3)',  fontStyle: 'italic'   },
  { tag: tags.processingInstruction, color: 'oklch(46.6% 0.025 107.3)'                   },
  { tag: tags.contentSeparator, color: 'oklch(39.4% 0.023 107.4)' /* olive-700 */       },
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

// ── List item spacing ──────────────────────────────────────────────────────
// Adds bottom padding to list-item lines so bulleted/numbered lists breathe
// more than ordinary prose. Uses a regex scan rather than the syntax tree so
// decorations are always present, even before the parser finishes.

const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)]) /;

const listSpacingPlugin = ViewPlugin.fromClass(class {
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
        if (LIST_ITEM_RE.test(line.text)) {
          deco.push(Decoration.line({ class: 'cm-list-item' }).range(line.from));
        }
        pos = line.to + 1;
      }
    }
    return Decoration.set(deco, true);
  }
}, { decorations: v => v.decorations });

// ── Auto-surround keymap ───────────────────────────────────────────────────
// When text is selected and an opening char is typed, wrap the selection.

const WRAP_PAIRS = {
  '(': ')', '[': ']', '{': '}',
  '"': '"', "'": "'", '`': '`',
  '*': '*', '_': '_', '~': '~',
};

const wrapSelectionKeymap = Object.entries(WRAP_PAIRS).map(([open, close]) => ({
  key: open,
  run(view) {
    const { from, to } = view.state.selection.main;
    if (from === to) return false; // no selection — let normal insertion happen
    view.dispatch({
      changes: [{ from, insert: open }, { to, insert: close }],
      selection: { anchor: from + 1, head: to + 1 },
      userEvent: 'input',
    });
    return true;
  },
}));

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

export function createEditor({ parent, onDocChange, onCursorChange, onCmdClick }) {
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

  const cmdClickHandler = EditorView.domEventHandlers({
    click(event, view) {
      if (!event.metaKey && !event.ctrlKey) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      const doc = view.state.doc.toString();
      let start = pos;
      while (start > 1 && !(doc[start - 2] === '[' && doc[start - 1] === '[')) start--;
      if (start < 2) return false;
      start -= 2;
      let end = pos;
      while (end + 1 < doc.length && !(doc[end] === ']' && doc[end + 1] === ']')) end++;
      if (!(doc[end] === ']' && doc[end + 1] === ']')) return false;
      const title = doc.slice(start + 2, end).trim();
      if (title) { onCmdClick(title); return true; }
      return false;
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
      listSpacingPlugin,
      EditorView.lineWrapping,
      keymap.of([
        ...wrapSelectionKeymap,
        tabKeymap,
        spaceKeymap,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      miTheme,
      updateListener,
      cmdClickHandler,
    ],
  });

  return new EditorView({ state, parent });
}
