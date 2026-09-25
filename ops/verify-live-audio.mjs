// Production assets, headers, and UI with a synthetic silent microphone. No agent call.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
const access=JSON.parse(await readFile(process.env.VC_LIVE_CREDENTIAL_FILE||'.local/owner-access.json','utf8'));
if(access.origin!=='https://srv2003889.hstgr.cloud')throw Error('Unexpected target');
const browser=await chromium.launch({args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
let page;
try{
  const context=await browser.newContext({permissions:['microphone'],viewport:{width:1440,height:960}});
  page=await context.newPage();const errors=[],submissions=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/turns'))submissions.push(r.url());});
  const response=await page.goto(access.origin);
  expect(response.headers()['content-security-policy']).not.toContain("'unsafe-eval'");
  await page.getByLabel('Password',{exact:true}).fill(access.password);
  await page.getByRole('button',{name:'Enter your space'}).click();
  await expect(page.getByRole('button',{name:'Wake NorthPointe'})).toBeEnabled();
  await page.getByRole('button',{name:'Open settings'}).click();
  await page.getByRole('button',{name:/^Vosk/}).click();
  await page.getByRole('button',{name:'Download',exact:true}).click();
  await expect(page.getByRole('button',{name:'Remove',exact:true})).toBeVisible({timeout:120000});
  console.log('PASS production model download and SHA-256 verification');
  await page.getByRole('button',{name:'Save preferences'}).click();
  const started=Date.now();await page.getByRole('button',{name:'Wake NorthPointe'}).click();
  await expect(page.getByText('Listening to you',{exact:true})).toBeVisible({timeout:120000});
  const startupMs=Date.now()-started;
  await page.waitForTimeout(2500);
  await page.getByRole('button',{name:'End voice session'}).click();
  await expect(page.getByRole('button',{name:'Wake NorthPointe'})).toBeEnabled();
  await page.getByRole('button',{name:'Open settings'}).click();
  await page.getByText('Device diagnostics',{exact:true}).click();
  await mkdir('.local/release-evidence',{recursive:true});
  await page.screenshot({path:'.local/release-evidence/live-audio-diagnostics.png',fullPage:true});
  await page.getByRole('button',{name:'Remove',exact:true}).click();
  await expect(page.getByRole('button',{name:'Download',exact:true})).toBeVisible({timeout:15000});
  expect(errors).toEqual([]);expect(submissions).toEqual([]);
  const report={time:new Date().toISOString(),startupMs,syntheticSilenceMs:2500,submissions:0,modelDownload:true,modelRemoval:true,pageErrors:errors,limit:'Synthetic desktop Chromium capture; physical Android/car/Bluetooth not qualified.'};
  await writeFile('.local/release-evidence/live-audio.json',JSON.stringify(report,null,2));
  console.log('PASS production AudioWorklet/Silero/Vosk capture, silent no-submit, model removal',JSON.stringify(report));
}catch(error){
  await mkdir('.local/release-evidence',{recursive:true});
  if(page)await page.screenshot({path:'.local/release-evidence/live-audio-failure.png',fullPage:true}).catch(()=>{});
  throw error;
}finally{await browser.close();}
