from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.security import Authenticator
from tests.conftest import OWNER_ID


@pytest.mark.asyncio
async def test_conversation_feed_is_owner_scoped_and_revision_keeps_original_association(service, repository):
    first, second = uuid4(), uuid4()
    accepted = await service.create_generated_document(OWNER_ID, title="QA notes", markdown="## Decision\n\nKeep the bridge open.", source_metadata={"vc_conversation_ids": [str(first)]})
    assert await service.list_documents(OWNER_ID, None, 200, second) == []
    pending = await service.list_documents(OWNER_ID, None, 200, first)
    assert pending[0].status == "pending" and pending[0].chunk_count == 0
    await service.process_job(OWNER_ID, accepted.job_id)
    ready = await service.list_documents(OWNER_ID, None, 200, first)
    assert ready[0].status == "ready" and ready[0].chunk_count > 0
    assert await service.list_documents(uuid4(), None, 200, first) == []
    source = await service.generated_source(OWNER_ID, accepted.document_id)
    assert "Keep the bridge" in source.body_markdown
    revised = await service.revise_generated_document(OWNER_ID, accepted.document_id, title="QA revised notes", markdown="## Decision\n\nInspect the bridge first.", conversation_id=second)
    assert revised.document_id == accepted.document_id and revised.revision == 2
    await service.process_job(OWNER_ID, revised.job_id)
    for conversation in [first, second]:
        items = await service.list_documents(OWNER_ID, None, 200, conversation)
        assert items[0].revision == 2 and items[0].chunk_count > 0
    await service.set_agent_document_archived(OWNER_ID, accepted.document_id, True)
    assert await service.list_documents(OWNER_ID, None, 200, first) == []
    with pytest.raises(ValueError):
        await service.generated_source(OWNER_ID, accepted.document_id)


@pytest.mark.asyncio
async def test_pdf_failure_cannot_be_marked_ready(service, repository, monkeypatch):
    accepted = await service.create_generated_document(OWNER_ID, title="Invalid PDF fixture", markdown="Saved source stays available.")
    async def fail(*args):
        raise ValueError("PDF render fixture failure")
    monkeypatch.setattr(service, "render_generated_pdf", fail)
    with pytest.raises(ValueError, match="PDF render fixture failure"):
        await service.process_job(OWNER_ID, accepted.job_id)
    assert repository.jobs[accepted.job_id].status == "failed"
    assert repository.documents[accepted.document_id].status == "failed"
    assert not repository.chunks.get(accepted.document_id)


def test_source_endpoint_requires_agent_token_and_feed_never_exposes_markdown(settings, service):
    app = create_app(settings=settings, service=service, authenticator=Authenticator(settings))
    with TestClient(app) as client:
        conversation = str(uuid4())
        headers = {"X-RAG-Token": settings.agent_api_token}
        created = client.post('/v1/generated-documents', headers=headers, json={"title": "API QA", "markdown": "Private full source.", "conversation_id": conversation})
        assert created.status_code == 202
        document_id = created.json()['document_id']
        path = f'/v1/generated-documents/{document_id}/source'
        assert client.get(path).status_code == 401
        assert client.get(path, headers={"X-RAG-Token": settings.api_token}).status_code == 403
        assert client.get(path, headers=headers).json()['body_markdown'] == 'Private full source.'
        feed = client.get('/v1/documents', headers=headers, params={"conversation_id": conversation}).json()
        assert len(feed) == 1 and 'body_markdown' not in feed[0]
