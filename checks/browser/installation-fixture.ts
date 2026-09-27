import type { Page } from '@playwright/test';
import type { InstallationSpeech } from '../../contract/types';

/** Explicit installation selections for isolated UI scenarios; never reads device storage. */
export async function installationFixture(page: Page, selection: Partial<InstallationSpeech> = {}) {
  let speech: InstallationSpeech = { version: 1, revision: 1, setupComplete: true, recognition: 'browser', output: 'browser', fishVoice: '', ...selection };
  await page.route('**/api/settings', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), speech, deepgramConfigured: true } });
  });
  await page.route('**/api/settings/speech', async route => {
    if (route.request().method() === 'GET') { await route.fulfill({ json: speech }); return; }
    const { revision, ...value } = route.request().postDataJSON();
    if (revision !== speech.revision) { await route.fulfill({ status: 409, json: { error: 'Settings changed elsewhere.' } }); return; }
    speech = { ...speech, ...value, setupComplete: true, revision: revision + 1 };
    await route.fulfill({ json: speech });
  });
}
