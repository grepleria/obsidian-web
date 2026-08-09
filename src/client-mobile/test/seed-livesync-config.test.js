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
