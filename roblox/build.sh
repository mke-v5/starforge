#!/bin/bash
# CLI copy of the modules: Roblox-style requires -> file requires
rm -rf cli && mkdir -p cli
for f in src/*.luau; do sed -E 's/require\(script\.Parent\.([A-Za-z0-9_]+)\)/require(".\/\1")/g' "$f" > cli/$(basename $f); done
cp test/*.luau cli/ 2>/dev/null; true
