from dataclasses import replace

import httpx
from fastapi.testclient import TestClient

from app.main import create_app
from app.security import Authenticator, VoiceConnectPairedAuthenticator


def test_session_revocation_is_observed_without_cached_operator_access(settings, service):
    authenticated = True
    checked = []

    async def status(request):
        assert request.url.path == "/api/status"
        checked.append(request.headers["cookie"])
        return httpx.Response(200, json={"authenticated": authenticated, "csrfToken": "owner-csrf"})

    configured = replace(settings, voice_connect_auth_url="http://127.0.0.1:18880/api/status")
    auth = Authenticator(configured, voice_connect=VoiceConnectPairedAuthenticator(
        configured, httpx.AsyncClient(transport=httpx.MockTransport(status))))
    client = TestClient(create_app(configured, service, auth), base_url="https://rag.example")
    headers = {"Cookie": "vc_session=owner-session", "X-VoiceConnect-RAG-Portal": "1"}
    assert client.get("/v1/groups", headers=headers).status_code == 200
    authenticated = False
    response = client.post("/v1/groups", headers={**headers, "Origin": "https://rag.example",
        "X-CSRF-Token": "owner-csrf"}, json={"name": "Must not be created"})
    assert response.status_code == 401
    assert len(checked) == 2
    assert all(group.name != "Must not be created" for group in service.repository.groups)


def test_auth_service_outage_fails_closed_even_with_agent_header(settings, service):
    async def status(request):
        raise httpx.ConnectError("offline", request=request)

    configured = replace(settings, voice_connect_auth_url="http://127.0.0.1:18880/api/status")
    auth = Authenticator(configured, voice_connect=VoiceConnectPairedAuthenticator(
        configured, httpx.AsyncClient(transport=httpx.MockTransport(status))))
    client = TestClient(create_app(configured, service, auth), base_url="https://rag.example")
    response = client.delete("/v1/documents/11111111-1111-1111-1111-111111111111", headers={
        "Cookie": "vc_session=owner-session", "X-VoiceConnect-RAG-Portal": "1",
        "Origin": "https://rag.example", "X-CSRF-Token": "owner-csrf",
        "X-RAG-Token": settings.agent_api_token})
    assert response.status_code == 503
