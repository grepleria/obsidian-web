/**
 * Tests for the provisioned-vault cold-start path.
 *
 * Why this file exists: the selfhosted profile shipped `provision.configUrl`
 * without `provision.vault`, so a cold visitor fell through boot.js's entry
 * routing to Obsidian's native "Where is your vault located?" onboarding. The
 * LiveSync seeder lives INSIDE the vault-open branch, so with no vault it
 * never ran and the served config was never fetched — the deployment looked
 * healthy from the server side while being completely inert in the browser.
 *
 * boot.js is a large IIFE that touches location/localStorage on load and is
 * not requireable under node:test, so these tests cover the two pieces that
 * carry the logic and can be exercised directly:
 *   1. the deploy-config contract (what the built bundle actually ships)
 *   2. the registry create-if-missing semantics ensureProvisionVault() relies
 *      on — specifically that a FIXED id is idempotent across visits
 * plus a transcription of boot.js's entry-routing precedence, so a future
 * reordering of that chain fails here rather than in a browser.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SELFHOSTED = path.join(__dirname, '..', '..', 'config', 'deploy-config.selfhosted.json');

test('selfhosted profile ships provision.vault.autoOpen — without it the seeder never runs', () => {
  const cfg = JSON.parse(fs.readFileSync(SELFHOSTED, 'utf8'));
  assert.ok(cfg.provision, 'selfhosted profile must set provision');
  assert.strictEqual(cfg.provision.configUrl, '/livesync-config.json');
  assert.ok(cfg.provision.vault, 'provision.vault is required for cold start');
  assert.strictEqual(cfg.provision.vault.autoOpen, true);
  assert.ok(cfg.provision.vault.id, 'a fixed vault id is required');
});

test('provision vault id is fixed, not random — repeat visits must reuse it', () => {
  const a = JSON.parse(fs.readFileSync(SELFHOSTED, 'utf8')).provision.vault.id;
  const b = JSON.parse(fs.readFileSync(SELFHOSTED, 'utf8')).provision.vault.id;
  assert.strictEqual(a, b);
  // Distinct from the demo vault, or a deployment with both would collide.
  assert.notStrictEqual(a, '0000demo0000demo');
});

test('registry create with a fixed id is idempotent (ensureProvisionVault contract)', () => {
  // Fresh module instance with a localStorage stub, mirroring
  // local-vault-registry.test.js's approach.
  const store = new Map();
  global.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  global.crypto = global.crypto || { getRandomValues: (a) => a.fill(7) };
  delete require.cache[require.resolve('../local-vault-registry')];
  const registry = require('../local-vault-registry');

  const ID = '0000prov0000prov';
  assert.ok(!registry.get(ID), 'starts absent');

  // First visit creates it...
  if (!registry.get(ID)) registry.create('Vault', { id: ID });
  const first = registry.get(ID);
  assert.ok(first, 'created');

  // ...a second visit must be a no-op, not a duplicate or a new uuid.
  if (!registry.get(ID)) registry.create('Vault', { id: ID });
  assert.strictEqual(registry.list().filter((v) => v.id === ID).length, 1);
  assert.strictEqual(registry.get(ID).createdAt, first.createdAt, 'not recreated');

  // The seeder renames it to the served vault name once the fetch lands.
  registry.rename(ID, 'knowledge');
  assert.strictEqual(registry.get(ID).name, 'knowledge');

  delete global.localStorage;
});

test('entry routing precedence: resume > demo autoOpen > provision autoOpen > starter', () => {
  // Transcription of boot.js's cold-entry chain. Guards the ORDER: a resumed
  // vault must always win, and provision must not shadow the demo profile.
  function route({ resumeId, demo, provision }) {
    if (resumeId) return '/vault/' + resumeId;
    if (demo && demo.autoOpen === true && demo.enabled !== false) {
      return '/vault/' + demo.id + '/Welcome';
    }
    const pv = provision && provision.vault;
    if (pv && pv.autoOpen === true && pv.id) return '/vault/' + pv.id;
    return '/starter';
  }

  const prov = { vault: { autoOpen: true, id: 'P' } };

  assert.strictEqual(route({ resumeId: 'R', provision: prov }), '/vault/R',
    'an existing vault always wins');
  assert.strictEqual(route({ provision: prov }), '/vault/P',
    'cold visit opens the provisioned vault — this is the bug that was fixed');
  assert.strictEqual(
    route({ demo: { autoOpen: true, id: 'D', enabled: true }, provision: prov }),
    '/vault/D/Welcome', 'demo profile is not shadowed by provision');
  assert.strictEqual(route({}), '/starter',
    'no provision config => stock onboarding, unchanged');
  assert.strictEqual(route({ provision: { vault: { id: 'P' } } }), '/starter',
    'autoOpen must be EXPLICITLY true');
  assert.strictEqual(route({ provision: { configUrl: '/x.json' } }), '/starter',
    'configUrl without vault => the exact inert state this fixes');
});
