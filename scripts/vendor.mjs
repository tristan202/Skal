// Kopierer xterm.js fra node_modules ind i renderer/vendor, så Tauri kan pakke den med.
import { cpSync, mkdirSync } from 'node:fs';

const files = [
  '@xterm/xterm/css/xterm.css',
  '@xterm/xterm/lib/xterm.js',
  '@xterm/addon-fit/lib/addon-fit.js',
  '@xterm/addon-unicode11/lib/addon-unicode11.js',
];
mkdirSync('renderer/vendor', { recursive: true });
for (const f of files) cpSync(`node_modules/${f}`, `renderer/vendor/${f.split('/').pop()}`);
