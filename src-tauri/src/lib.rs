use front_matter;

use pulldown_cmark::{html, Options, Parser};

/// Render Markdown to HTML, stripping all front-matter blocks first so that
/// `---` delimiters and raw key-value lines are never visible in the preview.
#[tauri::command]
fn parse_markdown(markdown: &str) -> String {
    let body = front_matter::strip(markdown);

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

/// Parse all front-matter blocks in `content` and return a merged map.
///
/// Each value is a tagged object: `{ type, value }` where `type` is one of
/// `"text"`, `"date"` (ISO 8601), or `"array"`.  Later block definitions
/// override earlier ones; the sig-delimiter block has the highest precedence.
#[tauri::command]
fn get_front_matter(content: &str) -> front_matter::FrontMatter {
    front_matter::parse(content)
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            parse_markdown,
            get_front_matter,
            read_file,
            write_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
