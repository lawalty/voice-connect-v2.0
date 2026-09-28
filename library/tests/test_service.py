from __future__ import annotations

from uuid import UUID

import pytest

import app.service as service_module
from app.embeddings import DeterministicTestEmbedder
from app.models import GroupCreate, GroupUpdate, SearchRequest
from app.service import RagService
from tests.conftest import OWNER_ID
from tests.fakes import FakeRepository, FakeStorage


@pytest.mark.asyncio
async def test_ingestion_process_search_and_signed_link(service, repository: FakeRepository, storage: FakeStorage) -> None:
    accepted = await service.ingest(
        OWNER_ID,
        group_identifier="NorthPointe",
        filename="policy.txt",
        mime_type="text/plain",
        content=b"The benevolence policy requires two approvals for disbursements.",
        source="portal",
    )
    assert accepted.group == "Church"
    assert not accepted.duplicate
    assert len(storage.objects) == 1

    completed = await service.process_job(OWNER_ID, accepted.job_id)
    assert completed.status == "completed"
    assert repository.documents[accepted.document_id].status == "ready"
    assert len(repository.chunks[accepted.document_id]) == 1
    listed = await service.list_documents(OWNER_ID, "Church", 100)
    assert listed[0].chunk_count == 1

    result = await service.search(OWNER_ID, SearchRequest(query="How many approvals?", group="Church"))
    assert result.routing_reason == "explicit group"
    assert result.hits[0].filename == "policy.txt"
    assert result.hits[0].group_name == "Church"

    link = await service.signed_link(OWNER_ID, accepted.document_id, None)
    assert link.expires_in == 3600
    assert link.url.startswith("https://signed.example/")


@pytest.mark.asyncio
async def test_enhanced_pdf_mode_uses_selected_ai_extractor(
    settings, repository: FakeRepository, storage: FakeStorage
) -> None:
    class RecordingExtractor:
        calls: list[tuple[str, bytes, str]] = []

        async def extract_pdf(
            self, filename: str, content: bytes, model: str
        ) -> str:
            self.calls.append((filename, content, model))
            return "AI extracted policy text"

    extractor = RecordingExtractor()
    service = RagService(
        settings,
        repository,
        storage,
        DeterministicTestEmbedder(),
        ai_extractor=extractor,
    )
    accepted = await service.ingest(
        OWNER_ID,
        group_identifier="Church",
        filename="scanned-policy.pdf",
        mime_type="application/pdf",
        content=b"%PDF opaque test",
        source="portal",
        source_metadata={"processing_mode": "gemini-3.7-flash"},
    )
    completed = await service.process_job(OWNER_ID, accepted.job_id)
    assert completed.status == "completed"
    assert extractor.calls == [
        ("scanned-policy.pdf", b"%PDF opaque test", "gemini-3.7-flash")
    ]
    assert repository.chunks[accepted.document_id][0]["content"] == "AI extracted policy text"


@pytest.mark.asyncio
async def test_duplicate_is_scoped_to_group(service) -> None:
    kwargs = dict(filename="same.txt", mime_type="text/plain", content=b"identical", source="api")
    first = await service.ingest(OWNER_ID, group_identifier="Church", **kwargs)
    duplicate = await service.ingest(OWNER_ID, group_identifier="Church", **kwargs)
    other_group = await service.ingest(OWNER_ID, group_identifier="Personal", **kwargs)
    assert duplicate.duplicate and duplicate.document_id == first.document_id
    assert not other_group.duplicate and other_group.document_id != first.document_id


@pytest.mark.asyncio
async def test_resubmitting_failed_document_reuses_storage_and_queues_retry(
    service, repository: FakeRepository, storage: FakeStorage
) -> None:
    kwargs = dict(
        group_identifier="Church",
        filename="failed.txt",
        mime_type="text/plain",
        content=b"Retry this failed embedding job.",
        source="url",
    )
    first = await service.ingest(OWNER_ID, **kwargs)
    await repository.fail_job(
        OWNER_ID,
        first.job_id,
        first.document_id,
        "Supabase Edge Function returned 546",
    )

    retried = await service.ingest(OWNER_ID, **kwargs)

    assert retried.document_id == first.document_id
    assert retried.job_id != first.job_id
    assert retried.duplicate is True
    assert retried.retried is True
    assert retried.status == "queued"
    assert len(storage.objects) == 1
    completed = await service.process_job(OWNER_ID, retried.job_id)
    assert completed.status == "completed"
    assert repository.documents[first.document_id].status == "ready"


@pytest.mark.asyncio
async def test_worker_retries_storage_object_visibility_race(
    settings, repository: FakeRepository, monkeypatch
) -> None:
    class DelayedStorage(FakeStorage):
        attempts = 0

        async def download(self, bucket: str, path: str) -> bytes:
            self.attempts += 1
            if self.attempts < 3:
                raise RuntimeError('{"code":"NoSuchKey"}')
            return await super().download(bucket, path)

    delays: list[float] = []

    async def record_sleep(delay: float) -> None:
        delays.append(delay)

    monkeypatch.setattr(service_module.asyncio, "sleep", record_sleep)
    storage = DelayedStorage()
    service = RagService(
        settings,
        repository,
        storage,
        DeterministicTestEmbedder(),
    )
    accepted = await service.ingest(
        OWNER_ID,
        group_identifier="Church",
        filename="upload-race.txt",
        mime_type="text/plain",
        content=b"The Storage object becomes visible after the job is queued.",
        source="portal",
    )

    completed = await service.process_job(OWNER_ID, accepted.job_id)

    assert completed.status == "completed"
    assert storage.attempts == 3
    assert delays == [0.5, 1.0]


@pytest.mark.asyncio
async def test_failed_pdf_retry_can_switch_from_local_to_enhanced_processing(
    service, repository: FakeRepository
) -> None:
    kwargs = dict(
        group_identifier="Church",
        filename="scanned.pdf",
        mime_type="application/pdf",
        content=b"%PDF same failed document",
        source="portal",
    )
    first = await service.ingest(
        OWNER_ID,
        **kwargs,
        source_metadata={"processing_mode": "automatic"},
    )
    await repository.fail_job(
        OWNER_ID,
        first.job_id,
        first.document_id,
        "The document contains no extractable text",
    )

    retried = await service.ingest(
        OWNER_ID,
        **kwargs,
        source_metadata={"processing_mode": "gemini-3.7-flash"},
    )

    assert retried.retried is True
    assert repository.documents[first.document_id].source_metadata == {
        "processing_mode": "gemini-3.7-flash"
    }


@pytest.mark.asyncio
async def test_automatic_group_routing_searches_two_when_ambiguous(service, repository: FakeRepository) -> None:
    repository.route_scores = [0.51, 0.49, 0.2]
    result = await service.search(OWNER_ID, SearchRequest(query="What is the policy?"))
    assert result.ambiguous_group is True
    assert [group.name for group in result.searched_groups] == ["Church", "EZCORP"]


@pytest.mark.asyncio
async def test_group_creation_embeds_description_and_rejects_alias_collision(service) -> None:
    created = await service.create_group(
        OWNER_ID, GroupCreate(name="Legal", aliases=["Contracts"], description="Agreements and legal records")
    )
    assert created.slug == "legal"
    with pytest.raises(ValueError, match="already exists"):
        await service.create_group(OWNER_ID, GroupCreate(name="Contracts"))


@pytest.mark.asyncio
async def test_group_update_propagates_to_existing_documents_without_reingestion(
    service, repository: FakeRepository
) -> None:
    accepted = await service.ingest(
        OWNER_ID,
        group_identifier="Church",
        filename="bylaws.txt",
        mime_type="text/plain",
        content=b"The board reviews the bylaws annually.",
        source="portal",
    )
    await service.process_job(OWNER_ID, accepted.job_id)
    before = repository.documents[accepted.document_id]
    before_chunks = repository.chunks[accepted.document_id]

    updated = await service.update_group(
        OWNER_ID,
        UUID("22222222-2222-2222-2222-222222222222"),
        GroupUpdate(
            name="Church Governance",
            aliases=["Assembly Governance"],
            description="Bylaws, board structure, and local church governance",
        ),
    )

    assert updated.name == "Church Governance"
    assert updated.slug == "church"
    listed = (await service.list_documents(OWNER_ID, None, 100))[0]
    assert listed.group_name == "Church Governance"
    assert listed.id == before.id
    assert listed.sha256 == before.sha256
    assert repository.chunks[accepted.document_id] is before_chunks
    assert len(repository.group_routing_embeddings[updated.id]) == 384
    searched = await service.search(
        OWNER_ID, SearchRequest(query="When are bylaws reviewed?", group="church")
    )
    assert searched.hits[0].group_name == "Church Governance"
    assert searched.hits[0].group_slug == "church"


@pytest.mark.asyncio
async def test_group_update_rejects_collisions_and_system_group(service) -> None:
    with pytest.raises(ValueError, match="already exists"):
        await service.update_group(
            OWNER_ID,
            UUID("22222222-2222-2222-2222-222222222222"),
            GroupUpdate(name="Personal"),
        )

    system_group = await service.ensure_generated_group(OWNER_ID)
    with pytest.raises(ValueError, match="System-managed"):
        await service.update_group(
            OWNER_ID, system_group.id, GroupUpdate(description="Changed")
        )


@pytest.mark.asyncio
async def test_owner_cannot_fetch_another_owners_document(service, repository: FakeRepository) -> None:
    accepted = await service.ingest(
        OWNER_ID, group_identifier="Personal", filename="private.txt", mime_type="text/plain", content=b"secret", source="api"
    )
    with pytest.raises(LookupError):
        await service.signed_link(UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), accepted.document_id, 3600)

