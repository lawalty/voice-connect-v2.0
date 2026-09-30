from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from app.models import Document, Group, Job, RouteCandidate, SearchHit


class FakeRepository:
    def __init__(self) -> None:
        self.groups: list[Group] = []
        self.documents: dict[UUID, Document] = {}
        self.jobs: dict[UUID, Job] = {}
        self.chunks: dict[UUID, list[dict[str, Any]]] = {}
        self.route_scores: list[float] = []
        self.group_routing_embeddings: dict[UUID, list[float]] = {}

    async def list_groups(self, owner_id: UUID) -> list[Group]:
        return [group for group in self.groups if group.owner_id == owner_id]

    async def create_group(
        self,
        owner_id: UUID,
        name: str,
        slug: str,
        aliases: list[str],
        description: str,
        routing_embedding: list[float],
    ) -> Group:
        group = Group(
            id=uuid4(),
            owner_id=owner_id,
            name=name,
            slug=slug,
            aliases=aliases,
            description=description,
        )
        self.groups.append(group)
        self.group_routing_embeddings[group.id] = routing_embedding
        return group

    async def update_group(
        self,
        owner_id: UUID,
        group_id: UUID,
        name: str,
        aliases: list[str],
        description: str,
        routing_embedding: list[float],
    ) -> Group:
        for index, group in enumerate(self.groups):
            if group.id == group_id and group.owner_id == owner_id:
                updated = group.model_copy(
                    update={
                        "name": name,
                        "aliases": aliases,
                        "description": description,
                        "updated_at": datetime.now(timezone.utc),
                    }
                )
                self.groups[index] = updated
                self.group_routing_embeddings[group_id] = routing_embedding
                return updated
        raise LookupError("RAG group not found")

    async def ensure_system_group(
        self,
        owner_id: UUID,
        name: str,
        slug: str,
        description: str,
        system_key: str,
        routing_embedding: list[float],
    ) -> Group:
        del routing_embedding
        existing = next(
            (
                group
                for group in self.groups
                if group.owner_id == owner_id and group.system_key == system_key
            ),
            None,
        )
        if existing:
            return existing
        group = Group(
            id=uuid4(),
            owner_id=owner_id,
            name=name,
            slug=slug,
            description=description,
            system_key=system_key,
        )
        self.groups.append(group)
        return group

    async def rank_groups(
        self, owner_id: UUID, query_embedding: list[float], limit: int = 3
    ) -> list[RouteCandidate]:
        del query_embedding
        groups = await self.list_groups(owner_id)
        scores = self.route_scores or [
            0.7 - (index * 0.1) for index in range(len(groups))
        ]
        return [
            RouteCandidate(
                id=group.id, name=group.name, slug=group.slug, score=scores[index]
            )
            for index, group in enumerate(groups[: min(limit, len(scores))])
        ]

    async def create_document_job(self, **values: Any) -> tuple[UUID, UUID, bool, str]:
        existing = next(
            (
                document
                for document in self.documents.values()
                if document.owner_id == values["owner_id"]
                and document.group_id == values["group_id"]
                and document.sha256 == values["sha256"]
            ),
            None,
        )
        if existing:
            job = next(
                job for job in self.jobs.values() if job.document_id == existing.id
            )
            return existing.id, job.id, True, existing.status
        document = Document(
            id=values["document_id"],
            owner_id=values["owner_id"],
            group_id=values["group_id"],
            filename=values["filename"],
            mime_type=values["mime_type"],
            storage_bucket=values["bucket"],
            storage_path=values["storage_path"],
            size_bytes=values["size_bytes"],
            sha256=values["sha256"],
            status="pending",
            source=values["source"],
            created_by_agent=values.get("created_by_agent", False),
            source_metadata=values["source_metadata"],
        )
        job = Job(
            id=values["job_id"],
            owner_id=values["owner_id"],
            document_id=document.id,
            status="queued",
        )
        self.documents[document.id] = document
        self.jobs[job.id] = job
        return document.id, job.id, False, document.status

    async def retry_failed_document(
        self,
        owner_id: UUID,
        document_id: UUID,
        job_id: UUID,
    ) -> tuple[UUID, bool, str]:
        document = self.documents.get(document_id)
        if not document or document.owner_id != owner_id:
            raise ValueError("document does not belong to owner")
        if document.document_kind != "upload":
            raise ValueError("only uploaded documents can be retried")
        if document.status == "failed":
            self.documents[document_id] = document.model_copy(
                update={"status": "pending", "error": None}
            )
            job = Job(
                id=job_id,
                owner_id=owner_id,
                document_id=document_id,
                document_revision=document.revision,
                status="queued",
            )
            self.jobs[job.id] = job
            return job.id, True, "queued"
        latest = next(
            (
                job
                for job in reversed(list(self.jobs.values()))
                if job.owner_id == owner_id and job.document_id == document_id
            ),
            None,
        )
        if latest is None:
            raise ValueError("document has no ingestion job")
        return latest.id, False, document.status

    async def update_document_source_metadata(
        self,
        owner_id: UUID,
        document_id: UUID,
        source_metadata: dict[str, Any],
    ) -> None:
        document = self.documents.get(document_id)
        if not document or document.owner_id != owner_id:
            raise LookupError("Document not found")
        self.documents[document_id] = document.model_copy(
            update={"source_metadata": source_metadata}
        )

    async def create_generated_document_job(
        self, **values: Any
    ) -> tuple[UUID, UUID, int, str]:
        if any(
            document.owner_id == values["owner_id"]
            and document.group_id == values["group_id"]
            and document.document_kind == "generated"
            and document.generated_title_key == values["title_key"]
            for document in self.documents.values()
        ):
            raise ValueError(
                "a generated document with that title already exists; revise it instead"
            )
        document = Document(
            id=values["document_id"],
            owner_id=values["owner_id"],
            group_id=values["group_id"],
            filename=values["filename"],
            mime_type="text/markdown",
            storage_bucket=None,
            storage_path=None,
            size_bytes=values["size_bytes"],
            sha256=values["sha256"],
            status="pending",
            source="hermes_generated",
            source_metadata=values["source_metadata"],
            document_kind="generated",
            created_by_agent=True,
            title=values["title"],
            generated_title_key=values["title_key"],
            body_markdown=values["markdown"],
            revision=1,
        )
        job = Job(
            id=values["job_id"],
            owner_id=values["owner_id"],
            document_id=document.id,
            document_revision=1,
            status="queued",
        )
        self.documents[document.id] = document
        self.jobs[job.id] = job
        return document.id, job.id, 1, document.status

    async def update_generated_document_job(
        self, **values: Any
    ) -> tuple[UUID, UUID, int, str]:
        document = self.documents.get(values["document_id"])
        if (
            not document
            or document.owner_id != values["owner_id"]
            or not document.created_by_agent
        ):
            raise ValueError("generated document not found or is not editable")
        if any(
            other.id != document.id
            and other.owner_id == document.owner_id
            and other.document_kind == "generated"
            and other.generated_title_key == values["title_key"]
            for other in self.documents.values()
        ):
            raise ValueError("a generated document with that title already exists")
        revision = document.revision + 1
        self.documents[document.id] = document.model_copy(
            update={
                "title": values["title"],
                "generated_title_key": values["title_key"],
                "filename": values["filename"],
                "mime_type": "text/markdown",
                "storage_bucket": None,
                "storage_path": None,
                "body_markdown": values["markdown"],
                "document_kind": "generated",
                "source": "hermes_generated",
                "size_bytes": values["size_bytes"],
                "sha256": values["sha256"],
                "revision": revision,
                "status": "pending",
                "error": None,
            }
        )
        for job_id, job in list(self.jobs.items()):
            if job.document_id == document.id and job.status in {
                "queued",
                "processing",
            }:
                self.jobs[job_id] = job.model_copy(
                    update={"status": "failed", "error": "Superseded"}
                )
        job = Job(
            id=values["job_id"],
            owner_id=values["owner_id"],
            document_id=document.id,
            document_revision=revision,
            status="queued",
        )
        self.jobs[job.id] = job
        return document.id, job.id, revision, "pending"

    async def find_generated_documents(
        self, owner_id: UUID, title_query: str
    ) -> list[Document]:
        return [
            await self.get_document(owner_id, document.id)
            for document in self.documents.values()
            if document.owner_id == owner_id
            and document.created_by_agent
            and title_query in (document.generated_title_key or "")
        ]

    async def delete_generated_document(
        self, owner_id: UUID, document_id: UUID
    ) -> bool:
        document = self.documents.get(document_id)
        if (
            not document
            or document.owner_id != owner_id
            or not document.created_by_agent
        ):
            return False
        self.documents.pop(document_id)
        self.chunks.pop(document_id, None)
        self.jobs = {
            key: job for key, job in self.jobs.items() if job.document_id != document_id
        }
        return True

    async def replace_agent_document_file(
        self, **values: Any
    ) -> tuple[UUID, UUID, int, str]:
        document = self.documents.get(values["document_id"])
        if (
            not document
            or document.owner_id != values["owner_id"]
            or not document.created_by_agent
        ):
            raise ValueError("agent-managed document not found or is not replaceable")
        revision = document.revision + 1
        self.documents[document.id] = document.model_copy(
            update={
                "filename": values["filename"],
                "mime_type": values["mime_type"],
                "storage_bucket": values["bucket"],
                "storage_path": values["storage_path"],
                "size_bytes": values["size_bytes"],
                "sha256": values["sha256"],
                "source": "hermes",
                "source_metadata": values["source_metadata"],
                "document_kind": "upload",
                "title": Path(values["filename"]).stem,
                "generated_title_key": None,
                "body_markdown": None,
                "revision": revision,
                "status": "pending",
                "error": None,
            }
        )
        for job_id, job in list(self.jobs.items()):
            if job.document_id == document.id and job.status in {
                "queued",
                "processing",
            }:
                self.jobs[job_id] = job.model_copy(
                    update={"status": "failed", "error": "Superseded"}
                )
        job = Job(
            id=values["job_id"],
            owner_id=values["owner_id"],
            document_id=document.id,
            document_revision=revision,
            status="queued",
        )
        self.jobs[job.id] = job
        return document.id, job.id, revision, "pending"

    async def set_agent_document_archived(
        self, owner_id: UUID, document_id: UUID, archived: bool
    ) -> bool:
        document = self.documents.get(document_id)
        if (
            not document
            or document.owner_id != owner_id
            or not document.created_by_agent
        ):
            return False
        self.documents[document_id] = document.model_copy(
            update={
                "archived_at": datetime.now(timezone.utc) if archived else None
            }
        )
        return True

    async def delete_document_as_operator(
        self, owner_id: UUID, document_id: UUID
    ) -> bool:
        document = self.documents.get(document_id)
        if not document or document.owner_id != owner_id:
            return False
        self.documents.pop(document_id)
        self.chunks.pop(document_id, None)
        self.jobs = {
            key: job for key, job in self.jobs.items() if job.document_id != document_id
        }
        return True

    async def get_document(self, owner_id: UUID, document_id: UUID) -> Document | None:
        document = self.documents.get(document_id)
        if document and document.owner_id == owner_id:
            group = next(
                group for group in self.groups if group.id == document.group_id
            )
            return document.model_copy(
                update={
                    "group_name": group.name,
                    "group_slug": group.slug,
                    "group_system_key": group.system_key,
                }
            )
        return None

    async def list_documents(
        self, owner_id: UUID, group_id: UUID | None, limit: int,
        conversation_id: UUID | None = None,
    ) -> list[Document]:
        output = []
        for document in self.documents.values():
            if document.owner_id != owner_id or (
                group_id and document.group_id != group_id
            ):
                continue
            if conversation_id and (document.document_kind != "generated" or document.archived_at or str(conversation_id) not in document.source_metadata.get("vc_conversation_ids", [])):
                continue
            hydrated = await self.get_document(owner_id, document.id)
            if hydrated is not None:
                hydrated = hydrated.model_copy(
                    update={"chunk_count": len(self.chunks.get(document.id, []))}
                )
            output.append(hydrated)
        return [item for item in output if item is not None][:limit]

    async def get_job(self, owner_id: UUID, job_id: UUID) -> Job | None:
        job = self.jobs.get(job_id)
        return job if job and job.owner_id == owner_id else None

    async def claim_next_job(self, owner_id: UUID) -> Job | None:
        for job in self.jobs.values():
            if job.owner_id == owner_id and job.status == "queued":
                claimed = job.model_copy(
                    update={"status": "processing", "attempts": job.attempts + 1}
                )
                self.jobs[job.id] = claimed
                return claimed
        return None

    async def start_job(self, owner_id: UUID, job_id: UUID, document_id: UUID) -> None:
        now = datetime.now(timezone.utc)
        self.jobs[job_id] = self.jobs[job_id].model_copy(
            update={"status": "processing", "started_at": now}
        )
        self.documents[document_id] = self.documents[document_id].model_copy(
            update={"status": "processing"}
        )

    async def replace_chunks(
        self, owner_id: UUID, document: Document, chunks: list[dict[str, Any]]
    ) -> None:
        assert owner_id == document.owner_id
        assert self.documents[document.id].revision == document.revision
        self.chunks[document.id] = chunks

    async def complete_job(
        self, owner_id: UUID, job_id: UUID, document_id: UUID
    ) -> None:
        now = datetime.now(timezone.utc)
        self.jobs[job_id] = self.jobs[job_id].model_copy(
            update={"status": "completed", "completed_at": now}
        )
        if self.documents[document_id].revision == self.jobs[job_id].document_revision:
            self.documents[document_id] = self.documents[document_id].model_copy(
                update={"status": "ready"}
            )

    async def fail_job(
        self,
        owner_id: UUID,
        job_id: UUID,
        document_id: UUID,
        error: str,
        expected_revision: int = 1,
    ) -> None:
        self.jobs[job_id] = self.jobs[job_id].model_copy(
            update={"status": "failed", "error": error}
        )
        if self.documents[document_id].revision == expected_revision:
            self.documents[document_id] = self.documents[document_id].model_copy(
                update={"status": "failed", "error": error}
            )

    async def hybrid_search(
        self,
        owner_id: UUID,
        group_ids: list[UUID],
        query: str,
        query_embedding: list[float],
        limit: int,
    ) -> list[SearchHit]:
        del query_embedding
        hits = []
        for document in self.documents.values():
            if document.archived_at is not None:
                continue
            if (
                document.owner_id != owner_id
                or document.group_id not in group_ids
                or document.status != "ready"
            ):
                continue
            group = next(
                group for group in self.groups if group.id == document.group_id
            )
            for record in self.chunks.get(document.id, []):
                hits.append(
                    SearchHit(
                        chunk_id=uuid4(),
                        document_id=document.id,
                        group_id=group.id,
                        group_name=group.name,
                        group_slug=group.slug,
                        filename=document.filename,
                        chunk_index=record["chunk_index"],
                        content=record["content"],
                        score=0.03,
                        semantic_similarity=0.8,
                        metadata={"query": query},
                    )
                )
        return hits[:limit]


class FakeStorage:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], bytes] = {}

    async def upload(
        self, bucket: str, path: str, content: bytes, mime_type: str
    ) -> None:
        del mime_type
        self.objects[(bucket, path)] = content

    async def download(self, bucket: str, path: str) -> bytes:
        return self.objects[(bucket, path)]

    async def remove(self, bucket: str, path: str) -> None:
        self.objects.pop((bucket, path), None)

    async def create_signed_download(
        self, bucket: str, path: str, filename: str, expires_in: int
    ) -> str:
        assert (bucket, path) in self.objects
        return f"https://signed.example/{filename}?expires={expires_in}"
