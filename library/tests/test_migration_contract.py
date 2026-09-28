from pathlib import Path

from pglast import parse_sql

SQL = (
    Path(__file__).parents[1]
    / "supabase"
    / "migrations"
    / "202608070001_group_aware_rag.sql"
).read_text(encoding="utf-8")
FK_INDEX_SQL = (
    Path(__file__).parents[1]
    / "supabase"
    / "migrations"
    / "20260809013652_add_rag_fk_indexes.sql"
).read_text(encoding="utf-8")
GENERATED_SQL = (
    Path(__file__).parents[1]
    / "supabase"
    / "migrations"
    / "20260809104513_generated_documents.sql"
).read_text(encoding="utf-8")
URL_INGESTION_SQL = (
    Path(__file__).parents[1]
    / "supabase"
    / "migrations"
    / "20260810140630_add_url_ingestion.sql"
).read_text(encoding="utf-8")
RETRY_SQL = (
    Path(__file__).parents[1]
    / "supabase"
    / "migrations"
    / "20260810163029_retry_failed_document_ingestion.sql"
).read_text(encoding="utf-8")
DELETION_SQL = (
    Path(__file__).parents[1]
    / "supabase"
    / "migrations"
    / "20260810225022_separate_agent_and_operator_document_deletion.sql"
).read_text(encoding="utf-8")
LIFECYCLE_SQL = (
    Path(__file__).parents[1]
    / "supabase"
    / "migrations"
    / "20260811033716_agent_managed_generated_docs_lifecycle.sql"
).read_text(encoding="utf-8")
UPLOAD_CONFLICT_FIX_SQL = (
    Path(__file__).parents[1]
    / "supabase"
    / "migrations"
    / "20260811035805_fix_agent_upload_conflict_target.sql"
).read_text(encoding="utf-8")
LIFECYCLE_COLUMN_FIX_SQL = (
    Path(__file__).parents[1]
    / "supabase"
    / "migrations"
    / "20260811040310_fix_agent_lifecycle_ambiguous_columns.sql"
).read_text(encoding="utf-8")
CHUNK_COUNTS_SQL = (
    Path(__file__).parents[1]
    / "supabase"
    / "migrations"
    / "20260817213049_list_document_chunk_counts.sql"
).read_text(encoding="utf-8")
STORAGE_CLAIM_GUARD_SQL = (
    Path(__file__).parents[1]
    / "supabase"
    / "migrations"
    / "20260824153818_prevent_storage_upload_claim_race.sql"
).read_text(encoding="utf-8")


def test_every_migration_parses_as_postgresql() -> None:
    migration_root = Path(__file__).parents[1] / "supabase" / "migrations"
    for path in sorted(migration_root.glob("*.sql")):
        parse_sql(path.read_text(encoding="utf-8"))


def test_schema_contract_has_vector_text_owner_and_private_storage_controls() -> None:
    assert "vector(384)" in SQL
    assert "using hnsw" in SQL
    assert "using gin(fts)" in SQL
    assert "enable row level security" in SQL
    assert "revoke all" in SQL and "from anon, authenticated" in SQL
    assert "'rag-documents', 'rag-documents', false" in SQL


def test_hybrid_search_uses_rrf_and_owner_group_filters() -> None:
    assert "1.0 / (60 + s.semantic_rank)" in SQL
    assert "1.0 / (60 + k.keyword_rank)" in SQL
    assert "c.owner_id = p_owner_id" in SQL
    assert "c.group_id = any(p_group_ids)" in SQL
    assert SQL.count("OPERATOR(extensions.<=>)") == 5


def test_foreign_key_columns_have_supporting_indexes() -> None:
    assert "rag_documents(group_id)" in FK_INDEX_SQL
    assert "rag_ingestion_jobs(document_id)" in FK_INDEX_SQL
    assert "rag_chunks(group_id)" in FK_INDEX_SQL


def test_generated_document_migration_separates_markdown_from_upload_storage() -> None:
    assert "document_kind = 'generated'" in GENERATED_SQL
    assert "body_markdown" in GENERATED_SQL
    assert "storage_bucket is null" in GENERATED_SQL
    assert "rag_documents_generated_title_uidx" in GENERATED_SQL
    assert "rag_ensure_system_group" in GENERATED_SQL
    assert "hermes-generated-documents" in GENERATED_SQL
    assert "rag_replace_document_chunks" in GENERATED_SQL
    assert "document revision changed before chunks were committed" in GENERATED_SQL
    assert "security invoker" in GENERATED_SQL
    assert "from public, anon, authenticated" in GENERATED_SQL


def test_url_ingestion_migration_allows_url_source_and_html_storage() -> None:
    assert "'url'" in URL_INGESTION_SQL
    assert "'hermes_generated'" in URL_INGESTION_SQL
    assert "'text/html'" in URL_INGESTION_SQL
    assert "'application/xhtml+xml'" in URL_INGESTION_SQL


def test_failed_ingestion_retry_is_atomic_owner_scoped_and_service_only() -> None:
    assert "rag_retry_failed_document" in RETRY_SQL
    assert "for update" in RETRY_SQL
    assert "d.owner_id = p_owner_id" in RETRY_SQL
    assert "set status = 'pending', error = null" in RETRY_SQL
    assert "'queued'::text" in RETRY_SQL
    assert "security invoker" in RETRY_SQL
    assert "from public, anon, authenticated" in RETRY_SQL
    assert "to service_role" in RETRY_SQL


def test_agent_provenance_and_delete_authorities_are_separate_and_service_only() -> None:
    assert "created_by_agent boolean not null default false" in DELETION_SQL
    assert "document provenance is immutable" in DELETION_SQL
    assert "rag_delete_generated_document" in DELETION_SQL
    assert "d.created_by_agent = true" in DELETION_SQL
    assert "g.system_key = 'hermes-generated-documents'" in DELETION_SQL
    assert "rag_delete_document_as_operator" in DELETION_SQL
    assert "security invoker" in DELETION_SQL
    assert "from public, anon, authenticated" in DELETION_SQL
    assert "to service_role" in DELETION_SQL


def test_agent_authority_is_independent_from_storage_shape() -> None:
    assert "d.source in ('hermes', 'hermes_generated')" in LIFECYCLE_SQL
    assert "document_kind <> 'generated' or created_by_agent = true" in LIFECYCLE_SQL
    assert "p_created_by_agent boolean" in LIFECYCLE_SQL
    assert "agent-managed documents require the reserved Generated Docs group" in LIFECYCLE_SQL
    assert "rag_replace_agent_document_file" in LIFECYCLE_SQL
    assert "rag_set_agent_document_archived" in LIFECYCLE_SQL
    assert LIFECYCLE_SQL.count("d.archived_at is null") == 2
    assert "d.created_by_agent = true" in LIFECYCLE_SQL
    assert "g.system_key = 'hermes-generated-documents'" in LIFECYCLE_SQL
    assert "security invoker" in LIFECYCLE_SQL
    assert "from public, anon, authenticated" in LIFECYCLE_SQL
    assert "to service_role" in LIFECYCLE_SQL


def test_agent_upload_conflict_target_matches_partial_unique_index() -> None:
    assert (
        "on conflict (owner_id, group_id, sha256) where document_kind = 'upload'"
        in UPLOAD_CONFLICT_FIX_SQL
    )
    assert "and d.document_kind = 'upload'" in UPLOAD_CONFLICT_FIX_SQL
    assert "security invoker" in UPLOAD_CONFLICT_FIX_SQL
    assert "from public, anon, authenticated" in UPLOAD_CONFLICT_FIX_SQL
    assert "to service_role" in UPLOAD_CONFLICT_FIX_SQL


def test_agent_lifecycle_mutations_qualify_out_parameter_column_names() -> None:
    assert LIFECYCLE_COLUMN_FIX_SQL.count(
        "update public.rag_ingestion_jobs as j"
    ) == 2
    assert LIFECYCLE_COLUMN_FIX_SQL.count(
        "and j.document_id = p_document_id"
    ) == 2
    assert LIFECYCLE_COLUMN_FIX_SQL.count("update public.rag_documents as d") == 2
    assert LIFECYCLE_COLUMN_FIX_SQL.count(
        "where d.id = p_document_id and d.owner_id = p_owner_id"
    ) == 2
    assert "security invoker" in LIFECYCLE_COLUMN_FIX_SQL
    assert "from public, anon, authenticated" in LIFECYCLE_COLUMN_FIX_SQL
    assert "to service_role" in LIFECYCLE_COLUMN_FIX_SQL


def test_document_chunk_counts_are_batched_owner_scoped_and_service_only() -> None:
    assert "rag_list_document_chunk_counts" in CHUNK_COUNTS_SQL
    assert "c.owner_id = p_owner_id" in CHUNK_COUNTS_SQL
    assert "d.owner_id = p_owner_id" in CHUNK_COUNTS_SQL
    assert "c.document_id = any(p_document_ids)" in CHUNK_COUNTS_SQL
    assert "count(*)::bigint" in CHUNK_COUNTS_SQL
    assert "security invoker" in CHUNK_COUNTS_SQL
    assert "from public, anon, authenticated" in CHUNK_COUNTS_SQL
    assert "to service_role" in CHUNK_COUNTS_SQL


def test_worker_claim_waits_for_uploaded_storage_object() -> None:
    assert "rag_claim_next_job" in STORAGE_CLAIM_GUARD_SQL
    assert "join public.rag_documents d" in STORAGE_CLAIM_GUARD_SQL
    assert "from storage.objects o" in STORAGE_CLAIM_GUARD_SQL
    assert "o.bucket_id = d.storage_bucket" in STORAGE_CLAIM_GUARD_SQL
    assert "o.name = d.storage_path" in STORAGE_CLAIM_GUARD_SQL
    assert "d.document_kind = 'generated'" in STORAGE_CLAIM_GUARD_SQL
    assert "for update of j skip locked" in STORAGE_CLAIM_GUARD_SQL
    assert "security invoker" in STORAGE_CLAIM_GUARD_SQL
    assert "from public, anon, authenticated" in STORAGE_CLAIM_GUARD_SQL
    assert "to service_role" in STORAGE_CLAIM_GUARD_SQL
