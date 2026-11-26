"""The OpenAI and Supabase clients, against the fake servers (no network)."""

import httpx
import pytest

import fakes
from app.clients import OpenAIEmbedder, SupabaseRest, UpstreamError, vector_literal
from app.config import EMBEDDING_DIMENSIONS


def embedder(world, **kw):
    sleeps = []
    return OpenAIEmbedder(fakes.OPENAI_KEY, "text-embedding-3-small", world.client, sleep=sleeps.append, **kw), sleeps


# ---------------- OpenAI embeddings ----------------

def test_embed_request_shape_and_order(world):
    e, _ = embedder(world)
    vectors = e.embed(["golden mask", "grand hall"])
    req = world.openai.requests[0]
    assert req["json"] == {"model": "text-embedding-3-small", "input": ["golden mask", "grand hall"],
                           "dimensions": EMBEDDING_DIMENSIONS, "encoding_format": "float"}
    assert req["headers"]["authorization"] == f"Bearer {fakes.OPENAI_KEY}"
    # the fake answers in reverse order; the client must put them back in input order
    assert vectors[0] == fakes.hash_embedding("golden mask")
    assert vectors[1] == fakes.hash_embedding("grand hall")


def test_embed_cleans_whitespace_and_rejects_empty(world):
    e, _ = embedder(world)
    e.embed(["  golden \n  mask  "])
    assert world.openai.requests[0]["json"]["input"] == ["golden mask"]
    for bad in ([], [""], ["ok", "   "]):
        with pytest.raises(ValueError):
            e.embed(bad)
    assert len(world.openai.requests) == 1


def test_embed_retries_rate_limit_then_succeeds(world):
    world.openai.fail_status, world.openai.fail_times = 429, 2
    e, sleeps = embedder(world)
    assert len(e.embed(["hello museum"])[0]) == EMBEDDING_DIMENSIONS
    assert len(world.openai.requests) == 3
    assert sleeps == [0.5, 1.0]


def test_embed_gives_up_after_retries_without_leaking_the_key(world):
    world.openai.fail_status, world.openai.fail_times = 500, 99
    e, _ = embedder(world)
    with pytest.raises(UpstreamError) as caught:
        e.embed(["hello"])
    assert len(world.openai.requests) == 3
    assert caught.value.status == 500
    assert fakes.OPENAI_KEY not in str(caught.value)


def test_embed_does_not_retry_client_errors(world):
    world.openai.fail_status, world.openai.fail_times = 400, 99
    e, _ = embedder(world)
    with pytest.raises(UpstreamError):
        e.embed(["hello"])
    assert len(world.openai.requests) == 1


def test_embed_timeout_becomes_upstream_error(world):
    world.openai.timeout = True
    e, _ = embedder(world)
    with pytest.raises(UpstreamError) as caught:
        e.embed(["hello"])
    assert caught.value.status is None


def test_embed_rejects_wrong_vector_size(world):
    world.openai.bad_dimension = True
    e, _ = embedder(world)
    with pytest.raises(UpstreamError):
        e.embed(["hello"])


def test_bad_openai_key_is_reported_cleanly(world):
    e = OpenAIEmbedder("sk-wrong", "text-embedding-3-small", world.client, sleep=lambda _s: None)
    with pytest.raises(UpstreamError) as caught:
        e.embed(["hello"])
    assert caught.value.status == 401 and "sk-wrong" not in str(caught.value)


def test_vector_literal_format():
    assert vector_literal([0.5, 1.0, -0.25]) == "[0.5,1,-0.25]"


# ---------------- Supabase REST ----------------

def supabase(world, secret=fakes.SECRET_KEY):
    return SupabaseRest(fakes.SUPABASE_URL, secret, fakes.PUBLISHABLE_KEY, world.client)


def test_new_style_secret_key_goes_only_in_apikey_header(world):
    supabase(world).select("museum_sources", "source_key")
    headers = world.supabase.requests[0]["headers"]
    assert headers["apikey"] == fakes.SECRET_KEY
    assert "authorization" not in headers


def test_jwt_style_key_is_also_sent_as_bearer(world):
    jwt_key = "eyJhbGciOiJIUzI1NiJ9.payload.signature"
    s = SupabaseRest(fakes.SUPABASE_URL, jwt_key, fakes.PUBLISHABLE_KEY, world.client)
    with pytest.raises(UpstreamError):          # the fake only accepts the new-style key (401)
        s.select("museum_sources", "source_key")
    headers = world.supabase.requests[0]["headers"]
    assert headers["apikey"] == jwt_key and headers["authorization"] == f"Bearer {jwt_key}"


def test_upsert_request_shape_and_batching(world):
    s = supabase(world)
    rows = [{"source_key": f"source-{i:03d}", "title": "t", "url": f"https://x/{i}", "publisher": "p",
             "source_type": "official", "license": None, "retrieved_on": "2026-11-26", "notes": None} for i in range(250)]
    s.upsert("museum_sources", rows, "source_key", batch=100)
    posts = world.supabase.writes("museum_sources")
    assert [len(p["json"]) for p in posts] == [100, 100, 50]
    assert posts[0]["params"] == {"on_conflict": "source_key"}
    assert posts[0]["headers"]["prefer"] == "resolution=merge-duplicates,return=minimal"


def test_rpc_sends_named_parameters(world):
    rows = supabase(world).rpc("search_museum_knowledge", {
        "query_text": "x", "query_embedding": None, "query_language": "en", "match_count": 3, "include_conflicting": False})
    assert rows == []
    sent = world.supabase.requests[0]
    assert sent["path"] == "/rest/v1/rpc/search_museum_knowledge"
    assert sent["json"]["query_embedding"] is None


def test_verify_user_uses_publishable_key_and_the_visitors_token(world):
    world.supabase.tokens["tok-abcdefghijklmnopqrstu"] = {"id": "u1", "is_anonymous": True}
    user = supabase(world).verify_user("tok-abcdefghijklmnopqrstu")
    assert user == {"id": "u1", "is_anonymous": True}
    headers = world.supabase.requests[0]["headers"]
    assert headers["apikey"] == fakes.PUBLISHABLE_KEY
    assert headers["authorization"] == "Bearer tok-abcdefghijklmnopqrstu"
    assert fakes.SECRET_KEY not in str(world.supabase.requests[0])


def test_verify_user_rejects_junk_without_calling_supabase(world):
    s = supabase(world)
    for junk in ("short", "has spaces in the token value xxxxxxxx", "x" * 5000, ""):
        assert s.verify_user(junk) is None
    assert world.supabase.requests == []


def test_verify_user_invalid_token_is_none_and_outage_is_an_error(world):
    s = supabase(world)
    assert s.verify_user("not-a-known-token-0000000000") is None
    world.supabase.auth_status = 500
    with pytest.raises(UpstreamError):
        s.verify_user("not-a-known-token-0000000000")


def test_missing_tables_give_a_helpful_hint(world):
    world.supabase.missing_tables = True
    with pytest.raises(UpstreamError) as caught:
        supabase(world).select("museum_sources", "id")
    assert "knowledge_base.sql" in str(caught.value)


def test_plain_http_supabase_url_is_refused():
    with pytest.raises(ValueError):
        SupabaseRest("http://example.com", "k", "p")
    SupabaseRest("http://localhost:54321", "k", "p")     # local development is allowed


def test_network_failure_is_a_clean_error():
    def boom(request):
        raise httpx.ConnectError("no route", request=request)
    s = SupabaseRest(fakes.SUPABASE_URL, fakes.SECRET_KEY, "p", httpx.Client(transport=httpx.MockTransport(boom)))
    with pytest.raises(UpstreamError) as caught:
        s.select("museum_sources", "id")
    assert fakes.SECRET_KEY not in str(caught.value)
