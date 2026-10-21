#!/usr/bin/env bash
# Dùng cho người biên soạn: chạy starter (kỳ vọng ĐỎ) rồi chạy lời giải (kỳ vọng XANH) cho một ngày.
# Usage: bash scripts/verify.sh day1
set -u
day="$1"
tmp="$(mktemp -d)"
mkdir "$tmp/nt"
cp -r ./. "$tmp/nt/" ; rm -rf "$tmp/nt/node_modules"; ln -s "$PWD/node_modules" "$tmp/nt/node_modules"
filter() { grep -E "^( ✓| ×| ❯ $day/[^:]*$|.*Test Files|.*Tests )"; }
echo "### STARTER ($day) - mong đợi có test đỏ"
(cd "$tmp/nt" && npx vitest run "$day/" 2>&1 | filter)
echo "### SOLUTION ($day) - mong đợi xanh hết"
cp -r "$tmp/nt/solutions/$day/." "$tmp/nt/$day/"
(cd "$tmp/nt" && npx vitest run "$day/" 2>&1 | filter)
rm -rf "$tmp"
