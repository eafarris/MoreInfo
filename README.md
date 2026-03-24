# MoreInfo

A markdown-based personal knowledge base (PKB) for macOS, with Windows and Linux planned. MoreInfo combines a wiki-style linking system, daily journals, and task management — all backed by plain-text files you can read, edit, back up, and sync with any tool you already use.

> **Status: Early development.** Core editing and linking work. Tasks, templates, and several planned widgets are still in progress.

---

## Philosophy

- **Plain text is the source of truth.** Every note is a `.md` file on disk. The SQLite database is a derived cache for speed — delete it and it rebuilds itself.
- **Filenames don't matter to the user.** MoreInfo manages filenames; you work with titles and links.
- **Portable.** Your datastore is a folder. Move it, sync it with any cloud provider, or open it in any text editor. Nothing is locked away.

---

## Features

### Working now

- **Markdown editor** with syntax highlighting, wiki-link autocomplete, and a live split preview
- **Wiki-style linking** — `[[Page Title]]` links between notes; clicking creates the page if it doesn't exist
- **Backlinks** — linked and unlinked references shown at the bottom of every page
- **Daily journals** — one `.md` file per day, named `YYYY-MM-DD.md`; today's journal opens on launch
- **Page aliases** — multiple names can resolve to the same page
- **Favorites** — star any page; favorited pages appear in the Favorites widget
- **@calc blocks** — tape-calculator arithmetic inside any page or the Scratch Pad (see below)
- **Full-text search** with SQLite FTS5
- **Metadata** — YAML-style front matter anywhere in the file, plus end-of-file sig-block metadata; supports string, date, boolean, and array types
- **Tags** via metadata
- **Sidebar layout** — resizable left, right, top, and bottom sidebars in a VS Code-style arrangement
- **Widgets**: Calendar, Metadata, References, Counter, Page, Browser, Search, Favorites, Scratchpad
- **Filesystem watcher** keeps the database in sync with changes made outside the app
- **User preferences** stored in `preferences.json` inside the datastore (travels with your data)

### Planned / in progress

- **Task management** — `[ ]` checkboxes with todotxt/TaskPaper-inspired parameters (`TODO`, `FIXME`, deadline dates, priorities, repeating tasks)
- **Tasks widget** — filtered view of all open tasks across the datastore
- **Page templates** — scaffold new pages from a template
- **Outline widget** — heading-based document outline
- **Categories** — user-defined page types stored in their own top-level folder (e.g. `people/`, `projects/`)
- **Static site export** — publish some or all notes as a website
- **Focus mode** — distraction-free single-document view
- **iOS / iPadOS binaries** (Tauri roadmap dependent)

---

## @calc blocks

Any page (including the Scratch Pad widget) can contain one or more calculator blocks. Start a block by placing `@calc` alone on a line. Every subsequent non-blank line is treated as an arithmetic expression. The block ends at the first blank line (or end of file).

```text
@calc
450 * 12
+ 1200
* 1.08
```

Results appear flush-right in the editor and in the preview pane.

### Implicit carry

The result of each expression is silently carried forward as the left operand of the next line **when that line begins with a binary operator** (`+`, `-`, `*`, `/`, `%`, `**`, `^`). A line that starts with a number or function is evaluated independently.

| Line | Interpretation |
|---|---|
| `450 * 12` | standalone: `450 × 12 = 5,400` |
| `+ 1200` | carry: `5,400 + 1,200 = 6,600` |
| `* 1.08` | carry: `6,600 × 1.08 = 7,128` |
| `32^2` | standalone (starts with a number): `1,024` |

A leading `-` is always treated as binary subtraction (subtract from the previous result), not unary negation.

### Supported syntax

| Feature | Examples |
|---|---|
| Basic operators | `+ - * / % ** ^` (`^` is an alias for `**`) |
| Grouping | `(2 + 3) * 4` |
| Constants | `pi` |
| Functions | `sqrt abs round floor ceil min max log sin cos tan` |

---
## Screenshots

Main window, daily journal:
![Main window with daily journal open](MoreInfoScreenshot-Journal.png)

Page open with sidebar widgets:
![Busy interface with widgets](MoreInfoScreenshot-Widgets.png)

---

## Tech stack

| Layer | Technology |
|---|---|
| Application framework | [Tauri v2](https://tauri.app) |
| Backend | Rust (2021 edition) |
| Frontend build | [Vite](https://vitejs.dev) |
| Editor | [CodeMirror 6](https://codemirror.net) |
| Styling | [Tailwind CSS v4](https://tailwindcss.com) |
| Icons | [Phosphor Icons](https://phosphoricons.com) |
| Markdown parsing (Rust) | [pulldown-cmark](https://github.com/raphlinus/pulldown-cmark) |
| Metadata parsing (Rust) | Custom `front-matter` crate (local) |
| Database | SQLite via [rusqlite](https://github.com/rusqlite/rusqlite) |
| Date parsing (JS) | [chrono-node](https://github.com/wanasit/chrono) |

---

## Building

### Prerequisites

- [Rust](https://rustup.rs) (stable toolchain)
- [Node.js](https://nodejs.org) 18 or later
- macOS 12+ (primary target; Windows/Linux builds untested but planned)
- Tauri CLI: installed automatically via `npm install`

### Development

```bash
git clone https://github.com/eafarris/MoreInfo.git
cd MoreInfo
npm install
npm run dev
```

`npm run dev` starts the Vite dev server and the Tauri development window together. Tailwind CSS is processed automatically by the Vite plugin — no separate build step needed.

### Production build

```bash
npm run build
```

This runs `vite build` followed by `tauri build` and produces a signed `.app` bundle (macOS) in `src-tauri/target/release/bundle/`.

---

## Datastore layout

By default the datastore lives at `~/Documents/MoreInfo`. The location can be overridden in `~/Library/Application Support/MoreInfo/moreinfo.json`.

```
~/Documents/MoreInfo/
  journal/          # YYYY-MM-DD.md daily journal files
  wiki/             # general-purpose pages
  templates/        # page templates
  preferences.json  # per-user preferences (travels with the datastore)
  moreinfo.sqlite   # derived cache — safe to delete; rebuilds on launch
```

---

## Built with Claude Code

MoreInfo is being developed in collaboration with [Claude Code](https://claude.ai/claude-code), Anthropic's agentic coding tool. The architecture decisions, feature design, and prose in `CLAUDE.md` are the author's; the implementation is largely written by Claude Code working from those specifications.

---

## About the name

I'm an [Apple Newton](https://en.wikipedia.org/wiki/Apple_Newton) fan, and used one well past its useful life. [SilverWARE](https://silverwaresoftware.com/AboutUs.shtml) made a PIM extension for the default Newton apps that was called [MoreInfo](https://silverwaresoftware.com/MI5PR.shtml), and it was truly the finest piece of software I've ever used. The name of this project is aspirational. My MoreInfo covers similar ground in a modern context, and I want it to be worthy of the name.

---

## License

Not yet decided. Source is public for reference. If you're interested in using or contributing, open an issue.
