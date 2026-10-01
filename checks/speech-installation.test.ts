import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SpeechSettings } from '../service/speech-settings';
import { installationPreferences } from '../client/speech-preferences';
import { DEFAULT_TRANSCRIPT_RULES } from '../contract/transcript-normalization';
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
  it('migrates transcript rules, persists edits and empty lists, and protects them from older clients', () => {
    const { dir, saved } = settings();
    const selection = { recognition: 'browser', output: 'browser', fishVoice: '' } as const;
    expect(saved.read().transcriptRules).toEqual(DEFAULT_TRANSCRIPT_RULES);
    const rules = [{ from: 'North Point', to: 'NorthPointe Church', context: 'name' }] as const;
    const edited = saved.save({ ...selection, transcriptRules: [...rules] }, 0);
    expect(new SpeechSettings(dir).read().transcriptRules).toEqual(rules);
    expect(installationPreferences({ ...DEFAULT_SPEECH, transcriptRules: [] }, edited).transcriptRules).toEqual(rules);
    expect(saved.save(selection, 1).transcriptRules).toEqual(rules);
    const removed = saved.save({ ...selection, transcriptRules: [] }, 2);
    expect(new SpeechSettings(dir).read().transcriptRules).toEqual([]);
    expect(installationPreferences(DEFAULT_SPEECH, removed).transcriptRules).toEqual([]);
    expect(saved.save(selection, 3).transcriptRules).toEqual([]);
    expect(() => saved.save({ ...selection, transcriptRules: [{ from: 'North Point', to: 'NorthPointe', context: 'unknown' }] } as never, 4)).toThrow();
    for (const invalid of [[{ from: '', to: 'Name' }], [{ from: 'Name', to: '' }], [{ from: 'x'.repeat(81), to: 'Name' }], [{ from: 'Name', to: 'One' }, { from: ' Name ', to: 'Two' }], Array.from({ length: 21 }, (_, i) => ({ from: `Name ${i}`, to: 'Name' }))]) {
      expect(() => saved.save({ ...selection, transcriptRules: invalid }, 4)).toThrow();
      expect(saved.read().transcriptRules).toEqual([]);
    }
    const unrestricted = saved.save({ ...selection, transcriptRules: [{ from: 'north point', to: 'NorthPointe', context: 'any' }] }, 4);
    expect(new SpeechSettings(dir).read().transcriptRules).toEqual(unrestricted.transcriptRules);
    expect(installationPreferences(DEFAULT_SPEECH, unrestricted).transcriptRules?.[0]?.context).toBe('any');
  });
  it('defaults old settings to restrained delivery and preserves Off across devices and older clients', () => {
    const { saved } = settings();
    const legacy = { version: 1, revision: 7, setupComplete: true, recognition: 'browser', output: 'fish', fishVoice: 'legacy-voice' };
    writeFileSync(saved.path, JSON.stringify(legacy));
    expect(saved.read()).toEqual({ ...legacy, fishDelivery: 'restrained', showTranscriptions: false, transcriptRules: DEFAULT_TRANSCRIPT_RULES });
    expect(JSON.parse(readFileSync(saved.path, 'utf8'))).toEqual(legacy);
    const off = saved.save({ recognition: 'browser', output: 'fish', fishVoice: 'legacy-voice', fishDelivery: 'off' }, 7);
    expect(installationPreferences({ ...DEFAULT_SPEECH, fishDelivery: 'happy' }, off).fishDelivery).toBe('off');
    expect(saved.save({ recognition: 'browser', output: 'fish', fishVoice: 'legacy-voice' }, 8).fishDelivery).toBe('off');
    expect(() => saved.save({ recognition: 'browser', output: 'fish', fishVoice: 'legacy-voice', fishDelivery: '[arbitrary cue]' } as never, 9)).toThrow();
    expect(saved.read().fishDelivery).toBe('off');
  });
  it('defaults transcription display off and persists explicit choices across restarts and devices', () => {
    const { dir, saved } = settings();
    expect(DEFAULT_SPEECH.showTranscriptions).toBe(false);
    expect(saved.read().showTranscriptions).toBe(false);
    const selection = { recognition: 'browser', output: 'browser', fishVoice: '' } as const;
    const enabled = saved.save({ ...selection, showTranscriptions: true }, 0);
    expect(new SpeechSettings(dir).read().showTranscriptions).toBe(true);
    expect(installationPreferences(DEFAULT_SPEECH, enabled).showTranscriptions).toBe(true);
    // A client predating this field cannot overwrite the owner's explicit choice.
    expect(saved.save(selection, 1).showTranscriptions).toBe(true);
    const disabled = saved.save({ ...selection, showTranscriptions: false }, 2);
    expect(new SpeechSettings(dir).read().showTranscriptions).toBe(false);
    expect(installationPreferences({ ...DEFAULT_SPEECH, showTranscriptions: true }, disabled).showTranscriptions).toBe(false);
    const { showTranscriptions: _, ...legacy } = disabled;
    expect(installationPreferences({ ...DEFAULT_SPEECH, showTranscriptions: true }, legacy).showTranscriptions).toBe(false);
    expect(() => saved.save({ ...selection, showTranscriptions: 'false' } as never, 3)).toThrow();
    expect(saved.read()).toEqual(disabled);
  });
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
    expect(current.fishModel).toBe('s2.1-pro');
    expect(current.speech.fishDelivery).toBe('restrained');
    expect(current.speech.showTranscriptions).toBe(false);
    const changed = await app.inject({ method: 'PUT', url: '/api/settings/speech', headers, payload: { ...payload, revision: 1, fishDelivery: 'soft', showTranscriptions: true, transcriptRules: [{ from: ' North Point ', to: ' NorthPointe ', context: 'name' }] } });
    expect(changed.statusCode).toBe(200); expect(changed.json().fishDelivery).toBe('soft');
    expect((await app.inject({ url: '/api/settings', headers: { cookie } })).json().speech.showTranscriptions).toBe(true);
    expect((await app.inject({ url: '/api/settings', headers: { cookie } })).json().speech.transcriptRules).toEqual([{ from: 'North Point', to: 'NorthPointe', context: 'name' }]);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/speech', headers, payload: { ...payload, revision: 2, transcriptRules: [{ from: '', to: 'Name' }] } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: '/api/settings/speech', headers, payload: { ...payload, revision: 2, fishDelivery: '(bad tag)' } })).statusCode).toBe(400);
    expect(current.vosk.state).toBe('unavailable');
  });
});
