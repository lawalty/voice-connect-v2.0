from __future__ import annotations

from io import BytesIO

import pytest
from fastapi.testclient import TestClient

import app.url_ingestion as url_ingestion
from app.config import Settings
from app.main import create_app
from app.parsers import extract_text
from app.security import Authenticator
from app.url_ingestion import (
    FetchedDocument,
    UrlDocumentFetcher,
    UrlFetchError,
    _document_filename,
    _is_public_ip,
    _resolve_public_addresses,
    redact_url_for_storage,
)


class FakeResponse:
    def __init__(self, status: int, headers: dict[str, str], content: bytes = b""):
        self.status = status
        self._headers = headers
        self._body = BytesIO(content)

    def getheader(self, name: str) -> str | None:
        return self._headers.get(name)

    def read(self, size: int = -1) -> bytes:
        return self._body.read(size)

    def close(self) -> None:
        pass


class FakeConnection:
    responses: list[FakeResponse] = []

    def __init__(self, *_args, **_kwargs):
        pass

    def request(self, *_args, **_kwargs) -> None:
        pass

    def getresponse(self) -> FakeResponse:
        return self.responses.pop(0)

    def close(self) -> None:
        pass


def test_html_extraction_keeps_document_content_and_drops_scripts() -> None:
    source = b"""
    <html><head><title>AG Position Paper</title><script>ignore me</script></head>
    <body><nav>Site menu</nav><main><h1>Divine Healing</h1>
    <p>Healing is an integral part of the gospel.</p><ul><li>Reference one</li></ul>
    </main><footer>Copyright footer</footer></body></html>
    """
    text = extract_text("position-paper.html", "text/html", source)
    assert "AG Position Paper" in text
    assert "# Divine Healing" in text
    assert "Healing is an integral part" in text
    assert "ignore me" not in text
    assert "Site menu" not in text


def test_url_security_rejects_non_public_targets_and_credentials(settings) -> None:
    fetcher = UrlDocumentFetcher(settings)
    assert _is_public_ip("93.184.216.34")
    assert not _is_public_ip("127.0.0.1")
    assert not _is_public_ip("169.254.169.254")
    with pytest.raises(UrlFetchError, match="unsafe address"):
        _resolve_public_addresses("127.0.0.1", 80)
    with pytest.raises(UrlFetchError, match="credentials"):
        fetcher._validate_url("https://user:pass@example.com/report.pdf")
    with pytest.raises(UrlFetchError, match="standard HTTP"):
        fetcher._validate_url("https://example.com:8443/report.pdf")


def test_domain_allowlist_accepts_subdomains_and_rejects_others(settings) -> None:
    restricted = Settings(
        **{
            **settings.__dict__,
            "url_allowed_domains": ("ag.org",),
        }
    )
    fetcher = UrlDocumentFetcher(restricted)
    assert fetcher._validate_url("https://news.ag.org/article")[1] == "news.ag.org"
    with pytest.raises(UrlFetchError, match="RAG_URL_ALLOWED_DOMAINS"):
        fetcher._validate_url("https://example.com/article")


def test_fetcher_revalidates_redirect_and_blocks_private_destination(
    settings, monkeypatch
) -> None:
    FakeConnection.responses = [
        FakeResponse(302, {"Location": "http://127.0.0.1/private"})
    ]
    monkeypatch.setattr(url_ingestion, "_PinnedHTTPConnection", FakeConnection)

    def resolve(host: str, _port: int) -> list[str]:
        if host == "127.0.0.1":
            raise UrlFetchError("unsafe address")
        return ["93.184.216.34"]

    monkeypatch.setattr(url_ingestion, "_resolve_public_addresses", resolve)
    with pytest.raises(UrlFetchError, match="unsafe address"):
        UrlDocumentFetcher(settings)._fetch_sync("http://example.com/start")


def test_fetcher_enforces_remote_size_and_normalizes_filename(
    settings, monkeypatch
) -> None:
    FakeConnection.responses = [
        FakeResponse(
            200,
            {
                "Content-Type": "text/html; charset=utf-8",
                "Content-Length": str(settings.max_upload_bytes + 1),
            },
        )
    ]
    monkeypatch.setattr(url_ingestion, "_PinnedHTTPSConnection", FakeConnection)
    monkeypatch.setattr(
        url_ingestion,
        "_resolve_public_addresses",
        lambda _host, _port: ["93.184.216.34"],
    )
    with pytest.raises(UrlFetchError, match="exceeds"):
        UrlDocumentFetcher(settings)._fetch_sync("https://example.com/article")
    assert (
        _document_filename(None, "https://example.com/article?id=3", "text/html")
        == "article.html"
    )


def test_url_api_queues_document_and_redacts_query_metadata(
    settings, service, repository
) -> None:
    class Fetcher:
        async def fetch(self, url: str) -> FetchedDocument:
            return FetchedDocument(
                requested_url=url,
                final_url="https://ag.org/report.html?download_token=secret",
                filename="report.html",
                mime_type="text/html",
                content=b"<main><h1>Official report</h1><p>Evidence.</p></main>",
            )

    client = TestClient(
        create_app(
            settings,
            service,
            Authenticator(settings),
            url_fetcher=Fetcher(),
        )
    )
    response = client.post(
        "/v1/ingest/url",
        headers={"X-RAG-Token": settings.api_token},
        json={
            "group": "Church",
            "url": "https://ag.org/report.html?download_token=secret",
        },
    )
    assert response.status_code == 202
    document = repository.documents[next(iter(repository.documents))]
    assert document.source == "url"
    assert document.filename == "report.html"
    assert document.source_metadata["requested_url"] == "https://ag.org/report.html"
    assert document.source_metadata["url_query_redacted"] is True


def test_portal_exposes_exactly_one_source_url_workflow() -> None:
    root = url_ingestion.Path(__file__).parents[1]
    portal = (root / "app" / "static" / "index.html").read_text(encoding="utf-8")
    script = (root / "app" / "static" / "app.js").read_text(encoding="utf-8")
    assert 'id="upload-url"' in portal
    assert 'type="url"' in portal
    assert "/v1/ingest/url" in script
    assert "Choose one source mode" in script
    assert "waitForIngestion" in script
    assert "Previous failure found; retry queued." in script
    assert "const formElement = event.currentTarget" in script
    assert "formElement.reset()" in script
    assert "event.currentTarget.reset()" not in script


def test_group_creation_refreshes_focuses_and_reports_inline() -> None:
    root = url_ingestion.Path(__file__).parents[1]
    portal = (root / "app" / "static" / "index.html").read_text(encoding="utf-8")
    script = (root / "app" / "static" / "app.js").read_text(encoding="utf-8")
    styles = (root / "app" / "static" / "styles.css").read_text(encoding="utf-8")
    assert 'id="group-result"' in portal
    assert 'aria-live="polite"' in portal
    assert "await Promise.all([loadGroups(saved.slug), loadDocuments()])" in script
    assert "selected for ingestion" in script
    assert "card.scrollIntoView" in script
    assert ".cards article.created" in styles


def test_group_editing_keeps_slug_stable_and_refreshes_document_metadata() -> None:
    root = url_ingestion.Path(__file__).parents[1]
    portal = (root / "app" / "static" / "index.html").read_text(encoding="utf-8")
    script = (root / "app" / "static" / "app.js").read_text(encoding="utf-8")
    assert 'id="cancel-group-edit"' in portal
    assert "stable slug does not change" in portal
    assert 'class="quiet edit-group"' in script
    assert 'method: editingGroup ? "PATCH" : "POST"' in script
    assert "Existing documents and automatic routing" in script


def test_redacted_source_url_removes_query_and_fragment() -> None:
    assert (
        redact_url_for_storage("https://ag.org/report?id=1#section")
        == "https://ag.org/report"
    )
