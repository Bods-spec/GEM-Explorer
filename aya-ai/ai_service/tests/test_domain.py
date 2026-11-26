"""The domain layer: which GEM places a question names, and whether it asks about another museum."""

import json
from pathlib import Path

import pytest

from app import domain
from app.rag import relevance_flags, terms


def test_every_entity_in_the_dataset_has_aliases_and_nothing_else_does():
    path = Path(__file__).resolve().parent.parent / "knowledge" / "entities.json"
    keys = {e["entity_key"] for e in json.loads(path.read_text(encoding="utf-8"))}
    assert domain.known_entity_keys() == keys, "add (or remove) the aliases in app/domain.py"


@pytest.mark.parametrize("question, museum", [
    ("What can I see in the Louvre Museum in Paris?", "Louvre Museum"),
    ("Tell me about the Egyptian Museum in Tahrir Square", "Egyptian Museum in Tahrir Square, Cairo"),
    ("What are the opening hours of the British Museum?", "British Museum"),
    ("Where is the Metropolitan Museum of Art?", "Metropolitan Museum of Art"),
    ("Is there an Egyptian museum in Turin?", "Egyptian Museum in Turin"),
    ("ما هي أهم القطع في متحف اللوفر؟", "Louvre Museum"),
    ("باللوفر فيه ايه؟", "Louvre Museum"),
    ("المتحف المصري بالتحرير بيفتح امتى؟", "Egyptian Museum in Tahrir Square, Cairo"),
    ("ازاي اروح المتحف المصري في التحرير", "Egyptian Museum in Tahrir Square, Cairo"),
    ("ازاي اوصل المتحف المصري بالقاهرة", "Egyptian Museum in Tahrir Square, Cairo"),
    ("المتحف البريطاني فيه حجر رشيد؟", "British Museum"),
    ("هل المتحف القومي للحضارة المصرية قريب؟", "National Museum of Egyptian Civilization"),
    ("Tell me about the Luxor Museum", "Luxor Museum"),
])
def test_questions_about_another_museum_are_recognised(question, museum):
    assert domain.other_museum(question) == museum


@pytest.mark.parametrize("question", [
    "What can I see in the Tutankhamun Galleries?",
    "Tell me about Ramesses II",
    "Who built the pyramids of Giza?",
    "What is the history of ancient Egypt?",
    "Tell me about the Egyptian Museum",                     # on its own this is ambiguous: not refused
    "ما هو المتحف المصري الكبير؟",
    "ما هو المتحف المصري الكبير بالقاهرة؟",
    "Tell me about the Grand Egyptian Museum in Cairo",
    "Is the Grand Egyptian Museum bigger than the Louvre?",  # it names GEM itself
    "هل المتحف المصري الكبير أكبر من متحف اللوفر؟",
    "Where can I buy tickets?",
    "ما هي مواعيد المتحف؟",
    "Tell me about Khufu's Boats Museum",                    # a GEM place that has "museum" in its name
    "احكيلي عن كرسي العرش الذهبي",
])
def test_ordinary_questions_are_never_refused(question):
    assert domain.other_museum(question) is None


@pytest.mark.parametrize("question, expected", [
    ("Tell me about the Golden Throne.", {"golden-throne"}),
    ("What can I see in the Tutankhamun Galleries?", {"tutankhamun-galleries"}),
    ("What is the Hanging Obelisk?", {"hanging-obelisk"}),
    ("إيه أهم الآثار الموجودة في البهو العظيم؟", {"grand-hall"}),
    ("احكيلي عن المسلة المعلقة", {"hanging-obelisk"}),
    ("للبهو العظيم", {"grand-hall"}),
    ("ما هو كرسي العرش الذهبي؟", {"golden-throne"}),
    ("عايز أعرف عن القناع الدهبي لتوت عنخ آمون", {"golden-burial-mask", "tutankhamun-galleries"}),
    ("ايه اللي هشوفه في قاعات توت؟", {"tutankhamun-galleries"}),
    ("الدرج العظيم فيه كام قطعة؟", {"grand-stairs"}),
    ("Tell me about Khufu's boats", {"khufus-boats-museum"}),
    ("Tell me about the obelisk of Ramesses II", {"obelisk-ramesses-ii"}),
    ("What are the opening hours?", set()),
    ("What is the capital of Japan?", set()),
])
def test_named_places_and_artefacts_are_found(question, expected):
    assert domain.mentioned_entities(question) >= expected
    if not expected:
        assert domain.mentioned_entities(question) == frozenset()


def test_a_specific_artefact_outranks_its_area_in_the_same_question():
    named = domain.mentioned_entities("What was inside Tutankhamun's canopic chest?")
    assert {"canopic-chest", "tutankhamun-galleries"} <= named
    assert domain.entity_match("canopic-chest", named) == "exact"
    assert domain.entity_match("tutankhamun-galleries", named) == "related"   # named too, but less specific
    assert domain.entity_match("golden-throne", named) is None                # a sibling is not related
    assert domain.entity_match(None, named) is None


def test_children_of_a_named_area_are_related():
    named = domain.mentioned_entities("What can I see in the Tutankhamun Galleries?")
    assert domain.entity_match("tutankhamun-galleries", named) == "exact"
    assert domain.entity_match("golden-throne", named) == "related"
    assert domain.entity_match("grand-hall", named) is None


def test_fold_simplifies_arabic_and_latin():
    assert domain.fold("  المُسلَّة   المعلّقة! ").split() == ["المسله", "المعلقه"]
    assert domain.fold("Khufu’s Boats") == " khufus boats "


# ---- shared-word evidence ignores words that are in nearly every note ----

def _row(content, similarity=None):
    return {"content": content, "similarity": similarity}


def test_words_found_in_every_note_are_not_evidence():
    note = "Visitors can see the museum collection in the Grand Hall of the Egyptian museum."
    semantic, lexical, overlap, needed = relevance_flags(terms("What can I see in the museum?"), _row(note), 0.30)
    assert (lexical, needed) == (False, 0)


def test_distinctive_words_are_evidence():
    note = "The statue of Sekhmet stands on the Grand Stairs."
    _s, lexical, overlap, needed = relevance_flags(terms("Who is Sekhmet in the museum?"), _row(note), 0.30)
    assert lexical and (overlap, needed) == (1, 1)


def test_meaning_evidence_and_word_evidence_are_reported_separately():
    note = "Completely different words here about boats."
    semantic, lexical, *_ = relevance_flags(terms("golden throne"), _row(note, similarity=0.55), 0.30)
    assert semantic and not lexical
    semantic, lexical, *_ = relevance_flags(terms("golden throne"), _row("A golden throne.", similarity=0.05), 0.30)
    assert lexical and not semantic


def test_a_bare_obelisk_names_the_area_and_its_artefact_is_related():
    named = domain.mentioned_entities("What is the Hanging Obelisk?")
    assert domain.entity_match("hanging-obelisk", named) == "exact"
    assert domain.entity_match("obelisk-ramesses-ii", named) == "related"