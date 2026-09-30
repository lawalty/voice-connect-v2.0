import io
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from docx import Document as WordDocument
from fastapi.testclient import TestClient

from app.main import create_app
from app.pdf_renderer import render_markdown_pdf
from app.security import Authenticator
from tests.conftest import OWNER_ID


def original_file(extension):
    if extension == 'pdf':
        return render_markdown_pdf('Original sermon', 'Keep the full original sermon.'), 'application/pdf'
    if extension == 'docx':
        document = WordDocument()
        document.add_paragraph('Keep the full original sermon.')
        output = io.BytesIO()
        document.save(output)
        return output.getvalue(), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    if extension == 'html':
        return b'<h1>Original sermon</h1><p>Keep the full original sermon.</p>', 'text/html'
    return b'Original sermon. Keep the full original sermon.', 'text/markdown' if extension == 'md' else 'text/plain'


@pytest.mark.asyncio
@pytest.mark.parametrize('extension', ['pdf', 'docx', 'md', 'txt', 'html'])
async def test_offers_uploaded_originals_without_reingestion_or_edit_authority(service, repository, storage, extension):
    content, mime = original_file(extension)
    accepted = await service.ingest(OWNER_ID, group_identifier='Church', filename=f'Original sermon.{extension}', mime_type=mime, content=content, source='portal', created_by_agent=False)
    await service.process_job(OWNER_ID, accepted.job_id)
    before = repository.documents[accepted.document_id].model_dump(exclude={'source_metadata'})
    chunks = list(repository.chunks[accepted.document_id])
    jobs = dict(repository.jobs)
    first, second = uuid4(), uuid4()
    offered = await service.offer_document_download(OWNER_ID, accepted.document_id, first)
    assert offered['offered_in_conversation'] is True
    assert offered['requires_sign_in'] is True
    assert offered['url'] == f'https://rag.example/api/library/documents/{accepted.document_id}/download'
    assert '?' not in offered['url']
    listed = await service.list_documents(OWNER_ID, None, 200, first)
    assert len(listed) == 1 and listed[0].id == accepted.document_id and listed[0].chunk_count > 0
    assert await service.list_documents(OWNER_ID, None, 200, second) == []
    repeated = await service.offer_document_download(OWNER_ID, accepted.document_id, first)
    assert repeated['offer_id'] != offered['offer_id']
    await service.offer_document_download(OWNER_ID, accepted.document_id, second)
    current = repository.documents[accepted.document_id]
    assert set(current.source_metadata['vc_conversation_ids']) == {str(first), str(second)}
    assert current.model_dump(exclude={'source_metadata'}) == before
    assert repository.chunks[accepted.document_id] == chunks and repository.jobs == jobs
    downloaded, payload, content_type = await service.download_document(OWNER_ID, accepted.document_id)
    assert payload == content and content_type == mime
    assert service.download_filename(downloaded) == f'Original sermon.{extension}'
    with pytest.raises(ValueError, match='Only documents created or placed by Hermes'):
        await service.delete_generated_document(OWNER_ID, accepted.document_id)


@pytest.mark.asyncio
@pytest.mark.parametrize('agent_created', [True, False])
async def test_generated_downloads_do_not_require_agent_edit_authority(service, repository, agent_created):
    accepted = await service.create_generated_document(OWNER_ID, title='Existing notes', markdown='Complete original notes.')
    await service.process_job(OWNER_ID, accepted.job_id)
    document = repository.documents[accepted.document_id]
    repository.documents[document.id] = document.model_copy(update={'created_by_agent': agent_created})
    offered = await service.offer_document_download(OWNER_ID, document.id, uuid4())
    assert offered['filename'].endswith('.pdf')
    _, payload, mime = await service.download_document(OWNER_ID, document.id)
    assert mime == 'application/pdf' and payload.startswith(b'%PDF-')


@pytest.mark.asyncio
async def test_download_offer_authentication_and_readiness(settings, service, repository):
    accepted = await service.create_generated_document(OWNER_ID, title='Ready gate', markdown='Only indexed content is offered.')
    with pytest.raises(ValueError, match='indexing'):
        await service.offer_document_download(OWNER_ID, accepted.document_id, uuid4())
    await service.process_job(OWNER_ID, accepted.job_id)
    with pytest.raises(LookupError):
        await service.offer_document_download(uuid4(), accepted.document_id, uuid4())
    with pytest.raises(LookupError):
        await service.download_document(uuid4(), accepted.document_id)
    app = create_app(settings=settings, service=service, authenticator=Authenticator(settings))
    path = f'/v1/documents/{accepted.document_id}'
    with TestClient(app) as client:
        assert client.post(path+'/offer-download', json={}).status_code == 401
        assert client.get(path+'/download').status_code == 401
        assert client.post(path+'/offer-download', headers={'X-RAG-Token': settings.api_token}, json={}).status_code == 403
        headers = {'X-RAG-Token': settings.agent_api_token}
        offer = client.post(path+'/offer-download', headers=headers, json={}).json()
        assert offer['offered_in_conversation'] is False and offer['offer_id'] is None
        response = client.get(path+'/download', headers=headers)
        assert response.status_code == 200 and response.content.startswith(b'%PDF-')
        assert response.headers['content-disposition'].startswith('attachment;')
        assert response.headers['cache-control'] == 'private, no-store'
        assert client.post(path+'/offer-download', headers=headers, json={'document_id':str(uuid4())}).status_code == 422
    repository.chunks[accepted.document_id] = []
    with pytest.raises(ValueError, match='indexing'):
        await service.offer_document_download(OWNER_ID, accepted.document_id, uuid4())
    document = repository.documents[accepted.document_id]
    repository.documents[document.id] = document.model_copy(update={'archived_at': datetime.now(timezone.utc)})
    with pytest.raises(LookupError):
        await service.download_document(OWNER_ID, document.id)


@pytest.mark.asyncio
async def test_concurrent_offer_retries_preserve_other_conversation_and_metadata(service, repository, monkeypatch):
    accepted = await service.create_generated_document(OWNER_ID, title='Concurrent offers', markdown='Existing content.', source_metadata={'authored_by':'Original author'})
    await service.process_job(OWNER_ID, accepted.job_id)
    first, second = uuid4(), uuid4()
    compare = repository.compare_document_source_metadata
    calls = 0
    async def conflict(owner, document_id, expected, replacement):
        nonlocal calls
        calls += 1
        if calls == 1:
            repository.documents[document_id] = repository.documents[document_id].model_copy(update={'source_metadata':{**expected,'vc_conversation_ids':[str(second)],'vc_download_offers':{str(second):str(uuid4())}}})
            return False
        return await compare(owner, document_id, expected, replacement)
    monkeypatch.setattr(repository, 'compare_document_source_metadata', conflict)
    await service.offer_document_download(OWNER_ID, accepted.document_id, first)
    metadata = repository.documents[accepted.document_id].source_metadata
    assert calls == 2 and metadata['authored_by'] == 'Original author'
    assert set(metadata['vc_conversation_ids']) == {str(first),str(second)}
    assert set(metadata['vc_download_offers']) == {str(first),str(second)}
