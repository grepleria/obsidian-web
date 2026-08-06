# Self-hosted obsidian-web — the CLIENT-ONLY (OPFS) deployment, served by nginx.
#
# Why this file exists: upstream ships two deployment modes — a Node.js server
# (real server-side vault filesystem) and the Cloudflare static build (OPFS,
# zero server-side vault storage). This image is the LATTER, self-hosted:
# `scripts/build-assets.sh` produces exactly the static bundle Cloudflare Pages
# would serve, and nginx serves it plus the two routes the CF Worker normally
# provides. The Node.js server mode is deliberately NOT used — a shared
# server-side vault folder with 2+ browser LiveSync nodes is the conflict-storm
# topology (grepleria-configs plans/obsidian-vault-platform/SPEC.md §1/§3).
#
# Build (from the repo root):
#   docker build -t <ak-fqdn>/obsidian-web:<tag> .
# The build needs network egress: GitHub API + release CDN (Obsidian APK,
# LiveSync plugin releases).

# ── builder ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

# bash: build-assets.sh is bash, not sh. unzip: scripts/update-obsidian-mobile.js
# shells out to it to extract the APK's assets/public tree (the only external
# tool either vendor-fetch script needs — everything else is node stdlib).
RUN apk add --no-cache bash unzip git

WORKDIR /build
COPY . .

# Obsidian renderer version. MUST default to the version this client is built
# against — NOT "latest". src/client-mobile/obsidian-version.js pins
# window.__owObsidianVersion, the Capacitor shim is written against that
# bundle's internals, and the boot watchdog refuses to start a mismatched
# renderer ("Obsidian X did not start. This version asks its host for a
# startup acknowledgement that obsidian-web does not provide."). Building with
# an empty value pulled 1.13.4 and produced exactly that failure screen in the
# browser — the image looked healthy (nginx 200s, plugin+renderer served)
# because the incompatibility only shows once Obsidian's own JS boots.
# Bump ONLY together with the client-side support work + obsidian-version.js.
ARG OBSIDIAN_MOBILE_VERSION="1.12.7"
ARG SEED_LIVESYNC_VERSION=""
ENV SEED_LIVESYNC_VERSION=${SEED_LIVESYNC_VERSION}

# vendor/obsidian-mobile/ — Obsidian's own Android renderer, extracted from the
# official APK. Gitignored upstream (it is Dynalist's proprietary bundle, NOT
# redistributable source), so it must be fetched at build time, never committed.
#
# NB this is the ONLY step needed: update-obsidian-mobile.js already imports and
# calls applyPatches on the extracted app.js itself (see its line ~306), so the
# README's `&& node scripts/patch-obsidian-mobile.js` companion is for the
# manual/dev flow only. Chaining it here fails — invoked standalone the script
# is a CLI that requires a <path-to-app.js> argument and exits 1 without one.
# (The patch list is empty today but aborts loudly if a future Obsidian version
# breaks an expected match; that guard runs inside the update script.)
#
# The version GUARD lives in this same RUN by necessity: the fetch script
# REWRITES src/client-mobile/obsidian-version.js with whatever it downloaded,
# so the committed value (what the Capacitor shim was actually written
# against) only exists before the fetch. Capture it first, compare after — a
# post-fetch comparison would always agree and prove nothing.
RUN set -e; \
    want="$(sed -n "s/.*__owObsidianVersion *= *'\([^']*\)'.*/\1/p" src/client-mobile/obsidian-version.js | head -1)"; \
    if [ -n "$OBSIDIAN_MOBILE_VERSION" ]; then \
      node scripts/update-obsidian-mobile.js --version "$OBSIDIAN_MOBILE_VERSION"; \
    else \
      node scripts/update-obsidian-mobile.js; \
    fi; \
    got="$(sed -n "s/.*__owObsidianVersion *= *'\([^']*\)'.*/\1/p" src/client-mobile/obsidian-version.js | head -1)"; \
    echo "renderer version: client written for '$want', fetched '$got'"; \
    if [ -n "$want" ] && [ "$want" != "$got" ]; then \
      echo "FATAL: Obsidian renderer/client mismatch (client written for $want, fetched $got)." >&2; \
      echo "  The bundle would build and serve fine but die in the browser with the boot" >&2; \
      echo "  watchdog's 'did not start' screen — the shim does not implement what $got" >&2; \
      echo "  expects. Build with --build-arg OBSIDIAN_MOBILE_VERSION=$want, or do the" >&2; \
      echo "  client-side support work and commit the new obsidian-version.js." >&2; \
      exit 1; \
    fi

# Build profile. Defaults to `selfhosted` because that is what this image IS:
# src/config/deploy-config.selfhosted.json enables LiveSync (rather than
# shipping it installed-but-disabled like the public app profile) and points
# provision.configUrl at /livesync-config.json, which the deployment mounts in.
# Together those make a first visit land in a configured, syncing vault.
# Override with --build-arg OW_PROFILE= for the stock app profile (manual
# LiveSync setup), or =demo for the seeded demo vault.
ARG OW_PROFILE="selfhosted"
ENV OW_PROFILE=${OW_PROFILE}

# Template vault — the single source of truth for the community-plugin set on
# both tiers (grepleria-configs plans/obsidian-vault-platform/
# layering-design.md). Its .obsidian/plugins/* are bundled into the
# system-plugins overlay with `enabled` from its community-plugins.json;
# reserved platform plugins (livesync, vault-operator) are skipped by the
# collector. REF is a pinned commit for reproducible builds — bump it
# together with template merges you want browsers to receive. Empty
# OW_TEMPLATE_REPO skips the whole step (plain upstream build).
ARG OW_TEMPLATE_REPO="https://github.com/grepleria/obsidian-vault-template.git"
ARG OW_TEMPLATE_REF="1324cd75a5d39690337514d99f0fcf1ca3839539"
RUN set -e; \
    if [ -n "$OW_TEMPLATE_REPO" ]; then \
      git init -q /build/.tmp/template; \
      git -C /build/.tmp/template fetch -q --depth 1 "$OW_TEMPLATE_REPO" "$OW_TEMPLATE_REF"; \
      git -C /build/.tmp/template checkout -q FETCH_HEAD; \
      echo "template vault at $OW_TEMPLATE_REF"; \
    fi

RUN cd src/deployments/cloudflare && npm install --no-audit --no-fund \
 && OW_TEMPLATE_VAULT_DIR="$([ -n "$OW_TEMPLATE_REPO" ] && echo /build/.tmp/template)" npm run build

# Fail loudly if the profile did not actually take — a typo'd OW_PROFILE would
# otherwise silently ship the stock app profile, i.e. LiveSync disabled and no
# provisioning, which looks fine until a visitor lands on the setup screen.
RUN set -e; \
    idx=/build/.tmp/deployments/cloudflare/public/index.html; \
    grep -q '"provision":{"configUrl"' "$idx" \
      || (echo "FATAL: built bundle has no provision.configUrl — OW_PROFILE='$OW_PROFILE' did not inject the self-hosted profile. (Note the base profile carries provision:null, so grepping for the bare key would false-pass.)" >&2; exit 1); \
    grep -q '"obsidian-livesync":{"install":true,"enabled":true}' "$idx" \
      || (echo "FATAL: built bundle does not auto-enable obsidian-livesync — visitors would have to enable it by hand." >&2; exit 1)

# HARD GATE — upstream's build WARNS AND CONTINUES when the LiveSync plugin
# download fails (offline/GitHub outage), shipping a bundle with the layout
# switcher only. For this platform that is a silent breakage: LiveSync IS the
# reason the browser client exists, and a visitor would get a vault that can
# never sync. Fail the image build instead.
RUN test -f /build/.tmp/deployments/cloudflare/public/system-plugins/obsidian-livesync/main.js \
      || (echo "FATAL: obsidian-livesync missing from the built bundle — upstream's build warns-and-continues on a failed plugin download; refusing to ship a no-sync image." >&2; exit 1) \
 && test -f /build/.tmp/deployments/cloudflare/public/obsidian-mobile/app.js \
      || (echo "FATAL: vendor renderer missing from the built bundle." >&2; exit 1) \
 && if [ -n "$OW_TEMPLATE_REPO" ]; then \
      node -e "const m=require('/build/.tmp/deployments/cloudflare/public/system-plugins/manifest.json'); \
        const ids=m.plugins.map(p=>p.id); \
        const cfg=require('/build/src/config/deploy-config.'+(process.env.OW_PROFILE||'selfhosted')+'.json'); \
        const want=cfg.webPlugins || require('/build/.tmp/template/.obsidian/community-plugins.json'); \
        const missing=want.filter(id=>!ids.includes(id)); \
        if(missing.length){console.error('FATAL: expected plugins missing from bundle: '+missing.join(', '));process.exit(1);} \
        const extra=m.plugins.filter(p=>!['obsidian-livesync','obsidian-web-layout'].includes(p.id)&&cfg.webPlugins&&!cfg.webPlugins.includes(p.id)); \
        if(extra.length){console.error('FATAL: non-allowlisted plugins leaked into the bundle: '+extra.map(p=>p.id).join(', '));process.exit(1);} \
        console.log('template plugin gate: '+want.length+' expected ids bundled, no leaks');"; \
    fi

# ── runtime ────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine

COPY --from=builder /build/.tmp/deployments/cloudflare/public /usr/share/nginx/html

# Installed as a TEMPLATE (not conf.d): the official image entrypoint
# envsubst-renders /etc/nginx/templates/*.template into conf.d at start,
# substituting ${OW_SYNC_UPSTREAM} (the same-origin /sync/ proxy target --
# the deployment's CouchDB hub LAN address). The default below is a
# deliberately dead loopback so an unconfigured deployment gets a valid
# config with a 502ing /sync/ (and a working static site) instead of an
# nginx that refuses to boot on an empty proxy_pass.
COPY nginx.conf /etc/nginx/templates/default.conf.template
ENV OW_SYNC_UPSTREAM=http://127.0.0.1:5984
# Page title for this deployment (sub_filter in nginx.conf); default is the
# stock name, i.e. a no-op rewrite.
ENV OW_TITLE="Obsidian Web"

EXPOSE 80
