-- Group-aware RAG schema for one owner. The service role is the only Data API caller.
-- This deliberately does not modify Hermes memory-provider tables or configuration.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema extensions;

create table if not exists public.rag_groups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  slug text not null check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  aliases text[] not null default '{}',
  description text not null default '',
  routing_embedding extensions.vector(384) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, slug)
);

create table if not exists public.rag_documents (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  group_id uuid not null references public.rag_groups(id) on delete restrict,
  filename text not null,
  mime_type text not null,
  storage_bucket text not null,
  storage_path text not null unique,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 52428800),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed')),
  source text not null default 'portal' check (source in ('portal', 'hermes', 'email', 'api')),
  source_metadata jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, group_id, sha256)
);

create table if not exists public.rag_ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid not null references public.rag_documents(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed')),
  attempts integer not null default 0 check (attempts >= 0),
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz
);

create table if not exists public.rag_chunks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  document_id uuid not null references public.rag_documents(id) on delete cascade,
  group_id uuid not null references public.rag_groups(id) on delete restrict,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null check (char_length(content) > 0),
  word_count integer not null check (word_count > 0),
  embedding extensions.vector(384) not null,
  metadata jsonb not null default '{}'::jsonb,
  fts tsvector generated always as (to_tsvector('english', content)) stored,
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index)
);

create index if not exists rag_groups_owner_idx on public.rag_groups(owner_id);
create index if not exists rag_groups_routing_hnsw_idx
  on public.rag_groups using hnsw (routing_embedding extensions.vector_cosine_ops);
create index if not exists rag_documents_owner_group_idx
  on public.rag_documents(owner_id, group_id, created_at desc);
create index if not exists rag_jobs_queue_idx
  on public.rag_ingestion_jobs(owner_id, status, created_at);
create index if not exists rag_chunks_owner_group_idx
  on public.rag_chunks(owner_id, group_id, document_id);
create index if not exists rag_chunks_embedding_hnsw_idx
  on public.rag_chunks using hnsw (embedding extensions.vector_cosine_ops);
create index if not exists rag_chunks_fts_idx on public.rag_chunks using gin(fts);

create or replace function public.rag_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists rag_groups_updated_at on public.rag_groups;
create trigger rag_groups_updated_at before update on public.rag_groups
for each row execute function public.rag_set_updated_at();
drop trigger if exists rag_documents_updated_at on public.rag_documents;
create trigger rag_documents_updated_at before update on public.rag_documents
for each row execute function public.rag_set_updated_at();

alter table public.rag_groups enable row level security;
alter table public.rag_documents enable row level security;
alter table public.rag_ingestion_jobs enable row level security;
alter table public.rag_chunks enable row level security;

drop policy if exists rag_groups_owner_policy on public.rag_groups;
create policy rag_groups_owner_policy on public.rag_groups
  for all to authenticated using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
drop policy if exists rag_documents_owner_policy on public.rag_documents;
create policy rag_documents_owner_policy on public.rag_documents
  for all to authenticated using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
drop policy if exists rag_jobs_owner_policy on public.rag_ingestion_jobs;
create policy rag_jobs_owner_policy on public.rag_ingestion_jobs
  for all to authenticated using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);
drop policy if exists rag_chunks_owner_policy on public.rag_chunks;
create policy rag_chunks_owner_policy on public.rag_chunks
  for all to authenticated using ((select auth.uid()) = owner_id)
  with check ((select auth.uid()) = owner_id);

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
    size_bytes, sha256, source, source_metadata
  ) values (
    p_document_id, p_owner_id, p_group_id, p_filename, p_mime_type,
    p_storage_bucket, p_storage_path, p_size_bytes, p_sha256, p_source,
    coalesce(p_source_metadata, '{}'::jsonb)
  )
  on conflict (owner_id, group_id, sha256) do nothing
  returning id, status into v_document_id, v_status;

  if v_document_id is null then
    select d.id, d.status into v_document_id, v_status
    from public.rag_documents d
    where d.owner_id = p_owner_id and d.group_id = p_group_id and d.sha256 = p_sha256;
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

create or replace function public.rag_claim_next_job(p_owner_id uuid)
returns setof public.rag_ingestion_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_job_id uuid;
begin
  select id into v_job_id
  from public.rag_ingestion_jobs
  where owner_id = p_owner_id and status = 'queued'
  order by created_at
  for update skip locked
  limit 1;

  if v_job_id is null then
    return;
  end if;

  return query
  update public.rag_ingestion_jobs
  set status = 'processing', started_at = now(), attempts = attempts + 1
  where id = v_job_id and owner_id = p_owner_id
  returning *;
end;
$$;

create or replace function public.rag_route_groups(
  p_owner_id uuid,
  p_query_embedding text,
  p_limit integer default 3
)
returns table(id uuid, name text, slug text, score double precision)
language sql
stable
security invoker
set search_path = ''
set hnsw.iterative_scan = 'strict_order'
as $$
  select g.id, g.name, g.slug,
    (1 - (g.routing_embedding OPERATOR(extensions.<=>) p_query_embedding::extensions.vector))::double precision as score
  from public.rag_groups g
  where g.owner_id = p_owner_id
  order by g.routing_embedding OPERATOR(extensions.<=>) p_query_embedding::extensions.vector
  limit greatest(1, least(p_limit, 10));
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

-- Supabase's 2026 Data API default no longer auto-grants new tables.
-- Opt in only the service role; browsers and plugins call the RAG API instead.
revoke all on public.rag_groups, public.rag_documents, public.rag_ingestion_jobs, public.rag_chunks from anon, authenticated;
grant select, insert, update, delete on public.rag_groups, public.rag_documents, public.rag_ingestion_jobs, public.rag_chunks to service_role;
revoke all on function public.rag_create_document_job(uuid, uuid, uuid, uuid, text, text, text, text, bigint, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.rag_claim_next_job(uuid) from public, anon, authenticated;
revoke all on function public.rag_route_groups(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.rag_hybrid_search(uuid, uuid[], text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.rag_create_document_job(uuid, uuid, uuid, uuid, text, text, text, text, bigint, text, text, jsonb) to service_role;
grant execute on function public.rag_claim_next_job(uuid) to service_role;
grant execute on function public.rag_route_groups(uuid, text, integer) to service_role;
grant execute on function public.rag_hybrid_search(uuid, uuid[], text, text, integer, integer) to service_role;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values (
  'rag-documents', 'rag-documents', false, 52428800,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/markdown',
    'text/plain',
    'application/octet-stream'
  ]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
