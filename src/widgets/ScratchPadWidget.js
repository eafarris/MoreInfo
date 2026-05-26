import { invoke } from '../tauri.js';
import { Widget } from './Widget.js';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
} from '@codemirror/view';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import {
  syntaxHighlighting,
  indentOnInput,
  bracketMatching,
} from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { miTheme, miHighlightStyle, calcBlockPlugin, calcCopyHandler, specialBlockEnterKey } from '../editor.js';

// ── Text transforms ────────────────────────────────────────────────────────

const TRANSFORMS = [
  {
    label: 'Sort lines',
    fn: text => text.split('\n').sort((a, b) => a.localeCompare(b)).join('\n'),
  },
  {
    label: 'Deduplicate',
    fn: text => [...new Set(text.split('\n'))].join('\n'),
  },
  {
    label: 'MD quote',
    fn: text => text.split('\n').map(l => '> ' + l).join('\n'),
  },
  {
    label: 'Remove linebreaks',
    fn: text => text.split('\n').map(l => l.trim()).filter(Boolean).join(' '),
  },
  {
    label: 'Remove extra whitespace',
    fn: text => text.replace(/[ \t]+/g, ' ').trim(),
  },
  null, // separator
  {
    label: 'Simple quotes',
    fn: text => text
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"'),
  },
  {
    label: 'Smart quotes',
    fn: text => text
      // Apostrophes in contractions/possessives first (between word chars).
      .replace(/(\w)'(\w)/g, '$1’$2')
      // Opening singles: after whitespace, open bracket, or line start.
      .replace(/(^|[\s(\[{])'(?=\S)/gm, '$1‘')
      // Remaining singles → closing.
      .replace(/'/g, '’')
      // Opening doubles: after whitespace, open bracket, or line start.
      .replace(/(^|[\s(\[{])"(?=\S)/gm, '$1“')
      // Remaining doubles → closing.
      .replace(/"/g, '”'),
  },
  null, // separator
  {
    label: 'MD to HTML',
    fn: async text => {
      const html = await invoke('parse_markdown', { markdown: text });
      return html;
    },
  },
];

export class ScratchPadWidget extends Widget {
  constructor() {
    super({ id: 'scratchPad', title: 'Scratch Pad', icon: 'ph-pencil-simple' });
    this._editor    = null;
    this._saveTimer = null;
    this._menuClose = null; // cleanup fn for the open actions menu
  }

  get wrapperClass() { return 'flex flex-col min-h-0 border-t border-olive-700'; }

  get headerAction() {
    return `<button class="sp-actions-btn text-olive-600 hover:text-olive-400 p-0.5 leading-none
                            bg-transparent border-none cursor-pointer" title="Transform…">
      <i class="ph ph-magic-wand text-sm leading-none"></i>
    </button>`;
  }

  onMount() {
    const updateListener = EditorView.updateListener.of(update => {
      if (!update.docChanged) return;
      clearTimeout(this._saveTimer);
      this._saveTimer = setTimeout(() => {
        invoke('write_scratchpad', { content: update.state.doc.toString() })
          .catch(e => console.error('[ScratchPad] save failed:', e));
      }, 500);
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
        EditorView.lineWrapping,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        calcBlockPlugin,
        calcCopyHandler,
        specialBlockEnterKey,
        miTheme,
        updateListener,
      ],
    });

    this._editor = new EditorView({ state, parent: this._body });

    invoke('read_scratchpad')
      .then(content => {
        if (!content) return;
        this._editor.dispatch({
          changes: { from: 0, to: this._editor.state.doc.length, insert: content },
        });
      })
      .catch(e => console.error('[ScratchPad] load failed:', e));

    const actionsBtn = this._container.querySelector('.sp-actions-btn');
    actionsBtn?.addEventListener('click', e => {
      e.stopPropagation();
      this._toggleActionsMenu(actionsBtn);
    });
  }

  onDestroy() {
    this._closeActionsMenu();
    clearTimeout(this._saveTimer);
    this._editor?.destroy();
    this._editor = null;
  }

  // ── Actions menu ───────────────────────────────────────────────────────────

  _toggleActionsMenu(anchor) {
    // If already open, close it.
    if (document.querySelector('.sp-actions-menu')) {
      this._closeActionsMenu();
      return;
    }

    const menu = document.createElement('div');
    menu.className =
      'sp-actions-menu fixed z-[9999] bg-olive-900 border border-olive-700 ' +
      'rounded-md shadow-xl py-1 min-w-[11rem]';

    for (const action of TRANSFORMS) {
      if (action === null) {
        const sep = document.createElement('div');
        sep.className = 'my-1 border-t border-olive-800';
        menu.appendChild(sep);
        continue;
      }

      const btn = document.createElement('button');
      btn.className =
        'w-full text-left px-3 py-1.5 text-xs text-olive-300 ' +
        'hover:bg-olive-700 hover:text-olive-100 ' +
        'bg-transparent border-none cursor-pointer block transition-colors';
      btn.textContent = action.label;
      btn.addEventListener('click', () => this._applyTransform(action.fn));
      menu.appendChild(btn);
    }

    document.body.appendChild(menu);

    // Position: right-align to anchor button, just below the header.
    const rect = anchor.getBoundingClientRect();
    menu.style.top   = `${rect.bottom + 4}px`;
    menu.style.right = `${window.innerWidth - rect.right}px`;

    // Close on any outside click (capture phase so it beats other handlers).
    const onOutside = e => {
      if (!menu.contains(e.target) && e.target !== anchor) {
        this._closeActionsMenu();
      }
    };
    document.addEventListener('click', onOutside, true);
    this._menuClose = () => {
      menu.remove();
      document.removeEventListener('click', onOutside, true);
      this._menuClose = null;
    };
  }

  _closeActionsMenu() {
    this._menuClose?.();
  }

  async _applyTransform(fn) {
    this._closeActionsMenu();
    if (!this._editor) return;
    const content = this._editor.state.doc.toString();
    const result  = await fn(content);
    this._editor.dispatch({
      changes: { from: 0, to: this._editor.state.doc.length, insert: result },
    });
    this._editor.focus();
  }
}
