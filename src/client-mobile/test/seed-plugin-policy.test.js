/**
 * Tests for seedPluginPolicy (seed-plugin-policy.js) — org-managed plugin
 * settings, the middle layer of the three-layer precedence
 * (template defaults < POLICY < user changes on unmanaged keys).
 */
const test = require('node:test');
const assert = require('node:assert');

const { seedPluginPolicy, fnv1a } = require('../seed-plugin-policy');

const MARKER = '.obsidian/.ow-policy-rev';

function makeStore(initial) {
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

function policyFetch(body, status) {
  return async () => ({
    ok: (status || 200) === 200,
    status: status || 200,
    text: async () => body,
  });
}

test('applies policy keys over existing settings, preserves unmanaged keys', async (t) => {
  const raw = JSON.stringify({ policies: { 'pdf-plus': { autoCopy: true } } });
  const store = makeStore({
    '.obsidian/plugins/pdf-plus/manifest.json': '{"id":"pdf-plus"}',
    '.obsidian/plugins/pdf-plus/data.json': '{"autoCopy":false,"userTweak":42}',
  });
  t.mock.method(globalThis, 'fetch', policyFetch(raw));
  assert.strictEqual(await seedPluginPolicy(store), true);
  const d = JSON.parse(store.files.get('.obsidian/plugins/pdf-plus/data.json'));
  assert.strictEqual(d.autoCopy, true, 'managed key follows policy');
  assert.strictEqual(d.userTweak, 42, 'unmanaged key untouched');
  assert.strictEqual(store.files.get(MARKER), fnv1a(raw));
});

test('rev-gate: unchanged policy is zero writes; changed policy re-applies', async (t) => {
  const raw = JSON.stringify({ policies: { 'pdf-plus': { autoCopy: true } } });
  const store = makeStore({
    '.obsidian/plugins/pdf-plus/manifest.json': '{"id":"pdf-plus"}',
    // user flipped the managed key back; same rev => policy must NOT re-impose
    '.obsidian/plugins/pdf-plus/data.json': '{"autoCopy":false}',
    [MARKER]: fnv1a(raw),
  });
  t.mock.method(globalThis, 'fetch', policyFetch(raw));
  assert.strictEqual(await seedPluginPolicy(store), false);
  assert.strictEqual(JSON.parse(store.files.get('.obsidian/plugins/pdf-plus/data.json')).autoCopy, false,
    'same rev: user keeps their flip until the org bumps the policy');

  const raw2 = JSON.stringify({ policies: { 'pdf-plus': { autoCopy: true, v: 2 } } });
  t.mock.method(globalThis, 'fetch', policyFetch(raw2));
  assert.strictEqual(await seedPluginPolicy(store), true);
  assert.strictEqual(JSON.parse(store.files.get('.obsidian/plugins/pdf-plus/data.json')).autoCopy, true,
    'new rev: managed key re-imposed');
});

test('policy for a plugin not installed here is inert, not an error', async (t) => {
  const raw = JSON.stringify({ policies: { 'obsidian-excalidraw-plugin': { theme: 'dark' } } });
  const store = makeStore({});
  t.mock.method(globalThis, 'fetch', policyFetch(raw));
  assert.strictEqual(await seedPluginPolicy(store), true, 'marker still written');
  assert.ok(!store.files.has('.obsidian/plugins/obsidian-excalidraw-plugin/data.json'),
    'nothing materialised for an unshipped plugin');
});

test('404 (not a policy origin) and malformed payloads are silently inert', async (t) => {
  const store = makeStore({});
  t.mock.method(globalThis, 'fetch', policyFetch('nope', 404));
  assert.strictEqual(await seedPluginPolicy(store), false);
  t.mock.method(globalThis, 'fetch', policyFetch('not json'));
  assert.strictEqual(await seedPluginPolicy(store), false);
  t.mock.method(globalThis, 'fetch', policyFetch('{"noPolicies":1}'));
  assert.strictEqual(await seedPluginPolicy(store), false);
  assert.strictEqual(store.files.size, 0, 'no writes in any inert case');
});

test('creates data.json when the plugin ships without one', async (t) => {
  const raw = JSON.stringify({ policies: { dataview: { enableDataviewJs: false } } });
  const store = makeStore({
    '.obsidian/plugins/dataview/manifest.json': '{"id":"dataview"}',
  });
  t.mock.method(globalThis, 'fetch', policyFetch(raw));
  assert.strictEqual(await seedPluginPolicy(store), true);
  assert.deepStrictEqual(JSON.parse(store.files.get('.obsidian/plugins/dataview/data.json')),
    { enableDataviewJs: false });
});
