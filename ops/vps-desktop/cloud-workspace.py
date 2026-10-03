#!/usr/bin/env python3
"""Three fixed app launchers and window placement for the managed desktop."""
import argparse
import ctypes
import fcntl
import os
import re
from pathlib import Path
import subprocess
import time

APPS = {
    'browser': ['/usr/local/bin/vc-cloud-browser'],
    'terminal': ['xterm', '-name', 'VCCloudTerminal', '-class', 'VCCloudTerminal', '-title', 'Terminal', '-fa', 'Monospace', '-fs', '14', '-bg', '#101b22', '-fg', '#e1edf1'],
    'files': ['thunar', '/home/node/Shared files'],
}
CURRENT = Path('/tmp/vc-cloud-workspace-current')


def run(*command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=5)
    return result.stdout if result.returncode == 0 else ''


def windows():
    result = []
    for line in run('wmctrl', '-lG').splitlines():
        fields = line.split(None, 7)
        if len(fields) < 8:
            continue
        identity, desktop, x, y, width, height, host, title = fields
        # Chrome's instance name contains the profile path and spaces. Read its
        # structured X11 class separately instead of splitting wmctrl -lGx.
        properties = run('xprop', '-id', identity, 'WM_CLASS', '_NET_WM_WINDOW_TYPE')
        classes = re.findall(r'"([^"]*)"', properties.splitlines()[0] if properties else '')
        lower = classes[-1].lower() if classes else ''
        app = 'browser' if lower == 'google-chrome' else 'terminal' if lower == 'vccloudterminal' else 'files' if lower == 'thunar' else None
        if not app or title.startswith('DevTools'):
            continue
        # Legacy XTerm omits EWMH window type; that defaults to a normal main
        # window. Accept it only for our explicitly named terminal class.
        legacy_terminal = app == 'terminal' and '_NET_WM_WINDOW_TYPE:  not found.' in properties
        if '_NET_WM_WINDOW_TYPE_NORMAL' not in properties and not legacy_terminal:
            continue
        try:
            result.append({'id': identity, 'app': app, 'geometry': tuple(int(v) for v in [x, y, width, height])})
        except ValueError:
            continue
    return result


def switch(app):
    if app not in APPS:
        raise ValueError('Unknown desktop application')
    # Repeated taps wait for the first launcher, then focus its existing window.
    with open('/tmp/vc-cloud-workspace-launch.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        existing = next((window for window in windows() if window['app'] == app), None)
        if existing is None:
            with open('/tmp/vc-cloud-workspace-apps.log', 'ab') as log:
                subprocess.Popen(APPS[app], cwd='/home/node/Shared files', stdout=log, stderr=log, start_new_session=True)
            for _ in range(30):
                time.sleep(0.2)
                existing = next((window for window in windows() if window['app'] == app), None)
                if existing:
                    break
        if existing:
            run('wmctrl', '-ir', existing['id'], '-b', 'remove,hidden,shaded')
            run('wmctrl', '-ia', existing['id'])
            CURRENT.write_text(app)


def screen_size():
    for line in run('xdpyinfo').splitlines():
        if 'dimensions:' in line:
            width, height = line.split('dimensions:', 1)[1].split()[0].split('x')
            return int(width), int(height)
    return None


def decorations(identity, locked):
    # Xfwm expects the Motif hint's own atom type. xprop -f 32c creates a
    # CARDINAL property, which this window manager ignores.
    x11 = ctypes.CDLL('libX11.so.6')
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
    x11.XInternAtom.restype = ctypes.c_ulong
    x11.XChangeProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_void_p, ctypes.c_int]
    x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    error_handler_type = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
    error_handler = error_handler_type(lambda display, error: 0)
    x11.XSetErrorHandler.argtypes = [ctypes.c_void_p]
    x11.XSetErrorHandler.restype = ctypes.c_void_p
    display = x11.XOpenDisplay(None)
    if not display:
        return
    previous_handler = x11.XSetErrorHandler(error_handler)
    try:
        atom = x11.XInternAtom(display, b'_MOTIF_WM_HINTS', 0)
        values = (ctypes.c_ulong * 5)(3 if locked else 2, 0, 0, 0, 0)
        x11.XChangeProperty(display, int(identity, 16), atom, atom, 32, 0, values, 5)
        x11.XSync(display, 0)
    finally:
        x11.XCloseDisplay(display)
        x11.XSetErrorHandler(previous_handler)


def place(window, size):
    decorations(window['id'], False)
    run('wmctrl', '-ir', window['id'], '-b', 'remove,shaded,fullscreen')
    run('wmctrl', '-ir', window['id'], '-b', 'add,maximized_vert,maximized_horz')
    if window['geometry'] != (0, 0, *size):
        run('wmctrl', '-ir', window['id'], '-e', f'0,0,0,{size[0]},{size[1]}')
    time.sleep(0.05)
    decorations(window['id'], True)


def watch():
    missing_since = None
    configured = set()
    while True:
        try:
            current = CURRENT.read_text().strip() if CURRENT.exists() else 'browser'
            all_windows = windows()
            configured.intersection_update(w['id'] for w in all_windows)
            size = screen_size()
            if size:
                for window in all_windows:
                    if window['id'] not in configured or window['geometry'] != (0, 0, *size):
                        place(window, size)
                        configured.add(window['id'])
            # Recover the selected app if its last window was unexpectedly closed.
            if current in APPS and not any(w['app'] == current for w in all_windows):
                missing_since = missing_since or time.monotonic()
                if time.monotonic() - missing_since > 2:
                    switch(current)
                    missing_since = None
            else:
                missing_since = None
        except (OSError, ValueError, subprocess.TimeoutExpired):
            pass
        time.sleep(0.7)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('app', nargs='?', choices=list(APPS))
    parser.add_argument('--watch', action='store_true')
    args = parser.parse_args()
    if args.watch:
        watch()
    elif args.app:
        switch(args.app)
    else:
        parser.error('Select an application or --watch')
