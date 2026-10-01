import { test, expect, type WebSocketRoute } from '@playwright/test';
import { enterFixtureSession } from './fixture-session';
import { installationFixture } from './installation-fixture';
import { waitForFixtureBudget } from './fixture-budget';

test.beforeEach(waitForFixtureBudget);

const id='9cfa53a1-b0fa-4be0-8264-28e77b96fabc';
const document={id,title:'Meeting notes — next steps',revision:1,status:'pending',chunk_count:0};

for(const [extension,mime,body] of [['pdf','application/pdf','%PDF-1.4\nOriginal sermon'],['docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document','PK-original'],['txt','text/plain','Complete original notes']]) {
  test(`existing uploaded ${extension} downloads in its original format and can be offered again after dismissal`,async({page})=>{
    let offered={...document,title:'Existing Library document',filename:`Original.${extension}`,mime_type:mime,status:'ready',chunk_count:2,offer_id:'2b156c69-7df3-4817-b95a-3bd8870bd170'};
    await page.route('**/api/library/generated?*',route=>route.fulfill({json:[offered]}));
    await page.route(`**/api/library/documents/${id}/download`,route=>route.fulfill({contentType:mime,body}));
    await enterFixtureSession(page);
    const link=page.getByRole('link',{name:`Download Existing Library document (${extension.toUpperCase()})`});
    await expect(link).toBeVisible();
    const pending=page.waitForEvent('download');await link.click();
    expect((await pending).suggestedFilename()).toBe(`Original.${extension}`);
    await expect(link).toBeVisible();
    await page.getByRole('button',{name:'Dismiss download for Existing Library document'}).click();
    await page.reload();await expect(link).toHaveCount(0);
    offered={...offered,offer_id:'c03861a3-81aa-4a7f-a5a0-7f1f2eb59b3c'};
    await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect(link).toBeVisible();
    await expect(page.getByRole('region',{name:'Document downloads'}).getByRole('link')).toHaveCount(1);
    await page.reload();await expect(link).toBeVisible();
  });
}

test('indexed PDF pill is below the orb, persists through download and reload, and closes only with its X',async({page},info)=>{
  let state={...document};
  await page.route('**/api/library/generated?*',route=>route.fulfill({json:[state]}));
  await page.route(`**/api/library/documents/${id}/download`,route=>route.fulfill({contentType:'application/pdf',body:'%PDF-1.4\nfixture PDF'}));
  await enterFixtureSession(page);
  await expect(page.getByRole('button',{name:'Wake NorthPointe'})).toBeEnabled();
  await expect(page.getByRole('region',{name:'Document downloads'})).toHaveCount(0);
  const layoutSelectors=['.orb-stage','.voice-bottom','.conversation-heading','.conversation-toggle'];
  const before=await Promise.all(layoutSelectors.map(selector=>page.locator(selector).boundingBox()));
  state={...document,status:'ready',chunk_count:0};
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('region',{name:'Document downloads'})).toHaveCount(0);
  state={...document,status:'ready',chunk_count:3};
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  const link=page.getByRole('link',{name:`Download ${document.title} (PDF)`});
  await expect(link).toBeVisible();
  for (const [index,selector] of layoutSelectors.entries()) expect(await page.locator(selector).boundingBox()).toEqual(before[index]);
  expect(await page.locator('.voice-overlays').evaluate(element=>getComputedStyle(element).position)).toBe('absolute');
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

for(const viewport of [{width:768,height:768},{width:390,height:664}]) {
  test(`download overlays preserve the active face and coexist with transcription at ${viewport.width}x${viewport.height}`,async({page,context},info)=>{
    await page.setViewportSize(viewport);
    await context.grantPermissions(['microphone']);
    await installationFixture(page,{recognition:'deepgram',showTranscriptions:true});
    await page.route('**/api/orbs',route=>route.fulfill({json:{revision:1,configured:true,preferences:{packId:'luminous-glass',motion:0,phaseColors:true},packs:[]}}));
    await page.addInitScript(()=>localStorage.setItem('vc2:speech',JSON.stringify({audioCues:false})));
    let socket:WebSocketRoute|undefined;
    await page.routeWebSocket(url=>url.pathname==='/api/audio'&&url.searchParams.get('kind')==='stt',route=>{socket=route;route.send(JSON.stringify({type:'ready',sampleRate:16000}));});
    let ready=false;
    await page.route('**/api/library/generated?*',route=>route.fulfill({json:ready?[{...document,status:'ready',chunk_count:2}]:[]}));
    await enterFixtureSession(page);
    await expect(page.locator('.orb-stage[data-face-ready="true"]')).toBeVisible();
    await page.getByRole('button',{name:'Wake NorthPointe',exact:true}).click();
    // Cold speech-detector startup has its own 20s deadline; this checks layout, not startup speed.
    await expect(page.locator('.orb-stage.phase-listening')).toBeVisible({timeout:30000});
    const selectors=['.orb-stage','.orb-canvas','.voice-bottom','.conversation-toggle'];
    const before=await Promise.all(selectors.map(selector=>page.locator(selector).boundingBox()));
    await page.screenshot({path:info.outputPath('face-before-download.png')});
    ready=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    const pill=page.locator('.document-download-pill');await expect(pill).toBeVisible();
    for(const [index,selector] of selectors.entries()) expect(await page.locator(selector).boundingBox()).toEqual(before[index]);
    const bounds=(await pill.boundingBox())!,orb=before[0]!,controls=before[2]!;
    expect(bounds.y).toBeGreaterThanOrEqual(orb.y+orb.height);
    expect(bounds.y+bounds.height).toBeLessThan(controls.y);
    await page.screenshot({path:info.outputPath('face-with-download.png')});
    socket!.send(JSON.stringify({type:'stt',text:'A draft stays above the download.',started:true,final:false,turnComplete:false}));
    await expect(page.locator('.heard-draft')).toBeVisible();
    const transcript=(await page.locator('.heard-draft').boundingBox())!;
    expect(transcript.y+transcript.height).toBeLessThan(bounds.y);
    expect(await pill.boundingBox()).toEqual(bounds);
    expect(await page.locator('.orb-stage').boundingBox()).toEqual(orb);
    await page.screenshot({path:info.outputPath('transcription-and-download.png')});
    await page.getByRole('button',{name:`Dismiss download for ${document.title}`}).click();
    await expect(pill).toHaveCount(0);await expect(page.locator('.heard-draft')).toBeVisible();
    expect(await page.locator('.orb-stage').boundingBox()).toEqual(orb);
    await page.getByRole('button',{name:'End voice session',exact:true}).click();
  });
}
