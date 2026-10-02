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
