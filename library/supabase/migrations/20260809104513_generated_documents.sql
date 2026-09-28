-- Canonical Markdown documents authored by Hermes. Uploaded originals remain
-- Storage-backed; generated PDFs are derived views and are never persisted.

alter table public.rag_groups
  add column if not exists system_key text;

create unique index if not exists rag_groups_owner_system_key_uidx
  on public.rag_groups(owner_id, system_key)
  where system_key is not null;

alter table public.rag_documents
  add column if not exists document_kind text not null default 'upload',
  add column if not exists title text,
  add column if not exists generated_title_key text,
  add column if not exists body_markdown text,
  add column if not exists revision integer not null default 1;

alter table public.rag_documents alter column storage_bucket drop not null;
alter table public.rag_documents alter column storage_path drop not null;
alter table public.rag_documents drop constraint if exists rag_documents_source_check;
alter table public.rag_documents drop constraint if exists rag_documents_owner_id_group_id_sha256_key;
alter table public.rag_documents drop constraint if exists rag_documents_generated_shape_check;

alter table public.rag_documents
  add constraint rag_documents_source_check
    check (source in ('portal', 'hermes', 'email', 'api', 'hermes_generated')),
  add constraint rag_documents_kind_check
    check (document_kind in ('upload', 'generated')),
  add constraint rag_documents_revision_check
    check (revision >= 1),
  add constraint rag_documents_generated_shape_check
    check (
      (
        document_kind = 'upload'
        and storage_bucket is not null
        and storage_path is not null
        and body_markdown is null
        and generated_title_key is null
        and source <> 'hermes_generated'
      )
      or
      (
        document_kind = 'generated'
        and storage_bucket is null
        and storage_path is null
        and source = 'hermes_generated'
        and title is not null
        and char_length(title) between 1 and 120
        and generated_title_key is not null
        -- Unicode case-folding can expand a 120-character display title.
        and char_length(generated_title_key) between 1 and 512
        and body_markdown is not null
        and char_length(body_markdown) between 1 and 200000
      )
    );

create unique index if not exists rag_documents_upload_sha_uidx
  on public.rag_documents(owner_id, group_id, sha256)
  where document_kind = 'upload';

create unique index if not exists rag_documents_generated_title_uidx
  on public.rag_documents(owner_id, group_id, generated_title_key)
  where document_kind = 'generated';

alter table public.rag_ingestion_jobs
  add column if not exists document_revision integer not null default 1
  check (document_revision >= 1);

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
  p_source_metadata jsonb
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
begin
  if not exists (
    select 1 from public.rag_groups
    where id = p_group_id and owner_id = p_owner_id
  ) then
    raise exception 'group does not belong to owner';
  end if;

  insert into public.rag_documents (
    id, owner_id, group_id, filename, mime_type, storage_bucket, storage_path,
    size_bytes, sha256, source, source_metadata, document_kind, revision
  ) values (
    p_document_id, p_owner_id, p_group_id, p_filename, p_mime_type,
    p_storage_bucket, p_storage_path, p_size_bytes, p_sha256, p_source,
    coalesce(p_source_metadata, '{}'::jsonb), 'upload', 1
  )
  on conflict (owner_id, group_id, sha256) where document_kind = 'upload'
  do nothing
  returning id, status into v_document_id, v_status;

  if v_document_id is null then
    select d.id, d.status into v_document_id, v_status
    from public.rag_documents d
    where d.owner_id = p_owner_id
      and d.group_id = p_group_id
      and d.sha256 = p_sha256
      and d.document_kind = 'upload';
    select j.id into v_job_id
    from public.rag_ingestion_jobs j
    where j.owner_id = p_owner_id and j.document_id = v_document_id
    order by j.created_at desc limit 1;
    return query select v_document_id, v_job_id, true, v_status;
    return;
  end if;

  insert into public.rag_ingestion_jobs(id, owner_id, document_id, document_revision)
  values (p_job_id, p_owner_id, v_document_id, 1)
  returning id into v_job_id;
  return query select v_document_id, v_job_id, false, v_status;
end;
$$;

create or replace function public.rag_ensure_system_group(
  p_owner_id uuid,
  p_name text,
  p_slug text,
  p_description text,
  p_system_key text,
  p_routing_embedding text
)
returns setof public.rag_groups
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_system_key is null or btrim(p_system_key) = '' then
    raise exception 'system key is required';
  end if;
  if exists (
    select 1 from public.rag_groups
    where owner_id = p_owner_id
      and system_key is distinct from p_system_key
      and (lower(name) = lower(p_name) or slug = p_slug)
  ) then
    raise exception 'reserved system group name is already occupied';
  end if;

  insert into public.rag_groups(
    owner_id, name, slug, aliases, description, system_key, routing_embedding
  ) values (
    p_owner_id, p_name, p_slug, '{}', coalesce(p_description, ''),
    p_system_key, p_routing_embedding::extensions.vector
  )
  on conflict (owner_id, system_key) where system_key is not null
  do update set
    name = excluded.name,
    slug = excluded.slug,
    description = excluded.description,
    routing_embedding = excluded.routing_embedding;

  return query
    select * from public.rag_groups
    where owner_id = p_owner_id and system_key = p_system_key;
end;
$$;

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
    title, generated_title_key, body_markdown, revision
  ) values (
    p_document_id, p_owner_id, p_group_id, p_filename, 'text/markdown', null, null,
    p_size_bytes, p_sha256, 'pending', 'hermes_generated',
    coalesce(p_source_metadata, '{}'::jsonb), 'generated', p_title,
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
  where d.id = p_document_id
    and d.owner_id = p_owner_id
    and d.document_kind = 'generated'
    and d.source = 'hermes_generated'
  for update;
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
  delete from public.rag_documents
  where id = p_document_id
    and owner_id = p_owner_id
    and document_kind = 'generated'
    and source = 'hermes_generated'
  returning id into v_deleted;
  return v_deleted is not null;
end;
$$;

create or replace function public.rag_replace_document_chunks(
  p_owner_id uuid,
  p_document_id uuid,
  p_document_revision integer,
  p_chunks jsonb
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_group_id uuid;
  v_inserted integer;
begin
  select group_id into v_group_id
  from public.rag_documents
  where id = p_document_id
    and owner_id = p_owner_id
    and revision = p_document_revision
  for update;
  if v_group_id is null then
    raise exception 'document revision changed before chunks were committed';
  end if;
  if jsonb_typeof(p_chunks) <> 'array' or jsonb_array_length(p_chunks) = 0 then
    raise exception 'chunks must be a non-empty JSON array';
  end if;

  delete from public.rag_chunks
  where owner_id = p_owner_id and document_id = p_document_id;

  insert into public.rag_chunks(
    owner_id, document_id, group_id, chunk_index, content, word_count,
    embedding, metadata
  )
  select
    p_owner_id,
    p_document_id,
    v_group_id,
    (item->>'chunk_index')::integer,
    item->>'content',
    (item->>'word_count')::integer,
    (item->>'embedding')::extensions.vector,
    coalesce(item->'metadata', '{}'::jsonb)
  from jsonb_array_elements(p_chunks) item;
  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

revoke all on function public.rag_ensure_system_group(uuid, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.rag_create_generated_document(uuid, uuid, uuid, uuid, text, text, text, text, bigint, text, jsonb) from public, anon, authenticated;
revoke all on function public.rag_update_generated_document(uuid, uuid, uuid, text, text, text, text, bigint, text) from public, anon, authenticated;
revoke all on function public.rag_delete_generated_document(uuid, uuid) from public, anon, authenticated;
revoke all on function public.rag_replace_document_chunks(uuid, uuid, integer, jsonb) from public, anon, authenticated;

grant execute on function public.rag_ensure_system_group(uuid, text, text, text, text, text) to service_role;
grant execute on function public.rag_create_generated_document(uuid, uuid, uuid, uuid, text, text, text, text, bigint, text, jsonb) to service_role;
grant execute on function public.rag_update_generated_document(uuid, uuid, uuid, text, text, text, text, bigint, text) to service_role;
grant execute on function public.rag_delete_generated_document(uuid, uuid) to service_role;
grant execute on function public.rag_replace_document_chunks(uuid, uuid, integer, jsonb) to service_role;
