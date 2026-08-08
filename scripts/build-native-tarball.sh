#!/usr/bin/env bash
# Build the NATIVE deployment tarball — the same bundle the docker image
# serves, packaged for non-docker consumers (Coder workspaces; the pinned-host
# native-nginx cutover). Uses the Dockerfile as the single build definition:
# builds the image, then extracts the served tree + the nginx template.
#
#   ./scripts/build-native-tarball.sh [image-build-args...]
#
# Output: dist/obsidian-web-native-<version>.tar.gz (+ .sha256), where
# <version> = git describe/short-sha of this checkout. Tarball layout:
#   html/                      — the static bundle (renderer, plugins, app)
#   nginx/default.conf.template — envsubst template (OW_SYNC_UPSTREAM, OW_TITLE)
#   VERSION                    — the source ref this was built from
#
# ⚠️ LICENSING: html/obsidian-mobile/ is Obsidian's proprietary renderer
# (fetched at build time, never committed — see the Dockerfile note). This
# tarball must be distributed INTERNALLY only (e.g. an internal gitea
# release), never published to the public internet.
#
# Native install sketch (what the consumer does):
#   tar -xzf obsidian-web-native-*.tar.gz -C /opt/obsidian-web
#   OW_SYNC_UPSTREAM=<couch-url> OW_TITLE=<title> \
#     envsubst '$OW_SYNC_UPSTREAM $OW_TITLE' \
#     < /opt/obsidian-web/nginx/default.conf.template > <nginx-conf-dir>/obsidian-web.conf
#   # point `root` at /opt/obsidian-web/html, drop livesync-config.json into it
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(git describe --tags --always --dirty 2>/dev/null || git rev-parse --short HEAD)"
IMG="obsidian-web-native-build:$VERSION"
OUT="dist/obsidian-web-native-$VERSION.tar.gz"

echo "== building image ($IMG)"
docker build -t "$IMG" "$@" .

echo "== extracting bundle"
CID="$(docker create "$IMG")"
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT
STAGE="$(mktemp -d)"
mkdir -p "$STAGE/pkg/nginx" dist
docker cp "$CID:/usr/share/nginx/html" "$STAGE/pkg/html"
docker cp "$CID:/etc/nginx/templates/default.conf.template" "$STAGE/pkg/nginx/default.conf.template"
printf '%s\n' "$VERSION" > "$STAGE/pkg/VERSION"

echo "== packaging"
tar -C "$STAGE/pkg" -czf "$OUT" .
( cd dist && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256" 2>/dev/null \
  || sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256" )
rm -rf "$STAGE"
ls -lh "$OUT"
cat "$OUT.sha256"
