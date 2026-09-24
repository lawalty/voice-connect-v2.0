import {test,expect,type Page,type BrowserContext} from '@playwright/test';

let ownerCookies:Parameters<BrowserContext['addCookies']>[0]=[];
async function enterPrivateSpace(page:Page,context:BrowserContext){
  if(ownerCookies.length)await context.addCookies(ownerCookies);
  const response=await page.goto('/');
  if(!ownerCookies.length){
    await page.getByLabel('Password',{exact:true}).fill('browser-fixture-password-2026');
    await page.getByRole('button',{name:'Enter your space'}).click();
  }
  await expect(page.getByRole('button',{name:'Start talking'})).toBeEnabled();
  ownerCookies=await context.cookies();
  return response;
}

async function useNativeSpeechFixture(page:Page){
  await page.addInitScript(()=>{
    class NativeSpeechFixture{
      onstart?:()=>void;onend?:()=>void;onresult?:(event:unknown)=>void;aborted=false;
      start(){(window as unknown as {vcTestSpeech:NativeSpeechFixture}).vcTestSpeech=this;queueMicrotask(()=>this.onstart?.());}
      stop(){this.onend?.();}
      abort(){this.aborted=true;}
      emit(text:string){this.onresult?.({resultIndex:0,results:[{isFinal:true,0:{transcript:text}}]});}
    }
    Object.defineProperty(window,'SpeechRecognition',{configurable:true,value:NativeSpeechFixture});
  });
}

test('production security headers allow isolated local recognition without permitting page eval',async({page,context},info)=>{
  test.skip(info.project.name!=='desktop','One production runtime check; layout is covered separately.');
  test.setTimeout(150000);
  await context.grantPermissions(['microphone']);
  await page.addInitScript(()=>{
    const tracks:MediaStreamTrack[]=[];
    (window as unknown as {vcTestTracks:MediaStreamTrack[]}).vcTestTracks=tracks;
    const capture=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await capture(constraints);tracks.push(...stream.getAudioTracks());return stream;};
  });
  const errors:string[]=[],submissions:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/turns'))submissions.push(r.url());});
  const response=await enterPrivateSpace(page,context);
  expect(response!.headers()['content-security-policy']).not.toContain("'unsafe-eval'");
  await page.getByRole('button',{name:'Open settings'}).click();
  await page.getByRole('button',{name:/On this device/}).click();
  await page.getByRole('button',{name:'Download',exact:true}).click();
  await expect(page.getByRole('button',{name:'Remove',exact:true})).toBeVisible({timeout:60000});
  await page.getByRole('button',{name:'Save preferences'}).click();
  const composer=page.getByRole('textbox',{name:'Message NorthPointe'});
  await composer.fill('Keep my existing text draft.');
  const conversation=await page.evaluate(()=>localStorage.getItem('vc2:conversation'));
  await page.getByRole('button',{name:'Start talking'}).click();
  await expect(page.getByText('Listening to you',{exact:true})).toBeVisible({timeout:90000});
  expect(await page.evaluate(()=>(window as unknown as {vcTestTracks:MediaStreamTrack[]}).vcTestTracks.some(track=>track.readyState==='live'))).toBe(true);
  await composer.focus();
  await expect(composer).toHaveValue('Keep my existing text draft.');
  await expect(page.getByRole('button',{name:'Start talking'})).toBeEnabled();
  expect(await page.evaluate(()=>(window as unknown as {vcTestTracks:MediaStreamTrack[]}).vcTestTracks.every(track=>track.readyState==='ended'))).toBe(true);
  expect(await page.evaluate(()=>localStorage.getItem('vc2:conversation'))).toBe(conversation);
  // Let any queued local endpoint arrive: typing must not leave a recognizer capable of sending it.
  await page.waitForTimeout(1500);
  await page.getByRole('button',{name:'Open settings'}).click();
  await page.getByText('Device diagnostics',{exact:true}).click();
  await page.screenshot({path:info.outputPath('local-speech.png'),fullPage:true});
  await page.getByRole('button',{name:'Remove',exact:true}).click();
  await expect(page.getByRole('button',{name:'Download',exact:true})).toBeVisible({timeout:15000});
  expect(errors).toEqual([]);expect(submissions).toEqual([]);
});

for(const handoff of ['composer focus','Edit as text','direct Send'] as const){
  test(`active speech hands off through ${handoff} without losing text or accepting stale recognition`,async({page,context},info)=>{
    test.skip(info.project.name!=='desktop','Speech handoff is independent of the separately covered layout.');
    await context.grantPermissions(['microphone']);
    await useNativeSpeechFixture(page);
    const submissions:{url:string;text:string}[]=[];
    page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/turns'))submissions.push({url:request.url(),text:request.postDataJSON().text});});
    await enterPrivateSpace(page,context);
    const conversation=await page.evaluate(()=>localStorage.getItem('vc2:conversation'));
    const composer=page.getByRole('textbox',{name:'Message NorthPointe'});
    await composer.fill('An existing typed thought.');
    await page.getByRole('button',{name:'Start talking'}).click();
    await expect(page.getByText('Listening to you',{exact:true})).toBeVisible();
    await page.evaluate(()=>(window as unknown as {vcTestSpeech:{emit(text:string):void}}).vcTestSpeech.emit('Words spoken before typing.'));
    await expect(page.getByRole('region',{name:'Voice conversation'}).getByText('Words spoken before typing.',{exact:true})).toBeVisible();
    if(handoff==='composer focus')await composer.focus();
    else await page.getByRole('button',{name:handoff==='Edit as text'?'Edit as text':'Send message',exact:true}).click();
    await expect(page.getByRole('button',{name:'Start talking'})).toBeEnabled();
    expect(await page.evaluate(()=>(window as unknown as {vcTestSpeech:{aborted:boolean}}).vcTestSpeech.aborted)).toBe(true);
    await page.evaluate(()=>{const speech=(window as unknown as {vcTestSpeech:{emit(text:string):void;onend():void}}).vcTestSpeech;speech.emit('A stale late recognition result.');speech.onend();});
    const combined='An existing typed thought.\nWords spoken before typing.';
    if(handoff!=='direct Send'){
      await expect(composer).toHaveValue(combined);
      expect(submissions).toEqual([]);
      await page.getByRole('button',{name:'Send message',exact:true}).click();
    }
    await expect(composer).toHaveValue('');
    await page.waitForTimeout(750);
    expect(submissions).toEqual([{url:`http://127.0.0.1:5180/api/conversations/${conversation}/turns`,text:combined}]);
    expect(await page.evaluate(()=>localStorage.getItem('vc2:conversation'))).toBe(conversation);
    await expect(page.getByText('A stale late recognition result.',{exact:true})).toHaveCount(0);
  });
}

for(const source of ['voice','text'] as const){
  test(`a delayed ${source} receipt preserves newer typing in the same conversation`,async({page,context},info)=>{
    test.skip(info.project.name!=='desktop','Draft ownership is independent of layout.');
    await context.grantPermissions(['microphone']);
    await useNativeSpeechFixture(page);
    await enterPrivateSpace(page,context);
    const composer=page.getByRole('textbox',{name:'Message NorthPointe'});
    const conversation=await page.evaluate(()=>localStorage.getItem('vc2:conversation'));
    await composer.fill('An earlier typed draft.');
    await page.getByRole('button',{name:'Start talking'}).click();
    await expect(page.getByText('Listening to you',{exact:true})).toBeVisible();
    await page.evaluate(()=>(window as unknown as {vcTestSpeech:{emit(text:string):void}}).vcTestSpeech.emit('A complete spoken turn.'));
    await expect(page.getByRole('region',{name:'Voice conversation'}).getByText('A complete spoken turn.',{exact:true})).toBeVisible();
    let releaseReceipt=()=>{},markAdmitted=()=>{};
    const heldReceipt=new Promise<void>(resolve=>{releaseReceipt=resolve;});
    const admitted=new Promise<void>(resolve=>{markAdmitted=resolve;});
    const submissions:string[]=[];
    await page.route('**/api/conversations/*/turns',async route=>{
      submissions.push(route.request().postDataJSON().text);
      const response=await route.fetch();markAdmitted();await heldReceipt;await route.fulfill({response});
    });
    try{
      await page.getByRole('button',{name:source==='voice'?'Finish thought':'Send message',exact:true}).click();
      await admitted;
      await composer.focus();
      await expect(composer).toHaveValue(source==='voice'?'An earlier typed draft.':'An earlier typed draft.\nA complete spoken turn.');
      await composer.fill('New words typed while the receipt is delayed.');
      const received=page.waitForResponse(response=>response.url().endsWith('/turns')&&response.request().method()==='POST');
      releaseReceipt();await received;
      await expect(page.getByRole('button',{name:'Send message',exact:true})).toBeEnabled();
      await expect(composer).toHaveValue('New words typed while the receipt is delayed.');
      expect(submissions).toEqual([source==='voice'?'A complete spoken turn.':'An earlier typed draft.\nA complete spoken turn.']);
      expect(await page.evaluate(()=>localStorage.getItem('vc2:conversation'))).toBe(conversation);
    }finally{releaseReceipt();}
  });
}
