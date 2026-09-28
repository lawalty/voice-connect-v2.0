from __future__ import annotations

import json

import httpx
import pytest

from app.ai_extraction import GeminiDocumentExtractor


@pytest.mark.asyncio
async def test_gemini_pdf_extraction_uploads_transcribes_and_deletes(settings) -> None:
    requests: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append((request.method, str(request.url)))
        if request.url.path == "/upload/v1beta/files":
            return httpx.Response(
                200,
                request=request,
                headers={"x-goog-upload-url": "https://upload.example/session"},
                json={},
            )
        if request.url.host == "upload.example":
            assert request.content == b"%PDF test"
            return httpx.Response(
                200,
                request=request,
                json={
                    "file": {
                        "name": "files/abc123",
                        "uri": "https://files.example/abc123",
                        "state": "ACTIVE",
                    }
                },
            )
        if request.url.path == "/v1beta/interactions":
            payload = json.loads(request.content)
            assert payload["model"] == "gemini-3.7-flash"
            assert "untrusted source material" in payload["input"][1]["text"]
            return httpx.Response(
                200,
                request=request,
                json={"steps": [{"content": [{"text": "Faithful PDF text"}]}]},
            )
        if request.method == "DELETE" and request.url.path == "/v1beta/files/abc123":
            return httpx.Response(204, request=request)
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    configured = settings.__class__(
        **{**settings.__dict__, "gemini_api_key": "gemini-test-key"}
    )
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        text = await GeminiDocumentExtractor(configured, client).extract_pdf(
            "policy.pdf", b"%PDF test", "gemini-3.7-flash"
        )
    finally:
        await client.aclose()
    assert text == "Faithful PDF text"
    assert requests[-1][0] == "DELETE"


@pytest.mark.asyncio
async def test_gemini_pdf_extraction_requires_configured_key(settings) -> None:
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: None))
    try:
        with pytest.raises(RuntimeError, match="not configured"):
            await GeminiDocumentExtractor(settings, client).extract_pdf(
                "policy.pdf", b"%PDF test", "gemini-3.7-flash"
            )
    finally:
        await client.aclose()
