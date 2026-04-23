use front_matter;

use chrono::Datelike;
use pulldown_cmark::{html, Options, Parser};
use rusqlite::Connection;
use tauri::menu::{AboutMetadata, MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::Emitter;

// ── Preferences ─────────────────────────────────────────────────────────────

/// User preferences, persisted to `moreinfo.json` in the OS config dir:
///   macOS   ~/Library/Application Support/MoreInfo/moreinfo.json
///   Windows %APPDATA%\MoreInfo\moreinfo.json
///   Linux   $XDG_CONFIG_HOME/moreinfo/moreinfo.json
#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
struct Prefs {
    /// Override for the datastore root directory.  When absent the app uses
    /// the platform default (~/.moreinfo on macOS/Linux).
    #[serde(skip_serializing_if = "Option::is_none")]
    datastore: Option<String>,
}

fn prefs_path() -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").map_err(|e| e.to_string())?;
        Ok(std::path::PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("MoreInfo")
            .join("moreinfo.json"))
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var("APPDATA").map_err(|e| e.to_string())?;
        Ok(std::path::PathBuf::from(appdata)
            .join("MoreInfo")
            .join("moreinfo.json"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let base = std::env::var("XDG_CONFIG_HOME").unwrap_or_else(|_| {
            let home = std::env::var("HOME").unwrap_or_default();
            format!("{}/.config", home)
        });
        Ok(std::path::PathBuf::from(base)
            .join("moreinfo")
            .join("moreinfo.json"))
    }
}

fn load_prefs_from_disk() -> Prefs {
    let path = match prefs_path() {
        Ok(p) => p,
        Err(_) => return Prefs::default(),
    };
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Prefs::default(),
    }
}

/// In-process cache — loaded once on first access.  Mutable so a future
/// preferences UI can update prefs at runtime without an app restart.
static PREFS: std::sync::OnceLock<std::sync::RwLock<Prefs>> = std::sync::OnceLock::new();

fn prefs_cache() -> &'static std::sync::RwLock<Prefs> {
    PREFS.get_or_init(|| std::sync::RwLock::new(load_prefs_from_disk()))
}

fn current_prefs() -> Prefs {
    prefs_cache().read().unwrap().clone()
}

fn persist_prefs(prefs: Prefs) -> Result<(), String> {
    let path = prefs_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&prefs).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    *prefs_cache().write().unwrap() = prefs;
    Ok(())
}

// ── Datastore helpers ───────────────────────────────────────────────────────

/// Returns the root of the MI datastore.  Respects the `datastore` preference
/// when set; otherwise falls back to ~/Documents/MoreInfo on all platforms.
fn datastore_dir() -> Result<std::path::PathBuf, String> {
    if let Some(custom) = current_prefs().datastore {
        return Ok(std::path::PathBuf::from(custom));
    }
    #[cfg(target_os = "windows")]
    {
        let home = std::env::var("USERPROFILE").map_err(|e| e.to_string())?;
        Ok(std::path::PathBuf::from(home).join("Documents").join("MoreInfo"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").map_err(|e| e.to_string())?;
        Ok(std::path::PathBuf::from(home).join("Documents").join("MoreInfo"))
    }
}

fn journal_dir() -> Result<std::path::PathBuf, String> {
    Ok(datastore_dir()?.join("journal"))
}

fn wiki_dir() -> Result<std::path::PathBuf, String> {
    Ok(datastore_dir()?.join("wiki"))
}

fn templates_dir() -> Result<std::path::PathBuf, String> {
    Ok(datastore_dir()?.join("templates"))
}

#[derive(serde::Serialize)]
struct JournalEntry {
    path:    String,
    content: String,
}

// ── Wiki link helpers ───────────────────────────────────────────────────────

/// Convert a title into a URL/filesystem-safe slug.
/// Matches the JS `slugify()` function in main.js.
fn slugify(text: &str) -> String {
    let mut result = String::new();
    let mut last_was_hyphen = false;

    for c in text.to_lowercase().chars() {
        if c.is_alphanumeric() {
            result.push(c);
            last_was_hyphen = false;
        } else if (c == ' ' || c == '-' || c == '_') && !result.is_empty() {
            if !last_was_hyphen {
                result.push('-');
                last_was_hyphen = true;
            }
        }
        // all other characters are dropped
    }

    // trim trailing hyphen
    if result.ends_with('-') {
        result.pop();
    }

    result
}

/// Escape characters that are meaningful inside an HTML attribute value.
fn html_attr_escape(s: &str) -> String {
    s.replace('&', "&amp;")
     .replace('"', "&quot;")
     .replace('<', "&lt;")
     .replace('>', "&gt;")
}

/// Pre-process a markdown string, converting `[[title]]` wiki links into
/// inline HTML anchor tags that the JS layer can intercept and route.
fn process_wiki_links(text: &str) -> String {
    let mut result = String::new();
    let bytes = text.as_bytes();
    let len   = bytes.len();
    let mut i = 0;

    while i < len {
        if i + 1 < len && bytes[i] == b'[' && bytes[i + 1] == b'[' {
            i += 2;
            let title_start = i;

            let mut found = false;
            while i + 1 < len {
                if bytes[i] == b']' && bytes[i + 1] == b']' {
                    let raw_title = &text[title_start..i];
                    let title     = raw_title.trim();
                    if !title.is_empty() {
                        let slug = slugify(title);
                        result.push_str(&format!(
                            r#"<a class="wiki-link" data-wiki-slug="{}" data-wiki-title="{}">{}</a>"#,
                            html_attr_escape(&slug),
                            html_attr_escape(title),
                            html_attr_escape(title),
                        ));
                        found = true;
                    }
                    i += 2;
                    break;
                }
                i += 1;
            }

            if !found {
                result.push_str("[[");
                result.push_str(&text[title_start..i]);
            }
        } else {
            // Advance by a full UTF-8 character, not just one byte.
            let ch_len = utf8_char_len(bytes[i]);
            result.push_str(&text[i..i + ch_len]);
            i += ch_len;
        }
    }

    result
}

/// Returns the byte length of the UTF-8 character starting with `b`.
#[inline]
fn utf8_char_len(b: u8) -> usize {
    if b < 0x80 { 1 }
    else if b < 0xE0 { 2 }
    else if b < 0xF0 { 3 }
    else { 4 }
}

/// Extract all `[[title]]` wiki links from a document, returning
/// `(slug, raw_title, context)` triples. Used for DB indexing; does not emit HTML.
fn extract_wiki_links(text: &str) -> Vec<(String, String, String)> {
    let mut links = Vec::new();
    let bytes = text.as_bytes();
    let len   = bytes.len();
    let mut i = 0;

    while i < len {
        if i + 1 < len && bytes[i] == b'[' && bytes[i + 1] == b'[' {
            let bracket_start = i;
            i += 2;
            let title_start = i;
            while i + 1 < len {
                if bytes[i] == b']' && bytes[i + 1] == b']' {
                    let raw_title = &text[title_start..i];
                    let title     = raw_title.trim();
                    let bracket_end = i + 2;
                    if !title.is_empty() {
                        let slug = slugify(title);
                        if !slug.is_empty() {
                            let ctx = extract_context(text, bracket_start, bracket_end, title);
                            links.push((slug, title.to_string(), ctx));
                        }
                    }
                    i = bracket_end;
                    break;
                }
                i += 1;
            }
        } else {
            i += 1;
        }
    }

    links
}

/// Return a short text snippet surrounding a `[[...]]` link for display as
/// context in the Linked References section.
///
/// `link_start` is the byte offset of the opening `[[`;
/// `link_end`   is the byte offset just after the closing `]]`.
/// `title`      is the plain link title (without brackets).
///
/// The result replaces the `[[...]]` with the bare title and trims the
/// surrounding text to ≈60 chars on each side within the same line.
fn extract_context(text: &str, link_start: usize, link_end: usize, title: &str) -> String {
    const HALF: usize = 60;

    // Line boundaries
    let line_start = text[..link_start].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let line_end   = text[link_end..].find('\n')
        .map(|i| link_end + i)
        .unwrap_or(text.len());

    // Window boundaries, snapped to valid char boundaries
    let mut snip_start = link_start.saturating_sub(HALF).max(line_start);
    let mut snip_end   = (link_end + HALF).min(line_end);
    while snip_start < link_start && !text.is_char_boundary(snip_start) { snip_start += 1; }
    while snip_end > link_end && !text.is_char_boundary(snip_end) { snip_end -= 1; }

    // Strip leading markdown punctuation from the before-text
    let before = text[snip_start..link_start]
        .trim_start_matches(|c: char| "#>*-!| \t".contains(c));
    let after  = &text[link_end..snip_end];

    let pre_dots  = if snip_start > line_start { "…" } else { "" };
    let post_dots = if snip_end < line_end { "…" } else { "" };

    format!("{}{}{}{}{}", pre_dots, before, title, after, post_dots)
}

/// Extract the display title of a page from its content and filesystem path.
///
/// Resolution order:
///   1. Journal pages — always use the date from the filename (YYYY-MM-DD)
///   2. Front-matter `title:` key
///   3. First `# h1` in the body
///   4. Filename stem with hyphens replaced by spaces
fn extract_page_title(content: &str, path: &str) -> String {
    // 1. Journal pages always use their date as the title
    let p = std::path::Path::new(path);
    if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
        let is_journal = p.parent()
            .and_then(|d| d.file_name())
            .and_then(|n| n.to_str())
            .map(|n| n == "journal")
            .unwrap_or(false);
        if is_journal {
            // stem is YYYY-MM-DD; validate before trusting it
            let parts: Vec<&str> = stem.splitn(3, '-').collect();
            if parts.len() == 3
                && parts[0].len() == 4
                && parts[1].len() == 2
                && parts[2].len() == 2
                && parts.iter().all(|p| p.chars().all(|c| c.is_ascii_digit()))
            {
                return stem.to_string();
            }
        }
    }

    // 2. Front-matter title (keys are lowercased+singularized, so only "title" needed)
    let fm = front_matter::parse(content);
    if let Some(val) = fm.get("title") {
        let s = match val {
            front_matter::Value::Text(t) | front_matter::Value::Date(t) => t.as_str(),
            front_matter::Value::Array(_) | front_matter::Value::Bool(_) => "",
        };
        if !s.is_empty() { return s.to_string(); }
    }

    // 3. First # h1 in body
    for line in front_matter::strip(content).lines() {
        if let Some(rest) = line.strip_prefix("# ") {
            let t = rest.trim();
            if !t.is_empty() { return t.to_string(); }
        }
    }

    // 4. Filename stem
    p.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .replace('-', " ")
}

/// Extract inline hashtags from body text: `#word` preceded by whitespace or
/// start-of-text, with the character after `#` being a letter (not a digit or
/// space — this excludes `# Heading` Markdown headings and `#123` ordinals).
/// Returns lowercase, deduplicated tags in sorted order.
fn extract_hashtags(body: &str) -> Vec<String> {
    let mut tags = std::collections::BTreeSet::new();
    let chars: Vec<char> = body.chars().collect();
    let len = chars.len();
    let mut i = 0;

    while i < len {
        if chars[i] == '#' {
            let preceded_by_ws = i == 0 || chars[i - 1].is_whitespace();
            let next_is_alpha  = i + 1 < len && chars[i + 1].is_alphabetic();
            if preceded_by_ws && next_is_alpha {
                let mut j = i + 1;
                while j < len && (chars[j].is_alphanumeric() || chars[j] == '_' || chars[j] == '-') {
                    j += 1;
                }
                let tag: String = chars[i + 1..j].iter().collect();
                tags.insert(tag.to_lowercase());
                i = j;
                continue;
            }
        }
        i += 1;
    }

    tags.into_iter().collect()
}

// ── Database helpers ────────────────────────────────────────────────────────

fn db_path() -> Result<std::path::PathBuf, String> {
    Ok(datastore_dir()?.join("moreinfo.sqlite"))
}

fn open_db() -> Result<Connection, String> {
    let path = db_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Connection::open(&path).map_err(|e| e.to_string())
}

/// Bump this whenever the schema or indexing logic changes in a way that
/// requires existing cached data to be discarded and rebuilt.
const SCHEMA_VERSION: i64 = 16;

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT NOT NULL PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS files (
            path     TEXT NOT NULL PRIMARY KEY,
            modified INTEGER NOT NULL,
            title    TEXT NOT NULL DEFAULT '',
            body     TEXT NOT NULL DEFAULT '',
            favorite INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS wiki_links (
            source_path  TEXT NOT NULL,
            target_slug  TEXT NOT NULL,
            target_title TEXT NOT NULL,
            context      TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_wl_source ON wiki_links(source_path);
        CREATE INDEX IF NOT EXISTS idx_wl_slug   ON wiki_links(target_slug);
        CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
            path  UNINDEXED,
            title,
            body,
            tokenize = 'unicode61'
        );
        CREATE TABLE IF NOT EXISTS file_tags (
            path TEXT NOT NULL,
            tag  TEXT NOT NULL,
            PRIMARY KEY (path, tag)
        );
        CREATE INDEX IF NOT EXISTS idx_ft_tag ON file_tags(tag);
        CREATE TABLE IF NOT EXISTS file_aliases (
            path       TEXT NOT NULL,
            alias      TEXT NOT NULL,
            alias_slug TEXT NOT NULL,
            PRIMARY KEY (path, alias)
        );
        CREATE INDEX IF NOT EXISTS idx_fa_slug ON file_aliases(alias_slug);
        CREATE TABLE IF NOT EXISTS future_tasks (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL,
            text TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_task_path ON future_tasks(path);
        CREATE TABLE IF NOT EXISTS tasks (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            path             TEXT    NOT NULL,
            line_number      INTEGER NOT NULL,
            text             TEXT    NOT NULL DEFAULT '',
            checked          INTEGER NOT NULL DEFAULT 0,
            defer_until      TEXT    NOT NULL DEFAULT '',
            implicit_heading TEXT    NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_path    ON tasks(path);
        CREATE INDEX IF NOT EXISTS idx_tasks_checked ON tasks(checked);
        CREATE TABLE IF NOT EXISTS annotations (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            path        TEXT    NOT NULL,
            line_number INTEGER NOT NULL,
            keyword     TEXT    NOT NULL,
            text        TEXT    NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_annotations_path    ON annotations(path);
        CREATE INDEX IF NOT EXISTS idx_annotations_keyword ON annotations(keyword);
        CREATE TABLE IF NOT EXISTS task_contexts (
            path        TEXT    NOT NULL,
            line_number INTEGER NOT NULL,
            context     TEXT    NOT NULL COLLATE NOCASE,
            PRIMARY KEY (path, line_number, context)
        );
        CREATE INDEX IF NOT EXISTS idx_tc_context ON task_contexts(context);
        CREATE TABLE IF NOT EXISTS file_metadata (
            path  TEXT NOT NULL,
            key   TEXT NOT NULL COLLATE NOCASE,
            value TEXT NOT NULL DEFAULT '',
            type  TEXT NOT NULL DEFAULT 'text',
            PRIMARY KEY (path, key)
        );
        CREATE INDEX IF NOT EXISTS idx_fmeta_key ON file_metadata(key);
    ").map_err(|e| e.to_string())?;

    // Migrate columns added after initial release (silently ignored if present).
    for sql in [
        "ALTER TABLE files      ADD COLUMN title       TEXT    NOT NULL DEFAULT ''",
        "ALTER TABLE wiki_links ADD COLUMN context     TEXT    NOT NULL DEFAULT ''",
        "ALTER TABLE files      ADD COLUMN body        TEXT    NOT NULL DEFAULT ''",
        "ALTER TABLE files      ADD COLUMN favorite    INTEGER NOT NULL DEFAULT 0",
        "ALTER TABLE tasks      ADD COLUMN defer_until      TEXT    NOT NULL DEFAULT ''",
        "ALTER TABLE tasks      ADD COLUMN implicit_heading TEXT    NOT NULL DEFAULT ''",
        "ALTER TABLE tasks      ADD COLUMN due_date         TEXT    NOT NULL DEFAULT ''",
        "ALTER TABLE tasks      ADD COLUMN priority         INTEGER NOT NULL DEFAULT 10",
        "ALTER TABLE tasks      ADD COLUMN first_seen       TEXT    NOT NULL DEFAULT ''",
    ] {
        let _ = conn.execute_batch(sql);
    }

    // If the stored schema version doesn't match, wipe cached index data so
    // index_datastore re-processes every file from scratch.
    let stored: Option<i64> = conn.query_row(
        "SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'schema_version'",
        [],
        |row| row.get(0),
    ).ok();

    if stored != Some(SCHEMA_VERSION) {
        conn.execute_batch(
            "DELETE FROM wiki_links; DELETE FROM files; DELETE FROM fts; DELETE FROM file_tags; DELETE FROM file_aliases; DELETE FROM future_tasks; DELETE FROM tasks; DELETE FROM annotations; DELETE FROM task_contexts; DELETE FROM file_metadata; DELETE FROM meta WHERE key != 'schema_version';"
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?1)",
            [SCHEMA_VERSION.to_string()],
        ).map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Re-index a single file: parse its wiki links and upsert the DB.
/// If the file no longer exists on disk, remove it from the DB instead.
fn index_file(conn: &Connection, path_str: &str) -> Result<(), String> {
    let path = std::path::Path::new(path_str);

    if !path.exists() {
        conn.execute("DELETE FROM wiki_links WHERE source_path = ?1", [path_str])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM fts WHERE path = ?1", [path_str])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM files WHERE path = ?1", [path_str])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM file_tags WHERE path = ?1", [path_str])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM file_aliases WHERE path = ?1", [path_str])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM future_tasks WHERE path = ?1", [path_str])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM annotations WHERE path = ?1", [path_str])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM task_contexts WHERE path = ?1", [path_str])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM file_metadata WHERE path = ?1", [path_str])
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    let meta     = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let modified = meta.modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;

    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let body    = front_matter::strip(&content).to_string();
    let links   = extract_wiki_links(&content);
    let title   = extract_page_title(&content, path_str);

    conn.execute("DELETE FROM wiki_links WHERE source_path = ?1", [path_str])
        .map_err(|e| e.to_string())?;

    for (slug, link_title, context) in &links {
        conn.execute(
            "INSERT INTO wiki_links (source_path, target_slug, target_title, context) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![path_str, slug, link_title, context],
        ).map_err(|e| e.to_string())?;
    }

    // Parse `favorite` boolean metadata variable.
    // Keys are lowercased + singularized by front_matter::parse, so only the
    // canonical lowercase singular form needs to be looked up here.
    let fm = front_matter::parse(&content);
    let favorite: i64 = {
        let fav = match fm.get("favorite") {
            Some(front_matter::Value::Bool(b)) => *b,
            Some(front_matter::Value::Text(t)) => t.trim().eq_ignore_ascii_case("true"),
            _ => false,
        };
        fav as i64
    };

    conn.execute(
        "INSERT OR REPLACE INTO files (path, modified, title, body, favorite) VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![path_str, modified, title, body, favorite],
    ).map_err(|e| e.to_string())?;

    // FTS5 doesn't support UPDATE — delete the old entry then insert the new one.
    conn.execute("DELETE FROM fts WHERE path = ?1", [path_str])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO fts(path, title, body) VALUES (?1, ?2, ?3)",
        rusqlite::params![path_str, title, body],
    ).map_err(|e| e.to_string())?;

    // Tags: merge front-matter `tag`/`tags` (both now stored as "tag" after
    // singularization) with inline #hashtags, normalised to lowercase.
    let mut tag_set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();

    if let Some(val) = fm.get("tag") {
        match val {
            front_matter::Value::Array(arr) => {
                for t in arr {
                    let n = t.trim().to_lowercase();
                    if !n.is_empty() { tag_set.insert(n); }
                }
            }
            front_matter::Value::Text(s) | front_matter::Value::Date(s) => {
                for t in s.split(',') {
                    let n = t.trim().to_lowercase();
                    if !n.is_empty() { tag_set.insert(n); }
                }
            }
            front_matter::Value::Bool(_) => {}
        }
    }

    for tag in extract_hashtags(&body) {
        tag_set.insert(tag);
    }

    conn.execute("DELETE FROM file_tags WHERE path = ?1", [path_str])
        .map_err(|e| e.to_string())?;
    for tag in &tag_set {
        conn.execute(
            "INSERT OR IGNORE INTO file_tags (path, tag) VALUES (?1, ?2)",
            rusqlite::params![path_str, tag],
        ).map_err(|e| e.to_string())?;
    }

    // Aliases: collect from `alias`/`aliases` (both now stored as "alias" after
    // singularization), normalised to lowercase.
    let mut alias_set: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();

    if let Some(val) = fm.get("alias") {
        match val {
            front_matter::Value::Text(t) | front_matter::Value::Date(t) => {
                let a = t.trim().to_lowercase();
                if !a.is_empty() { alias_set.insert(a); }
            }
            front_matter::Value::Array(arr) => {
                for a in arr {
                    let a = a.trim().to_lowercase();
                    if !a.is_empty() { alias_set.insert(a); }
                }
            }
            front_matter::Value::Bool(_) => {}
        }
    }

    conn.execute("DELETE FROM file_aliases WHERE path = ?1", [path_str])
        .map_err(|e| e.to_string())?;
    for alias in &alias_set {
        let alias_slug = slugify(alias);
        if !alias_slug.is_empty() {
            conn.execute(
                "INSERT OR IGNORE INTO file_aliases (path, alias, alias_slug) VALUES (?1, ?2, ?3)",
                rusqlite::params![path_str, alias, alias_slug],
            ).map_err(|e| e.to_string())?;
        }
    }

    // Index all metadata key/value pairs for the metadata pseudo-page.
    conn.execute("DELETE FROM file_metadata WHERE path = ?1", [path_str])
        .map_err(|e| e.to_string())?;
    for (key, val) in &fm {
        let (type_str, val_str) = match val {
            front_matter::Value::Text(s)  => ("text",  s.clone()),
            front_matter::Value::Date(s)  => ("date",  s.clone()),
            front_matter::Value::Bool(b)  => ("bool",  if *b { "true".to_string() } else { "false".to_string() }),
            front_matter::Value::Array(a) => ("array", a.join(", ")),
        };
        conn.execute(
            "INSERT OR REPLACE INTO file_metadata (path, key, value, type) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![path_str, key, val_str, type_str],
        ).map_err(|e| e.to_string())?;
    }

    // Index tasks (with implicit heading), task contexts, and annotations in one pass.
    // Preserve first_seen dates so due-date priority boosting has a stable creation anchor.
    let mut saved_first_seen: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT text, first_seen FROM tasks WHERE path = ?1 AND first_seen != ''"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([path_str], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }).map_err(|e| e.to_string())?;
        for r in rows { if let Ok((t, fs)) = r { saved_first_seen.insert(t, fs); } }
    }
    let today_iso = {
        let now = chrono::Local::now();
        format!("{}-{:02}-{:02}", now.year(), now.month(), now.day())
    };
    conn.execute("DELETE FROM tasks WHERE path = ?1", [path_str])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM task_contexts WHERE path = ?1", [path_str])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM annotations WHERE path = ?1", [path_str])
        .map_err(|e| e.to_string())?;
    const ANNOTATION_KEYWORDS: &[&str] = &["TODO", "FIXME", "NOTE", "IDEA"];
    let mut current_heading = String::new();
    for (i, line) in content.lines().enumerate() {
        let line_num = i as i64 + 1;

        // Track ATX headings and thematic breaks for implicit task context.
        let trimmed = line.trim_start();
        if trimmed.starts_with('#') {
            let after_hashes = trimmed.trim_start_matches('#');
            if after_hashes.is_empty() || after_hashes.starts_with(' ') {
                current_heading = after_hashes.trim().to_string();
            }
        } else if trimmed == "---" || trimmed == "***" || trimmed == "___" {
            current_heading.clear();
        }

        // Task lines: insert task record and its @context tags.
        if let Some((checked, text)) = parse_task_line(line) {
            let defer    = extract_defer_value(&text);
            let due      = extract_due_value(&text);
            let priority = extract_priority_value(&text);
            let first_seen = saved_first_seen.get(&text)
                .cloned()
                .unwrap_or_else(|| today_iso.clone());
            conn.execute(
                "INSERT INTO tasks (path, line_number, text, checked, defer_until, due_date, implicit_heading, priority, first_seen) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                rusqlite::params![path_str, line_num, text, checked as i64, defer, due, &current_heading, priority, first_seen],
            ).map_err(|e| e.to_string())?;
            for context in parse_task_contexts(&text) {
                conn.execute(
                    "INSERT OR IGNORE INTO task_contexts (path, line_number, context) VALUES (?1, ?2, ?3)",
                    rusqlite::params![path_str, line_num, context],
                ).map_err(|e| e.to_string())?;
            }
        }

        // Annotation keywords: TODO, FIXME, NOTE, IDEA (with optional trailing colon).
        for kw in ANNOTATION_KEYWORDS {
            let mut search_from = 0;
            while search_from < line.len() {
                match line[search_from..].find(kw) {
                    None => break,
                    Some(rel) => {
                        let abs   = search_from + rel;
                        let after = abs + kw.len();
                        let before_ok = abs == 0 || !line[..abs].chars().next_back()
                            .map_or(false, |c| c.is_alphanumeric() || c == '_');
                        let after_ok  = after >= line.len() || !line[after..].chars().next()
                            .map_or(false, |c| c.is_alphanumeric() || c == '_');
                        if before_ok && after_ok {
                            let rest = line[after..].trim_start();
                            let rest = rest.strip_prefix(':').unwrap_or(rest).trim();
                            conn.execute(
                                "INSERT INTO annotations (path, line_number, keyword, text) VALUES (?1, ?2, ?3, ?4)",
                                rusqlite::params![path_str, line_num, kw, rest],
                            ).map_err(|e| e.to_string())?;
                        }
                        search_from = abs + 1;
                    }
                }
            }
        }
    }

    Ok(())
}

/// Skip a GFM list marker at the start of `s` (e.g. "- ", "* ", "1. ")
/// and return the remainder.  Returns `s` unchanged if no marker is found.
fn skip_list_marker(s: &str) -> &str {
    if s.starts_with("- ") || s.starts_with("* ") || s.starts_with("+ ") {
        return &s[2..];
    }
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() { i += 1; }
    if i > 0 && i + 1 < bytes.len()
        && (bytes[i] == b'.' || bytes[i] == b')')
        && bytes[i + 1] == b' '
    {
        return &s[i + 2..];
    }
    s
}

/// Extract the raw value inside `@defer(...)` from task text, or return an
/// empty string if the tag is absent.  The value is stored as-is so JS can
/// parse it with chrono-node for natural-language date support.
fn extract_defer_value(task_text: &str) -> String {
    const PREFIX: &str = "@defer(";
    if let Some(start) = task_text.find(PREFIX) {
        let rest = &task_text[start + PREFIX.len()..];
        if let Some(end) = rest.find(')') {
            return rest[..end].trim().to_string();
        }
    }
    String::new()
}

/// Extract the raw value inside `@due(...)` from task text, or return an
/// empty string if the tag is absent.
fn extract_due_value(task_text: &str) -> String {
    const PREFIX: &str = "@due(";
    if let Some(start) = task_text.find(PREFIX) {
        let rest = &task_text[start + PREFIX.len()..];
        if let Some(end) = rest.find(')') {
            return rest[..end].trim().to_string();
        }
    }
    String::new()
}

/// Extract an explicit priority from task text.
/// Recognises `@priority(n)` and a bare parenthesised integer `(n)` where
/// n is 1–5.  `@priority(n)` takes precedence.  Returns 10 (implicit
/// default) when no explicit priority is found.
fn extract_priority_value(task_text: &str) -> i64 {
    // Try @priority(n) first.
    const PREFIX: &str = "@priority(";
    if let Some(start) = task_text.find(PREFIX) {
        let rest = &task_text[start + PREFIX.len()..];
        if let Some(end) = rest.find(')') {
            if let Ok(n) = rest[..end].trim().parse::<i64>() {
                if (1..=5).contains(&n) { return n; }
            }
        }
    }
    // Fall back to bare (n) — scan for a `(digit)` token surrounded by
    // whitespace / line boundaries.
    let bytes = task_text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'(' {
            // Must be preceded by whitespace or start-of-string.
            if i > 0 && bytes[i - 1] != b' ' && bytes[i - 1] != b'\t' {
                i += 1;
                continue;
            }
            let start = i + 1;
            if let Some(close) = task_text[start..].find(')') {
                let inner = task_text[start..start + close].trim();
                if let Ok(n) = inner.parse::<i64>() {
                    if (1..=5).contains(&n) { return n; }
                }
            }
        }
        i += 1;
    }
    10 // implicit default
}

/// If `line` is a task line, return `Some((checked, task_text))`.
/// Recognises `[]`, `[ ]`, `[X]`, `[x]` optionally preceded by a list marker.
/// A task is "checked" when the marker is `[X]`/`[x]` OR when `@done` appears
/// in the task text.
fn parse_task_line(line: &str) -> Option<(bool, String)> {
    let s = line.trim_start();
    let s = skip_list_marker(s);
    if !s.starts_with('[') { return None; }
    let b = s.as_bytes();
    let (bracket_end, x_checked) = if b.len() >= 2 && b[1] == b']' {
        (2, false)                               // []
    } else if b.len() >= 3 && b[1] == b' ' && b[2] == b']' {
        (3, false)                               // [ ]
    } else if b.len() >= 3 && (b[1] == b'X' || b[1] == b'x') && b[2] == b']' {
        (3, true)                                // [X] or [x]
    } else {
        return None;
    };
    let rest = s[bracket_end..].trim_start().to_string();
    let checked = x_checked || rest.contains("@done");
    Some((checked, rest))
}

/// Extract bare @context tags from task text (the part after the checkbox).
/// Reserved names and parameterised @word(...) tags are excluded.
fn parse_task_contexts(task_text: &str) -> Vec<String> {
    const RESERVED: &[&str] = &[
        "done", "cancelled", "waiting", "someday",
        "due", "priority", "defer", "repeat",
    ];
    let mut contexts = Vec::new();
    let bytes = task_text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'@' {
            let start = i + 1;
            let mut j = start;
            while j < bytes.len()
                && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_' || bytes[j] == b'-')
            {
                j += 1;
            }
            if j > start {
                let name = &task_text[start..j];
                let has_parens  = j < bytes.len() && bytes[j] == b'(';
                let is_reserved = RESERVED.iter().any(|r| r.eq_ignore_ascii_case(name));
                if !has_parens && !is_reserved {
                    contexts.push(name.to_string());
                }
            }
            i = j;
        } else {
            i += 1;
        }
    }
    contexts
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Return byte offsets (in `body`) of every word-boundary, case-insensitive
/// occurrence of `term` that is NOT inside a `[[...]]` wiki-link span.
fn find_unlinked_occurrences(body: &str, term: &str) -> Vec<usize> {
    let lower_body = body.to_lowercase();
    let lower_term = term.to_lowercase();
    if lower_term.is_empty() { return vec![]; }

    // Collect [[...]] byte spans so we can exclude them.
    let mut wiki_spans: Vec<(usize, usize)> = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0;
    while i + 1 < bytes.len() {
        if bytes[i] == b'[' && bytes[i + 1] == b'[' {
            let start = i;
            i += 2;
            while i + 1 < bytes.len() {
                if bytes[i] == b']' && bytes[i + 1] == b']' {
                    wiki_spans.push((start, i + 2));
                    i += 2;
                    break;
                }
                i += 1;
            }
        } else {
            i += 1;
        }
    }

    let term_len = lower_term.len();
    let mut results = Vec::new();
    let mut pos = 0;

    while pos + term_len <= lower_body.len() {
        if !lower_body.is_char_boundary(pos) { pos += 1; continue; }

        if lower_body[pos..].starts_with(lower_term.as_str()) {
            let end = pos + term_len;
            if lower_body.is_char_boundary(end) {
                let pre_ok  = body[..pos].chars().next_back().map_or(true, |c| !is_word_char(c));
                let post_ok = body[end..].chars().next().map_or(true, |c| !is_word_char(c));
                if pre_ok && post_ok {
                    let in_wiki = wiki_spans.iter().any(|&(s, e)| pos >= s && end <= e);
                    if !in_wiki {
                        results.push(pos);
                    }
                }
            }
            let step = body[pos..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
            pos += step;
        } else {
            let step = lower_body[pos..].chars().next().map(|c| c.len_utf8()).unwrap_or(1);
            pos += step;
        }
    }

    results
}

/// Extract a plain-text context snippet around a match at `[match_start, match_end)`
/// in `text`, trimming to ≈60 chars each side within the same line.
fn extract_plain_context(text: &str, match_start: usize, match_end: usize) -> String {
    const HALF: usize = 60;

    let line_start = text[..match_start].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let line_end   = text[match_end..].find('\n')
        .map(|i| match_end + i)
        .unwrap_or(text.len());

    let mut snip_start = match_start.saturating_sub(HALF).max(line_start);
    let mut snip_end   = (match_end + HALF).min(line_end);
    while snip_start < match_start && !text.is_char_boundary(snip_start) { snip_start += 1; }
    while snip_end > match_end && !text.is_char_boundary(snip_end) { snip_end -= 1; }

    let before = text[snip_start..match_start]
        .trim_start_matches(|c: char| "#>*-!| \t".contains(c));
    let matched = &text[match_start..match_end];
    let after   = &text[match_end..snip_end];

    let pre_dots  = if snip_start > line_start { "…" } else { "" };
    let post_dots = if snip_end < line_end { "…" } else { "" };

    format!("{}{}{}{}{}", pre_dots, before, matched, after, post_dots)
}

// ── Commands ────────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct UnlinkedEntry {
    source_path:  String,
    source_title: String,
    context:      String,
    matched_term: String,
}

/// Return all pages that mention this page's title or aliases in plain text
/// (i.e., not inside `[[...]]` wiki links).
#[tauri::command]
fn get_unlinked_references(path: String) -> Result<Vec<UnlinkedEntry>, String> {
    let conn = open_db()?;
    init_schema(&conn)?;

    let title: String = conn.query_row(
        "SELECT title FROM files WHERE path = ?1",
        [&path],
        |row| row.get(0),
    ).unwrap_or_default();

    let mut alias_stmt = conn.prepare(
        "SELECT alias FROM file_aliases WHERE path = ?1"
    ).map_err(|e| e.to_string())?;
    let aliases: Vec<String> = alias_stmt
        .query_map([&path], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    let mut terms: Vec<String> = Vec::new();
    if !title.trim().is_empty() { terms.push(title.clone()); }
    terms.extend(aliases);
    if terms.is_empty() { return Ok(vec![]); }

    // One result entry per source page — first matching term wins.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut results: Vec<UnlinkedEntry> = Vec::new();

    for term in &terms {
        if term.trim().is_empty() { continue; }

        // FTS5 phrase query: quoted term matches exact token sequence,
        // which naturally enforces word boundaries via the unicode61 tokenizer.
        let fts_query = format!("\"{}\"", term.replace('"', "\"\""));

        let mut stmt = conn.prepare(
            "SELECT fts.path, COALESCE(f.title, ''), fts.body
             FROM fts
             JOIN files f ON f.path = fts.path
             WHERE fts MATCH ?1
               AND fts.path != ?2"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(
            rusqlite::params![fts_query, &path],
            |row| Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            )),
        ).map_err(|e| e.to_string())?;

        for row in rows.filter_map(|r| r.ok()) {
            let (src_path, src_title, body) = row;
            if seen.contains(&src_path) { continue; }

            let occs = find_unlinked_occurrences(&body, term);
            if occs.is_empty() { continue; }

            seen.insert(src_path.clone());

            let match_end = occs[0] + term.len();
            let context   = extract_plain_context(&body, occs[0], match_end);

            let display_title = if src_title.trim().is_empty() {
                std::path::Path::new(&src_path)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .replace('-', " ")
                    .replace('_', " ")
            } else {
                src_title
            };

            results.push(UnlinkedEntry {
                source_path:  src_path,
                source_title: display_title,
                context,
                matched_term: term.clone(),
            });
        }
    }

    results.sort_by(|a, b| a.source_path.cmp(&b.source_path));
    Ok(results)
}

// ── Custom window size/position persistence ─────────────────────────────────
//
// tauri-plugin-window-state's exit-time save races with window teardown on
// macOS, so the plugin can write stale (large-monitor) dimensions back to disk
// on quit. We take over size/position management: JS saves on every
// resize/move event (debounced) via `save_window_size`, and restores via
// `restore_window_size` which also clamps to the current monitor.
// The plugin is kept only for MAXIMIZED / FULLSCREEN state.

// ── Per-datastore user preferences ──────────────────────────────────────────
// Stored at <datastore>/preferences.json.  Distinct from the app-level
// moreinfo.json in Application Support (which holds the datastore path itself).

#[derive(serde::Serialize, serde::Deserialize, Clone, Default)]
struct WinState {
    width:  u32,
    height: u32,
    x:      i32,
    y:      i32,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct UserPrefs {
    /// Window geometry — Rust needs this directly for restore_window_size.
    #[serde(skip_serializing_if = "Option::is_none")]
    window: Option<WinState>,
    /// All UI preferences and app state (widget layout, sidebar sizes, font
    /// choices, etc.).  Rust stores this as an opaque JSON value; JS owns
    /// the schema entirely.
    #[serde(skip_serializing_if = "Option::is_none")]
    ui: Option<serde_json::Value>,
}

/// Return the UI preferences blob, or an empty object if none is saved yet.
#[tauri::command]
fn get_ui_prefs() -> serde_json::Value {
    read_user_prefs().ui.unwrap_or_else(|| serde_json::json!({}))
}

/// Persist the UI preferences blob to the datastore's preferences.json.
#[tauri::command]
fn save_ui_prefs(prefs: serde_json::Value) -> Result<(), String> {
    let mut p = read_user_prefs();
    p.ui = if prefs.is_null() { None } else { Some(prefs) };
    write_user_prefs(&p)
}

fn user_prefs_path() -> Result<std::path::PathBuf, String> {
    Ok(datastore_dir()?.join("preferences.json"))
}

fn read_user_prefs() -> UserPrefs {
    let path = match user_prefs_path() {
        Ok(p) => p,
        Err(_) => return UserPrefs::default(),
    };
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => UserPrefs::default(),
    }
}

fn write_user_prefs(prefs: &UserPrefs) -> Result<(), String> {
    let path = user_prefs_path()?;
    let json = serde_json::to_string_pretty(prefs).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

/// Persist the current (non-maximised) window size and position to
/// the `window` key in `<datastore>/preferences.json`.
/// Called from JS on a debounced resize/move event.
#[tauri::command]
async fn save_window_size(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.is_maximized().map_err(|e| e.to_string())? {
        return Ok(()); // don't overwrite good dimensions with maximised ones
    }
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let pos  = window.outer_position().map_err(|e| e.to_string())?;
    let mut prefs = read_user_prefs();
    prefs.window  = Some(WinState { width: size.width, height: size.height, x: pos.x, y: pos.y });
    write_user_prefs(&prefs)
}

/// Read the saved window size/position from `preferences.json`, clamp it to
/// the current monitor, and apply it.  No-ops on first run or when maximised.
#[tauri::command]
async fn restore_window_size(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.is_maximized().map_err(|e| e.to_string())? {
        return Ok(());
    }
    let saved = match read_user_prefs().window {
        Some(w) => w,
        None    => return Ok(()),
    };

    // Find the monitor that owns the saved position, so we clamp relative to
    // the correct screen rather than whichever monitor the OS happened to place
    // the window on at startup.
    let monitors = window.available_monitors().map_err(|e| e.to_string())?;
    let monitor = monitors.iter()
        .find(|m| {
            let mp = m.position();
            let ms = m.size();
            saved.x >= mp.x
                && saved.x < mp.x + ms.width  as i32
                && saved.y >= mp.y
                && saved.y < mp.y + ms.height as i32
        })
        .or_else(|| monitors.first())
        .ok_or_else(|| "no monitor found".to_string())?;

    let mp = monitor.position();
    let ms = monitor.size();

    const MARGIN: u32 = 40;
    let max_w = ms.width.saturating_sub(MARGIN * 2);
    let max_h = ms.height.saturating_sub(MARGIN * 2);
    let new_w = saved.width.min(max_w);
    let new_h = saved.height.min(max_h);

    let new_x = saved.x.max(mp.x).min(mp.x + ms.width  as i32 - new_w as i32);
    let new_y = saved.y.max(mp.y).min(mp.y + ms.height as i32 - new_h as i32);

    window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: new_w, height: new_h }))
        .map_err(|e| e.to_string())?;
    window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: new_x, y: new_y }))
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Return all pages marked as favorites, sorted by title.
#[derive(serde::Serialize)]
struct FavoriteEntry {
    path:  String,
    title: String,
}

#[tauri::command]
fn list_favorites() -> Result<Vec<FavoriteEntry>, String> {
    let conn = open_db()?;
    init_schema(&conn)?;
    let mut stmt = conn.prepare(
        "SELECT path, title FROM files WHERE favorite = 1 ORDER BY title COLLATE NOCASE"
    ).map_err(|e| e.to_string())?;
    let entries: Vec<FavoriteEntry> = stmt
        .query_map([], |row| Ok(FavoriteEntry { path: row.get(0)?, title: row.get(1)? }))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(entries)
}

#[derive(serde::Serialize)]
struct TaskEntry {
    path:             String,
    title:            String,
    line_number:      i64,
    text:             String,
    checked:          bool,
    defer_until:      String,
    due_date:         String,
    implicit_heading: String,
    priority:         i64,
    first_seen:       String,
}

/// Return tasks from the index.
/// Pass `checked = Some(false)` for open tasks only (the default view),
/// `Some(true)` for completed, or `None` for all.
#[tauri::command]
fn list_tasks(checked: Option<bool>) -> Result<Vec<TaskEntry>, String> {
    let conn = open_db()?;
    init_schema(&conn)?;
    let sql = match checked {
        Some(true)  => "SELECT t.path, f.title, t.line_number, t.text, t.checked, t.defer_until, t.due_date, t.implicit_heading, t.priority, t.first_seen \
                         FROM tasks t JOIN files f ON f.path = t.path \
                         WHERE t.checked = 1 ORDER BY t.priority, t.path, t.line_number",
        Some(false) => "SELECT t.path, f.title, t.line_number, t.text, t.checked, t.defer_until, t.due_date, t.implicit_heading, t.priority, t.first_seen \
                         FROM tasks t JOIN files f ON f.path = t.path \
                         WHERE t.checked = 0 ORDER BY t.priority, t.path, t.line_number",
        None        => "SELECT t.path, f.title, t.line_number, t.text, t.checked, t.defer_until, t.due_date, t.implicit_heading, t.priority, t.first_seen \
                         FROM tasks t JOIN files f ON f.path = t.path \
                         ORDER BY t.priority, t.path, t.line_number",
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let entries: Vec<TaskEntry> = stmt
        .query_map([], |row| Ok(TaskEntry {
            path:             row.get(0)?,
            title:            row.get(1)?,
            line_number:      row.get(2)?,
            text:             row.get(3)?,
            checked:          row.get::<_, i64>(4)? != 0,
            defer_until:      row.get(5)?,
            due_date:         row.get(6)?,
            implicit_heading: row.get(7)?,
            priority:         row.get(8)?,
            first_seen:       row.get(9)?,
        }))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(entries)
}

// ── Metadata search ──────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct MetadataHit {
    path:   String,
    title:  String,
    value:  String,
    #[serde(rename = "type")]
    vtype:  String,
}

/// Find all pages that have a given metadata key (optionally matching a value).
#[tauri::command]
fn search_metadata(key: String, value: Option<String>) -> Result<Vec<MetadataHit>, String> {
    let conn = open_db()?;
    init_schema(&conn)?;

    // Always fetch all rows for this key; value filtering (including array element
    // matching) is done in Rust below, where we can split comma-separated arrays.
    let sql = "SELECT fm.path, f.title, fm.value, fm.type \
               FROM file_metadata fm JOIN files f ON f.path = fm.path \
               WHERE fm.key = ?1 \
               ORDER BY f.title";
    let params: Vec<Box<dyn rusqlite::types::ToSql>> = vec![Box::new(key.clone())];
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let mut hits: Vec<MetadataHit> = stmt.query_map(param_refs.as_slice(), |row| Ok(MetadataHit {
        path:  row.get(0)?,
        title: row.get(1)?,
        value: row.get(2)?,
        vtype: row.get(3)?,
    })).map_err(|e| e.to_string())?
      .filter_map(|r| r.ok())
      .collect();

    // Filter by value: for arrays, check each comma-separated element;
    // for other types, require an exact case-insensitive match.
    if let Some(ref val) = value {
        hits.retain(|h| {
            if h.vtype == "array" {
                h.value.split(',').any(|item| item.trim().eq_ignore_ascii_case(val))
            } else {
                h.value.eq_ignore_ascii_case(val)
            }
        });
    }

    Ok(hits)
}

/// Rewrite one task line in a source file.
///
/// `original_text` is the task text as stored in the DB (the content after
/// the checkbox).  The command locates the source line by searching near
/// `line_number` (1-based) for a line that contains `original_text`, then
/// replaces the first occurrence with `new_text`.  After writing, the file
/// is re-indexed so the DB stays in sync.
#[tauri::command]
fn write_task_line(
    path:          String,
    line_number:   i64,
    original_text: String,
    new_text:      String,
) -> Result<(), String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let lines: Vec<&str> = content.lines().collect();
    let n    = lines.len();
    let hint = (line_number as usize).saturating_sub(1); // 0-based

    // Search outward from hint for a line containing original_text.
    let target = (0..=20_usize)
        .flat_map(|d| {
            let mut v = vec![];
            if hint + d < n          { v.push(hint + d); }
            if d > 0 && hint >= d    { v.push(hint - d); }
            v
        })
        .find(|&i| lines[i].contains(original_text.as_str()))
        .ok_or_else(|| "Task line not found in source file".to_string())?;

    let new_line = lines[target].replacen(original_text.as_str(), new_text.as_str(), 1);
    let mut new_lines: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
    new_lines[target] = new_line;

    let ends_with_newline = content.ends_with('\n');
    let mut new_content   = new_lines.join("\n");
    if ends_with_newline { new_content.push('\n'); }

    std::fs::write(&path, &new_content).map_err(|e| e.to_string())?;

    let conn = open_db()?;
    init_schema(&conn)?;
    index_file(&conn, &path)?;

    Ok(())
}

/// Return all annotations across the datastore, ordered by host file's last-modified
/// date (most recently changed files first), then by line number within each file.
#[derive(serde::Serialize)]
struct AnnotationEntry {
    path:    String,
    title:   String,
    keyword: String,
    text:    String,
}

#[tauri::command]
fn list_annotations() -> Result<Vec<AnnotationEntry>, String> {
    let conn = open_db()?;
    init_schema(&conn)?;
    let mut stmt = conn.prepare(
        "SELECT a.path, COALESCE(f.title, ''), a.keyword, a.text
         FROM annotations a
         JOIN files f ON f.path = a.path
         ORDER BY f.modified DESC, a.path, a.line_number",
    ).map_err(|e| e.to_string())?;
    let entries: Vec<AnnotationEntry> = stmt
        .query_map([], |row| Ok(AnnotationEntry {
            path:    row.get(0)?,
            title:   row.get(1)?,
            keyword: row.get(2)?,
            text:    row.get(3)?,
        }))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(entries)
}

// ── Tag commands ──────────────────────────────────────────────────────────────

/// All unique tags across the datastore, ordered by page count descending then alpha.
#[derive(serde::Serialize)]
struct TagEntry {
    tag:   String,
    count: i64,
}

#[tauri::command]
fn list_tags() -> Result<Vec<TagEntry>, String> {
    let conn = open_db()?;
    init_schema(&conn)?;
    let mut stmt = conn.prepare(
        "SELECT tag, COUNT(*) AS count FROM file_tags \
         GROUP BY tag ORDER BY count DESC, tag ASC",
    ).map_err(|e| e.to_string())?;
    let entries: Vec<TagEntry> = stmt
        .query_map([], |row| Ok(TagEntry { tag: row.get(0)?, count: row.get(1)? }))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(entries)
}

/// All pages that carry a specific tag (case-insensitive), ordered by title.
#[derive(serde::Serialize)]
struct TagPageEntry {
    path:  String,
    title: String,
}

#[tauri::command]
fn list_pages_for_tag(tag: String) -> Result<Vec<TagPageEntry>, String> {
    let conn = open_db()?;
    init_schema(&conn)?;
    let normalized = tag.trim().to_lowercase();
    let mut stmt = conn.prepare(
        "SELECT f.path, COALESCE(f.title, '') FROM file_tags ft \
         JOIN files f ON f.path = ft.path \
         WHERE lower(ft.tag) = ?1 \
         ORDER BY f.title COLLATE NOCASE",
    ).map_err(|e| e.to_string())?;
    let entries: Vec<TagPageEntry> = stmt
        .query_map([&normalized], |row| Ok(TagPageEntry { path: row.get(0)?, title: row.get(1)? }))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();
    Ok(entries)
}

/// A task from another page that explicitly references the current page via [[link]].
#[derive(serde::Serialize)]
struct LinkedTaskEntry {
    source_path:  String,
    source_title: String,
    task_text:    String,
    checked:      bool,
}

/// Return tasks from other pages whose text contains [[title]] or [[alias]]
/// for the page at `path`.  Results are ordered: unchecked first, then by
/// source path and line number, so the caller can group pages with open tasks
/// ahead of pages with only completed tasks.
#[tauri::command]
fn get_linked_tasks(path: String) -> Result<Vec<LinkedTaskEntry>, String> {
    let conn = open_db()?;
    init_schema(&conn)?;

    // Title of the target page.
    let title: String = conn.query_row(
        "SELECT title FROM files WHERE path = ?1",
        [&path],
        |row| row.get(0),
    ).unwrap_or_default();

    // Aliases of the target page (raw strings, not slugs).
    let mut alias_stmt = conn.prepare(
        "SELECT alias FROM file_aliases WHERE path = ?1",
    ).map_err(|e| e.to_string())?;
    let aliases: Vec<String> = alias_stmt
        .query_map([&path], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    // Build LIKE patterns: "%[[title]]%", "%[[alias1]]%", …
    let mut patterns: Vec<String> = Vec::new();
    if !title.is_empty() {
        patterns.push(format!("%[[{}]]%", title));
    }
    for alias in &aliases {
        if !alias.is_empty() {
            patterns.push(format!("%[[{}]]%", alias));
        }
    }

    if patterns.is_empty() {
        return Ok(vec![]);
    }

    // Build "t.text LIKE ?2 OR t.text LIKE ?3 …" clause.
    let or_clauses: String = patterns
        .iter()
        .enumerate()
        .map(|(i, _)| format!("t.text LIKE ?{}", i + 2))
        .collect::<Vec<_>>()
        .join(" OR ");

    let sql = format!(
        "SELECT DISTINCT t.path, COALESCE(f.title, ''), t.text, t.checked
         FROM tasks t
         LEFT JOIN files f ON f.path = t.path
         WHERE t.path != ?1 AND ({})
         ORDER BY t.checked ASC, t.path, t.line_number",
        or_clauses
    );

    // Collect params: path first, then each LIKE pattern.
    let mut param_boxes: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(path.clone())];
    for pat in &patterns {
        param_boxes.push(Box::new(pat.clone()));
    }
    let params_refs: Vec<&dyn rusqlite::ToSql> =
        param_boxes.iter().map(|b| b.as_ref()).collect();

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let entries: Vec<LinkedTaskEntry> = stmt
        .query_map(params_refs.as_slice(), |row| {
            Ok(LinkedTaskEntry {
                source_path:  row.get(0)?,
                source_title: row.get(1)?,
                task_text:    row.get(2)?,
                checked:      row.get::<_, i64>(3)? != 0,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(entries)
}

/// Render Markdown to HTML, stripping front-matter and expanding wiki links.
#[tauri::command]
fn parse_markdown(markdown: &str) -> String {
    let body = front_matter::strip(markdown);
    let body = process_wiki_links(&body);

    let mut options = Options::empty();
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_SMART_PUNCTUATION);
    options.insert(Options::ENABLE_DEFINITION_LIST);

    let parser = Parser::new_ext(&body, options);
    let mut output = String::new();
    html::push_html(&mut output, parser);
    output
}

/// Parse all metadata blocks in `content` and return a merged map.
#[tauri::command]
fn get_metadata(content: &str) -> front_matter::FrontMatter {
    front_matter::parse(content)
}

/// Return the current preferences object.
#[tauri::command]
fn get_prefs() -> Result<Prefs, String> {
    Ok(current_prefs())
}

/// Persist a new preferences object.  Updates the in-process cache
/// immediately; the new datastore path takes effect on the next app launch.
#[tauri::command]
fn save_prefs(prefs: Prefs) -> Result<(), String> {
    persist_prefs(prefs)
}

/// Return the absolute path to the MI datastore root.
#[tauri::command]
fn get_datastore_path() -> Result<String, String> {
    Ok(datastore_dir()?.to_string_lossy().to_string())
}

/// Ensure `path` is a valid MI datastore: create the standard subdirectories
/// (journal, wiki, templates) and scratchpad.md if they don't already exist.
/// Returns true if this was a fresh initialisation, false if it already existed.
#[tauri::command]
fn init_datastore(path: String) -> Result<bool, String> {
    let root = std::path::PathBuf::from(&path);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    let is_fresh = !root.join("moreinfo.sqlite").exists()
        && !root.join("journal").exists()
        && !root.join("wiki").exists();

    for sub in ["journal", "wiki", "templates"] {
        std::fs::create_dir_all(root.join(sub)).map_err(|e| e.to_string())?;
    }
    let scratch = root.join("scratchpad.md");
    if !scratch.exists() {
        std::fs::write(&scratch, "").map_err(|e| e.to_string())?;
    }

    Ok(is_fresh)
}

/// Persist a new datastore path to app preferences.  The change takes effect
/// on next launch; the caller is responsible for prompting a restart.
#[tauri::command]
fn set_datastore_path(path: String) -> Result<(), String> {
    let mut prefs = current_prefs();
    prefs.datastore = if path.is_empty() { None } else { Some(path) };
    persist_prefs(prefs)
}

/// Recursively collect all `.md` files under `dir` into `out`.
/// Skips hidden entries (names starting with `.`) to avoid `.git`, `.DS_Store`, etc.
fn collect_md_files(dir: &std::path::Path, out: &mut std::collections::HashSet<String>) -> Result<(), String> {
    if !dir.exists() { return Ok(()); }
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())?.filter_map(|e| e.ok()) {
        let path = entry.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if name.starts_with('.') { continue; }
        if path.is_dir() {
            if name == "templates" { continue; } // reserved; never indexed
            collect_md_files(&path, out)?;
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            out.insert(path.to_string_lossy().to_string());
        }
    }
    Ok(())
}

/// Scan the datastore for new or modified markdown files and update the
/// Delete `moreinfo.sqlite` entirely and rebuild it from scratch.
/// Triggered by File → Reindex.  Returns the number of files indexed.
#[tauri::command]
fn full_reindex(app: tauri::AppHandle) -> Result<u32, String> {
    let db_path = datastore_dir()?.join("moreinfo.sqlite");
    if db_path.exists() {
        std::fs::remove_file(&db_path).map_err(|e| e.to_string())?;
    }
    index_datastore(app)
}

/// wiki-link cache in `moreinfo.sqlite`.
///
/// Returns the number of files that were re-indexed.
#[tauri::command]
fn index_datastore(app: tauri::AppHandle) -> Result<u32, String> {
    let conn = open_db()?;
    init_schema(&conn)?;

    let mut disk_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut to_index:   Vec<String>                       = Vec::new();

    // Walk the entire datastore so category folders and any future
    // top-level directories are included automatically.
    collect_md_files(&datastore_dir()?, &mut disk_paths)?;

    for path_str in &disk_paths {
        let path = std::path::Path::new(path_str);
        let meta     = std::fs::metadata(path).map_err(|e| e.to_string())?;
        let modified = meta.modified()
            .map_err(|e| e.to_string())?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs() as i64;

        let cached: Option<i64> = conn.query_row(
            "SELECT modified FROM files WHERE path = ?1",
            [path_str],
            |row| row.get(0),
        ).ok();

        if cached != Some(modified) {
            to_index.push(path_str.clone());
        }
    }

    let count = to_index.len() as u32;
    for path_str in &to_index {
        let short = std::path::Path::new(path_str)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(path_str);
        app.emit("index-progress", short).ok();
        index_file(&conn, path_str)?;
    }

    // Remove rows for files deleted from disk
    let db_paths: Vec<String> = {
        let mut stmt = conn.prepare("SELECT path FROM files").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| row.get(0)).map_err(|e| e.to_string())?;
        let paths: Vec<String> = rows.filter_map(|r| r.ok()).collect();
        paths
    };
    for path_str in db_paths {
        if !disk_paths.contains(&path_str) {
            conn.execute("DELETE FROM wiki_links WHERE source_path = ?1", [&path_str])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM fts WHERE path = ?1", [&path_str])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM files WHERE path = ?1", [&path_str])
                .map_err(|e| e.to_string())?;
        }
    }

    Ok(count)
}

/// Return all pages that contain a wiki link pointing at `slug`.
#[derive(serde::Serialize)]
struct BacklinkEntry {
    source_path:  String,
    source_title: String,
    context:      String,
}

#[tauri::command]
fn get_backlinks(path: String) -> Result<Vec<BacklinkEntry>, String> {
    let conn = open_db()?;
    init_schema(&conn)?;

    // Derive the title slug for this page so we can match [[Title]] links.
    let title: String = conn.query_row(
        "SELECT title FROM files WHERE path = ?1",
        [&path],
        |row| row.get(0),
    ).unwrap_or_default();
    let title_slug = slugify(&title);

    // Match wiki_links whose target_slug equals the title slug OR any alias slug.
    let mut stmt = conn.prepare(
        "SELECT wl.source_path, COALESCE(f.title, ''), wl.context
         FROM wiki_links wl
         LEFT JOIN files f ON f.path = wl.source_path
         WHERE wl.source_path != ?1
           AND (wl.target_slug = ?2
                OR wl.target_slug IN (SELECT alias_slug FROM file_aliases WHERE path = ?1))
         ORDER BY wl.source_path"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map(rusqlite::params![&path, &title_slug], |row| {
        Ok(BacklinkEntry {
            source_path:  row.get(0)?,
            source_title: row.get(1)?,
            context:      row.get(2)?,
        })
    }).map_err(|e| e.to_string())?;
    let entries: Vec<BacklinkEntry> = rows.filter_map(|r| r.ok()).collect();

    Ok(entries)
}

/// Return all indexed pages as (title, path) pairs for autocomplete.
#[derive(serde::Serialize)]
struct PageEntry {
    title:    String,
    path:     String,
    aliases:  Vec<String>,
    favorite: bool,
}

#[tauri::command]
fn list_pages() -> Result<Vec<PageEntry>, String> {
    let conn = open_db()?;
    init_schema(&conn)?;
    let mut stmt = conn.prepare(
        "SELECT f.path, f.title, COALESCE(GROUP_CONCAT(fa.alias, '|||'), '') AS aliases, f.favorite
         FROM files f
         LEFT JOIN file_aliases fa ON fa.path = f.path
         GROUP BY f.path"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        let path:        String = row.get(0)?;
        let title:       String = row.get(1)?;
        let aliases_raw: String = row.get(2)?;
        let favorite:    bool   = row.get::<_, i64>(3).unwrap_or(0) != 0;
        Ok((path, title, aliases_raw, favorite))
    }).map_err(|e| e.to_string())?;

    let mut entries: Vec<PageEntry> = rows.filter_map(|r| r.ok()).map(|(path, title, aliases_raw, favorite)| {
        let display = if title.trim().is_empty() {
            std::path::Path::new(&path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .replace('-', " ")
                .replace('_', " ")
        } else {
            title
        };
        let aliases: Vec<String> = if aliases_raw.is_empty() {
            vec![]
        } else {
            aliases_raw.split("|||").map(|s| s.to_string()).collect()
        };
        PageEntry { path, title: display, aliases, favorite }
    }).collect();

    entries.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    Ok(entries)
}

/// Read the raw content of any file by absolute path.
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Return sorted list of YYYY-MM-DD strings for every `YYYY-MM-DD.md` file
/// found in the journal directory.
#[tauri::command]
fn list_journal_dates() -> Result<Vec<String>, String> {
    let dir = journal_dir()?;
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut dates: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| {
            let name = entry.ok()?.file_name();
            let name = name.to_string_lossy();
            if name.len() == 13 && name.ends_with(".md") {
                let date = &name[..10];
                let b = date.as_bytes();
                if b[4] == b'-' && b[7] == b'-' {
                    return Some(date.to_string());
                }
            }
            None
        })
        .collect();
    dates.sort();
    Ok(dates)
}

/// Open an existing journal file for `date` (YYYY-MM-DD), or prepare a new
/// empty one.  The file is NOT created on disk until the user types something
/// and auto-save fires; this keeps empty days off the filesystem.
#[tauri::command]
fn open_journal(date: String) -> Result<JournalEntry, String> {
    let dir = journal_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.md", date));
    let content = if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        String::new()
    };
    Ok(JournalEntry {
        path: path.to_string_lossy().to_string(),
        content,
    })
}

/// Open (or create) a wiki page by title.
/// The file is stored at `<datastore>/wiki/<slug>.md`.
/// New pages get a minimal sig-block with the title pre-filled.
#[tauri::command]
fn open_wiki_page(title: String) -> Result<JournalEntry, String> {
    let dir = wiki_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let slug = slugify(&title);
    if slug.is_empty() {
        return Err("Could not derive a filename from that title.".to_string());
    }
    let path = dir.join(format!("{}.md", slug));
    let content = if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        let default = format!("\n-- \ntitle: {}\n", title);
        std::fs::write(&path, &default).map_err(|e| e.to_string())?;
        default
    };
    Ok(JournalEntry {
        path: path.to_string_lossy().to_string(),
        content,
    })
}

/// Open or create a template file at `<datastore>/templates/<slug>.md`.
/// Templates are never added to the search index.
#[tauri::command]
fn open_template(name: String) -> Result<JournalEntry, String> {
    let dir = templates_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let slug = slugify(&name);
    if slug.is_empty() {
        return Err("Could not derive a filename from that name.".to_string());
    }
    let path = dir.join(format!("{}.md", slug));
    let content = if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())?
    } else {
        let default = format!("\n-- \ntitle: {}\n", name);
        std::fs::write(&path, &default).map_err(|e| e.to_string())?;
        default
    };
    Ok(JournalEntry {
        path: path.to_string_lossy().to_string(),
        content,
    })
}

// ── Template helpers ─────────────────────────────────────────────────────────

fn title_case(s: &str) -> String {
    s.split_whitespace()
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                None    => String::new(),
                Some(f) => f.to_uppercase().to_string() + c.as_str(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Best display name for a template file: its `title` metadata if set,
/// otherwise the filename stem converted to Title Case.
fn template_display_name(path: &std::path::Path) -> String {
    if let Ok(content) = std::fs::read_to_string(path) {
        let fm = front_matter::parse(&content);
        if let Some(front_matter::Value::Text(t)) = fm.get("title") {
            let t = t.trim();
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .replace('-', " ")
        .replace('_', " ");
    title_case(&stem)
}

#[derive(serde::Serialize)]
struct TemplateEntry {
    slug:  String,
    title: String,
    path:  String,
}

/// Return all templates in `<datastore>/templates/`, sorted by display title.
#[tauri::command]
fn list_templates() -> Result<Vec<TemplateEntry>, String> {
    let dir = templates_dir()?;
    if !dir.exists() { return Ok(vec![]); }

    let mut entries: Vec<TemplateEntry> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
        .map(|e| {
            let path  = e.path();
            let slug  = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
            let title = template_display_name(&path);
            TemplateEntry { slug, title, path: path.to_string_lossy().to_string() }
        })
        .collect();

    entries.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    Ok(entries)
}

/// Set the `title` metadata in `content` following the MI placement rule:
///   - If a `title:` line already exists anywhere, update it in-situ.
///   - Otherwise append it to the sig block (creating one if absent).
fn set_title_in_content(content: &str, new_title: &str) -> String {
    // Walk lines looking for the first `title:` key (case-insensitive,
    // list markers stripped).
    let mut found = false;
    let new_lines: Vec<String> = content.lines().map(|line| {
        if found { return line.to_string(); }
        let check = line.trim();
        let check = check
            .strip_prefix("- ").or_else(|| check.strip_prefix("* "))
            .or_else(|| check.strip_prefix("+ "))
            .unwrap_or(check)
            .trim_start();
        if let Some(colon_pos) = check.find(':') {
            if check[..colon_pos].trim().eq_ignore_ascii_case("title") {
                found = true;
                return format!("title: {}", new_title);
            }
        }
        line.to_string()
    }).collect();

    if found {
        return new_lines.join("\n");
    }

    // Not found — append to existing sig block or create one.
    let joined  = new_lines.join("\n");
    let trail   = if content.ends_with('\n') { "" } else { "\n" };
    let has_sig = content.lines().any(|l| l == "-- ");
    if has_sig {
        format!("{}{}title: {}\n", joined, trail, new_title)
    } else {
        format!("{}{}\n-- \ntitle: {}\n", joined, trail, new_title)
    }
}

/// Create a new wiki page from a template.
/// The template is copied verbatim; only `title` is updated (in-situ if the
/// key already exists, otherwise appended to the sig block).
#[tauri::command]
fn new_from_template(template_slug: String, title: String) -> Result<JournalEntry, String> {
    let template_path = templates_dir()?.join(format!("{}.md", template_slug));
    if !template_path.exists() {
        return Err(format!("Template '{}' not found.", template_slug));
    }
    let template_content = std::fs::read_to_string(&template_path).map_err(|e| e.to_string())?;
    let content = set_title_in_content(&template_content, &title);

    let dir = wiki_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let slug = slugify(&title);
    if slug.is_empty() {
        return Err("Could not derive a filename from that title.".to_string());
    }
    let path = dir.join(format!("{}.md", slug));
    std::fs::write(&path, &content).map_err(|e| e.to_string())?;

    if let Ok(conn) = open_db() {
        let _ = init_schema(&conn);
        let _ = index_file(&conn, &path.to_string_lossy());
    }

    Ok(JournalEntry {
        path: path.to_string_lossy().to_string(),
        content,
    })
}

/// Write `content` to `path`, creating parent directories as needed.
/// Also updates the wiki-link index for the saved file.
#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(p, content).map_err(|e| e.to_string())?;

    // Best-effort index update — a DB hiccup must not break the save path.
    if let Ok(conn) = open_db() {
        let _ = init_schema(&conn);
        let _ = index_file(&conn, &path);
    }

    Ok(())
}

/// Read the scratchpad file. Returns empty string if it doesn't exist yet.
#[tauri::command]
fn read_scratchpad() -> Result<String, String> {
    let path = datastore_dir()?.join("scratchpad.md");
    if path.exists() {
        std::fs::read_to_string(&path).map_err(|e| e.to_string())
    } else {
        Ok(String::new())
    }
}

/// Full-text search across all indexed pages.
/// Returns up to 20 results ordered by FTS5 rank.
#[derive(serde::Serialize)]
struct SearchResult {
    path:    String,
    title:   String,
    snippet: String,
}

// ── Search helpers ─────────────────────────────────────────────────────────

/// Tokenise a search query, collecting quoted strings as single tokens.
fn tokenize_search_query(input: &str) -> Vec<String> {
    let mut tokens  = Vec::new();
    let mut cur     = String::new();
    let mut in_q    = false;
    for ch in input.chars() {
        match ch {
            '"' => {
                cur.push(ch);
                if in_q { tokens.push(std::mem::take(&mut cur)); }
                in_q = !in_q;
            }
            c if c.is_whitespace() && !in_q => {
                if !cur.is_empty() { tokens.push(std::mem::take(&mut cur)); }
            }
            c => { cur.push(c); }
        }
    }
    if !cur.is_empty() { tokens.push(cur); }
    tokens
}

/// If `s` looks like `key:value` or `key: value` where the key is all
/// lowercase ASCII letters/digits/hyphens/underscores, return (key, value).
fn parse_filter_token(s: &str) -> Option<(String, String)> {
    let pos = s.find(':')?;
    let key = s[..pos].trim();
    let val = s[pos + 1..].trim();
    if key.is_empty() || val.is_empty() { return None; }
    if !key.chars().all(|c| c.is_ascii_lowercase() || c == '_' || c == '-') { return None; }
    Some((key.to_string(), val.to_string()))
}

/// Sanitise a bare string into space-separated prefix-wildcard FTS5 tokens.
fn fts_prefix_tokens(s: &str) -> String {
    let safe: String = s.chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    safe.split_whitespace()
        .map(|w| format!("{}*", w))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Active filters extracted from the query string.
struct SearchFilters {
    /// Each inner Vec is an OR group; multiple groups are AND'd together.
    tag_groups:   Vec<Vec<String>>,
    category:     Option<String>,
    in_journal:   bool,
    in_wiki:      bool,
    after:        Option<String>,  // YYYY-MM-DD; implies in_journal
    before:       Option<String>,  // YYYY-MM-DD; implies in_journal
    /// Arbitrary metadata key/value filters.  Value "*" means "key exists".
    meta_filters: Vec<(String, String)>,
}

impl SearchFilters {
    fn new() -> Self {
        Self { tag_groups: Vec::new(), category: None,
               in_journal: false, in_wiki: false,
               after: None, before: None,
               meta_filters: Vec::new() }
    }
    fn is_empty(&self) -> bool {
        self.tag_groups.is_empty() && self.category.is_none()
            && !self.in_journal && !self.in_wiki
            && self.after.is_none() && self.before.is_none()
            && self.meta_filters.is_empty()
    }
}

/// Apply a recognised filter key/value. Returns true if the key was handled.
/// `pending_tags` accumulates the current OR-group of tag values; it is
/// committed into `filters.tag_groups` when AND or another filter is seen.
fn apply_known_filter(
    key: &str, val: &str,
    filters: &mut SearchFilters,
    pending_tags: &mut Vec<String>,
) -> bool {
    match key {
        "tag" | "tags" => {
            if !pending_tags.is_empty() {
                filters.tag_groups.push(std::mem::take(pending_tags));
            }
            let vals: Vec<String> = val.split(',')
                .map(|v| v.trim().to_lowercase())
                .filter(|v| !v.is_empty())
                .collect();
            if !vals.is_empty() { *pending_tags = vals; }
            true
        }
        "cat" | "category" => {
            filters.category = Some(val.to_string());
            true
        }
        "in" => {
            match val.to_lowercase().as_str() {
                "journal"       => filters.in_journal = true,
                "wiki" | "pages"=> filters.in_wiki    = true,
                _               => {}
            }
            true
        }
        "after" => {
            filters.after      = Some(val.to_string());
            filters.in_journal = true;
            true
        }
        "before" => {
            filters.before     = Some(val.to_string());
            filters.in_journal = true;
            true
        }
        _ => false,
    }
}

/// Build an FTS5 query string from the non-filter tokens.
/// Handles: quoted phrases, NEAR, bare prefix words, and mixes thereof.
fn build_fts_query(parts: &[String]) -> Option<String> {
    if parts.is_empty() { return None; }

    // NEAR: any token is the literal string "NEAR"
    if parts.iter().any(|t| t == "NEAR") {
        let terms: Vec<String> = parts.iter()
            .filter(|t| t.as_str() != "NEAR")
            .map(|t| {
                if t.starts_with('"') && t.ends_with('"') && t.len() > 2 {
                    let inner = t[1..t.len() - 1].replace('"', "");
                    format!("\"{}\"", inner)
                } else {
                    fts_prefix_tokens(t)
                }
            })
            .filter(|s| !s.is_empty())
            .collect();
        if terms.is_empty() { return None; }
        return Some(format!("NEAR({}, 10)", terms.join(" ")));
    }

    // Build token-by-token (handles single phrase, mixed, bare words)
    let tokens: Vec<String> = parts.iter()
        .map(|t| {
            if t.starts_with('"') && t.ends_with('"') && t.len() > 2 {
                let inner = t[1..t.len() - 1].replace('"', "");
                if inner.trim().is_empty() { return String::new(); }
                format!("\"{}\"", inner)
            } else {
                fts_prefix_tokens(t)
            }
        })
        .filter(|s| !s.is_empty())
        .collect();

    if tokens.is_empty() { None } else { Some(tokens.join(" ")) }
}

/// Tokenise `query` and split into FTS terms and structured filters.
/// Extracted so the logic can be unit-tested without a database.
fn extract_search_filters(query: &str) -> (Vec<String>, SearchFilters) {
    let mut filters      = SearchFilters::new();
    let mut pending_tags: Vec<String> = Vec::new();
    let mut fts_parts:    Vec<String> = Vec::new();

    for token in tokenize_search_query(query) {
        // Quoted token — may be "key: multi word value" filter or a phrase search.
        if token.starts_with('"') && token.ends_with('"') && token.len() > 2 {
            let inner = &token[1..token.len() - 1];
            if let Some((key, val)) = parse_filter_token(inner) {
                if apply_known_filter(&key, &val, &mut filters, &mut pending_tags) {
                    continue;
                }
                // Unknown quoted key:value → metadata filter.
                filters.meta_filters.push((key, val));
                continue;
            }
            fts_parts.push(token);
            continue;
        }

        // Explicit AND between tag filters — commit pending tag group.
        if token == "AND" {
            if !pending_tags.is_empty() {
                filters.tag_groups.push(std::mem::take(&mut pending_tags));
            }
            continue;
        }

        // Bare key:value — try known filters first, then metadata JOIN.
        if let Some((key, val)) = parse_filter_token(&token) {
            if apply_known_filter(&key, &val, &mut filters, &mut pending_tags) {
                continue;
            }
            // Unknown key → arbitrary metadata filter.
            // value "*" means "key exists with any value".
            filters.meta_filters.push((key, val));
            continue;
        }

        fts_parts.push(token);
    }

    // Commit any trailing tag group.
    if !pending_tags.is_empty() {
        filters.tag_groups.push(pending_tags);
    }

    (fts_parts, filters)
}

#[tauri::command]
fn search_pages(query: String) -> Result<Vec<SearchResult>, String> {
    let db_path = datastore_dir()?.join("moreinfo.sqlite");
    let conn    = Connection::open(&db_path).map_err(|e| e.to_string())?;

    let query = query.trim();
    if query.is_empty() { return Ok(vec![]); }

    // ── Step 1: tokenise, classify, extract filters ────────────────────────
    let (fts_parts, filters) = extract_search_filters(query);

    // ── Step 2: build FTS query from remaining tokens ──────────────────────
    let fts_query = build_fts_query(&fts_parts);

    if fts_query.is_none() && filters.is_empty() { return Ok(vec![]); }

    // ── Step 3: build SQL dynamically ─────────────────────────────────────
    let use_fts  = fts_query.is_some();
    let path_col = if use_fts { "fts.path" } else { "f.path" };

    let mut conditions: Vec<String> = Vec::new();
    let mut bind_vals:  Vec<String> = Vec::new();

    if let Some(ref fq) = fts_query {
        conditions.push("fts MATCH ?".to_string());
        bind_vals.push(fq.clone());
    }

    // Source filter (in_journal takes precedence over in_wiki).
    if filters.in_journal {
        conditions.push("f.path LIKE ?".to_string());
        bind_vals.push("%/journal/%".to_string());
    } else if filters.in_wiki {
        conditions.push("(f.path LIKE ? OR f.path LIKE ?)".to_string());
        bind_vals.push("%/wiki/%".to_string());
        bind_vals.push("%/pages/%".to_string());
    }

    // Date filters — extract YYYY-MM-DD from journal filename.
    // Journal filenames are always YYYY-MM-DD.md (13 chars), so the date
    // starts 13 chars from the end and is 10 chars long.
    if let Some(ref after) = filters.after {
        conditions.push("substr(f.path, length(f.path) - 12, 10) > ?".to_string());
        bind_vals.push(after.clone());
    }
    if let Some(ref before) = filters.before {
        conditions.push("substr(f.path, length(f.path) - 12, 10) < ?".to_string());
        bind_vals.push(before.clone());
    }

    // Tag filters — one EXISTS per AND-group; within a group, OR across tags.
    for group in &filters.tag_groups {
        let phs = group.iter().map(|_| "?").collect::<Vec<_>>().join(", ");
        conditions.push(format!(
            "EXISTS (SELECT 1 FROM file_tags ft \
             WHERE ft.path = {path_col} AND lower(ft.tag) IN ({phs}))"
        ));
        bind_vals.extend(group.iter().cloned());
    }

    // Category filter.
    if let Some(ref cat) = filters.category {
        conditions.push(format!(
            "EXISTS (SELECT 1 FROM file_metadata fm \
             WHERE fm.path = {path_col} \
             AND lower(fm.key) = 'category' AND lower(fm.value) = lower(?))"
        ));
        bind_vals.push(cat.clone());
    }

    // Arbitrary metadata filters.  value "*" = key exists with any value.
    for (key, val) in &filters.meta_filters {
        if val == "*" {
            conditions.push(format!(
                "EXISTS (SELECT 1 FROM file_metadata fm \
                 WHERE fm.path = {path_col} AND lower(fm.key) = lower(?))"
            ));
            bind_vals.push(key.clone());
        } else {
            conditions.push(format!(
                "EXISTS (SELECT 1 FROM file_metadata fm \
                 WHERE fm.path = {path_col} \
                 AND lower(fm.key) = lower(?) AND lower(fm.value) = lower(?))"
            ));
            bind_vals.push(key.clone());
            bind_vals.push(val.clone());
        }
    }

    let where_clause = if conditions.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", conditions.join(" AND "))
    };

    let sql = if use_fts {
        format!(
            "SELECT fts.path, COALESCE(f.title, fts.title, ''), \
                    snippet(fts, 2, '', '', '…', 16)
             FROM fts JOIN files f ON f.path = fts.path
             {where_clause}
             ORDER BY rank LIMIT 20"
        )
    } else {
        format!(
            "SELECT f.path, f.title, ''
             FROM files f
             {where_clause}
             LIMIT 20"
        )
    };

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let params: Vec<&dyn rusqlite::types::ToSql> = bind_vals.iter()
        .map(|s| s as &dyn rusqlite::types::ToSql)
        .collect();

    let results: Vec<SearchResult> = stmt
        .query_map(params.as_slice(), |row| {
            Ok(SearchResult { path: row.get(0)?, title: row.get(1)?, snippet: row.get(2)? })
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(results)
}

/// Write content to the scratchpad file (not indexed).
#[tauri::command]
fn write_scratchpad(content: String) -> Result<(), String> {
    let path = datastore_dir()?.join("scratchpad.md");
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Fetch raw HTML from a URL, server-side (bypasses CORS / X-Frame-Options).
/// Sends a Safari-like User-Agent and requests dark-mode via the Sec-CH-Prefers-Color-Scheme hint.
#[tauri::command]
async fn fetch_page(url: String) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15")
        .gzip(true)
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(&url)
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Sec-CH-Prefers-Color-Scheme", "dark")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let text = response.text().await.map_err(|e| e.to_string())?;
    Ok(text)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let handle = app.handle();

            let toggle_left   = MenuItem::with_id(handle, "toggle-left",   "Toggle Left Sidebar",   true, Some("CmdOrCtrl+["))?;
            let toggle_right  = MenuItem::with_id(handle, "toggle-right",  "Toggle Right Sidebar",  true, Some("CmdOrCtrl+]"))?;
            let toggle_top    = MenuItem::with_id(handle, "toggle-top",    "Toggle Top Panel",      true, None::<&str>)?;
            let toggle_bottom = MenuItem::with_id(handle, "toggle-bottom", "Toggle Bottom Panel",   true, None::<&str>)?;

            let view_today    = MenuItem::with_id(handle, "view-today",    "Today's Journal",       true, Some("CmdOrCtrl+Shift+T"))?;
            let view_tasks    = MenuItem::with_id(handle, "view-tasks",    "Tasks",                 true, Some("CmdOrCtrl+Shift+K"))?;
            let view_render   = MenuItem::with_id(handle, "view-render",   "Render Markdown",       true, Some("CmdOrCtrl+Shift+R"))?;

            let edit_find             = MenuItem::with_id(handle, "edit-find",             "Find\u{2026}",                true, Some("CmdOrCtrl+G"))?;

            let file_new              = MenuItem::with_id(handle, "file-new",              "New Page\u{2026}",          true, Some("CmdOrCtrl+N"))?;
            let file_new_template     = MenuItem::with_id(handle, "file-new-template",     "New Template\u{2026}",      true, None::<&str>)?;
            let file_from_template    = MenuItem::with_id(handle, "file-from-template",    "New from Template\u{2026}", true, None::<&str>)?;
            let file_edit_template    = MenuItem::with_id(handle, "file-edit-template",    "Edit Template\u{2026}",     true, None::<&str>)?;
            let file_reindex          = MenuItem::with_id(handle, "file-reindex",          "Reindex Database",          true, None::<&str>)?;
            let file_settings         = MenuItem::with_id(handle, "file-settings",         "Settings\u{2026}",          true, Some("CmdOrCtrl+,"))?;

            let menu = MenuBuilder::new(handle)
                .items(&[
                    // ── App menu (macOS convention) ──────────────────
                    &SubmenuBuilder::new(handle, "MoreInfo")
                        .about(Some(AboutMetadata {
                            name:      Some("MoreInfo".to_string()),
                            version:   Some(env!("CARGO_PKG_VERSION").to_string()),
                            copyright: Some("\u{00a9} 2026 Eric A. Farris".to_string()),
                            license:   Some("MIT License".to_string()),
                            comments:  Some("A markdown-based personal knowledge base.".to_string()),
                            ..Default::default()
                        }))
                        .separator()
                        .item(&file_settings)
                        .separator()
                        .services()
                        .separator()
                        .hide()
                        .hide_others()
                        .show_all()
                        .separator()
                        .quit()
                        .build()?,
                    // ── File ────────────────────────────────────────
                    &SubmenuBuilder::new(handle, "File")
                        .item(&file_new)
                        .separator()
                        .item(&file_new_template)
                        .item(&file_from_template)
                        .item(&file_edit_template)
                        .separator()
                        .item(&file_reindex)
                        .separator()
                        .item(&file_settings)
                        .build()?,
                    // ── Edit ────────────────────────────────────────
                    &SubmenuBuilder::new(handle, "Edit")
                        .undo()
                        .redo()
                        .separator()
                        .cut()
                        .copy()
                        .paste()
                        .separator()
                        .select_all()
                        .separator()
                        .item(&edit_find)
                        .build()?,
                    // ── View ────────────────────────────────────────
                    &SubmenuBuilder::new(handle, "View")
                        .item(&view_today)
                        .item(&view_tasks)
                        .item(&view_render)
                        .separator()
                        .item(&toggle_left)
                        .item(&toggle_right)
                        .separator()
                        .item(&toggle_top)
                        .item(&toggle_bottom)
                        .build()?,
                    // ── Window ──────────────────────────────────────
                    &SubmenuBuilder::new(handle, "Window")
                        .minimize()
                        .maximize()
                        .separator()
                        .close_window()
                        .build()?,
                    // ── Help (Windows convention; macOS uses app menu) ──
                    &SubmenuBuilder::new(handle, "Help")
                        .about(Some(AboutMetadata {
                            name:      Some("MoreInfo".to_string()),
                            version:   Some(env!("CARGO_PKG_VERSION").to_string()),
                            copyright: Some("\u{00a9} 2026 Eric A. Farris".to_string()),
                            license:   Some("MIT License".to_string()),
                            comments:  Some("A markdown-based personal knowledge base.".to_string()),
                            ..Default::default()
                        }))
                        .build()?,
                ])
                .build()?;

            app.set_menu(menu)?;

            // Forward menu events to the webview as a "menu" event so JS can handle them.
            app.on_menu_event(|app, event| {
                app.emit("menu", event.id().as_ref()).ok();
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            parse_markdown,
            get_metadata,
            get_prefs,
            save_prefs,
            get_datastore_path,
            init_datastore,
            set_datastore_path,
            read_file,
            write_file,
            list_journal_dates,
            open_journal,
            open_wiki_page,
            open_template,
            list_templates,
            new_from_template,
            full_reindex,
            index_datastore,
            get_backlinks,
            get_unlinked_references,
            list_pages,
            read_scratchpad,
            write_scratchpad,
            search_pages,
            fetch_page,
            list_favorites,
            list_annotations,
            list_tasks,
            search_metadata,
            write_task_line,
            get_linked_tasks,
            save_window_size,
            restore_window_size,
            list_tags,
            list_pages_for_tag,
            get_ui_prefs,
            save_ui_prefs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ── Search helper tests ───────────────────────────────────────────────────────

#[cfg(test)]
mod search_tests {
    use super::*;

    // ── tokenize_search_query ────────────────────────────────────────────────

    #[test]
    fn tokenize_single_word() {
        assert_eq!(tokenize_search_query("hello"), vec!["hello"]);
    }

    #[test]
    fn tokenize_two_words() {
        assert_eq!(tokenize_search_query("hello world"), vec!["hello", "world"]);
    }

    #[test]
    fn tokenize_extra_whitespace() {
        assert_eq!(tokenize_search_query("  hello   world  "), vec!["hello", "world"]);
    }

    #[test]
    fn tokenize_quoted_phrase_is_single_token() {
        assert_eq!(tokenize_search_query(r#""exact phrase""#), vec![r#""exact phrase""#]);
    }

    #[test]
    fn tokenize_mixed_bare_and_quoted() {
        let got = tokenize_search_query(r#"hello "exact phrase" world"#);
        assert_eq!(got, vec!["hello", r#""exact phrase""#, "world"]);
    }

    #[test]
    fn tokenize_filter_token_kept_intact() {
        assert_eq!(tokenize_search_query("in:journal"), vec!["in:journal"]);
    }

    #[test]
    fn tokenize_near_keyword() {
        let got = tokenize_search_query("hello NEAR world");
        assert_eq!(got, vec!["hello", "NEAR", "world"]);
    }

    #[test]
    fn tokenize_empty_string() {
        let got = tokenize_search_query("");
        assert!(got.is_empty());
    }

    #[test]
    fn tokenize_whitespace_only() {
        let got = tokenize_search_query("   ");
        assert!(got.is_empty());
    }

    #[test]
    fn tokenize_unclosed_quote_yields_one_token() {
        // An unclosed quote absorbs the rest of the input as a single token.
        let got = tokenize_search_query(r#"hello "unclosed"#);
        assert_eq!(got, vec!["hello", "\"unclosed"]);
    }

    // ── parse_filter_token ───────────────────────────────────────────────────

    #[test]
    fn filter_token_basic() {
        assert_eq!(parse_filter_token("in:journal"), Some(("in".into(), "journal".into())));
    }

    #[test]
    fn filter_token_tag() {
        assert_eq!(parse_filter_token("tag:rust"), Some(("tag".into(), "rust".into())));
    }

    #[test]
    fn filter_token_date() {
        assert_eq!(
            parse_filter_token("after:2024-01-01"),
            Some(("after".into(), "2024-01-01".into())),
        );
    }

    #[test]
    fn filter_token_value_preserves_case() {
        // Keys are lowercased by the caller; values must be preserved as-is.
        assert_eq!(
            parse_filter_token("author:Jane Doe"),
            Some(("author".into(), "Jane Doe".into())),
        );
    }

    #[test]
    fn filter_token_no_colon_returns_none() {
        assert_eq!(parse_filter_token("hello"), None);
    }

    #[test]
    fn filter_token_empty_key_returns_none() {
        assert_eq!(parse_filter_token(":value"), None);
    }

    #[test]
    fn filter_token_empty_value_returns_none() {
        assert_eq!(parse_filter_token("key:"), None);
    }

    #[test]
    fn filter_token_uppercase_key_returns_none() {
        // Keys must be all lowercase ASCII; "NEAR" (and other uppercase tokens)
        // are not treated as key:value filters.
        assert_eq!(parse_filter_token("NEAR"), None);
        assert_eq!(parse_filter_token("Author:Eric"), None);
    }

    #[test]
    fn filter_token_hyphen_and_underscore_in_key() {
        assert_eq!(
            parse_filter_token("publish-date:2025-01-01"),
            Some(("publish-date".into(), "2025-01-01".into())),
        );
        assert_eq!(
            parse_filter_token("my_key:value"),
            Some(("my_key".into(), "value".into())),
        );
    }

    // ── build_fts_query ──────────────────────────────────────────────────────

    #[test]
    fn fts_empty_parts_returns_none() {
        assert_eq!(build_fts_query(&[]), None);
    }

    #[test]
    fn fts_single_bare_word_gets_prefix_wildcard() {
        assert_eq!(build_fts_query(&["hello".into()]), Some("hello*".into()));
    }

    #[test]
    fn fts_two_bare_words() {
        assert_eq!(
            build_fts_query(&["hello".into(), "world".into()]),
            Some("hello* world*".into()),
        );
    }

    #[test]
    fn fts_quoted_phrase_passed_through() {
        assert_eq!(
            build_fts_query(&[r#""exact phrase""#.into()]),
            Some(r#""exact phrase""#.into()),
        );
    }

    #[test]
    fn fts_mixed_bare_and_quoted() {
        let got = build_fts_query(&["hello".into(), r#""exact phrase""#.into()]);
        assert_eq!(got, Some(r#"hello* "exact phrase""#.into()));
    }

    #[test]
    fn fts_near_two_bare_words() {
        let got = build_fts_query(&["hello".into(), "NEAR".into(), "world".into()]);
        assert_eq!(got, Some("NEAR(hello* world*, 10)".into()));
    }

    #[test]
    fn fts_near_with_quoted_phrase() {
        let got = build_fts_query(&[r#""hello world""#.into(), "NEAR".into(), "foo".into()]);
        assert_eq!(got, Some(r#"NEAR("hello world" foo*, 10)"#.into()));
    }

    #[test]
    fn fts_near_only_no_terms_returns_none() {
        // "NEAR" with no other tokens produces no usable query.
        let got = build_fts_query(&["NEAR".into()]);
        assert_eq!(got, None);
    }

    // ── extract_search_filters ───────────────────────────────────────────────

    #[test]
    fn extract_unknown_key_value_goes_to_meta_filters() {
        let (fts, filters) = extract_search_filters("author:jane");
        assert!(fts.is_empty(), "should not reach FTS");
        assert_eq!(filters.meta_filters, vec![("author".to_string(), "jane".to_string())]);
    }

    #[test]
    fn extract_wildcard_value_goes_to_meta_filters() {
        let (fts, filters) = extract_search_filters("author:*");
        assert!(fts.is_empty());
        assert_eq!(filters.meta_filters, vec![("author".to_string(), "*".to_string())]);
    }

    #[test]
    fn extract_known_key_does_not_go_to_meta_filters() {
        let (_, filters) = extract_search_filters("tag:rust in:journal");
        assert!(filters.meta_filters.is_empty());
        assert!(!filters.tag_groups.is_empty());
        assert!(filters.in_journal);
    }

    #[test]
    fn extract_mixed_known_and_unknown_filters() {
        let (fts, filters) = extract_search_filters("notes author:jane in:wiki");
        assert_eq!(fts, vec!["notes"]);
        assert!(filters.in_wiki);
        assert_eq!(filters.meta_filters, vec![("author".to_string(), "jane".to_string())]);
    }

    #[test]
    fn extract_multiple_meta_filters_all_collected() {
        let (_, filters) = extract_search_filters("author:jane status:done");
        assert_eq!(filters.meta_filters.len(), 2);
        assert!(filters.meta_filters.contains(&("author".to_string(), "jane".to_string())));
        assert!(filters.meta_filters.contains(&("status".to_string(), "done".to_string())));
    }

    #[test]
    fn extract_quoted_unknown_key_value_goes_to_meta_filters() {
        let (fts, filters) = extract_search_filters(r#""author:Jane Doe""#);
        assert!(fts.is_empty());
        assert_eq!(filters.meta_filters, vec![("author".to_string(), "Jane Doe".to_string())]);
    }

    #[test]
    fn extract_bare_word_goes_to_fts_not_meta() {
        let (fts, filters) = extract_search_filters("hello");
        assert_eq!(fts, vec!["hello"]);
        assert!(filters.meta_filters.is_empty());
    }

    #[test]
    fn fts_multi_word_bare_token_produces_multiple_wildcards() {
        // fts_prefix_tokens splits on non-alphanumeric, so "hello world" (bare)
        // becomes "hello* world*".
        let got = build_fts_query(&["hello world".into()]);
        assert_eq!(got, Some("hello* world*".into()));
    }
}
