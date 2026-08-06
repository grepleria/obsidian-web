'use strict';

/**
 * Obsidian Web — Layout Switcher.
 *
 * Lets the user pick between three layout modes on the web wrapper:
 *   - auto    → use viewport heuristics (default)
 *   - mobile  → force the mobile layout
 *   - desktop → force the desktop layout
 *
 * The mode is persisted in localStorage under "obsidian-web:layout-mode".
 * client-mobile/boot.js reads this key and sets window.__owPlatformOverrides
 * before the Obsidian bundle initializes Platform. window.__owPlatform
 * itself is populated by client-mobile/platform-bridge.js's runtime
 * interception (not a build-time patch — see
 * docs/plans/runtime-platform-descriptors.md).
 *
 * In real Obsidian (desktop or mobile app) window.__owPlatform does not
 * exist, so this plugin loads as a no-op — no ribbon icon, no commands.
 *
 * docs/plans/runtime-platform-descriptors.md §3.5: `localStorage.EmulateMobile`
 * overrides window.__owPlatformOverrides in platform-bridge.js, so this
 * switcher would be a no-op while emulating (isMobile is locked true either
 * way). Rather than leave a button that looks active but does nothing —
 * worse than a disabled button (brief §3.5's explicit call) — it's shown
 * visually disabled and its commands/ribbon click are inert while emulating.
 */

const obsidian = require('obsidian');

const LAYOUT_KEY = 'obsidian-web:layout-mode';
const EMULATE_MOBILE_KEY = 'EmulateMobile';
const MODES = ['auto', 'mobile', 'desktop'];

function isEmulateMobileActive() {
  // Truthy VALUE, not mere key existence — mirrors the bundle's own guard
  // and platform-bridge.js's computeWant() (brief §3.5). Surprising but
  // deliberate: `localStorage.EmulateMobile = "0"` is ON here, same as in
  // the bundle and in platform-bridge.js's isEmulateActive() — a plain
  // `!!value` check on a string is not "0 means off". A prior round of this
  // slice special-cased "0"/"false" as OFF in platform-bridge.js ONLY,
  // which desynced it from this exact line and produced a real half-state
  // bug (calev, third pass). If "0" ever needs to mean OFF, it must change
  // in all three readers of this key at once — never here alone.
  return !!localStorage.getItem(EMULATE_MOBILE_KEY);
}

function getMode() {
  return localStorage.getItem(LAYOUT_KEY) || 'auto';
}

function setMode(mode) {
  if (!MODES.includes(mode)) return;
  if (mode === 'auto') {
    // Remove the key so boot.js falls back to viewport detection.
    localStorage.removeItem(LAYOUT_KEY);
  } else {
    localStorage.setItem(LAYOUT_KEY, mode);
  }
  showReloadOverlay(mode);
  setTimeout(() => location.reload(), 150);
}

function showReloadOverlay(mode) {
  const div = document.createElement('div');
  div.style.cssText = [
    'position:fixed', 'inset:0',
    'background:var(--background-primary)',
    'color:var(--text-normal)',
    'display:flex', 'align-items:center', 'justify-content:center',
    'font:14px var(--font-interface, sans-serif)',
    'z-index:99999',
  ].join(';');
  div.textContent = 'Switching to ' + mode + ' mode…';
  document.body.appendChild(div);
}

function modeLabel(mode) {
  return mode === 'auto'    ? 'Auto (by viewport)'
       : mode === 'mobile'  ? 'Mobile layout'
       : mode === 'desktop' ? 'Desktop layout'
       : mode;
}

/**
 * ── PDF context menu (browser) ───────────────────────────────────────────
 *
 * The PDF view's onContextMenu — unlike the editor/file-tree handlers —
 * takes an ELECTRON detour when `win.electron` exists (which obsidian-web's
 * desktop layout deliberately provides): it awaits an ipcRenderer
 * "context-menu" round-trip no browser answers (1s timeout, then bail), and
 * never calls preventDefault() synchronously, because real Electron has no
 * native context menu to suppress. Net effect in a browser: right-click in
 * a PDF always got the BROWSER menu, and plugin menu items (e.g. PDF++)
 * were unreachable by mouse.
 *
 * A passive shim cannot fix this (the electron branch bails on
 * e.defaultPrevented, so a capture-phase preventDefault kills Obsidian's
 * menu, and without one the browser's always wins). But a plugin is an
 * ACTIVE participant: suppress the original dispatch entirely, then
 * re-invoke the view's own handler with `win.electron` TEMPORARILY MASKED —
 * the handler computes its electron flag in its synchronous first step, so
 * it takes the non-electron branch, which builds the complete Obsidian menu
 * synchronously (navigator.clipboard fallbacks are already upstream) and
 * never consults defaultPrevented. electron is restored in `finally`; the
 * handler's async continuation uses the already-captured flag, so the
 * restore cannot race it. If PDF++ (or anything else) wrapped
 * onContextMenu, we call the wrapped version — their items ride along.
 *
 * This replaced a build-time vendor patch (fork PR #9, closed unmerged) —
 * same branch-steering, but in first-party source with zero-patches intact.
 */

// Find the PDF viewer component that owns `targetEl`: the object carrying
// BOTH onContextMenu and onThumbnailContextMenu (a distinctive pair unique
// to the PDF viewer child) somewhere shallow inside a 'pdf' leaf's view.
// Bounded BFS over plain-object properties — internal layout (view.viewer
// .child today) shifts across Obsidian versions; the property PAIR is the
// stable signature. Returns null when nothing matches (caller degrades to
// the browser menu, loudly).
function findPdfViewerComponent(app, targetEl) {
  const leaves = app.workspace.getLeavesOfType('pdf');
  for (const leaf of leaves) {
    const view = leaf.view;
    if (!view || (view.containerEl && !view.containerEl.contains(targetEl))) continue;
    const queue = [{ obj: view, depth: 0 }];
    const seen = new Set();
    let visited = 0;
    while (queue.length && visited < 200) {
      const { obj, depth } = queue.shift();
      if (!obj || typeof obj !== 'object' || seen.has(obj)) continue;
      seen.add(obj);
      visited++;
      if (typeof obj.onContextMenu === 'function' &&
          typeof obj.onThumbnailContextMenu === 'function') {
        return obj;
      }
      if (depth >= 4) continue;
      for (const key of Object.keys(obj)) {
        const v = obj[key];
        if (v && typeof v === 'object' && !(v instanceof Node) && v !== window) {
          queue.push({ obj: v, depth: depth + 1 });
        }
      }
    }
  }
  return null;
}

let pdfMenuWarned = false;

function handlePdfContextMenu(app, evt) {
  // Only when the desktop layout is active: in mobile layout the vendor
  // handler bails on !isDesktopApp, and a preventDefault here would leave
  // the user with NO menu at all instead of the browser's.
  if (!obsidian.Platform.isDesktopApp) return;
  const t = evt.target;
  if (!(t instanceof Element)) return;
  // Mirror the vendor handler's own scope: inside the viewer, on a page.
  // (The thumbnail sidebar has its own handler and its own element — not
  // intercepted here; it keeps today's behaviour.)
  if (!t.closest('.pdf-viewer-container') || !t.closest('.page')) return;

  const comp = findPdfViewerComponent(app, t);
  if (!comp) {
    // Degrade to the browser menu (status quo) — but say so, once: this is
    // the signal that an Obsidian bump moved the internals and the BFS
    // signature needs re-deriving.
    if (!pdfMenuWarned) {
      pdfMenuWarned = true;
      console.warn('[obsidian-web-layout] PDF viewer component not found — ' +
        'right-click falls back to the browser menu. Obsidian internals may ' +
        'have shifted; re-derive findPdfViewerComponent().');
    }
    return;
  }

  evt.preventDefault();
  evt.stopImmediatePropagation();

  const win = (t.ownerDocument && t.ownerDocument.defaultView) || window;
  const savedElectron = win.electron;
  try {
    win.electron = undefined;
    // Async handler; its synchronous first step captures the (masked)
    // electron flag and, on the non-electron path, builds and shows the
    // menu before the first await.
    const p = comp.onContextMenu(evt);
    if (p && typeof p.catch === 'function') {
      p.catch((e) => console.warn('[obsidian-web-layout] PDF context menu failed', e));
    }
  } finally {
    win.electron = savedElectron;
  }
}

module.exports = class ObsidianWebLayoutPlugin extends obsidian.Plugin {
  async onload() {
    // Only activate on obsidian-web (where __owPlatform exists).
    // In real Obsidian desktop/mobile, this plugin is a no-op.
    if (typeof window.__owPlatform === 'undefined') {
      console.log('[obsidian-web-layout] not on obsidian-web — plugin idle');
      return;
    }

    // Capture phase so we run before the vendor's own bubble-phase binding
    // on .pdf-viewer-container; stopImmediatePropagation prevents a double
    // dispatch. registerDomEvent scopes teardown to plugin unload.
    this.registerDomEvent(document, 'contextmenu',
      (evt) => handlePdfContextMenu(this.app, evt), { capture: true });

    const emulating = isEmulateMobileActive();

    const ribbonEl = this.addRibbonIcon(
      'monitor-smartphone',
      emulating ? 'Layout mode (disabled during mobile emulation)' : 'Layout mode',
      (evt) => {
        if (emulating) {
          new obsidian.Notice('Layout switcher is disabled during mobile emulation.');
          return;
        }
        this.showMenu(evt);
      }
    );
    if (emulating) {
      ribbonEl.addClass('is-disabled');
      ribbonEl.setAttribute('aria-disabled', 'true');
      // .is-disabled alone isn't styled for ribbon actions in the bundle's
      // own CSS (only menu-items/text-icon-buttons are) — force the visual
      // unmistakably here rather than rely on an Obsidian rule that doesn't
      // exist for this element.
      ribbonEl.style.opacity = '0.35';
      ribbonEl.style.cursor = 'not-allowed';
    }

    for (const mode of MODES) {
      this.addCommand({
        id: 'set-layout-' + mode,
        name: 'Set layout: ' + modeLabel(mode),
        callback: () => {
          if (emulating) {
            new obsidian.Notice('Layout switcher is disabled during mobile emulation.');
            return;
          }
          setMode(mode);
        },
      });
    }
  }

  showMenu(evt) {
    const current = getMode();
    const menu = new obsidian.Menu();
    for (const mode of MODES) {
      menu.addItem((item) =>
        item
          .setTitle(modeLabel(mode))
          .setChecked(mode === current)
          .onClick(() => setMode(mode))
      );
    }
    menu.showAtMouseEvent(evt);
  }
};
