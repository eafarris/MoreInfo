import { Widget } from './Widget.js';

/**
 * Strip YAML-style front matter (---...---) and late-matter sig (-- \n...) from
 * raw markdown. Returns the cleaned text and whether any metadata was found.
 */
function stripMeta(text) {
  let out  = text;
  let found = false;

  // Front matter blocks: ---\n...\n--- (may appear anywhere in the document)
  out = out.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/gm, () => {
    found = true;
    return '\n';
  });

  // Late matter: a line starting with "-- " (email-sig convention) through EOF
  const sigIdx = out.search(/^-- \r?\n/m);
  if (sigIdx !== -1) {
    found = true;
    out = out.slice(0, sigIdx);
  }

  return { text: out.trim(), hadMeta: found };
}

/**
 * Strip common Markdown syntax so word and sentence counts reflect
 * prose content rather than markup characters.
 */
function toPlain(text) {
  return text
    .replace(/^#{1,6} /gm, '')                          // heading markers
    .replace(/^> /gm, '')                               // blockquote markers
    .replace(/^[-*+] /gm, '')                           // unordered list markers
    .replace(/^\d+\. /gm, '')                           // ordered list markers
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')          // [text](url) → text
    .replace(/\[\[([^\]|]*)(?:\|[^\]]*)?\]\]/g, '$1')  // [[page|alias]] → page
    .replace(/(\*\*|__)(.*?)\1/gs, '$2')                // bold
    .replace(/(\*|_)(.*?)\1/gs, '$2')                   // italic
    .replace(/~~(.*?)~~/gs, '$1')                       // strikethrough
    .replace(/`{3}[\s\S]*?`{3}/g, 'X')                 // fenced code blocks
    .replace(/`[^`]+`/g, 'X');                          // inline code
}

function countStats(raw) {
  if (!raw) return { paragraphs: 0, sentences: 0, words: 0, chars: 0 };

  const plain = toPlain(raw);

  const paragraphs = raw.split(/\n\s*\n/).filter(b => b.trim().length > 0).length;
  const words      = plain.split(/\s+/).filter(Boolean).length;

  // Sentence ends: punctuation followed by whitespace or end-of-string,
  // but not a lone decimal point (e.g. 3.14 shouldn't count).
  const sentences  = (plain.match(/[^\s\d][.!?]+(?=\s|$)/g) || []).length;

  // Characters without newlines (matches word-processor convention)
  const chars      = raw.replace(/\r?\n/g, '').length;

  return { paragraphs, sentences, words, chars };
}

function fmt(n) {
  return n.toLocaleString();
}

export class CounterWidget extends Widget {
  constructor() {
    super({ id: 'counter', title: 'Counter', icon: 'ph-text-aa' });
    this._hadMeta = false;
  }

  get wrapperClass() { return 'flex flex-col border-l border-olive-700'; }

  onMount() {
    this._render({ paragraphs: 0, sentences: 0, words: 0, chars: 0 }, false);
  }

  onFileOpen(path, content) {
    this._update(content);
  }

  onDocumentChange(content) {
    this._update(content);
  }

  _update(raw) {
    const { text, hadMeta } = stripMeta(raw);
    this._hadMeta = hadMeta;
    this._render(countStats(text), hadMeta);
  }

  _render({ paragraphs, sentences, words, chars }, hadMeta) {
    this._body.innerHTML = `
      <table class="w-full text-xs tabular-nums">
        <tbody>
          ${this._row('Paragraphs', paragraphs)}
          ${this._row('Sentences',  sentences)}
          ${this._row('Words',      words)}
          ${this._row('Characters', chars)}
        </tbody>
      </table>
      ${hadMeta
        ? `<p class="px-3 pt-1 pb-2 text-[10px] text-olive-600 italic">Not including metadata</p>`
        : ''}
    `;
  }

  _row(label, value) {
    return `
      <tr class="border-b border-olive-800 last:border-0">
        <td class="px-3 py-1.5 text-olive-500">${label}</td>
        <td class="px-3 py-1.5 text-right text-olive-200 font-medium">${fmt(value)}</td>
      </tr>`;
  }
}
