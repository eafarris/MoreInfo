use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// A typed front-matter value.
///
/// Serialises as a tagged object so the JS side can branch on `.type`:
///   `{ type: "text",  value: "Hello" }`
///   `{ type: "date",  value: "2024-01-15" }`
///   `{ type: "array", value: ["one", "two"] }`
///   `{ type: "bool",  value: true }`
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "lowercase")]
pub enum Value {
    Text(String),
    /// ISO 8601 date string (YYYY-MM-DD). Validated but stored verbatim.
    Date(String),
    Array(Vec<String>),
    Bool(bool),
}

pub type FrontMatter = HashMap<String, Value>;

// ── Public API ────────────────────────────────────────────────────────────────

/// Parse front-matter from `content` and return a merged map.
///
/// Metadata is read from two locations only:
///
/// 1. **Leading block** – an optional `^---$` … `^---$` pair that begins on
///    the very first line of the document.  Any `---` pairs appearing later
///    in the file are ignored; they render as thematic breaks (`<hr>`).
///
/// 2. **Sig block** – the *last* line matching `^-- $` (note the trailing
///    space) acts like an email `.sig` delimiter.  Everything from the next
///    line to EOF is treated as a metadata block with no closing delimiter.
///
/// The sig block has the highest precedence: its keys override the front block.
pub fn parse(content: &str) -> FrontMatter {
    let mut result = FrontMatter::new();
    let (dashed_region, sig_region) = split_sig(content);

    if let Some(pairs) = front_block(dashed_region) {
        for (k, v) in pairs {
            result.insert(k, v);
        }
    }

    if let Some(sig) = sig_region {
        for (k, v) in parse_pairs(sig) {
            result.insert(k, v);
        }
    }

    result
}

/// Return a copy of `content` with front-matter removed, ready for Markdown
/// rendering.  Only the leading `---…---` block and the sig block are removed;
/// any other `---` lines remain in place and render as thematic breaks.
pub fn strip(content: &str) -> String {
    let (dashed_region, _) = split_sig(content);
    let lines: Vec<&str> = dashed_region.lines().collect();

    // Remove a leading ---…--- block if present.
    if lines.first() == Some(&"---") {
        if let Some(rel) = lines[1..].iter().position(|l| *l == "---") {
            // Skip the opening ---, the block content, and the closing ---.
            return lines[rel + 2..].join("\n");
        }
        // Unmatched opening --- at top: leave it in place (renders as <hr>).
    }

    dashed_region.to_string()
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Split `content` at the *last* `^-- $` line.
/// Returns `(before, Some(after))` or `(content, None)` if no sig line exists.
fn split_sig(content: &str) -> (&str, Option<&str>) {
    let mut last_sig_byte: Option<usize> = None;
    let mut byte_offset: usize = 0;

    for line in content.lines() {
        if line == "-- " {
            last_sig_byte = Some(byte_offset);
        }
        // +1 for '\n'; lines() strips the newline.
        byte_offset += line.len() + 1;
    }

    match last_sig_byte {
        None => (content, None),
        Some(start) => {
            let before = &content[..start];
            // Skip the "-- \n" line itself (3 bytes for "-- " + 1 for '\n').
            let after_start = (start + 4).min(content.len());
            let after = &content[after_start..];
            (before, Some(after))
        }
    }
}

/// Parse the leading `---…---` block from `region`, if present.
/// Returns `None` if the document does not begin with `---`.
fn front_block(region: &str) -> Option<Vec<(String, Value)>> {
    let lines: Vec<&str> = region.lines().collect();
    if lines.first() != Some(&"---") {
        return None;
    }
    let close = lines[1..].iter().position(|l| *l == "---")?;
    Some(parse_pairs_slice(&lines[1..1 + close]))
}

// ── Value parsing ─────────────────────────────────────────────────────────────

fn parse_pairs(text: &str) -> Vec<(String, Value)> {
    let lines: Vec<&str> = text.lines().collect();
    parse_pairs_slice(&lines)
}

fn parse_pairs_slice(lines: &[&str]) -> Vec<(String, Value)> {
    let mut pairs = Vec::new();
    for &line in lines {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // Strip unordered list markers so metadata can be written as a list.
        let line = line
            .strip_prefix("- ")
            .or_else(|| line.strip_prefix("* "))
            .or_else(|| line.strip_prefix("+ "))
            .unwrap_or(line)
            .trim_start();
        if let Some(colon) = line.find(':') {
            let raw_key = line[..colon].trim().to_ascii_lowercase();
            let key     = singularize(&raw_key);
            let raw     = line[colon + 1..].trim();
            if !key.is_empty() {
                pairs.push((key, parse_value(raw)));
            }
        }
    }
    pairs
}

// ── Key singularization ───────────────────────────────────────────────────────

/// Normalise a metadata key to its singular form.
///
/// The input must already be lowercase.  The function is idempotent:
/// `singularize("room") == "room"`.
///
/// This allows users to write either `room:` or `rooms:`, `child:` or
/// `children:`, etc. — both are stored under the singular key.
fn singularize(word: &str) -> String {
    // ── Irregular plurals ─────────────────────────────────────────────────────
    // Words whose plural cannot be derived by suffix rules.
    const IRREGULAR: &[(&str, &str)] = &[
        ("aliases",   "alias"),    // reserved MI key
        ("children",  "child"),
        ("people",    "person"),
        ("men",       "man"),
        ("women",     "woman"),
        ("mice",      "mouse"),
        ("geese",     "goose"),
        ("feet",      "foot"),
        ("teeth",     "tooth"),
        ("oxen",      "ox"),
        ("alumni",    "alumnus"),
        ("syllabi",   "syllabus"),
        ("cacti",     "cactus"),
        ("fungi",     "fungus"),
        ("nuclei",    "nucleus"),
        ("radii",     "radius"),
        ("stimuli",   "stimulus"),
        ("criteria",  "criterion"),
        ("phenomena", "phenomenon"),
        ("indices",   "index"),
        ("vertices",  "vertex"),
        ("matrices",  "matrix"),
    ];
    for &(plural, singular) in IRREGULAR {
        if word == plural {
            return singular.to_string();
        }
    }

    // ── Invariant / uncountable words ─────────────────────────────────────────
    // These look like plurals under certain rules but are not.
    const INVARIANT: &[&str] = &[
        // Already singular — protect from -s stripping
        "alias", "status", "virus", "corpus", "campus", "nexus",
        "census", "bonus", "focus", "circus", "toss",
        // -is words (axis, basis, …)
        "axis", "basis", "crisis", "thesis", "analysis", "diagnosis",
        "oasis", "ellipsis", "emphasis", "hypothesis", "synthesis",
        // Pluralia tantum / invariant
        "series", "species", "means", "news", "crossroads",
        "physics", "economics", "mathematics", "politics", "athletics",
        "data", "chess", "tennis",
    ];
    if INVARIANT.contains(&word) {
        return word.to_string();
    }

    // ── Suffix rules (longest-match first) ───────────────────────────────────

    // *ies → *y   hobbies→hobby  categories→category  priorities→priority
    // Guard: len ≥ 5 keeps short words ("dies","lies","ties") unchanged.
    if word.ends_with("ies") && word.len() >= 5 {
        return format!("{}y", &word[..word.len() - 3]);
    }

    // *sses → *ss  masses→mass  classes→class  addresses→address
    if word.ends_with("sses") {
        return word[..word.len() - 2].to_string();
    }

    // *ches → *ch  churches→church  witches→witch  watches→watch
    if word.ends_with("ches") {
        return word[..word.len() - 2].to_string();
    }

    // *shes → *sh  washes→wash  dishes→dish  bushes→bush
    if word.ends_with("shes") {
        return word[..word.len() - 2].to_string();
    }

    // *xes → *x   boxes→box  foxes→fox  taxes→tax
    if word.ends_with("xes") {
        return word[..word.len() - 2].to_string();
    }

    // General *s → drop the s.
    // Skip when the stem ends with a pattern that signals the word is already
    // singular or that stripping would produce a non-word:
    //   ss  →  grass, chess (also caught by invariant list)
    //   is  →  tennis, axis
    //   us  →  bonus, campus, virus (also caught by invariant list)
    if word.ends_with('s') && word.len() >= 3 {
        let stem = &word[..word.len() - 1];
        if !stem.ends_with("ss") && !stem.ends_with("is") && !stem.ends_with("us") {
            return stem.to_string();
        }
    }

    word.to_string()
}

fn parse_value(raw: &str) -> Value {
    // 1. Bracket-array: ['a','b'], ["a","b"], or [a, b, c] (unquoted).
    //    try_parse_array handles the quoted forms; the unquoted fallback strips
    //    the brackets and applies the same comma-split used in step 4 below.
    if raw.starts_with('[') && raw.ends_with(']') {
        if let Some(arr) = try_parse_array(raw) {
            return Value::Array(arr);
        }
        let inner = raw[1..raw.len() - 1].trim();
        let items: Vec<String> = inner
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        return Value::Array(items);
    }

    // 2. Quoted string: "…" or '…'
    //    Strips the outer quotes and returns Text, letting values that contain
    //    commas opt out of the comma-list heuristic below.
    let b = raw.as_bytes();
    if raw.len() >= 2
        && ((b[0] == b'"' && b[raw.len() - 1] == b'"')
            || (b[0] == b'\'' && b[raw.len() - 1] == b'\''))
    {
        return Value::Text(raw[1..raw.len() - 1].to_string());
    }

    // 3. Boolean literals (case-insensitive, unquoted).
    //    Checked before comma-list and date so these words are never
    //    misclassified as plain text.  To use one as a literal string,
    //    the author must quote it (e.g. `status: "true"`).
    match raw.to_ascii_lowercase().as_str() {
        "true"  | "t" | "yes" | "y" | "on"  | "1" => return Value::Bool(true),
        "false" | "f" | "no"  | "n" | "off" | "0" => return Value::Bool(false),
        _ => {}
    }

    // 4. Comma-delimited list → Array  (e.g. `one, two, three`)
    if raw.contains(',') {
        let items: Vec<String> = raw
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        return Value::Array(items);
    }

    // 5. ISO 8601 date: YYYY-MM-DD
    if is_date(raw) {
        return Value::Date(raw.to_string());
    }

    // 6. Plain text
    Value::Text(raw.to_string())
}

/// Parse `['item one', 'item two']` style arrays (single or double quotes).
fn try_parse_array(raw: &str) -> Option<Vec<String>> {
    let s = raw.trim();
    if !s.starts_with('[') || !s.ends_with(']') {
        return None;
    }
    let inner = s[1..s.len() - 1].trim();
    if inner.is_empty() {
        return Some(Vec::new());
    }

    let mut items: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_string = false;
    let mut quote_char = '"';

    for ch in inner.chars() {
        if in_string {
            if ch == quote_char {
                items.push(current.clone());
                current.clear();
                in_string = false;
            } else {
                current.push(ch);
            }
        } else {
            match ch {
                '\'' | '"' => {
                    in_string = true;
                    quote_char = ch;
                }
                // Whitespace and commas are delimiters outside of strings.
                ',' | ' ' | '\t' => {}
                // Any other character outside a string means this isn't an
                // array literal we recognise.
                _ => return None,
            }
        }
    }

    if in_string {
        // Unclosed quote – don't treat as array.
        return None;
    }

    Some(items)
}

/// True if `s` looks like an ISO 8601 calendar date: `YYYY-MM-DD`.
fn is_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[0..4].iter().all(|c| c.is_ascii_digit())
        && b[4] == b'-'
        && b[5..7].iter().all(|c| c.is_ascii_digit())
        && b[7] == b'-'
        && b[8..10].iter().all(|c| c.is_ascii_digit())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn text(s: &str) -> Value {
        Value::Text(s.to_string())
    }
    fn date(s: &str) -> Value {
        Value::Date(s.to_string())
    }
    fn array(items: &[&str]) -> Value {
        Value::Array(items.iter().map(|s| s.to_string()).collect())
    }

    #[test]
    fn single_block_at_top() {
        let doc = "---\ntitle: Hello\ndate: 2024-03-01\n---\n\nBody text.";
        let fm = parse(doc);
        assert_eq!(fm["title"], text("Hello"));
        assert_eq!(fm["date"], date("2024-03-01"));
    }

    // ── bracket-array forms ───────────────────────────────────────────────────

    #[test]
    fn array_bracket_single_quoted() {
        let doc = "---\ntags: ['rust', 'tauri', 'markdown']\n---";
        let fm = parse(doc);
        assert_eq!(fm["tag"], array(&["rust", "tauri", "markdown"]));
    }

    #[test]
    fn array_bracket_double_quoted() {
        let doc = "---\ntags: [\"rust\", \"tauri\", \"markdown\"]\n---";
        let fm = parse(doc);
        assert_eq!(fm["tag"], array(&["rust", "tauri", "markdown"]));
    }

    #[test]
    fn array_bracket_unquoted() {
        // [one, two, three] — no quotes; brackets stripped, values trimmed.
        let doc = "---\ntags: [one, two, three]\n---";
        let fm = parse(doc);
        assert_eq!(fm["tag"], array(&["one", "two", "three"]));
    }

    #[test]
    fn array_bracket_unquoted_no_spaces() {
        let doc = "---\ntags: [alpha,beta,gamma]\n---";
        let fm = parse(doc);
        assert_eq!(fm["tag"], array(&["alpha", "beta", "gamma"]));
    }

    #[test]
    fn array_bracket_unquoted_extra_spaces() {
        let doc = "---\ntags: [ one , two , three ]\n---";
        let fm = parse(doc);
        assert_eq!(fm["tag"], array(&["one", "two", "three"]));
    }

    #[test]
    fn array_bracket_unquoted_single_item() {
        // Single-item unquoted bracket: [rust] — no comma, still an array.
        let doc = "---\ntags: [rust]\n---";
        let fm = parse(doc);
        assert_eq!(fm["tag"], array(&["rust"]));
    }

    #[test]
    fn array_bracket_empty() {
        let doc = "---\ntags: []\n---";
        let fm = parse(doc);
        assert_eq!(fm["tag"], array(&[]));
    }

    #[test]
    fn array_comma_delimited() {
        let doc = "---\ntags: one, two, three\n---";
        let fm = parse(doc);
        assert_eq!(fm["tag"], array(&["one", "two", "three"]));
    }

    #[test]
    fn array_comma_delimited_no_spaces() {
        let doc = "---\ntags: alpha,beta,gamma\n---";
        let fm = parse(doc);
        assert_eq!(fm["tag"], array(&["alpha", "beta", "gamma"]));
    }

    #[test]
    fn quoted_string_with_comma_is_text() {
        let doc = "---\ntitle: \"one, two, three\"\n---";
        let fm = parse(doc);
        assert_eq!(fm["title"], text("one, two, three"));
    }

    #[test]
    fn single_quoted_string_with_comma_is_text() {
        let doc = "---\ntitle: 'one, two, three'\n---";
        let fm = parse(doc);
        assert_eq!(fm["title"], text("one, two, three"));
    }

    #[test]
    fn plain_string_no_comma_is_text() {
        let doc = "---\nauthor: Jane Doe\n---";
        let fm = parse(doc);
        assert_eq!(fm["author"], text("Jane Doe"));
    }

    #[test]
    fn mid_document_block_is_ignored() {
        // A ---…--- pair that does not start on line 1 is NOT parsed as metadata.
        let doc = "# Heading\n\nSome prose.\n\n---\nauthor: Jane\n---\n\nMore prose.";
        let fm = parse(doc);
        assert!(!fm.contains_key("author"));
    }

    #[test]
    fn mid_document_block_stays_in_strip() {
        // Mid-document --- pairs are left intact so they render as <hr>.
        let doc = "# Heading\n\nProse.\n\n---\nauthor: Jane\n---\n\nMore.";
        let stripped = strip(doc);
        assert!(stripped.contains("---"));
        assert!(stripped.contains("Prose."));
        assert!(stripped.contains("More."));
    }

    #[test]
    fn sig_delimiter_overrides_front_block() {
        let doc = "---\ntitle: Draft\n---\n\nBody.\n\n-- \ntitle: Final";
        let fm = parse(doc);
        assert_eq!(fm["title"], text("Final"));
    }

    #[test]
    fn last_sig_delimiter_wins() {
        let doc = "-- \ntitle: First sig\n\nText.\n\n-- \ntitle: Last sig";
        let fm = parse(doc);
        assert_eq!(fm["title"], text("Last sig"));
    }

    #[test]
    fn strip_removes_front_block_and_sig() {
        let doc = "---\ntitle: Hi\n---\n\nBody.\n\n-- \nauthor: Me";
        let stripped = strip(doc);
        assert!(!stripped.contains("title:"));
        assert!(!stripped.contains("author:"));
        assert!(stripped.contains("Body."));
    }

    #[test]
    fn list_style_metadata() {
        let doc = "---\n- title: My Page\n- tags: one, two\n- favorite: true\n---";
        let fm = parse(doc);
        assert_eq!(fm["title"],    text("My Page"));
        assert_eq!(fm["tag"],      array(&["one", "two"]));  // "tags" → "tag"
        assert_eq!(fm["favorite"], Value::Bool(true));
    }

    #[test]
    fn list_markers_asterisk_and_plus() {
        let doc = "---\n* author: Jane\n+ date: 2026-03-23\n---";
        let fm = parse(doc);
        assert_eq!(fm["author"], text("Jane"));
        assert_eq!(fm["date"],   date("2026-03-23"));
    }

    #[test]
    fn keys_are_normalized_to_lowercase_and_singular() {
        // Keys are lowercased then singularized: "TAGS" → "tags" → "tag".
        let doc = "---\nTitle: My Page\nTAGS: one, two\nFavorite: true\n---";
        let fm = parse(doc);
        assert_eq!(fm["title"],    text("My Page"));
        assert_eq!(fm["tag"],      array(&["one", "two"]));
        assert_eq!(fm["favorite"], Value::Bool(true));
    }

    #[test]
    fn unmatched_opener_at_top_is_kept() {
        // An unmatched --- at the very top is not parsed as metadata and stays
        // in the stripped output (renders as <hr>).
        let doc = "---\ntitle: Hi\n\nBody.";
        let fm = parse(doc);
        assert!(!fm.contains_key("title"));
        let stripped = strip(doc);
        assert!(stripped.contains("---"));
        assert!(stripped.contains("Body."));
    }

    #[test]
    fn no_metadata_when_not_at_top() {
        let doc = "Body text.\n\n---\ntitle: Should be ignored\n---";
        let fm = parse(doc);
        assert!(fm.is_empty());
    }

    // ── singularize ───────────────────────────────────────────────────────────

    #[test]
    fn singularize_idempotent_on_singular() {
        for w in &["room", "child", "tag", "category", "award", "alias", "person",
                   "status", "series", "analysis", "tooth", "mouse"] {
            assert_eq!(singularize(w), *w, "singularize({w:?}) should be a no-op");
        }
    }

    #[test]
    fn singularize_simple_s() {
        assert_eq!(singularize("rooms"),   "room");
        assert_eq!(singularize("awards"),  "award");
        assert_eq!(singularize("tags"),    "tag");
        assert_eq!(singularize("events"),  "event");
        assert_eq!(singularize("projects"),"project");
    }

    #[test]
    fn singularize_ies_to_y() {
        assert_eq!(singularize("categories"),  "category");
        assert_eq!(singularize("hobbies"),     "hobby");
        assert_eq!(singularize("priorities"),  "priority");
        assert_eq!(singularize("activities"),  "activity");
        assert_eq!(singularize("dependencies"),"dependency");
    }

    #[test]
    fn singularize_sibilant_es() {
        assert_eq!(singularize("churches"),  "church");
        assert_eq!(singularize("watches"),   "watch");
        assert_eq!(singularize("dishes"),    "dish");
        assert_eq!(singularize("washes"),    "wash");
        assert_eq!(singularize("boxes"),     "box");
        assert_eq!(singularize("taxes"),     "tax");
        assert_eq!(singularize("classes"),   "class");
        assert_eq!(singularize("addresses"), "address");
    }

    #[test]
    fn singularize_irregulars() {
        assert_eq!(singularize("children"),  "child");
        assert_eq!(singularize("people"),    "person");
        assert_eq!(singularize("men"),       "man");
        assert_eq!(singularize("women"),     "woman");
        assert_eq!(singularize("mice"),      "mouse");
        assert_eq!(singularize("geese"),     "goose");
        assert_eq!(singularize("feet"),      "foot");
        assert_eq!(singularize("teeth"),     "tooth");
        assert_eq!(singularize("criteria"),  "criterion");
        assert_eq!(singularize("phenomena"), "phenomenon");
        assert_eq!(singularize("indices"),   "index");
        assert_eq!(singularize("alumni"),    "alumnus");
        assert_eq!(singularize("aliases"),   "alias");
    }

    #[test]
    fn singularize_invariant_words_unchanged() {
        for w in &["series", "species", "status", "virus", "analysis",
                   "basis", "axis", "tennis", "news", "data", "alias"] {
            assert_eq!(singularize(w), *w, "invariant word {w:?} should be unchanged");
        }
    }

    #[test]
    fn plural_key_stored_as_singular() {
        // "rooms: A, B" and "room: A, B" should produce the same key.
        let plural   = parse("---\nrooms: A, B\n---");
        let singular = parse("---\nroom: A, B\n---");
        assert!(plural.contains_key("room"),   "plural key 'rooms' should be stored as 'room'");
        assert!(singular.contains_key("room"), "singular key 'room' should be stored as 'room'");
        assert_eq!(plural["room"], singular["room"]);
    }

    #[test]
    fn irregular_plural_key_stored_as_singular() {
        let plural   = parse("---\nchildren: Alice, Bob\n---");
        let singular = parse("---\nchild: Alice\n---");
        assert!(plural.contains_key("child"),
            "plural key 'children' should be stored as 'child'");
        assert!(singular.contains_key("child"));
    }
}
