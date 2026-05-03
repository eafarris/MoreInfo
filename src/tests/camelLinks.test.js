import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { camelRe, camelToTitle, setCamelEnabled, isCamelEnabled } from '../camelLinks.js';

// Reset the enabled flag to the default (true) around every test so that tests
// don't bleed state into one another.
beforeEach(() => setCamelEnabled(true));
afterEach(()  => setCamelEnabled(true));

// ── camelToTitle ────────────────────────────────────────────────────────────

describe('camelToTitle', () => {
  it('splits a two-segment word', () => {
    expect(camelToTitle('HelloWorld')).toBe('Hello World');
  });

  it('splits a three-segment word', () => {
    expect(camelToTitle('AndersonContract')).toBe('Anderson Contract');
  });

  it('handles consecutive caps as separate segments', () => {
    // Each uppercase letter is treated as a boundary.
    expect(camelToTitle('MyPageTitle')).toBe('My Page Title');
  });

  it('leaves a single word unchanged', () => {
    // Single lowercase word — no uppercase other than the first letter.
    // camelToTitle inserts a space before every uppercase, so 'Hello' → ' Hello' → 'Hello' after trim.
    expect(camelToTitle('Hello')).toBe('Hello');
  });
});

// ── camelRe ─────────────────────────────────────────────────────────────────

describe('camelRe', () => {
  it('matches a valid CamelCase word', () => {
    expect('HelloWorld'.match(camelRe())).not.toBeNull();
  });

  it('matches multiple words in a string', () => {
    const matches = 'Refer to AndersonContract or MyPage for details'.match(camelRe());
    expect(matches).toEqual(['AndersonContract', 'MyPage']);
  });

  it('does not match a plain lowercase word', () => {
    expect('helloworld'.match(camelRe())).toBeNull();
  });

  it('matches WiFi — two valid segments (Wi + Fi)', () => {
    // WiFi has two camelCase segments, each with a lowercase run: Wi and Fi.
    expect('WiFi'.match(camelRe())).not.toBeNull();
  });

  it('does not match a word whose second segment has no lowercase letters (e.g. MacOS)', () => {
    // MacOS: "Mac" is a valid first segment, but "OS" has no lowercase — fails [a-z]+.
    expect('MacOS'.match(camelRe())).toBeNull();
  });

  it('does not match an all-caps acronym', () => {
    expect('HTML'.match(camelRe())).toBeNull();
  });

  it('does not match a single capitalised word like "Hello"', () => {
    // One uppercase followed by lowercase — only one segment, no match.
    expect('Hello'.match(camelRe())).toBeNull();
  });

  it('each call returns an independent regex (no shared lastIndex)', () => {
    const re1 = camelRe();
    const re2 = camelRe();
    re1.exec('HelloWorld');  // advances re1's lastIndex
    // re2 should still find from position 0
    expect(re2.exec('HelloWorld')?.[0]).toBe('HelloWorld');
  });
});

// ── setCamelEnabled / isCamelEnabled ────────────────────────────────────────

describe('setCamelEnabled / isCamelEnabled', () => {
  it('is enabled by default', () => {
    expect(isCamelEnabled()).toBe(true);
  });

  it('disables when set to false', () => {
    setCamelEnabled(false);
    expect(isCamelEnabled()).toBe(false);
  });

  it('re-enables when set back to true', () => {
    setCamelEnabled(false);
    setCamelEnabled(true);
    expect(isCamelEnabled()).toBe(true);
  });

  it('coerces truthy/falsy values', () => {
    setCamelEnabled(0);
    expect(isCamelEnabled()).toBe(false);
    setCamelEnabled(1);
    expect(isCamelEnabled()).toBe(true);
  });
});

// ── preprocessCamelLinks (pure logic, extracted for testing) ─────────────────
// The actual preprocessCamelLinks in main.js reads allPages from module scope,
// so we reproduce the core logic here against the shared utilities.

function preprocessCamelLinksCore(markdown, titleSet) {
  if (!isCamelEnabled()) return markdown;
  if (titleSet.size === 0) return markdown;

  const lines = markdown.split('\n');
  const out   = [];
  let inFence = false;
  let inCalc  = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inCalc && /^(`{3,}|~{3,})/.test(trimmed)) inFence = !inFence;
    if (!inFence) {
      if (trimmed === '@calc') inCalc = true;
      else if (inCalc && trimmed === '') inCalc = false;
    }
    if (inFence || inCalc) { out.push(line); continue; }

    const parts = line.split(/(\[\[[^\]]*\]\])/);
    out.push(parts.map((part, i) => {
      if (i % 2 === 1) return part;
      return part.replace(camelRe(), match => {
        const title = camelToTitle(match);
        return titleSet.has(title) ? `[[${title}]]` : match;
      });
    }).join(''));
  }
  return out.join('\n');
}

describe('preprocessCamelLinks (core logic)', () => {
  const pages = new Set(['Anderson Contract', 'My Page']);

  it('expands a known CamelCase word into a wiki link', () => {
    expect(preprocessCamelLinksCore('See AndersonContract for details.', pages))
      .toBe('See [[Anderson Contract]] for details.');
  });

  it('leaves an unknown CamelCase word untouched', () => {
    expect(preprocessCamelLinksCore('See UnknownPage here.', pages))
      .toBe('See UnknownPage here.');
  });

  it('does not double-expand an existing [[bracket]] link', () => {
    expect(preprocessCamelLinksCore('See [[Anderson Contract]] already.', pages))
      .toBe('See [[Anderson Contract]] already.');
  });

  it('skips lines inside a fenced code block', () => {
    const md = '```\nAndersonContract\n```';
    expect(preprocessCamelLinksCore(md, pages)).toBe(md);
  });

  it('skips lines inside a @calc block', () => {
    const md = '@calc\nAndersonContract + 1\n';
    expect(preprocessCamelLinksCore(md, pages)).toBe(md);
  });

  it('returns markdown unchanged when disabled', () => {
    setCamelEnabled(false);
    expect(preprocessCamelLinksCore('See AndersonContract.', pages))
      .toBe('See AndersonContract.');
  });

  it('expands again after re-enabling', () => {
    setCamelEnabled(false);
    setCamelEnabled(true);
    expect(preprocessCamelLinksCore('See AndersonContract.', pages))
      .toBe('See [[Anderson Contract]].');
  });
});

// ── renderTaskText (core logic, extracted for testing) ───────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const TOKEN_RE = /(\[\[[^\]]+\]\])|(@(?:due|defer|priority|done|overdue|waiting|someday)(?:\([^)]*\))?)|(@[a-zA-Z][a-zA-Z0-9_-]*)|(\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b)/g;

function renderTaskTextCore(raw, titleSet) {
  const parts = [];
  let last = 0, m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(raw)) !== null) {
    if (m.index > last) parts.push(esc(raw.slice(last, m.index)));
    const [full, wiki, atParam, atCtx, camel] = m;
    if (wiki) {
      const title = wiki.slice(2, -2);
      parts.push(`<span class="mi-tasks-wiki" data-title="${esc(title)}">${esc(full)}</span>`);
    } else if (atParam) {
      parts.push(`<span class="mi-tasks-at-param">${esc(full)}</span>`);
    } else if (atCtx) {
      parts.push(`<span class="mi-tasks-at-ctx">${esc(full)}</span>`);
    } else {
      const title = camelToTitle(camel);
      if (isCamelEnabled() && titleSet?.has(title)) {
        parts.push(`<span class="mi-tasks-wiki" data-title="${esc(title)}">${esc(camel)}</span>`);
      } else {
        parts.push(esc(camel));
      }
    }
    last = m.index + full.length;
  }
  if (last < raw.length) parts.push(esc(raw.slice(last)));
  return parts.join('');
}

describe('renderTaskText (core logic)', () => {
  const titles = new Set(['Anderson Contract']);

  it('renders a known CamelCase word as a wiki span', () => {
    const html = renderTaskTextCore('See AndersonContract', titles);
    expect(html).toContain('class="mi-tasks-wiki"');
    expect(html).toContain('data-title="Anderson Contract"');
    expect(html).toContain('AndersonContract');
  });

  it('renders an unknown CamelCase word as plain text', () => {
    const html = renderTaskTextCore('See UnknownPage', titles);
    expect(html).not.toContain('mi-tasks-wiki');
    expect(html).toContain('UnknownPage');
  });

  it('renders [[wiki links]] as clickable spans', () => {
    const html = renderTaskTextCore('See [[Anderson Contract]]', titles);
    expect(html).toContain('class="mi-tasks-wiki"');
    expect(html).toContain('data-title="Anderson Contract"');
  });

  it('does not linkify CamelCase when disabled', () => {
    setCamelEnabled(false);
    const html = renderTaskTextCore('See AndersonContract', titles);
    expect(html).not.toContain('mi-tasks-wiki');
    expect(html).toContain('AndersonContract');
  });

  it('still linkifies [[bracket]] links even when CamelCase is disabled', () => {
    setCamelEnabled(false);
    const html = renderTaskTextCore('See [[Anderson Contract]]', titles);
    expect(html).toContain('mi-tasks-wiki');
  });

  it('linkifies again after re-enabling', () => {
    setCamelEnabled(false);
    setCamelEnabled(true);
    const html = renderTaskTextCore('See AndersonContract', titles);
    expect(html).toContain('mi-tasks-wiki');
  });
});
