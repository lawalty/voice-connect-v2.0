// Authorized synthetic acceptance. Isolated browser profiles; never runs in CI.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium, request, expect } from '@playwright/test';

const expected = process.argv[2];
assert.match(expected || '', /^[a-f0-9]{40}$/, 'Expected full release SHA');
const access = JSON.parse(await readFile(process.env.VC_LIVE_CREDENTIAL_FILE || '.local/owner-access.json', 'utf8'));
assert.equal(access.origin, 'https://srv2003889.hstgr.cloud');
const api = await request.newContext({ baseURL: access.origin, extraHTTPHeaders: { Origin: access.origin } });
let browser;
const evidence = `.local/release-evidence/recovery-${expected.slice(0, 7)}`;
const result = { build: expected, time: new Date().toISOString(), physicalTabletTest: false };
try {
  const health = await (await api.get('/health')).json();
  assert.equal(health.build, expected); assert.equal(health.openclaw, true);
  const login = await api.post('/api/auth/login', { data: { password: access.password } });
  assert.equal(login.status(), 200);
  const status = await login.json();
  const created = await api.post('/api/conversations', { headers: { 'X-CSRF-Token': status.csrfToken }, data: { title: 'Synthetic reply recovery QA' } });
  assert.equal(created.status(), 200);
  const conversation = await created.json(); result.conversationId = conversation.id;
  const storageState = await api.storageState();
  browser = await chromium.launch();
  const tablets = await browser.newContext({ baseURL: access.origin, storageState, viewport: { width: 800, height: 1100 } });
  const phones = await browser.newContext({ baseURL: access.origin, storageState, viewport: { width: 412, height: 915 } });
  for (const context of [tablets, phones]) await context.addInitScript(id => {
    localStorage.setItem('vc2:conversation', id);
    localStorage.setItem('vc2:speech', JSON.stringify({ recognition: 'browser', output: 'browser', audioCues: false }));
    Object.assign(window, { recoverySpeech: [] });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      getVoices: () => [], addEventListener() {}, removeEventListener() {}, cancel() {},
      speak(utterance) { window.recoverySpeech.push(utterance.text); queueMicrotask(() => { utterance.onstart?.(new Event('start')); utterance.onend?.(new Event('end')); }); },
    } });
  }, conversation.id);
  const tablet = await tablets.newPage(), phone = await phones.newPage();
  let connections = 0, faultyConnection = 0, fault = '', dropped = 0, submissions = 0, aborts = 0;
  await tablet.routeWebSocket(url => url.pathname === '/api/events', route => {
    const connection = ++connections, server = route.connectToServer();
    server.onMessage(message => {
      const event = JSON.parse(message.toString());
      if (connection === faultyConnection && fault && event.type !== 'hello' && (fault === 'silent' || event.type !== 'pong')) { dropped++; return; }
      route.send(message);
    });
  });
  tablet.on('request', req => {
    if (req.method() === 'POST' && req.url().endsWith('/turns')) submissions++;
    if (req.url().endsWith('/abort')) aborts++;
  });
  for (const page of [tablet, phone]) {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Wake NorthPointe' })).toBeEnabled();
    await page.getByRole('button', { name: /Conversation\s*\d/ }).click();
  }
  faultyConnection = connections; fault = 'events';
  await tablet.getByLabel('Message NorthPointe').fill('Synthetic Voice Connect delivery check. Do not use tools or change files or saved memories. Reply with exactly: RECOVERY 731.');
  await tablet.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(phone.getByRole('article', { name: 'NorthPointe', exact: true })).toContainText('RECOVERY 731', { timeout: 90000 });
  await expect.poll(async () => {
    const response = await api.get(`/api/conversations/${conversation.id}`);
    assert.equal(response.status(), 200);
    const view = await response.json();
    return !view.activeTurn && view.messages.some(m => m.role === 'assistant' && m.text.includes('RECOVERY 731'));
  }, { timeout: 30000, intervals: [1000, 2000] }).toBe(true);
  await tablet.getByLabel('Message NorthPointe').fill('Unsent tablet draft.');
  const restoredAt = Date.now();
  await tablet.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('resume')); });
  await expect(tablet.getByRole('article', { name: 'NorthPointe', exact: true })).toContainText('RECOVERY 731', { timeout: 8000 });
  await expect(tablet.getByText('NorthPointe is thinking', { exact: true })).toHaveCount(0);
  result.foregroundRecoveryMs = Date.now() - restoredAt;
  assert.equal(connections, faultyConnection, 'Missing events recover without restarting a healthy socket');
  await expect(tablet.getByLabel('Message NorthPointe')).toHaveValue('Unsent tablet draft.');
  assert.deepEqual(await tablet.evaluate(() => window.recoverySpeech), [], 'Recovery does not replay old speech');
  // A transport which remains OPEN but no longer answers page probes must reconnect.
  fault = 'silent'; const restartedAt = Date.now();
  await tablet.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => connections, { timeout: 10000 }).toBe(faultyConnection + 1);
  await expect(tablet.locator('.site-header .connection-pill')).toHaveText('Connected');
  result.silentSocketRecoveryMs = Date.now() - restartedAt;
  await expect(tablet.getByLabel('Message NorthPointe')).toHaveValue('Unsent tablet draft.');
  for (const page of [tablet, phone]) assert.equal(await page.evaluate(() => localStorage.getItem('vc2:conversation')), conversation.id);
  assert.equal(submissions, 1); assert.equal(aborts, 0); assert.ok(dropped > 0);
  const history = await (await api.get(`/api/conversations/${conversation.id}`)).json();
  assert.equal(history.messages.filter(m => m.role === 'user').length, 1);
  Object.assign(result, { submissions, aborts, droppedEvents: dropped, sameConversation: true, draftPreserved: true, noSpeechReplay: true, nativeRoundTrip: true });
  await mkdir(evidence, { recursive: true });
  await tablet.screenshot({ path: `${evidence}/tablet-restored.png`, fullPage: true });
  await phone.screenshot({ path: `${evidence}/phone-live.png`, fullPage: true });
  await writeFile(`${evidence}/result.json`, JSON.stringify(result, null, 2));
  console.log('PASS native two-client reply recovery', JSON.stringify(result));
} finally { await browser?.close(); await api.dispose(); }
