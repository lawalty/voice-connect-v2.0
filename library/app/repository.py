from __future__ import annotations

from typing import Any, Protocol
from uuid import UUID

from app.models import Document, Group, Job, RouteCandidate, SearchHit


class Repository(Protocol):
    async def list_groups(self, owner_id: UUID) -> list[Group]: ...
    async def create_group(
        self,
        owner_id: UUID,
        name: str,
        slug: str,
        aliases: list[str],
        description: str,
        routing_embedding: list[float],
    ) -> Group: ...
    async def update_group(
        self,
        owner_id: UUID,
        group_id: UUID,
        name: str,
        aliases: list[str],
        description: str,
        routing_embedding: list[float],
    ) -> Group: ...
    async def ensure_system_group(
        self,
        owner_id: UUID,
        name: str,
        slug: str,
        description: str,
        system_key: str,
        routing_embedding: list[float],
    ) -> Group: ...
    async def rank_groups(
        self, owner_id: UUID, query_embedding: list[float], limit: int = 3
    ) -> list[RouteCandidate]: ...
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
    ) -> tuple[UUID, UUID, bool, str]: ...
    async def retry_failed_document(
        self,
        owner_id: UUID,
        document_id: UUID,
        job_id: UUID,
    ) -> tuple[UUID, bool, str]: ...
    async def update_document_source_metadata(
        self,
        owner_id: UUID,
        document_id: UUID,
        source_metadata: dict[str, Any],
    ) -> None: ...
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
    ) -> tuple[UUID, UUID, int, str]: ...
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
    ) -> tuple[UUID, UUID, int, str]: ...
    async def find_generated_documents(
        self, owner_id: UUID, title_query: str
    ) -> list[Document]: ...
    async def delete_generated_document(
        self, owner_id: UUID, document_id: UUID
    ) -> bool: ...
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
    ) -> tuple[UUID, UUID, int, str]: ...
    async def set_agent_document_archived(
        self, owner_id: UUID, document_id: UUID, archived: bool
    ) -> bool: ...
    async def delete_document_as_operator(
        self, owner_id: UUID, document_id: UUID
    ) -> bool: ...
    async def get_document(
        self, owner_id: UUID, document_id: UUID
    ) -> Document | None: ...
    async def list_documents(
        self, owner_id: UUID, group_id: UUID | None, limit: int,
        conversation_id: UUID | None = None,
    ) -> list[Document]: ...
    async def get_job(self, owner_id: UUID, job_id: UUID) -> Job | None: ...
    async def claim_next_job(self, owner_id: UUID) -> Job | None: ...
    async def start_job(
        self, owner_id: UUID, job_id: UUID, document_id: UUID
    ) -> None: ...
    async def replace_chunks(
        self,
        owner_id: UUID,
        document: Document,
        chunks: list[dict[str, Any]],
    ) -> None: ...
    async def complete_job(
        self, owner_id: UUID, job_id: UUID, document_id: UUID
    ) -> None: ...
    async def fail_job(
        self,
        owner_id: UUID,
        job_id: UUID,
        document_id: UUID,
        error: str,
        expected_revision: int = 1,
    ) -> None: ...
    async def hybrid_search(
        self,
        owner_id: UUID,
        group_ids: list[UUID],
        query: str,
        query_embedding: list[float],
        limit: int,
    ) -> list[SearchHit]: ...


class ObjectStorage(Protocol):
    async def upload(
        self, bucket: str, path: str, content: bytes, mime_type: str
    ) -> None: ...
    async def download(self, bucket: str, path: str) -> bytes: ...
    async def remove(self, bucket: str, path: str) -> None: ...
    async def create_signed_download(
        self, bucket: str, path: str, filename: str, expires_in: int
    ) -> str: ...


def match_group(groups: list[Group], identifier: str) -> Group | None:
    needle = identifier.strip().casefold()
    for group in groups:
        names = [group.name, group.slug, *group.aliases]
        if needle in {value.strip().casefold() for value in names}:
            return group
    return None
