#!/usr/bin/env bash
# Usage: ./scripts/bump.sh [patch|minor|major|<version>]
# Default: patch

set -euo pipefail

BUMP_TYPE="${1:-patch}"

# ── resolve current version ──────────────────────────────────────────────────
CURRENT=$(node -p "require('./package.json').version")

bump_semver() {
  local ver="$1" type="$2"
  local major minor patch
  IFS='.' read -r major minor patch <<< "$ver"
  case "$type" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "${major}.$((minor + 1)).0" ;;
    patch) echo "${major}.${minor}.$((patch + 1))" ;;
    *)     echo "$type" ;;   # treat as explicit version string
  esac
}

NEW_VERSION=$(bump_semver "$CURRENT" "$BUMP_TYPE")

echo "Bumping $CURRENT → $NEW_VERSION"

# ── update package.json ──────────────────────────────────────────────────────
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$NEW_VERSION';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

# ── update manifest.json ─────────────────────────────────────────────────────
node -e "
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
manifest.version = '$NEW_VERSION';
fs.writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
"

# ── git commit + tag + push ──────────────────────────────────────────────────
git add -A
git commit -m "chore: bump version to $NEW_VERSION"
git tag "v$NEW_VERSION"
git push origin HEAD
git push origin "v$NEW_VERSION"

echo "Done — v$NEW_VERSION pushed with tag"
