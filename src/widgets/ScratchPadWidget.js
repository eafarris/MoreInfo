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

export class ScratchPadWidget extends Widget {
  constructor() {
    super({ id: 'scratchPad', title: 'Scratch Pad', icon: 'ph-pencil-simple' });
    this._editor    = null;
    this._saveTimer = null;
  }

  get wrapperClass() { return 'flex flex-col min-h-0 border-t border-olive-700'; }

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
  }

  onDestroy() {
    clearTimeout(this._saveTimer);
    this._editor?.destroy();
    this._editor = null;
  }
}
