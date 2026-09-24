// Read-only deployed identity, security and persisted-state gate. Never prints credentials.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {request} from '@playwright/test';

const expected=process.argv[2];
assert.match(expected||'',/^[a-f0-9]{40}$/,'Provide the full expected source SHA');
const access=JSON.parse(await readFile(process.env.VC_LIVE_CREDENTIAL_FILE||'.local/owner-access.json','utf8'));
assert.equal(access.origin,'https://srv2003889.hstgr.cloud');
const evidence=JSON.parse(await readFile('.local/release-evidence/live.json','utf8'));
const api=await request.newContext({baseURL:access.origin,extraHTTPHeaders:{Origin:access.origin}});
try{
  const health=await (await api.get('/health')).json();
  assert.equal(health.build,expected);assert.equal(health.openclaw,true);
  for(const path of ['/api/settings','/%61pi/settings','/a%70i/conversations','/api/%64iagnostics']){
    assert.equal((await api.get(path)).status(),401,`${path} requires authentication`);
  }
  const response=await api.post('/api/auth/login',{data:{password:access.password}});
  assert.equal(response.status(),200);const status=await response.json();
  assert.equal(status.build,expected);
  const noCsrf=await api.put('/%61pi/settings/deepgram',{data:{apiKey:'invalid'}});
  assert.equal(noCsrf.status(),403,'Encoded route still requires CSRF');
  const wrongOrigin=await api.put('/%61pi/settings/deepgram',{headers:{Origin:'https://untrusted.example','X-CSRF-Token':status.csrfToken},data:{apiKey:'invalid'}});
  assert.equal(wrongOrigin.status(),403,'Encoded route still checks Origin');
  const history=await api.get(`/api/conversations/${evidence.conversationId}`);
  assert.equal(history.status(),200);const view=await history.json();
  assert.ok(view.messages.some(m=>m.role==='assistant'&&/482/.test(m.text)),'Native conversation survives release changes');
  assert.ok(view.messages.some(m=>m.role==='user'&&m.attachments?.length),'Captured image survives release changes');
  const settings=await (await api.get('/api/settings')).json();
  assert.equal(settings.harness.connected,true);assert.equal(settings.harness.images,true);
  const html=await api.get('/');
  assert.ok(!html.headers()['content-security-policy'].includes("'unsafe-eval'"));
  const assets=[...new Set((await html.text()).match(/\/assets\/[^"'\s>]+\.(?:js|css)/g))];
  assert.ok(assets.length>=2);const verified=[];
  for(const path of assets){
    const remote=await api.get(path);assert.equal(remote.status(),200);
    const digest=b=>createHash('sha256').update(b).digest('hex');
    const local=await readFile(`dist/client${path}`);
    assert.equal(digest(await remote.body()),digest(local),`Served asset matches build: ${path}`);
    verified.push({path,sha256:digest(local)});
  }
  const result={time:new Date().toISOString(),build:expected,nativeConnected:true,persistedConversationId:evidence.conversationId,persistedImage:true,encodedRouteAuthentication:true,originAndCsrf:true,assets:verified};
  await mkdir('.local/release-evidence',{recursive:true});
  await writeFile(`.local/release-evidence/release-${expected}.json`,JSON.stringify(result,null,2));
  console.log('PASS release identity, persisted native conversation/image, security boundaries, and served assets',JSON.stringify(result));
}finally{await api.dispose();}
