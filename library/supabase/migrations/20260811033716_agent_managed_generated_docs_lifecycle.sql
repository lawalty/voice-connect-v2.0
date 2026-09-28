-- Make trusted agent provenance independent from the artifact's storage form.
-- A Hermes-created PDF/file remains agent-manageable when it is stored as an
-- upload, while human/operator uploads remain protected.

set lock_timeout = '10s';
set statement_timeout = '2min';

alter table public.rag_documents
  add column if not exists archived_at timestamptz;

drop trigger if exists rag_documents_provenance_immutable on public.rag_documents;

alter table public.rag_documents
  drop constraint if exists rag_documents_agent_provenance_check;

-- Repair artifacts that were demonstrably submitted by Hermes into its
-- reserved group before upload-shaped agent provenance was supported.
update public.rag_documents d
set created_by_agent = true
from public.rag_groups g
where d.group_id = g.id
  and d.owner_id = g.owner_id
  and d.source in ('hermes', 'hermes_generated')
  and g.system_key = 'hermes-generated-documents';

alter table public.rag_documents
  add constraint rag_documents_agent_provenance_check
  check (document_kind <> 'generated' or created_by_agent = true) not valid;

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

create trigger rag_documents_provenance_immutable
before update of created_by_agent on public.rag_documents
for each row execute function public.rag_protect_document_provenance();

drop function if exists public.rag_create_document_job(
  uuid, uuid, uuid, uuid, text, text, text, text, bigint, text, text, jsonb
);

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
  on conflict (owner_id, group_id, sha256) do nothing
  returning id, status into v_document_id, v_status;

  if v_document_id is null then
    select d.id, d.status, d.created_by_agent
      into v_document_id, v_status, v_existing_created_by_agent
    from public.rag_documents d
    where d.owner_id = p_owner_id
      and d.group_id = p_group_id
      and d.sha256 = p_sha256;
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
  where id = p_document_id and owner_id = p_owner_id;

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

  update public.rag_ingestion_jobs
  set status = 'failed', error = 'Superseded by a newer document revision', completed_at = now()
  where owner_id = p_owner_id
    and document_id = p_document_id
    and status in ('queued', 'processing');

  v_revision := v_revision + 1;
  update public.rag_documents
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
  where id = p_document_id and owner_id = p_owner_id;

  insert into public.rag_ingestion_jobs(
    id, owner_id, document_id, document_revision
  ) values (p_job_id, p_owner_id, p_document_id, v_revision);

  return query select p_document_id, p_job_id, v_revision, 'pending'::text;
end;
$$;

create or replace function public.rag_set_agent_document_archived(
  p_owner_id uuid,
  p_document_id uuid,
  p_archived boolean
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_updated uuid;
begin
  update public.rag_documents d
  set archived_at = case
    when coalesce(p_archived, true) then coalesce(d.archived_at, now())
    else null
  end
  where d.id = p_document_id
    and d.owner_id = p_owner_id
    and d.created_by_agent = true
    and exists (
      select 1 from public.rag_groups g
      where g.id = d.group_id
        and g.owner_id = d.owner_id
        and g.system_key = 'hermes-generated-documents'
    )
  returning d.id into v_updated;
  return v_updated is not null;
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
    and d.created_by_agent = true
    and g.id = d.group_id
    and g.owner_id = d.owner_id
    and g.system_key = 'hermes-generated-documents'
  returning d.id into v_deleted;
  return v_deleted is not null;
end;
$$;

create or replace function public.rag_hybrid_search(
  p_owner_id uuid,
  p_group_ids uuid[],
  p_query_text text,
  p_query_embedding text,
  p_match_count integer default 8,
  p_candidate_count integer default 64
)
returns table(
  chunk_id uuid,
  document_id uuid,
  group_id uuid,
  group_name text,
  group_slug text,
  filename text,
  chunk_index integer,
  content text,
  score double precision,
  semantic_similarity double precision,
  metadata jsonb
)
language sql
stable
security invoker
set search_path = ''
set hnsw.iterative_scan = 'strict_order'
as $$
  with semantic as (
    select c.id,
      row_number() over (order by c.embedding OPERATOR(extensions.<=>) p_query_embedding::extensions.vector) as semantic_rank,
      (1 - (c.embedding OPERATOR(extensions.<=>) p_query_embedding::extensions.vector))::double precision as similarity
    from public.rag_chunks c
    join public.rag_documents d on d.id = c.document_id
    where c.owner_id = p_owner_id
      and c.group_id = any(p_group_ids)
      and d.status = 'ready'
      and d.archived_at is null
    order by c.embedding OPERATOR(extensions.<=>) p_query_embedding::extensions.vector
    limit greatest(p_match_count, least(p_candidate_count, 200))
  ), keyword as (
    select c.id,
      row_number() over (
        order by ts_rank_cd(c.fts, websearch_to_tsquery('english', p_query_text)) desc
      ) as keyword_rank
    from public.rag_chunks c
    join public.rag_documents d on d.id = c.document_id
    where c.owner_id = p_owner_id
      and c.group_id = any(p_group_ids)
      and d.status = 'ready'
      and d.archived_at is null
      and c.fts @@ websearch_to_tsquery('english', p_query_text)
    order by ts_rank_cd(c.fts, websearch_to_tsquery('english', p_query_text)) desc
    limit greatest(p_match_count, least(p_candidate_count, 200))
  ), fused as (
    select coalesce(s.id, k.id) as id,
      coalesce(1.0 / (60 + s.semantic_rank), 0.0)
        + coalesce(1.0 / (60 + k.keyword_rank), 0.0) as fused_score,
      s.similarity
    from semantic s
    full outer join keyword k on k.id = s.id
  )
  select c.id, c.document_id, c.group_id, g.name, g.slug, d.filename,
    c.chunk_index, c.content, f.fused_score::double precision,
    f.similarity, c.metadata
  from fused f
  join public.rag_chunks c on c.id = f.id
  join public.rag_documents d on d.id = c.document_id
  join public.rag_groups g on g.id = c.group_id
  order by f.fused_score desc, c.document_id, c.chunk_index
  limit greatest(1, least(p_match_count, 20));
$$;

revoke all on function public.rag_protect_document_provenance() from public, anon, authenticated;
revoke all on function public.rag_create_document_job(uuid, uuid, uuid, uuid, text, text, text, text, bigint, text, text, jsonb, boolean) from public, anon, authenticated;
revoke all on function public.rag_update_generated_document(uuid, uuid, uuid, text, text, text, text, bigint, text) from public, anon, authenticated;
revoke all on function public.rag_replace_agent_document_file(uuid, uuid, uuid, text, text, text, text, bigint, text, jsonb) from public, anon, authenticated;
revoke all on function public.rag_set_agent_document_archived(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.rag_delete_generated_document(uuid, uuid) from public, anon, authenticated;
revoke all on function public.rag_hybrid_search(uuid, uuid[], text, text, integer, integer) from public, anon, authenticated;

grant execute on function public.rag_protect_document_provenance() to service_role;
grant execute on function public.rag_create_document_job(uuid, uuid, uuid, uuid, text, text, text, text, bigint, text, text, jsonb, boolean) to service_role;
grant execute on function public.rag_update_generated_document(uuid, uuid, uuid, text, text, text, text, bigint, text) to service_role;
grant execute on function public.rag_replace_agent_document_file(uuid, uuid, uuid, text, text, text, text, bigint, text, jsonb) to service_role;
grant execute on function public.rag_set_agent_document_archived(uuid, uuid, boolean) to service_role;
grant execute on function public.rag_delete_generated_document(uuid, uuid) to service_role;
grant execute on function public.rag_hybrid_search(uuid, uuid[], text, text, integer, integer) to service_role;
