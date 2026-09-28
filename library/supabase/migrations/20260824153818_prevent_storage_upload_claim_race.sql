-- Upload metadata and its ingestion job are committed before the separate
-- Storage request completes. Do not let the worker claim an upload-shaped
-- document until the exact private object is visible in storage.objects.

set lock_timeout = '10s';
set statement_timeout = '2min';

create or replace function public.rag_claim_next_job(p_owner_id uuid)
returns setof public.rag_ingestion_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job_id uuid;
begin
  select j.id into v_job_id
  from public.rag_ingestion_jobs j
  join public.rag_documents d
    on d.id = j.document_id
   and d.owner_id = j.owner_id
  where j.owner_id = p_owner_id
    and j.status = 'queued'
    and d.status = 'pending'
    and (
      d.document_kind = 'generated'
      or (
        d.storage_bucket is not null
        and d.storage_path is not null
        and exists (
          select 1
          from storage.objects o
          where o.bucket_id = d.storage_bucket
            and o.name = d.storage_path
        )
      )
    )
  order by j.created_at
  for update of j skip locked
  limit 1;

  if v_job_id is null then
    return;
  end if;

  return query
  update public.rag_ingestion_jobs as j
  set status = 'processing', started_at = now(), attempts = attempts + 1
  where j.id = v_job_id and j.owner_id = p_owner_id
  returning j.*;
end;
$$;

revoke all on function public.rag_claim_next_job(uuid)
from public, anon, authenticated;

grant execute on function public.rag_claim_next_job(uuid) to service_role;
