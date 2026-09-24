#!/usr/bin/env bash
set -euo pipefail
release="${1:?Usage: deploy.sh COMMIT_SHA}"
[[ "$release" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a full commit SHA'; exit 1; }
[[ "$(hostname)" == srv2003889 ]] || { echo 'Unexpected deployment host'; exit 1; }
base=/opt/voice-connect-v2
source_dir="$base/releases/$release"
test -f "$source_dir/package.json"
install -d -m 700 "$base" "$base/backups" "$base/secrets"
exec 9>"$base/deploy.lock"
flock -n 9 || { echo 'Another VC deployment is running'; exit 1; }
python3 - <<'PY'
import json, pathlib, os, secrets, sqlite3, time
base=pathlib.Path('/opt/voice-connect-v2')
secret_dir=base/'secrets'
if (base/'state'/'voice-connect.sqlite').exists() and not (secret_dir/'master-key').exists():
    raise RuntimeError('Existing database requires its original master key. Restore that key before deploying.')
for name in ['state','caddy-data','caddy-config']:
    (base/name).mkdir(exist_ok=True)
os.chown(base/'state',1000,1000)
os.chmod(base/'state',0o700)
os.chown(secret_dir,1000,1000)
config=json.loads(pathlib.Path('/root/.openclaw/openclaw.json').read_text())
gateway_token=config.get('gateway',{}).get('auth',{}).get('token')
if not isinstance(gateway_token,str) or not gateway_token: raise RuntimeError('Gateway token unavailable')
for name,value in [('gateway-token',gateway_token),('master-key',secrets.token_hex(32)),('bootstrap-token',secrets.token_urlsafe(32))]:
    target=secret_dir/name
    if not target.exists() or name=='gateway-token':
        target.write_text(value+'\n')
    os.chmod(target,0o600)
    os.chown(target,1000,1000)
db=base/'state'/'voice-connect.sqlite'
if db.exists():
    stamp=time.strftime('%Y%m%dT%H%M%SZ',time.gmtime())
    with sqlite3.connect(db) as source, sqlite3.connect(base/'backups'/f'{stamp}.sqlite') as dest:
        source.backup(dest)
    os.chmod(base/'backups'/f'{stamp}.sqlite',0o600)
print('VC directories, secrets, and state backup ready; no secret values displayed.')
PY
export VC_RELEASE="$release"
cd "$source_dir"
docker compose --project-directory "$source_dir" -f ops/compose.yaml build app
if test -f "$base/current-release"; then cp "$base/current-release" "$base/previous-release"; fi
cat ops/Caddyfile > "$base/Caddyfile"
chmod 644 "$base/Caddyfile"
docker compose --project-directory "$source_dir" -f ops/compose.yaml up -d --no-build
healthy=0
for attempt in $(seq 1 30); do
    if curl --fail --silent http://127.0.0.1:18880/health | python3 -c 'import json,sys; h=json.loads(sys.stdin.read() or "{}"); sys.exit(0 if h.get("build")==sys.argv[1] and h.get("openclaw") is True else 1)' "$release"; then healthy=1; break; fi
    sleep 2
done
if test "$healthy" != 1; then echo 'New VC service failed health check. Previous image and backup remain available.'; exit 1; fi
docker compose --project-directory "$source_dir" -f ops/compose.yaml exec -T edge caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose --project-directory "$source_dir" -f ops/compose.yaml exec -T edge caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
printf '%s\n' "$release" > "$base/current-release"
printf 'Voice Connect deployed: %s\n' "$release"
docker compose --project-directory "$source_dir" -f ops/compose.yaml ps
