#!/usr/bin/env node
/**
 * Assemble the demo into a flat, self-contained directory.
 *
 *   node scripts/deploy-demo.mjs --out build
 *   node scripts/deploy-demo.mjs --out /var/www/html/devuser/swstatus
 *
 * The demo references ./swstatus.js, ./swstatus.css and ./data/snapshot.json,
 * so everything lands side by side and the result can be served by any static
 * host with no rewrites.
 */

import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(args.get('out') ?? join(root, 'build'));

const exists = async (p) => access(p).then(() => true, () => false);

await mkdir(join(out, 'data'), { recursive: true });

// Prefer built dist, fall back to src so the demo works before a build.
const jsSrc = (await exists(join(root, 'dist/swstatus.js')))
  ? join(root, 'dist/swstatus.js') : join(root, 'src/swstatus.js');
const cssSrc = (await exists(join(root, 'dist/swstatus.css')))
  ? join(root, 'dist/swstatus.css') : join(root, 'src/swstatus.css');

await cp(jsSrc, join(out, 'swstatus.js'));
await cp(cssSrc, join(out, 'swstatus.css'));
await cp(join(root, 'demo/index.html'), join(out, 'index.html'));

if (await exists(join(root, 'data/snapshot.json'))) {
  await cp(join(root, 'data/snapshot.json'), join(out, 'data/snapshot.json'));
} else {
  console.warn('deploy-demo: no data/snapshot.json yet, run `npm run refresh` first');
}

const size = async (p) => (await readFile(p)).byteLength;
console.log(`deployed to ${out}`);
console.log(`  swstatus.js   ${((await size(join(out, 'swstatus.js'))) / 1024).toFixed(1)} KB`);
console.log(`  swstatus.css  ${((await size(join(out, 'swstatus.css'))) / 1024).toFixed(1)} KB`);
