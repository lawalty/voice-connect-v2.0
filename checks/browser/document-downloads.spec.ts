import { test, expect } from '@playwright/test';
import { enterFixtureSession } from './fixture-session';

const id='9cfa53a1-b0fa-4be0-8264-28e77b96fabc';
const document={id,title:'Meeting notes — next steps',revision:1,status:'pending',chunk_count:0};

test('indexed PDF pill is below the orb, persists through download and reload, and closes only with its X',async({page},info)=>{
  let state={...document};
  await page.route('**/api/library/generated?*',route=>route.fulfill({json:[state]}));
  await page.route(`**/api/library/documents/${id}/download`,route=>route.fulfill({contentType:'application/pdf',body:'%PDF-1.4\nfixture PDF'}));
  await enterFixtureSession(page);
  await expect(page.getByRole('button',{name:'Wake NorthPointe'})).toBeEnabled();
  await expect(page.getByRole('region',{name:'Document downloads'})).toHaveCount(0);
  state={...document,status:'ready',chunk_count:0};
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('region',{name:'Document downloads'})).toHaveCount(0);
  state={...document,status:'ready',chunk_count:3};
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  const link=page.getByRole('link',{name:`Download ${document.title} (PDF)`});
  await expect(link).toBeVisible();
  const orb=await page.locator('.orb-stage').boundingBox(),pill=await page.locator('.document-download-pill').boundingBox();
  expect(orb).toBeTruthy();expect(pill).toBeTruthy();
  expect(pill!.y).toBeGreaterThanOrEqual(orb!.y+orb!.height);
  expect(await page.evaluate(()=>window.document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('document-pill.png'),fullPage:true});
  const downloadPromise=page.waitForEvent('download');await link.click();
  const download=await downloadPromise;expect(download.suggestedFilename()).toMatch(/Meeting notes.*pdf$/);
  await expect(link).toBeVisible();
  await page.reload();await expect(link).toBeVisible();
  await page.getByRole('button',{name:`Dismiss download for ${document.title}`}).click();
  await expect(link).toHaveCount(0);
  await page.reload();await expect(link).toHaveCount(0);
  state={...state,revision:2};await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(link).toBeVisible();
});

test('failed ingestion never announces a PDF and download errors keep the pill available',async({page})=>{
  let state={...document,status:'failed'};
  await page.route('**/api/library/generated?*',route=>route.fulfill({json:[state]}));
  await enterFixtureSession(page);
  await expect(page.getByRole('button',{name:'Wake NorthPointe'})).toBeEnabled();
  await expect(page.getByRole('region',{name:'Document downloads'})).toHaveCount(0);
  state={...document,status:'ready',chunk_count:2};await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.route(`**/api/library/documents/${id}/download`,route=>route.fulfill({status:502,json:{error:'This PDF could not be downloaded. Please try again.'}}));
  const link=page.getByRole('link',{name:`Download ${document.title} (PDF)`});
  await link.click();await expect(page.getByRole('alert')).toContainText('Please try again');await expect(link).toBeVisible();
});

test('download notices stay with the conversation that requested them',async({page})=>{
  let first='';
  await page.route('**/api/library/generated?*',route=>{
    const conversation=new URL(route.request().url()).searchParams.get('conversation_id')!;
    first ||= conversation;
    return route.fulfill({json:conversation===first?[{...document,status:'ready',chunk_count:2}]:[]});
  });
  await enterFixtureSession(page);
  const link=page.getByRole('link',{name:`Download ${document.title} (PDF)`});await expect(link).toBeVisible();
  await page.getByRole('button',{name:'NorthPointe',exact:true}).click();
  await page.getByRole('button',{name:'Begin a new conversation'}).click();
  await expect.poll(()=>page.evaluate(()=>localStorage.getItem('vc2:conversation'))).not.toBe(first);
  await expect(link).toHaveCount(0);
  expect(await page.evaluate(id=>JSON.parse(localStorage.getItem(`vc2:document-downloads:${id}`)!).documents.length,first)).toBe(1);
});
