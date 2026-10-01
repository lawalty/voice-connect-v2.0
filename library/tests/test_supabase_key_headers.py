from uuid import UUID
import json

import httpx
import pytest

from app.config import Settings
from app.supabase_backend import SupabaseRepository


@pytest.mark.asyncio
async def test_download_offer_metadata_patch_is_owner_scoped_and_compare_and_swap():
    owner = UUID('11111111-1111-1111-1111-111111111111')
    document = UUID('22222222-2222-2222-2222-222222222222')
    expected = {'authored_by':'Original author'}
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(200, request=request, json=[{'id':str(document)}] if len(requests)==1 else [])
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        repository = SupabaseRepository(_settings('sb_secret_current'), client=client)
        replacement = {**expected,'vc_conversation_ids':['current-conversation']}
        assert await repository.compare_document_source_metadata(owner, document, expected, replacement)
        assert not await repository.compare_document_source_metadata(owner, document, expected, replacement)
    for request in requests:
        assert request.method == 'PATCH'
        assert request.url.params['owner_id'] == f'eq.{owner}'
        assert request.url.params['id'] == f'eq.{document}'
        assert request.url.params['status'] == 'eq.ready'
        assert request.url.params['archived_at'] == 'is.null'
        assert json.loads(request.url.params['source_metadata'][3:]) == expected
        assert json.loads(request.content) == {'source_metadata':replacement}


def _settings(key: str) -> Settings:
    return Settings(
        supabase_url="https://project.supabase.co",
        service_role_key=key,
        publishable_key="sb_publishable_test",
        owner_user_id=UUID("11111111-1111-1111-1111-111111111111"),
        api_token="t" * 40,
    )


def test_current_secret_key_is_never_sent_as_bearer_jwt() -> None:
    headers = SupabaseRepository(_settings("sb_secret_current")).headers
    assert headers == {"apikey": "sb_secret_current"}


def test_legacy_service_role_jwt_keeps_bearer_compatibility() -> None:
    headers = SupabaseRepository(_settings("legacy.jwt.value")).headers
    assert headers["apikey"] == "legacy.jwt.value"
    assert headers["Authorization"] == "Bearer legacy.jwt.value"


@pytest.mark.asyncio
async def test_group_update_uses_owner_scoped_patch_and_returns_representation() -> None:
    owner_id = UUID("11111111-1111-1111-1111-111111111111")
    group_id = UUID("22222222-2222-2222-2222-222222222222")
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(
            method=request.method,
            url=str(request.url),
            prefer=request.headers.get("Prefer"),
            body=request.content.decode("utf-8"),
        )
        return httpx.Response(
            200,
            request=request,
            json=[
                {
                    "id": str(group_id),
                    "owner_id": str(owner_id),
                    "name": "Corrected",
                    "slug": "stable-slug",
                    "aliases": ["Alias"],
                    "description": "Corrected description",
                }
            ],
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    repository = SupabaseRepository(_settings("sb_secret_current"), client=client)
    try:
        updated = await repository.update_group(
            owner_id,
            group_id,
            "Corrected",
            ["Alias"],
            "Corrected description",
            [0.0] * 384,
        )
    finally:
        await client.aclose()

    assert updated.slug == "stable-slug"
    assert captured["method"] == "PATCH"
    assert f"owner_id=eq.{owner_id}" in captured["url"]
    assert f"id=eq.{group_id}" in captured["url"]
    assert captured["prefer"] == "return=representation"
    assert '"routing_embedding":"[0,0,0' in captured["body"]


@pytest.mark.asyncio
async def test_document_listing_fetches_chunk_counts_in_one_owner_scoped_rpc() -> None:
    owner_id = UUID("11111111-1111-1111-1111-111111111111")
    document_id = UUID("33333333-3333-3333-3333-333333333333")
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/rag_documents"):
            return httpx.Response(
                200,
                request=request,
                json=[
                    {
                        "id": str(document_id),
                        "owner_id": str(owner_id),
                        "group_id": "22222222-2222-2222-2222-222222222222",
                        "filename": "bylaws.pdf",
                        "mime_type": "application/pdf",
                        "storage_bucket": "rag-documents",
                        "storage_path": f"{owner_id}/church/bylaws.pdf",
                        "size_bytes": 1024,
                        "sha256": "a" * 64,
                        "status": "ready",
                        "source": "portal",
                        "rag_groups": {
                            "name": "Church",
                            "slug": "church",
                            "system_key": None,
                        },
                    }
                ],
            )
        assert request.url.path.endswith("/rpc/rag_list_document_chunk_counts")
        return httpx.Response(
            200,
            request=request,
            json=[{"document_id": str(document_id), "chunk_count": 67}],
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    repository = SupabaseRepository(_settings("sb_secret_current"), client=client)
    try:
        documents = await repository.list_documents(owner_id, None, 100)
    finally:
        await client.aclose()

    assert documents[0].chunk_count == 67
    assert len(requests) == 2
    assert f'"p_owner_id":"{owner_id}"' in requests[1].content.decode("utf-8")
    assert f'"p_document_ids":["{document_id}"]' in requests[1].content.decode("utf-8")
