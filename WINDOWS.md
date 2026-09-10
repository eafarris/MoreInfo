# Windows Notes

The bulk of MoreInfo development happens on macOS. This file is the running
record of everything platform-specific discovered while building, running,
and debugging MoreInfo on Windows — so context isn't lost between sessions
(or between machines). Keep it updated as Windows-specific work continues;
treat it as a peer to `claude.md`, not a subset of it.

---

## Build & run

- Cargo workspace root is `C:\MoreInfo` (see `Cargo.toml`: members are
  `src-tauri` and `crates/front-matter`). Build output lands in
  `C:\MoreInfo\target\`, not `src-tauri\target\` — the latter only exists
  pre-workspace and is unused now.
- Dev loop: `npm run dev` (→ `tauri dev`) starts the Vite dev server on
  `:5173`, then `cargo run`s the Tauri host. First build after a `git pull`
  or dependency bump is slow (multi-minute); subsequent incremental builds
  are fast.
- No native debugger (`procdump`, `cdb`, `windbg`) is installed in this dev
  environment. For hang/crash diagnosis, fall back to:
  - `Get-Process -Name MoreInfo | Select Id, Responding` (PowerShell) to
    check whether the process is genuinely UI-thread-hung (`Responding:
    False`) vs. just slow.
  - Windows Error Reporting's AppHang archive:
    `C:\ProgramData\Microsoft\Windows\WER\ReportArchive\AppHang_MoreInfo.exe_*\Report.wer`
    — a `Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1002}`
    query surfaces the same hangs from the Application event log. These
    reports list loaded modules but do **not** include a call stack (no
    memory dump is configured), so they're only useful for coarse signal
    (e.g. "MSCTF/IME-related modules are loaded"), not root-causing.
- A release build (see below) lands at `target/release/`, which `.gitignore`
  already covers — no cleanup needed there.

---

## Native menu: platform differences

Tauri's menu is built by hand in `src-tauri/src/lib.rs` (`fn run()`) rather
than declared in `tauri.conf.json`, specifically so a navigation handler
could be installed. This means every menu is fully custom and platform
branching has to be done explicitly with `cfg!(target_os = "macos")` — it
is not automatic.

- The "MoreInfo" app menu (About/Settings/Services/Hide/Quit) is a macOS
  menu-bar convention and is now gated to macOS only. It used to be built
  unconditionally, which put a stray "MoreInfo" menu to the left of File on
  Windows with no way to Quit without it (fixed 2026-09-09).
- On Windows/Linux, **Quit lives in File** as "Exit" (`quit_with_text`),
  and a **Help menu** (About) is shown — also now gated to non-macOS, since
  macOS already has About in its app menu.
- **Settings** (`File → Settings…`, `Ctrl+,` / `Cmd+,`) is the same dialog
  and the same menu location on every platform — no Windows/macOS
  divergence there. It's implemented in `src/main.js`
  (`showSettingsDialog()`), not a native window.

---

## Resolved: "hang" right after launching the dev build

**Symptom:** shortly after launching `npm run dev` and bringing the window
to the foreground (clicking into it, or just Alt-Tabbing to it), the
process reports `Responding: False` in Task Manager / `Get-Process` — often
for minutes at a stretch — and looks fully frozen.

**Status as of 2026-09-10: root-caused. Two separate things were tangled
together here, both now resolved:**

**1. A real deadlock — fixed.** Correctly diagnosed in a prior Mac-side
Claude Code session before any Windows-side reproduction was even possible
(session `51b0b7a2-8e8e-472f-97ea-36b5572a566e`) — the user relayed that
session's findings here, they checked out exactly against the actual code,
and the fix below is a direct implementation of that diagnosis.

The mechanism: `save_window_size` was invoked from JS on a debounced
`tauri://resize`/`tauri://move` event, and queried
`window.outer_size()` / `outer_position()` / `is_maximized()` from that
async command context. On Windows, those queries block on the native UI
thread — and if that thread is still inside the nested, blocking message
loop Windows runs during an in-progress resize/move (or hasn't fully
unwound from one), the query deadlocks the whole app. This is a known,
unresolved upstream issue: tauri-apps/tao#381 / tauri-apps/tauri#3990,
"Application freezes when resized via a tauri command (Windows only)".
Fixed by replacing it with `install_window_geometry_persistence()` (in
`lib.rs`, called from `run()`): a native `on_window_event` handler that
captures size/position straight off the event payload (no query) and only
calls `is_maximized()`/`is_minimized()` synchronously from within that same
callback — safe, since that's in-thread, not a cross-thread round-trip.
Geometry is cached in memory and flushed to `preferences.json` only on
`CloseRequested`, which also sidesteps the *other* known issue in this
area (`tauri-plugin-window-state`'s own exit-time save racing with window
teardown on macOS). See the comment block above `WinState` in `lib.rs` for
the full explanation.

**2. Old hardware + unoptimized dev build — not a bug, just cost.** Once
the above was fixed, launches *still* showed long `Responding: False`
stretches. Testing (see below) traced this to WebView2 cold-start plus
JIT-compiling a 1.5MB unminified dev JS bundle, on a machine whose CPU
(Xeon E5-1630 v3, Haswell, ~2014) is roughly a decade behind Apple Silicon
in single-core throughput — the exact kind of work this hang is bound by.
Evidence:
  - With zero interaction, the process stayed fully responsive indefinitely
    (no hang from just sitting idle).
  - CPU usage climbed steadily throughout a "hung" stretch rather than
    flatlining — the signature of real, if slow, work completing, not a
    blocked wait.
  - A **release build launches in 1-2 seconds**, full styled UI, no
    hang, no perceptible delay — night and day from the dev build. This is
    the conclusive test: build one (see "Testing a release build" below)
    any time this needs re-verifying.

Two theories were tested and ruled out before landing on the above:
`-webkit-app-region: drag` conflicting with native decorations (removing
it didn't help), and an MSCTF/WebView2 deadlock suggested by
`MSCTF.dll`/`IMM32.DLL`/`textinputframework.dll` showing up in a WER hang
report's loaded-module list (`--disable-features=msctf` via
`additional_browser_args` didn't help either — that module list is just
what any Windows app with a text field loads, not evidence on its own).

**Net effect for day-to-day dev work:** the dev build (`npm run dev`) will
likely still feel slow to open and briefly unresponsive on this hardware —
that's expected now, not a regression to chase. If a *fresh* hang pattern
shows up (doesn't clear, or shows flat/zero CPU instead of climbing), that's
worth treating as a new bug, not this one recurring.

### Testing a release build

`npm run build` runs the full `tauri build`, including installer bundling
(not verified to work in this environment — untested). To just check launch
performance without bundling:

```powershell
cd C:\MoreInfo\src-tauri
cargo build --release --features tauri/custom-protocol
# binary lands at C:\MoreInfo\target\release\MoreInfo.exe
```

**The `--features tauri/custom-protocol` is not optional.** Tauri v2
decides whether a build loads `devUrl` or the embedded `frontendDist` at
*compile time*, based on whether the `tauri` crate's own `custom-protocol`
feature is enabled (`tauri-2.10.3/build.rs`: `dev = !custom_protocol`) —
**not** based on `--release` vs. debug, and not automatically inferred. The
`tauri` CLI (`tauri build`) enables this feature for you; a bare
`cargo build --release` silently does not, and the resulting "release"
binary will still try to load `http://localhost:5173` and fail with
"can't reach this page" the moment the dev server isn't running. Learned
this the hard way mid-investigation — cost a full rebuild cycle.

---

## Diagnostic toolbox reference

Quick reference for future Windows sessions debugging similar issues:

```powershell
# Is the process actually hung, or just slow?
Get-Process -Name MoreInfo | Select-Object Id, Responding, StartTime

# Any AppHang reports Windows already captured?
Get-WinEvent -FilterHashtable @{LogName='Application'; Id=1002} -MaxEvents 5 |
  Where-Object { $_.Message -match 'MoreInfo' }

# Full WER report contents (loaded modules, hang signature — no call stack)
Get-ChildItem "C:\ProgramData\Microsoft\Windows\WER\ReportArchive" -Filter "*MoreInfo*"
```

No `procdump`/`cdb`/`windbg` available in this environment as of
2026-09-10 — if a future investigation needs an actual call stack, that's
the gap to fill first (e.g. `winget install Sysinternals.ProcessMonitor`
or the Windows SDK debugging tools), with the user's go-ahead since it's a
new install.
