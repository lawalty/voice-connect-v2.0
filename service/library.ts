import { z } from 'zod';
import type { LibraryGroup, LibraryDocument, LibrarySearch, LibraryLink } from '../contract/library.js';

export const librarySearchInput = z.object({
  query: z.string().trim().min(2).max(4000), group: z.string().trim().min(1).max(80).optional(),
  session_group: z.string().trim().min(1).max(80).optional(),
  include_generated: z.boolean().default(false), limit: z.number().int().min(1).max(20).default(8),
}).strict();
export const libraryDocumentsInput = z.object({group: z.string().trim().min(1).max(80).optional(), limit: z.coerce.number().int().min(1).max(200).default(200)}).strict();
export const libraryDocumentId = z.string().uuid();
const group = z.object({id:z.string().uuid(),name:z.string(),slug:z.string(),description:z.string().default('')});
const document = z.object({id:z.string().uuid(),group_id:z.string().uuid(),filename:z.string(),title:z.string().nullable().optional(),status:z.string(),document_kind:z.string(),group_name:z.string().nullable().optional(),group_slug:z.string().nullable().optional()});
const search = z.object({query:z.string(),routing_reason:z.string(),ambiguous_group:z.boolean(),searched_groups:z.array(group.omit({description:true}).extend({score:z.number()})),hits:z.array(z.object({chunk_id:z.string().uuid(),document_id:z.string().uuid(),group_name:z.string(),group_slug:z.string(),filename:z.string(),chunk_index:z.number().int(),content:z.string(),score:z.number()}))});
const link = z.object({document_id:z.string().uuid(),filename:z.string(),url:z.string().url(),expires_in:z.number().int()});

export class LibraryError extends Error {
  constructor(public statusCode:number, message:string) { super(message); }
}

/** Thin client for the existing owner-scoped RAG API. Never queries Supabase directly. */
export class LibraryClient {
  private readonly base:string;
  constructor(baseUrl:string, private readonly token:string, private readonly fetcher:typeof fetch=fetch) {
    this.base=baseUrl.replace(/\/+$/, '');
    if(this.base) {
      const url=new URL(this.base);
      if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||
        (url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))
        throw new Error('The library API must use an HTTPS origin (or loopback HTTP for development).');
    }
  }
  get configured() { return Boolean(this.base&&this.token); }
  private async request(path:string, method='GET', payload?:unknown, signal?:AbortSignal):Promise<unknown> {
    if(!this.configured)throw new LibraryError(503,'The library connection has not been configured.');
    const timeout=AbortSignal.timeout(25000);
    let response:Response;
    try {
      response=await this.fetcher(`${this.base}${path}`,{method,headers:{'X-RAG-Token':this.token,...payload!==undefined?{'Content-Type':'application/json'}:{}},
        body:payload===undefined?undefined:JSON.stringify(payload),redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout});
      if(!response.ok) {
        await response.body?.cancel();
        if(response.status===404)throw new LibraryError(404,'This library document or group was not found.');
        if(response.status===429)throw new LibraryError(503,'The library is busy. Please try again shortly.');
        throw new LibraryError(502,'The library could not complete this request.');
      }
      // Bound remote JSON before parsing; never relay upstream error bodies or credentials.
      const reader=response.body?.getReader();if(!reader)throw new Error('Missing library response');
      const chunks:Uint8Array[]=[];let bytes=0;
      try {for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>2*1024*1024)throw new Error('Library response too large');chunks.push(part.value);}}
      finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch(error) {
      if(error instanceof LibraryError)throw error;
      throw new LibraryError(502,'The library is temporarily unavailable. Please try again.');
    }
  }
  private validate<T>(schema:z.ZodType<T>,value:unknown):T {
    const parsed=schema.safeParse(value);if(!parsed.success)throw new LibraryError(502,'The library returned an unexpected response.');return parsed.data;
  }
  async groups(signal?:AbortSignal):Promise<LibraryGroup[]> {return this.validate(z.array(group),await this.request('/v1/groups','GET',undefined,signal));}
  async documents(input:unknown={},signal?:AbortSignal):Promise<LibraryDocument[]> {
    const args=libraryDocumentsInput.parse(input),params=new URLSearchParams({limit:String(args.limit)});
    if(args.group)params.set('group',args.group);
    return this.validate(z.array(document),await this.request(`/v1/documents?${params}`,'GET',undefined,signal));
  }
  async search(input:unknown,signal?:AbortSignal):Promise<LibrarySearch> {
    return this.validate(search,await this.request('/v1/search','POST',librarySearchInput.parse(input),signal));
  }
  async signedLink(documentId:string,signal?:AbortSignal):Promise<LibraryLink> {
    const id=libraryDocumentId.parse(documentId);
    const result=this.validate(link,await this.request(`/v1/documents/${id}/signed-link?expires_in=3600`,'POST',{},signal));
    const url=new URL(result.url);
    if(result.document_id!==id||url.protocol!=='https:'||url.username||url.password||
      ![new URL(this.base).origin,'https://fjmfziotgloxkiubldip.supabase.co'].includes(url.origin))
      throw new LibraryError(502,'The library returned an invalid download link.');
    return {...result,url:url.href};
  }
}
