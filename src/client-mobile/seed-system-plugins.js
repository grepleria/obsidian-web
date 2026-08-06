/**
 * seed-system-plugins.js — seed-on-boot of the server's system plugins
 * (e.g. obsidian-web-layout, the desktop/mobile layout switcher) into an
 * OPFS (local) vault.
 *
 * No DOM deps beyond the global `fetch` (available under node:test/bun test
 * AND in the browser) — runs under node:test and inside the browser via a
 * plain <script> tag (attaches to window.__owSeedSystemPlugins).
 *
 * Server vaults get system plugins overlaid live via /api/fs (see
 * server/system-plugins.js + server/api/fs.js). OPFS vaults never touch
 * /api/fs, so boot.js calls seedSystemPlugins() once (idempotent,
 * version-gated) before injecting Obsidian's scripts — see
 * docs/plans/opfs-seed-system-plugins.md §3.
 *
 * `store` is an OpfsStore instance (storage/opfs-store.js makeStore(vaultId))
 * — only `readFile({path,encoding})` / `writeFile({path,data,encoding})`
 * are used, so a fake with the same shape works fine in tests.
 */
(function () {
  'use strict';

  async function seedSystemPlugins(store) {
    let man = await fetch('/api/system-plugins').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    let base = 'server';
    if (!man || !man.plugins) {                 // CF static: אין /api → static fallback
      man = await fetch('/system-plugins/manifest.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
      base = 'static';
    }
    if (!man || !man.plugins) return;

    const enabled = [];
    for (const p of man.plugins) {
      const dir = '.obsidian/plugins/' + p.id;
      const marker = dir + '/.ow-seeded-version';   // version-gate (idempotent)

      let seededVer = null;
      try { seededVer = (await store.readFile({ path: marker, encoding: 'utf8' })).data; } catch (_) {}

      // Enablement semantics (feat/template-plugins — this seeder now runs on
      // EVERY boot, not only into fresh vaults, so existing replicas receive
      // new/updated plugins on their next load):
      //   marker == version  → nothing at all. Critically: do NOT re-add to
      //     the enabled list — the union-merge below would re-enable a plugin
      //     the user deliberately turned off, every single boot.
      //   marker absent (NEW install) → seed all files; enable per p.enabled
      //     (false = installed-but-disabled).
      //   marker != version (UPGRADE) → refresh the files but skip data.json
      //     (the user's plugin settings — template defaults are for first
      //     install only) and do NOT touch enablement.
      if (seededVer === p.version) continue;
      const isUpgrade = seededVer !== null;

      // אם קובץ כלשהו נכשל — אל תסמן marker (אחרת plugin שבור תקוע
      // ולא מתעדכן; ה-boot הבא ינסה שוב כי המ-marker לא ישקף את הגרסה הנוכחית).
      let allOk = true;
      for (const f of p.files) {
        if (isUpgrade && f === 'data.json') continue;   // never clobber user settings
        const url = base === 'static'
          ? '/system-plugins/' + p.id + '/' + encodeURIComponent(f)
          : '/api/system-plugin-file?id=' + encodeURIComponent(p.id) + '&file=' + encodeURIComponent(f);
        const resp = await fetch(url).catch(() => null);
        if (!resp || !resp.ok) { allOk = false; break; }
        const buf = await resp.arrayBuffer();
        // system plugins שלנו טקסט (json/js/css) → utf8 (עקבי עם חוזה OpfsStore)
        await store.writeFile({ path: dir + '/' + f, data: new TextDecoder().decode(buf), encoding: 'utf8' });
      }
      if (allOk) {
        await store.writeFile({ path: marker, data: p.version, encoding: 'utf8' });
        if (!isUpgrade && p.enabled !== false) enabled.push(p.id);   // enable on FIRST install only
      } else {
        console.warn('[ow] system plugin ' + p.id + ' seed incomplete — retry בboot הבא');
      }
    }

    // מיזוג ל-community-plugins.json (union, לא דריסה — לא לדרוס plugins שהמשתמש הפעיל בעצמו)
    let list = [];
    try {
      const raw = (await store.readFile({ path: '.obsidian/community-plugins.json', encoding: 'utf8' })).data;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch (_) {}
    const merged = Array.from(new Set(list.concat(enabled)));
    await store.writeFile({ path: '.obsidian/community-plugins.json', data: JSON.stringify(merged, null, 2), encoding: 'utf8' });
  }

  /**
   * seedCorePlugins — write the deployment's enabled-core-plugins allowlist
   * into a FRESH vault (callers gate on isVaultEmptyForSeed, same as
   * seedSystemPlugins above). Write-once by design: if core-plugins.json
   * already exists — app-written or from a previous seed — leave it alone,
   * so toggles the user makes in Settings stick.
   *
   * Format note: this renderer generation reads core-plugins.json as an
   * ARRAY of enabled ids (see upstream's demo template) — absent = disabled.
   * The companion core-plugins-migration.json marker mirrors what the demo
   * template writes, keeping the renderer's migration path quiet.
   */
  async function seedCorePlugins(store, list) {
    if (!Array.isArray(list) || list.length === 0) return false;
    try {
      await store.readFile({ path: '.obsidian/core-plugins.json', encoding: 'utf8' });
      return false;                                  // exists → app owns it now
    } catch (_) {}
    await store.writeFile({
      path: '.obsidian/core-plugins.json',
      data: JSON.stringify(list, null, 2),
      encoding: 'utf8',
    });
    await store.writeFile({
      path: '.obsidian/core-plugins-migration.json',
      data: JSON.stringify({ 'file-explorer': true }),
      encoding: 'utf8',
    });
    return true;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { seedSystemPlugins, seedCorePlugins };
  } else if (typeof window !== 'undefined') {
    window.__owSeedSystemPlugins = { seedSystemPlugins, seedCorePlugins };
  }
})();
