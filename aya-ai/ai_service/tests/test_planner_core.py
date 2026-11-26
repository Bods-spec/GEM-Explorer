"""The plan builder (app/planner_core.py) on the REAL dataset: pure code, so these tests show the actual rules.

Time rules: minutes come from the team estimate of each area, scaled by pace; a plan never exceeds the visitor's time;
stops, artefacts and links come only from the catalog."""

import itertools
import json
from pathlib import Path

import pytest

from app.catalog import build_catalog
from app.planner_core import MAX_MINUTES, PACES, Preferences, build_plan, _full_visit, _short_visit
from app.planner_text import TAG_LABELS

KNOWLEDGE = Path(__file__).resolve().parent.parent / "knowledge"
TUT_RAMESSES = ["tutankhamun", "treasures", "ramesses"]


@pytest.fixture(scope="module")
def catalog():
    entities = json.loads((KNOWLEDGE / "entities.json").read_text(encoding="utf-8"))
    sources = json.loads((KNOWLEDGE / "sources.json").read_text(encoding="utf-8"))
    return build_catalog(entities, sources)


def plan(catalog, minutes, interests=(), must=(), removed=(), pace="normal", language="en"):
    return build_plan(Preferences(minutes, pace, list(interests), list(must), list(removed)), catalog, language)


def keys(result):
    return [s["key"] for s in result["stops"]]


# ---------------- the three budgets ----------------

@pytest.mark.parametrize("minutes", [60, 120, 180])
def test_a_plan_fits_the_time_and_follows_the_tour_order(catalog, minutes):
    result = plan(catalog, minutes, TUT_RAMESSES)
    assert result["stops"] and result["total_estimated_minutes"] <= minutes
    assert "tutankhamun-galleries" in keys(result)
    orders = [catalog.get(k).order for k in keys(result)]
    assert orders == sorted(orders)
    assert result["total_estimated_minutes"] == sum(s["minutes"] for s in result["stops"]) + result["transitions_total"] + result["rest_buffer_minutes"]
    assert result["free_minutes"] == minutes - result["total_estimated_minutes"]


def test_longer_visits_get_more_stops_and_a_rest_buffer(catalog):
    short, medium, long = (plan(catalog, m, TUT_RAMESSES) for m in (60, 120, 180))
    assert len(short["stops"]) < len(medium["stops"]) <= len(long["stops"])
    assert (short["rest_buffer_minutes"], medium["rest_buffer_minutes"], long["rest_buffer_minutes"]) == (0, 0, 10)
    assert all(s["minutes"] % 5 == 0 for r in (short, medium, long) for s in r["stops"])


def test_a_general_visit_without_interests_follows_the_museums_own_order(catalog):
    result = plan(catalog, 120)
    assert keys(result) == ["hanging-obelisk", "grand-hall", "grand-stairs", "main-galleries"] and {s["priority"] for s in result["stops"]} == {"general"}
    assert {n["reason"] for n in result["not_included"]} >= {"no_verified_estimate"}


# ---------------- invariants over many combinations ----------------

def test_invariants_hold_for_every_combination(catalog):
    area_keys = {a.key for a in catalog.areas()}
    artefacts = [p.key for p in catalog.places.values() if p.kind == "artifact"]
    for minutes, pace, interests, must, removed in itertools.product(
        range(0, 600, 35), PACES, ([], ["gold"], TUT_RAMESSES, ["history", "daily-life"]),
        ([], ["golden-throne"], ["colossal-statue-ramesses-ii", "sarcophagus-djehutymose"], ["khufus-boats-museum", "mirror-of-mesehti"]),
        ([], ["grand-stairs"], ["tutankhamun-galleries", "golden-throne"]),
    ):
        result = plan(catalog, minutes, interests, must, removed, pace)
        budget = min(minutes, MAX_MINUTES)
        assert result["total_estimated_minutes"] <= budget, (minutes, pace, interests, must, removed)
        assert len(set(keys(result))) == len(result["stops"])
        for stop in result["stops"]:
            area = catalog.get(stop["key"])
            assert stop["key"] in area_keys and area.minutes                     # only schedulable areas of the catalog
            assert _short_visit(area) <= stop["minutes"] <= _full_visit(area, pace)
            assert stop["sources"] and all(s["url"].startswith("https://") for s in stop["sources"])
            assert stop["key"] not in removed
            for h in stop["highlights"]:
                assert h["key"] in artefacts and catalog.get(h["key"]).parent == stop["key"] and h["key"] not in removed and h["sources"]
        assert not ({"khufus-boats-museum"} & set(keys(result)))                    # no verified time: never scheduled


def test_time_scales_with_pace_and_buffers_are_flat(catalog):
    relaxed, normal, fast = (plan(catalog, 240, [], (), (), p) for p in ("relaxed", "normal", "fast"))
    assert (relaxed["transition_minutes_each"], normal["transition_minutes_each"], fast["transition_minutes_each"]) == (10, 5, 5)
    assert _full_visit(catalog.get("main-galleries"), "relaxed") > _full_visit(catalog.get("main-galleries"), "normal") > _full_visit(catalog.get("main-galleries"), "fast")


# ---------------- priorities ----------------

def test_must_see_stops_come_before_interest_and_optional_ones(catalog):
    result = plan(catalog, 60, ["ramesses"], ["golden-throne"])
    by_key = {s["key"]: s for s in result["stops"]}
    assert by_key["tutankhamun-galleries"]["priority"] == "must_see"
    assert by_key["tutankhamun-galleries"]["minutes"] >= _short_visit(catalog.get("tutankhamun-galleries"))      # kept: never squeezed out
    assert by_key["tutankhamun-galleries"]["because"]["asked_for"] == ["Golden Throne"]
    assert [h["key"] for h in by_key["tutankhamun-galleries"]["highlights"]] == ["golden-throne"]
    others = [s for s in result["stops"] if s["priority"] != "must_see"]
    assert all(s["minutes"] == _short_visit(catalog.get(s["key"])) for s in others)      # the spare time went to the must-see first
    assert result["total_estimated_minutes"] <= 60


def test_optional_stops_only_use_spare_time_and_never_shrink_others(catalog):
    result = plan(catalog, 120, [], ["golden-throne"])
    fillers = [s for s in result["stops"] if s["priority"] == "filler"]
    must = next(s for s in result["stops"] if s["priority"] == "must_see")
    assert must["minutes"] == _full_visit(catalog.get("tutankhamun-galleries"), "normal")
    assert all(s["minutes"] == _full_visit(catalog.get(s["key"]), "normal") for s in fillers)


def test_artefacts_are_highlights_of_their_area_not_stops(catalog):
    result = plan(catalog, 120, ["gold"], ["golden-burial-mask", "golden-throne"])
    assert "golden-throne" not in keys(result) and "golden-burial-mask" not in keys(result)
    tut = next(s for s in result["stops"] if s["key"] == "tutankhamun-galleries")
    assert [h["key"] for h in tut["highlights"][:2]] == ["golden-burial-mask", "golden-throne"] and len(tut["highlights"]) <= 3


# ---------------- impossible and conflicting requests ----------------

def test_must_sees_that_cannot_fit_give_no_plan_and_say_what_they_need(catalog):
    result = plan(catalog, 30, [], ["golden-throne"])
    assert result["stops"] == [] and result["issues"][0]["code"] == "must_see_does_not_fit"
    assert result["issues"][0]["needs_minutes"] == 40 and result["issues"][0]["names"] == ["Golden Throne (Tutankhamun Galleries)"]


def test_some_must_sees_fit_and_the_rest_are_reported(catalog):
    result = plan(catalog, 45, [], ["colossal-statue-ramesses-ii", "sarcophagus-djehutymose", "golden-throne"])
    issue = next(i for i in result["issues"] if i["code"] == "left_out_for_time")
    assert "Grand Hall" in [s["name"] for s in result["stops"]] and any("Golden Throne" in n for n in issue["names"])
    assert result["total_estimated_minutes"] <= 45


def test_a_visit_that_is_too_short_for_anything_gives_no_stops(catalog):
    assert plan(catalog, 5)["stops"] == [] and plan(catalog, 0)["stops"] == []


def test_removed_stops_stay_out_and_are_reported(catalog):
    result = plan(catalog, 180, ["kings", "statues"], [], ["grand-stairs"])
    assert "grand-stairs" not in keys(result)
    assert {"key": "grand-stairs", "name": "Grand Stairs", "reason": "removed_by_visitor"} in result["not_included"]


def test_asking_for_and_removing_the_same_thing_is_reported_not_guessed(catalog):
    result = plan(catalog, 120, [], ["grand-stairs"], ["grand-stairs"])
    assert "grand-stairs" not in keys(result) and result["issues"][0]["code"] == "asked_and_removed"


def test_places_without_a_verified_time_are_named_but_never_scheduled(catalog):
    result = plan(catalog, 300, [], ["khufus-boats-museum"])
    assert "khufus-boats-museum" not in keys(result)
    assert {"key": "khufus-boats-museum", "name": "Khufu's Boats Museum", "reason": "no_verified_estimate"} in result["not_included"]


def test_very_long_visits_are_capped(catalog):
    result = plan(catalog, 5000)
    assert result["budget_minutes"] == MAX_MINUTES and result["total_estimated_minutes"] <= MAX_MINUTES
    assert any(i["code"] == "capped" for i in result["issues"])


def test_unknown_keys_cannot_create_stops(catalog):
    result = plan(catalog, 120, ["no-such-tag"], ["made-up-room", "pyramid-of-giza"], ["nonsense"])
    assert all(catalog.get(k) is not None for k in keys(result))


# ---------------- language, sources, catalog rules ----------------

def test_arabic_plans_use_arabic_names_and_arabic_pages_first(catalog):
    result = plan(catalog, 120, ["obelisks"], [], [], "normal", "ar")
    stop = result["stops"][0]
    assert stop["name"] == "المسلة المعلقة" and "/ar/" in stop["sources"][0]["url"]
    english = plan(catalog, 120, ["obelisks"])["stops"][0]
    assert "/ar/" not in english["sources"][0]["url"]


def test_every_source_is_a_known_row_of_the_knowledge_base(catalog):
    known = {s["url"] for s in json.loads((KNOWLEDGE / "sources.json").read_text(encoding="utf-8"))}
    result = plan(catalog, 240, TUT_RAMESSES, ["golden-throne"])
    urls = [s["url"] for stop in result["stops"] for s in stop["sources"]] + [s["url"] for stop in result["stops"] for h in stop["highlights"] for s in h["sources"]]
    assert urls and set(urls) <= known


def test_the_catalog_ignores_entities_it_cannot_trust():
    sources = [{"source_key": "s1", "title": "T", "url": "https://gem.eg/x", "source_type": "official"}]
    base = dict(entity_key="a", kind="area", parent_key=None, name_en="A", name_ar="", summary_en="", summary_ar="", suggested_minutes=30,
                minutes_basis="team_estimate", visit_order=1, interest_tags=["kings"], verification_status="verified", source_keys=["s1"])
    rows = [base, {**base, "entity_key": "b", "source_keys": ["missing"]},                      # no known source: dropped
            {**base, "entity_key": "c", "verification_status": "conflicting"},                   # conflicting: dropped
            {**base, "entity_key": "d", "minutes_basis": None},                                  # minutes not a team estimate: never scheduled
            {**base, "entity_key": "e", "suggested_minutes": None},
            {**base, "entity_key": "f", "source_keys": ["s1"], "name_en": ""}]
    catalog = build_catalog(rows, sources + [{"source_key": "bad", "title": "T", "url": "http://insecure", "source_type": "official"}])
    assert set(catalog.places) == {"a", "d", "e"} and [a.key for a in catalog.areas()] == ["a"]


def test_every_interest_tag_in_the_data_has_a_label_in_both_languages(catalog):
    assert set(catalog.tags()) <= set(TAG_LABELS)