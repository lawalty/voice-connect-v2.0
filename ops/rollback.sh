#!/usr/bin/env bash
set -euo pipefail
base=/opt/voice-connect-v2
release="${1:-$(cat "$base/previous-release") }"
release="${release// /}"
[[ "$(hostname)" == srv2003889 && "$release" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid host or release'; exit 1; }
source_dir="$base/releases/$release"
test -f "$source_dir/ops/compose.yaml"
docker image inspect "voice-connect-v2:$release" > /dev/null
exec 9>"$base/deploy.lock"
flock -n 9 || { echo 'Another VC operation is running'; exit 1; }
export VC_RELEASE="$release"
cd "$source_dir"
cat ops/Caddyfile > "$base/Caddyfile"
docker compose --project-directory "$source_dir" -f ops/compose.yaml up -d --no-build app
healthy=0
for attempt in $(seq 1 30); do
    if curl --fail --silent http://127.0.0.1:18880/health | python3 -c 'import json,sys; h=json.load(sys.stdin); sys.exit(0 if h.get("build")==sys.argv[1] and h.get("openclaw") is True else 1)' "$release"; then healthy=1; break; fi
    sleep 2
done
test "$healthy" = 1 || { echo 'Rollback did not restore the expected build and gateway connection.'; exit 1; }
docker compose --project-directory "$source_dir" -f ops/compose.yaml exec -T edge caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose --project-directory "$source_dir" -f ops/compose.yaml exec -T edge caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
printf '%s\n' "$release" > "$base/current-release"
printf '\nRolled application back to %s. State was preserved.\n' "$release"
