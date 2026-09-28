-- Requeue an uploaded document whose prior parsing or embedding job failed.
-- The original Storage object and stable document ID are preserved.

create or replace function public.rag_retry_failed_document(
  p_owner_id uuid,
  p_document_id uuid,
  p_job_id uuid
)
returns table(job_id uuid, retried boolean, document_status text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
  v_kind text;
  v_revision integer;
  v_job_id uuid;
begin
  select d.status, d.document_kind, d.revision
    into v_status, v_kind, v_revision
  from public.rag_documents d
  where d.id = p_document_id and d.owner_id = p_owner_id
  for update;

  if not found then
    raise exception 'document does not belong to owner';
  end if;
  if v_kind <> 'upload' then
    raise exception 'only uploaded documents can be retried';
  end if;

  if v_status = 'failed' then
    update public.rag_documents
    set status = 'pending', error = null
    where id = p_document_id and owner_id = p_owner_id;

    insert into public.rag_ingestion_jobs(
      id, owner_id, document_id, document_revision
    ) values (
      p_job_id, p_owner_id, p_document_id, v_revision
    )
    returning id into v_job_id;

    return query select v_job_id, true, 'queued'::text;
    return;
  end if;

  select j.id into v_job_id
  from public.rag_ingestion_jobs j
  where j.owner_id = p_owner_id and j.document_id = p_document_id
  order by j.created_at desc
  limit 1;

  return query select v_job_id, false, v_status;
end;
$$;

revoke all on function public.rag_retry_failed_document(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.rag_retry_failed_document(uuid, uuid, uuid)
  to service_role;
