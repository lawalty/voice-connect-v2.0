from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


ProcessingMode = Literal[
    "automatic",
    "gemini-3.7-flash",
    "gemini-3.1-pro-preview",
]


class GroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    slug: str | None = Field(default=None, pattern=r"^[a-z0-9][a-z0-9-]{0,62}$")
    aliases: list[str] = Field(default_factory=list, max_length=30)
    description: str = Field(default="", max_length=2000)

    @field_validator("name", "description")
    @classmethod
    def strip_text(cls, value: str) -> str:
        return value.strip()

    @field_validator("aliases")
    @classmethod
    def normalize_aliases(cls, values: list[str]) -> list[str]:
        normalized = []
        for value in values:
            clean = value.strip()
            if clean and clean.casefold() not in {
                item.casefold() for item in normalized
            }:
                normalized.append(clean)
        return normalized


class GroupUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    aliases: list[str] | None = Field(default=None, max_length=30)
    description: str | None = Field(default=None, max_length=2000)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        clean = value.strip()
        if not clean:
            raise ValueError("name cannot be blank")
        return clean

    @field_validator("description")
    @classmethod
    def strip_description(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None

    @field_validator("aliases")
    @classmethod
    def normalize_aliases(cls, values: list[str] | None) -> list[str] | None:
        if values is None:
            return None
        normalized = []
        for value in values:
            clean = value.strip()
            if clean and clean.casefold() not in {
                item.casefold() for item in normalized
            }:
                normalized.append(clean)
        return normalized

    @model_validator(mode="after")
    def require_change(self) -> "GroupUpdate":
        if not self.model_fields_set or all(
            getattr(self, field_name) is None for field_name in self.model_fields_set
        ):
            raise ValueError("at least one editable group field is required")
        return self


class Group(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: UUID
    owner_id: UUID
    name: str
    slug: str
    aliases: list[str] = Field(default_factory=list)
    description: str = ""
    system_key: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class Document(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: UUID
    owner_id: UUID
    group_id: UUID
    filename: str
    mime_type: str
    storage_bucket: str | None = None
    storage_path: str | None = None
    size_bytes: int
    sha256: str
    status: Literal["pending", "processing", "ready", "failed"]
    source: str
    document_kind: Literal["upload", "generated"] = "upload"
    created_by_agent: bool = False
    title: str | None = None
    generated_title_key: str | None = None
    body_markdown: str | None = None
    revision: int = 1
    archived_at: datetime | None = None
    source_metadata: dict[str, Any] = Field(default_factory=dict)
    error: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    group_name: str | None = None
    group_slug: str | None = None
    group_system_key: str | None = None
    chunk_count: int = Field(default=0, ge=0)


class Job(BaseModel):
    model_config = ConfigDict(extra="ignore")
    id: UUID
    owner_id: UUID
    document_id: UUID
    document_revision: int = 1
    status: Literal["queued", "processing", "completed", "failed"]
    attempts: int = 0
    error: str | None = None
    created_at: datetime | None = None
    started_at: datetime | None = None
    completed_at: datetime | None = None


class SearchRequest(BaseModel):
    query: str = Field(min_length=2, max_length=4000)
    group: str | None = Field(default=None, max_length=80)
    session_group: str | None = Field(default=None, max_length=80)
    include_generated: bool = False
    limit: int = Field(default=8, ge=1, le=20)


class RouteCandidate(BaseModel):
    id: UUID
    name: str
    slug: str
    score: float


class SearchHit(BaseModel):
    chunk_id: UUID
    document_id: UUID
    group_id: UUID
    group_name: str
    group_slug: str
    filename: str
    chunk_index: int
    content: str
    score: float
    semantic_similarity: float | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class SearchResponse(BaseModel):
    query: str
    routing_reason: str
    ambiguous_group: bool
    searched_groups: list[RouteCandidate]
    hits: list[SearchHit]


class IngestAccepted(BaseModel):
    document_id: UUID
    job_id: UUID
    group: str
    status: str
    duplicate: bool = False
    retried: bool = False


class UrlIngestRequest(BaseModel):
    group: str = Field(min_length=1, max_length=80)
    url: str = Field(min_length=8, max_length=2048)
    processing_mode: ProcessingMode = "automatic"

    @field_validator("group", "url")
    @classmethod
    def strip_url_ingest_text(cls, value: str) -> str:
        return value.strip()


class GeneratedDocumentCreate(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    markdown: str = Field(min_length=1, max_length=200_000)

    @field_validator("title", "markdown")
    @classmethod
    def strip_generated_text(cls, value: str) -> str:
        return value.strip()


class GeneratedDocumentUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    markdown: str = Field(min_length=1, max_length=200_000)

    @field_validator("title", "markdown")
    @classmethod
    def strip_generated_update_text(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None


class GeneratedDocumentAccepted(BaseModel):
    document_id: UUID
    job_id: UUID
    title: str
    group: str
    status: str
    revision: int
    pdf_path: str


class AgentDocumentAccepted(BaseModel):
    document_id: UUID
    job_id: UUID
    filename: str
    group: str
    status: str
    revision: int


class AgentDocumentArchive(BaseModel):
    archived: bool = True


class SignedLink(BaseModel):
    document_id: UUID
    filename: str
    url: str
    expires_in: int
