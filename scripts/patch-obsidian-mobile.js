#!/usr/bin/env node
'use strict';

/**
 * patch-obsidian-mobile.js
 *
 * Applies build-time patches to the extracted Obsidian mobile bundle
 * (obsidian-mobile/app.js).
 *
 * As of docs/plans/zero-patches.md, `PATCHES` is empty — the extracted
 * bundle is applied unmodified (byte-identical to Obsidian's own APK).
 * Three patches that used to expose `window.__owPlatform`, merge
 * `window.__owPlatformOverrides` into the Platform flags, and gate the
 * `is-mobile` body class were replaced by a runtime interceptor —
 * `src/client-mobile/platform-bridge.js` — that achieves the same effect by
 * wrapping `Object.defineProperty` instead of rewriting app.js (see
 * docs/plans/runtime-platform-descriptors.md, §0-§1, for that rationale and
 * history). The 4th and last one (`vault-profile-on-desktop-layout`, which
 * made the desktop-layout vault-profile panel render on a code path upstream
 * mobile always guards off) was removed outright by
 * docs/plans/zero-patches.md, once measurement showed `platform-bridge.js`'s
 * own `isDesktopApp` locking already covers what it used to patch.
 *
 * This file (and its empty `PATCHES` array) stays in place as infrastructure
 * for a future Obsidian version that might need a new patch — see "HOW TO
 * FIX A BROKEN PATCH" below for the workflow.
 *
 * Importable:
 *   const { applyPatches, PATCHES } = require('./patch-obsidian-mobile');
 *
 * CLI-runnable:
 *   node scripts/patch-obsidian-mobile.js <path-to-app.js>
 *
 * If any regex no longer matches exactly the expected number of times,
 * `applyPatches` throws — silent failures here produce subtly broken
 * bundles that are hard to debug.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * HOW TO FIX A BROKEN PATCH AFTER AN OBSIDIAN VERSION BUMP
 * ───────────────────────────────────────────────────────────────────────────
 * The bundle (app.js) is a single minified line. Variable names change between
 * builds, but the *structural shape* around each patch is stable. Each PATCH
 * below has a `doc` block with:
 *   • WHAT — the behavior the patch changes and why.
 *   • ANCHOR — a short, stable substring to grep for in the new app.js to
 *              locate the code (survives minification; not the full regex).
 *   • REBUILD — how to turn what you find into the new `find`/`replace`.
 * Workflow when a patch throws "expected N match(es), found M":
 *   1. Open the new vendor/obsidian-mobile/app.js.
 *   2. Search for that patch's ANCHOR string.
 *   3. Compare the surrounding code to the current `find` regex; adjust only
 *      the parts that changed (usually a variable name or added/removed flag).
 *   4. Keep capture groups aligned with `replace`. Re-run the patch.
 * The regexes intentionally use `\w+`/`\w{1,3}` for identifiers so a pure
 * variable-rename does NOT break them — only structural changes do.
 * Verified applying cleanly across Obsidian 1.11.7 and 1.12.7.
 */

const fsp = require('fs/promises');
const path = require('path');

const PATCHES = [
  {
    name: 'pdf-context-menu-browser-path',
    // WHAT: makes right-click inside the PDF viewer open OBSIDIAN's context
    // menu (with plugin items, e.g. PDF++) instead of the browser's native
    // menu. The PDF view's onContextMenu, unlike the editor/file-tree ones,
    // takes an ELECTRON detour when `win.electron` exists (which our desktop
    // layout's electron shim deliberately provides): it awaits an
    // ipcRenderer "context-menu" round-trip that no browser answers (1s
    // timeout -> bail), and — decisively — it never calls preventDefault()
    // synchronously, because real Electron has no native context menu to
    // suppress. In a browser the native menu therefore always wins.
    //
    // WHY A PATCH (zero-patches.md exception, argued): a runtime shim is
    // structurally impossible here. Suppressing the native menu requires a
    // SYNCHRONOUS preventDefault() during dispatch, but the electron branch
    // explicitly bails on `e.defaultPrevented` after its await — so any
    // capture-phase preventDefault kills Obsidian's own menu, and without
    // one the browser menu always shows. The only fix is steering the
    // handler onto its NON-electron branch (which builds the full menu
    // synchronously, with navigator.clipboard fallbacks already in place)
    // and preventing the default there. Both edits are inside the minified
    // function body — runtime interception has no seam.
    //
    // Both changes are gated on `win.__owPlatform` (set only by obsidian-web
    // boot), so the patched bundle behaves byte-for-byte stock anywhere our
    // platform marker is absent.
    //
    // ANCHOR: `.win.electron)&&` — the PDF onContextMenu is the only site
    //         that computes `isDesktopApp && win.electron` into a flag and
    //         immediately gates an isTrusted electron IPC await on it.
    // REBUILD: find the PDF viewer's onContextMenu (search
    //         `onThumbnailContextMenu` and walk back ~7k chars). The shape:
    //         `(s=bn.isDesktopApp&&e.win.electron)&&e.isTrusted?[4,Rn(e)]:[3,2]`
    //         Only identifiers vary across builds; the state labels [4,..]
    //         and [3,2] are the async-generator jump table and may renumber —
    //         update the literals if so, keeping else-branch semantics.
    find: /\((\w{1,3})=(\w{1,3})\.isDesktopApp&&(\w{1,3})\.win\.electron\)&&\3\.isTrusted\?\[4,(\w{1,3})\(\3\)\]:\[3,2\]/g,
    replace: '($1=$2.isDesktopApp&&$3.win.electron&&!$3.win.__owPlatform)&&$3.isTrusted?[4,$4($3)]:($3.win.__owPlatform&&$3.preventDefault(),[3,2])',
    expectedMatches: 1,
  },
];

async function applyPatches(appJsPath) {
  let content = await fsp.readFile(appJsPath, 'utf8');

  for (const patch of PATCHES) {
    // Count matches using a global flag (cloned from the non-global regex).
    const globalRegex = new RegExp(patch.find.source, 'g');
    const matches = content.match(globalRegex) || [];

    if (matches.length !== patch.expectedMatches) {
      throw new Error(
        `Patch "${patch.name}" expected ${patch.expectedMatches} match(es), ` +
        `found ${matches.length}. Obsidian's bundle changed shape.\n` +
        `  → Open scripts/patch-obsidian-mobile.js, find the "${patch.name}" PATCH,\n` +
        `    and follow its ANCHOR/REBUILD doc block to re-derive the regex\n` +
        `    against the new vendor/obsidian-mobile/app.js. See the "HOW TO FIX"\n` +
        `    header for the full workflow.`
      );
    }

    content = content.replace(patch.find, patch.replace);
    console.log(`  patched: ${patch.name} (${matches.length}x)`);
  }

  await fsp.writeFile(appJsPath, content, 'utf8');
}

module.exports = { applyPatches, PATCHES };

// CLI mode
if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node scripts/patch-obsidian-mobile.js <path-to-app.js>');
    process.exit(1);
  }
  applyPatches(path.resolve(target))
    .then(() => console.log('Done.'))
    .catch(err => { console.error('Error:', err.message); process.exit(1); });
}
