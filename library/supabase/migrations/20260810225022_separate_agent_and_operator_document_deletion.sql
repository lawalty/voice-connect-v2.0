-- Separate the human operator's library-management authority from Hermes's
-- deliberately narrow authority over documents it authored. Provenance is a
-- server-maintained column and cannot be changed after insertion.

set lock_timeout = '10s';
set statement_timeout = '2min';

alter table public.rag_documents
  add column if not exists created_by_agent boolean not null default false;

update public.rag_documents d
set created_by_agent = true
from public.rag_groups g
where d.group_id = g.id
  and d.owner_id = g.owner_id
  and d.document_kind = 'generated'
  and d.source = 'hermes_generated'
  and g.system_key = 'hermes-generated-documents';

alter table public.rag_documents
  drop constraint if exists rag_documents_agent_provenance_check;

alter table public.rag_documents
  add constraint rag_documents_agent_provenance_check
  check (
    (document_kind = 'upload' and created_by_agent = false)
    or
    (document_kind = 'generated' and created_by_agent = true)
  ) not valid;

alter table public.rag_documents
  validate constraint rag_documents_agent_provenance_check;

create or replace function public.rag_protect_document_provenance()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.created_by_agent is distinct from old.created_by_agent then
    raise exception 'document provenance is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists rag_documents_provenance_immutable on public.rag_documents;
create trigger rag_documents_provenance_immutable
before update of created_by_agent on public.rag_documents
for each row execute function public.rag_protect_document_provenance();

create or replace function public.rag_create_generated_document(
  p_document_id uuid,
  p_job_id uuid,
  p_owner_id uuid,
  p_group_id uuid,
  p_title text,
  p_title_key text,
  p_filename text,
  p_body_markdown text,
  p_size_bytes bigint,
  p_sha256 text,
  p_source_metadata jsonb
)
returns table(document_id uuid, job_id uuid, revision integer, document_status text)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.rag_groups
    where id = p_group_id
      and owner_id = p_owner_id
      and system_key = 'hermes-generated-documents'
  ) then
    raise exception 'generated documents require the reserved Generated Docs group';
  end if;
  if exists (
    select 1 from public.rag_documents
    where owner_id = p_owner_id
      and group_id = p_group_id
      and document_kind = 'generated'
      and generated_title_key = p_title_key
  ) then
    raise exception 'a generated document with that title already exists; revise it instead';
  end if;

  insert into public.rag_documents(
    id, owner_id, group_id, filename, mime_type, storage_bucket, storage_path,
    size_bytes, sha256, status, source, source_metadata, document_kind,
    created_by_agent, title, generated_title_key, body_markdown, revision
  ) values (
    p_document_id, p_owner_id, p_group_id, p_filename, 'text/markdown', null, null,
    p_size_bytes, p_sha256, 'pending', 'hermes_generated',
    coalesce(p_source_metadata, '{}'::jsonb), 'generated', true, p_title,
    p_title_key, p_body_markdown, 1
  );
  insert into public.rag_ingestion_jobs(
    id, owner_id, document_id, document_revision
  ) values (p_job_id, p_owner_id, p_document_id, 1);

  return query select p_document_id, p_job_id, 1, 'pending'::text;
end;
$$;

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
    and d.document_kind = 'generated'
    and d.source = 'hermes_generated'
    and d.created_by_agent = true
    and g.system_key = 'hermes-generated-documents'
  for update of d;
  if v_revision is null then
    raise exception 'generated document not found or is not editable';
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

  update public.rag_ingestion_jobs
  set status = 'failed', error = 'Superseded by a newer document revision', completed_at = now()
  where owner_id = p_owner_id
    and document_id = p_document_id
    and status in ('queued', 'processing');

  v_revision := v_revision + 1;
  update public.rag_documents
  set title = p_title,
      generated_title_key = p_title_key,
      filename = p_filename,
      body_markdown = p_body_markdown,
      size_bytes = p_size_bytes,
      sha256 = p_sha256,
      revision = v_revision,
      status = 'pending',
      error = null
  where id = p_document_id and owner_id = p_owner_id;

  insert into public.rag_ingestion_jobs(
    id, owner_id, document_id, document_revision
  ) values (p_job_id, p_owner_id, p_document_id, v_revision);

  return query select p_document_id, p_job_id, v_revision, 'pending'::text;
end;
$$;

create or replace function public.rag_delete_generated_document(
  p_owner_id uuid,
  p_document_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_deleted uuid;
begin
  delete from public.rag_documents d
  using public.rag_groups g
  where d.id = p_document_id
    and d.owner_id = p_owner_id
    and d.document_kind = 'generated'
    and d.source = 'hermes_generated'
    and d.created_by_agent = true
    and g.id = d.group_id
    and g.owner_id = d.owner_id
    and g.system_key = 'hermes-generated-documents'
  returning d.id into v_deleted;
  return v_deleted is not null;
end;
$$;

create or replace function public.rag_delete_document_as_operator(
  p_owner_id uuid,
  p_document_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_deleted uuid;
begin
  delete from public.rag_documents
  where id = p_document_id
    and owner_id = p_owner_id
  returning id into v_deleted;
  return v_deleted is not null;
end;
$$;

revoke all on function public.rag_protect_document_provenance() from public, anon, authenticated;
revoke all on function public.rag_delete_document_as_operator(uuid, uuid) from public, anon, authenticated;
revoke all on function public.rag_delete_generated_document(uuid, uuid) from public, anon, authenticated;

grant execute on function public.rag_protect_document_provenance() to service_role;
grant execute on function public.rag_delete_document_as_operator(uuid, uuid) to service_role;
grant execute on function public.rag_delete_generated_document(uuid, uuid) to service_role;
