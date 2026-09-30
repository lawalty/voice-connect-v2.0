from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote
from uuid import UUID

import httpx

from app.config import Settings
from app.embeddings import vector_literal
from app.models import Document, Group, Job, RouteCandidate, SearchHit


class SupabaseError(RuntimeError):
    pass


class _SupabaseHttp:
    def __init__(
        self, settings: Settings, client: httpx.AsyncClient | None = None
    ) -> None:
        self.settings = settings
        self.client = client or httpx.AsyncClient(timeout=60.0)

    @property
    def headers(self) -> dict[str, str]:
        headers = {"apikey": self.settings.service_role_key}
        # Current sb_secret_ keys are API keys, not JWTs. Legacy service_role
        # JWTs still need the bearer header to establish the Postgres role.
        if not self.settings.service_role_key.startswith("sb_secret_"):
            headers["Authorization"] = f"Bearer {self.settings.service_role_key}"
        return headers

    async def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        headers = {**self.headers, **kwargs.pop("headers", {})}
        response = await self.client.request(
            method, f"{self.settings.supabase_url}{path}", headers=headers, **kwargs
        )
        if response.is_error:
            detail = response.text[:1200]
            raise SupabaseError(
                f"Supabase {method} {path} failed ({response.status_code}): {detail}"
            )
        return response


class SupabaseRepository(_SupabaseHttp):
    async def list_groups(self, owner_id: UUID) -> list[Group]:
        response = await self.request(
            "GET",
            "/rest/v1/rag_groups",
            params={
                "owner_id": f"eq.{owner_id}",
                "select": "id,owner_id,name,slug,aliases,description,system_key,created_at,updated_at",
                "order": "name.asc",
            },
        )
        return [Group.model_validate(row) for row in response.json()]

    async def create_group(
        self,
        owner_id: UUID,
        name: str,
        slug: str,
        aliases: list[str],
        description: str,
        routing_embedding: list[float],
    ) -> Group:
        response = await self.request(
            "POST",
            "/rest/v1/rag_groups",
            headers={"Prefer": "return=representation"},
            json={
                "owner_id": str(owner_id),
                "name": name,
                "slug": slug,
                "aliases": aliases,
                "description": description,
                "routing_embedding": vector_literal(routing_embedding),
            },
        )
        return Group.model_validate(response.json()[0])

    async def update_group(
        self,
        owner_id: UUID,
        group_id: UUID,
        name: str,
        aliases: list[str],
        description: str,
        routing_embedding: list[float],
    ) -> Group:
        response = await self.request(
            "PATCH",
            "/rest/v1/rag_groups",
            headers={"Prefer": "return=representation"},
            params={
                "owner_id": f"eq.{owner_id}",
                "id": f"eq.{group_id}",
                "select": "id,owner_id,name,slug,aliases,description,system_key,created_at,updated_at",
            },
            json={
                "name": name,
                "aliases": aliases,
                "description": description,
                "routing_embedding": vector_literal(routing_embedding),
            },
        )
        rows = response.json()
        if not rows:
            raise LookupError("RAG group not found")
        return Group.model_validate(rows[0])

    async def ensure_system_group(
        self,
        owner_id: UUID,
        name: str,
        slug: str,
        description: str,
        system_key: str,
        routing_embedding: list[float],
    ) -> Group:
        response = await self.request(
            "POST",
            "/rest/v1/rpc/rag_ensure_system_group",
            json={
                "p_owner_id": str(owner_id),
                "p_name": name,
                "p_slug": slug,
                "p_description": description,
                "p_system_key": system_key,
                "p_routing_embedding": vector_literal(routing_embedding),
            },
        )
        return Group.model_validate(response.json()[0])

    async def rank_groups(
        self, owner_id: UUID, query_embedding: list[float], limit: int = 3
    ) -> list[RouteCandidate]:
        response = await self.request(
            "POST",
            "/rest/v1/rpc/rag_route_groups",
            json={
                "p_owner_id": str(owner_id),
                "p_query_embedding": vector_literal(query_embedding),
                "p_limit": limit,
            },
        )
        return [RouteCandidate.model_validate(row) for row in response.json()]

    async def create_document_job(
        self,
        *,
        document_id: UUID,
        job_id: UUID,
        owner_id: UUID,
        group_id: UUID,
        filename: str,
        mime_type: str,
        bucket: str,
        storage_path: str,
        size_bytes: int,
        sha256: str,
        source: str,
        source_metadata: dict[str, Any],
        created_by_agent: bool,
    ) -> tuple[UUID, UUID, bool, str]:
        response = await self.request(
            "POST",
            "/rest/v1/rpc/rag_create_document_job",
            json={
                "p_document_id": str(document_id),
                "p_job_id": str(job_id),
                "p_owner_id": str(owner_id),
                "p_group_id": str(group_id),
                "p_filename": filename,
                "p_mime_type": mime_type,
                "p_storage_bucket": bucket,
                "p_storage_path": storage_path,
                "p_size_bytes": size_bytes,
                "p_sha256": sha256,
                "p_source": source,
                "p_source_metadata": source_metadata,
                "p_created_by_agent": created_by_agent,
            },
        )
        row = response.json()[0]
        return (
            UUID(row["document_id"]),
            UUID(row["job_id"]),
            bool(row["duplicate"]),
            row["document_status"],
        )

    async def retry_failed_document(
        self,
        owner_id: UUID,
        document_id: UUID,
        job_id: UUID,
    ) -> tuple[UUID, bool, str]:
        response = await self.request(
            "POST",
            "/rest/v1/rpc/rag_retry_failed_document",
            json={
                "p_owner_id": str(owner_id),
                "p_document_id": str(document_id),
                "p_job_id": str(job_id),
            },
        )
        row = response.json()[0]
        return UUID(row["job_id"]), bool(row["retried"]), row["document_status"]

    async def update_document_source_metadata(
        self,
        owner_id: UUID,
        document_id: UUID,
        source_metadata: dict[str, Any],
    ) -> None:
        await self.request(
            "PATCH",
            "/rest/v1/rag_documents",
            params={
                "owner_id": f"eq.{owner_id}",
                "id": f"eq.{document_id}",
            },
            headers={"Prefer": "return=minimal"},
            json={"source_metadata": source_metadata},
        )

    async def create_generated_document_job(
        self,
        *,
        document_id: UUID,
        job_id: UUID,
        owner_id: UUID,
        group_id: UUID,
        title: str,
        title_key: str,
        filename: str,
        markdown: str,
        size_bytes: int,
        sha256: str,
        source_metadata: dict[str, Any],
    ) -> tuple[UUID, UUID, int, str]:
        response = await self.request(
            "POST",
            "/rest/v1/rpc/rag_create_generated_document",
            json={
                "p_document_id": str(document_id),
                "p_job_id": str(job_id),
                "p_owner_id": str(owner_id),
                "p_group_id": str(group_id),
                "p_title": title,
                "p_title_key": title_key,
                "p_filename": filename,
                "p_body_markdown": markdown,
                "p_size_bytes": size_bytes,
                "p_sha256": sha256,
                "p_source_metadata": source_metadata,
            },
        )
        row = response.json()[0]
        return (
            UUID(row["document_id"]),
            UUID(row["job_id"]),
            int(row["revision"]),
            row["document_status"],
        )

    async def update_generated_document_job(
        self,
        *,
        document_id: UUID,
        job_id: UUID,
        owner_id: UUID,
        title: str,
        title_key: str,
        filename: str,
        markdown: str,
        size_bytes: int,
        sha256: str,
    ) -> tuple[UUID, UUID, int, str]:
        response = await self.request(
            "POST",
            "/rest/v1/rpc/rag_update_generated_document",
            json={
                "p_document_id": str(document_id),
                "p_job_id": str(job_id),
                "p_owner_id": str(owner_id),
                "p_title": title,
                "p_title_key": title_key,
                "p_filename": filename,
                "p_body_markdown": markdown,
                "p_size_bytes": size_bytes,
                "p_sha256": sha256,
            },
        )
        row = response.json()[0]
        return (
            UUID(row["document_id"]),
            UUID(row["job_id"]),
            int(row["revision"]),
            row["document_status"],
        )

    async def find_generated_documents(
        self, owner_id: UUID, title_query: str
    ) -> list[Document]:
        response = await self.request(
            "GET",
            "/rest/v1/rag_documents",
            params={
                "owner_id": f"eq.{owner_id}",
                "created_by_agent": "eq.true",
                "generated_title_key": f"ilike.*{title_query.replace('*', '')}*",
                "select": "*,rag_groups(name,slug,system_key)",
                "order": "updated_at.desc",
                "limit": 20,
            },
        )
        return [self._document(row) for row in response.json()]

    async def delete_generated_document(
        self, owner_id: UUID, document_id: UUID
    ) -> bool:
        response = await self.request(
            "POST",
            "/rest/v1/rpc/rag_delete_generated_document",
            json={"p_owner_id": str(owner_id), "p_document_id": str(document_id)},
        )
        payload = response.json()
        return bool(payload[0] if isinstance(payload, list) and payload else payload)

    async def replace_agent_document_file(
        self,
        *,
        document_id: UUID,
        job_id: UUID,
        owner_id: UUID,
        filename: str,
        mime_type: str,
        bucket: str,
        storage_path: str,
        size_bytes: int,
        sha256: str,
        source_metadata: dict[str, Any],
    ) -> tuple[UUID, UUID, int, str]:
        response = await self.request(
            "POST",
            "/rest/v1/rpc/rag_replace_agent_document_file",
            json={
                "p_document_id": str(document_id),
                "p_job_id": str(job_id),
                "p_owner_id": str(owner_id),
                "p_filename": filename,
                "p_mime_type": mime_type,
                "p_storage_bucket": bucket,
                "p_storage_path": storage_path,
                "p_size_bytes": size_bytes,
                "p_sha256": sha256,
                "p_source_metadata": source_metadata,
            },
        )
        row = response.json()[0]
        return (
            UUID(row["document_id"]),
            UUID(row["job_id"]),
            int(row["revision"]),
            row["document_status"],
        )

    async def set_agent_document_archived(
        self, owner_id: UUID, document_id: UUID, archived: bool
    ) -> bool:
        response = await self.request(
            "POST",
            "/rest/v1/rpc/rag_set_agent_document_archived",
            json={
                "p_owner_id": str(owner_id),
                "p_document_id": str(document_id),
                "p_archived": archived,
            },
        )
        payload = response.json()
        return bool(payload[0] if isinstance(payload, list) and payload else payload)

    async def delete_document_as_operator(
        self, owner_id: UUID, document_id: UUID
    ) -> bool:
        response = await self.request(
            "POST",
            "/rest/v1/rpc/rag_delete_document_as_operator",
            json={"p_owner_id": str(owner_id), "p_document_id": str(document_id)},
        )
        payload = response.json()
        return bool(payload[0] if isinstance(payload, list) and payload else payload)

    @staticmethod
    def _document(row: dict[str, Any]) -> Document:
        nested = row.pop("rag_groups", None) or {}
        row["group_name"] = nested.get("name")
        row["group_slug"] = nested.get("slug")
        row["group_system_key"] = nested.get("system_key")
        return Document.model_validate(row)

    async def get_document(self, owner_id: UUID, document_id: UUID) -> Document | None:
        response = await self.request(
            "GET",
            "/rest/v1/rag_documents",
            params={
                "owner_id": f"eq.{owner_id}",
                "id": f"eq.{document_id}",
                "select": "*,rag_groups(name,slug,system_key)",
                "limit": 1,
            },
        )
        rows = response.json()
        return self._document(rows[0]) if rows else None

    async def list_documents(
        self, owner_id: UUID, group_id: UUID | None, limit: int,
        conversation_id: UUID | None = None,
    ) -> list[Document]:
        params: dict[str, Any] = {
            "owner_id": f"eq.{owner_id}",
            "select": "*,rag_groups(name,slug,system_key)",
            "order": "created_at.desc",
            "limit": limit,
        }
        if group_id:
            params["group_id"] = f"eq.{group_id}"
        if conversation_id:
            params["source_metadata->vc_conversation_ids"] = 'cs.["' + str(conversation_id) + '"]'
            params["document_kind"] = "eq.generated"
            params["archived_at"] = "is.null"
            params["order"] = "updated_at.desc"
        response = await self.request("GET", "/rest/v1/rag_documents", params=params)
        rows = response.json()
        if not rows:
            return []
        counts_response = await self.request(
            "POST",
            "/rest/v1/rpc/rag_list_document_chunk_counts",
            json={
                "p_owner_id": str(owner_id),
                "p_document_ids": [row["id"] for row in rows],
            },
        )
        counts = {
            row["document_id"]: int(row["chunk_count"])
            for row in counts_response.json()
        }
        for row in rows:
            row["chunk_count"] = counts.get(row["id"], 0)
        return [self._document(row) for row in rows]

    async def get_job(self, owner_id: UUID, job_id: UUID) -> Job | None:
        response = await self.request(
            "GET",
            "/rest/v1/rag_ingestion_jobs",
            params={
                "owner_id": f"eq.{owner_id}",
                "id": f"eq.{job_id}",
                "select": "*",
                "limit": 1,
            },
        )
        rows = response.json()
        return Job.model_validate(rows[0]) if rows else None

    async def claim_next_job(self, owner_id: UUID) -> Job | None:
        response = await self.request(
            "POST",
            "/rest/v1/rpc/rag_claim_next_job",
            json={"p_owner_id": str(owner_id)},
        )
        rows = response.json()
        return Job.model_validate(rows[0]) if rows else None

    async def _patch(
        self, table: str, owner_id: UUID, record_id: UUID, payload: dict[str, Any]
    ) -> None:
        await self.request(
            "PATCH",
            f"/rest/v1/{table}",
            params={"owner_id": f"eq.{owner_id}", "id": f"eq.{record_id}"},
            headers={"Prefer": "return=minimal"},
            json=payload,
        )

    async def start_job(self, owner_id: UUID, job_id: UUID, document_id: UUID) -> None:
        now = datetime.now(timezone.utc).isoformat()
        job = await self.get_job(owner_id, job_id)
        if job is None:
            raise SupabaseError("Ingestion job disappeared before start")
        await self._patch(
            "rag_ingestion_jobs",
            owner_id,
            job_id,
            {"status": "processing", "started_at": now},
        )
        await self.request(
            "PATCH",
            "/rest/v1/rag_documents",
            params={
                "owner_id": f"eq.{owner_id}",
                "id": f"eq.{document_id}",
                "revision": f"eq.{job.document_revision}",
            },
            headers={"Prefer": "return=minimal"},
            json={"status": "processing", "error": None},
        )

    async def replace_chunks(
        self, owner_id: UUID, document: Document, chunks: list[dict[str, Any]]
    ) -> None:
        await self.request(
            "POST",
            "/rest/v1/rpc/rag_replace_document_chunks",
            json={
                "p_owner_id": str(owner_id),
                "p_document_id": str(document.id),
                "p_document_revision": document.revision,
                "p_chunks": chunks,
            },
        )

    async def complete_job(
        self, owner_id: UUID, job_id: UUID, document_id: UUID
    ) -> None:
        now = datetime.now(timezone.utc).isoformat()
        job = await self.get_job(owner_id, job_id)
        if job is None:
            raise SupabaseError("Ingestion job disappeared before completion")
        await self.request(
            "PATCH",
            "/rest/v1/rag_documents",
            params={
                "owner_id": f"eq.{owner_id}",
                "id": f"eq.{document_id}",
                "revision": f"eq.{job.document_revision}",
            },
            headers={"Prefer": "return=minimal"},
            json={"status": "ready", "error": None},
        )
        await self._patch(
            "rag_ingestion_jobs",
            owner_id,
            job_id,
            {"status": "completed", "completed_at": now, "error": None},
        )

    async def fail_job(
        self,
        owner_id: UUID,
        job_id: UUID,
        document_id: UUID,
        error: str,
        expected_revision: int = 1,
    ) -> None:
        safe_error = error[:2000]
        now = datetime.now(timezone.utc).isoformat()
        await self.request(
            "PATCH",
            "/rest/v1/rag_documents",
            params={
                "owner_id": f"eq.{owner_id}",
                "id": f"eq.{document_id}",
                "revision": f"eq.{expected_revision}",
            },
            headers={"Prefer": "return=minimal"},
            json={"status": "failed", "error": safe_error},
        )
        await self._patch(
            "rag_ingestion_jobs",
            owner_id,
            job_id,
            {"status": "failed", "completed_at": now, "error": safe_error},
        )

    async def hybrid_search(
        self,
        owner_id: UUID,
        group_ids: list[UUID],
        query: str,
        query_embedding: list[float],
        limit: int,
    ) -> list[SearchHit]:
        response = await self.request(
            "POST",
            "/rest/v1/rpc/rag_hybrid_search",
            json={
                "p_owner_id": str(owner_id),
                "p_group_ids": [str(group_id) for group_id in group_ids],
                "p_query_text": query,
                "p_query_embedding": vector_literal(query_embedding),
                "p_match_count": limit,
                "p_candidate_count": max(40, limit * 8),
            },
        )
        return [SearchHit.model_validate(row) for row in response.json()]


class SupabaseStorage(_SupabaseHttp):
    @staticmethod
    def _object_path(bucket: str, path: str) -> str:
        return f"{quote(bucket, safe='')}/{quote(path, safe='/')}"

    async def upload(
        self, bucket: str, path: str, content: bytes, mime_type: str
    ) -> None:
        await self.request(
            "POST",
            f"/storage/v1/object/{self._object_path(bucket, path)}",
            headers={
                "Content-Type": mime_type or "application/octet-stream",
                "x-upsert": "false",
            },
            content=content,
        )

    async def download(self, bucket: str, path: str) -> bytes:
        response = await self.request(
            "GET", f"/storage/v1/object/{self._object_path(bucket, path)}"
        )
        return response.content

    async def remove(self, bucket: str, path: str) -> None:
        await self.request(
            "DELETE",
            f"/storage/v1/object/{quote(bucket, safe='')}",
            json={"prefixes": [path]},
        )

    async def create_signed_download(
        self, bucket: str, path: str, filename: str, expires_in: int
    ) -> str:
        response = await self.request(
            "POST",
            f"/storage/v1/object/sign/{self._object_path(bucket, path)}",
            json={"expiresIn": expires_in, "download": filename},
        )
        payload = response.json()
        signed = payload.get("signedURL") or payload.get("signedUrl")
        if not signed:
            raise SupabaseError("Supabase Storage did not return a signed URL")
        if signed.startswith(("http://", "https://")):
            return signed
        return f"{self.settings.supabase_url}/storage/v1{signed if signed.startswith('/') else '/' + signed}"
