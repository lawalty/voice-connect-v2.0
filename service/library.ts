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
const search = z.object({query:z.string(),routing_reason:z.string(),ambiguous_group:z.boolean(),searched_groups:z.array(group.omit({description:true}).extend({score:z.number()})),hits:z.array(z.object({chunk_id:z.string().uuid(),document_id:z.string().uuid(),group_name:z.string(),group_slug:z.string(),filename:z.string(),chunk_index:z.number().int(),content:z.string(),score:z.number(),metadata:z.object({document_kind:z.string().optional(),title:z.string().optional(),revision:z.number().int().optional(),heading_path:z.array(z.string()).optional()}).optional()}))});
const link = z.object({document_id:z.string().uuid(),filename:z.string(),url:z.string().url(),expires_in:z.number().int()});
const generated = z.object({id:z.string().uuid(),title:z.string().nullable().optional(),filename:z.string().optional(),mime_type:z.string().optional(),document_kind:z.enum(['upload','generated']).optional(),revision:z.number().int().positive(),status:z.enum(['pending','processing','ready','failed']),chunk_count:z.number().int().nonnegative(),source_metadata:z.object({vc_download_offers:z.record(z.string(),z.string().uuid()).optional()}).optional()});
const offered = z.object({document_id:z.string().uuid(),title:z.string(),filename:z.string(),status:z.literal('ready'),url:z.string().url(),requires_sign_in:z.literal(true),offered_in_conversation:z.boolean(),offer_id:z.string().uuid().nullable()});
const accepted = z.object({document_id:z.string().uuid(),job_id:z.string().uuid(),title:z.string(),status:z.string(),revision:z.number().int().positive()});
const source = z.object({id:z.string().uuid(),title:z.string(),body_markdown:z.string(),revision:z.number().int().positive(),status:z.string()});
export const generatedWriteInput = z.object({title:z.string().trim().min(1).max(120),markdown:z.string().trim().min(1).max(200000)}).strict();
export const generatedRevisionInput = generatedWriteInput.partial({title:true}).extend({document_id:libraryDocumentId}).strict();
export const generatedReadInput = z.object({document_id:libraryDocumentId.optional(),title:z.string().trim().min(1).max(120).optional()}).strict().refine(v=>Boolean(v.document_id)!==Boolean(v.title),'Use either a document ID or title.');

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
        if(response.status===409||response.status===400)throw new LibraryError(409,path.endsWith('/offer-download')?'This document is not ready to offer or changed during the request. Check its Library status and retry.':'The document request conflicts with an existing title or is ambiguous. List the generated documents, resolve the exact ID, and read its source before revising.');
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
  async generatedDocuments(conversationId:string,signal?:AbortSignal) {
    const id=libraryDocumentId.parse(conversationId);
    const documents=this.validate(z.array(generated),await this.request(`/v1/documents?conversation_id=${id}&limit=200`,'GET',undefined,signal));
    return documents.map(({source_metadata,document_kind,filename,mime_type,title,...item})=>({
      ...item,title:title||filename||'Document',
      filename:document_kind==='upload'?filename:`${(title||filename||'Document').replace(/[\\/:*?"<>|]/g,'_')}.pdf`,
      mime_type:document_kind==='upload'?mime_type:'application/pdf',
      offer_id:source_metadata?.vc_download_offers?.[id],
    }));
  }
  async offerDownload(documentId:string,conversationId?:string,signal?:AbortSignal) {
    const id=libraryDocumentId.parse(documentId);
    const result=this.validate(offered,await this.request(`/v1/documents/${id}/offer-download`,'POST',conversationId?{conversation_id:libraryDocumentId.parse(conversationId)}:{},signal));
    if(result.document_id!==id||result.url!==`${this.base}/api/library/documents/${id}/download`||result.offered_in_conversation!==Boolean(conversationId))
      throw new LibraryError(502,'The library returned an invalid download offer.');
    return result;
  }
  async writeDocument(input:unknown,conversationId?:string,signal?:AbortSignal) {
    const args=generatedWriteInput.parse(input);
    return this.validate(accepted,await this.request('/v1/generated-documents','POST',{...args,...conversationId?{conversation_id:libraryDocumentId.parse(conversationId)}:{}},signal));
  }
  async readDocument(input:unknown,signal?:AbortSignal) {
    const args=generatedReadInput.parse(input);
    const id=args.document_id??this.validate(z.object({id:libraryDocumentId}),await this.request(`/v1/generated-documents/resolve?title=${encodeURIComponent(args.title!)}`,'GET',undefined,signal)).id;
    return this.validate(source,await this.request(`/v1/generated-documents/${id}/source`,'GET',undefined,signal));
  }
  async reviseDocument(input:unknown,conversationId?:string,signal?:AbortSignal) {
    const {document_id,...args}=generatedRevisionInput.parse(input);
    return this.validate(accepted,await this.request(`/v1/generated-documents/${document_id}`,'PUT',{...args,...conversationId?{conversation_id:libraryDocumentId.parse(conversationId)}:{}},signal));
  }
  async downloadDocument(documentId:string,signal?:AbortSignal):Promise<{payload:Buffer;filename:string;contentType:string}> {
    const id=libraryDocumentId.parse(documentId);
    if(!this.configured)throw new LibraryError(503,'The library connection has not been configured.');
    try {
      const timeout=AbortSignal.timeout(30000);
      const response=await this.fetcher(`${this.base}/v1/documents/${id}/download`,{headers:{'X-RAG-Token':this.token},redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout});
      const contentType=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
      const types=['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain','text/markdown','text/x-markdown','text/html','application/xhtml+xml','application/octet-stream'];
      if(!response.ok||!types.includes(contentType)){
        await response.body?.cancel();throw new LibraryError(response.status===404?404:response.status===400?409:502,'This document could not be downloaded. It may be unavailable or still indexing.');
      }
      const encoded=/^attachment; filename\*=UTF-8''([^\r\n]+)$/i.exec(response.headers.get('content-disposition')||'')?.[1];
      const filename=encoded?decodeURIComponent(encoded):'';
      if(!filename||/[\\/\x00-\x1f\x7f]/.test(filename)) {await response.body?.cancel();throw new Error('Invalid filename');}
      const reader=response.body?.getReader();if(!reader)throw new Error('Empty document');
      const chunks:Uint8Array[]=[];let bytes=0;
      try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>50*1024*1024)throw new Error('Document too large');chunks.push(part.value);}}
      finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      const payload=Buffer.concat(chunks);if(contentType==='application/pdf'&&payload.subarray(0,5).toString()!=='%PDF-')throw new Error('Invalid PDF');
      return {payload,filename,contentType};
    }catch(error){if(error instanceof LibraryError)throw error;throw new LibraryError(502,'This document could not be downloaded. Please try again.');}
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
