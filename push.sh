#!/bin/bash
set -e

# ─────────────────────────────────────────
# Sprinkler Dash Card — Push & Release
# Usage: ./push.sh "commit message" [version]
# Example: ./push.sh "fix: progress bar" v1.7.1
# ─────────────────────────────────────────

MSG="${1:-chore: update}"
VERSION="$2"

cd "$(dirname "$0")"

# Copy latest card — prefer Claude output in Downloads, fall back to HA Samba mount
CLAUDE_SRC="$HOME/Downloads/sprinkler-dash-card.js"
HA_SRC="/Volumes/config/www/sprinkler-dash-card.js"
if [ -f "$CLAUDE_SRC" ]; then
  cp "$CLAUDE_SRC" sprinkler-dash-card.js
  echo "✓ Copied from $CLAUDE_SRC"
elif [ -f "$HA_SRC" ]; then
  cp "$HA_SRC" sprinkler-dash-card.js
  echo "✓ Copied from $HA_SRC"
else
  echo "⚠ No source file found — using existing sprinkler-dash-card.js"
fi

git add -A
git status

read -rp "Commit and push? [y/N] " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

git commit -m "$MSG"
git push origin main

if [ -n "$VERSION" ]; then
  git tag "$VERSION"
  git push origin "$VERSION"
  gh release create "$VERSION" sprinkler-dash-card.js \
    --title "$VERSION" \
    --notes "$MSG"
  echo "✓ Released $VERSION"
fi

echo "✓ Done → https://github.com/HybridRCG/sprinkler-dash-card"
