# MoreInfo

MoreInfo ("MI") is a markdown-based note taking app for macOS and Windows.

## Engineering

MI is built using Rust and Tauri. Styling of the front-end is done with TailwindCSS and is themeable, and the Phosphor Icon set is used as glyphs. Where possible, MI defaults to OS-native API calls, forms, and styling.

## Definitions

Page
: A single markdown document, stored on disk in the filesystem within MI's data folder.

Journal
: A Journal, also called a "Daily Journal", is a special type of page named for a day in YYYY-MM-DD format. Each calendar day can have its own journal, though it is not required.

Template
: A special type of page that can be used to quickly create other pages based on the content and placeholders in the template page.

Link
: A URI joining pages together, or a destination to an external URI. In many cases the actual URI is hidden from the user.

WikiLink
: A type of link that explicitly binds two pages together. In the markdown and UI, wikilinks are enclosed in double-square brackets ("`[[`"…"`]]`"). Inside the brackets is the title of a page. Treated as an explicit link to the page matching the title. If the page exists, the destination of the link is to the page with that title. If the page does not exist, MI will show a blank page with that title for creation.

Linked Reference
: A wikilink.

Unlinked Reference
: A plain-text phrase matching the title of an existing page, without the standard double-square brackets delimiter. Can optionally be highlighted in the UI, and optionally turned into a linked reference. Treated as an implicit link to the page matching the title.

Backlink
: Bottom-matter of a page showing links where other pages have referenced this page. There are two lists of backlinks, one for linked (ie., explicit) references and one for unlinked (ie., implicit) references.

Active Page
: One and only one page within the main document window that has cursor focus. Active pages are usually highlighted via window chrome or CSS.

Sidebar
: Each side of the main document window (left, top, right, bottom) can have its own collapsible sidebar. Sidebars can contain widgets.

Widget
: A tool that can embed functionality on a sidebar. An example of a widget is the Calendar widget, which shows a monthly calendar where days are linked to their journal pages. Another example of a widget is the Page widget, which can show another page. Other widgets may include a paragraph/sentence/word/character counter, or a widget that displays the metadata of the active page. Widgets can be organized by position and sidebar. The organization of these widgets is stored as part of the user settings, and multiple widget organizations can be saved.

Viewport
: The main application window can be split on every side (left, top, right, bottom) into viewports. The number of viewports is not limited. Viewports can show other pages within the system or offer an additional view (and edit point) of the currently active page.

## Highlighted Features

- Uses plain-text Markdown as its 'source of truth' data format. All data is stored in plain-text files. While an SQLite database is used to quickly implement features such as searching and linking, the database is always derived from the text files within the MI folder.

- supports wiki linking to other pages via double-square brackets. Words or phrases surrounded by double-square brackets ("`[[`"…"`]]`") are links to pages that either already exist or are created when clicked.

- Pages that are part of the wiki have backlinks to all of the files where the page is referenced. References are separated into either linked (ie., double-square bracketed) or unlinked (a simple string match without delimiters.

- supports daily journals. These are markdown files with the filename pattern of `YYYY-MM-DD.md`. Each day may have at most one daily journal note. Like wiki links, these files are not created until they are opened. Files for dates in the future are supported. "Journal Notes" is the default view of the app, which opens the current day's daily journal.

- Supports Jekyll-style front matter. Notes can have metadata embedded in them using lines between triple-dashes ("---"). In addition, late-matter metadata can be added to the end of the file using lines defined by the start of the metadata with the "email .sig" delimiter, double-dash plus space ("-- "), and continuing until the end of the file. Front matter are used as variables, both some built-in variables with significance as well as on-the-fly database columns using user-defined metadata items. Reserved variables are listed below. Metadata can have three types: string, date, and array.

- Support for numerous types of task management. Any line can be turned into a task by beginning the line with a square-bracket pair, either with or without a space between (ie., "`[]`" or "`[ ]`"). Once a line has been marked as being a task, it is rendered with a clickable checkbox, and can have its own parameters to define the scope of the task, like "project" "now", "later", "todo", "someday", "date:YYYY-MM-DD", etc. The entire list of built-in parameters is listed below, and users can create their own depending on their needs. Task management will include several types of repeating tasks.

- Support for widgets on sidebars. Collapsible sidebars on all four sides (left, top, right, bottom) can be configured to show any number of widgets. By default, MI shows a monthly calendar widget on the right-side that links to daily journals. Those days with existing journals are highlighted. The default left-side sidebar shows an outline of the currently active document. MI ships with multiple widgets, listed below. An API is planned to allow creation of third-party widgets.

- Split View, browser, or multiple files. The main document viewport can be split along the horizontal and vertical axes any number of times to show either the current document in another view, a different document, or a uri-accessible resource (eg., web page). MI uses an internal "moreinfo::" URL scheme to reference its own files via URI. Any of these viewports can be "zoomed in," which reduces all other viewports to their minimum to show the maximum of the current document.

- Templating. Any page within the MI database can be used as a template for quickly scaffolding new pages. MI will bundle templates for commonly-used page types, like a contact person, project tracker, daily journal, etc.

- Focus mode. MI can be configured with a single document in a single viewport with no surrounding sidebars and a minimum of window chrome, for maximum focus on only the active document.

- Export. MI can export its data graph in a number of ways, including as a series of PDFs and HTML. When exporting to HTML MI can be used as a static site generator.

--

## Reserved metadata variables

Title
:The title of the page. Used when exporting and linking.

Author
:The author of the page. Used when exporting. A setting determines the default (unassigned) value of this variable.

Published
:The datetime this page should be published, when exporting. Useful for using MI as a blogging engine.

Created
:The datetime this page was created. This is a read-only variable.

Tags
:An array of tags for this page

Aliases
:An array of aliases for this page. An alias is considered a link to the page in the same way as the title.

## Reserved task management parameters

## Shipping widgets