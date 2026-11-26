"""The ingestion script: dataset checks, dry run, and a full mocked load."""

import copy
import json
import re

import pytest

import fakes
from app import ingest
from app.clients import OpenAIEmbedder, UpstreamError
from app.config import EMBEDDING_DIMENSIONS
from conftest import make_settings


# ---------------- the dataset files ----------------

def test_real_dataset_is_valid(dataset):
    assert ingest.validate_dataset(dataset) == []
    assert (len(dataset["sources"]), len(dataset["entities"]), len(dataset["chunks"])) == (52, 22, 72)


@pytest.mark.parametrize("mutate, expected", [
    (lambda d: d["chunks"][0].update(content_hash="0" * 64), "content_hash"),
    (lambda d: d["chunks"][0].update(source_key="nope"), "unknown source"),
    (lambda d: d["chunks"][0].update(entity_key="nope"), "unknown entity"),
    (lambda d: d["chunks"][0].update(language="fr"), "bad language"),
    (lambda d: d["chunks"][0].update(verification_status="maybe"), "bad verification_status"),
    (lambda d: d["chunks"][0].update(content="too short", content_hash=ingest.sha256("too short")), "20..1500"),
    (lambda d: d["chunks"].append(copy.deepcopy(d["chunks"][0])), "duplicate chunk_key"),
    (lambda d: d["entities"][-1].update(parent_key="nope"), "unknown parent"),
    (lambda d: d["entities"][0].update(minutes_basis=None), "minutes_basis"),
    (lambda d: d["entities"][0].update(source_keys=[]), "source_keys must be a non-empty list"),
    (lambda d: d["entities"][0].update(source_keys=["no-such-source"]), "not in sources.json"),
    (lambda d: d["entities"][0].update(source_keys=d["entities"][0]["source_keys"] * 2), "duplicate source_keys"),
    (lambda d: d["entities"][0].update(source_keys=[None]), "source_keys must be a non-empty list"),
    (lambda d: d["entities"][0].update(name_ar="Hanging Obelisk"), "name_ar has no Arabic letters"),
    (lambda d: d["entities"][0].update(summary_ar="Hanging Obelisk"), "summary_ar has no Arabic letters"),
    (lambda d: d["entities"][0].update(suggested_minutes=None), "minutes_basis without suggested_minutes"),
    (lambda d: d["chunks"][0].update(content="The visit takes about 30 minutes in total.", content_hash=ingest.sha256("The visit takes about 30 minutes in total.")), "states minutes"),
    (lambda d: d["chunks"][0].update(content="تستغرق الزيارة نحو 30 دقيقة في المتوسط.", content_hash=ingest.sha256("تستغرق الزيارة نحو 30 دقيقة في المتوسط.")), "mostly not Arabic|states minutes|marked English"),
    (lambda d: next(c for c in d["chunks"] if c["language"] == "ar").update(language="en"), "marked English"),
    (lambda d: next(c for c in d["chunks"] if c["language"] == "en").update(language="ar"), "marked Arabic"),
    (lambda d: d["sources"][0].update(url="http://insecure.example"), "https://"),
    (lambda d: d["sources"][0].update(source_type="blog"), "source_type"),
])
def test_validation_catches_problems(dataset, mutate, expected):
    bad = copy.deepcopy(dataset)
    mutate(bad)
    errors = ingest.validate_dataset(bad)
    assert any(re.search(expected, e) for e in errors), errors


# ---------------- the command line ----------------

def test_dry_run_needs_no_keys_and_sends_nothing(monkeypatch, capsys):
    def forbidden(*_a, **_k):
        raise AssertionError("a dry run must not even read the settings")
    monkeypatch.setattr(ingest, "get_settings", forbidden)
    monkeypatch.setattr(ingest, "SupabaseRest", forbidden)
    monkeypatch.setattr(ingest, "OpenAIEmbedder", forbidden)
    assert ingest.main([]) == 0
    out = capsys.readouterr().out
    assert "DRY RUN" in out and "Nothing was sent" in out and "72 notes" in out


def test_apply_without_keys_stops_with_a_clear_message(monkeypatch, capsys):
    monkeypatch.setattr(ingest, "get_settings", lambda: make_settings(openai_api_key="", supabase_secret_key=""))
    assert ingest.main(["--apply"]) == 2
    assert "fill in" in capsys.readouterr().out


def test_apply_reports_missing_tables_without_secrets(monkeypatch, capsys, world):
    world.supabase.missing_tables = True
    monkeypatch.setattr(ingest, "get_settings", lambda: make_settings())
    real_supabase, real_openai = ingest.SupabaseRest, ingest.OpenAIEmbedder
    monkeypatch.setattr(ingest, "SupabaseRest", lambda url, secret, pub: real_supabase(url, secret, pub, world.client))
    monkeypatch.setattr(ingest, "OpenAIEmbedder", lambda key, model: real_openai(key, model, world.client))
    assert ingest.main(["--apply"]) == 3
    out = capsys.readouterr().out
    assert "knowledge_base.sql" in out
    assert not any(secret in out for secret in fakes.ALL_SECRETS)


def test_apply_end_to_end_through_main(monkeypatch, capsys, world):
    monkeypatch.setattr(ingest, "get_settings", lambda: make_settings())
    real_supabase, real_openai = ingest.SupabaseRest, ingest.OpenAIEmbedder
    monkeypatch.setattr(ingest, "SupabaseRest", lambda url, secret, pub: real_supabase(url, secret, pub, world.client))
    monkeypatch.setattr(ingest, "OpenAIEmbedder", lambda key, model: real_openai(key, model, world.client))
    assert ingest.main(["--apply"]) == 0
    out = capsys.readouterr().out
    assert '"chunks_embedded": 72' in out
    assert not any(secret in out for secret in fakes.ALL_SECRETS)


# ---------------- the load itself ----------------

def test_full_load_into_the_fake_database(world, clients, dataset):
    report = ingest.run_ingest(dataset, *clients)
    assert report == {"sources": 52, "entities": 22, "chunks_embedded": 72, "chunks_metadata_updated": 0, "chunks_unchanged": 0}

    t = world.supabase.tables
    assert (len(t["museum_sources"]), len(t["museum_entities"]), len(t["museum_chunks"])) == (52, 22, 72)

    # one OpenAI request, 72 texts, nothing but the note text was sent
    assert len(world.openai.requests) == 1
    assert world.openai.embedded_texts == [c["content"] for c in dataset["chunks"]]

    sample = t["museum_chunks"]["golden-burial-mask-en"]
    assert sample["embedding_model"] == "text-embedding-3-small"
    assert len(json.loads(sample["embedding"])) == EMBEDDING_DIMENSIONS
    source = next(s for s in t["museum_sources"].values() if s["id"] == sample["source_id"])
    assert source["source_key"] == "gem-art-golden-mask"
    assert "fts" not in sample          # the database fills this in itself
    assert t["museum_entities"]["colossal-statue-ramesses-ii"]["parent_key"] == "grand-hall"


def test_areas_are_written_before_artefacts(world, clients, dataset):
    ingest.run_ingest(dataset, *clients)
    kinds = [{r["kind"] for r in req["json"]} for req in world.supabase.writes("museum_entities")]
    assert kinds == [{"area"}, {"artifact"}]


def test_only_the_expected_tables_are_written(world, clients, dataset):
    ingest.run_ingest(dataset, *clients)
    tables = {r["path"] for r in world.supabase.requests if r["method"] == "POST"}
    assert tables == {"/rest/v1/museum_sources", "/rest/v1/museum_entities", "/rest/v1/museum_chunks"}


def test_running_twice_embeds_nothing_the_second_time(world, clients, dataset):
    ingest.run_ingest(dataset, *clients)
    world.openai.requests.clear()
    chunk_writes_before = len(world.supabase.writes("museum_chunks"))
    report = ingest.run_ingest(dataset, *clients)
    assert report["chunks_embedded"] == 0 and report["chunks_unchanged"] == 72
    assert world.openai.requests == []
    assert len(world.supabase.writes("museum_chunks")) == chunk_writes_before
    assert len(world.supabase.chunks) == 72


def test_changed_text_is_embedded_again_alone(world, clients, dataset):
    ingest.run_ingest(dataset, *clients)
    world.openai.requests.clear()
    changed = copy.deepcopy(dataset)
    changed["chunks"][3]["content"] += " An extra sentence added after review."
    changed["chunks"][3]["content_hash"] = ingest.sha256(changed["chunks"][3]["content"])
    report = ingest.run_ingest(changed, *clients)
    assert report["chunks_embedded"] == 1 and report["chunks_unchanged"] == 71
    assert world.openai.embedded_texts == [changed["chunks"][3]["content"]]


def test_metadata_change_updates_without_embedding_again(world, clients, dataset):
    ingest.run_ingest(dataset, *clients)
    world.openai.requests.clear()
    key = dataset["chunks"][0]["chunk_key"]
    old_embedding = world.supabase.chunks[key]["embedding"]
    changed = copy.deepcopy(dataset)
    changed["chunks"][0]["verification_status"] = "conflicting"
    report = ingest.run_ingest(changed, *clients)
    assert report["chunks_metadata_updated"] == 1 and report["chunks_embedded"] == 0
    assert world.openai.requests == []
    assert world.supabase.chunks[key]["verification_status"] == "conflicting"
    assert world.supabase.chunks[key]["embedding"] == old_embedding      # the stored vector is kept


def test_new_embedding_model_re_embeds_everything(world, clients, dataset):
    ingest.run_ingest(dataset, *clients)
    world.openai.requests.clear()
    other = OpenAIEmbedder(fakes.OPENAI_KEY, "text-embedding-3-large", world.client, sleep=lambda _s: None)
    report = ingest.run_ingest(dataset, clients[0], other)
    assert report["chunks_embedded"] == 72
    assert world.supabase.chunks["gem-hours-en"]["embedding_model"] == "text-embedding-3-large"


def test_invalid_dataset_is_refused_before_any_request(world, clients, dataset):
    bad = copy.deepcopy(dataset)
    bad["chunks"][0]["content_hash"] = "x"
    with pytest.raises(ValueError):
        ingest.run_ingest(bad, *clients)
    assert world.supabase.requests == [] and world.openai.requests == []


def test_openai_failure_leaves_chunks_unwritten(world, clients, dataset):
    world.openai.fail_status, world.openai.fail_times = 500, 99
    with pytest.raises(UpstreamError):
        ingest.run_ingest(dataset, *clients)
    assert world.supabase.chunks == {}          # nothing half-written without vectors


# ---------------- source keys, Arabic names and team estimates ----------------

def test_a_source_key_missing_in_the_database_stops_the_load_before_entities(world, clients, dataset, monkeypatch):
    """The database is asked which sources really exist; a missing one stops everything that points at it."""
    real_select = world.supabase._select

    def select_without_one(table, columns):
        rows = real_select(table, columns)
        if table == "museum_sources":
            rows = [r for r in rows if r["source_key"] != dataset["entities"][0]["source_keys"][0]]
        return rows

    monkeypatch.setattr(world.supabase, "_select", select_without_one)
    with pytest.raises(ValueError, match="not found in museum_sources"):
        ingest.run_ingest(dataset, *clients)
    assert world.supabase.tables["museum_entities"] == {} and world.supabase.tables["museum_chunks"] == {}
    assert world.openai.requests == []          # and nothing was sent to OpenAI


def test_official_gem_arabic_names_are_used(dataset):
    names = {e["entity_key"]: e["name_ar"] for e in dataset["entities"]}
    assert names["grand-hall"] == "البهو العظيم"
    assert names["grand-stairs"] == "الدرج العظيم"
    assert names["hanging-obelisk"] == "المسلة المعلقة"
    everything = json.dumps(dataset["entities"] + dataset["chunks"], ensure_ascii=False)
    assert "القاعة الكبرى" not in everything     # the earlier, unofficial wording


def test_every_entity_has_arabic_text_and_an_arabic_note(dataset):
    arabic_notes = {c["entity_key"] for c in dataset["chunks"] if c["language"] == "ar"}
    for e in dataset["entities"]:
        assert re.search(r"[؀-ۿ]", e["name_ar"] or ""), e["entity_key"]
        assert re.search(r"[؀-ۿ]", e["summary_ar"] or ""), e["entity_key"]
        assert e["entity_key"] in arabic_notes, e["entity_key"]


def test_visit_durations_are_team_estimates_and_not_stated_in_the_notes(dataset):
    for e in dataset["entities"]:
        if e["suggested_minutes"] is not None:
            assert e["minutes_basis"] == "team_estimate", e["entity_key"]
        else:
            assert e["minutes_basis"] is None, e["entity_key"]
    assert not [c["chunk_key"] for c in dataset["chunks"] if ingest._MINUTES_RE.search(c["content"])]


# ---------------- content decisions (26 Nov 2026) ----------------

def test_the_disputed_117_figure_is_not_stated_anywhere(dataset):
    """The English page says acres and the Arabic page says feddans; neither unit is used."""
    text = json.dumps(dataset["chunks"] + dataset["entities"], ensure_ascii=False)
    assert "117" not in text and "فدان" not in text and not re.search(r"\bacres?\b", text, re.I)
    timeline = {c["chunk_key"]: c["content"] for c in dataset["chunks"]}
    assert "1992" in timeline["gem-history-timeline-en"] and "1992" in timeline["gem-history-timeline-ar"]


def test_complex_size_is_the_500000_square_metres_from_the_map_pages(dataset):
    notes = {c["chunk_key"]: c for c in dataset["chunks"]}
    assert "500,000 square metres" in notes["gem-complex-size-en"]["content"]
    assert notes["gem-complex-size-en"]["source_key"] == "gem-complex-map"
    assert "500 ألف متر مربع" in notes["gem-complex-size-ar"]["content"]
    assert notes["gem-complex-size-ar"]["source_key"] == "gem-ar-complex-map"


def test_hanging_obelisk_is_neutral_except_in_clearly_attributed_wording_notes(dataset):
    notes = {c["chunk_key"]: c for c in dataset["chunks"]}
    entity_text = json.dumps([e for e in dataset["entities"] if e["entity_key"] == "hanging-obelisk"], ensure_ascii=False)
    for key in ("hanging-obelisk-en", "hanging-obelisk-ar"):
        text = notes[key]["content"]
        assert not re.search(r"\b(first|only)\b|أول|الوحيد", text), key
    assert not re.search(r"\b(first|only)\b|أول|الوحيد", entity_text)
    # the museum's own claims are kept, each in its own note, tied to its own official page, and flagged as unverified
    en, ar = notes["hanging-obelisk-wording-en"], notes["hanging-obelisk-wording-ar"]
    assert (en["source_key"], ar["source_key"]) == ("gem-art-obelisk-ramesses-ii", "gem-ar-art-obelisk-ramesses-ii")
    assert "museum's" in en["content"] and "not verified it independently" in en["content"]
    assert "لم نتحقق منها بشكل مستقل" in ar["content"]
    assert all(n["entity_key"] == "hanging-obelisk" for n in (en, ar))
