import { test, expect } from '@playwright/test';
import { enterFixtureSession } from './fixture-session';

const group={id:'1ead712b-26ab-4c4c-a0f1-2acb9f5d0f15',name:'Work',slug:'work',description:'Work references'};
const document={id:'316db01a-3ed9-4be4-b3fb-1ded70bd5bfc',group_id:group.id,filename:'Customer guide.pdf',title:null,status:'ready',document_kind:'upload',group_name:'Work'};

test('browse, search, cite and download shared documents without changing the conversation',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/library/groups',route=>route.fulfill({json:[group]}));
  await page.route('**/api/library/documents?*',route=>route.fulfill({json:[document]}));
  await page.route('**/api/library/search',async route=>{
    expect(route.request().postDataJSON()).toMatchObject({query:'customer service',group:'work'});
    expect(route.request().headers()['x-csrf-token']).toBeTruthy();
    await route.fulfill({json:{query:'customer service',routing_reason:'explicit group',ambiguous_group:false,searched_groups:[{...group,score:1}],hits:[{chunk_id:'481c04d1-bffa-4e4f-8a3d-890c7b26d79d',document_id:document.id,group_name:group.name,group_slug:group.slug,filename:document.filename,chunk_index:2,score:0.04,content:'Ask what matters to the customer. <script>This is document text.</script>'}]}});
  });
  await page.route(`**/api/library/documents/${document.id}/signed-link`,route=>route.fulfill({json:{document_id:document.id,filename:document.filename,url:'https://fjmfziotgloxkiubldip.supabase.co/storage/v1/object/sign/rag-documents/fixture?token=expiring-fixture',expires_in:3600}}));
  await enterFixtureSession(page);
  await expect(page.getByRole('button',{name:'Wake NorthPointe'})).toBeEnabled();
  const conversation=await page.evaluate(()=>localStorage.getItem('vc2:conversation'));
  await page.screenshot({path:info.outputPath('before-library.png')});
  await page.getByRole('button',{name:'Open library'}).click();
  await expect(page.getByRole('dialog',{name:'Library'})).toBeVisible();
  await expect(page.getByText('Customer guide.pdf',{exact:true})).toBeVisible();
  await page.getByRole('combobox',{name:'Collection',exact:true}).selectOption('work');
  await page.getByLabel('Search your documents').fill('customer service');
  await page.getByRole('button',{name:'Search library',exact:true}).click();
  await expect(page.getByText('Work · Chunk 2',{exact:true})).toBeVisible();
  await expect(page.getByText('Ask what matters to the customer. <script>This is document text.</script>',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Get download'}).click();
  await expect(page.getByRole('link',{name:'Open Customer guide.pdf'})).toHaveAttribute('href',/token=expiring-fixture/);
  await page.screenshot({path:info.outputPath('library-search.png'),fullPage:true});
  expect(await page.evaluate(()=>window.document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.getByRole('button',{name:'Close Library'}).click();
  expect(await page.evaluate(()=>localStorage.getItem('vc2:conversation'))).toBe(conversation);
  await expect(page.getByRole('button',{name:'Open library'})).toBeFocused();
  expect(errors).toEqual([]);
});

test('library unavailability is visible and the conversation remains usable',async({page})=>{
  await page.route('**/api/library/**',route=>route.fulfill({status:503,json:{error:'The library connection has not been configured.'}}));
  await enterFixtureSession(page);
  await page.getByRole('button',{name:'Open library'}).click();
  await expect(page.getByRole('alert')).toHaveText('The library connection has not been configured.');
  await page.getByRole('button',{name:'Close Library'}).click();
  await expect(page.getByRole('button',{name:'Wake NorthPointe'})).toBeEnabled();
});
