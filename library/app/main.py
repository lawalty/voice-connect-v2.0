from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any
from urllib.parse import quote, urlsplit
from uuid import UUID

import uvicorn
from fastapi import (
    BackgroundTasks,
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles

from app.config import Settings
from app.embeddings import SupabaseGteSmallEmbedder
from app.models import (
    AgentDocumentAccepted,
    AgentDocumentArchive,
    Document,
    GeneratedDocumentAccepted,
    GeneratedDocumentCreate,
    GeneratedDocumentUpdate,
    Group,
    GroupCreate,
    GroupUpdate,
    IngestAccepted,
    Job,
    ProcessingMode,
    SearchRequest,
    SearchResponse,
    SignedLink,
    UrlIngestRequest,
)
from app.pdf_renderer import pdf_filename
from app.security import Authenticator, Principal, verify_generated_link
from app.service import RagService
from app.supabase_backend import SupabaseError, SupabaseRepository, SupabaseStorage
from app.url_ingestion import UrlDocumentFetcher, redact_url_for_storage


class RevalidatingStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope: Any) -> Response:
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-store, max-age=0, must-revalidate"
        return response


def build_service(settings: Settings) -> RagService:
    return RagService(
        settings=settings,
        repository=SupabaseRepository(settings),
        storage=SupabaseStorage(settings),
        embedder=SupabaseGteSmallEmbedder(settings),
    )


def create_app(
    settings: Settings | None = None,
    service: RagService | None = None,
    authenticator: Authenticator | None = None,
    url_fetcher: UrlDocumentFetcher | None = None,
) -> FastAPI:
    settings = settings or Settings.from_env()
    service = service or build_service(settings)
    authenticator = authenticator or Authenticator(settings)
    url_fetcher = url_fetcher or UrlDocumentFetcher(settings)
    app = FastAPI(title="Voice Connect Library", version="1.0.0")
    app.state.settings = settings
    app.state.rag_service = service

    async def principal(
        identity: Principal = Depends(authenticator.authenticate),
    ) -> Principal:
        return identity

    async def operator_principal(
        identity: Principal = Depends(principal),
    ) -> Principal:
        if identity.access_level != "operator":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This action requires a human operator session",
            )
        return identity

    async def agent_principal(
        identity: Principal = Depends(principal),
    ) -> Principal:
        if identity.access_level != "agent":
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This action requires the trusted agent session",
            )
        return identity

    def as_http_error(exc: Exception) -> HTTPException:
        if isinstance(exc, LookupError):
            return HTTPException(status_code=404, detail=str(exc))
        if isinstance(exc, ValueError):
            return HTTPException(status_code=400, detail=str(exc))
        if isinstance(exc, SupabaseError) and "already exists" in str(exc).casefold():
            return HTTPException(status_code=409, detail=str(exc))
        return HTTPException(status_code=502, detail="The library backend could not complete this request.")

    @app.get("/healthz")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "voice-connect-library"}

    @app.get("/v1/groups", response_model=list[Group])
    async def list_groups(identity: Principal = Depends(principal)) -> list[Group]:
        return await service.list_groups(identity.owner_id)

    @app.post("/v1/groups", response_model=Group, status_code=status.HTTP_201_CREATED)
    async def create_group(
        body: GroupCreate,
        identity: Principal = Depends(principal),
    ) -> Group:
        try:
            return await service.create_group(identity.owner_id, body)
        except Exception as exc:
            raise as_http_error(exc) from exc

    @app.post(
        "/v1/ingest/upload",
        response_model=IngestAccepted,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def ingest_upload(
        background_tasks: BackgroundTasks,
        group: Annotated[str, Form(min_length=1, max_length=80)],
        file: Annotated[UploadFile, File()],
        source: Annotated[str, Form()] = "portal",
        source_metadata: Annotated[str, Form()] = "{}",
        processing_mode: Annotated[ProcessingMode, Form()] = "automatic",
        identity: Principal = Depends(principal),
    ) -> IngestAccepted:
        try:
            metadata: dict[str, Any] = json.loads(source_metadata)
            if not isinstance(metadata, dict):
                raise ValueError("source_metadata must be a JSON object")
            metadata["processing_mode"] = processing_mode
            content = await file.read(settings.max_upload_bytes + 1)
            is_agent_managed_submission = (
                identity.access_level == "agent" and source != "email"
            )
            trusted_source = (
                "hermes"
                if is_agent_managed_submission
                else ("portal" if source == "hermes" else source)
            )
            accepted = await service.ingest(
                identity.owner_id,
                group_identifier=group,
                filename=file.filename or "document.txt",
                mime_type=file.content_type or "application/octet-stream",
                content=content,
                source=trusted_source,
                source_metadata=metadata,
                created_by_agent=is_agent_managed_submission,
            )
            if settings.inline_worker and (
                not accepted.duplicate or accepted.retried
            ):
                background_tasks.add_task(
                    service.process_job, identity.owner_id, accepted.job_id
                )
            return accepted
        except Exception as exc:
            raise as_http_error(exc) from exc
        finally:
            await file.close()

    @app.post(
        "/v1/ingest/raw",
        response_model=IngestAccepted,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def ingest_raw(
        request: Request,
        background_tasks: BackgroundTasks,
        group: str = Query(min_length=1, max_length=80),
        filename: str = Query(min_length=1, max_length=255),
        processing_mode: ProcessingMode = Query(default="automatic"),
        identity: Principal = Depends(principal),
    ) -> IngestAccepted:
        try:
            content = bytearray()
            async for chunk in request.stream():
                if len(content) + len(chunk) > settings.max_upload_bytes:
                    raise ValueError(
                        f"File exceeds the {settings.max_upload_bytes // (1024 * 1024)} MB upload limit"
                    )
                content.extend(chunk)
            if not content:
                raise ValueError("The uploaded file is empty")
            accepted = await service.ingest(
                identity.owner_id,
                group_identifier=group,
                filename=filename,
                mime_type=request.headers.get(
                    "content-type", "application/octet-stream"
                ).split(";", 1)[0].strip(),
                content=bytes(content),
                source="portal",
                source_metadata={"processing_mode": processing_mode},
                created_by_agent=False,
            )
            if settings.inline_worker and (
                not accepted.duplicate or accepted.retried
            ):
                background_tasks.add_task(
                    service.process_job, identity.owner_id, accepted.job_id
                )
            return accepted
        except Exception as exc:
            raise as_http_error(exc) from exc

    @app.post(
        "/v1/ingest/url",
        response_model=IngestAccepted,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def ingest_url(
        body: UrlIngestRequest,
        background_tasks: BackgroundTasks,
        identity: Principal = Depends(principal),
    ) -> IngestAccepted:
        try:
            fetched = await url_fetcher.fetch(body.url)
            accepted = await service.ingest(
                identity.owner_id,
                group_identifier=body.group,
                filename=fetched.filename,
                mime_type=fetched.mime_type,
                content=fetched.content,
                source="url",
                source_metadata={
                    "requested_url": redact_url_for_storage(fetched.requested_url),
                    "final_url": redact_url_for_storage(fetched.final_url),
                    "url_query_redacted": bool(
                        urlsplit(fetched.requested_url).query
                        or urlsplit(fetched.final_url).query
                    ),
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                    "content_type": fetched.mime_type,
                    "processing_mode": body.processing_mode,
                },
                created_by_agent=identity.access_level == "agent",
            )
            if settings.inline_worker and (
                not accepted.duplicate or accepted.retried
            ):
                background_tasks.add_task(
                    service.process_job, identity.owner_id, accepted.job_id
                )
            return accepted
        except Exception as exc:
            raise as_http_error(exc) from exc

    @app.patch("/v1/groups/{group_id}", response_model=Group)
    async def update_group(
        group_id: UUID,
        body: GroupUpdate,
        identity: Principal = Depends(principal),
    ) -> Group:
        try:
            return await service.update_group(identity.owner_id, group_id, body)
        except Exception as exc:
            raise as_http_error(exc) from exc

    @app.post(
        "/v1/generated-documents",
        response_model=GeneratedDocumentAccepted,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_generated_document(
        body: GeneratedDocumentCreate,
        background_tasks: BackgroundTasks,
        identity: Principal = Depends(agent_principal),
    ) -> GeneratedDocumentAccepted:
        try:
            accepted = await service.create_generated_document(
                identity.owner_id,
                title=body.title,
                markdown=body.markdown,
                source_metadata={
                    "authored_by": "NorthPointe",
                    "canonical_format": "markdown",
                    "vc_conversation_ids": [str(body.conversation_id)] if body.conversation_id else [],
                },
            )
            if settings.inline_worker:
                background_tasks.add_task(
                    service.process_job, identity.owner_id, accepted.job_id
                )
            return accepted
        except Exception as exc:
            raise as_http_error(exc) from exc

    @app.get(
        "/v1/generated-documents/resolve",
        response_model=Document,
        response_model_exclude={"body_markdown", "generated_title_key"},
    )
    async def resolve_generated_document(
        title: str = Query(min_length=1, max_length=120),
        identity: Principal = Depends(agent_principal),
    ) -> Document:
        try:
            return await service.resolve_generated_document(identity.owner_id, title)
        except Exception as exc:
            raise as_http_error(exc) from exc

    @app.put(
        "/v1/generated-documents/{document_id}",
        response_model=GeneratedDocumentAccepted,
    )
    async def revise_generated_document(
        document_id: UUID,
        body: GeneratedDocumentUpdate,
        background_tasks: BackgroundTasks,
        identity: Principal = Depends(agent_principal),
    ) -> GeneratedDocumentAccepted:
        try:
            accepted = await service.revise_generated_document(
                identity.owner_id,
                document_id,
                title=body.title,
                markdown=body.markdown,
                conversation_id=body.conversation_id,
            )
            if settings.inline_worker:
                background_tasks.add_task(
                    service.process_job, identity.owner_id, accepted.job_id
                )
            return accepted
        except Exception as exc:
            raise as_http_error(exc) from exc

    @app.get("/v1/generated-documents/{document_id}/source")
    async def generated_source(
        document_id: UUID,
        identity: Principal = Depends(agent_principal),
    ) -> dict[str, Any]:
        try:
            document = await service.generated_source(identity.owner_id, document_id)
            return document.model_dump(mode="json", include={"id", "title", "body_markdown", "revision", "status"})
        except Exception as exc:
            raise as_http_error(exc) from exc

    @app.delete("/v1/generated-documents/{document_id}")
    async def delete_generated_document(
        document_id: UUID,
        identity: Principal = Depends(agent_principal),
    ) -> dict[str, Any]:
        try:
            document, storage_cleanup = await service.delete_generated_document(
                identity.owner_id, document_id
            )
            return {
                "success": True,
                "document_id": str(document.id),
                "title": document.title,
                "group": document.group_name,
                "storage_cleanup": storage_cleanup,
                "status": "removed",
            }
        except Exception as exc:
            raise as_http_error(exc) from exc

    @app.put(
        "/v1/generated-documents/{document_id}/file",
        response_model=AgentDocumentAccepted,
    )
    async def replace_agent_document_file(
        document_id: UUID,
        background_tasks: BackgroundTasks,
        file: Annotated[UploadFile, File()],
        source_metadata: Annotated[str, Form()] = "{}",
        identity: Principal = Depends(agent_principal),
    ) -> AgentDocumentAccepted:
        try:
            metadata: dict[str, Any] = json.loads(source_metadata)
            if not isinstance(metadata, dict):
                raise ValueError("source_metadata must be a JSON object")
            content = await file.read(settings.max_upload_bytes + 1)
            accepted = await service.replace_agent_document_file(
                identity.owner_id,
                document_id,
                filename=file.filename or "document.txt",
                mime_type=file.content_type or "application/octet-stream",
                content=content,
                source_metadata=metadata,
            )
            if settings.inline_worker:
                background_tasks.add_task(
                    service.process_job, identity.owner_id, accepted.job_id
                )
            return accepted
        except Exception as exc:
            raise as_http_error(exc) from exc
        finally:
            await file.close()

    @app.patch("/v1/generated-documents/{document_id}/archive")
    async def archive_agent_document(
        document_id: UUID,
        body: AgentDocumentArchive,
        identity: Principal = Depends(agent_principal),
    ) -> dict[str, Any]:
        try:
            document = await service.set_agent_document_archived(
                identity.owner_id, document_id, body.archived
            )
            return {
                "success": True,
                "document_id": str(document.id),
                "title": document.title,
                "filename": document.filename,
                "group": document.group_name,
                "archived": document.archived_at is not None,
                "status": "archived" if document.archived_at else "active",
            }
        except Exception as exc:
            raise as_http_error(exc) from exc

    @app.delete("/v1/documents/{document_id}")
    async def delete_document_as_operator(
        document_id: UUID,
        identity: Principal = Depends(operator_principal),
    ) -> dict[str, Any]:
        try:
            document, storage_cleanup = await service.delete_document_as_operator(
                identity.owner_id, document_id
            )
            return {
                "success": True,
                "document_id": str(document.id),
                "filename": document.filename,
                "title": document.title,
                "group": document.group_name,
                "document_kind": document.document_kind,
                "storage_cleanup": storage_cleanup,
                "status": "removed",
            }
        except Exception as exc:
            raise as_http_error(exc) from exc

    @app.get("/v1/jobs/{job_id}", response_model=Job)
    async def ingestion_status(
        job_id: UUID,
        identity: Principal = Depends(principal),
    ) -> Job:
        job = await service.repository.get_job(identity.owner_id, job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Ingestion job not found")
        return job

    @app.post("/v1/search", response_model=SearchResponse)
    async def search(
        body: SearchRequest,
        identity: Principal = Depends(principal),
    ) -> SearchResponse:
        try:
            return await service.search(identity.owner_id, body)
        except Exception as exc:
            raise as_http_error(exc) from exc

    @app.get("/v1/documents")
    async def list_documents(
        identity: Principal = Depends(principal),
        group: str | None = Query(default=None, max_length=80),
        limit: int = Query(default=50, ge=1, le=200),
        conversation_id: UUID | None = Query(default=None),
    ) -> list[dict[str, Any]]:
        try:
            documents = await service.list_documents(identity.owner_id, group, limit, conversation_id)
            return [
                document.model_dump(
                    mode="json",
                    exclude={"body_markdown", "generated_title_key"},
                )
                for document in documents
            ]
        except Exception as exc:
            raise as_http_error(exc) from exc

    @app.post("/v1/documents/{document_id}/signed-link", response_model=SignedLink)
    async def signed_link(
        document_id: UUID,
        expires_in: int | None = Query(default=None, ge=300, le=604_800),
        identity: Principal = Depends(principal),
    ) -> SignedLink:
        try:
            return await service.signed_link(identity.owner_id, document_id, expires_in)
        except Exception as exc:
            raise as_http_error(exc) from exc

    def pdf_response(document: Document, payload: bytes) -> Response:
        filename = pdf_filename(document.title or document.filename)
        disposition = f"inline; filename*=UTF-8''{quote(filename)}"
        return Response(
            payload,
            media_type="application/pdf",
            headers={
                "Content-Disposition": disposition,
                "Cache-Control": "private, no-store, max-age=0, must-revalidate",
                "Pragma": "no-cache",
                "X-Content-Type-Options": "nosniff",
                "X-Hermes-Document-Revision": str(document.revision),
            },
        )

    @app.get("/v1/documents/{document_id}/pdf")
    async def authenticated_pdf(
        document_id: UUID,
        identity: Principal = Depends(principal),
    ) -> Response:
        try:
            document, payload = await service.render_generated_pdf(
                identity.owner_id, document_id
            )
            return pdf_response(document, payload)
        except Exception as exc:
            raise as_http_error(exc) from exc

    @app.get("/share/documents/{document_id}/pdf")
    async def shared_pdf(
        document_id: UUID,
        expires: int = Query(gt=0),
        sig: str = Query(min_length=64, max_length=64),
    ) -> Response:
        if not verify_generated_link(settings, document_id, expires, sig):
            raise HTTPException(
                status_code=401, detail="The document link is invalid or expired"
            )
        try:
            document, payload = await service.render_generated_pdf(
                settings.owner_user_id, document_id
            )
            return pdf_response(document, payload)
        except Exception as exc:
            raise as_http_error(exc) from exc

    static_dir = Path(__file__).parent / "static"

    @app.get("/rag/", include_in_schema=False)
    async def voice_connect_portal(request: Request) -> Response:
        try:
            await authenticator.voice_connect.authenticate(request)
        except HTTPException as exc:
            if exc.status_code == 401:
                return RedirectResponse(url="/", status_code=303)
            raise
        return FileResponse(
            static_dir / "index.html",
            media_type="text/html; charset=utf-8",
            headers={"Cache-Control": "no-store, max-age=0, must-revalidate"},
        )

    app.mount(
        "/rag",
        RevalidatingStaticFiles(directory=static_dir, html=True),
        name="rag-portal",
    )

    @app.get("/", include_in_schema=False)
    async def root() -> RedirectResponse:
        return RedirectResponse(url="/rag/")

    return app


def run() -> None:
    uvicorn.run("app.main:create_app", factory=True, host="127.0.0.1", port=8787)


if __name__ == "__main__":
    run()
