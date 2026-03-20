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

/// Parse all front-matter blocks in `content` and return a merged map.
///
/// Blocks are found in two ways:
///
/// 1. **Dashed blocks** – zero or more `^---$` … `^---$` pairs appearing
///    *anywhere* in the document.  Pairs are matched top-to-bottom; an
///    unmatched opening delimiter is ignored.
///
/// 2. **Sig block** – the *last* line matching `^-- $` (note the trailing
///    space) acts like an email `.sig` delimiter.  Everything from the next
///    line to EOF is treated as another metadata block with no closing
///    delimiter.
///
/// Later definitions override earlier ones, so the sig block has the highest
/// precedence.
pub fn parse(content: &str) -> FrontMatter {
    let mut result = FrontMatter::new();
    let (dashed_region, sig_region) = split_sig(content);

    for pairs in dashed_blocks(dashed_region) {
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

/// Return a copy of `content` with all front-matter blocks removed, ready for
/// Markdown rendering.  The sig delimiter line and everything after it are
/// also omitted.
pub fn strip(content: &str) -> String {
    let (dashed_region, _) = split_sig(content);
    let lines: Vec<&str> = dashed_region.lines().collect();
    let n = lines.len();
    let mut out: Vec<&str> = Vec::with_capacity(n);
    let mut i = 0;

    while i < n {
        if lines[i] == "---" {
            let search = (i + 1).min(n);
            if let Some(rel) = lines[search..n].iter().position(|l| *l == "---") {
                // Skip the whole block including both delimiters.
                i = search + rel + 1;
            } else {
                // Unmatched opener – keep as-is (will render as an <hr>).
                out.push(lines[i]);
                i += 1;
            }
        } else {
            out.push(lines[i]);
            i += 1;
        }
    }

    out.join("\n")
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/// Split `content` at the *last* `^-- $` line.
/// Returns `(before, Some(after))` or `(content, None)` if no sig line exists.
fn split_sig(content: &str) -> (&str, Option<&str>) {
    // We need byte offsets, so walk the lines manually.
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

/// Iterate over all matched `---`…`---` blocks in `region` and return each
/// block's parsed key-value pairs.
fn dashed_blocks(region: &str) -> Vec<Vec<(String, Value)>> {
    let lines: Vec<&str> = region.lines().collect();
    let n = lines.len();
    let mut blocks = Vec::new();
    let mut i = 0;

    while i < n {
        if lines[i] == "---" {
            let search = (i + 1).min(n);
            if let Some(rel) = lines[search..n].iter().position(|l| *l == "---") {
                let block_lines = &lines[search..search + rel];
                blocks.push(parse_pairs_slice(block_lines));
                i = search + rel + 1;
                continue;
            }
        }
        i += 1;
    }

    blocks
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
        if let Some(colon) = line.find(':') {
            let key = line[..colon].trim().to_string();
            let raw = line[colon + 1..].trim();
            if !key.is_empty() {
                pairs.push((key, parse_value(raw)));
            }
        }
    }
    pairs
}

fn parse_value(raw: &str) -> Value {
    // 1. Explicit bracket-array syntax: ['a', 'b'] or ["a", "b"]
    if raw.starts_with('[') {
        if let Some(arr) = try_parse_array(raw) {
            return Value::Array(arr);
        }
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

    #[test]
    fn array_bracket_syntax() {
        let doc = "---\ntags: ['rust', 'tauri', 'markdown']\n---";
        let fm = parse(doc);
        assert_eq!(fm["tags"], array(&["rust", "tauri", "markdown"]));
    }

    #[test]
    fn array_comma_delimited() {
        let doc = "---\ntags: one, two, three\n---";
        let fm = parse(doc);
        assert_eq!(fm["tags"], array(&["one", "two", "three"]));
    }

    #[test]
    fn array_comma_delimited_no_spaces() {
        let doc = "---\ntags: alpha,beta,gamma\n---";
        let fm = parse(doc);
        assert_eq!(fm["tags"], array(&["alpha", "beta", "gamma"]));
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
    fn multiple_blocks_later_overrides() {
        let doc = "---\ntitle: First\n---\n\n---\ntitle: Second\n---";
        let fm = parse(doc);
        assert_eq!(fm["title"], text("Second"));
    }

    #[test]
    fn block_anywhere_in_file() {
        let doc = "# Heading\n\nSome prose.\n\n---\nauthor: Jane\n---\n\nMore prose.";
        let fm = parse(doc);
        assert_eq!(fm["author"], text("Jane"));
    }

    #[test]
    fn sig_delimiter_overrides_dashed() {
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
    fn strip_removes_blocks_and_sig() {
        let doc = "---\ntitle: Hi\n---\n\nBody.\n\n-- \nauthor: Me";
        let stripped = strip(doc);
        assert!(!stripped.contains("title:"));
        assert!(!stripped.contains("author:"));
        assert!(stripped.contains("Body."));
    }

    #[test]
    fn unmatched_opener_is_kept() {
        let doc = "---\ntitle: Hi\n\nBody.";
        let stripped = strip(doc);
        // Unmatched --- stays (renders as <hr> in markdown).
        assert!(stripped.contains("---"));
        assert!(stripped.contains("Body."));
    }
}
