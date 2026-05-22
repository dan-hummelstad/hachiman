#!/usr/bin/env bash
# Auto-format the file just edited, using the owning package's
# prettier + eslint config. Silent on success; never blocks.
set -uo pipefail

input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')

[ -z "$file" ] && exit 0
[ ! -f "$file" ] && exit 0

case "$file" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.css|*.md) ;;
  *) exit 0 ;;
esac

case "$file" in
  */apps/hachiman/*)            pkg="hachiman" ;;
  */pkgs/hachiman-node/*)       pkg="@hachiman/hachiman-node" ;;
  *)                            exit 0 ;;
esac

# Skip generated artifacts (the block-generated hook should have caught these,
# but belt-and-suspenders).
case "$file" in
  */mumbleproto/*) exit 0 ;;
  */dist/*|*/out/*|*/node_modules/*) exit 0 ;;
esac

pnpm -F "$pkg" exec prettier --write --log-level=silent "$file" >/dev/null 2>&1 || true
pnpm -F "$pkg" exec eslint --fix --quiet "$file" >/dev/null 2>&1 || true

exit 0
