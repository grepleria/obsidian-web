'use strict';

/**
 * Integration test for seedSystemPlugins (seed-system-plugins.js) — exercises
 * the real production logic end-to-end against a fake OpfsStore (same shape
 * as storage/opfs-store.js makeStore()) and a mocked global fetch (same
 * shape as /api/system-plugins + /api/system-plugin-file, see
 * server/api/system-plugin-files.js). Full-browser/OPFS/render verification
 * (DoD #3-#6 in docs/plans/opfs-seed-system-plugins.md) is out of scope for
 * a node:test/bun test process — covered separately by calev-heavy.
 */

const assert = require('assert/strict');
const test = require('node:test');
const { seedSystemPlugins } = require('../seed-system-plugins');

// ── fake OpfsStore — same readFile/writeFile contract as storage/opfs-store.js ──
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

// ── fake fetch — /api/system-plugins + /api/system-plugin-file ──────────────
function makeFakeFetch({ manifest, fileContents, failFiles }) {
  const calls = [];
  failFiles = failFiles || new Set();
  return {
    calls,
    fetch: async function fakeFetch(url) {
      calls.push(url);
      if (url === '/api/system-plugins') {
        return { ok: true, json: async () => manifest };
      }
      const m = /^\/api\/system-plugin-file\?id=([^&]+)&file=([^&]+)$/.exec(url);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const file = decodeURIComponent(m[2]);
        const key = id + '/' + file;
        if (failFiles.has(key)) return { ok: false };
        const text = fileContents[key];
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
      }
      return { ok: false };
    },
  };
}

test('seedSystemPlugins writes plugin files + marker + merges community-plugins.json', async (t) => {
  const manifest = { plugins: [{ id: 'obsidian-web-layout', version: '0.1.0', files: ['manifest.json', 'main.js'] }] };
  const fileContents = {
    'obsidian-web-layout/manifest.json': '{"id":"obsidian-web-layout"}',
    'obsidian-web-layout/main.js': '// layout switcher',
  };
  const fake = makeFakeFetch({ manifest, fileContents });
  const origFetch = global.fetch;
  global.fetch = fake.fetch;
  t.after(() => { global.fetch = origFetch; });

  const store = makeFakeStore();
  await seedSystemPlugins(store);

  assert.equal(store.files.get('.obsidian/plugins/obsidian-web-layout/manifest.json'), fileContents['obsidian-web-layout/manifest.json']);
  assert.equal(store.files.get('.obsidian/plugins/obsidian-web-layout/main.js'), fileContents['obsidian-web-layout/main.js']);
  assert.equal(store.files.get('.obsidian/plugins/obsidian-web-layout/.ow-seeded-version'), '0.1.0');

  const community = JSON.parse(store.files.get('.obsidian/community-plugins.json'));
  assert.deepEqual(community, ['obsidian-web-layout']);
});

test('seedSystemPlugins is idempotent — a second run at the same version does not re-fetch files', async (t) => {
  const manifest = { plugins: [{ id: 'obsidian-web-layout', version: '0.1.0', files: ['manifest.json', 'main.js'] }] };
  const fileContents = {
    'obsidian-web-layout/manifest.json': 'M',
    'obsidian-web-layout/main.js': 'J',
  };
  const fake = makeFakeFetch({ manifest, fileContents });
  const origFetch = global.fetch;
  global.fetch = fake.fetch;
  t.after(() => { global.fetch = origFetch; });

  const store = makeFakeStore();
  await seedSystemPlugins(store); // first run: seeds
  const fileFetchesAfterFirst = fake.calls.filter((u) => u.startsWith('/api/system-plugin-file')).length;
  assert.equal(fileFetchesAfterFirst, 2);

  await seedSystemPlugins(store); // second run: version-gate should skip file fetches
  const fileFetchesAfterSecond = fake.calls.filter((u) => u.startsWith('/api/system-plugin-file')).length;
  assert.equal(fileFetchesAfterSecond, 2, 'no new /api/system-plugin-file calls on the second (idempotent) run');

  const community = JSON.parse(store.files.get('.obsidian/community-plugins.json'));
  assert.deepEqual(community, ['obsidian-web-layout'], 'still enabled exactly once, no duplicate');
});

test('seedSystemPlugins re-seeds when the server-side version changes', async (t) => {
  const fileContents = {
    'obsidian-web-layout/manifest.json': 'M-v2',
    'obsidian-web-layout/main.js': 'J-v2',
  };

  const store = makeFakeStore({
    '.obsidian/plugins/obsidian-web-layout/.ow-seeded-version': '0.1.0',
    '.obsidian/plugins/obsidian-web-layout/manifest.json': 'M-v1',
    '.obsidian/plugins/obsidian-web-layout/main.js': 'J-v1',
    '.obsidian/community-plugins.json': JSON.stringify(['obsidian-web-layout']),
  });

  const manifest = { plugins: [{ id: 'obsidian-web-layout', version: '0.2.0', files: ['manifest.json', 'main.js'] }] };
  const fake = makeFakeFetch({ manifest, fileContents });
  const origFetch = global.fetch;
  global.fetch = fake.fetch;
  t.after(() => { global.fetch = origFetch; });

  await seedSystemPlugins(store);

  assert.equal(store.files.get('.obsidian/plugins/obsidian-web-layout/manifest.json'), 'M-v2');
  assert.equal(store.files.get('.obsidian/plugins/obsidian-web-layout/main.js'), 'J-v2');
  assert.equal(store.files.get('.obsidian/plugins/obsidian-web-layout/.ow-seeded-version'), '0.2.0');
});

test('seedSystemPlugins does not mark the version or enable the plugin when a file fetch fails', async (t) => {
  const manifest = { plugins: [{ id: 'obsidian-web-layout', version: '0.1.0', files: ['manifest.json', 'main.js'] }] };
  const fileContents = { 'obsidian-web-layout/manifest.json': 'M' };
  const fake = makeFakeFetch({
    manifest,
    fileContents,
    failFiles: new Set(['obsidian-web-layout/main.js']),
  });
  const origFetch = global.fetch;
  global.fetch = fake.fetch;
  t.after(() => { global.fetch = origFetch; });

  const store = makeFakeStore();
  await seedSystemPlugins(store);

  assert.equal(store.files.has('.obsidian/plugins/obsidian-web-layout/.ow-seeded-version'), false, 'marker not written on partial failure');
  const community = store.files.has('.obsidian/community-plugins.json')
    ? JSON.parse(store.files.get('.obsidian/community-plugins.json'))
    : [];
  assert.deepEqual(community, [], 'plugin not enabled when seed is incomplete');
});

test('seedSystemPlugins merges into (does not overwrite) an existing community-plugins.json', async (t) => {
  const manifest = { plugins: [{ id: 'obsidian-web-layout', version: '0.1.0', files: ['main.js'] }] };
  const fileContents = { 'obsidian-web-layout/main.js': 'J' };
  const fake = makeFakeFetch({ manifest, fileContents });
  const origFetch = global.fetch;
  global.fetch = fake.fetch;
  t.after(() => { global.fetch = origFetch; });

  const store = makeFakeStore({
    '.obsidian/community-plugins.json': JSON.stringify(['some-user-installed-plugin']),
  });
  await seedSystemPlugins(store);

  const community = JSON.parse(store.files.get('.obsidian/community-plugins.json'));
  assert.deepEqual([...community].sort(), ['obsidian-web-layout', 'some-user-installed-plugin'].sort());
});

test('seedSystemPlugins is a no-op when /api/system-plugins is unreachable', async (t) => {
  const origFetch = global.fetch;
  global.fetch = async () => { throw new Error('network down'); };
  t.after(() => { global.fetch = origFetch; });

  const store = makeFakeStore();
  await assert.doesNotReject(seedSystemPlugins(store));
  assert.equal(store.files.size, 0);
});

// ── static fallback (CF: אין /api/system-plugins → /system-plugins/manifest.json) ──
// docs/plans/cf-mobile-seed.md §3ב — fallback רק כש-/api/system-plugins מחזיר
// 404/null; שאר הלוגיקה (version-gate, allOk, merge) זהה, רק ה-URL של הקובץ.
function makeFakeStaticFetch({ manifest, fileContents }) {
  const calls = [];
  return {
    calls,
    fetch: async function fakeStaticFetch(url) {
      calls.push(url);
      if (url === '/api/system-plugins') return { ok: false, status: 404 };   // CF static: אין /api
      if (url === '/system-plugins/manifest.json') return { ok: true, json: async () => manifest };
      const m = /^\/system-plugins\/([^/]+)\/(.+)$/.exec(url);
      if (m) {
        const id = m[1];
        const file = decodeURIComponent(m[2]);
        const key = id + '/' + file;
        const text = fileContents[key];
        if (text === undefined) return { ok: false };
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
      }
      return { ok: false };
    },
  };
}

test('seedSystemPlugins falls back to /system-plugins/manifest.json when /api/system-plugins 404s (CF static)', async (t) => {
  const manifest = { plugins: [{ id: 'obsidian-web-layout', version: '0.1.0', files: ['manifest.json', 'main.js'] }] };
  const fileContents = {
    'obsidian-web-layout/manifest.json': '{"id":"obsidian-web-layout"}',
    'obsidian-web-layout/main.js': '// layout switcher',
  };
  const fake = makeFakeStaticFetch({ manifest, fileContents });
  const origFetch = global.fetch;
  global.fetch = fake.fetch;
  t.after(() => { global.fetch = origFetch; });

  const store = makeFakeStore();
  await seedSystemPlugins(store);

  assert.equal(store.files.get('.obsidian/plugins/obsidian-web-layout/manifest.json'), fileContents['obsidian-web-layout/manifest.json']);
  assert.equal(store.files.get('.obsidian/plugins/obsidian-web-layout/main.js'), fileContents['obsidian-web-layout/main.js']);
  assert.equal(store.files.get('.obsidian/plugins/obsidian-web-layout/.ow-seeded-version'), '0.1.0');

  const community = JSON.parse(store.files.get('.obsidian/community-plugins.json'));
  assert.deepEqual(community, ['obsidian-web-layout']);

  // ודא שהשתמש בנתיב הסטטי (לא /api/system-plugin-file) — finding 2: encodeURIComponent
  assert.ok(fake.calls.includes('/system-plugins/obsidian-web-layout/manifest.json'));
  assert.ok(fake.calls.includes('/system-plugins/obsidian-web-layout/main.js'));
  assert.ok(!fake.calls.some((u) => u.startsWith('/api/system-plugin-file')));
});

test('seedSystemPlugins does not use static fallback when /api/system-plugins succeeds (local server — no regression)', async (t) => {
  const manifest = { plugins: [{ id: 'obsidian-web-layout', version: '0.1.0', files: ['main.js'] }] };
  const fileContents = { 'obsidian-web-layout/main.js': 'J' };
  const fake = makeFakeFetch({ manifest, fileContents });
  const origFetch = global.fetch;
  global.fetch = fake.fetch;
  t.after(() => { global.fetch = origFetch; });

  const store = makeFakeStore();
  await seedSystemPlugins(store);

  assert.ok(!fake.calls.some((u) => u.startsWith('/system-plugins/')), 'static fallback not consulted when /api succeeds');
});

// ── seedCorePlugins (feat/core-plugins) ──────────────────────────────────────

const fs2 = require('fs');
const path2 = require('path');
const SELFHOSTED2 = path2.join(__dirname, '..', '..', 'config', 'deploy-config.selfhosted.json');

const { seedCorePlugins } = require('../seed-system-plugins');

function makeCoreStore(initial) {
  const files = new Map(Object.entries(initial || {}));
  return {
    files,
    async readFile({ path }) {
      if (!files.has(path)) { const e = new Error('ENOENT ' + path); e.code = 'ENOENT'; throw e; }
      return { data: files.get(path) };
    },
    async writeFile({ path, data }) { files.set(path, data); return { uri: '' }; },
  };
}

test('seedCorePlugins writes the allowlist + migration marker into a fresh vault', async () => {
  const store = makeCoreStore();
  const wrote = await seedCorePlugins(store, ['file-explorer', 'graph']);
  assert.strictEqual(wrote, true);
  assert.deepStrictEqual(JSON.parse(store.files.get('.obsidian/core-plugins.json')),
    ['file-explorer', 'graph']);
  assert.deepStrictEqual(JSON.parse(store.files.get('.obsidian/core-plugins-migration.json')),
    { 'file-explorer': true });
});

test('seedCorePlugins is write-once — an existing file (user toggles) is never clobbered', async () => {
  const store = makeCoreStore({ '.obsidian/core-plugins.json': '["sync"]' });
  const wrote = await seedCorePlugins(store, ['file-explorer']);
  assert.strictEqual(wrote, false);
  assert.strictEqual(store.files.get('.obsidian/core-plugins.json'), '["sync"]');
});

test('seedCorePlugins no-ops on null/empty config (upstream profiles)', async () => {
  const store = makeCoreStore();
  assert.strictEqual(await seedCorePlugins(store, null), false);
  assert.strictEqual(await seedCorePlugins(store, []), false);
  assert.ok(!store.files.has('.obsidian/core-plugins.json'));
});

test('selfhosted profile omits the commercial sync/publish core plugins', () => {
  const cfg = JSON.parse(fs2.readFileSync(SELFHOSTED2, 'utf8'));
  assert.ok(Array.isArray(cfg.corePlugins) && cfg.corePlugins.length > 0);
  assert.ok(!cfg.corePlugins.includes('sync'), 'core Sync must not be seeded — LiveSync is the sync');
  assert.ok(!cfg.corePlugins.includes('publish'));
  assert.ok(cfg.corePlugins.includes('file-explorer'), 'allowlist semantics: essentials must be PRESENT');
});

// ── every-boot semantics (feat/template-plugins) ─────────────────────────────
// The seeder now runs on every boot into populated vaults, so these three
// properties are load-bearing: user disables stay disabled, upgrades never
// clobber settings, and first installs seed template defaults.

function fetchStub(manifest, files) {
  return async (url) => {
    if (url === '/api/system-plugins') return { ok: true, json: async () => manifest };
    const m = url.match(/^\/api\/system-plugin-file\?id=([^&]+)&file=(.+)$/);
    if (m) {
      const key = decodeURIComponent(m[1]) + '/' + decodeURIComponent(m[2]);
      if (files[key] !== undefined) {
        return { ok: true, arrayBuffer: async () => new TextEncoder().encode(files[key]).buffer };
      }
    }
    return { ok: false };
  };
}

test('same-version rerun does NOT re-enable a plugin the user disabled', async (t) => {
  const man = { plugins: [{ id: 'p1', version: '1.0', files: ['main.js', 'manifest.json'] }] };
  const store = makeFakeStore({
    '.obsidian/plugins/p1/.ow-seeded-version': '1.0',
    // user removed p1 from their community list after disabling it
    '.obsidian/community-plugins.json': '["other-plugin"]',
  });
  t.mock.method(globalThis, 'fetch', fetchStub(man, {}));
  await seedSystemPlugins(store);
  assert.deepStrictEqual(JSON.parse(store.files.get('.obsidian/community-plugins.json')),
    ['other-plugin'], 'p1 must stay disabled');
});

test('upgrade refreshes files but skips data.json and leaves enablement alone', async (t) => {
  const man = { plugins: [{ id: 'p1', version: '2.0', files: ['main.js', 'manifest.json', 'data.json'] }] };
  const store = makeFakeStore({
    '.obsidian/plugins/p1/.ow-seeded-version': '1.0',
    '.obsidian/plugins/p1/main.js': 'OLD',
    '.obsidian/plugins/p1/data.json': '{"user":"settings"}',
    '.obsidian/community-plugins.json': '[]',   // user has it disabled
  });
  t.mock.method(globalThis, 'fetch', fetchStub(man, {
    'p1/main.js': 'NEW', 'p1/manifest.json': '{"id":"p1","version":"2.0"}',
    'p1/data.json': '{"template":"defaults"}',
  }));
  await seedSystemPlugins(store);
  assert.strictEqual(store.files.get('.obsidian/plugins/p1/main.js'), 'NEW', 'code updated');
  assert.strictEqual(store.files.get('.obsidian/plugins/p1/data.json'), '{"user":"settings"}',
    'user settings survive the upgrade');
  assert.strictEqual(store.files.get('.obsidian/plugins/p1/.ow-seeded-version'), '2.0');
  assert.deepStrictEqual(JSON.parse(store.files.get('.obsidian/community-plugins.json')), [],
    'upgrade must not re-enable');
});

test('first install seeds data.json template defaults and enables', async (t) => {
  const man = { plugins: [{ id: 'p1', version: '1.0', files: ['main.js', 'manifest.json', 'data.json'] }] };
  const store = makeFakeStore({});
  t.mock.method(globalThis, 'fetch', fetchStub(man, {
    'p1/main.js': 'CODE', 'p1/manifest.json': '{"id":"p1"}', 'p1/data.json': '{"template":"defaults"}',
  }));
  await seedSystemPlugins(store);
  assert.strictEqual(store.files.get('.obsidian/plugins/p1/data.json'), '{"template":"defaults"}');
  assert.deepStrictEqual(JSON.parse(store.files.get('.obsidian/community-plugins.json')), ['p1']);
});
