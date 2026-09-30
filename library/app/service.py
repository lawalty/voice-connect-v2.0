from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import time
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from app.ai_extraction import (
    AI_PROCESSING_MODES,
    AUTOMATIC_PROCESSING,
    AiDocumentExtractor,
    GeminiDocumentExtractor,
)
from app.chunking import chunk_markdown, chunk_text
from app.config import Settings
from app.embeddings import Embedder, vector_literal
from app.models import (
    AgentDocumentAccepted,
    Document,
    GeneratedDocumentAccepted,
    Group,
    GroupCreate,
    GroupUpdate,
    IngestAccepted,
    Job,
    RouteCandidate,
    SearchRequest,
    SearchResponse,
    SignedLink,
)
from app.parsers import extract_text, validate_document
from app.pdf_renderer import pdf_filename, render_markdown_pdf
from app.repository import ObjectStorage, Repository, match_group
from app.security import sign_generated_link

GENERATED_GROUP_NAME = "Generated Docs"
GENERATED_GROUP_SLUG = "generated-docs"
GENERATED_GROUP_KEY = "hermes-generated-documents"
GENERATED_GROUP_DESCRIPTION = "Documents written by Hermes, including notes, summaries, briefs, guides, checklists, and reports."
logger = logging.getLogger(__name__)
STORAGE_READINESS_ATTEMPTS = 8


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")
    return slug[:63] or "group"


def safe_filename(value: str) -> str:
    leaf = Path(value).name.strip().replace("\x00", "")
    stem = re.sub(r"[^A-Za-z0-9._ -]+", "_", leaf)
    return stem[:180] or "document.txt"


def generated_title_key(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip().casefold()


def generated_markdown_filename(title: str) -> str:
    clean = re.sub(r"[^A-Za-z0-9._ -]+", "_", title).strip(" ._")
    clean = re.sub(r"\s+", " ", clean)[:170].rstrip()
    return f"{clean or 'Hermes Document'}.md"


class RagService:
    def __init__(
        self,
        settings: Settings,
        repository: Repository,
        storage: ObjectStorage,
        embedder: Embedder,
        ai_extractor: AiDocumentExtractor | None = None,
    ) -> None:
        self.settings = settings
        self.repository = repository
        self.storage = storage
        self.embedder = embedder
        self.ai_extractor = ai_extractor or GeminiDocumentExtractor(settings)

    async def list_groups(self, owner_id: UUID) -> list[Group]:
        return await self.repository.list_groups(owner_id)

    async def resolve_group(self, owner_id: UUID, identifier: str) -> Group:
        group = match_group(await self.repository.list_groups(owner_id), identifier)
        if group is None:
            raise LookupError(f"Unknown RAG group: {identifier}")
        return group

    @staticmethod
    def _require_agent_managed(document: Document, action: str) -> None:
        if (
            not document.created_by_agent
            or document.group_system_key != GENERATED_GROUP_KEY
        ):
            raise ValueError(
                f"Only documents created or placed by Hermes in Generated Docs can be {action}"
            )

    async def create_group(self, owner_id: UUID, request: GroupCreate) -> Group:
        reserved = {
            GENERATED_GROUP_NAME.casefold(),
            GENERATED_GROUP_SLUG.casefold(),
            GENERATED_GROUP_KEY.casefold(),
        }
        requested_names = {
            request.name.casefold(),
            (request.slug or "").casefold(),
            *(alias.casefold() for alias in request.aliases),
        }
        if requested_names & reserved:
            raise ValueError(f"{GENERATED_GROUP_NAME} is a reserved system group")
        groups = await self.repository.list_groups(owner_id)
        slug = request.slug or slugify(request.name)
        for identifier in [request.name, slug, *request.aliases]:
            if match_group(groups, identifier):
                raise ValueError(
                    "A group with that name, slug, or alias already exists"
                )
        routing_text = "\n".join(
            [request.name, *request.aliases, request.description]
        ).strip()
        embedding = (await self.embedder.embed([routing_text]))[0]
        return await self.repository.create_group(
            owner_id,
            request.name,
            slug,
            request.aliases,
            request.description,
            embedding,
        )

    async def update_group(
        self, owner_id: UUID, group_id: UUID, request: GroupUpdate
    ) -> Group:
        groups = await self.repository.list_groups(owner_id)
        current = next((group for group in groups if group.id == group_id), None)
        if current is None:
            raise LookupError("RAG group not found")
        if current.system_key is not None:
            raise ValueError("System-managed RAG groups cannot be edited")

        name = request.name if request.name is not None else current.name
        aliases = request.aliases if request.aliases is not None else current.aliases
        description = (
            request.description
            if request.description is not None
            else current.description
        )
        reserved = {
            GENERATED_GROUP_NAME.casefold(),
            GENERATED_GROUP_SLUG.casefold(),
            GENERATED_GROUP_KEY.casefold(),
        }
        if {name.casefold(), *(alias.casefold() for alias in aliases)} & reserved:
            raise ValueError(f"{GENERATED_GROUP_NAME} is a reserved system group")

        other_groups = [group for group in groups if group.id != current.id]
        for identifier in [name, *aliases]:
            if match_group(other_groups, identifier):
                raise ValueError(
                    "A group with that name, slug, or alias already exists"
                )

        routing_text = "\n".join([name, *aliases, description]).strip()
        embedding = (await self.embedder.embed([routing_text]))[0]
        return await self.repository.update_group(
            owner_id,
            current.id,
            name,
            aliases,
            description,
            embedding,
        )

    async def ensure_generated_group(self, owner_id: UUID) -> Group:
        groups = await self.repository.list_groups(owner_id)
        for group in groups:
            if group.system_key == GENERATED_GROUP_KEY:
                return group
        collision = match_group(groups, GENERATED_GROUP_NAME) or match_group(
            groups, GENERATED_GROUP_SLUG
        )
        if collision is not None:
            raise ValueError(
                f"The reserved {GENERATED_GROUP_NAME} group name is already occupied"
            )
        embedding = (
            await self.embedder.embed(
                [f"{GENERATED_GROUP_NAME}\n{GENERATED_GROUP_DESCRIPTION}"]
            )
        )[0]
        return await self.repository.ensure_system_group(
            owner_id,
            GENERATED_GROUP_NAME,
            GENERATED_GROUP_SLUG,
            GENERATED_GROUP_DESCRIPTION,
            GENERATED_GROUP_KEY,
            embedding,
        )

    async def create_generated_document(
        self,
        owner_id: UUID,
        *,
        title: str,
        markdown: str,
        source_metadata: dict[str, Any] | None = None,
    ) -> GeneratedDocumentAccepted:
        title = re.sub(r"\s+", " ", title).strip()
        markdown = markdown.strip()
        if not title or len(title) > 120:
            raise ValueError(
                "Generated document titles must contain 1 to 120 characters"
            )
        if not markdown:
            raise ValueError("Generated document Markdown cannot be empty")
        if len(markdown) > self.settings.max_generated_markdown_chars:
            raise ValueError(
                f"Generated document Markdown exceeds {self.settings.max_generated_markdown_chars} characters"
            )
        encoded = markdown.encode("utf-8")
        group = await self.ensure_generated_group(owner_id)
        (
            document_id,
            job_id,
            revision,
            document_status,
        ) = await self.repository.create_generated_document_job(
            document_id=uuid4(),
            job_id=uuid4(),
            owner_id=owner_id,
            group_id=group.id,
            title=title,
            title_key=generated_title_key(title),
            filename=generated_markdown_filename(title),
            markdown=markdown,
            size_bytes=len(encoded),
            sha256=hashlib.sha256(encoded).hexdigest(),
            source_metadata=source_metadata or {"authored_by": "Hermes"},
        )
        return GeneratedDocumentAccepted(
            document_id=document_id,
            job_id=job_id,
            title=title,
            group=group.name,
            status=document_status,
            revision=revision,
            pdf_path=f"/v1/documents/{document_id}/pdf",
        )

    async def resolve_generated_document(self, owner_id: UUID, title: str) -> Document:
        needle = generated_title_key(title)
        if not needle:
            raise ValueError("title is required")
        candidates = await self.repository.find_generated_documents(owner_id, needle)
        exact = [item for item in candidates if item.generated_title_key == needle]
        if len(exact) == 1:
            return exact[0]
        contained = [
            item for item in candidates if needle in (item.generated_title_key or "")
        ]
        if len(contained) == 1:
            return contained[0]
        if not contained:
            raise LookupError(f"No generated document matches title: {title}")
        titles = ", ".join(
            sorted(item.title or item.filename for item in contained[:8])
        )
        raise ValueError(f"Generated document title is ambiguous; matches: {titles}")

    async def revise_generated_document(
        self,
        owner_id: UUID,
        document_id: UUID,
        *,
        title: str | None,
        markdown: str,
        conversation_id: UUID | None = None,
    ) -> GeneratedDocumentAccepted:
        document = await self.repository.get_document(owner_id, document_id)
        if document is None:
            raise LookupError("Generated document not found")
        self._require_agent_managed(document, "revised")
        final_title = re.sub(
            r"\s+", " ", title or document.title or Path(document.filename).stem
        ).strip()
        markdown = markdown.strip()
        if not final_title or len(final_title) > 120:
            raise ValueError(
                "Generated document titles must contain 1 to 120 characters"
            )
        if not markdown or len(markdown) > self.settings.max_generated_markdown_chars:
            raise ValueError(
                "Generated document Markdown is empty or exceeds the configured limit"
            )
        encoded = markdown.encode("utf-8")
        (
            resolved_id,
            job_id,
            revision,
            status,
        ) = await self.repository.update_generated_document_job(
            document_id=document.id,
            job_id=uuid4(),
            owner_id=owner_id,
            title=final_title,
            title_key=generated_title_key(final_title),
            filename=generated_markdown_filename(final_title),
            markdown=markdown,
            size_bytes=len(encoded),
            sha256=hashlib.sha256(encoded).hexdigest(),
        )
        if conversation_id:
            metadata = dict(document.source_metadata)
            conversations = metadata.get("vc_conversation_ids", [])
            metadata["vc_conversation_ids"] = list(dict.fromkeys([*conversations, str(conversation_id)]))
            await self.repository.update_document_source_metadata(owner_id, document.id, metadata)
        if document.storage_bucket and document.storage_path:
            try:
                await self.storage.remove(
                    document.storage_bucket, document.storage_path
                )
            except Exception:
                logger.exception(
                    "Revised agent document %s, but its superseded Storage object could not be removed",
                    document.id,
                )
        return GeneratedDocumentAccepted(
            document_id=resolved_id,
            job_id=job_id,
            title=final_title,
            group=document.group_name or GENERATED_GROUP_NAME,
            status=status,
            revision=revision,
            pdf_path=f"/v1/documents/{resolved_id}/pdf",
        )

    async def delete_generated_document(
        self, owner_id: UUID, document_id: UUID
    ) -> tuple[Document, str]:
        document = await self.repository.get_document(owner_id, document_id)
        if document is None:
            raise LookupError("Generated document not found")
        self._require_agent_managed(document, "deleted")
        if not await self.repository.delete_generated_document(owner_id, document.id):
            raise LookupError("Generated document not found")
        storage_cleanup = "not_required"
        if document.storage_bucket and document.storage_path:
            try:
                await self.storage.remove(document.storage_bucket, document.storage_path)
                storage_cleanup = "completed"
            except Exception:
                storage_cleanup = "failed"
                logger.exception(
                    "Agent document %s was removed from the RAG database but its private Storage object cleanup failed",
                    document.id,
                )
        return document, storage_cleanup

    async def replace_agent_document_file(
        self,
        owner_id: UUID,
        document_id: UUID,
        *,
        filename: str,
        mime_type: str,
        content: bytes,
        source_metadata: dict[str, Any] | None = None,
    ) -> AgentDocumentAccepted:
        document = await self.repository.get_document(owner_id, document_id)
        if document is None:
            raise LookupError("Generated Docs document not found")
        self._require_agent_managed(document, "replaced")
        filename = safe_filename(filename)
        validate_document(filename, mime_type)
        if not content:
            raise ValueError("The replacement document is empty")
        if len(content) > self.settings.max_upload_bytes:
            raise ValueError(
                f"The replacement exceeds the {self.settings.max_upload_bytes} byte limit"
            )

        next_revision = document.revision + 1
        storage_path = (
            f"{owner_id}/{document.group_id}/{document.id}/"
            f"revision-{next_revision}/{filename}"
        )
        await self.storage.upload(
            self.settings.storage_bucket, storage_path, content, mime_type
        )
        try:
            resolved_id, job_id, revision, status = (
                await self.repository.replace_agent_document_file(
                    document_id=document.id,
                    job_id=uuid4(),
                    owner_id=owner_id,
                    filename=filename,
                    mime_type=mime_type or "application/octet-stream",
                    bucket=self.settings.storage_bucket,
                    storage_path=storage_path,
                    size_bytes=len(content),
                    sha256=hashlib.sha256(content).hexdigest(),
                    source_metadata=source_metadata or {"replaced_by": "Hermes"},
                )
            )
        except Exception:
            try:
                await self.storage.remove(self.settings.storage_bucket, storage_path)
            except Exception:
                logger.exception(
                    "Failed to roll back replacement Storage object %s", storage_path
                )
            raise

        if document.storage_bucket and document.storage_path:
            try:
                await self.storage.remove(document.storage_bucket, document.storage_path)
            except Exception:
                logger.exception(
                    "Replaced agent document %s, but its superseded Storage object could not be removed",
                    document.id,
                )
        return AgentDocumentAccepted(
            document_id=resolved_id,
            job_id=job_id,
            filename=filename,
            group=document.group_name or GENERATED_GROUP_NAME,
            status=status,
            revision=revision,
        )

    async def set_agent_document_archived(
        self, owner_id: UUID, document_id: UUID, archived: bool
    ) -> Document:
        document = await self.repository.get_document(owner_id, document_id)
        if document is None:
            raise LookupError("Generated Docs document not found")
        self._require_agent_managed(document, "archived or restored")
        if not await self.repository.set_agent_document_archived(
            owner_id, document.id, archived
        ):
            raise LookupError("Generated Docs document not found")
        refreshed = await self.repository.get_document(owner_id, document.id)
        if refreshed is None:
            raise LookupError("Generated Docs document not found")
        return refreshed

    async def delete_document_as_operator(
        self, owner_id: UUID, document_id: UUID
    ) -> tuple[Document, str]:
        document = await self.repository.get_document(owner_id, document_id)
        if document is None:
            raise LookupError("Document not found")
        if not await self.repository.delete_document_as_operator(owner_id, document.id):
            raise LookupError("Document not found")

        storage_cleanup = "not_required"
        if document.storage_bucket and document.storage_path:
            try:
                await self.storage.remove(document.storage_bucket, document.storage_path)
                storage_cleanup = "completed"
            except Exception:
                storage_cleanup = "failed"
                logger.exception(
                    "Document %s was removed from the RAG database but its private Storage object cleanup failed",
                    document.id,
                )
        return document, storage_cleanup

    async def ingest(
        self,
        owner_id: UUID,
        *,
        group_identifier: str,
        filename: str,
        mime_type: str,
        content: bytes,
        source: str,
        source_metadata: dict[str, Any] | None = None,
        created_by_agent: bool = False,
    ) -> IngestAccepted:
        if source not in {"portal", "hermes", "email", "api", "url"}:
            raise ValueError("source must be portal, hermes, email, api, or url")
        filename = safe_filename(filename)
        validate_document(filename, mime_type)
        if not content:
            raise ValueError("The uploaded document is empty")
        if len(content) > self.settings.max_upload_bytes:
            raise ValueError(
                f"The upload exceeds the {self.settings.max_upload_bytes} byte limit"
            )
        if created_by_agent and slugify(group_identifier) == GENERATED_GROUP_SLUG:
            group = await self.ensure_generated_group(owner_id)
        else:
            group = await self.resolve_group(owner_id, group_identifier)
        agent_managed = created_by_agent and group.system_key == GENERATED_GROUP_KEY
        digest = hashlib.sha256(content).hexdigest()
        proposed_document_id = uuid4()
        proposed_job_id = uuid4()
        storage_path = f"{owner_id}/{group.id}/{proposed_document_id}/{filename}"
        (
            document_id,
            job_id,
            duplicate,
            document_status,
        ) = await self.repository.create_document_job(
            document_id=proposed_document_id,
            job_id=proposed_job_id,
            owner_id=owner_id,
            group_id=group.id,
            filename=filename,
            mime_type=mime_type or "application/octet-stream",
            bucket=self.settings.storage_bucket,
            storage_path=storage_path,
            size_bytes=len(content),
            sha256=digest,
            source=source,
            source_metadata=source_metadata or {},
            created_by_agent=agent_managed,
        )
        retried = False
        if duplicate and document_status == "failed":
            existing = await self.repository.get_document(owner_id, document_id)
            if existing is None:
                raise LookupError("Failed duplicate document disappeared")
            if source_metadata:
                await self.repository.update_document_source_metadata(
                    owner_id,
                    document_id,
                    {**existing.source_metadata, **source_metadata},
                )
            if (existing.error or "").startswith("Storage upload failed"):
                if not existing.storage_bucket or not existing.storage_path:
                    raise ValueError("Failed document has no Storage location")
                try:
                    await self.storage.download(
                        existing.storage_bucket, existing.storage_path
                    )
                except Exception:
                    await self.storage.upload(
                        existing.storage_bucket,
                        existing.storage_path,
                        content,
                        mime_type,
                    )
            job_id, retried, document_status = (
                await self.repository.retry_failed_document(
                    owner_id, document_id, proposed_job_id
                )
            )
        if not duplicate:
            try:
                await self.storage.upload(
                    self.settings.storage_bucket, storage_path, content, mime_type
                )
            except Exception as exc:
                await self.repository.fail_job(
                    owner_id, job_id, document_id, f"Storage upload failed: {exc}", 1
                )
                raise
        return IngestAccepted(
            document_id=document_id,
            job_id=job_id,
            group=group.name,
            status=document_status if duplicate else "queued",
            duplicate=duplicate,
            retried=retried,
        )

    async def process_job(
        self, owner_id: UUID, job_id: UUID, already_claimed: bool = False
    ) -> Job:
        job = await self.repository.get_job(owner_id, job_id)
        if job is None:
            raise LookupError("Ingestion job not found")
        if job.status == "completed":
            return job
        document = await self.repository.get_document(owner_id, job.document_id)
        if document is None:
            raise LookupError("Document for ingestion job not found")
        if job.document_revision != document.revision:
            await self.repository.fail_job(
                owner_id,
                job.id,
                document.id,
                "Superseded by a newer document revision",
                job.document_revision,
            )
            superseded = await self.repository.get_job(owner_id, job.id)
            if superseded is None:
                raise RuntimeError("Superseded job disappeared")
            return superseded
        if not already_claimed:
            await self.repository.start_job(owner_id, job.id, document.id)
        try:
            if document.document_kind == "generated":
                if not document.body_markdown or not document.title:
                    raise ValueError(
                        "Generated document is missing canonical Markdown or title"
                    )
                chunks = chunk_markdown(document.body_markdown, document.title)
                # A ready generated document promises both searchable text and a usable PDF.
                await self.render_generated_pdf(owner_id, document.id)
            else:
                if not document.storage_bucket or not document.storage_path:
                    raise ValueError(
                        "Uploaded document is missing its Storage location"
                    )
                raw = await self._download_when_storage_ready(
                    document.storage_bucket, document.storage_path
                )
                processing_mode = str(
                    document.source_metadata.get(
                        "processing_mode", AUTOMATIC_PROCESSING
                    )
                )
                if (
                    processing_mode in AI_PROCESSING_MODES
                    and document.filename.casefold().endswith(".pdf")
                ):
                    text = await self.ai_extractor.extract_pdf(
                        document.filename, raw, processing_mode
                    )
                else:
                    text = extract_text(
                        document.filename,
                        document.mime_type,
                        raw,
                        pdf_ocr_enabled=self.settings.local_pdf_ocr_enabled,
                        pdf_ocr_languages=self.settings.ocr_languages,
                        pdf_ocr_dpi=self.settings.ocr_dpi,
                        pdf_ocr_min_embedded_chars=(
                            self.settings.ocr_min_embedded_chars
                        ),
                        pdf_ocr_page_timeout_seconds=(
                            self.settings.ocr_page_timeout_seconds
                        ),
                    )
                chunks = chunk_text(text)
            if not chunks:
                raise ValueError("Document produced no searchable chunks")
            embeddings: list[list[float]] = []
            for start in range(0, len(chunks), self.settings.embed_batch_size):
                embeddings.extend(
                    await self.embedder.embed(
                        [
                            chunk.content
                            for chunk in chunks[
                                start : start + self.settings.embed_batch_size
                            ]
                        ]
                    )
                )
            records = [
                {
                    "owner_id": str(owner_id),
                    "document_id": str(document.id),
                    "group_id": str(document.group_id),
                    "chunk_index": chunk.index,
                    "content": chunk.content,
                    "word_count": chunk.word_count,
                    "embedding": vector_literal(embedding),
                    "metadata": {
                        "filename": document.filename,
                        "title": document.title,
                        "chunk_index": chunk.index,
                        "heading_path": list(chunk.heading_path),
                        "document_kind": document.document_kind,
                        "revision": document.revision,
                    },
                }
                for chunk, embedding in zip(chunks, embeddings, strict=True)
            ]
            await self.repository.replace_chunks(owner_id, document, records)
            await self.repository.complete_job(owner_id, job.id, document.id)
        except Exception as exc:
            await self.repository.fail_job(
                owner_id, job.id, document.id, str(exc), document.revision
            )
            raise
        completed = await self.repository.get_job(owner_id, job.id)
        if completed is None:
            raise RuntimeError("Completed job disappeared")
        return completed

    async def _download_when_storage_ready(self, bucket: str, path: str) -> bytes:
        for attempt in range(STORAGE_READINESS_ATTEMPTS):
            try:
                return await self.storage.download(bucket, path)
            except Exception as exc:
                is_pending_upload = "NoSuchKey" in str(exc)
                is_last_attempt = attempt == STORAGE_READINESS_ATTEMPTS - 1
                if not is_pending_upload or is_last_attempt:
                    raise
                delay_seconds = min(0.5 * (2**attempt), 4.0)
                logger.info(
                    "Storage object %s is not visible yet; retrying in %.1f seconds",
                    path,
                    delay_seconds,
                )
                await asyncio.sleep(delay_seconds)
        raise RuntimeError("Storage readiness retry loop exited unexpectedly")

    async def _route(
        self, owner_id: UUID, request: SearchRequest, query_embedding: list[float]
    ) -> tuple[list[RouteCandidate], str, bool]:
        groups = await self.repository.list_groups(owner_id)
        if not groups:
            raise LookupError("No RAG groups exist yet")
        for identifier, reason in (
            (request.group, "explicit group"),
            (request.session_group, "session group"),
        ):
            if identifier:
                group = match_group(groups, identifier)
                if group is None:
                    raise LookupError(f"Unknown RAG group: {identifier}")
                return (
                    [
                        RouteCandidate(
                            id=group.id, name=group.name, slug=group.slug, score=1.0
                        )
                    ],
                    reason,
                    False,
                )

        ranked = await self.repository.rank_groups(owner_id, query_embedding, limit=10)
        generated = next(
            (group for group in groups if group.system_key == GENERATED_GROUP_KEY), None
        )
        ranked = [
            candidate
            for candidate in ranked
            if generated is None or candidate.id != generated.id
        ]
        if not ranked:
            if request.include_generated and generated:
                return (
                    [
                        RouteCandidate(
                            id=generated.id,
                            name=generated.name,
                            slug=generated.slug,
                            score=1.0,
                        )
                    ],
                    "Generated Docs retrieval",
                    False,
                )
            raise LookupError("No non-generated groups have routing embeddings")
        if len(ranked) == 1:
            routed, reason, ambiguous = ranked, "automatic group routing", False
        else:
            margin = ranked[0].score - ranked[1].score
            if (
                ranked[0].score >= self.settings.route_min_score
                and margin >= self.settings.route_min_margin
            ):
                routed, reason, ambiguous = ranked[:1], "automatic group routing", False
            else:
                routed, reason, ambiguous = (
                    ranked[:2],
                    "ambiguous automatic routing; searched the two closest groups",
                    True,
                )
        if request.include_generated:
            if generated is None:
                generated = await self.ensure_generated_group(owner_id)
            if all(candidate.id != generated.id for candidate in routed):
                routed.append(
                    RouteCandidate(
                        id=generated.id,
                        name=generated.name,
                        slug=generated.slug,
                        score=1.0,
                    )
                )
            reason += " plus Generated Docs"
        return routed, reason, ambiguous

    async def search(self, owner_id: UUID, request: SearchRequest) -> SearchResponse:
        query_embedding = (await self.embedder.embed([request.query]))[0]
        routed, reason, ambiguous = await self._route(
            owner_id, request, query_embedding
        )
        hits = await self.repository.hybrid_search(
            owner_id,
            [candidate.id for candidate in routed],
            request.query,
            query_embedding,
            request.limit,
        )
        return SearchResponse(
            query=request.query,
            routing_reason=reason,
            ambiguous_group=ambiguous,
            searched_groups=routed,
            hits=hits,
        )

    async def list_documents(
        self, owner_id: UUID, group_identifier: str | None, limit: int,
        conversation_id: UUID | None = None,
    ) -> list[Document]:
        group_id = None
        if group_identifier:
            group_id = (await self.resolve_group(owner_id, group_identifier)).id
        return await self.repository.list_documents(owner_id, group_id, limit, conversation_id)

    async def generated_source(self, owner_id: UUID, document_id: UUID) -> Document:
        document = await self.repository.get_document(owner_id, document_id)
        if document is None:
            raise LookupError("Generated document not found")
        self._require_agent_managed(document, "read as Markdown")
        if document.document_kind != "generated" or document.archived_at or not document.body_markdown:
            raise ValueError("This document has no active generated Markdown source")
        return document

    async def signed_link(
        self, owner_id: UUID, document_id: UUID, expires_in: int | None
    ) -> SignedLink:
        document = await self.repository.get_document(owner_id, document_id)
        if document is None:
            raise LookupError("Document not found")
        if document.document_kind == "generated":
            ttl = expires_in or self.settings.generated_link_ttl_seconds
            ttl = max(300, min(ttl, self.settings.generated_link_max_ttl_seconds))
            expires_at = int(time.time()) + ttl
            signature = sign_generated_link(self.settings, document.id, expires_at)
            url = f"{self.settings.public_base_url}/share/documents/{document.id}/pdf?expires={expires_at}&sig={signature}"
            return SignedLink(
                document_id=document.id,
                filename=pdf_filename(document.title or document.filename),
                url=url,
                expires_in=ttl,
            )
        ttl = expires_in or self.settings.signed_url_ttl_seconds
        ttl = max(300, min(ttl, 86_400))
        if not document.storage_bucket or not document.storage_path:
            raise ValueError("Uploaded document is missing its Storage location")
        url = await self.storage.create_signed_download(
            document.storage_bucket, document.storage_path, document.filename, ttl
        )
        return SignedLink(
            document_id=document.id, filename=document.filename, url=url, expires_in=ttl
        )

    async def render_generated_pdf(
        self, owner_id: UUID, document_id: UUID
    ) -> tuple[Document, bytes]:
        document = await self.repository.get_document(owner_id, document_id)
        if document is None:
            raise LookupError("Generated document not found")
        if (
            document.document_kind != "generated"
            or not document.body_markdown
            or not document.title
        ):
            raise ValueError(
                "Only Hermes-generated Markdown documents can be rendered as PDF"
            )
        return document, await asyncio.to_thread(render_markdown_pdf,
            document.title, document.body_markdown, document.updated_at,
            author=str(document.source_metadata.get("authored_by") or "NorthPointe"),
        )
