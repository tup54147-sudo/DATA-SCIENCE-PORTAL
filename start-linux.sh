#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo 'Node.js 22.5 or newer is required.'; exit 1; }
[ -d node_modules ] || npm install
[ -f .env ] || cp .env.example .env
exec npm start
