"""Step 1 tests. They run the app in memory: no network, no OpenAI, no Supabase."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app

ROOT = Path(__file__).resolve().parent.parent
client = TestClient(app)


def test_health_is_ok():
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["service"] == "gem-ai-guide"
    assert isinstance(body["openai_configured"], bool)
    assert isinstance(body["supabase_configured"], bool)


def test_health_never_returns_secrets(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-this-must-never-appear")
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "sb_secret_this-must-never-appear")
    response = client.get("/health")
    text = response.text
    assert "this-must-never-appear" not in text
    assert "example.supabase.co" not in text
    body = response.json()
    assert body["openai_configured"] is True
    assert body["supabase_configured"] is True


def test_keys_reported_missing_when_empty(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "   ")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)
    body = client.get("/health").json()
    assert body["openai_configured"] is False
    assert body["supabase_configured"] is False


def test_cors_allows_only_the_frontend_origin():
    ok = client.get("/health", headers={"Origin": "http://localhost:5600"})
    assert ok.headers.get("access-control-allow-origin") == "http://localhost:5600"
    other = client.get("/health", headers={"Origin": "http://evil.example"})
    assert "access-control-allow-origin" not in other.headers


def test_unknown_route_is_404():
    assert client.get("/nope").status_code == 404


def test_post_to_health_is_refused():
    assert client.post("/health").status_code == 405


@pytest.mark.parametrize("name", ["sources", "entities", "chunks"])
def test_rag_dataset_files_are_present_and_valid(name):
    """The prepared knowledge files travel with the service (they are not loaded anywhere yet)."""
    data = json.loads((ROOT / "knowledge" / f"{name}.json").read_text(encoding="utf-8"))
    assert isinstance(data, list) and len(data) > 0
