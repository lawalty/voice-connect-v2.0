import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from './store.js';
import { LibraryClient, LibraryError, libraryDocumentId, libraryDocumentsInput, librarySearchInput } from './library.js';

/** Registered under the service's existing session, exact-origin, and CSRF hooks. */
export function registerLibraryRoutes(app:FastifyInstance, library:LibraryClient, store:Store) {
  const run=async<T>(reply:{code:(code:number)=>any},action:()=>Promise<T>)=>{
    try{return await action();}catch(error){if(error instanceof LibraryError)return reply.code(error.statusCode).send({error:error.message});throw error;}
  };
  app.get('/api/library/status',async()=>({configured:library.configured}));
  app.get('/api/library/generated',async(req,reply)=>{
    const {conversation_id}=z.object({conversation_id:libraryDocumentId}).strict().parse(req.query);
    if(!store.conversation(conversation_id))return reply.code(404).send({error:'Conversation not found.'});
    return run(reply,()=>library.generatedDocuments(conversation_id));
  });
  app.get<{Params:{id:string}}>('/api/library/documents/:id/download',{config:{rateLimit:{max:20,timeWindow:60000}}},async(req,reply)=>run(reply,async()=>{
    const id=libraryDocumentId.parse(req.params.id);
    const source=await library.readDocument({document_id:id});
    if(source.status!=='ready')throw new LibraryError(409,'This document is still being indexed. Please try again shortly.');
    const payload=await library.downloadPdf(id);
    const filename=`${source.title.replace(/[^a-zA-Z0-9._ -]/g,'_').trim().slice(0,100)||'Document'}.pdf`;
    return reply.header('Content-Type','application/pdf').header('Content-Disposition',`attachment; filename="${filename}"`).send(payload);
  }));
  app.get('/api/library/groups',async(_req,reply)=>run(reply,()=>library.groups()));
  app.get('/api/library/documents',async(req,reply)=>run(reply,()=>library.documents(libraryDocumentsInput.parse(req.query))));
  app.post('/api/library/search',{config:{rateLimit:{max:30,timeWindow:60000}}},async(req,reply)=>run(reply,()=>library.search(librarySearchInput.parse(req.body))));
  app.post<{Params:{id:string}}>('/api/library/documents/:id/signed-link',async(req,reply)=>run(reply,()=>library.signedLink(libraryDocumentId.parse(req.params.id))));
}
