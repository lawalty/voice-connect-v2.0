from __future__ import annotations

import subprocess
from dataclasses import replace
from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from app.main import create_app
from app.security import Authenticator, VoiceConnectPairedAuthenticator


def test_portal_queue_runtime_regression() -> None:
    root = Path(__file__).parents[1]
    subprocess.run(
        ["node", "--test", str(root / "tests" / "portal_queue_runtime.mjs")],
        cwd=root,
        check=True,
    )


def test_api_requires_auth_and_exposes_portal(settings, service) -> None:
    client = TestClient(create_app(settings, service, Authenticator(settings)))
    assert client.get("/healthz").status_code == 200
    assert client.get("/v1/groups").status_code == 401
    assert client.post("/v1/ingest/url", json={"group": "Church", "url": "https://ag.org"}).status_code == 401
    portal = client.get("/rag/", follow_redirects=False)
    script = client.get("/rag/app.js?v=enhanced-ai-1")
    assert portal.status_code == 303
    assert script.status_code == 200
    assert portal.headers["location"] == "/"
    assert script.headers["cache-control"] == "no-store, max-age=0, must-revalidate"


def voice_connect_authenticator(settings, role="owner", authenticated=True):
    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["cookie"] == "vc_session=paired-session"
        assert request.headers["host"] == "rag.example"
        return httpx.Response(
            200,
            json={
                "authenticated": authenticated,
                "csrfToken": "voice-connect-csrf",
                "device": {"role": role},
            },
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    configured = replace(
        settings,
        voice_connect_auth_url="http://voice-connect.internal/api/status",
    )
    voice_connect = VoiceConnectPairedAuthenticator(configured, client=client)
    return Authenticator(settings, voice_connect=voice_connect)


def test_voice_connect_paired_session_opens_tokenless_portal_and_uses_operator_api(
    settings, service
) -> None:
    client = TestClient(
        create_app(settings, service, voice_connect_authenticator(settings)),
        base_url="https://rag.example",
    )
    cookie = {"Cookie": "vc_session=paired-session"}
    portal = client.get("/rag/", headers=cookie)
    assert portal.status_code == 200
    assert 'id="operator-auth"' not in portal.text
    assert portal.headers["cache-control"] == "no-store, max-age=0, must-revalidate"

    groups = client.get(
        "/v1/groups",
        headers={**cookie, "X-VoiceConnect-RAG-Portal": "1"},
    )
    assert groups.status_code == 200
    assert len(groups.json()) == 3


def test_voice_connect_portal_rejects_unpaired_but_accepts_member_sessions(
    settings, service
) -> None:
    unpaired = TestClient(
        create_app(settings, service, voice_connect_authenticator(settings)),
        base_url="https://rag.example",
    )
    assert unpaired.get("/rag/", follow_redirects=False).status_code == 303

    member = TestClient(
        create_app(
            settings,
            service,
            voice_connect_authenticator(settings, role="member"),
        ),
        base_url="https://rag.example",
    )
    response = member.get(
        "/rag/",
        headers={"Cookie": "vc_session=paired-session"},
    )
    assert response.status_code == 200

    groups = member.get(
        "/v1/groups",
        headers={
            "Cookie": "vc_session=paired-session",
            "X-VoiceConnect-RAG-Portal": "1",
        },
    )
    assert groups.status_code == 200

    created = member.post(
        "/v1/groups",
        headers={
            "Cookie": "vc_session=paired-session",
            "X-VoiceConnect-RAG-Portal": "1",
            "Origin": "https://rag.example",
            "X-CSRF-Token": "voice-connect-csrf",
        },
        json={"name": "Member Managed"},
    )
    assert created.status_code == 201

    mutation_headers = {
        "Cookie": "vc_session=paired-session",
        "X-VoiceConnect-RAG-Portal": "1",
        "Origin": "https://rag.example",
        "X-CSRF-Token": "voice-connect-csrf",
    }
    updated = member.patch(
        f"/v1/groups/{created.json()['id']}",
        headers=mutation_headers,
        json={
            "name": "Member Managed Updated",
            "aliases": ["Paired device"],
            "description": "Managed from a paired member session",
        },
    )
    assert updated.status_code == 200

    uploaded = member.post(
        "/v1/ingest/upload",
        headers=mutation_headers,
        data={"group": created.json()["slug"], "source": "portal"},
        files={"file": ("paired.txt", b"paired upload", "text/plain")},
    )
    assert uploaded.status_code == 202
    document_id = uploaded.json()["document_id"]

    missing_csrf = member.delete(
        f"/v1/documents/{document_id}",
        headers={
            "Cookie": "vc_session=paired-session",
            "X-VoiceConnect-RAG-Portal": "1",
            "Origin": "https://rag.example",
        },
    )
    assert missing_csrf.status_code == 403

    deleted = member.delete(
        f"/v1/documents/{document_id}",
        headers=mutation_headers,
    )
    assert deleted.status_code == 200
    assert deleted.json()["success"] is True
    assert deleted.json()["status"] == "removed"


def test_voice_connect_portal_mutations_require_exact_origin_and_csrf(
    settings, service
) -> None:
    client = TestClient(
        create_app(settings, service, voice_connect_authenticator(settings)),
        base_url="https://rag.example",
    )
    base_headers = {
        "Cookie": "vc_session=paired-session",
        "X-VoiceConnect-RAG-Portal": "1",
    }
    missing_origin = client.post(
        "/v1/groups",
        headers={**base_headers, "X-CSRF-Token": "voice-connect-csrf"},
        json={"name": "Archive"},
    )
    assert missing_origin.status_code == 403

    wrong_csrf = client.post(
        "/v1/groups",
        headers={**base_headers, "Origin": "https://rag.example", "X-CSRF-Token": "wrong"},
        json={"name": "Archive"},
    )
    assert wrong_csrf.status_code == 403

    created = client.post(
        "/v1/groups",
        headers={
            **base_headers,
            "Origin": "https://rag.example",
            "X-CSRF-Token": "voice-connect-csrf",
        },
        json={"name": "Archive"},
    )
    assert created.status_code == 201
    assert created.json()["slug"] == "archive"


def test_voice_connect_portal_javascript_uses_cookie_auth_without_rag_token() -> None:
    root = Path(__file__).parents[1]
    script = (root / "app" / "static" / "app.js").read_text(encoding="utf-8")
    assert 'fetch("/api/status"' in script
    assert 'headers.set("X-VoiceConnect-RAG-Portal", "1")' in script
    assert 'headers.set("X-CSRF-Token", state.csrfToken)' in script
    assert "sessionStorage" not in script


def test_upload_group_search_and_status_api(settings, service) -> None:
    client = TestClient(create_app(settings, service, Authenticator(settings)))
    headers = {"X-RAG-Token": settings.api_token}
    groups = client.get("/v1/groups", headers=headers)
    assert groups.status_code == 200 and len(groups.json()) == 3

    uploaded = client.post(
        "/v1/ingest/upload",
        headers=headers,
        data={"group": "Church", "source": "portal"},
        files={"file": ("guide.txt", b"Sunday service begins at ten.", "text/plain")},
    )
    assert uploaded.status_code == 202
    job_id = uploaded.json()["job_id"]
    assert client.get(f"/v1/jobs/{job_id}", headers=headers).json()["status"] == "queued"

    created = client.post(
        "/v1/groups",
        headers=headers,
        json={"name": "Archive", "aliases": ["History"], "description": "Historical records"},
    )
    assert created.status_code == 201 and created.json()["slug"] == "archive"

    updated = client.patch(
        f"/v1/groups/{created.json()['id']}",
        headers=headers,
        json={
            "name": "Company Archive",
            "aliases": ["History", "Records"],
            "description": "Corrected historical company records",
        },
    )
    assert updated.status_code == 200
    assert updated.json()["name"] == "Company Archive"
    assert updated.json()["slug"] == "archive"


def test_portal_raw_upload_bypasses_multipart_and_records_processing_mode(
    settings, service, repository
) -> None:
    client = TestClient(create_app(settings, service, Authenticator(settings)))
    response = client.post(
        "/v1/ingest/raw",
        params={
            "group": "Church",
            "filename": "hard-to-parse.pdf",
            "processing_mode": "gemini-3.7-flash",
        },
        headers={
            "X-RAG-Token": settings.api_token,
            "Content-Type": "application/pdf",
        },
        content=b"%PDF-1.7 test payload",
    )
    assert response.status_code == 202
    document_id = response.json()["document_id"]
    document = next(
        item for item in repository.documents.values() if str(item.id) == document_id
    )
    assert document.source == "portal"
    assert document.created_by_agent is False
    assert document.source_metadata["processing_mode"] == "gemini-3.7-flash"


def test_portal_raw_upload_rejects_unknown_model_and_oversized_body(
    settings, service
) -> None:
    client = TestClient(create_app(settings, service, Authenticator(settings)))
    headers = {
        "X-RAG-Token": settings.api_token,
        "Content-Type": "text/plain",
    }
    invalid = client.post(
        "/v1/ingest/raw",
        params={
            "group": "Church",
            "filename": "notes.txt",
            "processing_mode": "arbitrary-paid-model",
        },
        headers=headers,
        content=b"test",
    )
    assert invalid.status_code == 422

    constrained_settings = settings.__class__(
        **{**settings.__dict__, "max_upload_bytes": 3}
    )
    constrained_client = TestClient(
        create_app(
            constrained_settings,
            service,
            Authenticator(constrained_settings),
        )
    )
    oversized = constrained_client.post(
        "/v1/ingest/raw",
        params={"group": "Church", "filename": "notes.txt"},
        headers=headers,
        content=b"four",
    )
    assert oversized.status_code == 400
    assert "upload limit" in oversized.json()["detail"]


def test_group_update_requires_auth_and_at_least_one_field(settings, service) -> None:
    client = TestClient(create_app(settings, service, Authenticator(settings)))
    group_id = "22222222-2222-2222-2222-222222222222"
    assert client.patch(f"/v1/groups/{group_id}", json={"name": "New"}).status_code == 401
    response = client.patch(
        f"/v1/groups/{group_id}",
        headers={"X-RAG-Token": settings.api_token},
        json={},
    )
    assert response.status_code == 422


def test_wrong_token_and_unknown_group_are_rejected(settings, service) -> None:
    client = TestClient(create_app(settings, service, Authenticator(settings)))
    assert client.get("/v1/groups", headers={"X-RAG-Token": "wrong"}).status_code == 401
    response = client.post(
        "/v1/ingest/upload",
        headers={"X-RAG-Token": settings.api_token},
        data={"group": "Missing"},
        files={"file": ("guide.txt", b"text", "text/plain")},
    )
    assert response.status_code == 404


def test_operator_can_delete_uploaded_document_but_agent_cannot(
    settings, service, repository, storage
) -> None:
    client = TestClient(create_app(settings, service, Authenticator(settings)))
    operator_headers = {"X-RAG-Token": settings.api_token}
    agent_headers = {"X-RAG-Token": settings.agent_api_token}
    uploaded = client.post(
        "/v1/ingest/upload",
        headers=operator_headers,
        data={"group": "Church", "source": "portal"},
        files={"file": ("policy.txt", b"Protected staff policy.", "text/plain")},
    )
    assert uploaded.status_code == 202
    document_id = uploaded.json()["document_id"]
    document = repository.documents[next(key for key in repository.documents if str(key) == document_id)]
    storage_key = (document.storage_bucket, document.storage_path)
    assert storage_key in storage.objects

    denied = client.delete(f"/v1/documents/{document_id}", headers=agent_headers)
    assert denied.status_code == 403
    assert document.id in repository.documents
    assert storage_key in storage.objects

    removed = client.delete(f"/v1/documents/{document_id}", headers=operator_headers)
    assert removed.status_code == 200
    assert removed.json()["document_kind"] == "upload"
    assert removed.json()["storage_cleanup"] == "completed"
    assert document.id not in repository.documents
    assert storage_key not in storage.objects


def test_agent_can_delete_only_uuid_resolved_agent_document(settings, service) -> None:
    client = TestClient(create_app(settings, service, Authenticator(settings)))
    agent_headers = {"X-RAG-Token": settings.agent_api_token}
    created = client.post(
        "/v1/generated-documents",
        headers=agent_headers,
        json={"title": "Sermon Draft", "markdown": "# Sermon Draft\n\nDraft body."},
    )
    assert created.status_code == 202
    document_id = created.json()["document_id"]

    removed = client.delete(
        f"/v1/generated-documents/{document_id}", headers=agent_headers
    )
    assert removed.status_code == 200
    assert removed.json()["document_id"] == document_id
    assert removed.json()["title"] == "Sermon Draft"


def test_agent_file_in_generated_docs_is_managed_but_operator_file_is_protected(
    settings, service, repository, storage
) -> None:
    client = TestClient(create_app(settings, service, Authenticator(settings)))
    agent_headers = {"X-RAG-Token": settings.agent_api_token}
    operator_headers = {"X-RAG-Token": settings.api_token}

    managed = client.post(
        "/v1/ingest/upload",
        headers=agent_headers,
        data={"group": "Generated Docs", "source": "hermes"},
        files={"file": ("agent.pdf", b"%PDF-1.4 agent", "application/pdf")},
    )
    assert managed.status_code == 202
    managed_id = managed.json()["document_id"]
    managed_document = next(
        item for item in repository.documents.values() if str(item.id) == managed_id
    )
    assert managed_document.document_kind == "upload"
    assert managed_document.created_by_agent is True

    removed = client.delete(
        f"/v1/generated-documents/{managed_id}", headers=agent_headers
    )
    assert removed.status_code == 200
    assert removed.json()["storage_cleanup"] == "completed"

    protected = client.post(
        "/v1/ingest/upload",
        headers=operator_headers,
        data={"group": "Generated Docs", "source": "hermes"},
        files={"file": ("staff.txt", b"staff controlled", "text/plain")},
    )
    assert protected.status_code == 202
    protected_id = protected.json()["document_id"]
    protected_document = next(
        item for item in repository.documents.values() if str(item.id) == protected_id
    )
    assert protected_document.created_by_agent is False
    denied = client.delete(
        f"/v1/generated-documents/{protected_id}", headers=agent_headers
    )
    assert denied.status_code == 400
    assert protected_document.id in repository.documents

    operator_denied = client.post(
        "/v1/generated-documents",
        headers=operator_headers,
        json={"title": "Forged", "markdown": "Cannot claim agent provenance."},
    )
    assert operator_denied.status_code == 403


def test_portal_exposes_confirmed_human_document_deletion_control() -> None:
    root = Path(__file__).parents[1]
    portal = (root / "app" / "static" / "index.html").read_text(encoding="utf-8")
    script = (root / "app" / "static" / "app.js").read_text(encoding="utf-8")

    assert "You can download or delete documents here" in portal
    assert 'class="quiet danger delete-document"' in script
    assert "window.confirm" in script
    assert "DELETE" in script
    assert "/v1/documents/${document.id}" in script


def test_portal_queues_multiple_files_sequentially_and_shows_chunk_counts() -> None:
    root = Path(__file__).parents[1]
    portal = (root / "app" / "static" / "index.html").read_text(encoding="utf-8")
    script = (root / "app" / "static" / "app.js").read_text(encoding="utf-8")
    styles = (root / "app" / "static" / "styles.css").read_text(encoding="utf-8")

    assert 'id="upload-file"' in portal and "multiple" in portal
    assert 'id="ingestion-progress"' in portal
    assert 'id="ingestion-queue"' in portal
    assert 'id="documents-summary"' in portal
    assert '/rag/ingestion-queue.js?v=enhanced-ai-1' in portal
    assert '/rag/app.js?v=enhanced-ai-1' in portal
    assert 'id="processing-mode"' in portal
    assert "Automatic · local OCR and private" in portal
    assert "locally OCRs scanned pages when needed" in portal
    assert "Gemini 3.7 Flash" in portal
    assert "Gemini 3.1 Pro" in portal
    assert 'Array.from($("#upload-file").files)' in script
    assert "await runSequentialQueue(queue" in script
    assert 'accepted = await api(`/v1/ingest/raw?${query}`' in script
    assert "rawBody: true" in script
    assert "await waitForIngestion(accepted" in script
    assert "remaining sources not started" not in script
    assert "if (halted) break" not in script
    assert "doc.chunk_count" in script
    assert ".processing-spinner" in styles
