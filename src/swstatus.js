/*!
 * swstatus.js — a dependency-free status widget for PagerDuty status-page data.
 *
 * Renders semantic markup with stable class names and data-status attributes.
 * It ships no colors, fonts, or spacing of its own — style it entirely from CSS.
 *
 *   <div id="status"></div>
 *   <script src="swstatus.js"></script>
 *   <script>SWStatus.mount('#status', { source: './data/snapshot.json' });</script>
 *
 * or as a custom element:
 *
 *   <sw-status src="./data/snapshot.json" refresh="60"></sw-status>
 *
 * Headless use — derive state and render it yourself:
 *
 *   const snap  = await SWStatus.load('./data/snapshot.json');
 *   const state = SWStatus.derive(snap);
 */
(function (global) {
  'use strict';

  var NS = 'swst';

  /* ------------------------------------------------------------------ *
   * Status vocabulary
   *
   * Services carry no health field of their own. The status page derives
   * health from posts (incidents / maintenances) that impact them, so we
   * do the same. Ranks let us reduce many impacts down to the worst one.
   * ------------------------------------------------------------------ */

  var STATUS = {
    operational:     { rank: 0, label: 'Operational',    icon: 'check'  },
    maintenance:     { rank: 1, label: 'Maintenance',    icon: 'wrench' },
    'partial-outage':{ rank: 2, label: 'Partial outage', icon: 'alert'  },
    outage:          { rank: 3, label: 'Outage',         icon: 'minus'  },
    // Not a severity, an absence of information. Rank 0 so it never wins a
    // worst-of comparison; it is only ever set deliberately.
    unknown:         { rank: 0, label: 'Unknown',        icon: 'clock'  }
  };

  // Upstream enum names -> our slugs.
  var IMPACT_SLUG = {
    'operational': 'operational',
    'partial outage': 'partial-outage',
    'outage': 'outage',
    'maintenance': 'maintenance'
  };

  /* Footer copy. Mirrors the severity mapping in the status-indicator
     proposal: one degraded service must not read as a full outage, and a
     failed fetch must never render as a false green. */
  var FOOTER_COPY = {
    operational:      'All systems operational',
    maintenance:      'Scheduled maintenance',
    'partial-outage': 'Some systems degraded',
    outage:           'Active incident',
    unknown:          'System status unreachable'
  };

  var ICONS = {
    check:  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 5"/></svg>',
    alert:  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.2L15 14H1z"/><path d="M8 6.4v3.2"/><path d="M8 12h.01"/></svg>',
    minus:  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="6.2"/><path d="M5 8h6"/></svg>',
    wrench: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10.6 5.4a2.9 2.9 0 01-3.8 3.8L3.3 12.7a1.4 1.4 0 002 2l3.5-3.5a2.9 2.9 0 003.8-3.8l-1.9 1.9-1.9-.5-.5-1.9z"/></svg>',
    clock:  '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.2 1.6"/></svg>'
  };

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function el(target) {
    return typeof target === 'string' ? document.querySelector(target) : target;
  }

  function parseDate(v) {
    if (!v) return null;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  function relTime(date, now) {
    if (!date) return '';
    var s = Math.round(((now || new Date()) - date) / 1000);
    var future = s < 0;
    s = Math.abs(s);
    var out;
    if (s < 45) out = 'just now';
    else if (s < 5400) out = Math.round(s / 60) + 'm';
    else if (s < 86400 * 2) out = Math.round(s / 3600) + 'h';
    else out = Math.round(s / 86400) + 'd';
    if (out === 'just now') return future ? 'shortly' : out;
    return future ? 'in ' + out : out + ' ago';
  }

  function absTime(date) {
    if (!date) return '';
    try {
      return date.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZoneName: 'short'
      });
    } catch (e) { return date.toISOString(); }
  }

  function worst(a, b) {
    var ra = (STATUS[a] || STATUS.operational).rank;
    var rb = (STATUS[b] || STATUS.operational).rank;
    return rb > ra ? b : a;
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  /* ------------------------------------------------------------------ *
   * Derivation: snapshot -> renderable state
   * ------------------------------------------------------------------ */

  function derive(snapshot, options) {
    snapshot = snapshot || {};
    options = options || {};

    // post_enums are referenced from posts by id (severity_id / status_id).
    var enums = {};
    (snapshot.post_enums || []).forEach(function (e) { enums[e.id] = e; });

    var enumName = function (id) {
      var e = enums[id];
      return e && e.name ? String(e.name).toLowerCase() : null;
    };

    var posts = (snapshot.posts || []).map(function (p) {
      var updates = (p.updates || []).slice().sort(function (a, b) {
        return (parseDate(a.reported_at) || 0) - (parseDate(b.reported_at) || 0);
      });
      var latest = p.latest_update || updates[updates.length - 1] || {};

      // An update's impacts reference a service and an impact-severity enum.
      var impacts = (latest.impacts || []).map(function (i) {
        var svc = i.service || {};
        var name = (i.severity && i.severity.name) || enumName(i.severity_id) || 'operational';
        return {
          serviceId: svc.id || i.service_id || null,
          serviceName: svc.display_name || svc.name || '',
          status: IMPACT_SLUG[String(name).toLowerCase()] || 'operational'
        };
      });

      var statusName = (latest.status && latest.status.name) || enumName(latest.status_id) || '';
      statusName = String(statusName).toLowerCase();
      var type = (p.post_type || 'incident').toLowerCase();

      var resolved = type === 'maintenance'
        ? statusName === 'completed'
        : statusName === 'resolved';
      var upcoming = type === 'maintenance' && statusName === 'scheduled';

      return {
        id: p.id,
        type: type,
        title: p.title || '(untitled)',
        statusName: statusName,
        severityName: (latest.severity && latest.severity.name) || enumName(latest.severity_id) || '',
        message: latest.message || '',
        postmortem: (p.postmortem && p.postmortem.message) || '',
        reportedAt: parseDate(latest.reported_at || p.reported_at),
        startsAt: parseDate(p.starts_at),
        endsAt: parseDate(p.ends_at),
        impacts: impacts,
        updates: updates.map(function (u) {
          return {
            reportedAt: parseDate(u.reported_at),
            statusName: (u.status && u.status.name) || enumName(u.status_id) || '',
            message: u.message || ''
          };
        }).reverse(), // newest first for display
        resolved: resolved,
        upcoming: upcoming,
        // Upcoming maintenance is announced but not yet degrading anything.
        active: !resolved && !upcoming
      };
    });

    // Sort newest first.
    posts.sort(function (a, b) { return (b.reportedAt || 0) - (a.reportedAt || 0); });

    var active = posts.filter(function (p) { return p.active; });
    var upcoming = posts.filter(function (p) { return p.upcoming; });
    var history = posts.filter(function (p) { return p.resolved; });

    // Fold active impacts onto services.
    var byId = {};
    active.forEach(function (p) {
      p.impacts.forEach(function (i) {
        if (!i.serviceId) return;
        byId[i.serviceId] = worst(byId[i.serviceId] || 'operational', i.status);
      });
    });

    var services = (snapshot.services || [])
      .filter(function (s) { return s.is_active !== false; })
      .map(function (s) {
        var st = byId[s.id] || 'operational';
        return {
          id: s.id,
          name: s.name,
          description: s.description || '',
          status: st,
          label: (STATUS[st] || STATUS.operational).label
        };
      });

    var overall = services.reduce(function (acc, s) { return worst(acc, s.status); }, 'operational');
    var degraded = services.filter(function (s) { return s.status !== 'operational'; });

    var headline;
    if (overall === 'operational') {
      headline = (snapshot.page && snapshot.page.headline) || 'All systems operational';
    } else if (overall === 'maintenance') {
      headline = 'Maintenance in progress';
    } else {
      headline = (overall === 'outage' ? 'Outage' : 'Partial outage') +
                 ' affecting ' + plural(degraded.length, 'service', 'services');
    }

    // A snapshot is a mirror, so it is only as true as the job that wrote it.
    // Past maxAge we stop making a claim: a confident green from a refresh job
    // that died three days ago is the one failure this widget must not have.
    var generatedAt = parseDate(snapshot.generated_at);
    var stale = false;
    if (options.maxAge > 0 && generatedAt) {
      var age = Date.now() - generatedAt.getTime();
      if (age > options.maxAge) {
        stale = true;
        overall = 'unknown';
        headline = 'Status unavailable';
        services = services.map(function (svc) {
          return { id: svc.id, name: svc.name, description: svc.description,
                   status: 'unknown', label: STATUS.unknown.label };
        });
        degraded = [];
      }
    }

    return {
      page: snapshot.page || {},
      generatedAt: generatedAt,
      stale: stale,
      source: snapshot.source || null,
      services: services,
      overall: overall,
      overallLabel: (STATUS[overall] || STATUS.operational).label,
      headline: headline,
      degraded: degraded,
      posts: posts,
      active: active,
      upcoming: upcoming,
      history: history
    };
  }

  /* ------------------------------------------------------------------ *
   * Rendering
   * ------------------------------------------------------------------ */

  function icon(name) { return ICONS[name] || ''; }

  function statusIcon(slug) {
    return icon((STATUS[slug] || STATUS.operational).icon);
  }

  function renderService(s, opts) {
    return '' +
      '<li class="' + NS + '__service" data-status="' + esc(s.status) + '">' +
        '<div class="' + NS + '__service-body">' +
          '<h3 class="' + NS + '__service-name">' + esc(s.name) + '</h3>' +
          (opts.descriptions && s.description
            ? '<p class="' + NS + '__service-desc">' + esc(s.description) + '</p>' : '') +
        '</div>' +
        '<span class="' + NS + '__pill" data-status="' + esc(s.status) + '">' +
          '<span class="' + NS + '__pill-icon" aria-hidden="true">' + statusIcon(s.status) + '</span>' +
          '<span class="' + NS + '__pill-label">' + esc(s.label) + '</span>' +
        '</span>' +
      '</li>';
  }

  function renderPost(p, now) {
    var when = p.type === 'maintenance' && p.startsAt ? p.startsAt : p.reportedAt;
    var names = p.impacts.map(function (i) { return i.serviceName; }).filter(Boolean);

    var updates = p.updates.map(function (u) {
      return '' +
        '<li class="' + NS + '__update">' +
          '<div class="' + NS + '__update-head">' +
            '<span class="' + NS + '__update-status">' + esc(u.statusName || '—') + '</span>' +
            '<time class="' + NS + '__update-time" datetime="' +
              esc(u.reportedAt ? u.reportedAt.toISOString() : '') + '" title="' +
              esc(absTime(u.reportedAt)) + '">' + esc(relTime(u.reportedAt, now)) + '</time>' +
          '</div>' +
          (u.message ? '<p class="' + NS + '__update-msg">' + esc(u.message) + '</p>' : '') +
        '</li>';
    }).join('');

    return '' +
      '<article class="' + NS + '__post" data-type="' + esc(p.type) + '" data-post-status="' + esc(p.statusName) + '">' +
        '<header class="' + NS + '__post-head">' +
          '<h3 class="' + NS + '__post-title">' + esc(p.title) + '</h3>' +
          '<span class="' + NS + '__badge" data-post-status="' + esc(p.statusName) + '">' +
            esc(p.statusName || p.type) + '</span>' +
        '</header>' +
        '<p class="' + NS + '__post-meta">' +
          '<time datetime="' + esc(when ? when.toISOString() : '') + '" title="' + esc(absTime(when)) + '">' +
            esc(relTime(when, now)) + '</time>' +
          (names.length ? '<span class="' + NS + '__post-services"> · ' + esc(names.join(', ')) + '</span>' : '') +
        '</p>' +
        (updates ? '<ol class="' + NS + '__updates">' + updates + '</ol>' : '') +
        (p.postmortem
          ? '<div class="' + NS + '__postmortem"><h4>Postmortem</h4><p>' + esc(p.postmortem) + '</p></div>'
          : '') +
      '</article>';
  }

  function renderSection(title, posts, now, modifier) {
    if (!posts.length) return '';
    return '' +
      '<section class="' + NS + '__section ' + NS + '__section--' + modifier + '">' +
        '<h2 class="' + NS + '__section-title">' + esc(title) + '</h2>' +
        posts.map(function (p) { return renderPost(p, now); }).join('') +
      '</section>';
  }

  function render(state, opts) {
    var now = new Date();
    var count = state.services.length;
    var meta = state.stale
      ? 'Snapshot is out of date, so this may not reflect current status'
      : state.overall === 'operational'
        ? plural(count, 'service', 'services') + ' operational'
        : plural(state.degraded.length, 'service', 'services') + ' affected of ' + count;

    var updatedBit = state.generatedAt
      ? '<span class="' + NS + '__updated"> · checked <time datetime="' +
          esc(state.generatedAt.toISOString()) + '" title="' + esc(absTime(state.generatedAt)) +
          '">' + esc(relTime(state.generatedAt, now)) + '</time></span>'
      : '';

    var html = '' +
      '<div class="' + NS + '__banner" data-status="' + esc(state.overall) + '" role="status">' +
        '<span class="' + NS + '__banner-icon" aria-hidden="true">' + statusIcon(state.overall) + '</span>' +
        '<div class="' + NS + '__banner-body">' +
          '<p class="' + NS + '__headline">' + esc(state.headline) + '</p>' +
          '<p class="' + NS + '__meta">' + esc(meta) + updatedBit + '</p>' +
        '</div>' +
      '</div>';

    if (opts.services !== false) {
      html += '<ul class="' + NS + '__services" role="list">' +
        state.services.map(function (s) { return renderService(s, opts); }).join('') +
        '</ul>';
    }

    if (opts.incidents !== false) {
      html += renderSection('Active incidents',
                state.active.filter(function (p) { return p.type === 'incident'; }), now, 'active');
      html += renderSection('Maintenance in progress',
                state.active.filter(function (p) { return p.type === 'maintenance'; }), now, 'maintenance');
      html += renderSection('Scheduled maintenance', state.upcoming, now, 'upcoming');
    }

    if (opts.history) {
      var hist = state.history.slice(0, opts.historyLimit || 10);
      if (hist.length) {
        html += renderSection('Recent history', hist, now, 'history');
      } else if (opts.incidents !== false && !state.active.length && !state.upcoming.length) {
        html += '<p class="' + NS + '__empty">' +
                  '<span class="' + NS + '__empty-icon" aria-hidden="true">' + icon('clock') + '</span>' +
                  'No incidents reported.</p>';
      }
    }

    if (opts.footer !== false) {
      var link = state.source
        ? '<a class="' + NS + '__source" href="' + esc(state.source) + '" rel="noopener noreferrer" target="_blank">Status page</a>'
        : '';
      html += '<footer class="' + NS + '__footer">' +
                '<span class="' + NS + '__footer-note">' +
                  esc(state.page.name || 'Status') +
                  (state.generatedAt ? ' · snapshot ' + esc(absTime(state.generatedAt)) : '') +
                '</span>' + link +
              '</footer>';
    }

    return html;
  }

  /* Compact footer indicator: a dot, a short label, and a link out.
     This is the variant intended for a site footer. */
  function renderFooter(state, opts) {
    var status = state ? state.overall : 'unknown';
    var label = opts.labels[status] || FOOTER_COPY.unknown;
    var href = opts.href || (state && state.source) ||
               'https://signalwire.trust.pagerduty.com/posts/dashboard';

    return '' +
      '<a class="' + NS + '-ind" data-status="' + esc(status) + '" href="' + esc(href) + '"' +
         ' target="_blank" rel="noopener noreferrer"' +
         ' aria-label="System status: ' + esc(label) + '">' +
        '<span class="' + NS + '-ind__dot" aria-hidden="true"></span>' +
        '<span class="' + NS + '-ind__label">' + esc(label) + '</span>' +
      '</a>';
  }

  function renderError(err) {
    return '<div class="' + NS + '__banner" data-status="unknown" role="status">' +
             '<span class="' + NS + '__banner-icon" aria-hidden="true">' + icon('alert') + '</span>' +
             '<div class="' + NS + '__banner-body">' +
               '<p class="' + NS + '__headline">Status unavailable</p>' +
               '<p class="' + NS + '__meta">' + esc(err && err.message ? err.message : String(err)) + '</p>' +
             '</div>' +
           '</div>';
  }

  /* ------------------------------------------------------------------ *
   * Data loading
   * ------------------------------------------------------------------ */

  function fetchOne(url) {
    // Cache-bust so a cron-refreshed snapshot is picked up promptly.
    var sep = url.indexOf('?') === -1 ? '?' : '&';
    return fetch(url + sep + '_=' + Date.now(), { credentials: 'omit' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching ' + url);
        return r.json();
      });
  }

  /* Accepts a URL or a list of them. With a list, the first source that answers
     wins and the rest are never touched. Point it at two hosts that do not share
     a failure domain and neither one going down takes the indicator with it. */
  function load(source) {
    var list = Array.isArray(source) ? source : [source];
    if (!list.length) return Promise.reject(new Error('no snapshot source given'));

    return (function attempt(i) {
      return fetchOne(list[i]).catch(function (err) {
        if (i >= list.length - 1) throw err;
        return attempt(i + 1);
      });
    })(0);
  }

  /* ------------------------------------------------------------------ *
   * Instance
   * ------------------------------------------------------------------ */

  var DEFAULTS = {
    source: './data/snapshot.json',
    data: null,          // supply a snapshot directly and skip fetching
    refresh: 0,          // ms between refetches; 0 disables
    maxAge: 0,           // ms; past this the snapshot is treated as unknown
    variant: 'dashboard',// 'dashboard' (full panel) or 'footer' (dot + label)
    href: null,          // link target for the footer variant
    labels: FOOTER_COPY, // footer copy per status
    columns: null,       // sets --swst-columns
    descriptions: true,
    services: true,
    incidents: true,
    history: true,
    historyLimit: 10,
    footer: true,
    className: '',
    onUpdate: null,
    onError: null
  };

  function mount(target, options) {
    var node = el(target);
    if (!node) throw new Error('SWStatus: mount target not found');

    var opts = {};
    Object.keys(DEFAULTS).forEach(function (k) { opts[k] = DEFAULTS[k]; });
    Object.keys(options || {}).forEach(function (k) { opts[k] = options[k]; });

    node.classList.add(NS);
    if (opts.className) {
      opts.className.split(/\s+/).filter(Boolean).forEach(function (c) { node.classList.add(c); });
    }
    if (opts.columns) node.style.setProperty('--' + NS + '-columns', opts.columns);

    var timer = null;
    var destroyed = false;

    var api = {
      state: null,
      snapshot: null,
      refresh: update,
      destroy: function () {
        destroyed = true;
        if (timer) clearInterval(timer);
        node.innerHTML = '';
        node.classList.remove(NS, 'is-loading', 'is-error');
      },
      // Swap in a snapshot without touching the network (used by the demo).
      setData: function (snapshot) {
        api.snapshot = snapshot;
        paint(snapshot);
      }
    };

    var footer = opts.variant === 'footer';

    function paint(snapshot) {
      var state = derive(snapshot, { maxAge: opts.maxAge });
      api.state = state;
      node.classList.remove('is-loading', 'is-error');
      node.setAttribute('data-status', state.overall);
      node.innerHTML = footer ? renderFooter(state, opts) : render(state, opts);
      if (typeof opts.onUpdate === 'function') opts.onUpdate(state, api);
    }

    function fail(err) {
      node.classList.remove('is-loading');
      node.classList.add('is-error');
      node.setAttribute('data-status', 'unknown');
      // Never leave a stale green behind: the footer degrades to a neutral
      // "unreachable" state rather than an error panel.
      node.innerHTML = footer ? renderFooter(null, opts) : renderError(err);
      if (typeof opts.onError === 'function') opts.onError(err, api);
      else if (global.console) console.error('SWStatus:', err);
    }

    function update() {
      if (destroyed) return Promise.resolve();
      if (opts.data) { paint(opts.data); return Promise.resolve(api.state); }
      if (!api.snapshot) node.classList.add('is-loading');
      return load(opts.source)
        .then(function (snap) { api.snapshot = snap; paint(snap); return api.state; })
        .catch(fail);
    }

    update();
    if (opts.refresh > 0) timer = setInterval(update, opts.refresh);

    return api;
  }

  /* ------------------------------------------------------------------ *
   * <sw-status> custom element
   * ------------------------------------------------------------------ */

  if (global.customElements && !global.customElements.get('sw-status')) {
    var SwStatusElement = function () {
      return Reflect.construct(HTMLElement, [], SwStatusElement);
    };
    SwStatusElement.prototype = Object.create(HTMLElement.prototype);
    SwStatusElement.prototype.constructor = SwStatusElement;
    Object.setPrototypeOf(SwStatusElement, HTMLElement);

    SwStatusElement.prototype.connectedCallback = function () {
      if (this._instance) return;
      var num = function (v, d) { var n = parseFloat(v); return isNaN(n) ? d : n; };
      var bool = function (v, d) { return v == null ? d : v !== 'false'; };
      this._instance = mount(this, {
        source: this.getAttribute('src') || DEFAULTS.source,
        refresh: num(this.getAttribute('refresh'), 0) * 1000,
        maxAge: num(this.getAttribute('max-age'), 0) * 1000,
        variant: this.getAttribute('variant') || DEFAULTS.variant,
        href: this.getAttribute('href') || null,
        columns: this.getAttribute('columns') || null,
        descriptions: bool(this.getAttribute('descriptions'), true),
        history: bool(this.getAttribute('history'), true),
        incidents: bool(this.getAttribute('incidents'), true),
        footer: bool(this.getAttribute('footer'), true)
      });
    };
    SwStatusElement.prototype.disconnectedCallback = function () {
      if (this._instance) { this._instance.destroy(); this._instance = null; }
    };

    global.customElements.define('sw-status', SwStatusElement);
  }

  /* ------------------------------------------------------------------ */

  var SWStatus = {
    mount: mount,
    load: load,
    derive: derive,
    STATUS: STATUS,
    version: '0.2.0'
  };

  global.SWStatus = SWStatus;
  if (typeof module !== 'undefined' && module.exports) module.exports = SWStatus;

})(typeof globalThis !== 'undefined' ? globalThis
   : typeof window !== 'undefined' ? window
   : typeof self !== 'undefined' ? self
   : this);
