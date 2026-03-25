# MoreInfo

MoreInfo ("MI") is a markdown-based note taking app for macOS and Windows. It allows for the building of a personal knowledge base (PKB) through wiki-like linking, daily journals, and task management. It uses plaintext markdown documents for all of its source data.

## Engineering and Architecture

MI is built using Rust and Tauri. Styling of the front-end is done with TailwindCSS and is themeable, and the Phosphor Icon set is used as glyphs. Where possible, MI defaults to OS-native API calls, forms, and styling. While being developed as an app for macOS, the toolset has been selected because of its ability to be recompiled as near-native apps for other operating systems. At least macOS, iOS, iPadOS, and Windows binaries are planned.

Its datastore is a structured folder hierarchy consisting of plain text files in markdown format as its source of truth. While a 'moreinfo.sqlite' SQLite database exists, it is created and updated based on the contents of the markdown files. The database exists to speed up things like searching and linking, and other routines that would be easier to create and cache rather than build from the filesystem. A file watch mechanism exists to allow MI to automatically keep the database in sync with the filesystem, including a journal within the database keeping track of the last time the database was updated, which would trigger an update with newer files on launch or reindex.

To wit, the SQLite database is _derived_ from the content of the markdown files in the datastore. The database is _not authoritative_, and only reflects the truth as it exists in the MD files on disk. No functionality or data is lost should the SQLite database be destroyed or corrupted. It can always be reconstructed by parsing the Markdown files on disk.

The Markdown files in the datastore themselves are given a filename on first save, derived by various means. Once the file (a "page" in MI parlance) has a filename, that filename is immutable. The idea of the MI datastore is that filenames don't matter to the user at all.

The UI consists of a main active document editing area surrounded by sidebars on all four sides. Sidebars can be resized along their main axis. Sidebars contain Widgets, which show navigational aids and additional content. Some widgets retain a fixed size along one or more axes, but most widgets can be resized to fill space in the sidebars in both axes. It is good to use Visual Studio Code as an example of how sidebars should behave when figuring out ambiguous directions or behaviors.

## Glossary of terms

Datastore
: The root of MI's data structure. By default, this is `~/Documents/MoreInfo` on all platforms. The datastore has a `journal` folder storing daily journals, and a `wiki` folder containing more generic pages, and a 'templates' folder containing template pages. Users may optionally create their own "category" of pages, which will be expressed in the filesystem as a top-level folder. The datastore contains `scratchpad.md`, a file that is not a true 'page' but exists in the ScratchPad Widget and is automatically saved and retrieved like other pages. Also in this datastore is `moreinfo.sqlite`, an SQLite database built from the content within 'journal' and 'pages' for quicker searching and linking, as well as other pieces of data and metadata that would be cheaper to cache than build from the filesystem. Finally, a `preferences.json` file contains user preferences, including color/font/theme choices, basic editor configuration like tab stops and spaces vs tabs, export preferences, etc.

Page
: A plaintext file within the datastore. All pages are assumed to use Markdown formatting and carry the "`.md`" extension. Pages are the source of truth for Moreinfo. Pages can be linked within each other to form a wiki-like structure. There are several types of pages, including 'wiki' pages, 'journal' pages and 'template' pages. Users may create their own own "categories" of pages.

Wiki
: The 'generic' page that exists within the 'wiki' folder of the datastore. These pages are given a filename upon creation, either from their title or a user-supplied filename. The title (and therefore the filename) is derived based on how the page is created. If the page is created as the result of clicking on a wiki link, that will be the title of the page. A page can also be created by File->New page from the menu, at which point the user is prompted for the title of the page.

Journal
: A special type of page that exists within the 'journal' folder of the datastore. These files are named `YYYY-MM-DD.md`, after a day on the calendar. Up to one journal page can exist for each day. The default startup view of MI is today's journal page. The Calendar widget allows navigation by day, as well as a date picker in the menu under View->Journal.

Template
: A special type of page that exists within the 'templates' folder of the datastore. Template pages can be used to quickly create other pages via "File->New from template" in the menu system. A page can be saved as a template via "File->Save as template" in the menu system. Templates retain all metadata and their values, with the exception of 'title,' which the user is prompted for on page creation. Content (non-metadata) within the template page is also retained when creating a page based on the template. Templates are helpful when creating 'categories' of pages; they define common content and metadata for future pages. The 'templates' folder is walked when updating the database only to enumerate the templates available; they are not indexed for search or links, as they don't represent any content themselves.

Metadata
: A series of key/value pairs that describe the document in a structured way. Some metadata variables are based on filesystem data by default and can be read-only. Most variables can be set within a YAML-like front-matter structure. The variable name and its value are delimited by zero or more spaces, followed by a colon ("`:`"), followed by zero or more spaces (regex `\s*:\s*`). The structure itself is delimited by triple-dashes ("`---`") alone on a line, followed by the variable assignments, followed by another line of only triple dashes. In typical YAML front-matter, this section must be at the beginning of the file; for MI pages this structure could be anywhere, including multiple places. A final structure for defining metadata comes at the end of a file, using the "email .sig" delimiter of double dashes followed by a space ("`-- `") alone on a line, then continuing to the end of the file. Any variable that is defined more than once will use its last definition, from top to bottom through the file. Variable names are _case-insensitive_, and stored in the db cache as such. Values are _case sensitive_, though reserved metadata variables can change this behavior (eg., "tags" are _case insensitive_).

: Metadata variables are weakly typed, with four recognized types: string, date (or datetime), boolean, and array.

Metadata string
: A variable is defined as a string based on the data after the delimiter (regex '\s*:\s*'). If strings are surrounded by single or double quotes, the quotes themselves are not considered part of the string (so `string` would match `'string'` or `"string"`). If the string can be successfully parsed by "chrono_node," a pulled-in JS library, it is considered a metadata _date_ rather than a string. If the string can be successfully parsed as an array delimited by commas, it is considered a metadata _array_ rather than a string, _unless_ the string is surrounded in quotes. If the string matches one of the metadata boolean values (defined below), it is considered a metadata _boolean_ rather than a string. String values are _case sensitive_.

Metadata date
: A variable is defined as a date based on the data after the delimiter (regex: '\s*:\s*'). If the data can be successfully parsed by the JS library "chromo-node," it is considered a Metadata date. This allows not only for date patterns (eg., "YYYY-MM-DD") but also human-parsable relative dates like "tomorrow," "last may," or "1st Tuesday each month."

Metadata boolean
: A variable is consider a boolean when its value is one and only one of the following pairs (_case insensitive_): True/False, T/F, 1/0, Yes/No, Y/N, On/Off. In each case, the former value results to a "TRUE" value and the latter to "FALSE."

Metadata array
: A variable is defined as an array based on the data after the delimiter (regex: '\s*:\s*'). If the data can be parsed into an array delimited by commas, it is considered a metadata array. While spaces around the commas are considered part of the delimiter, spaces not around the commas are considered significant to the element of the array. For example, the metadata `tags: tag one, two, three` is exploded into the array named `tags` consisting of three elements: `['tag one', 'two', 'three']`. A user may write a metadata array using brackets and quotes (eg., ['one', 'two', 'three']) for clarity or as their own style if they wish.

Wiki link
: Pages are linked across other pages through their titles or aliases. When a word or phrase is surrounded in double-square brackets ("`[[`…`]]`"), that is treated as a link to a page with that title. When clicking on a wiki link, the user is either taken to the page with that title, or a new active document is created with that title. Also supported is using "CamelCase" to create a link to a page titled "Camel Case," but _CamelCase cannot create new pages_. UI in the active document area allows for breadcrumb navigation back through previous links. Explicit wiki links to journal pages can also be created, using [[YYYY-MM-DD]] format. As with wiki pages, journal pages can be created if they do not previously exist.

Backlink
: Pages that have links _to_ them will show those links in the ReferencesWidget. There are two types of backlinks: "Linked References" include any explicit link (ie., bracketed wiki links) link to the page. "Unlinked References" include any time the title of the page exists in a full-text search of all wiki pages or journal pages (but not templates). Each reference found is enumerated in the appropriate section as bottom-matter on the page.

Linked Reference
: An explicit link to a page, by including the title of the page within double-square brackets. Linked References create a 'two-way' link between pages: A click on the reference to get to the page, and a click on the "Linked References" in the ReferencesWidget to go to the previous page.

Unlinked Reference
: Any instance of the title or any alias of a page included in a full-text search of all content. Unlinked References create a 'one-way' link between pages. The unlinked reference will show in the References Widget, but because there was no explicit link given in the text, there is no link back to the implicitly referenced page.

Task
: Pages can be littered with tasks, which are a newline started by either `[]`, or `- []`, with an optional space between the single-square brackets. Tasks adhere loosely to the [todotxt](https://github.com/todotxt/todo.txt) and [TaskPaper](https://www.taskpaper.com/guide/getting-started/) formats, with allowances for Markdown, and some additional reserved parameters. Task management is a major feature of MI and is documented in its own "TASK MANAGEMENT.md" file.

## Features

- Uses plain-text Markdown as its default format. All data is stored in plain-text files. While an SQLite database is used to quickly implement features such as searching and linking, the database is always derived from the text files within the MI folder.

- Supports wiki linking to other pages via double-square brackets. Words or phrases surrounded by double-square brackets ("`[[`"…"`]]`") are links to pages that either already exist or are created when clicked. Status: FULLY IMPLEMENTED.

- Pages that are part of the wiki have backlinks to all of the files where the page is referenced. References are separated into either linked (ie., double-square bracketed) or unlinked (a simple string match without delimiters. Status: FULLY IMPLEMENTED.

- Supports daily journals. These are markdown files with the filename pattern of `YYYY-MM-DD.md`. Each day may have up to one daily journal page. Like wiki pages, these files are not created until they are opened. Files for dates in the future are supported. "Journal Notes" is the default view of the app, which opens the current day's daily journal. Status: FULLY IMPLEMENTED.

- Supports Jekyll-style front matter. Pages can have metadata embedded in them using lines between triple-dashes ("---"). In addition, late-matter metadata can be added to the end of the file using lines defined by the start of the metadata with the "email .signature" delimiter, double-dash plus space ("-- "), and continuing until the end of the file. Front matter are used as variables, both some built-in variables with significance as well as on-the-fly database columns using user-defined metadata items. Reserved variables are listed below. Metadata can have three types: string, date, and array. Status: FULLY IMPLEMENTED.

- Support for numerous types of task management. Any line can be turned into a task by beginning the line with a square-bracket pair, either with or without a space between (ie., "`[]`" or "`[ ]`"). (GFM's default task list format of `- []` is also supported when creating a list of tasks. Once a line has been marked as being a task, it is rendered with a clickable checkbox, and can have its own parameters to define the scope of the task, like "project:" "now", "later", "todo", "someday", "date:YYYY-MM-DD", etc. The entire list of built-in parameters is listed below, and users can create their own depending on their needs. Task management will include several types of repeating tasks. Task management gets its own spec document, "TASK MANAGEMENT.md". Status: PLANNING.

- Support for use as a Static Site Generator (SSG) for exporting some or all notes and journals as a complete web site. SSG gets its own spec document, "SSG.md". Status: PLANNING.

- Support for widgets on sidebars. Collapsible or popover sidebars on all four sides (left, top, right, bottom) can be configured to show any number of widgets. By default, MI shows a monthly Calendar widget on the right-side that links to daily journals. Those days with existing journals are highlighted. The default left-side sidebar shows the Outline widget for the currently active document. MI ships with multiple widgets, listed below. An API is planned to allow creation of third-party widgets. Status: PARTIALLY IMPLEMENTED.

- Scratch Pad. A special widget that offers a place to hold temporary text, run calc blocks, etc., The Scratch Pad is not indexed and cannot be linked, but is saved across sessions. The Scratch Pad has special operations to manipulate its contents, like sorting lines, converting between document formats (e.g., CSV  → JSON) and the like. Users can write their own functions.

- Templating. Any page within the MI database can be used as a template for quickly scaffolding new pages. MI will bundle templates for commonly-used page types, like a contact person, project tracker, daily journal, etc. Status: PARTIALLY IMPLEMENTED.

- Focus mode. MI can be configured with a single document in a single viewport with no surrounding sidebars and a minimum of window chrome, for maximum focus on only the active document. Status: PLANNING.

- Calc blocks. Typing '@calc' by itself on a line puts the editor into calculator mode, where each line is considered a mathematical expression. Expressions keep the result of the expression as the first numerator in the next expression, for a tape-calculator feel, if appropriate. Calc blocks can also do unit and base conversion. Calc blocks are supported in all pages, including the Scratch Pad widget. Status: PARTIALLY IMPLEMENTED.

-
## Reserved metadata variables

Title
: Used as in the header of the active document viewport. Can be explicitly set within metadata. Defaults to "DD MMM YYYY" if the page is a journal page. Non-journal pages should use the `<title>` tag of the document, or, if not specified, the first `<h1>` of the document. If none of these are specified, the filename from the filesystem will be used as a last resort. Once a file is given a filename, that name in the filesystem does _not_ change based on any edits to the page that change the _title_. Title and Filename are separate concepts; meeting only that a page needs a filename that can be extracted from a title, and a file needs a title, that can be extracted from a filename. But this only happens _once_ to give the page an initial filename on the filesystem.

Category
: A wiki page can have one optional category, which can be used to group like pages together. Categories describe the type of entity that a page represents, like a 'meeting', 'person,' 'project,' etc. Typically page templates are used to create a page within a category, as these pages should all share a similar structure and metadata. Categories have two important distinctions from tags: A page can have zero or one category, where a page can have many tags; and a category answers the question "what kind of page is this?" whereas tags answers "what topics is this page about?" Unlike other metadata, a page created based on a template will retain the category metadata value from a template.

Publish-date
: Datetime that this page should be published, when exporting. Can be explicitly set within metadata. Defaults to the last-modified date of the document from the filesystem.

Created-date
: Datetime the page was created. Read only variable. Defaults to the creation date of the document from the filesystem.

Unpublish-date
: Datetime the page should be unpublished, when exporting. Can _only_ be set within metadata; there is no default.

Tags
: An array of taxonomical tags associated with this page. Can _only_ be set within metadata; there is no default. The reserved "tags" variable name has special behavior in that the array values are treated and stored as _case insensitive_, ie., there is no difference between the tag "One", "one", or "oNe".

Aliases
: An array of aliases for this page. Can _only_ be set within metadata; there is no default. Aliases are treated the same as page titles when linking; they can be defined as linked references, or found as unlinked references. Aliases are treated as surrounded by whitespace and other alphanumeric boundaries. That is, a page with an alias of "eric" will hit on the string "Eric said this" but not on the string "The future of America."  The reserved "aliases" variable name has special behavior in that the array values are treated and stored as _case insensitive_, ie., there is no difference between the aliases "Eric" and "eric".

Alias
: Same as "aliases," but holds only one string instead of an array.

Favorite
: A boolean value, when, if true, allows the page to show up in the FavoritesWidget. 

## Reserved task management parameters

To be written. See the task management spec document at "TASK MANAGEMENT.md".

## Shipping widgets

Calendar
: A monthly calendar with prev/next month buttons as well as a year/month picker that shows when clicking the month title. Days with existing journal pages are highlighted with a dot below the date. "Today" is highlighted with a circle around today's date. Clicking on any date will take you to the journal page for that day, creating it if it does not exist. The Calendar widget can be stretched along its Y axis, but cannot be resized in the X axis. Status: FULLY IMPLEMENTED.

Metadata
: A list of defined metadata variables and their values existing in the current active document. A checkbox allows the show/hide of built-in variables as described above, if they are not explicitly defined. The Metadata widget is resizable on both axes. Status: FULLY IMPLEMENTED.

References
: A list of linked references that lead to the active page, and a list of unlinked references where the active page is mentioned. Status: FULLY IMPLEMENTED.

Counter
: A paragraph, sentence, word, and character counter for the active document. The Counter widget is resizable on both axes. Status: FULLY IMPLEMENTED.

Page
: A widget displaying any page from the datastore, including the active document. Has a top-bar UI for searching for pages. By default, the Page Widget lives on the left sidebar. The Page widget is resizable on both axes. Status: PARTIALLY IMPLEMENTED.

Tasks
: A widget containing all uncompleted tasks found in daily journals. A small UI at the top of the widget allows filtering which tasks appear. The Task widget is resizable on both axes. See the task management spec document "TASK MANAGMENT.md" file for more information. Status: PLANNING.

Browser
: A _simple_ display of any URI-reachable content. The UI would consist entirely of the title bar and forward/back pages. We will not be building a full browser UI. Clicked links will open in the same widget, while Cmd+Click will open in a new Browser widget, smartly positioned based on the location and position of the current widget. The Browser widget is resizable on both axes. Status: PARTIALLY IMPLEMENTED.

Search
: A widget containing the results of a full-text search of the datastore. Has a top-bar UI for search terms which can be expanded to allow for operators and filters. The Search widget is resizable on both axes. Status: PARTIALLY IMPLEMENTED.


## Current Feature Implementation Status

- [x] Markdown editor
- [x] Metadata parsing
- [x] Calendar widget
- [x] Metadata widget
- [x] Left, Right sidebars
- [x] side-by-side realtime Markdown render preview
- [X] Top, bottom sidebars
- [X] Resizable sidebars
- [X] Full-text search
- [X] @calc blocks
- [ ] Operators, filters for full-text search
- [X] SQLite database as cache for linked references
- [X] SQLite database as cache for full-text search
- [X] SQLite database as cache for unlinked references
- [ ] SQLite database as cache for exposed tasks
- [X] Filesystem watcher to keep DB up to date and autosave
- [X] Basic widget API
- [X] Counter widget
- [X] Outline widget
- [X] Page widget
- [X] Browser widget
- [X] Search widget
- [X] Wiki links
- [X] Page aliases
- [X] Page References widget
- [X] Page templates
- [ ] Basic tasks
- [ ] Tasks widget
- [ ] Expanded tasks : TODO, FIXME, Later, Someday, Deadline, Done