from __future__ import annotations

import hashlib
import hmac
import time
from dataclasses import dataclass
from http.cookies import SimpleCookie
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

import httpx
from fastapi import Header, HTTPException, Request, status

from app.config import Settings


@dataclass(frozen=True)
class Principal:
    owner_id: UUID
    mechanism: str
    access_level: Literal["agent", "operator"]


class VoiceConnectPairedAuthenticator:
    """Validate the HttpOnly Voice Connect session without exposing RAG secrets.

    The same-origin portal uses the owner's Path=/ session. Voice Connect 2.0
    validates it on every request; neither the session database nor reusable
    operator credentials are exposed to the portal.
    """

    def __init__(
        self,
        settings: Settings,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        self.settings = settings
        self.client = client or httpx.AsyncClient(timeout=5.0)

    async def authenticate(self, request: Request) -> Principal:
        session = self._session_cookie(request.headers.get("cookie", ""))
        if not session:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="A paired Voice Connect session is required",
            )
        if not self.settings.voice_connect_auth_url:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Voice Connect authentication is not configured",
            )

        public = urlsplit(self.settings.public_base_url)
        if not public.hostname:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="RAG_PUBLIC_BASE_URL is required for Voice Connect authentication",
            )
        public_origin = f"{public.scheme}://{public.netloc}"
        if request.method.upper() not in {"GET", "HEAD", "OPTIONS"}:
            if request.headers.get("origin", "").rstrip("/") != public_origin:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Voice Connect origin validation failed",
                )

        try:
            response = await self.client.get(
                self.settings.voice_connect_auth_url,
                headers={
                    "Accept": "application/json",
                    "Cookie": f"vc_session={session}",
                    "Host": public.netloc,
                    "X-Forwarded-Host": public.netloc,
                    "X-Forwarded-Proto": public.scheme,
                },
            )
        except httpx.HTTPError as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Voice Connect authentication is unavailable",
            ) from exc
        if response.status_code != 200:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Voice Connect authentication is unavailable",
            )
        try:
            body = response.json()
            authenticated = body.get("authenticated") is True
            csrf = str(body.get("csrfToken") or "")
        except (AttributeError, TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Voice Connect returned an invalid authentication response",
            ) from exc
        if not authenticated:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="The Voice Connect session has expired",
            )
        if request.method.upper() not in {"GET", "HEAD", "OPTIONS"}:
            supplied = request.headers.get("x-csrf-token", "")
            if not csrf or not hmac.compare_digest(supplied, csrf):
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="Voice Connect CSRF validation failed",
                )
        return Principal(
            self.settings.owner_user_id,
            "voice-connect-paired",
            "operator",
        )

    @staticmethod
    def _session_cookie(raw_cookie: str) -> str:
        if len(raw_cookie) > 8192:
            return ""
        jar = SimpleCookie()
        try:
            jar.load(raw_cookie)
        except Exception:
            return ""
        morsel = jar.get("vc_session")
        if not morsel:
            return ""
        value = morsel.value.strip()
        if not value or len(value) > 512 or any(char.isspace() for char in value):
            return ""
        return value


class Authenticator:
    def __init__(
        self,
        settings: Settings,
        client: httpx.AsyncClient | None = None,
        voice_connect: VoiceConnectPairedAuthenticator | None = None,
    ) -> None:
        self.settings = settings
        self.client = client or httpx.AsyncClient(timeout=10.0)
        self.voice_connect = voice_connect or VoiceConnectPairedAuthenticator(settings)

    async def authenticate(
        self,
        request: Request,
        authorization: str | None = Header(default=None),
        x_rag_token: str | None = Header(default=None),
        x_voiceconnect_rag_portal: str | None = Header(default=None),
    ) -> Principal:
        if x_voiceconnect_rag_portal == "1":
            return await self.voice_connect.authenticate(request)
        token = (x_rag_token or "").strip()
        if token and self.settings.agent_api_token and hmac.compare_digest(
            token, self.settings.agent_api_token
        ):
            return Principal(self.settings.owner_user_id, "agent-token", "agent")
        if token and hmac.compare_digest(token, self.settings.api_token):
            return Principal(self.settings.owner_user_id, "operator-token", "operator")

        bearer = ""
        if authorization and authorization.lower().startswith("bearer "):
            bearer = authorization[7:].strip()
        if bearer and hmac.compare_digest(bearer, self.settings.api_token):
            return Principal(self.settings.owner_user_id, "operator-token", "operator")
        if bearer and self.settings.agent_api_token and hmac.compare_digest(
            bearer, self.settings.agent_api_token
        ):
            return Principal(self.settings.owner_user_id, "agent-token", "agent")
        if not bearer or not self.settings.publishable_key:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="A valid RAG token or paired Voice Connect session is required",
            )

        response = await self.client.get(
            f"{self.settings.supabase_url}/auth/v1/user",
            headers={
                "apikey": self.settings.publishable_key,
                "Authorization": f"Bearer {bearer}",
            },
        )
        if response.status_code != 200:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired owner session",
            )
        try:
            user_id = UUID(response.json()["id"])
        except (KeyError, TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid owner identity",
            ) from exc
        if user_id != self.settings.owner_user_id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="This RAG space belongs to a different user",
            )
        return Principal(user_id, "supabase-auth", "operator")


def sign_generated_link(settings: Settings, document_id: UUID, expires_at: int) -> str:
    if not settings.public_base_url or not settings.link_signing_secret:
        raise RuntimeError(
            "RAG_PUBLIC_BASE_URL and RAG_LINK_SIGNING_SECRET are required for generated PDF links"
        )
    message = f"{settings.owner_user_id}:{document_id}:{expires_at}".encode("utf-8")
    return hmac.new(
        settings.link_signing_secret.encode("utf-8"), message, hashlib.sha256
    ).hexdigest()


def verify_generated_link(
    settings: Settings, document_id: UUID, expires_at: int, signature: str
) -> bool:
    if expires_at < int(time.time()) or not settings.link_signing_secret:
        return False
    expected = sign_generated_link(settings, document_id, expires_at)
    return hmac.compare_digest(expected, signature.strip())
