from __future__ import annotations

import io
from urllib.parse import urlsplit

import pytest
from fastapi.testclient import TestClient
from pypdf import PdfReader

from app.main import create_app
from app.markdown_ir import parse_markdown
from app.models import SearchRequest
from app.security import Authenticator
from tests.conftest import OWNER_ID
from tests.fakes import FakeRepository, FakeStorage

SAMPLE_MARKDOWN = """# Meeting Summary

## Decisions

- Adopt the canonical Markdown pipeline.
- Keep generated documents in their own group.

> The PDF is a rendered view, not the source of truth.

| Field | Value |
| --- | --- |
| Group | Generated Docs |
| Format | Markdown |

```python
print("searchable")
```

Read the [vector guidance](https://supabase.com/docs/guides/ai/vector-columns).
"""


def test_markdown_renderer_keeps_only_safe_external_source_links() -> None:
    parsed = parse_markdown(
        "[safe](https://example.com/reference) and [unsafe](javascript:alert(1))"
    )
    assert parsed.links == ("https://example.com/reference",)
    assert 'href="javascript:' not in "".join(block.markup for block in parsed.blocks)


@pytest.mark.asyncio
async def test_generated_document_uses_markdown_path_indexes_renders_and_deletes(
    service,
    repository: FakeRepository,
    storage: FakeStorage,
) -> None:
    accepted = await service.create_generated_document(
        OWNER_ID,
        title="Meeting Summary",
        markdown=SAMPLE_MARKDOWN,
    )
    assert accepted.group == "Generated Docs"
    assert storage.objects == {}
    document = repository.documents[accepted.document_id]
    assert document.document_kind == "generated"
    assert document.created_by_agent is True
    assert document.storage_path is None
    assert document.body_markdown == SAMPLE_MARKDOWN.strip()

    completed = await service.process_job(OWNER_ID, accepted.job_id)
    assert completed.status == "completed"
    chunks = repository.chunks[accepted.document_id]
    assert any(record["metadata"]["heading_path"] == ["Decisions"] for record in chunks)
    assert all(record["metadata"]["document_kind"] == "generated" for record in chunks)

    search = await service.search(
        OWNER_ID,
        SearchRequest(
            query="What format is the canonical document?", group="Generated Docs"
        ),
    )
    assert search.hits and search.hits[0].group_name == "Generated Docs"

    rendered_document, payload = await service.render_generated_pdf(
        OWNER_ID, accepted.document_id
    )
    assert rendered_document.title == "Meeting Summary"
    reader = PdfReader(io.BytesIO(payload))
    assert len(reader.pages) >= 1
    text = "\n".join(page.extract_text() or "" for page in reader.pages)
    assert "Meeting Summary" in text
    assert "Generated Docs" in text
    assert "Sources" in text

    resolved = await service.resolve_generated_document(OWNER_ID, "meeting")
    assert resolved.id == accepted.document_id
    revised = await service.revise_generated_document(
        OWNER_ID,
        accepted.document_id,
        title="Canonical Meeting Notes",
        markdown="# Canonical Meeting Notes\n\n## Result\n\nThe revised body is searchable.",
    )
    assert revised.document_id == accepted.document_id
    assert revised.revision == 2
    await service.process_job(OWNER_ID, revised.job_id)
    assert all(
        "PDF is a rendered view" not in record["content"]
        for record in repository.chunks[accepted.document_id]
    )
    assert any(
        "revised body" in record["content"]
        for record in repository.chunks[accepted.document_id]
    )

    removed, storage_cleanup = await service.delete_generated_document(
        OWNER_ID, accepted.document_id
    )
    assert removed.title == "Canonical Meeting Notes"
    assert storage_cleanup == "not_required"
    assert accepted.document_id not in repository.documents


@pytest.mark.asyncio
async def test_generated_title_uniqueness_and_upload_guardrail(service) -> None:
    await service.create_generated_document(
        OWNER_ID, title="Weekly Brief", markdown="A durable brief."
    )
    with pytest.raises(ValueError, match="already exists"):
        await service.create_generated_document(
            OWNER_ID, title=" weekly   brief ", markdown="Different body."
        )

    upload = await service.ingest(
        OWNER_ID,
        group_identifier="Personal",
        filename="upload.txt",
        mime_type="text/plain",
        content=b"Uploaded originals are protected.",
        source="api",
    )
    with pytest.raises(ValueError, match="Only documents created or placed by Hermes"):
        await service.delete_generated_document(OWNER_ID, upload.document_id)


@pytest.mark.asyncio
async def test_generated_deletion_rejects_forged_or_missing_agent_provenance(
    service, repository
) -> None:
    accepted = await service.create_generated_document(
        OWNER_ID, title="Protected Draft", markdown="Agent-authored content."
    )
    document = repository.documents[accepted.document_id]
    repository.documents[accepted.document_id] = document.model_copy(
        update={"created_by_agent": False}
    )

    with pytest.raises(ValueError, match="Only documents created or placed by Hermes"):
        await service.delete_generated_document(OWNER_ID, accepted.document_id)


@pytest.mark.asyncio
async def test_agent_uploaded_artifact_in_generated_docs_keeps_agent_authority(
    service,
    repository: FakeRepository,
    storage: FakeStorage,
) -> None:
    accepted = await service.ingest(
        OWNER_ID,
        group_identifier="Generated Docs",
        filename="sermon-draft.pdf",
        mime_type="application/pdf",
        content=b"%PDF-1.4 agent draft",
        source="hermes",
        source_metadata={"local_path": "/tmp/sermon-draft.pdf"},
        created_by_agent=True,
    )
    document = await repository.get_document(OWNER_ID, accepted.document_id)
    assert document is not None
    assert document.document_kind == "upload"
    assert document.created_by_agent is True
    assert document.group_system_key == "hermes-generated-documents"
    assert document.source_metadata["local_path"].endswith("sermon-draft.pdf")

    link = await service.signed_link(OWNER_ID, document.id, 3600)
    assert link.filename == "sermon-draft.pdf"
    storage_key = (document.storage_bucket, document.storage_path)
    assert storage_key in storage.objects

    removed, storage_cleanup = await service.delete_generated_document(
        OWNER_ID, document.id
    )
    assert removed.id == document.id
    assert storage_cleanup == "completed"
    assert storage_key not in storage.objects


@pytest.mark.asyncio
async def test_storage_shape_does_not_block_revise_replace_archive_or_restore(
    service,
    repository: FakeRepository,
    storage: FakeStorage,
) -> None:
    accepted = await service.ingest(
        OWNER_ID,
        group_identifier="Generated Docs",
        filename="draft.md",
        mime_type="text/markdown",
        content=b"# Draft\n\nOriginal.",
        source="hermes",
        created_by_agent=True,
    )
    original = await repository.get_document(OWNER_ID, accepted.document_id)
    assert original is not None
    original_storage_key = (original.storage_bucket, original.storage_path)

    revised = await service.revise_generated_document(
        OWNER_ID,
        original.id,
        title="Revised Draft",
        markdown="# Revised Draft\n\nCanonical revision.",
    )
    assert revised.document_id == original.id
    assert revised.revision == 2
    revised_document = await repository.get_document(OWNER_ID, original.id)
    assert revised_document is not None
    assert revised_document.document_kind == "generated"
    assert revised_document.created_by_agent is True
    assert revised_document.body_markdown is not None
    assert original_storage_key not in storage.objects

    replaced = await service.replace_agent_document_file(
        OWNER_ID,
        original.id,
        filename="final.txt",
        mime_type="text/plain",
        content=b"Final replacement is searchable.",
    )
    assert replaced.document_id == original.id
    replacement = await repository.get_document(OWNER_ID, original.id)
    assert replacement is not None
    assert replacement.document_kind == "upload"
    assert replacement.created_by_agent is True
    replacement_key = (replacement.storage_bucket, replacement.storage_path)
    assert replacement_key in storage.objects

    await service.process_job(OWNER_ID, replaced.job_id)
    active_search = await service.search(
        OWNER_ID,
        SearchRequest(query="What is the final replacement?", group="Generated Docs"),
    )
    assert any(hit.document_id == original.id for hit in active_search.hits)

    archived = await service.set_agent_document_archived(OWNER_ID, original.id, True)
    assert archived.archived_at is not None
    archived_link = await service.signed_link(OWNER_ID, original.id, 3600)
    assert archived_link.filename == "final.txt"
    archived_search = await service.search(
        OWNER_ID,
        SearchRequest(query="What is the final replacement?", group="Generated Docs"),
    )
    assert all(hit.document_id != original.id for hit in archived_search.hits)

    restored = await service.set_agent_document_archived(OWNER_ID, original.id, False)
    assert restored.archived_at is None
    restored_search = await service.search(
        OWNER_ID,
        SearchRequest(query="What is the final replacement?", group="Generated Docs"),
    )
    assert any(hit.document_id == original.id for hit in restored_search.hits)


@pytest.mark.asyncio
async def test_human_uploads_and_documents_outside_generated_docs_stay_protected(
    service,
) -> None:
    await service.ensure_generated_group(OWNER_ID)
    staff_upload = await service.ingest(
        OWNER_ID,
        group_identifier="Generated Docs",
        filename="staff-policy.txt",
        mime_type="text/plain",
        content=b"Human-controlled source.",
        source="portal",
        created_by_agent=False,
    )
    outside = await service.ingest(
        OWNER_ID,
        group_identifier="Personal",
        filename="personal.txt",
        mime_type="text/plain",
        content=b"Outside Generated Docs.",
        source="hermes",
        created_by_agent=True,
    )

    for document_id in (staff_upload.document_id, outside.document_id):
        with pytest.raises(
            ValueError, match="Only documents created or placed by Hermes"
        ):
            await service.delete_generated_document(OWNER_ID, document_id)


@pytest.mark.asyncio
async def test_include_generated_adds_reserved_group_to_automatic_search(
    service,
) -> None:
    accepted = await service.create_generated_document(
        OWNER_ID,
        title="Project North Star",
        markdown="The north star is reliable downloadable knowledge.",
    )
    await service.process_job(OWNER_ID, accepted.job_id)
    result = await service.search(
        OWNER_ID,
        SearchRequest(
            query="What did Hermes write about the north star?", include_generated=True
        ),
    )
    assert "Generated Docs" in [group.name for group in result.searched_groups]
    assert any(hit.document_id == accepted.document_id for hit in result.hits)


def test_generated_api_returns_pdf_and_rejects_tampered_share_link(
    settings, service
) -> None:
    client = TestClient(create_app(settings, service, Authenticator(settings)))
    headers = {"X-RAG-Token": settings.agent_api_token}
    created = client.post(
        "/v1/generated-documents",
        headers=headers,
        json={"title": "API Brief", "markdown": "# API Brief\n\nA rendered document."},
    )
    assert created.status_code == 202
    document_id = created.json()["document_id"]

    resolved = client.get(
        "/v1/generated-documents/resolve?title=API%20Brief",
        headers=headers,
    )
    assert resolved.status_code == 200
    assert "body_markdown" not in resolved.json()
    listed = client.get("/v1/documents?group=Generated%20Docs", headers=headers)
    assert listed.status_code == 200
    assert "body_markdown" not in listed.json()[0]

    pdf = client.get(f"/v1/documents/{document_id}/pdf", headers=headers)
    assert pdf.status_code == 200
    assert pdf.headers["content-type"].startswith("application/pdf")
    assert pdf.headers["cache-control"].startswith("private, no-store")

    link = client.post(
        f"/v1/documents/{document_id}/signed-link?expires_in=86400",
        headers=headers,
    ).json()["url"]
    split = urlsplit(link)
    shared = client.get(f"{split.path}?{split.query}")
    assert shared.status_code == 200
    last = "0" if split.query[-1] != "0" else "1"
    tampered = client.get(f"{split.path}?{split.query[:-1]}{last}")
    assert tampered.status_code == 401
