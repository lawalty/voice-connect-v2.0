"""Private host recognition. No recordings or transcripts are written to disk."""
import asyncio
import hashlib
import hmac
import json
import os
from pathlib import Path
import shutil
import urllib.request
import uuid
import zipfile

from aiohttp import web, WSMsgType
from vosk import Model, KaldiRecognizer, SetLogLevel

SetLogLevel(-1)
MANIFEST = json.loads(Path(__file__).with_name('model.json').read_text())
ROOT = Path(os.environ.get('VC_VOSK_MODEL_DIR', '/models')).resolve()
TOKEN = Path(os.environ.get('VC_VOSK_TOKEN_FILE', '/run/secrets/vosk-token')).read_text().strip()
if len(TOKEN) < 32:
    raise RuntimeError('Vosk service token is missing')


class HostModel:
    def __init__(self):
        self.model = None
        self.removing = False
        self.task = None
        self.sessions = set()
        self.state = 'missing'
        self.received = 0
        self.error = None

    def status(self):
        return {**MANIFEST, 'installed': self.model is not None, 'state': self.state,
                'received': self.received, 'error': self.error, 'activeSessions': len(self.sessions)}

    def install_files(self):
        ROOT.mkdir(parents=True, exist_ok=True)
        target = ROOT / MANIFEST['id']
        if not target.exists():
            downloads = ROOT / '.downloads'
            downloads.mkdir(exist_ok=True)
            archive = downloads / (MANIFEST['id'] + '.zip')
            def valid():
                if not archive.exists() or archive.stat().st_size != MANIFEST['bytes']:
                    return False
                with archive.open('rb') as stream:
                    digest = hashlib.sha256()
                    while chunk := stream.read(262144):
                        digest.update(chunk)
                    return digest.hexdigest() == MANIFEST['sha256']
            if not valid():
                part = downloads / (MANIFEST['id'] + '.part')
                try:
                    with urllib.request.urlopen(MANIFEST['url'], timeout=60) as source, part.open('wb') as dest:
                        while chunk := source.read(262144):
                            self.received += len(chunk)
                            if self.received > MANIFEST['bytes']:
                                raise ValueError('Download exceeds manifest')
                            dest.write(chunk)
                    part.replace(archive)
                finally:
                    part.unlink(missing_ok=True)
                if not valid():
                    raise ValueError('Download integrity mismatch')
            self.received = MANIFEST['bytes']
            self.state = 'extracting'
            staging = ROOT / ('.install-' + uuid.uuid4().hex)
            staging.mkdir()
            try:
                with zipfile.ZipFile(archive) as bundle:
                    total = 0
                    for member in bundle.infolist():
                        path = (staging / member.filename).resolve()
                        if not path.is_relative_to(staging / MANIFEST['id']) or (member.external_attr >> 16) & 0o170000 == 0o120000:
                            raise ValueError('Unsafe model archive')
                        total += member.file_size
                        if total > 1024 * 1024 * 1024:
                            raise ValueError('Model archive too large')
                    bundle.extractall(staging)
                (staging / MANIFEST['id']).replace(target)
            finally:
                if staging.parent == ROOT:
                    shutil.rmtree(staging)
            (ROOT / 'installed.json').write_text(json.dumps(MANIFEST) + '\n')
        installed = json.loads((ROOT / 'installed.json').read_text())
        if installed != MANIFEST or not (target / 'am' / 'final.mdl').is_file():
            raise ValueError('Installed model does not match manifest')
        self.state = 'loading'
        return Model(str(target))

    async def install(self):
        self.state, self.error, self.received = 'downloading', None, 0
        try:
            self.model = await asyncio.to_thread(self.install_files)
            self.state = 'ready'
        except Exception:
            self.state, self.error = 'error', 'The host model could not be installed or loaded. Retry the download or check the host service.'

    def begin(self):
        if self.removing:
            raise web.HTTPConflict()
        if not self.model and (self.task is None or self.task.done()):
            self.task = asyncio.create_task(self.install())


host = HostModel()


@web.middleware
async def authorization(request, handler):
    if request.path != '/health' and not hmac.compare_digest(request.headers.get('Authorization', ''), 'Bearer ' + TOKEN):
        raise web.HTTPUnauthorized()
    return await handler(request)


async def status(request):
    return web.json_response(host.status())


async def install(request):
    host.begin()
    return web.json_response(host.status(), status=202)


async def remove(request):
    if host.removing or host.sessions or host.task and not host.task.done():
        raise web.HTTPConflict(text='Stop voice sessions before removing this host model.')
    host.removing = True
    try:
        host.model = None
        for name in [MANIFEST['id'], '.downloads']:
            target = (ROOT / name).resolve()
            if target.parent != ROOT:
                raise RuntimeError('Invalid removal path')
            if target.exists():
                await asyncio.to_thread(shutil.rmtree, target)
        (ROOT / 'installed.json').unlink(missing_ok=True)
        host.state, host.received, host.error = 'missing', 0, None
        return web.json_response(host.status())
    finally:
        host.removing = False


async def recognize(request):
    if host.model is None:
        raise web.HTTPServiceUnavailable()
    if len(host.sessions) >= 2:
        raise web.HTTPTooManyRequests()
    ws = web.WebSocketResponse(max_msg_size=64000, heartbeat=20, compress=False)
    host.sessions.add(ws)
    try:
        await ws.prepare(request)
        recognizer = await asyncio.to_thread(KaldiRecognizer, host.model, 16000)
        await ws.send_json({'type': 'ready', 'sampleRate': 16000})
        async for message in ws:
            if message.type == WSMsgType.BINARY:
                pcm = message.data
                if len(pcm) % 2 or not 0 < len(pcm) <= 64000:
                    await ws.close(code=1008); break
                final = await asyncio.to_thread(recognizer.AcceptWaveform, pcm)
                result = json.loads(recognizer.Result() if final else recognizer.PartialResult())
                await ws.send_json({'type': 'stt', 'text': result.get('text' if final else 'partial', ''), 'final': bool(final), 'turnComplete': False})
                await ws.send_json({'type': 'ack', 'bytes': len(pcm)})
            elif message.type == WSMsgType.TEXT:
                command = json.loads(message.data)
                if set(command) != {'type', 'id'} or command['type'] != 'finish' or not isinstance(command['id'], int):
                    await ws.close(code=1008); break
                result = json.loads(await asyncio.to_thread(recognizer.FinalResult))
                await ws.send_json({'type': 'stt', 'text': result.get('text', ''), 'final': True, 'turnComplete': False})
                await asyncio.to_thread(recognizer.Reset)
                await ws.send_json({'type': 'finished', 'id': command['id']})
            elif message.type == WSMsgType.ERROR:
                break
    except Exception:
        if ws.prepared and not ws.closed:
            await ws.send_json({'type': 'error', 'message': 'Host recognition stopped. Your draft is preserved.'})
            await ws.close(code=1011)
    finally:
        host.sessions.discard(ws)
    return ws


async def startup(app):
    if (ROOT / 'installed.json').exists():
        host.begin()


async def cleanup(app):
    await asyncio.gather(*(ws.close(code=1001) for ws in list(host.sessions)))
    if host.task:
        await host.task


app = web.Application(middlewares=[authorization], client_max_size=1024)
app.router.add_get('/health', lambda request: web.json_response({'ready': True}))
app.router.add_get('/status', status)
app.router.add_post('/install', install)
app.router.add_delete('/model', remove)
app.router.add_get('/recognize', recognize)
app.on_startup.append(startup)
app.on_cleanup.append(cleanup)
if __name__ == '__main__':
    web.run_app(app, host='127.0.0.1', port=int(os.environ.get('VC_VOSK_PORT', '27017')), access_log=None, print=None)
