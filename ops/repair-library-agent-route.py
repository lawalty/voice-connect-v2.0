#!/usr/bin/env python3
"""Repair the OpenClaw container's route to the VC Library on srv2003889.

Run with --check first. Uses the installed Compose stack and its existing image;
backs up the override and refuses any unrelated resolved configuration change.
"""
import argparse
import copy
import json
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
import urllib.request

import yaml

HOST = "srv2003889.hstgr.cloud"
SERVICE = "openclaw-gateway"
CONTAINER = "openclaw-openclaw-gateway-1"


class OverrideList(list):
    """Preserve Compose's port replacement tag when editing the override."""


class ComposeLoader(yaml.SafeLoader):
    pass


class ComposeDumper(yaml.SafeDumper):
    pass


ComposeLoader.add_constructor("!override", lambda loader, node: OverrideList(loader.construct_sequence(node)))
ComposeDumper.add_representer(OverrideList, lambda dumper, value: dumper.represent_sequence("!override", value))


def with_library_route(override):
    updated = copy.deepcopy(override)
    service = updated.setdefault("services", {}).setdefault(SERVICE, {})
    hosts = service.setdefault("extra_hosts", [])
    if isinstance(hosts, dict):
        hosts[HOST] = "host-gateway"
    elif isinstance(hosts, list):
        hosts[:] = [entry for entry in hosts if entry.replace("=", ":", 1).split(":", 1)[0] != HOST]
        hosts.append(HOST + ":host-gateway")
    else:
        raise ValueError("Unexpected extra_hosts format")
    return updated


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="Validate without changing the stack")
    args = parser.parse_args()
    assert socket.gethostname() == "srv2003889", "Unexpected host"
    base = Path("/root/openclaw")
    override = base / "compose.override.yaml"
    original = override.read_bytes()
    updated = yaml.dump(with_library_route(yaml.load(original, Loader=ComposeLoader)), Dumper=ComposeDumper, sort_keys=False).encode()
    native = Path("/root/.openclaw/openclaw.json")
    native_before = native.read_bytes()
    assert json.loads(native_before)["plugins"]["entries"]["vc-shared-library"]["config"]["baseUrl"] == "https://" + HOST
    command = ["docker", "compose", "-f", str(base / "docker-compose.yml")]

    def resolve(path):
        return json.loads(subprocess.check_output(command + ["-f", str(path), "config", "--format", "json"], cwd=base))

    before = resolve(override)
    with tempfile.NamedTemporaryFile(dir=base, suffix=".yaml") as candidate:
        candidate.write(updated)
        candidate.flush()
        after = resolve(candidate.name)
    expected = copy.deepcopy(before)
    hosts = expected["services"][SERVICE].setdefault("extra_hosts", [])
    hosts[:] = [entry for entry in hosts if entry.split("=", 1)[0] != HOST]
    hosts.append(HOST + "=host-gateway")
    assert after == expected, "Refusing unrelated Compose configuration changes"
    container = json.loads(subprocess.check_output(["docker", "inspect", CONTAINER]))[0]
    image = json.loads(subprocess.check_output(["docker", "image", "inspect", after["services"][SERVICE]["image"]]))[0]
    assert image["Id"] == container["Image"], "Refusing to change the Gateway image"
    if args.check:
        print(json.dumps({"validated": True, "only_change": "Library hostname routes to Docker host", "same_image": True}))
        return
    with sqlite3.connect("file:/opt/voice-connect-v2/state/voice-connect.sqlite?mode=ro", uri=True) as db:
        active = db.execute("select count(*) from turns where delivery in ('pending','accepted') and cancelled=0").fetchone()[0]
    assert active == 0, "Wait for the active VC turn to finish"
    backup = Path("/opt/voice-connect-v2/backups") / ("library-agent-route-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
    backup.mkdir(mode=0o700)
    (backup / "compose.override.yaml").write_bytes(original)
    (backup / "openclaw.json").write_bytes(native_before)
    for path in backup.iterdir():
        os.chmod(path, 0o600)
    assert override.read_bytes() == original, "Compose override changed during validation"
    override.write_bytes(updated)
    subprocess.run(command + ["-f", str(override), "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", SERVICE], cwd=base, check=True)
    assert native.read_bytes() == native_before, "Native configuration changed unexpectedly"
    for _ in range(45):
        try:
            with urllib.request.urlopen("http://127.0.0.1:18880/health", timeout=5) as response:
                if json.load(response).get("openclaw") is True:
                    print(json.dumps({"gateway_connected": True, "backup": str(backup), "native_configuration_preserved": True}))
                    return
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError("Gateway reconnection not confirmed; backup preserved")


if __name__ == "__main__":
    main()
