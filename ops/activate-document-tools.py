"""Activate the reviewed Library plugin release on the existing OpenClaw host.

Run after deploy.sh, with the full deployed SHA. Backups preserve both config and
the existing workshop skill. This changes no model, memory, browser, or voice setting.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sqlite3
import subprocess
import sys
import urllib.request

release = sys.argv[1]
assert re.fullmatch(r"[a-f0-9]{40}", release)
assert socket.gethostname() == "srv2003889"
base = Path("/opt/voice-connect-v2")
with urllib.request.urlopen("http://127.0.0.1:18880/health", timeout=10) as response:
    health = json.load(response)
assert health["build"] == release and health["openclaw"] is True
with sqlite3.connect(f"file:{base}/state/voice-connect.sqlite?mode=ro", uri=True) as db:
    active = db.execute("select count(*) from turns where delivery in ('pending','accepted') and cancelled=0").fetchone()[0]
assert active == 0, "Wait for the active Voice Connect turn to finish."
config_path = Path("/root/.openclaw/openclaw.json")
before = json.loads(config_path.read_text())
assert before["plugins"]["entries"]["vc-shared-library"]["enabled"] is True
paths = before["plugins"]["load"]["paths"]
old_paths = [path for path in paths if path.startswith("/home/node/.openclaw/vc-library-releases/")]
assert len(old_paths) == 1, "Inspect the existing Library plugin path."
skill = Path("/root/.openclaw/agents/northpointe/agent/workshop-skills/document-library-retrieval/SKILL.md")
assert skill.is_file()
backup = base / "backups" / f"document-tools-{release}"
backup.mkdir(mode=0o700, exist_ok=False)
shutil.copy2(config_path, backup / "openclaw.json")
os.chmod(backup / "openclaw.json", 0o600)
shutil.copy2(skill, backup / "SKILL.md")
target = Path("/root/.openclaw/vc-library-releases") / release
target.mkdir(mode=0o755, exist_ok=False)
subprocess.run(["docker", "cp", "voice-connect-v2-app-1:/app/dist/openclaw-library/.", str(target)], check=True, capture_output=True)
for file in target.iterdir():
    os.chmod(file, 0o644)
new_path = "/home/node/.openclaw/vc-library-releases/" + release
new_paths = [new_path if path in old_paths else path for path in paths]


def native(*args):
    result = subprocess.run(["docker", "exec", "openclaw-openclaw-gateway-1", "node", "openclaw.mjs", *args], capture_output=True, text=True, timeout=120)
    if result.returncode:
        # Do not relay config, token, or tool payloads from native diagnostics.
        raise RuntimeError(f"Native {' '.join(args[:2])} failed; inspect protected diagnostics. Backup: {backup}")
    return result.stdout


native("config", "set", "plugins.load.paths", json.dumps(new_paths), "--strict-json")
after = json.loads(config_path.read_text())
expected = json.loads(json.dumps(before))
expected["plugins"]["load"]["paths"] = new_paths
assert {k: v for k, v in after.items() if k != "meta"} == {k: v for k, v in expected.items() if k != "meta"}, "Unexpected unrelated configuration change."
source = base / "releases" / release / "integrations/openclaw-library/document-library-retrieval/SKILL.md"
shutil.copyfile(source, skill)
os.chmod(skill, 0o644)
os.chown(skill, 1000, 1000)
native("plugins", "reload", "vc-shared-library", "--accept-capabilities", "--json")
print(json.dumps({"plugin_release": release, "native_plugin_reloaded": True, "skill_sha256": hashlib.sha256(skill.read_bytes()).hexdigest(), "backup": str(backup), "unrelated_config_preserved": True}))
