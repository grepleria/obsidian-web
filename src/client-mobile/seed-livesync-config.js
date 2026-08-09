/**
 * seed-livesync-config.js — provisioned LiveSync setup for a self-hosted
 * deployment: fetch this origin's LiveSync settings and write them straight
 * into the OPFS vault's `.obsidian/plugins/obsidian-livesync/data.json`
 * before Obsidian boots, so the plugin comes up already configured and
 * immediately replicates the remote vault down. No setup URI to paste, no
 * settings tab to fill in.
 *
 * Sibling of seed-system-plugins.js (which puts the plugin FILES in place)
 * and seed-example-vault.js; same `store` contract — only readFile/writeFile
 * are used, so a fake with that shape works in tests. Attaches to
 * window.__owSeedLivesyncConfig; runs under node:test too.
 *
 * OPT-IN, and inert by default: everything below is gated on
 * `window.__owConfig.provision.configUrl`, which no upstream profile sets.
 * With it unset this module fetches nothing and writes nothing, so the app
 * and demo profiles behave exactly as before.
 *
 * WHY A SERVER ENDPOINT IS ACCEPTABLE HERE (it would not be for the public
 * deployment): a self-hosted instance sits behind its own identity gate, and
 * the endpoint is same-origin — the visitor has already authenticated to
 * reach the page at all. The endpoint is expected to be served with
 * `Cache-Control: no-store`.
 *
 * ⚠️ This deliberately puts CouchDB credentials + the E2E passphrase into the
 * browser's OPFS. That is the same place the plugin would store them after a
 * manual setup — the difference is only who types them. Deployments that do
 * not want the passphrase served must leave `provision` unset and keep the
 * manual/setup-URI flow.
 */
(function () {
  'use strict';

  var MARKER = '.obsidian/plugins/obsidian-livesync/.ow-provisioned-rev';
  var DATA = '.obsidian/plugins/obsidian-livesync/data.json';

  // Settings the plugin reads (schema confirmed against vrtmrz/obsidian-livesync
  // incl. its headless CLI: couchDB_URI/USER/PASSWORD/DBNAME, encrypt,
  // passphrase, isConfigured). Anything the endpoint sends is merged over
  // these, so the server stays the source of truth for the whole shape.
  var DEFAULTS = {
    liveSync: true,
    syncOnSave: true,
    syncOnStart: true,
    encrypt: true,
    usePluginSync: false,
    isConfigured: true
  };

  function randomSuffix() {
    try {
      var a = new Uint8Array(4);
      (self.crypto || window.crypto).getRandomValues(a);
      return Array.prototype.map.call(a, function (b) {
        return ('0' + b.toString(16)).slice(-2);
      }).join('');
    } catch (_) {
      return String(Date.now()).slice(-8);
    }
  }

  /**
   * @param store  OpfsStore-shaped {readFile, writeFile}
   * @param opts   {configUrl}  — required; caller passes window.__owConfig.provision
   * @returns true when it wrote a config this call, false when it skipped.
   */
  async function seedLivesyncConfig(store, opts) {
    var cfgUrl = opts && opts.configUrl;
    if (!cfgUrl) return false;                      // not a provisioned deployment

    // Cache-bust for the same reason seed-example-vault.js does: a still-
    // controlling previous service worker can serve a stale cache-first copy
    // of this URL right after a redeploy, which would pin the vault to
    // rotated-away credentials.
    var url = cfgUrl + (cfgUrl.indexOf('?') === -1 ? '?' : '&') + 'ow=' + Date.now();

    var payload = null;
    try {
      var resp = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
      // 404 = this origin serves no provisioning (the upstream-neutral path):
      // fall through silently and leave the manual flow untouched.
      if (!resp || !resp.ok) return false;
      payload = await resp.json();
    } catch (_) {
      return false;                                 // offline/blocked → manual flow
    }
    if (!payload || !payload.livesync) return false;

    // Rev-gate, mirroring seed-system-plugins.js's .ow-seeded-version: write
    // once, then again only when the server's rev changes. That is what makes
    // credential rotation propagate on the next visit instead of needing the
    // visitor to clear site data — and what stops us clobbering settings the
    // user has since tuned by hand under an unchanged rev.
    var rev = String(payload.rev == null ? '' : payload.rev);
    var seen = null;
    try { seen = (await store.readFile({ path: MARKER, encoding: 'utf8' })).data; } catch (_) {}
    if (seen !== null && seen === rev) return false;

    // Preserve any existing local settings (device name, UI prefs) and let the
    // served config win on the keys it specifies.
    var existing = {};
    try {
      var raw = (await store.readFile({ path: DATA, encoding: 'utf8' })).data;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') existing = parsed;
    } catch (_) {}

    var merged = {};
    var k;
    for (k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) merged[k] = DEFAULTS[k];
    for (k in existing) if (Object.prototype.hasOwnProperty.call(existing, k)) merged[k] = existing[k];
    for (k in payload.livesync) {
      if (Object.prototype.hasOwnProperty.call(payload.livesync, k)) merged[k] = payload.livesync[k];
    }

    // Every browser replica needs its own identity, or peers collide in the
    // remote DB's device list. Generated once and preserved across re-seeds.
    if (!merged.deviceAndVaultName) {
      merged.deviceAndVaultName = 'web-' + randomSuffix();
    }

    await store.writeFile({ path: DATA, data: JSON.stringify(merged, null, 2), encoding: 'utf8' });
    await store.writeFile({ path: MARKER, data: rev, encoding: 'utf8' });

    // Adopt the server's vault name locally. boot.js has to create the vault
    // BEFORE this fetch resolves (it is what makes the fetch happen at all),
    // so it necessarily uses the generic provision.vault.name placeholder;
    // this is the first moment the real name is known. Registry-only cosmetic
    // rename -- never fails the seed.
    try {
      if (payload.vault && typeof window !== 'undefined' && window.__owLocalVaults
          && window.__owVaultId && window.__owLocalVaults.get(window.__owVaultId)
          && window.__owLocalVaults.get(window.__owVaultId).name !== payload.vault) {
        window.__owLocalVaults.rename(window.__owVaultId, payload.vault);
      }
    } catch (_) {}

    return true;
  }

  /**
   * Rev watchdog — the boot-time seed only reaches a page that RELOADS. A
   * long-lived tab keeps replicating with the credentials it booted with, so
   * a workspace recreate (rotated couch password → new served rev) leaves the
   * open replica 401-ing until a manual hard refresh (observed live on the
   * vaulte2e delete→recreate test, 2026-08-09). This polls the same endpoint
   * on tab focus + a slow interval; on rev DRIFT it re-runs the seeder (same
   * merge + marker semantics) and reloads the page so the plugin boots with
   * the new credentials. A never-seeded vault (no marker) stays boot's job —
   * the watchdog only chases rotation, never first provisioning.
   *
   * @returns 'skipped'   — not provisioned / endpoint unavailable / bad shape
   *          'unchanged' — no marker yet, or served rev matches
   *          'reloaded'  — drift: re-seeded and triggered reload
   */
  async function checkRevOnce(store, opts, reload) {
    var cfgUrl = opts && opts.configUrl;
    if (!cfgUrl) return 'skipped';
    var url = cfgUrl + (cfgUrl.indexOf('?') === -1 ? '?' : '&') + 'ow=' + Date.now();
    var payload = null;
    try {
      var resp = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
      if (!resp || !resp.ok) return 'skipped';
      payload = await resp.json();
    } catch (_) { return 'skipped'; }
    if (!payload || !payload.livesync) return 'skipped';

    var rev = String(payload.rev == null ? '' : payload.rev);
    var seen = null;
    try { seen = (await store.readFile({ path: MARKER, encoding: 'utf8' })).data; } catch (_) {}
    if (seen === null || seen === rev) return 'unchanged';

    var wrote = await seedLivesyncConfig(store, opts);
    if (wrote) {
      console.log('[ow] livesync config rev drift (' + seen + ' -> ' + rev + '): re-seeded, reloading');
      (reload || function () { location.reload(); })();
      return 'reloaded';
    }
    return 'unchanged';
  }

  var WATCH_MS = 5 * 60 * 1000;
  var _watchInstalled = false;

  /** Install the focus + interval watchdog once. Inert when not provisioned. */
  function startRevWatch(store, opts) {
    if (_watchInstalled || !(opts && opts.configUrl)) return false;
    _watchInstalled = true;
    var tick = function () { checkRevOnce(store, opts).catch(function () {}); };
    setInterval(tick, WATCH_MS);
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) tick();
      });
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Sync-failure guard — event-driven defence against the shared-credential
  // CouchDB lockout, complementing the interval watchdog above.
  //
  // TRANSPORT (verified against the shipped obsidian-livesync 1.0.0 bundle):
  // replication builds PouchDB with a custom fetch that, on this platform
  // (useRequestAPI=false; nativeFetch throws "not implemented"; zero XHR),
  // calls `_fetch = window.fetch.bind(window)`. So wrapping window.fetch —
  // before the plugin captures that bound reference, which a plain <script>
  // in index.html always is — sees EVERY replication request and its status.
  //
  // On a 401/403 to the sync path it does two things:
  //   1. debounced rev re-check (checkRevOnce) — the ROTATION case: re-seed +
  //      reload onto the new credential on the first failure, not on the next
  //      5-minute tick.
  //   2. a client-side circuit breaker — the PERSISTENT-STALE case (rev
  //      unchanged: a deleted account, or an already-locked pair). After a low
  //      threshold of failures it stops sending sync requests (synthetic 503,
  //      no network) for a cooldown, half-opening a single probe afterwards.
  //      CouchDB's own lockout trips at 5 failures per (user, IP); tripping
  //      ours BELOW that and going silent lets the server-side counter age out,
  //      so the SHARED ws_* credential is never locked for the healthy
  //      replicas (the desktop node, other browsers). This is the piece the
  //      interval watchdog cannot provide — it prevents the lockout rather
  //      than only recovering from a rotation faster.
  //
  // Testable core: createSyncGuard(deps) with injected fetch/now/onRevCheck so
  // the state machine is exercised under a fake clock without a browser.

  function urlOf(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    try { return String(input); } catch (_) { return ''; }
  }

  function createSyncGuard(deps) {
    var fetchImpl = deps.fetch;
    var nowFn = deps.now || function () { return Date.now(); };
    var onRevCheck = deps.onRevCheck || function () {};
    var mkResp = deps.makeResponse || function (body, init) { return new Response(body, init); };
    var cfg = deps.config || {};
    var pathPrefix = cfg.pathPrefix || '/sync/';   // the couch proxy path (only provisioned origins serve it)
    var threshold = cfg.threshold || 2;            // failures within windowMs that trip the breaker (< couch's 5)
    var windowMs = cfg.windowMs || 20000;
    var baseCooldownMs = cfg.cooldownMs || 120000; // silent period; > couch max_lifetime/… kept modest, backs off
    var cooldownCapMs = cfg.cooldownCapMs || 600000;
    var revDebounceMs = cfg.revDebounceMs || 2000;

    var CLOSED = 0, OPEN = 1, HALF = 2;
    var state = CLOSED;
    var openUntil = 0;
    var cooldown = baseCooldownMs;
    var failTimes = [];
    var probeInFlight = false;
    var lastRev = -Infinity;

    function isSync(u) {
      try { return new URL(u, 'http://ow.local').pathname.indexOf(pathPrefix) === 0; }
      catch (_) { return false; }
    }
    function authFail(res) { return !!res && (res.status === 401 || res.status === 403); }
    function shortCircuit() {
      return mkResp('{"error":"unavailable","reason":"ow-sync-guard: cooling down after repeated auth failures"}',
        { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil(cooldown / 1000)) } });
    }
    function debouncedRev() {
      var t = nowFn();
      if (t - lastRev >= revDebounceMs) { lastRev = t; try { onRevCheck(); } catch (_) {} }
    }
    function openBreaker() { state = OPEN; openUntil = nowFn() + cooldown; failTimes = []; }
    function closeBreaker() { state = CLOSED; openUntil = 0; cooldown = baseCooldownMs; failTimes = []; }

    function wrapped(input, init) {
      var u = urlOf(input);
      if (!isSync(u)) return fetchImpl(input, init);
      var t = nowFn();

      if (state === OPEN) {
        if (t < openUntil) return Promise.resolve(shortCircuit());
        state = HALF;                                   // cooldown elapsed → allow one probe
      }
      if (state === HALF) {
        if (probeInFlight) return Promise.resolve(shortCircuit());
        probeInFlight = true;
        return fetchImpl(input, init).then(function (res) {
          probeInFlight = false;
          if (authFail(res)) { cooldown = Math.min(cooldownCapMs, cooldown * 2); openBreaker(); debouncedRev(); }
          else if (res && res.ok) { closeBreaker(); }
          return res;
        }, function (err) { probeInFlight = false; openBreaker(); throw err; });
      }
      // CLOSED
      return fetchImpl(input, init).then(function (res) {
        if (authFail(res)) {
          failTimes.push(t);
          failTimes = failTimes.filter(function (x) { return t - x <= windowMs; });
          debouncedRev();
          if (failTimes.length >= threshold) openBreaker();
        } else if (res && res.ok) {
          failTimes = [];
        }
        return res;
      });
    }

    return {
      fetch: wrapped,
      state: function () { return { state: state, openUntil: openUntil, cooldown: cooldown, fails: failTimes.length, probeInFlight: probeInFlight }; }
    };
  }

  // Install the wrapper on the real window.fetch, once, at script-load (before
  // the plugin bundle captures its bound _fetch). The rev-check action is
  // wired later by boot.js via arm() — once it has the OPFS store + provision
  // opts — so an auth failure before arming still gets breaker protection and
  // simply skips the reload until armed.
  function installSyncGuard(global) {
    if (!global || typeof global.fetch !== 'function' || global.__owSyncGuardInstalled) return null;
    global.__owSyncGuardInstalled = true;
    var pending = { onRevCheck: function () {} };
    var guard = createSyncGuard({
      fetch: global.fetch.bind(global),
      onRevCheck: function () { pending.onRevCheck(); },
      config: (global.__owConfig && global.__owConfig.syncGuard) || {}
    });
    global.fetch = guard.fetch;
    global.__owSyncGuard = {
      arm: function (fn) { if (typeof fn === 'function') pending.onRevCheck = fn; },
      state: guard.state
    };
    return global.__owSyncGuard;
  }

  if (typeof window !== 'undefined') installSyncGuard(window);

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { seedLivesyncConfig, checkRevOnce, startRevWatch, createSyncGuard, urlOf };
  } else if (typeof window !== 'undefined') {
    window.__owSeedLivesyncConfig = { seedLivesyncConfig, checkRevOnce, startRevWatch, createSyncGuard };
  }
})();
