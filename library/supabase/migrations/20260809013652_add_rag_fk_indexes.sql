-- Cover foreign-key columns used for referential checks and cascading deletes.

create index if not exists rag_documents_group_id_idx
  on public.rag_documents(group_id);

create index if not exists rag_jobs_document_id_idx
  on public.rag_ingestion_jobs(document_id);

create index if not exists rag_chunks_group_id_idx
  on public.rag_chunks(group_id);
