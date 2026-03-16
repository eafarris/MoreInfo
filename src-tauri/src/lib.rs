use front_matter;

use pulldown_cmark::{html, Options, Parser};
use rusqlite::Connection;
use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::Emitter;

// ── Datastore helpers ───────────────────────────────────────────────────────

/// Returns the root of the MI datastore.
/// ~/.moreinfo on Unix/macOS; ~/Documents/Moreinfo on Windows.
fn datastore_dir() -> Result<std::path::PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let home = std::env::var("USERPROFILE").map_err(|e| e.to_string())?;
        Ok(std::path::PathBuf::from(home).join("Documents").join("Moreinfo"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").map_err(|e| e.to_string())?;
        Ok(std::path::PathBuf::from(home).join(".moreinfo"))
    }
}

fn journal_dir() -> Result<std::path::PathBuf, String> {
    Ok(datastore_dir()?.join("journal"))
}

fn wiki_dir() -> Result<std::path::PathBuf, String> {
    Ok(datastore_dir()?.join("wiki"))
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
            result.push(bytes[i] as char);
            i += 1;
        }
    }

    result
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
///   1. Front-matter `title:` key
///   2. First `# h1` in the body
///   3. Filename stem with hyphens replaced by spaces
fn extract_page_title(content: &str, path: &str) -> String {
    // 1. Front-matter title
    let fm = front_matter::parse(content);
    for key in ["title", "Title", "TITLE"] {
        if let Some(val) = fm.get(key) {
            let s = match val {
                front_matter::Value::Text(t) | front_matter::Value::Date(t) => t.as_str(),
                front_matter::Value::Array(_) => continue,
            };
            if !s.is_empty() { return s.to_string(); }
        }
    }

    // 2. First # h1 in body
    for line in front_matter::strip(content).lines() {
        if let Some(rest) = line.strip_prefix("# ") {
            let t = rest.trim();
            if !t.is_empty() { return t.to_string(); }
        }
    }

    // 3. Filename stem
    std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .replace('-', " ")
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
const SCHEMA_VERSION: i64 = 2;

fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS meta (
            key   TEXT NOT NULL PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS files (
            path     TEXT NOT NULL PRIMARY KEY,
            modified INTEGER NOT NULL,
            title    TEXT NOT NULL DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS wiki_links (
            source_path  TEXT NOT NULL,
            target_slug  TEXT NOT NULL,
            target_title TEXT NOT NULL,
            context      TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_wl_source ON wiki_links(source_path);
        CREATE INDEX IF NOT EXISTS idx_wl_slug   ON wiki_links(target_slug);
    ").map_err(|e| e.to_string())?;

    // Migrate columns added after initial release (silently ignored if present).
    for sql in [
        "ALTER TABLE files      ADD COLUMN title   TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE wiki_links ADD COLUMN context TEXT NOT NULL DEFAULT ''",
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
        conn.execute_batch("DELETE FROM wiki_links; DELETE FROM files;")
            .map_err(|e| e.to_string())?;
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
        conn.execute("DELETE FROM files WHERE path = ?1", [path_str])
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

    conn.execute(
        "INSERT OR REPLACE INTO files (path, modified, title) VALUES (?1, ?2, ?3)",
        rusqlite::params![path_str, modified, title],
    ).map_err(|e| e.to_string())?;

    Ok(())
}

// ── Commands ────────────────────────────────────────────────────────────────

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

/// Return the absolute path to the MI datastore root.
#[tauri::command]
fn get_datastore_path() -> Result<String, String> {
    Ok(datastore_dir()?.to_string_lossy().to_string())
}

/// Scan the datastore for new or modified markdown files and update the
/// wiki-link cache in `moreinfo.sqlite`.
///
/// Returns the number of files that were re-indexed.
#[tauri::command]
fn index_datastore() -> Result<u32, String> {
    let conn = open_db()?;
    init_schema(&conn)?;

    let mut disk_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut to_index:   Vec<String>                       = Vec::new();

    for dir in [journal_dir()?, wiki_dir()?] {
        if !dir.exists() { continue; }
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())?.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") { continue; }

            let path_str = path.to_string_lossy().to_string();
            disk_paths.insert(path_str.clone());

            let meta     = std::fs::metadata(&path).map_err(|e| e.to_string())?;
            let modified = meta.modified()
                .map_err(|e| e.to_string())?
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_secs() as i64;

            let cached: Option<i64> = conn.query_row(
                "SELECT modified FROM files WHERE path = ?1",
                [&path_str],
                |row| row.get(0),
            ).ok();

            if cached != Some(modified) {
                to_index.push(path_str);
            }
        }
    }

    let count = to_index.len() as u32;
    for path_str in &to_index {
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
fn get_backlinks(slug: String) -> Result<Vec<BacklinkEntry>, String> {
    let conn = open_db()?;
    init_schema(&conn)?;

    let mut stmt = conn.prepare(
        "SELECT wl.source_path, COALESCE(f.title, ''), wl.context
         FROM wiki_links wl
         LEFT JOIN files f ON f.path = wl.source_path
         WHERE wl.target_slug = ?1
         ORDER BY wl.source_path"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([&slug], |row| {
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
    title: String,
    path:  String,
}

#[tauri::command]
fn list_pages() -> Result<Vec<PageEntry>, String> {
    let conn = open_db()?;
    init_schema(&conn)?;
    let mut stmt = conn.prepare(
        "SELECT path, title FROM files ORDER BY title COLLATE NOCASE"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok(PageEntry { path: row.get(0)?, title: row.get(1)? })
    }).map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
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
/// New pages get a minimal front-matter block with the title pre-filled.
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
        let default = format!("---\ntitle: {}\n---\n\n", title);
        std::fs::write(&path, &default).map_err(|e| e.to_string())?;
        default
    };
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle();

            let toggle_left   = MenuItem::with_id(handle, "toggle-left",   "Toggle Left Sidebar",   true, Some("CmdOrCtrl+["))?;
            let toggle_right  = MenuItem::with_id(handle, "toggle-right",  "Toggle Right Sidebar",  true, Some("CmdOrCtrl+]"))?;
            let toggle_top    = MenuItem::with_id(handle, "toggle-top",    "Toggle Top Panel",      true, None::<&str>)?;
            let toggle_bottom = MenuItem::with_id(handle, "toggle-bottom", "Toggle Bottom Panel",   true, None::<&str>)?;

            let menu = MenuBuilder::new(handle)
                .items(&[
                    // ── App menu (macOS convention) ──────────────────
                    &SubmenuBuilder::new(handle, "MoreInfo")
                        .about(None)
                        .separator()
                        .services()
                        .separator()
                        .hide()
                        .hide_others()
                        .show_all()
                        .separator()
                        .quit()
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
                        .build()?,
                    // ── View ────────────────────────────────────────
                    &SubmenuBuilder::new(handle, "View")
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
            get_datastore_path,
            read_file,
            write_file,
            list_journal_dates,
            open_journal,
            open_wiki_page,
            index_datastore,
            get_backlinks,
            list_pages,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
