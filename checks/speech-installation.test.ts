import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SpeechSettings } from '../service/speech-settings';
import { installationPreferences } from '../client/speech-preferences';
import { DEFAULT_SPEECH } from '../contract/types';
import { buildApp } from '../service/main';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
function settings() {
  const dir = mkdtempSync(join(tmpdir(), 'vc-speech-installation-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, saved: new SpeechSettings(dir) };
}
describe('installation speech choices', () => {
  it('requires setup, persists independently of devices and rejects stale writes', () => {
    const { dir, saved } = settings();
    expect(saved.read()).toMatchObject({ setupComplete: false, recognition: 'vosk', output: 'browser' });
    const first = saved.save({ recognition: 'deepgram', output: 'fish', fishVoice: 'chosen-voice' }, 0);
    expect(new SpeechSettings(dir).read()).toEqual(first);
    expect(() => saved.save({ recognition: 'browser', output: 'browser', fishVoice: '' }, 0)).toThrow('changed elsewhere');
    expect(saved.read()).toEqual(first);
    const device = installationPreferences({ ...DEFAULT_SPEECH, recognition: 'browser', output: 'browser', fishVoice: 'stale', audioCues: false, interruptionSensitivity: 22 }, first);
    expect(device).toMatchObject({ recognition: 'deepgram', output: 'fish', fishVoice: 'chosen-voice', audioCues: false, interruptionSensitivity: 22 });
    expect(JSON.parse(readFileSync(saved.path, 'utf8'))).toEqual(first);
  });
  it('never replaces a corrupt file with defaults or stores provider credentials', () => {
    const { saved } = settings();
    expect(() => saved.save({ recognition: 'browser', output: 'browser', fishVoice: '', apiKey: 'secret' } as never, 0)).toThrow();
    writeFileSync(saved.path, 'corrupt');
    expect(() => saved.read()).toThrow();
    expect(() => saved.save({ recognition: 'browser', output: 'browser', fishVoice: '' }, 0)).toThrow();
    expect(readFileSync(saved.path, 'utf8')).toBe('corrupt');
  });
  it('protects shared configuration and model management with authentication, origin and CSRF', async () => {
    const { dir } = settings(), origin = 'http://127.0.0.1:5173';
    const app = await buildApp({ config: { stateDir: dir, masterKey: randomBytes(32), gatewayEnabled: false, bootstrapToken: 'bootstrap-only-test-token', origin, secureCookie: false, staticDir: join(dir, 'absent') } });
    cleanup.push(() => app.close());
    expect((await app.inject('/api/settings')).statusCode).toBe(401);
    const setup = await app.inject({ method: 'POST', url: '/api/auth/setup', headers: { origin }, payload: { password: 'long fixture password', bootstrapToken: 'bootstrap-only-test-token' } });
    const cookie = setup.cookies[0]!.name + '=' + setup.cookies[0]!.value, csrf = setup.json().csrfToken;
    const payload = { revision: 0, recognition: 'browser', output: 'browser', fishVoice: '' };
    for (const url of ['/api/settings/speech', '/api/settings/vosk']) {
      expect((await app.inject({ method: url.endsWith('speech') ? 'PUT' : 'POST', url, headers: { origin, cookie }, payload })).statusCode).toBe(403);
    }
    const headers = { origin, cookie, 'x-csrf-token': csrf };
    expect((await app.inject({ method: 'PUT', url: '/api/settings/speech', headers, payload: { ...payload, recognition: 'deepgram' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/speech', headers, payload: { ...payload, output: 'fish', fishVoice: 'voice' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/speech', headers, payload: { ...payload, recognition: 'vosk' } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/speech', headers, payload })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/speech', headers, payload })).statusCode).toBe(409);
    const current = (await app.inject({ url: '/api/settings', headers: { cookie } })).json();
    expect(current.speech).toMatchObject({ setupComplete: true, revision: 1, recognition: 'browser' });
    expect(current.vosk.state).toBe('unavailable');
  });
});
