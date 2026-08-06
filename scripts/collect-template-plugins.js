#!/usr/bin/env node
'use strict';

/**
 * collect-template-plugins.js — derive the browser plugin bundle from a
 * TEMPLATE VAULT checkout (grepleria/obsidian-vault-template), so the
 * template is the single source of truth for the plugin set on BOTH tiers
 * (desktop vaults get it via vault genesis; browsers via this bundle).
 *
 * Usage:
 *   node scripts/collect-template-plugins.js <template-vault-dir> <dest-system-plugins-dir>
 *
 * Copies each plugin under <vault>/.obsidian/plugins/<id>/ into
 * <dest>/<id>/ and prints the manifest entries (JSON array) to stdout for
 * build-assets.sh to merge into system-plugins/manifest.json.
 *
 * - `enabled` comes from the template's own community-plugins.json — the
 *   template's enabled set IS the deployment's enabled set.
 * - RESERVED ids are skipped even if present: obsidian-livesync and
 *   vault-operator are platform-installed (the template's .gitignore
 *   excludes them for credential reasons; belt-and-braces here), and
 *   obsidian-web-layout is this repo's own system plugin.
 * - data.json (template default settings) IS bundled when present: the
 *   seeder writes it on FIRST install only and skips it on upgrades, so
 *   user settings are never clobbered (seed-system-plugins.js).
 * - Fails loudly on a malformed template (missing manifest.json/main.js,
 *   unreadable community list): a silently-thin bundle would look healthy
 *   while shipping half the plugin set.
 */

const fs = require('fs');
const path = require('path');

const RESERVED = new Set(['obsidian-livesync', 'vault-operator', 'obsidian-web-layout']);
const CANDIDATE_FILES = ['main.js', 'manifest.json', 'styles.css', 'data.json'];

function fail(msg) { console.error('collect-template-plugins: FATAL: ' + msg); process.exit(1); }

const [vaultDir, destDir] = process.argv.slice(2);
if (!vaultDir || !destDir) fail('usage: collect-template-plugins.js <template-vault-dir> <dest-system-plugins-dir>');

const obsDir = path.join(vaultDir, '.obsidian');
const pluginsDir = path.join(obsDir, 'plugins');
if (!fs.existsSync(pluginsDir)) fail('no .obsidian/plugins under ' + vaultDir);

let enabledList;
try {
  enabledList = JSON.parse(fs.readFileSync(path.join(obsDir, 'community-plugins.json'), 'utf8'));
  if (!Array.isArray(enabledList)) throw new Error('not an array');
} catch (e) {
  fail('cannot read community-plugins.json from the template: ' + e.message);
}

const entries = [];
for (const id of fs.readdirSync(pluginsDir).sort()) {
  const src = path.join(pluginsDir, id);
  if (!fs.statSync(src).isDirectory()) continue;
  if (RESERVED.has(id)) { console.error('  skipping reserved id: ' + id); continue; }

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8')); }
  catch (e) { fail('plugin ' + id + ' has no readable manifest.json: ' + e.message); }
  if (!fs.existsSync(path.join(src, 'main.js'))) fail('plugin ' + id + ' has no main.js');
  if (manifest.id && manifest.id !== id) fail('plugin dir ' + id + ' vs manifest id ' + manifest.id + ' mismatch');

  const files = CANDIDATE_FILES.filter((f) => fs.existsSync(path.join(src, f)));
  const dest = path.join(destDir, id);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(src, f), path.join(dest, f));

  entries.push({
    id,
    version: String(manifest.version || '0.0.0'),
    files,
    enabled: enabledList.includes(id),
  });
}

// Every enabled id in the template must have shipped — a listed-but-missing
// plugin means the template repo is inconsistent; refuse to build a bundle
// that silently drops it.
for (const id of enabledList) {
  if (RESERVED.has(id)) continue;
  if (!entries.some((e) => e.id === id)) fail('community-plugins.json lists "' + id + '" but no such plugin dir exists in the template');
}

console.error('  template plugins bundled: ' + entries.length);
process.stdout.write(JSON.stringify(entries));
