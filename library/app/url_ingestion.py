from __future__ import annotations

import asyncio
import http.client
import ipaddress
import re
import socket
import ssl
from dataclasses import dataclass
from email.message import Message
from pathlib import Path
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit

import certifi

from app.config import Settings


REDIRECT_STATUSES = {301, 302, 303, 307, 308}
SUPPORTED_URL_MIME_TYPES = {
    "application/octet-stream",
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/xhtml+xml",
    "text/html",
    "text/markdown",
    "text/plain",
    "text/x-markdown",
}
MIME_EXTENSIONS = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/xhtml+xml": ".html",
    "text/html": ".html",
    "text/markdown": ".md",
    "text/plain": ".txt",
    "text/x-markdown": ".md",
}
MIME_ALLOWED_EXTENSIONS = {
    "application/pdf": {".pdf"},
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
        ".docx"
    },
    "application/xhtml+xml": {".htm", ".html"},
    "text/html": {".htm", ".html"},
    "text/markdown": {".md", ".txt"},
    "text/plain": {".md", ".txt"},
    "text/x-markdown": {".md", ".txt"},
}
DOCUMENT_EXTENSIONS = {".docx", ".htm", ".html", ".md", ".pdf", ".txt"}
_CONTROL_OR_SPACE = re.compile(r"[\x00-\x20\x7f]")


class UrlFetchError(ValueError):
    pass


@dataclass(frozen=True)
class FetchedDocument:
    requested_url: str
    final_url: str
    filename: str
    mime_type: str
    content: bytes


def redact_url_for_storage(value: str) -> str:
    """Keep public provenance without persisting query-string credentials."""
    parsed = urlsplit(value)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


def _normalized_host(value: str) -> str:
    try:
        return value.rstrip(".").encode("idna").decode("ascii").casefold()
    except UnicodeError as exc:
        raise UrlFetchError("The URL hostname is not valid") from exc


def _is_public_ip(value: str) -> bool:
    address = ipaddress.ip_address(value.split("%", 1)[0])
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        address = address.ipv4_mapped
    return address.is_global


def _resolve_public_addresses(host: str, port: int) -> list[str]:
    try:
        answers = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise UrlFetchError(f"The URL hostname could not be resolved: {host}") from exc
    addresses: list[str] = []
    for answer in answers:
        address = answer[4][0]
        if _is_public_ip(address) and address not in addresses:
            addresses.append(address)
    if not addresses:
        raise UrlFetchError(
            "The URL resolves only to a private, local, reserved, or otherwise unsafe address"
        )
    return addresses


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host: str, connect_ip: str, port: int, timeout: float) -> None:
        super().__init__(host, port=port, timeout=timeout)
        self._connect_ip = connect_ip

    def connect(self) -> None:
        self.sock = self._create_connection(
            (self._connect_ip, self.port), self.timeout, self.source_address
        )


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, connect_ip: str, port: int, timeout: float) -> None:
        super().__init__(
            host,
            port=port,
            timeout=timeout,
            context=ssl.create_default_context(cafile=certifi.where()),
        )
        self._connect_ip = connect_ip

    def connect(self) -> None:
        raw_socket = self._create_connection(
            (self._connect_ip, self.port), self.timeout, self.source_address
        )
        self.sock = self._context.wrap_socket(raw_socket, server_hostname=self.host)


class UrlDocumentFetcher:
    def __init__(self, settings: Settings) -> None:
        self.max_bytes = settings.max_upload_bytes
        self.timeout = settings.url_fetch_timeout_seconds
        self.max_redirects = settings.url_max_redirects
        self.allowed_domains = tuple(
            _normalized_host(domain.lstrip("."))
            for domain in settings.url_allowed_domains
            if domain.strip()
        )

    async def fetch(self, url: str) -> FetchedDocument:
        return await asyncio.to_thread(self._fetch_sync, url)

    def _validate_url(self, value: str) -> tuple[str, str, int, str]:
        value = value.strip()
        if not value or len(value) > 2048 or _CONTROL_OR_SPACE.search(value):
            raise UrlFetchError("Enter a valid public HTTP(S) URL up to 2,048 characters")
        try:
            parsed = urlsplit(value)
            port = parsed.port
        except ValueError as exc:
            raise UrlFetchError("The URL contains an invalid port") from exc
        scheme = parsed.scheme.casefold()
        if scheme not in {"http", "https"}:
            raise UrlFetchError("Only public HTTP(S) URLs can be ingested")
        if parsed.username is not None or parsed.password is not None:
            raise UrlFetchError("URLs containing embedded credentials are not allowed")
        if not parsed.hostname:
            raise UrlFetchError("The URL must contain a hostname")
        host = _normalized_host(parsed.hostname)
        if self.allowed_domains and not any(
            host == domain or host.endswith(f".{domain}")
            for domain in self.allowed_domains
        ):
            raise UrlFetchError("The URL hostname is not in RAG_URL_ALLOWED_DOMAINS")
        port = port or (443 if scheme == "https" else 80)
        if port not in {80, 443}:
            raise UrlFetchError("Only standard HTTP and HTTPS ports are allowed")
        target = urlunsplit(
            (
                scheme,
                _netloc(host, port, scheme),
                parsed.path or "/",
                parsed.query,
                "",
            )
        )
        return target, host, port, scheme

    def _fetch_sync(self, requested_url: str) -> FetchedDocument:
        current_url = requested_url.strip()
        initial_url = current_url
        for redirect_count in range(self.max_redirects + 1):
            current_url, host, port, scheme = self._validate_url(current_url)
            addresses = _resolve_public_addresses(host, port)
            response: http.client.HTTPResponse | None = None
            connection: http.client.HTTPConnection | None = None
            last_error: Exception | None = None
            for address in addresses:
                try:
                    connection_type = (
                        _PinnedHTTPSConnection
                        if scheme == "https"
                        else _PinnedHTTPConnection
                    )
                    connection = connection_type(host, address, port, self.timeout)
                    parsed = urlsplit(current_url)
                    path = quote(parsed.path or "/", safe="/%:@!$&'()*+,;=-._~")
                    if parsed.query:
                        path += "?" + quote(parsed.query, safe="=&%:@!$'()*+,;/?-._~")
                    connection.request(
                        "GET",
                        path,
                        headers={
                            "Accept": "application/pdf, application/vnd.openxmlformats-officedocument.wordprocessingml.document, text/html, application/xhtml+xml, text/markdown, text/plain; q=0.9, */*; q=0.1",
                            "Accept-Encoding": "identity",
                            "Host": _host_header(host, port, scheme),
                            "User-Agent": "Hermes-RAG-URL-Ingestion/0.4 (+document fetcher)",
                        },
                    )
                    response = connection.getresponse()
                    break
                except (OSError, ssl.SSLError, http.client.HTTPException) as exc:
                    last_error = exc
                    if connection is not None:
                        connection.close()
                    connection = None
            if response is None or connection is None:
                raise UrlFetchError(f"Could not connect to the URL: {last_error}")
            try:
                if response.status in REDIRECT_STATUSES:
                    location = response.getheader("Location")
                    if not location:
                        raise UrlFetchError("The URL returned a redirect without a destination")
                    if redirect_count >= self.max_redirects:
                        raise UrlFetchError("The URL exceeded the redirect limit")
                    next_url = urljoin(current_url, location)
                    if scheme == "https" and urlsplit(next_url).scheme.casefold() == "http":
                        raise UrlFetchError("HTTPS-to-HTTP redirects are not allowed")
                    current_url = next_url
                    continue
                if not 200 <= response.status < 300:
                    raise UrlFetchError(f"The URL returned HTTP {response.status}")
                encoding = (response.getheader("Content-Encoding") or "identity").casefold()
                if encoding not in {"", "identity"}:
                    raise UrlFetchError(
                        f"The URL ignored the identity request and returned unsupported {encoding} encoding"
                    )
                length_header = response.getheader("Content-Length")
                if length_header:
                    try:
                        remote_length = int(length_header)
                    except ValueError:
                        remote_length = None
                    if remote_length is not None and remote_length > self.max_bytes:
                        raise UrlFetchError(
                            f"The remote document exceeds the {self.max_bytes} byte limit"
                        )
                content = _read_limited(response, self.max_bytes)
                mime_type = _mime_type(response.getheader("Content-Type"), current_url)
                filename = _document_filename(
                    response.getheader("Content-Disposition"), current_url, mime_type
                )
                return FetchedDocument(
                    requested_url=initial_url,
                    final_url=current_url,
                    filename=filename,
                    mime_type=mime_type,
                    content=content,
                )
            finally:
                response.close()
                connection.close()
        raise UrlFetchError("The URL exceeded the redirect limit")


def _netloc(host: str, port: int, scheme: str) -> str:
    display_host = f"[{host}]" if ":" in host else host
    default_port = 443 if scheme == "https" else 80
    return display_host if port == default_port else f"{display_host}:{port}"


def _host_header(host: str, port: int, scheme: str) -> str:
    return _netloc(host, port, scheme)


def _read_limited(response: http.client.HTTPResponse, max_bytes: int) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = response.read(min(65_536, max_bytes - total + 1))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
        if total > max_bytes:
            raise UrlFetchError(f"The remote document exceeds the {max_bytes} byte limit")
    content = b"".join(chunks)
    if not content:
        raise UrlFetchError("The remote document is empty")
    return content


def _mime_type(header: str | None, url: str) -> str:
    mime_type = (header or "").split(";", 1)[0].strip().casefold()
    aliases = {
        "application/x-pdf": "application/pdf",
        "binary/octet-stream": "application/octet-stream",
    }
    mime_type = aliases.get(mime_type, mime_type)
    if not mime_type:
        extension = Path(unquote(urlsplit(url).path)).suffix.casefold()
        mime_type = {
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".htm": "text/html",
            ".html": "text/html",
            ".md": "text/markdown",
            ".pdf": "application/pdf",
            ".txt": "text/plain",
        }.get(extension, "")
    if mime_type not in SUPPORTED_URL_MIME_TYPES:
        raise UrlFetchError(f"The URL returned an unsupported media type: {mime_type or 'unknown'}")
    return mime_type


def _document_filename(disposition: str | None, url: str, mime_type: str) -> str:
    candidate = ""
    if disposition:
        message = Message()
        message["Content-Disposition"] = disposition
        candidate = message.get_filename() or ""
    candidate = candidate or Path(unquote(urlsplit(url).path)).name
    candidate = candidate.strip().replace("\x00", "")
    suffix = Path(candidate).suffix.casefold()
    expected = MIME_EXTENSIONS.get(mime_type)
    if mime_type == "application/octet-stream":
        if suffix not in DOCUMENT_EXTENSIONS:
            raise UrlFetchError(
                "The URL returned application/octet-stream without a supported document filename"
            )
    elif expected and suffix not in MIME_ALLOWED_EXTENSIONS.get(mime_type, set()):
        candidate = f"{Path(candidate).stem or 'document'}{expected}"
    return candidate or f"document{expected or '.txt'}"
