-- OUT parameters named document_id and revision are PL/pgSQL variables. Use
-- explicit table aliases in lifecycle mutations so PostgreSQL never has to
-- choose between an OUT variable and a table column.

set lock_timeout = '10s';
set statement_timeout = '2min';

create or replace function public.rag_update_generated_document(
  p_document_id uuid,
  p_job_id uuid,
  p_owner_id uuid,
  p_title text,
  p_title_key text,
  p_filename text,
  p_body_markdown text,
  p_size_bytes bigint,
  p_sha256 text
)
returns table(document_id uuid, job_id uuid, revision integer, document_status text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_revision integer;
begin
  select d.revision into v_revision
  from public.rag_documents d
  join public.rag_groups g
    on g.id = d.group_id and g.owner_id = d.owner_id
  where d.id = p_document_id
    and d.owner_id = p_owner_id
    and d.created_by_agent = true
    and g.system_key = 'hermes-generated-documents'
  for update of d;
  if v_revision is null then
    raise exception 'agent-managed document not found or is not editable';
  end if;
  if exists (
    select 1 from public.rag_documents d
    where d.owner_id = p_owner_id
      and d.document_kind = 'generated'
      and d.generated_title_key = p_title_key
      and d.id <> p_document_id
  ) then
    raise exception 'a generated document with that title already exists';
  end if;

  update public.rag_ingestion_jobs as j
  set status = 'failed',
      error = 'Superseded by a newer document revision',
      completed_at = now()
  where j.owner_id = p_owner_id
    and j.document_id = p_document_id
    and j.status in ('queued', 'processing');

  v_revision := v_revision + 1;
  update public.rag_documents as d
  set title = p_title,
      generated_title_key = p_title_key,
      filename = p_filename,
      mime_type = 'text/markdown',
      storage_bucket = null,
      storage_path = null,
      body_markdown = p_body_markdown,
      document_kind = 'generated',
      source = 'hermes_generated',
      size_bytes = p_size_bytes,
      sha256 = p_sha256,
      revision = v_revision,
      status = 'pending',
      error = null
  where d.id = p_document_id and d.owner_id = p_owner_id;

  insert into public.rag_ingestion_jobs(
    id, owner_id, document_id, document_revision
  ) values (p_job_id, p_owner_id, p_document_id, v_revision);

  return query select p_document_id, p_job_id, v_revision, 'pending'::text;
end;
$$;

create or replace function public.rag_replace_agent_document_file(
  p_document_id uuid,
  p_job_id uuid,
  p_owner_id uuid,
  p_filename text,
  p_mime_type text,
  p_storage_bucket text,
  p_storage_path text,
  p_size_bytes bigint,
  p_sha256 text,
  p_source_metadata jsonb
)
returns table(document_id uuid, job_id uuid, revision integer, document_status text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_revision integer;
begin
  select d.revision into v_revision
  from public.rag_documents d
  join public.rag_groups g
    on g.id = d.group_id and g.owner_id = d.owner_id
  where d.id = p_document_id
    and d.owner_id = p_owner_id
    and d.created_by_agent = true
    and g.system_key = 'hermes-generated-documents'
  for update of d;
  if v_revision is null then
    raise exception 'agent-managed document not found or is not replaceable';
  end if;

  update public.rag_ingestion_jobs as j
  set status = 'failed',
      error = 'Superseded by a newer document revision',
      completed_at = now()
  where j.owner_id = p_owner_id
    and j.document_id = p_document_id
    and j.status in ('queued', 'processing');

  v_revision := v_revision + 1;
  update public.rag_documents as d
  set filename = p_filename,
      mime_type = p_mime_type,
      storage_bucket = p_storage_bucket,
      storage_path = p_storage_path,
      size_bytes = p_size_bytes,
      sha256 = p_sha256,
      source = 'hermes',
      source_metadata = coalesce(p_source_metadata, '{}'::jsonb),
      document_kind = 'upload',
      title = regexp_replace(p_filename, '\.[^.]+$', ''),
      generated_title_key = null,
      body_markdown = null,
      revision = v_revision,
      status = 'pending',
      error = null
  where d.id = p_document_id and d.owner_id = p_owner_id;

  insert into public.rag_ingestion_jobs(
    id, owner_id, document_id, document_revision
  ) values (p_job_id, p_owner_id, p_document_id, v_revision);

  return query select p_document_id, p_job_id, v_revision, 'pending'::text;
end;
$$;

revoke all on function public.rag_update_generated_document(
  uuid, uuid, uuid, text, text, text, text, bigint, text
) from public, anon, authenticated;
revoke all on function public.rag_replace_agent_document_file(
  uuid, uuid, uuid, text, text, text, text, bigint, text, jsonb
) from public, anon, authenticated;

grant execute on function public.rag_update_generated_document(
  uuid, uuid, uuid, text, text, text, text, bigint, text
) to service_role;
grant execute on function public.rag_replace_agent_document_file(
  uuid, uuid, uuid, text, text, text, text, bigint, text, jsonb
) to service_role;
