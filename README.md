# @signalwire/status-widget

Embeddable platform status widget. Reads the SignalWire PagerDuty status feed and renders it
either as a compact footer indicator or as a full service dashboard. No dependencies, no
framework, no build step, and nothing running at request time.

```
●  All systems operational
```

**Live demo:** https://signalwire.github.io/status-widget/
**Live snapshot:** https://raw.githubusercontent.com/signalwire/status-widget/main/data/snapshot.json

## Why this exists

The signalwire.com footer links to the trust page. A visitor has to click through to learn
whether anything is wrong. This renders the answer in place, and links through for detail.

The PagerDuty status API is public and needs no token, but sends no CORS headers, so a browser
cannot read it directly. A GitHub Action mirrors it to a static snapshot that can be served
cross-origin. See "Data" below.

## Install

```bash
npm install @signalwire/status-widget
```

The same build is mirrored on the CDN, so no build step is required:

```html
<link rel="stylesheet"
      href="https://cdn.signalwire.com/@signalwire/status-widget/dist/swstatus.css">
<script src="https://cdn.signalwire.com/@signalwire/status-widget/dist/swstatus.js"></script>
```

The unversioned path redirects to the current release. Pin a version for production:
`https://cdn.signalwire.com/@signalwire/status-widget@0.2.0/dist/swstatus.js`. The package is
also on jsDelivr and unpkg, all three serving `Access-Control-Allow-Origin: *`.

## Use

### Footer indicator

The variant intended for a site footer. A dot, a short label, and a link to the status page.

```html
<sw-status
  variant="footer"
  src="https://raw.githubusercontent.com/signalwire/status-widget/main/data/snapshot.json"
  refresh="60"></sw-status>
```

### Full dashboard

```html
<div id="status"></div>
<script>
  SWStatus.mount('#status', {
    source: 'https://raw.githubusercontent.com/signalwire/status-widget/main/data/snapshot.json',
    refresh: 60000,
    columns: 2
  });
</script>
```

### Headless

Derive the state and render it yourself. Useful inside a Framer code component or any
framework that owns its own markup.

```js
import SWStatus from '@signalwire/status-widget';

const state = SWStatus.derive(await SWStatus.load(url));
// { overall, overallLabel, headline, services[], active[], upcoming[], history[], degraded[] }
```

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `source` | `./data/snapshot.json` | Snapshot URL, or a list tried in order |
| `maxAge` | `0` | ms; past this the snapshot reads as unknown. `0` disables |
| `data` | `null` | Supply a snapshot object directly and skip fetching |
| `variant` | `dashboard` | `dashboard` or `footer` |
| `refresh` | `0` | Milliseconds between refetches, `0` disables |
| `href` | status page URL | Link target for the footer variant |
| `labels` | see below | Footer copy per status |
| `columns` | `2` | Service grid columns |
| `descriptions` | `true` | Show service descriptions |
| `incidents` | `true` | Show active and scheduled posts |
| `history` | `true` | Show resolved posts |
| `historyLimit` | `10` | Maximum resolved posts |
| `footer` | `true` | Show the attribution row |
| `onUpdate` | `null` | `(state, api)` after every successful render |
| `onError` | `null` | `(error, api)` on fetch or parse failure |

The `<sw-status>` element accepts `src`, `variant`, `refresh` (seconds), `max-age` (seconds),
`href`, `columns`, `descriptions`, `history`, `incidents`, and `footer` as attributes.

`mount()` returns `{ state, snapshot, refresh(), setData(snapshot), destroy() }`.

## States

Five states, matching the severity mapping approved for the footer.

| Upstream severity | State | Copy |
| --- | --- | --- |
| all good | `operational` | All systems operational |
| minor | `partial-outage` | Some systems degraded |
| major | `outage` | Active incident |
| maintenance | `maintenance` | Scheduled maintenance |
| fetch failed | `unknown` | System status unreachable |

A failed fetch renders the neutral unknown state. It never shows a stale green.

### Staying honest when the data is old

A snapshot is a mirror, so it is only as true as the job that wrote it. Set `maxAge` and
anything older reads as unknown rather than as a confident green:

```js
SWStatus.mount(el, { variant: 'footer', maxAge: 30 * 60 * 1000 });
```

Every service goes unknown too, because if the snapshot is stale the per-service claims are no
more trustworthy than the overall one.

### Surviving a host outage

`source` also takes a list. The first host that answers wins, and the rest are never touched:

```js
SWStatus.mount(el, {
  variant: 'footer',
  maxAge: 30 * 60 * 1000,
  source: [
    'https://cdn.signalwire.com/status/snapshot.json',
    'https://raw.githubusercontent.com/signalwire/status-widget/main/data/snapshot.json'
  ]
});
```

Point it at two hosts that do not share a failure domain and neither one going down takes the
indicator with it.

Services carry no health field upstream. A service is operational unless an unresolved post
lists it under `impacts`. The widget takes the worst active impact per service, then rolls
those up to an overall state, which is the same rule the PagerDuty dashboard applies. One
degraded service therefore does not read as a full outage.

## Theming

The widget renders semantic markup with stable class names and sets `data-status` on the
root, the banner, every service, and every pill. `swstatus.css` is a default theme built on
SignalWire tokens. Override its custom properties, or skip the file and write your own rules.

```css
.swst {
  --swst-ok: #22c55e;
  --swst-warn: #FFD700;
  --swst-down: #ef4444;
  --swst-maint: #044EF4;
  --swst-card-bg: #181a28;
  --swst-border: rgba(255, 255, 255, 0.12);
  --swst-radius: 10px;
  --swst-columns: 2;
}
```

Add `.swst--light` for the light theme. `data-status` resolves to `operational`,
`partial-outage`, `outage`, `maintenance`, or `unknown`, and is usually the only hook a
custom skin needs.

## Data

The widget reads one merged JSON file. Build it with:

```bash
npm run refresh          # writes data/snapshot.json
```

The upstream API is public and needs no token, but it sends no CORS headers, so the browser
cannot read it directly. A GitHub Action rebuilds the snapshot every five minutes and commits
it here, and `raw.githubusercontent.com` serves it with `Access-Control-Allow-Origin: *`.

Expect roughly five minutes, and up to ten in the worst case, between a PagerDuty post and a
changed dot. That is the cost of having nothing to operate. If you need real time, point
`source` at an on-demand proxy instead; the widget does not care which it reads.

Health is derived, not read: services carry no status field upstream, so a service counts as
operational unless an unresolved post lists it under `impacts`.

## Development

```bash
npm run build     # assemble dist/
npm run refresh   # fetch a fresh snapshot
npm run serve     # build, refresh, deploy to build/, serve it
```

To deploy the demo to an arbitrary directory:

```bash
node scripts/deploy-demo.mjs --out /var/www/html/somewhere
```

## Browser support

Any browser with `fetch`, custom elements, and CSS custom properties. `color-mix()` is used
for pill tints and degrades to the untinted background where it is unsupported.

## License

MIT
