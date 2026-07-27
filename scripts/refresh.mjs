#!/usr/bin/env node
/**
 * Build a same-origin status snapshot from the PagerDuty status page API.
 *
 * The upstream API is public and needs no token, but it sends no CORS headers,
 * so a browser on another origin cannot read it. This script pulls it from a
 * server or a CI runner and writes one merged JSON file that CAN be served with
 * `Access-Control-Allow-Origin`.
 *
 *   node scripts/refresh.mjs [--out data/snapshot.json] [--subdomain signalwire]
 *
 * Exits non-zero on any upstream failure so a scheduled run does not overwrite
 * a good snapshot with a partial one.
 */

import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const SUBDOMAIN = args.get('subdomain') ?? 'signalwire';
const BASE = `https://${SUBDOMAIN}.trust.pagerduty.com`;
const OUT = resolve(args.get('out') ?? 'data/snapshot.json');

// Reach back far enough to cover the page's whole history and forward far
// enough to pick up scheduled maintenance windows.
const SINCE = args.get('since') ?? '2025-12-01T00:00:00Z';
const UNTIL = new Date(Date.now() + 180 * 864e5).toISOString().replace(/\.\d+Z$/, 'Z');

async function get(path) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(BASE + path, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(20000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw new Error(`${path}: ${err.message}`);
      await new Promise((r) => setTimeout(r, attempt * 750));
    }
  }
}

/** Walk continuation tokens so a busy window is never silently truncated. */
async function getAllPosts() {
  const posts = [];
  let token = null;
  let guard = 0;

  do {
    const qs = new URLSearchParams({ since: SINCE, until: UNTIL, limit: '500' });
    if (token) qs.set('continuation_token', token);
    const page = await get(`/api/posts?${qs}`);
    posts.push(...(page.posts ?? []));
    token = page.continuationToken ?? null;
  } while (token && ++guard < 20);

  if (token) console.warn('refresh: stopped paginating after 20 pages');
  return posts;
}

const [data, services, enums, posts] = await Promise.all([
  get('/api/data'),
  get('/api/services'),
  get('/api/post_enums'),
  getAllPosts()
]);

// `name` and `business_services` live under layout_settings, not layout.
const settings = data?.layout?.layout_settings ?? {};
const sp = settings.statusPage ?? {};
const uptime = settings.service_uptime_settings ?? {};

// business_services carries the human descriptions and the display order;
// /api/services carries display_name and is_active. Merge on business_service_id.
const descriptions = new Map(
  (settings.business_services ?? []).map((b) => [b.id, b])
);
const order = new Map(
  (settings.business_services ?? []).map((b, i) => [b.id, i])
);

const merged = (services.services ?? [])
  .map((s) => ({
    id: s.id,
    business_service_id: s.business_service_id,
    name: s.display_name || s.name,
    description: descriptions.get(s.business_service_id)?.description ?? '',
    is_active: s.is_active !== false
  }))
  .sort((a, b) => (order.get(a.business_service_id) ?? 999) -
                  (order.get(b.business_service_id) ?? 999));

const snapshot = {
  generated_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  source: `${BASE}/posts/dashboard`,
  page: {
    name: settings.name ?? null,
    status_page_id: data?.layout?.status_page_id ?? null,
    headline: sp.globalStatusHeadline ?? null,
    columns: sp.numberOfColumns ?? '2',
    logo_url: settings.globalComponents?.logoFileUrl ?? null,
    home_url: sp.linkUrlText ?? null,
    home_text: sp.linkText ?? null,
    uptime_days: uptime.days ?? null,
    created_at: uptime.status_page_creation_date ?? null
  },
  services: merged,
  post_enums: enums.post_enums ?? [],
  posts
};

await mkdir(dirname(OUT), { recursive: true });
// Write then rename so a reader never sees a half-written file.
await writeFile(`${OUT}.tmp`, JSON.stringify(snapshot, null, 1));
await rename(`${OUT}.tmp`, OUT);

console.log(
  `wrote ${OUT}  services=${merged.length}  posts=${posts.length}  at ${snapshot.generated_at}`
);
