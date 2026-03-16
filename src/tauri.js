// Tauri v2 helpers — import wherever Rust commands or native dialogs are needed.
export const invoke = (cmd, args) => window.__TAURI__.core.invoke(cmd, args);
export const dialog = () => window.__TAURI__.dialog;
