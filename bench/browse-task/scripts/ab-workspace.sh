#!/usr/bin/env bash
# Builds a BENCH_WORKSPACE for one A/B arm: git worktrees of pen-editor-backend and pen-editor at chosen refs,
# the desktop checkout symlinked (it must already be built: pen-editor-desktop/dist). Both worktrees get `npm ci`.
#
#   scripts/ab-workspace.sh <dest> [--backend-ref REF] [--frontend-ref REF] [--backend-patch FILE]
#
# 27.10.2026 A/B: arm A = backend origin/main with the prompt part of ba084e5 reverted (--backend-patch), arm B = origin/main.
# (That revert later landed as pen-editor-backend e9a63ab: `git show e9a63ab` is the A patch.)
set -euo pipefail
dest="${1:?usage: ab-workspace.sh <dest> [--backend-ref REF] [--frontend-ref REF] [--backend-patch FILE]}"; shift
root="$(cd "$(dirname "$0")/../../../.." && pwd)"       # the folder that holds pen-editor*/ (bench/ lives in pen-editor-desktop)
backend_ref=origin/main; frontend_ref=origin/main; patch=""
while [ $# -gt 0 ]; do
  case "$1" in
    --backend-ref) backend_ref="$2"; shift 2 ;;
    --frontend-ref) frontend_ref="$2"; shift 2 ;;
    --backend-patch) patch="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$dest"; dest="$(cd "$dest" && pwd)"
git -C "$root/pen-editor-backend" fetch -q
git -C "$root/pen-editor" fetch -q
git -C "$root/pen-editor-backend" worktree add --detach "$dest/pen-editor-backend" "$backend_ref" >/dev/null
git -C "$root/pen-editor" worktree add --detach "$dest/pen-editor" "$frontend_ref" >/dev/null
[ -z "$patch" ] || git -C "$dest/pen-editor-backend" apply --index "$patch"
ln -sfn "$root/pen-editor-desktop" "$dest/pen-editor-desktop"
[ -d "$root/pen-editor-desktop/dist" ] || echo "WARNING: pen-editor-desktop/dist is missing; run 'npm run build' there or drop --no-build" >&2
(cd "$dest/pen-editor-backend" && npm ci --no-audit --no-fund >/dev/null)
(cd "$dest/pen-editor" && npm ci --no-audit --no-fund >/dev/null)
echo "workspace ready: $dest"
git -C "$dest/pen-editor-backend" log --oneline -1
git -C "$dest/pen-editor" log --oneline -1
