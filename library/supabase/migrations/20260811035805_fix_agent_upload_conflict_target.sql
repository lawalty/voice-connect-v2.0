-- The upload de-duplication index is partial (document_kind = 'upload').
-- PostgreSQL requires the ON CONFLICT target to carry the same predicate so
-- it can infer that index. Keep trusted agent provenance independent from the
-- artifact's upload storage shape.

set lock_timeout = '10s';
set statement_timeout = '2min';

create or replace function public.rag_create_document_job(
  p_document_id uuid,
  p_job_id uuid,
  p_owner_id uuid,
  p_group_id uuid,
  p_filename text,
  p_mime_type text,
  p_storage_bucket text,
  p_storage_path text,
  p_size_bytes bigint,
  p_sha256 text,
  p_source text,
  p_source_metadata jsonb,
  p_created_by_agent boolean
)
returns table(document_id uuid, job_id uuid, duplicate boolean, document_status text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_document_id uuid;
  v_job_id uuid;
  v_status text;
  v_existing_created_by_agent boolean;
  v_group_system_key text;
begin
  select g.system_key into v_group_system_key
  from public.rag_groups g
  where g.id = p_group_id and g.owner_id = p_owner_id;
  if not found then
    raise exception 'group does not belong to owner';
  end if;
  if coalesce(p_created_by_agent, false)
     and v_group_system_key is distinct from 'hermes-generated-documents' then
    raise exception 'agent-managed documents require the reserved Generated Docs group';
  end if;

  insert into public.rag_documents (
    id, owner_id, group_id, filename, mime_type, storage_bucket, storage_path,
    size_bytes, sha256, source, source_metadata, document_kind,
    created_by_agent
  ) values (
    p_document_id, p_owner_id, p_group_id, p_filename, p_mime_type,
    p_storage_bucket, p_storage_path, p_size_bytes, p_sha256, p_source,
    coalesce(p_source_metadata, '{}'::jsonb), 'upload',
    coalesce(p_created_by_agent, false)
  )
  on conflict (owner_id, group_id, sha256) where document_kind = 'upload'
  do nothing
  returning id, status into v_document_id, v_status;

  if v_document_id is null then
    select d.id, d.status, d.created_by_agent
      into v_document_id, v_status, v_existing_created_by_agent
    from public.rag_documents d
    where d.owner_id = p_owner_id
      and d.group_id = p_group_id
      and d.sha256 = p_sha256
      and d.document_kind = 'upload';
    if coalesce(p_created_by_agent, false)
       and not coalesce(v_existing_created_by_agent, false) then
      raise exception 'an identical protected document already exists and cannot be claimed by the agent';
    end if;
    select j.id into v_job_id
    from public.rag_ingestion_jobs j
    where j.owner_id = p_owner_id and j.document_id = v_document_id
    order by j.created_at desc limit 1;
    return query select v_document_id, v_job_id, true, v_status;
    return;
  end if;

  insert into public.rag_ingestion_jobs(id, owner_id, document_id)
  values (p_job_id, p_owner_id, v_document_id)
  returning id into v_job_id;
  return query select v_document_id, v_job_id, false, v_status;
end;
$$;

revoke all on function public.rag_create_document_job(
  uuid, uuid, uuid, uuid, text, text, text, text, bigint, text, text, jsonb, boolean
) from public, anon, authenticated;

grant execute on function public.rag_create_document_job(
  uuid, uuid, uuid, uuid, text, text, text, text, bigint, text, text, jsonb, boolean
) to service_role;
