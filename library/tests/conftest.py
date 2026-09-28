from __future__ import annotations

from uuid import UUID

import pytest

from app.config import Settings
from app.embeddings import DeterministicTestEmbedder
from app.models import Group
from app.service import RagService
from tests.fakes import FakeRepository, FakeStorage

OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")


@pytest.fixture
def settings() -> Settings:
    return Settings(
        supabase_url="https://project.supabase.co",
        service_role_key="service-role-test",
        publishable_key="publishable-test",
        owner_user_id=OWNER_ID,
        api_token="t" * 40,
        agent_api_token="a" * 40,
        public_base_url="https://rag.example",
        link_signing_secret="s" * 40,
        inline_worker=False,
    )


@pytest.fixture
def repository() -> FakeRepository:
    repo = FakeRepository()
    repo.groups.extend(
        [
            Group(
                id=UUID("22222222-2222-2222-2222-222222222222"),
                owner_id=OWNER_ID,
                name="Church",
                slug="church",
                aliases=["NorthPointe"],
                description="Sermons and ministry",
            ),
            Group(
                id=UUID("33333333-3333-3333-3333-333333333333"),
                owner_id=OWNER_ID,
                name="EZCORP",
                slug="ezcorp",
                aliases=["EZ"],
                description="Company operations",
            ),
            Group(
                id=UUID("44444444-4444-4444-4444-444444444444"),
                owner_id=OWNER_ID,
                name="Personal",
                slug="personal",
                aliases=["Home"],
                description="Personal records",
            ),
        ]
    )
    return repo


@pytest.fixture
def storage() -> FakeStorage:
    return FakeStorage()


@pytest.fixture
def service(
    settings: Settings, repository: FakeRepository, storage: FakeStorage
) -> RagService:
    return RagService(settings, repository, storage, DeterministicTestEmbedder())
