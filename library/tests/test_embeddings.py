from __future__ import annotations

import json

import httpx
import pytest

from app.embeddings import EMBEDDING_DIMENSIONS, SupabaseGteSmallEmbedder


@pytest.mark.asyncio
async def test_edge_embedder_splits_safe_batches_and_recovers_from_546(
    settings,
) -> None:
    batch_sizes: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        inputs = json.loads(request.content)["inputs"]
        batch_sizes.append(len(inputs))
        if len(inputs) > 2:
            return httpx.Response(
                546,
                request=request,
                json={"code": "WORKER_RESOURCE_LIMIT"},
            )
        return httpx.Response(
            200,
            request=request,
            json={
                "embeddings": [
                    [float(index)] * EMBEDDING_DIMENSIONS
                    for index, _input in enumerate(inputs)
                ]
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    embedder = SupabaseGteSmallEmbedder(settings, client=client)
    try:
        embeddings = await embedder.embed([f"chunk {index}" for index in range(5)])
    finally:
        await client.aclose()

    assert len(embeddings) == 5
    assert batch_sizes == [4, 2, 2, 1]


@pytest.mark.asyncio
async def test_edge_embedder_retries_transient_503_then_succeeds(
    settings, monkeypatch
) -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            return httpx.Response(503, request=request, text="temporarily unavailable")
        return httpx.Response(
            200,
            request=request,
            json={"embeddings": [[0.0] * EMBEDDING_DIMENSIONS]},
        )

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr("app.embeddings.asyncio.sleep", no_sleep)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        result = await SupabaseGteSmallEmbedder(settings, client=client).embed(["text"])
    finally:
        await client.aclose()
    assert len(result) == 1
    assert attempts == 3


@pytest.mark.asyncio
async def test_edge_embedder_does_not_retry_permanent_400(settings, monkeypatch) -> None:
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(400, request=request, text="bad request")

    async def no_sleep(_seconds: float) -> None:
        return None

    monkeypatch.setattr("app.embeddings.asyncio.sleep", no_sleep)
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(httpx.HTTPStatusError):
            await SupabaseGteSmallEmbedder(settings, client=client).embed(["text"])
    finally:
        await client.aclose()
    assert attempts == 1
