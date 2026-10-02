import { test, expect } from '@playwright/test';
import { enterFixtureSession } from './fixture-session';

test('monitor icon opens an authenticated separate cloud desktop and preserves the conversation',async({page},info)=>{
  await enterFixtureSession(page);
  await expect.poll(()=>page.evaluate(()=>localStorage.getItem('vc2:conversation'))).toBeTruthy();
  const conversation=await page.evaluate(()=>localStorage.getItem('vc2:conversation'));
  const icon=page.getByRole('link',{name:'Open cloud desktop (opens in a new tab)'});
  await expect(icon).toHaveAttribute('href','/desktop');
  await expect(icon).toHaveAttribute('rel','noopener noreferrer');
  const popupPromise=page.waitForEvent('popup');await icon.click();const popup=await popupPromise;
  await expect(popup).toHaveURL(/\/desktop$/);
  await expect(popup.getByRole('heading',{name:'Cloud desktop'})).toBeVisible();
  await expect(popup.getByRole('alert')).toContainText('unavailable');
  await expect(popup.getByRole('button',{name:'Take control'})).toBeDisabled();
  await popup.screenshot({path:info.outputPath('desktop-unavailable.png')});
  expect(await page.evaluate(()=>localStorage.getItem('vc2:conversation'))).toBe(conversation);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('monitor-icon.png')});
  await popup.close();
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
