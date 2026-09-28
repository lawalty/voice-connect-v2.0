from __future__ import annotations

import hashlib
import math
import asyncio
from typing import Protocol

import httpx

from app.config import Settings


EMBEDDING_DIMENSIONS = 384
SAFE_EDGE_EMBED_BATCH_SIZE = 4
TRANSIENT_EMBED_STATUS_CODES = {429, 500, 502, 503, 504}


class Embedder(Protocol):
    async def embed(self, texts: list[str]) -> list[list[float]]: ...


class SupabaseGteSmallEmbedder:
    """Invoke a private Supabase Edge Function backed by built-in gte-small."""

    def __init__(self, settings: Settings, client: httpx.AsyncClient | None = None) -> None:
        self.settings = settings
        self.client = client or httpx.AsyncClient(timeout=60.0)

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        embeddings: list[list[float]] = []
        for start in range(0, len(texts), SAFE_EDGE_EMBED_BATCH_SIZE):
            embeddings.extend(
                await self._embed_batch(
                    texts[start : start + SAFE_EDGE_EMBED_BATCH_SIZE]
                )
            )
        return embeddings

    async def _embed_batch(self, texts: list[str]) -> list[list[float]]:
        headers = {
            "apikey": self.settings.service_role_key,
            "Content-Type": "application/json",
        }
        if not self.settings.service_role_key.startswith("sb_secret_"):
            headers["Authorization"] = f"Bearer {self.settings.service_role_key}"
        response: httpx.Response | None = None
        last_transport_error: httpx.TransportError | None = None
        for attempt in range(4):
            try:
                response = await self.client.post(
                    f"{self.settings.supabase_url}/functions/v1/{self.settings.embed_function}",
                    headers=headers,
                    json={"inputs": texts},
                )
                last_transport_error = None
            except httpx.TransportError as exc:
                last_transport_error = exc
                if attempt == 3:
                    raise
            else:
                if response.status_code not in TRANSIENT_EMBED_STATUS_CODES or attempt == 3:
                    break
            await asyncio.sleep(0.5 * (2**attempt))
        if response is None:
            if last_transport_error is not None:
                raise last_transport_error
            raise RuntimeError("Embedding request did not return a response")
        if response.status_code == 546 and len(texts) > 1:
            midpoint = len(texts) // 2
            left = await self._embed_batch(texts[:midpoint])
            right = await self._embed_batch(texts[midpoint:])
            return [*left, *right]
        response.raise_for_status()
        payload = response.json()
        embeddings = payload.get("embeddings") if isinstance(payload, dict) else None
        if not isinstance(embeddings, list) or len(embeddings) != len(texts):
            raise RuntimeError("rag-embed returned an invalid embedding count")
        for embedding in embeddings:
            if not isinstance(embedding, list) or len(embedding) != EMBEDDING_DIMENSIONS:
                raise RuntimeError("rag-embed must return normalized 384-dimensional vectors")
        return embeddings


class DeterministicTestEmbedder:
    """Dependency-free deterministic vectors for unit tests only, never production fallback."""

    async def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._one(text) for text in texts]

    @staticmethod
    def _one(text: str) -> list[float]:
        values = [0.0] * EMBEDDING_DIMENSIONS
        for token in text.casefold().split():
            digest = hashlib.sha256(token.encode("utf-8")).digest()
            index = int.from_bytes(digest[:2], "big") % EMBEDDING_DIMENSIONS
            values[index] += 1.0 if digest[2] % 2 else -1.0
        norm = math.sqrt(sum(value * value for value in values)) or 1.0
        return [value / norm for value in values]


def vector_literal(values: list[float]) -> str:
    if len(values) != EMBEDDING_DIMENSIONS:
        raise ValueError(f"expected {EMBEDDING_DIMENSIONS} embedding dimensions")
    return "[" + ",".join(f"{value:.9g}" for value in values) + "]"
