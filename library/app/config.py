from __future__ import annotations

import hmac
import os
from dataclasses import dataclass
from uuid import UUID

from dotenv import load_dotenv


def _bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int) -> int:
    value = os.getenv(name)
    return int(value) if value else default


def _float(name: str, default: float) -> float:
    value = os.getenv(name)
    return float(value) if value else default


@dataclass(frozen=True)
class Settings:
    supabase_url: str
    service_role_key: str
    publishable_key: str
    owner_user_id: UUID
    api_token: str
    agent_api_token: str = ""
    public_base_url: str = ""
    link_signing_secret: str = ""
    storage_bucket: str = "rag-documents"
    max_upload_bytes: int = 52_428_800
    url_fetch_timeout_seconds: float = 20.0
    url_max_redirects: int = 5
    url_allowed_domains: tuple[str, ...] = ()
    signed_url_ttl_seconds: int = 3600
    generated_link_ttl_seconds: int = 86_400
    generated_link_max_ttl_seconds: int = 604_800
    max_generated_markdown_chars: int = 200_000
    inline_worker: bool = True
    embed_function: str = "rag-embed"
    embed_batch_size: int = 4
    local_pdf_ocr_enabled: bool = True
    ocr_languages: str = "eng"
    ocr_dpi: int = 200
    ocr_min_embedded_chars: int = 32
    ocr_page_timeout_seconds: float = 90.0
    gemini_api_key: str = ""
    gemini_api_base_url: str = "https://generativelanguage.googleapis.com"
    gemini_api_upload_base_url: str = "https://generativelanguage.googleapis.com/upload"
    route_min_score: float = 0.28
    route_min_margin: float = 0.06
    voice_connect_auth_url: str = ""

    @classmethod
    def from_env(cls) -> Settings:
        load_dotenv()
        missing = [
            name
            for name in (
                "SUPABASE_URL",
                "RAG_OWNER_USER_ID",
                "RAG_API_TOKEN",
                "RAG_AGENT_API_TOKEN",
            )
            if not os.getenv(name, "").strip()
        ]
        secret_key = (
            os.getenv("SUPABASE_SECRET_KEY", "").strip()
            or os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        )
        if not secret_key:
            missing.append("SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY)")
        if missing:
            raise RuntimeError(
                f"Missing required environment variables: {', '.join(missing)}"
            )
        token = os.environ["RAG_API_TOKEN"].strip()
        agent_token = os.environ["RAG_AGENT_API_TOKEN"].strip()
        if len(token) < 32:
            raise RuntimeError("RAG_API_TOKEN must contain at least 32 characters")
        if len(agent_token) < 32:
            raise RuntimeError("RAG_AGENT_API_TOKEN must contain at least 32 characters")
        if hmac.compare_digest(token.encode("utf-8"), agent_token.encode("utf-8")):
            raise RuntimeError("RAG_AGENT_API_TOKEN must be different from RAG_API_TOKEN")
        public_base_url = os.getenv("RAG_PUBLIC_BASE_URL", "").strip().rstrip("/")
        link_signing_secret = os.getenv("RAG_LINK_SIGNING_SECRET", "").strip()
        if public_base_url and not public_base_url.startswith(
            ("https://", "http://127.0.0.1", "http://localhost")
        ):
            raise RuntimeError("RAG_PUBLIC_BASE_URL must use HTTPS except on loopback")
        if link_signing_secret and len(link_signing_secret) < 32:
            raise RuntimeError(
                "RAG_LINK_SIGNING_SECRET must contain at least 32 characters"
            )
        if link_signing_secret and hmac.compare_digest(
            link_signing_secret.encode("utf-8"), token.encode("utf-8")
        ):
            raise RuntimeError(
                "RAG_LINK_SIGNING_SECRET must be different from RAG_API_TOKEN"
            )
        if link_signing_secret and hmac.compare_digest(
            link_signing_secret.encode("utf-8"), agent_token.encode("utf-8")
        ):
            raise RuntimeError(
                "RAG_LINK_SIGNING_SECRET must be different from RAG_AGENT_API_TOKEN"
            )
        return cls(
            supabase_url=os.environ["SUPABASE_URL"].rstrip("/"),
            service_role_key=secret_key,
            publishable_key=os.getenv("SUPABASE_PUBLISHABLE_KEY", "").strip(),
            owner_user_id=UUID(os.environ["RAG_OWNER_USER_ID"].strip()),
            api_token=token,
            agent_api_token=agent_token,
            public_base_url=public_base_url,
            link_signing_secret=link_signing_secret,
            storage_bucket=os.getenv("RAG_STORAGE_BUCKET", "rag-documents").strip(),
            max_upload_bytes=_int("RAG_MAX_UPLOAD_BYTES", 52_428_800),
            url_fetch_timeout_seconds=_float(
                "RAG_URL_FETCH_TIMEOUT_SECONDS", 20.0
            ),
            url_max_redirects=_int("RAG_URL_MAX_REDIRECTS", 5),
            url_allowed_domains=tuple(
                value.strip()
                for value in os.getenv("RAG_URL_ALLOWED_DOMAINS", "").split(",")
                if value.strip()
            ),
            signed_url_ttl_seconds=_int("RAG_SIGNED_URL_TTL_SECONDS", 3600),
            generated_link_ttl_seconds=_int("RAG_GENERATED_LINK_TTL_SECONDS", 86_400),
            generated_link_max_ttl_seconds=_int(
                "RAG_GENERATED_LINK_MAX_TTL_SECONDS", 604_800
            ),
            max_generated_markdown_chars=_int(
                "RAG_MAX_GENERATED_MARKDOWN_CHARS", 200_000
            ),
            inline_worker=_bool("RAG_INLINE_WORKER", True),
            embed_function=os.getenv("RAG_EMBED_FUNCTION", "rag-embed").strip(),
            embed_batch_size=_int("RAG_EMBED_BATCH_SIZE", 4),
            local_pdf_ocr_enabled=_bool("RAG_LOCAL_PDF_OCR_ENABLED", True),
            ocr_languages=os.getenv("RAG_OCR_LANGUAGES", "eng").strip() or "eng",
            ocr_dpi=_int("RAG_OCR_DPI", 200),
            ocr_min_embedded_chars=_int("RAG_OCR_MIN_EMBEDDED_CHARS", 32),
            ocr_page_timeout_seconds=_float(
                "RAG_OCR_PAGE_TIMEOUT_SECONDS", 90.0
            ),
            gemini_api_key=(
                os.getenv("GEMINI_API_KEY", "").strip()
                or os.getenv("GOOGLE_API_KEY", "").strip()
            ),
            gemini_api_base_url=os.getenv(
                "RAG_GEMINI_API_BASE_URL",
                "https://generativelanguage.googleapis.com",
            ).strip().rstrip("/"),
            gemini_api_upload_base_url=os.getenv(
                "RAG_GEMINI_API_UPLOAD_BASE_URL",
                "https://generativelanguage.googleapis.com/upload",
            ).strip().rstrip("/"),
            route_min_score=_float("RAG_ROUTE_MIN_SCORE", 0.28),
            route_min_margin=_float("RAG_ROUTE_MIN_MARGIN", 0.06),
            voice_connect_auth_url=os.getenv(
                "RAG_VOICE_CONNECT_AUTH_URL",
                "http://127.0.0.1:18880/api/status",
            ).strip(),
        )
