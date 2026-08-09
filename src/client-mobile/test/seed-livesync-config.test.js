/**
 * Tests for seedLivesyncConfig (seed-livesync-config.js) — the provisioned
 * LiveSync auto-config path used by self-hosted deployments.
 *
 * Same shape as seed-system-plugins.test.js: a fake OpfsStore with the
 * readFile/writeFile contract, and a stubbed global fetch.
 */
const test = require('node:test');
const assert = require('node:assert');

const { seedLivesyncConfig } = require('../seed-livesync-config');

const DATA = '.obsidian/plugins/obsidian-livesync/data.json';
const MARKER = '.obsidian/plugins/obsidian-livesync/.ow-provisioned-rev';

function makeFakeStore(initialFiles) {
  const files = new Map(Object.entries(initialFiles || {}));
  return {
    files,
    async readFile({ path }) {
      if (!files.has(path)) {
        const e = new Error('readFile: not found: ' + path);
        e.code = 'ENOENT';
        throw e;
      }
      return { data: files.get(path) };
    },
    async writeFile({ path, data }) {
      files.set(path, data);
      return { uri: '' };
    },
  };
}

const PAYLOAD = {
  rev: 'rev1',
  vault: 'knowledge',
  livesync: {
    couchDB_URI: 'https://sync.example.test',
    couchDB_USER: 'obsidian_knowledge',
    couchDB_PASSWORD: 'pw',
    couchDB_DBNAME: 'db_knowledge',
    passphrase: 'e2e',
  },
};

function stubFetch(responder) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return responder(url);
  };
  return calls;
}

function ok(body) {
  return { ok: true, json: async () => body };
}

test('writes data.json + rev marker on a fresh vault', async () => {
  const store = makeFakeStore({});
  stubFetch(() => ok(PAYLOAD));

  const wrote = await seedLivesyncConfig(store, { configUrl: '/livesync-config.json' });
  assert.equal(wrote, true);

  const cfg = JSON.parse(store.files.get(DATA));
  assert.equal(cfg.couchDB_DBNAME, 'db_knowledge');
  assert.equal(cfg.passphrase, 'e2e');
  // defaults the server did not specify
  assert.equal(cfg.encrypt, true);
  assert.equal(cfg.syncOnStart, true);
  assert.equal(cfg.isConfigured, true);
  // per-browser identity so replicas are distinguishable in the remote DB
  assert.ok(/^web-/.test(cfg.deviceAndVaultName));
  assert.equal(store.files.get(MARKER), 'rev1');
});

test('is a no-op on an unchanged rev (does not clobber user tweaks)', async () => {
  const store = makeFakeStore({
    [MARKER]: 'rev1',
    [DATA]: JSON.stringify({ couchDB_DBNAME: 'db_knowledge', syncOnSave: false }),
  });
  stubFetch(() => ok(PAYLOAD));

  const wrote = await seedLivesyncConfig(store, { configUrl: '/livesync-config.json' });
  assert.equal(wrote, false);
  // the hand-tuned value survives
  assert.equal(JSON.parse(store.files.get(DATA)).syncOnSave, false);
});

test('re-seeds when the rev changes (credential rotation)', async () => {
  const store = makeFakeStore({
    [MARKER]: 'rev1',
    [DATA]: JSON.stringify({
      couchDB_PASSWORD: 'old', deviceAndVaultName: 'web-keepme', syncOnSave: false,
    }),
  });
  stubFetch(() => ok(Object.assign({}, PAYLOAD, {
    rev: 'rev2',
    livesync: Object.assign({}, PAYLOAD.livesync, { couchDB_PASSWORD: 'new' }),
  })));

  const wrote = await seedLivesyncConfig(store, { configUrl: '/livesync-config.json' });
  assert.equal(wrote, true);

  const cfg = JSON.parse(store.files.get(DATA));
  assert.equal(cfg.couchDB_PASSWORD, 'new');      // served config wins
  assert.equal(cfg.deviceAndVaultName, 'web-keepme'); // identity preserved
  assert.equal(cfg.syncOnSave, false);            // unrelated local tweak preserved
  assert.equal(store.files.get(MARKER), 'rev2');
});

test('no-op when the deployment is not provisioned (no configUrl)', async () => {
  const store = makeFakeStore({});
  let fetched = false;
  global.fetch = async () => { fetched = true; return ok(PAYLOAD); };

  assert.equal(await seedLivesyncConfig(store, undefined), false);
  assert.equal(await seedLivesyncConfig(store, {}), false);
  assert.equal(fetched, false, 'must not fetch when unprovisioned');
  assert.equal(store.files.size, 0);
});

test('404 falls back to the manual flow (upstream-neutral)', async () => {
  const store = makeFakeStore({});
  stubFetch(() => ({ ok: false, status: 404, json: async () => ({}) }));

  assert.equal(await seedLivesyncConfig(store, { configUrl: '/livesync-config.json' }), false);
  assert.equal(store.files.size, 0);
});

test('network failure is non-fatal', async () => {
  const store = makeFakeStore({});
  global.fetch = async () => { throw new Error('offline'); };

  assert.equal(await seedLivesyncConfig(store, { configUrl: '/livesync-config.json' }), false);
  assert.equal(store.files.size, 0);
});

test('malformed payload (no livesync key) writes nothing', async () => {
  const store = makeFakeStore({});
  stubFetch(() => ok({ rev: 'rev1' }));

  assert.equal(await seedLivesyncConfig(store, { configUrl: '/livesync-config.json' }), false);
  assert.equal(store.files.size, 0);
});

test('cache-busts the config fetch (stale-service-worker guard)', async () => {
  const store = makeFakeStore({});
  const calls = stubFetch(() => ok(PAYLOAD));

  await seedLivesyncConfig(store, { configUrl: '/livesync-config.json' });
  assert.ok(/\?|&/.test(calls[0].url), 'expected a cache-busting query string');
  assert.equal(calls[0].opts.cache, 'no-store');
  assert.equal(calls[0].opts.credentials, 'same-origin');
});

// ---------------------------------------------------------------------------
// checkRevOnce — the rev watchdog behind startRevWatch (long-lived tabs:
// credential rotation must re-seed + reload without a manual hard refresh)
// ---------------------------------------------------------------------------
const { checkRevOnce } = require('../seed-livesync-config');

test('rev drift re-seeds and reloads', async () => {
  const store = makeFakeStore({});
  stubFetch(() => ok(PAYLOAD));
  await seedLivesyncConfig(store, { configUrl: '/livesync-config.json' }); // marker=rev1

  stubFetch(() => ok({
    rev: 'rev2',
    livesync: Object.assign({}, PAYLOAD.livesync, { couchDB_PASSWORD: 'rotated' }),
  }));
  let reloaded = 0;
  const res = await checkRevOnce(store, { configUrl: '/livesync-config.json' }, () => { reloaded++; });
  assert.equal(res, 'reloaded');
  assert.equal(reloaded, 1);
  assert.equal(store.files.get(MARKER), 'rev2');
  const data = JSON.parse(store.files.get(DATA));
  assert.equal(data.couchDB_PASSWORD, 'rotated');
});

test('unchanged rev neither writes nor reloads', async () => {
  const store = makeFakeStore({});
  stubFetch(() => ok(PAYLOAD));
  await seedLivesyncConfig(store, { configUrl: '/livesync-config.json' });
  const before = store.files.get(DATA);

  let reloaded = 0;
  stubFetch(() => ok(PAYLOAD));
  const res = await checkRevOnce(store, { configUrl: '/livesync-config.json' }, () => { reloaded++; });
  assert.equal(res, 'unchanged');
  assert.equal(reloaded, 0);
  assert.equal(store.files.get(DATA), before);
});

test('never-seeded vault (no marker) is left to the boot path', async () => {
  const store = makeFakeStore({});
  stubFetch(() => ok(PAYLOAD));
  let reloaded = 0;
  const res = await checkRevOnce(store, { configUrl: '/livesync-config.json' }, () => { reloaded++; });
  assert.equal(res, 'unchanged');
  assert.equal(reloaded, 0);
  assert.equal(store.files.size, 0);
});

test('endpoint failure during a watch tick is non-fatal', async () => {
  const store = makeFakeStore({});
  global.fetch = async () => { throw new Error('offline'); };
  assert.equal(await checkRevOnce(store, { configUrl: '/livesync-config.json' }, () => {}), 'skipped');
});

// ---------------------------------------------------------------------------
// createSyncGuard — the window.fetch wrapper (event-driven rev-check + the
// client-side circuit breaker that keeps a stale tab from tripping CouchDB's
// shared-account lockout). Driven under a fake clock + fake fetch.
// ---------------------------------------------------------------------------
const { createSyncGuard, urlOf } = require('../seed-livesync-config');

function makeGuard(overrides) {
  const o = overrides || {};
  const state = { t: 0, calls: [], revChecks: 0, reply: () => ({ status: 200, ok: true }) };
  const mkResp = (body, init) => ({ status: init.status, ok: init.status >= 200 && init.status < 300, body, headers: init.headers, __synthetic: true });
  const guard = createSyncGuard({
    fetch: (url) => { state.calls.push(urlOf(url)); const r = state.reply(url); return Promise.resolve(r); },
    now: () => state.t,
    onRevCheck: () => { state.revChecks++; },
    makeResponse: mkResp,
    config: Object.assign({ threshold: 2, windowMs: 20000, cooldownMs: 120000, revDebounceMs: 2000 }, o),
  });
  return { guard, state };
}
const SYNC = 'https://obsidian--w--o.example/sync/db_x/_revs_diff';

test('guard: non-sync URLs pass straight through, never counted', async () => {
  const { guard, state } = makeGuard();
  state.reply = () => ({ status: 401, ok: false });
  for (let i = 0; i < 10; i++) await guard.fetch('https://obsidian--w--o.example/api/fs/stat?path=x');
  assert.equal(state.calls.length, 10);
  assert.equal(guard.state().state, 0);           // still CLOSED
  assert.equal(state.revChecks, 0);
});

test('guard: 401 fires a debounced rev-check', async () => {
  const { guard, state } = makeGuard({ threshold: 10 }); // high threshold isolates debounce from the breaker
  state.reply = () => ({ status: 401, ok: false });
  await guard.fetch(SYNC);
  assert.equal(state.revChecks, 1);
  await guard.fetch(SYNC);                          // same instant → debounced away
  assert.equal(state.revChecks, 1);
  state.t += 3000;
  await guard.fetch(SYNC);
  assert.equal(state.revChecks, 2);
});

test('guard: breaker trips below CouchDB threshold and short-circuits (no network)', async () => {
  const { guard, state } = makeGuard();               // threshold 2
  state.reply = () => ({ status: 401, ok: false });
  await guard.fetch(SYNC);                             // fail 1 (network hit)
  await guard.fetch(SYNC);                             // fail 2 → OPEN
  assert.equal(guard.state().state, 1);
  const before = state.calls.length;
  const r = await guard.fetch(SYNC);                  // short-circuited
  assert.equal(state.calls.length, before);           // NO extra network call
  assert.equal(r.status, 503);
  assert.ok(state.calls.length <= 2, 'CouchDB saw fewer than its 5-failure threshold');
});

test('guard: half-open lets exactly one probe through, others short-circuit', async () => {
  const { guard, state } = makeGuard();
  state.reply = () => ({ status: 401, ok: false });
  await guard.fetch(SYNC); await guard.fetch(SYNC);    // OPEN
  state.t += 120001;                                   // cooldown elapsed → HALF
  const n = state.calls.length;
  // first request probes (hits network), still 401 → re-OPEN with doubled cooldown
  await guard.fetch(SYNC);
  assert.equal(state.calls.length, n + 1);
  assert.equal(guard.state().state, 1);
  assert.equal(guard.state().cooldown, 240000);       // backoff doubled
  const n2 = state.calls.length;
  await guard.fetch(SYNC);                             // OPEN again → short-circuit
  assert.equal(state.calls.length, n2);
});

test('guard: a successful probe closes the breaker and resets backoff', async () => {
  const { guard, state } = makeGuard();
  state.reply = () => ({ status: 401, ok: false });
  await guard.fetch(SYNC); await guard.fetch(SYNC);    // OPEN
  state.t += 120001;                                   // HALF
  state.reply = () => ({ status: 200, ok: true });     // credential now good
  await guard.fetch(SYNC);                             // probe succeeds → CLOSED
  assert.equal(guard.state().state, 0);
  assert.equal(guard.state().cooldown, 120000);       // reset
  assert.equal(guard.state().fails, 0);
});

test('guard: a success in CLOSED clears the failure window', async () => {
  const { guard, state } = makeGuard({ threshold: 3 });
  state.reply = () => ({ status: 401, ok: false });
  await guard.fetch(SYNC);                             // fail 1
  state.reply = () => ({ status: 200, ok: true });
  await guard.fetch(SYNC);                             // success resets
  assert.equal(guard.state().fails, 0);
  state.reply = () => ({ status: 401, ok: false });
  await guard.fetch(SYNC);
  assert.equal(guard.state().state, 0);               // one fresh failure, still CLOSED
});

test('guard: stale failures age out of the sliding window', async () => {
  const { guard, state } = makeGuard({ threshold: 2, windowMs: 20000 });
  state.reply = () => ({ status: 401, ok: false });
  await guard.fetch(SYNC);                             // fail at t=0
  state.t += 20001;                                    // older than window
  await guard.fetch(SYNC);                             // fail at t=20001; t=0 aged out
  assert.equal(guard.state().state, 0);               // only 1 in-window → not tripped
});

// ---------------------------------------------------------------------------
// migrated-connection strip + forced reseed (rotation reaching migrated
// replicas — the vaulte2e 2026-08-09 401-forever case)
// ---------------------------------------------------------------------------
const FORCED_MARKER = '.obsidian/plugins/obsidian-livesync/.ow-forced-reseed-rev';

test('seed strips the plugin-migrated encrypted connection', async () => {
  const store = makeFakeStore({
    [DATA]: JSON.stringify({
      deviceAndVaultName: 'web-keepme',
      activeConfigurationId: 'legacy-couchdb',
      remoteConfigurations: { 'legacy-couchdb': { uri: '%$OLDENC' } },
      encryptedCouchDBConnection: '%$OLDENC',
      encryptedPassphrase: '%$OLDENC',
      configPassphraseStore: '',
      customUserSetting: 42,
    }),
  });
  stubFetch(() => ok(PAYLOAD));
  assert.equal(await seedLivesyncConfig(store, { configUrl: '/livesync-config.json' }), true);
  const data = JSON.parse(store.files.get(DATA));
  for (const k of ['remoteConfigurations', 'activeConfigurationId',
    'encryptedCouchDBConnection', 'encryptedPassphrase', 'configPassphraseStore']) {
    assert.ok(!(k in data), k + ' should be stripped');
  }
  assert.equal(data.couchDB_PASSWORD, 'pw');            // served creds win
  assert.equal(data.deviceAndVaultName, 'web-keepme');  // identity preserved
  assert.equal(data.customUserSetting, 42);             // unrelated keys kept
});

test('forced check reseeds ONCE per rev when marker is current', async () => {
  const store = makeFakeStore({});
  stubFetch(() => ok(PAYLOAD));
  await seedLivesyncConfig(store, { configUrl: '/livesync-config.json' }); // marker=rev1
  // simulate the plugin re-migrating stale creds after the seed
  const mig = JSON.parse(store.files.get(DATA));
  mig.activeConfigurationId = 'legacy-couchdb';
  mig.encryptedCouchDBConnection = '%$STALE';
  store.files.set(DATA, JSON.stringify(mig));

  let reloads = 0;
  // 1st forced check: marker == rev, but force → reseed + reload
  let res = await checkRevOnce(store, { configUrl: '/livesync-config.json' }, () => { reloads++; }, true);
  assert.equal(res, 'reloaded');
  assert.equal(reloads, 1);
  assert.equal(store.files.get(FORCED_MARKER), 'rev1');
  assert.ok(!('encryptedCouchDBConnection' in JSON.parse(store.files.get(DATA))));

  // 2nd forced check under the SAME rev: no reseed, no reload (loop guard)
  res = await checkRevOnce(store, { configUrl: '/livesync-config.json' }, () => { reloads++; }, true);
  assert.equal(res, 'unchanged');
  assert.equal(reloads, 1);
});

test('forced check on a NEVER-seeded vault stays inert', async () => {
  const store = makeFakeStore({});
  stubFetch(() => ok(PAYLOAD));
  const res = await checkRevOnce(store, { configUrl: '/livesync-config.json' }, () => {}, true);
  assert.equal(res, 'unchanged');
  assert.equal(store.files.size, 0);
});

test('plain rev drift still reseeds and clears the way for future forces', async () => {
  const store = makeFakeStore({});
  stubFetch(() => ok(PAYLOAD));
  await seedLivesyncConfig(store, { configUrl: '/livesync-config.json' });
  stubFetch(() => ok({ rev: 'rev2', livesync: Object.assign({}, PAYLOAD.livesync, { couchDB_PASSWORD: 'new' }) }));
  let reloads = 0;
  const res = await checkRevOnce(store, { configUrl: '/livesync-config.json' }, () => { reloads++; });
  assert.equal(res, 'reloaded');
  assert.equal(JSON.parse(store.files.get(DATA)).couchDB_PASSWORD, 'new');
});
