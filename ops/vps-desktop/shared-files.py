#!/usr/bin/env python3
"""Copy incoming VC images and native OpenClaw files into the visible desktop."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import time

IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.avif', '.heic'}


def publish(base, folder, name, data, uid=1000):
    # Directory handles plus exclusive, no-follow creation prevent a desktop
    # user's links or existing files from redirecting privileged writes.
    if Path(name).name != name or name in {'.', '..'}:
        raise ValueError('Invalid destination name')
    parent = os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        directory = os.open(folder, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            try:
                output = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=directory)
            except FileExistsError:
                if not stat.S_ISREG(os.stat(name, dir_fd=directory, follow_symlinks=False).st_mode):
                    raise ValueError('Destination is not a regular file')
                return
            try:
                with os.fdopen(output, 'wb', closefd=False) as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(output)
                os.fchown(output, uid, uid)
            except Exception:
                os.unlink(name, dir_fd=directory)
                raise
            finally:
                os.close(output)
        finally:
            os.close(directory)
    finally:
        os.close(parent)


def sync(database, inbound, destination, seen, uid=1000):
    copied = 0
    if database.exists():
        with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=5) as db:
            for identifier, metadata in db.execute('SELECT id,metadata FROM attachments'):
                key = 'vc:' + identifier
                if key in seen:
                    continue
                meta = json.loads(metadata)
                ext = {'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp'}.get(meta.get('mimeType'))
                if not ext:
                    continue
                data = db.execute('SELECT bytes FROM attachments WHERE id=?', (identifier,)).fetchone()[0]
                name = 'image-' + hashlib.sha256(identifier.encode()).hexdigest()[:24] + ext
                publish(destination, 'Images', name, data, uid)
                seen.add(key)
                copied += 1
    if inbound.exists():
        for source in inbound.iterdir():
            info = source.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_size > 100 * 1024 * 1024 or time.time() - info.st_mtime < 2:
                continue
            key = 'native:' + source.name
            if key in seen:
                continue
            descriptor = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(descriptor, 'rb') as stream:
                data = stream.read(100 * 1024 * 1024 + 1)
                after = os.fstat(stream.fileno())
            if (after.st_size, after.st_mtime_ns) != (info.st_size, info.st_mtime_ns) or len(data) > 100 * 1024 * 1024:
                continue
            ext = source.suffix.lower()
            if not ext.isascii() or not ext[1:].isalnum() or len(ext) > 12:
                ext = '.bin'
            folder = 'Images' if ext in IMAGE_EXTENSIONS else 'Documents'
            # Native inbound basenames already contain stable generated IDs;
            # preserve readable original names when their components are safe.
            name = source.name if len(source.name) <= 200 else 'file-' + hashlib.sha256(source.name.encode()).hexdigest()[:24] + ext
            publish(destination, folder, name, data, uid)
            seen.add(key)
            copied += 1
    return copied


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    state = Path('/var/lib/voice-connect-desktop-files/seen.json')
    seen = set(json.loads(state.read_text())) if state.exists() else set()
    while True:
        try:
            count = sync(Path('/opt/voice-connect-v2/state/voice-connect.sqlite'), Path('/root/.openclaw/media/inbound'), Path('/opt/voice-connect-v2/shared-files'), seen)
            temporary = state.with_suffix('.tmp')
            temporary.write_text(json.dumps(sorted(seen)))
            temporary.chmod(0o600)
            temporary.replace(state)
            if count:
                print(f'Published {count} incoming desktop files', flush=True)
        except Exception as error:
            print(f'Desktop file sync failed: {type(error).__name__}', flush=True)
            if args.once:
                raise
        if args.once:
            return
        time.sleep(3)


if __name__ == '__main__':
    main()
