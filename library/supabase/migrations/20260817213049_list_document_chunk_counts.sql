-- Return compact per-document chunk counts for the owner-scoped management
-- portal without transferring every chunk row through the Data API.

create or replace function public.rag_list_document_chunk_counts(
  p_owner_id uuid,
  p_document_ids uuid[]
)
returns table(document_id uuid, chunk_count bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select c.document_id, count(*)::bigint as chunk_count
  from public.rag_chunks as c
  join public.rag_documents as d
    on d.id = c.document_id
   and d.owner_id = p_owner_id
  where c.owner_id = p_owner_id
    and c.document_id = any(p_document_ids)
  group by c.document_id;
$$;

revoke all on function public.rag_list_document_chunk_counts(uuid, uuid[])
  from public, anon, authenticated;
grant execute on function public.rag_list_document_chunk_counts(uuid, uuid[])
  to service_role;
