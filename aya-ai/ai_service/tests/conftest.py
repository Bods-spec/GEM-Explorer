import pytest
from fastapi.testclient import TestClient

import fakes
from app.config import Settings
from app.ingest import load_dataset, run_ingest
from app.main import app
from app.services import build_services, get_services
from app.clients import OpenAIEmbedder, SupabaseRest

USER_TOKEN = "user-token-aaaaaaaaaaaaaaaaaaaaaaaa"
OTHER_TOKEN = "user-token-bbbbbbbbbbbbbbbbbbbbbbbb"
GUEST_TOKEN = "guest-token-cccccccccccccccccccccc"


def make_settings(**overrides) -> Settings:
    values = dict(
        frontend_origin="http://localhost:5600", app_env="development", allow_guest_users=True,
        supabase_url=fakes.SUPABASE_URL, supabase_secret_key=fakes.SECRET_KEY,
        supabase_publishable_key=fakes.PUBLISHABLE_KEY, openai_api_key=fakes.OPENAI_KEY,
        openai_embedding_model="text-embedding-3-small", rag_min_similarity=0.30,
        rag_user_per_minute=20, rag_ip_per_minute=60, rag_daily_limit=2000,
        openai_chat_model="test-chat-model", guide_user_per_minute=6, guide_user_per_day=100, guide_daily_limit=1000,
    )
    values.update(overrides)
    return Settings(**values)


@pytest.fixture
def world():
    w = fakes.World()
    w.supabase.tokens[USER_TOKEN] = {"id": "user-a"}
    w.supabase.tokens[OTHER_TOKEN] = {"id": "user-b"}
    w.supabase.tokens[GUEST_TOKEN] = {"id": "guest-1", "is_anonymous": True}
    yield w
    assert w.stray == [], f"the app contacted an unexpected host: {w.stray}"


@pytest.fixture
def dataset():
    return load_dataset()


@pytest.fixture
def clients(world):
    return (
        SupabaseRest(fakes.SUPABASE_URL, fakes.SECRET_KEY, fakes.PUBLISHABLE_KEY, world.client),
        OpenAIEmbedder(fakes.OPENAI_KEY, "text-embedding-3-small", world.client, sleep=lambda _s: None),
    )


@pytest.fixture
def ingested(world, clients, dataset):
    """The real dataset, loaded into the fake database through the real ingestion code."""
    run_ingest(dataset, *clients)
    world.openai.requests.clear()
    world.supabase.requests.clear()
    return world


@pytest.fixture
def make_client(world):
    """TestClient wired to the fake servers. Call make_client(**settings_overrides)."""
    made = []

    def factory(**overrides) -> TestClient:
        services = build_services(make_settings(**overrides), world.client)
        services.embedder and setattr(services.embedder, "_sleep", lambda _s: None)
        services.guide and setattr(services.guide._chat, "_sleep", lambda _s: None)
        app.dependency_overrides[get_services] = lambda: services
        client = TestClient(app)
        client.services = services
        made.append(client)
        return client

    yield factory
    app.dependency_overrides.clear()


def auth(token: str = USER_TOKEN) -> dict:
    return {"Authorization": f"Bearer {token}"}