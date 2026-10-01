import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { enterFixtureSession } from './fixture-session';
import { waitForFixtureBudget } from './fixture-budget';
import { LUMINOUS_GLASS, type InstallationOrbs } from '../../contract/orb-packs';

test.beforeEach(waitForFixtureBudget);
// This scenario verifies storage across two simultaneous devices. Keep real
// WebGL rendering, but avoid continuous GPU work while closing those contexts.
test.use({ reducedMotion: 'reduce' });
test('a legacy phone avatar migrates to the installation and fresh devices share packs and appearance', async ({ page, browser, context }, info) => {
  const suffix = randomUUID().slice(0, 8), id = `legacy-${suffix}`;
  const pack = { ...LUMINOUS_GLASS, id, name: 'Shared personal avatar',
    atlas: 'data:image/png;base64,' + readFileSync('client/public/orb-packs/luminous-glass/atlas.png').toString('base64'),
    flow: 'data:image/png;base64,' + readFileSync('client/public/orb-packs/luminous-glass/flow.png').toString('base64') };
  await enterFixtureSession(page);
  await expect(page.getByRole('button', { name: 'Open settings', exact: true })).toBeEnabled();
  const before = await (await page.request.get('/api/orbs')).json() as InstallationOrbs;
  const origin = String(info.project.use.baseURL);
  const csrf = (await (await page.request.get('/api/status')).json()).csrfToken;
  const headers = { origin, 'x-csrf-token': csrf };
  const read = async () => await (await page.request.get('/api/orbs')).json() as InstallationOrbs;
  const appearance = async (target: Page) => {
    await target.getByRole('button', { name: 'Open settings', exact: true }).click();
    await target.getByText('Orb appearance', { exact: true }).click();
    await expect(target.getByRole('combobox', { name: 'Orb style', exact: true })).toBeEnabled();
  };
  let second: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  try {
    // Seed the exact former browser store, then load the new client.
    await page.evaluate(async pack => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('vc2-orb-packs', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('packs', { keyPath: 'id' });
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction('packs', 'readwrite'); tx.objectStore('packs').put(pack);
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
      }); db.close();
      localStorage.setItem('vc2:orb', JSON.stringify({ packId: pack.id, motion: .65, phaseColors: false }));
      localStorage.removeItem('vc2:orb-server-migration-v1');
    }, pack);
    await page.reload(); await appearance(page);
    await expect.poll(async () => (await read()).packs.some(p => p.id === id)).toBe(true);
    if (!before.configured) {
      await expect(page.getByRole('combobox', { name: 'Orb style', exact: true })).toHaveValue(id);
      await expect(page.getByRole('checkbox', { name: 'State colors', exact: true })).not.toBeChecked();
      await expect(page.getByRole('slider', { name: 'Movement', exact: true })).toHaveValue('0.65');
    } else {
      await page.getByRole('combobox', { name: 'Orb style', exact: true }).selectOption(id);
    }
    await expect(page.locator('.orb-pack-preview [data-face-ready="true"]')).toBeVisible();
    await expect.poll(async () => await page.evaluate(() => localStorage.getItem('vc2:orb-server-migration-v1'))).toBe('done');
    second = await browser.newContext({ baseURL: origin, reducedMotion: 'reduce', storageState: { cookies: await context.cookies(), origins: [] } });
    const pc = await second.newPage(); await pc.goto('/'); await appearance(pc);
    await expect(pc.getByRole('combobox', { name: 'Orb style', exact: true })).toHaveValue(id);
    await expect(pc.locator('.orb-pack-preview [data-face-ready="true"]')).toBeVisible();
    await pc.getByRole('checkbox', { name: 'State colors', exact: true }).check();
    await expect.poll(async () => (await read()).preferences.phaseColors).toBe(true);
    // Opening the panel refreshes a still-open device without a new sign-in.
    await page.getByRole('button', { name: 'Close Make yourself at home', exact: true }).click();
    await appearance(page); await expect(page.getByRole('checkbox', { name: 'State colors', exact: true })).toBeChecked();
    const imported = { ...pack, id: `new-${suffix}`, name: 'Imported on PC' };
    await pc.locator('input[type=file][accept*=".orb.json"]').setInputFiles({ name: 'my-avatar.orb.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(imported)) });
    await expect(pc.getByRole('combobox', { name: 'Orb style', exact: true })).toHaveValue(imported.id);
    await page.reload(); await appearance(page);
    await expect(page.getByRole('combobox', { name: 'Orb style', exact: true })).toHaveValue(imported.id);
    await page.getByRole('combobox', { name: 'Preview expression', exact: true }).selectOption('speaking');
    await expect(page.locator('.orb-pack-preview [data-face-ready="true"]')).toBeVisible();
    await page.screenshot({ path: info.outputPath('shared-orb-appearance.png'), fullPage: true });
    // The phone's local recovery copy still exists after transfer.
    expect(await page.evaluate(async id => {
      const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('vc2-orb-packs', 1); request.onsuccess = () => resolve(request.result); });
      const found = await new Promise<boolean>(resolve => { const request = db.transaction('packs').objectStore('packs').get(id); request.onsuccess = () => resolve(Boolean(request.result)); }); db.close(); return found;
    }, id)).toBe(true);
  } finally {
    await second?.close();
    for (const packId of [id, `new-${suffix}`]) {
      const current = await read(); if (current.packs.some(p => p.id === packId)) await page.request.delete(`/api/orbs/packs/${packId}`, { headers, data: { revision: current.revision } });
    }
    const current = await read(); await page.request.patch('/api/orbs/preferences', { headers, data: { revision: current.revision, patch: before.preferences } });
  }
});
