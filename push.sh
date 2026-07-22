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

# Copy latest card — from Claude outputs dir (set by Claude Desktop)
CLAUDE_OUT="$HOME/Library/Application Support/Claude/outputs/sprinkler-dash-card.js"
CLAUDE_DL="$HOME/Downloads/sprinkler-dash-card.js"
HA_SRC="/Volumes/config/www/community/sprinkler-dash-card/sprinkler-dash-card.js"
if [ -f "$CLAUDE_OUT" ]; then
  cp "$CLAUDE_OUT" sprinkler-dash-card.js
  echo "✓ Copied from Claude outputs"
elif [ -f "$CLAUDE_DL" ]; then
  cp "$CLAUDE_DL" sprinkler-dash-card.js
  echo "✓ Copied from Downloads"
elif [ -f "$HA_SRC" ]; then
  cp "$HA_SRC" sprinkler-dash-card.js
  echo "✓ Copied from HACS HA folder"
else
  echo "⚠ No source file found — using existing sprinkler-dash-card.js in project"
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
