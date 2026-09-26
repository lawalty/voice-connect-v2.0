import type { FastifyInstance } from 'fastify';
import { LibraryClient, LibraryError, libraryDocumentId, libraryDocumentsInput, librarySearchInput } from './library.js';

/** Registered under the service's existing session, exact-origin, and CSRF hooks. */
export function registerLibraryRoutes(app:FastifyInstance, library:LibraryClient) {
  const run=async<T>(reply:{code:(code:number)=>any},action:()=>Promise<T>)=>{
    try{return await action();}catch(error){if(error instanceof LibraryError)return reply.code(error.statusCode).send({error:error.message});throw error;}
  };
  app.get('/api/library/status',async()=>({configured:library.configured}));
  app.get('/api/library/groups',async(_req,reply)=>run(reply,()=>library.groups()));
  app.get('/api/library/documents',async(req,reply)=>run(reply,()=>library.documents(libraryDocumentsInput.parse(req.query))));
  app.post('/api/library/search',{config:{rateLimit:{max:30,timeWindow:60000}}},async(req,reply)=>run(reply,()=>library.search(librarySearchInput.parse(req.body))));
  app.post<{Params:{id:string}}>('/api/library/documents/:id/signed-link',async(req,reply)=>run(reply,()=>library.signedLink(libraryDocumentId.parse(req.params.id))));
}
