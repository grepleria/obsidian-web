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
RUN apk add --no-cache bash unzip

WORKDIR /build
COPY . .

# Pin the Obsidian renderer + LiveSync plugin at build time for reproducibility.
# Empty = latest (upstream default). Set both when cutting a pinned image.
ARG OBSIDIAN_MOBILE_VERSION=""
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
RUN if [ -n "$OBSIDIAN_MOBILE_VERSION" ]; then \
      node scripts/update-obsidian-mobile.js --version "$OBSIDIAN_MOBILE_VERSION"; \
    else \
      node scripts/update-obsidian-mobile.js; \
    fi

# The static bundle. OW_PROFILE unset = the default (app) profile: no demo vault,
# no seeded example content — the shape this platform wants (each visitor gets
# their own empty OPFS vault and points LiveSync at their own CouchDB database).
RUN cd src/deployments/cloudflare && npm install --no-audit --no-fund && npm run build

# HARD GATE — upstream's build WARNS AND CONTINUES when the LiveSync plugin
# download fails (offline/GitHub outage), shipping a bundle with the layout
# switcher only. For this platform that is a silent breakage: LiveSync IS the
# reason the browser client exists, and a visitor would get a vault that can
# never sync. Fail the image build instead.
RUN test -f /build/.tmp/deployments/cloudflare/public/system-plugins/obsidian-livesync/main.js \
      || (echo "FATAL: obsidian-livesync missing from the built bundle — upstream's build warns-and-continues on a failed plugin download; refusing to ship a no-sync image." >&2; exit 1) \
 && test -f /build/.tmp/deployments/cloudflare/public/obsidian-mobile/app.js \
      || (echo "FATAL: vendor renderer missing from the built bundle." >&2; exit 1)

# ── runtime ────────────────────────────────────────────────────────────────
FROM nginx:1.27-alpine

COPY --from=builder /build/.tmp/deployments/cloudflare/public /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
