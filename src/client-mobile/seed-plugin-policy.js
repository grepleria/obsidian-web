/**
 * seed-plugin-policy.js — org-managed plugin settings for self-hosted
 * deployments (grepleria-configs plans/obsidian-vault-platform/
 * layering-design.md §7b).
 *
 * The deployment serves `/plugin-policy.json` same-origin — sourced from the
 * TEMPLATE VAULT's `.obsidian/plugin-policy.json` (version-controlled with
 * the standard it describes; the host copies it into the web provision dir).
 * Shape:
 *
 *   { "policies": { "<plugin-id>": { ...settings keys... } } }
 *
 * Three-layer precedence, and this module is the middle layer:
 *   template data.json defaults  — first install only (seed-system-plugins)
 *   POLICY OVERLAY                — managed keys, re-applied whenever the
 *                                   policy content changes (this module)
 *   user changes                  — every key policy does not name, forever
 *
 * Rev-gating: no embedded rev — the applier hashes the served text (FNV-1a),
 * so the file stays hand-editable in the template. Marker
 * `.obsidian/.ow-policy-rev` records the last applied hash; unchanged policy
 * = zero writes. Only INSTALLED plugins (manifest.json present) are touched:
 * policy for a plugin this deployment does not ship is inert, not an error.
 *
 * 404 = this origin serves no policy → silently do nothing (upstream-neutral,
 * same contract as seed-livesync-config.js).
 *
 * No DOM deps beyond global fetch — runs under node:test and in the browser
 * (window.__owSeedPluginPolicy), same pattern as the other seeders.
 */
(function () {
  'use strict';

  var MARKER = '.obsidian/.ow-policy-rev';

  // FNV-1a 32-bit over the raw served text — cheap, stable, and collisions
  // merely cost one redundant re-apply of identical semantics.
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16);
  }

  async function seedPluginPolicy(store) {
    var raw = null;
    try {
      // cache-bust + no-store for the same reason as the livesync config: a
      // service worker serving a stale policy would pin browsers to a
      // superseded standard.
      var resp = await fetch('/plugin-policy.json?ow=' + Date.now(),
        { cache: 'no-store', credentials: 'same-origin' });
      if (!resp || !resp.ok) return false;         // 404 → not a policy origin
      raw = await resp.text();
    } catch (_) {
      return false;                                 // offline → next boot
    }

    var payload = null;
    try { payload = JSON.parse(raw); } catch (_) { return false; }
    if (!payload || typeof payload.policies !== 'object' || payload.policies === null) return false;

    var rev = fnv1a(raw);
    var seen = null;
    try { seen = (await store.readFile({ path: MARKER, encoding: 'utf8' })).data; } catch (_) {}
    if (seen === rev) return false;

    var applied = 0;
    for (var id in payload.policies) {
      if (!Object.prototype.hasOwnProperty.call(payload.policies, id)) continue;
      var overlay = payload.policies[id];
      if (!overlay || typeof overlay !== 'object') continue;

      // Installed check: manifest.json is the one file every plugin has.
      try { await store.readFile({ path: '.obsidian/plugins/' + id + '/manifest.json', encoding: 'utf8' }); }
      catch (_) { continue; }                       // not shipped here → inert

      var dataPath = '.obsidian/plugins/' + id + '/data.json';
      var existing = {};
      try {
        var parsed = JSON.parse((await store.readFile({ path: dataPath, encoding: 'utf8' })).data);
        if (parsed && typeof parsed === 'object') existing = parsed;
      } catch (_) {}

      var merged = {};
      var k;
      for (k in existing) if (Object.prototype.hasOwnProperty.call(existing, k)) merged[k] = existing[k];
      for (k in overlay) if (Object.prototype.hasOwnProperty.call(overlay, k)) merged[k] = overlay[k];

      await store.writeFile({ path: dataPath, data: JSON.stringify(merged, null, 2), encoding: 'utf8' });
      applied++;
    }

    await store.writeFile({ path: MARKER, data: rev, encoding: 'utf8' });
    if (applied) console.log('[ow] plugin policy applied to ' + applied + ' plugin(s), rev ' + rev);
    return true;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { seedPluginPolicy, fnv1a };
  } else if (typeof window !== 'undefined') {
    window.__owSeedPluginPolicy = { seedPluginPolicy };
  }
})();
