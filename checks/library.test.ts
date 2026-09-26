import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../service/main.js';
import { LibraryClient } from '../service/library.js';
import { createLibraryTools, libraryToolDefinitions } from '../service/library-tools.js';

const groupId='1ead712b-26ab-4c4c-a0f1-2acb9f5d0f15',documentId='316db01a-3ed9-4be4-b3fb-1ded70bd5bfc',chunkId='481c04d1-bffa-4e4f-8a3d-890c7b26d79d';
const groups=[{id:groupId,name:'Work',slug:'work',description:'Work reference material',owner_id:'private-owner'}];
const docs=[{id:documentId,group_id:groupId,filename:'Customer guide.pdf',title:null,status:'ready',document_kind:'upload',group_name:'Work',storage_path:'private-storage-path',owner_id:'private-owner'}];
const search={query:'customer service',routing_reason:'explicit group',ambiguous_group:false,searched_groups:[{id:groupId,name:'Work',slug:'work',score:1}],hits:[{chunk_id:chunkId,document_id:documentId,group_name:'Work',group_slug:'work',filename:'Customer guide.pdf',chunk_index:2,content:'Ask what matters to the customer.',score:0.04}]};
const secret='fixture-agent-token-that-must-stay-on-the-server';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.reverse())await close();cleanup.length=0;vi.restoreAllMocks();});
async function fixture() {
  const calls:{url:string;method:string;token:string|undefined;body:unknown}[]=[];
  let failure=false,redirect=false;
  const server=createServer(async(req,res)=>{
    const parts:Buffer[]=[];for await(const part of req)parts.push(part);
    const raw=Buffer.concat(parts).toString();calls.push({url:req.url!,method:req.method!,token:req.headers['x-rag-token'] as string|undefined,body:raw?JSON.parse(raw):undefined});
    if(redirect){res.writeHead(302,{location:'https://example.com/stolen'});res.end();return;}
    res.setHeader('content-type','application/json');
    if(failure){res.statusCode=500;res.end(JSON.stringify({detail:secret}));return;}
    const payload=req.url?.startsWith('/v1/groups')?groups:req.url?.startsWith('/v1/search')?search:req.url?.includes('signed-link')?{document_id:documentId,filename:docs[0].filename,url:'https://fjmfziotgloxkiubldip.supabase.co/storage/v1/object/sign/rag-documents/example?token=temporary&download=Customer guide.pdf',expires_in:3600}:docs;
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=(server.address() as {port:number}).port,url=`http://127.0.0.1:${port}`;
  const dir=mkdtempSync(join(tmpdir(),'vc-library-')),origin='http://127.0.0.1:5173';
  const app=await buildApp({config:{stateDir:dir,masterKey:randomBytes(32),bootstrapToken:'fixture-bootstrap-credential',gatewayEnabled:false,gatewayToken:'',origin,secureCookie:false,staticDir:join(dir,'absent'),libraryUrl:url,libraryToken:secret}});
  cleanup.push(async()=>{await app.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true,force:true});});
  const setup=await app.inject({method:'POST',url:'/api/auth/setup',headers:{origin},payload:{password:'fixture-password-long-enough',bootstrapToken:'fixture-bootstrap-credential'}});
  const cookie=String(setup.headers['set-cookie']).split(';')[0];
  return {app,calls,url,headers:{cookie,origin,'x-csrf-token':setup.json().csrfToken},fail:()=>{failure=true;},redirect:()=>{redirect=true;}};
}

describe('shared library authentication and exact API contract',()=>{
  it('uses the existing API paths and keeps credentials and storage internals server-side',async()=>{
    const f=await fixture();
    const list=await f.app.inject({url:'/api/library/documents?group=Work&limit=200',headers:f.headers});
    expect(list.statusCode).toBe(200);expect(list.json()).toMatchObject([{id:documentId,group_name:'Work'}]);
    for(const privateText of [secret,'private-owner','private-storage-path'])expect(list.body).not.toContain(privateText);
    expect(f.calls[0]).toMatchObject({url:'/v1/documents?limit=200&group=Work',method:'GET',token:secret});
    const response=await f.app.inject({method:'POST',url:'/api/library/search',headers:f.headers,payload:{query:'customer service',group:'work',include_generated:true,limit:2}});
    expect(response.statusCode).toBe(200);expect(response.json().hits[0].document_id).toBe(documentId);
    expect(f.calls[1]).toMatchObject({url:'/v1/search',body:{query:'customer service',group:'work',include_generated:true,limit:2}});
    const download=await f.app.inject({method:'POST',url:`/api/library/documents/${documentId}/signed-link`,headers:f.headers,payload:{}});
    expect(download.statusCode).toBe(200);expect(download.json().url).toContain('Customer%20guide.pdf');
    expect(f.calls[2].url).toBe(`/v1/documents/${documentId}/signed-link?expires_in=3600`);
  });
  it('rejects unauthenticated, encoded-path, cross-origin and missing-CSRF requests before reaching the library',async()=>{
    const f=await fixture();
    for(const url of ['/api/library/groups','/%61pi/library/groups','/api/library/documents'])expect((await f.app.inject({url})).statusCode).toBe(401);
    expect((await f.app.inject({method:'POST',url:'/api/library/search',headers:{...f.headers,origin:'https://untrusted.invalid'},payload:{query:'test'}})).statusCode).toBe(403);
    expect((await f.app.inject({method:'POST',url:'/api/library/search',headers:{cookie:f.headers.cookie,origin:f.headers.origin},payload:{query:'test'}})).statusCode).toBe(403);
    expect(f.calls).toHaveLength(0);
  });
  it('rejects invalid queries and IDs without sending requests',async()=>{
    const f=await fixture();
    for(const payload of [{query:'x'},{query:'test',limit:21},{query:'test',url:'https://untrusted.invalid'}])expect((await f.app.inject({method:'POST',url:'/api/library/search',headers:f.headers,payload})).statusCode).toBe(400);
    expect((await f.app.inject({method:'POST',url:'/api/library/documents/not-a-uuid/signed-link',headers:f.headers,payload:{}})).statusCode).toBe(400);
    expect(f.calls).toHaveLength(0);
  });
  it('sanitizes errors and refuses to follow upstream redirects with the credential',async()=>{
    const f=await fixture();f.fail();
    const error=await f.app.inject({url:'/api/library/groups',headers:f.headers});expect(error.statusCode).toBe(502);expect(error.body).not.toContain(secret);
    f.redirect();const redirected=await f.app.inject({url:'/api/library/groups',headers:f.headers});expect(redirected.statusCode).toBe(502);expect(redirected.body).not.toContain(secret);
  });
  it('reports an unconfigured connection instead of pretending the library is empty',async()=>{
    const client=new LibraryClient('','');expect(client.configured).toBe(false);
    await expect(client.groups()).rejects.toMatchObject({statusCode:503});
  });
  it('rejects insecure/non-origin configuration, malformed responses and foreign download links',async()=>{
    for(const url of ['http://example.com','https://example.com/another','https://secret@example.com','https://example.com?token=secret'])expect(()=>new LibraryClient(url,secret)).toThrow();
    const invalid=new LibraryClient('https://library.example',secret,vi.fn().mockResolvedValue(new Response(JSON.stringify({token:secret}))));
    await expect(invalid.groups()).rejects.toMatchObject({statusCode:502});
    const foreign=new LibraryClient('https://library.example',secret,vi.fn().mockResolvedValue(new Response(JSON.stringify({document_id:documentId,filename:'x',expires_in:300,url:'https://foreign.example/source'}))));
    await expect(foreign.signedLink(documentId)).rejects.toMatchObject({statusCode:502});
  });
  it('makes the same cited evidence available through the harness adapter without exposing credentials',async()=>{
    const f=await fixture(),tools=createLibraryTools(new LibraryClient(f.url,secret));
    const result=await tools.find(t=>t.name==='vc_library_search')!.execute('native-call',{query:'customer service',group:'work'});
    expect(result).toMatchObject({details:{hits:[{document_id:documentId,chunk_index:2}]}});
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(libraryToolDefinitions().map(t=>t.name)).toEqual(tools.map(t=>t.name));
    const bad=await tools.find(t=>t.name==='vc_library_download')!.execute('native-call',{document_id:'../groups'});
    expect(bad).toMatchObject({isError:true});expect(f.calls).toHaveLength(1);
  });
});
