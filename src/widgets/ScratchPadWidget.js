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

// ── Dialog helper ─────────────────────────────────────────────────────────

function showAddTextDialog() {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className =
      'fixed inset-0 z-[10000] flex items-center justify-center bg-black/50';

    const card = document.createElement('div');
    card.className =
      'bg-olive-900 border border-olive-700 rounded-lg shadow-2xl p-5 w-80 flex flex-col gap-4';

    const title = document.createElement('h3');
    title.className = 'text-sm font-semibold text-olive-100 m-0';
    title.textContent = 'Add Text to Each Row';

    const makeField = (labelText, placeholder) => {
      const wrap = document.createElement('div');
      wrap.className = 'flex flex-col gap-1';
      const lbl = document.createElement('label');
      lbl.className = 'text-xs text-olive-400';
      lbl.textContent = labelText;
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = placeholder;
      input.className =
        'bg-olive-800 border border-olive-600 rounded px-2 py-1 text-xs ' +
        'text-olive-100 placeholder-olive-600 outline-none ' +
        'focus:border-amber-500 focus:ring-1 focus:ring-amber-500';
      wrap.appendChild(lbl);
      wrap.appendChild(input);
      return { wrap, input };
    };

    const { wrap: beginWrap, input: beginInput } = makeField('Add to the Beginning', 'Prefix…');
    const { wrap: endWrap,   input: endInput   } = makeField('Add to the End',       'Suffix…');

    const buttons = document.createElement('div');
    buttons.className = 'flex justify-end gap-2';

    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.className =
      'px-3 py-1 text-xs rounded bg-olive-700 text-olive-300 ' +
      'hover:bg-olive-600 border-none cursor-pointer';

    const ok = document.createElement('button');
    ok.textContent = 'Apply';
    ok.className =
      'px-3 py-1 text-xs rounded bg-amber-600 text-white ' +
      'hover:bg-amber-500 border-none cursor-pointer';

    const close = result => { overlay.remove(); resolve(result); };

    cancel.addEventListener('click', () => close(null));
    ok.addEventListener('click',     () => close({ prefix: beginInput.value, suffix: endInput.value }));

    overlay.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); close({ prefix: beginInput.value, suffix: endInput.value }); }
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
    });

    buttons.appendChild(cancel);
    buttons.appendChild(ok);
    card.appendChild(title);
    card.appendChild(beginWrap);
    card.appendChild(endWrap);
    card.appendChild(buttons);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    beginInput.focus();
  });
}

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
  null, // separator
  {
    label: 'Add text to each row',
    fn: async text => {
      const result = await showAddTextDialog();
      if (result === null) return text;
      const { prefix, suffix } = result;
      return text.split('\n').map(line => prefix + line + suffix).join('\n');
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
