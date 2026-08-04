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

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { seedLivesyncConfig };
  } else if (typeof window !== 'undefined') {
    window.__owSeedLivesyncConfig = { seedLivesyncConfig };
  }
})();
