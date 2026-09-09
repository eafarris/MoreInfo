import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss()],
  test: {
    environment: 'jsdom',
    globals: true,
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    // es2022 + safari15 (Chrome already clears this at 105): main.js uses a
    // top-level await (initPrefs()), which needs a target that supports it.
    target: ['es2022', 'chrome105', 'safari15'],
    minify: process.env.TAURI_ENV_DEBUG !== 'true',
    outDir: 'dist',
  },
});
