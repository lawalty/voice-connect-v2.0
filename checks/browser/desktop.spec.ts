import { test, expect } from '@playwright/test';
import { enterFixtureSession } from './fixture-session';

test('monitor icon opens an authenticated separate cloud desktop and preserves the conversation',async({page},info)=>{
  await enterFixtureSession(page);
  await expect.poll(()=>page.evaluate(()=>localStorage.getItem('vc2:conversation'))).toBeTruthy();
  const conversation=await page.evaluate(()=>localStorage.getItem('vc2:conversation'));
  const icon=page.getByRole('link',{name:'Open cloud desktop (opens in a new tab)'});
  await expect(icon).toHaveAttribute('href','/desktop');
  await expect(icon).toHaveAttribute('rel','opener');
  const popupPromise=page.waitForEvent('popup');await icon.click();const popup=await popupPromise;
  await expect(popup).toHaveURL(/\/desktop$/);
  await expect(popup.getByRole('heading',{name:'Cloud desktop'})).toBeVisible();
  await expect(popup.getByRole('alert')).toContainText('unavailable');
  await expect(popup.getByRole('button',{name:'Take control'})).toBeDisabled();
  const dock=popup.getByRole('navigation',{name:'Desktop applications'});
  await expect(dock.getByRole('button')).toHaveCount(3);
  for(const name of ['Browser','Terminal','Files'])await expect(dock.getByRole('button',{name,exact:true})).toBeDisabled();
  expect(await popup.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await popup.screenshot({path:info.outputPath('desktop-unavailable.png')});
  expect(await page.evaluate(()=>localStorage.getItem('vc2:conversation'))).toBe(conversation);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('monitor-icon.png')});
  await popup.close();
});

test('Voice Connect focuses its original window, closes the desktop and preserves the draft',async({page,context})=>{
  await enterFixtureSession(page);
  await expect.poll(()=>page.evaluate(()=>localStorage.getItem('vc2:conversation'))).toBeTruthy();
  const conversation=await page.evaluate(()=>localStorage.getItem('vc2:conversation'));
  await page.getByRole('button',{name:/^Conversation/}).click();
  const draft=page.getByRole('textbox',{name:'Message NorthPointe'});
  await draft.fill('This unsent draft remains in the original window.');
  await page.evaluate(()=>{
    const original=window as Window&{desktopReturnOrder?:string[]};
    original.desktopReturnOrder=[];
    const focus=window.focus.bind(window);
    window.focus=()=>{original.desktopReturnOrder!.push('focus');focus();};
  });
  let opened=0;context.on('page',()=>{opened++;});
  const pending=page.waitForEvent('popup');
  await page.getByRole('link',{name:'Open cloud desktop (opens in a new tab)'}).click();
  const desktop=await pending;
  await expect(desktop.getByRole('button',{name:'Voice Connect',exact:true})).toBeVisible();
  expect(await desktop.evaluate(()=>window.opener!==null)).toBe(true);
  await desktop.evaluate(()=>{
    const close=window.close.bind(window);
    window.close=()=>{(window.opener as Window&{desktopReturnOrder:string[]}).desktopReturnOrder.push('close');close();};
  });
  const closed=desktop.waitForEvent('close');
  await desktop.getByRole('button',{name:'Voice Connect',exact:true}).click();
  await closed;
  expect(opened).toBe(1);expect(context.pages()).toEqual([page]);
  expect(await page.evaluate(()=>(window as Window&{desktopReturnOrder?:string[]}).desktopReturnOrder)).toEqual(['focus','close']);
  await expect(draft).toHaveValue('This unsent draft remains in the original window.');
  expect(await page.evaluate(()=>localStorage.getItem('vc2:conversation'))).toBe(conversation);
});

test('a directly opened desktop returns in the same tab',async({page,context})=>{
  await enterFixtureSession(page);await page.goto('/desktop');
  await expect(page.getByRole('button',{name:'Voice Connect',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.opener)).toBe(null);
  let opened=0;context.on('page',()=>{opened++;});
  await page.getByRole('button',{name:'Voice Connect',exact:true}).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('link',{name:'Voice Connect home'})).toBeVisible();
  expect(opened).toBe(0);expect(context.pages()).toEqual([page]);
});

test('initializes the packaged RFB client and reports a refused stream without a runtime error',async({page})=>{
  await enterFixtureSession(page);
  await page.route('**/api/desktop/connect',route=>route.fulfill({json:{ticket:'57731ef9-6d61-4c51-a646-1f1a3433cba5',control:false}}));
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/desktop');
  await expect(page.getByRole('status')).toHaveText('Ubuntu VPS · Disconnected');
  await expect(page.getByRole('alert')).toContainText('desktop disconnected');
  expect(errors).toEqual([]);
});
