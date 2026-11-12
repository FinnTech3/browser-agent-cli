#!/usr/bin/env bash
# Regenerate every image and clip in docs/ and agensi/media/ from REAL runs of bac against the demo pages in
# docs/media-src/site. Needs: Node 20+ (run `npm install` first), Chromium for Playwright, ffmpeg, python3 + Pillow.
# It installs bac from a freshly packed tarball into a temp prefix, so what you see is what `npm install -g` gives.
#   bash docs/media-src/make-media.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="$ROOT/docs/media-src"
export MEDIA_TMP="${MEDIA_TMP:-/tmp/bac-media}"
DEMO=/tmp/bac-demo      # cwd of the recorded sessions; it shows up in `bac shot` output, so keep it short
rm -rf "$MEDIA_TMP" "$DEMO" && mkdir -p "$MEDIA_TMP"

(cd "$ROOT" && npm pack --silent --pack-destination "$MEDIA_TMP" >/dev/null)
npm install --silent -g --prefix "$MEDIA_TMP/prefix" "$MEDIA_TMP"/browser-agent-cli-*.tgz >/dev/null
export PATH="$MEDIA_TMP/prefix/bin:$PATH" BAC_HOME="$MEDIA_TMP/home"

node "$SRC/serve.mjs" 8765 >/dev/null & P1=$!
node "$ROOT/test/support/serve.js" 8766 >/dev/null & P2=$!
trap 'bac stop >/dev/null 2>&1 || true; kill $P1 $P2 2>/dev/null || true' EXIT
sleep 1

cast() {  # cast NAME : record the real session, then render it
  python3 "$SRC/record.py" "$SRC/casts/$1.json" "$MEDIA_TMP/$1.cast.json"
}

cast safety
node "$SRC/termcast.mjs" "$MEDIA_TMP/safety.cast.json" "$MEDIA_TMP/safety.png" --still

rm -rf "$DEMO"
cast hero
python3 "$SRC/transcript.py" "$MEDIA_TMP/hero.cast.json" "$ROOT/docs/demo-session.txt"
node "$SRC/termcast.mjs" "$MEDIA_TMP/hero.cast.json" "$ROOT/docs/demo.gif" "$ROOT/docs/demo.mp4"
node "$SRC/termcast.mjs" "$MEDIA_TMP/hero.cast.json" "$MEDIA_TMP/session.png" --still

node "$SRC/refs-figure.mjs" "$MEDIA_TMP/refs.png"
node "$SRC/social.mjs" "$MEDIA_TMP/social.png" "$DEMO/form.png" "$MEDIA_TMP/hero.cast.json" "$ROOT/agensi/media/logo.png"

python3 "$SRC/finish.py" "$MEDIA_TMP/session.png" "$ROOT/agensi/media/screenshot-2.png"
python3 "$SRC/finish.py" "$MEDIA_TMP/safety.png" "$ROOT/docs/safety.png"
python3 "$SRC/finish.py" "$MEDIA_TMP/refs.png" "$ROOT/docs/refs.png"
python3 "$SRC/finish.py" "$MEDIA_TMP/social.png" "$ROOT/docs/social-preview.png"
cp "$ROOT/docs/refs.png" "$ROOT/agensi/media/screenshot-1.png"
cp "$ROOT/docs/safety.png" "$ROOT/agensi/media/screenshot-3.png"
ls -l "$ROOT"/docs/*.* "$ROOT"/agensi/media/*.png
