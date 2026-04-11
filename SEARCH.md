# MoreInfo Search

MoreInfo's full-text search indexes all wiki pages and journal entries. The SQLite FTS5 engine with the `unicode61` tokenizer handles indexing and querying. Templates are not indexed.

## How Indexing Works

The `unicode61` tokenizer splits document text on every non-alphanumeric character. Hyphens, slashes, dots, colons, underscores, and other punctuation all act as word delimiters. So a line like:

```
ansible-playbook -l cluster_acc deployment/install-updates.yml
```

is indexed as the tokens: `ansible`, `playbook`, `l`, `cluster`, `acc`, `deployment`, `install`, `updates`, `yml`.

## Default Search (bare words)

Typing bare words searches for all terms anywhere in the document (implicit AND). Each word is matched as a prefix, so partial words also match.

| Query | Matches |
|---|---|
| `install` | "install", "installation", "installer", … |
| `install updates` | pages containing both "install…" and "update…" anywhere |
| `install-updates` | same as `install updates` (hyphen becomes a delimiter) |
| `foo/bar` | same as `foo bar` |

## Exact Phrase Search

Wrapping a query in **double quotes** searches for that exact sequence of adjacent tokens. Punctuation within the phrase is still handled by the tokenizer (hyphens split into two adjacent tokens, which must appear adjacently in the document).

```
"install updates"
```

Matches pages where the token `install` is immediately followed by `updates`. Does **not** match pages where they appear in different sentences.

```
"ansible playbook"
```

Matches `ansible-playbook` in the source text because the tokenizer produces two adjacent tokens.

## NEAR Operator

`word NEAR word` (all-caps `NEAR`, with spaces on both sides) finds pages where the two terms appear **within 10 tokens of each other**, in either order.

```
install NEAR updates
```

Matches pages where `install` and `updates` appear within 10 words of each other.

```
deploy NEAR cluster NEAR ansible
```

Three or more terms can be chained. All listed terms must appear within 10 tokens of each other.

**Important:** `NEAR` must be in all uppercase. Lowercase `near` is treated as an ordinary search term.

| Query | Behavior |
|---|---|
| `install NEAR updates` | proximity search, within 10 tokens |
| `install near updates` | searches for all three words: "install", "near", "updates" |

## Operator Precedence / Combining

Currently, operators cannot be combined in a single query (e.g., you cannot mix `NEAR` with a quoted phrase). Each query uses exactly one mode:

1. If the query is wrapped in `"…"` → exact phrase mode.
2. Else if the query contains ` NEAR ` → proximity mode.
3. Otherwise → prefix word mode.

## Filter Operators

The general design is **Option C** (hybrid): a small set of reserved shorthand operators, with any other `key:value` token planned as an arbitrary metadata filter. Filters can be freely combined with text search operators in the same query.

### Source filters

- `in:journal` — restrict results to journal pages only
- `in:wiki` or `in:pages` — restrict results to wiki pages only

### Date filters — journal filenames only

`after:` and `before:` filter on the **journal page filename date** (`YYYY-MM-DD`), not on filesystem timestamps (created/modified). This is intentional: a journal page may be created or edited at any time, but its date is authoritative from its filename. Because only journal pages carry a filename date, these filters implicitly restrict results to journals (`in:journal` is not required alongside them).

```
after:2025-01-01
before:2025-06-01
after:2024-12-01 before:2025-03-01
```

Natural-language dates are planned (e.g., `after:last month`), parsed via chrono-node.

### Tag and category filters

`tag:` and `tags:` are synonyms. Both check array membership (case-insensitive, matching MI's tag storage).

- `tag:ops` — page has the tag "ops"
- `tags:ops` — same
- `tag:ops,ansible` — page has "ops" **or** "ansible" (comma-separated = implicit OR)
- `tags:ops,ansible` — same
- `tag:ops AND tag:ansible` — page has **both** tags (explicit AND; `AND` must be uppercase)

The `AND` binary operator only applies between two `tag:`/`tags:` filters. It is not a general boolean operator across other filter types (yet).

`tag:` requires array-membership logic rather than string equality, which is why it stays a named shorthand rather than mapping directly to the raw metadata key.

#### Tags with spaces

Because tags can contain spaces (e.g. `tags: tag one, two, three` → `['tag one', 'two', 'three']`), multi-word tag values are wrapped in quotes using a **colon-space** convention inside the quotes:

```
"tag: value one"
"tag: home automation"
"tags: value one,value two"
```

The parser disambiguates this from exact phrase search by checking whether the quoted string begins with a known operator keyword followed by `: ` (colon-space). The collision with phrase search is negligible — no one realistically searches for a phrase like `"tag: home automation"` as literal text. The `tag:"value one"` form is also accepted as an alternative.

This same convention extends to any filter with a multi-word value:

```
"cat: meeting notes"
"author: Eric Farris"
"project: home lab"
```

The disambiguation regex applied to quoted strings: `/^(tag|tags|cat|category|in|after|before|[a-z][a-z0-9_-]*):\s/i` — if it matches, it's a filter token, not a phrase search.

- `category:person` — category equals "person"
- `cat:person` — alias for `category:`

### Arbitrary metadata filters (planned)

Any `key:value` token that is not one of the reserved operator words above will be treated as a metadata filter: the page's metadata must contain a field named `key` with a value equal to `value` (case-sensitive for string fields; case-insensitive for tags).

```
author:eric
priority:high
status:done
project:homelab
```

Reserved operator words that cannot be used as metadata key names: `tag`, `tags`, `cat`, `category`, `after`, `before`, `in`. The infix operators `NEAR` and `AND` are also reserved (uppercase-only, so lowercase `near` and `and` are ordinary search terms).

### Fuzzy matching (planned)

A `~` prefix on a word enables approximate/fuzzy matching for that term. Not yet designed in detail.

## Implementation Notes

- FTS table: `fts` (columns: `path`, `title`, `body`)
- Tokenizer: `unicode61` — splits on all non-alphanumeric characters
- Snippet generation: `snippet(fts, 2, '', '', '…', 16)` (16-token window from the `body` column)
- Query building: `src-tauri/src/lib.rs` → `fn search_pages`
- Default result limit: 20 results, ordered by FTS5 rank
