#!/usr/bin/env node
/**
 * Assemble dist/ from src/.
 *
 * The widget has no dependencies and targets browsers directly, so there is
 * nothing to transpile or bundle. This copies the source and emits a small ESM
 * wrapper so the package works from a <script> tag, from a bundler, and from a
 * CDN path without three different source trees.
 */

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

let js = await readFile(join(root, 'src/swstatus.js'), 'utf8');
const css = await readFile(join(root, 'src/swstatus.css'), 'utf8');

// Single source of truth for the version: package.json. Otherwise the string
// the widget reports drifts from the one npm installed.
// Guard on the pattern being found, not on the text changing: when the source
// already carries the right version, replacing is a no-op and that is fine.
const VERSION_RE = /(version:\s*)'[^']*'/;
if (!VERSION_RE.test(js)) throw new Error('build: no version field found in src/swstatus.js');
js = js.replace(VERSION_RE, `$1'${pkg.version}'`);

await writeFile(join(dist, 'swstatus.js'), js);
await writeFile(join(dist, 'swstatus.css'), css);

// ESM entry: the UMD file registers window.SWStatus and defines <sw-status>.
await writeFile(
  join(dist, 'swstatus.mjs'),
  `import './swstatus.js';\n` +
  `const SWStatus = globalThis.SWStatus;\n` +
  `export const { mount, load, derive, STATUS, version } = SWStatus;\n` +
  `export default SWStatus;\n`
);

const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(1)} KB`;
console.log(`dist/swstatus.js   ${kb(js)}`);
console.log(`dist/swstatus.css  ${kb(css)}`);
console.log('dist/swstatus.mjs  esm wrapper');
