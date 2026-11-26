"""Which places and artefacts of the Grand Egyptian Museum does a question name, and does it
explicitly ask about a DIFFERENT museum?

Two small, readable lookups; no AI and no network:

  mentioned_entities(question) -> {"golden-throne", ...}
      used to rank the notes of the thing the visitor named above generic notes.

  other_museum(question) -> "Louvre Museum" | None
      a visitor who asks about the Louvre must hear "I only have information about GEM",
      even though the words "museum" or "see" also appear in our notes.
      A question is NOT refused when it also names GEM itself ("Is GEM bigger than the
      Louvre?"). Questions that name no museum at all (ordinary questions about Egyptian
      history, artefacts or GEM) are never touched by this check.

The lists are written by hand and cover the common cases. A museum that is not on the
list is still handled by the normal evidence rules (similarity / shared words).
tests/test_domain.py fails if an entity in knowledge/entities.json has no entry here.
"""

import json
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

_AR = "ء-ي"                       # Arabic letters
_ENTITIES_FILE = Path(__file__).resolve().parent.parent / "knowledge" / "entities.json"


def fold(text: str) -> str:
    """Lower-case, no diacritics or apostrophes, simplified Arabic spelling, single spaces, padded with spaces."""
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c)).replace("ـ", "")
    for src, dst in (("أ", "ا"), ("إ", "ا"), ("آ", "ا"), ("ٱ", "ا"), ("ى", "ي"), ("ة", "ه")):
        text = text.replace(src, dst)
    text = re.sub(r"['’`]", "", text)
    return " " + " ".join(re.sub(r"[\W_]+", " ", text).split()) + " "


def _en(phrase: str) -> str:
    words = [re.escape(w) + r"(?:s|es)?" for w in fold(phrase).split()]
    return r"(?<![a-z0-9])" + r"\s+".join(words) + r"(?![a-z0-9])"


def _ar(phrase: str) -> str:
    """An Arabic phrase that also matches with ال / و / ب / ل / ف in front ("باللوفر", "للبهو")."""
    parts = []
    for i, word in enumerate(fold(phrase).split()):
        core = word[2:] if word.startswith("ال") and len(word) > 4 else word
        parts.append((r"(?:لل|[وفبكل]?(?:ال)?)" if i == 0 else r"(?:لل|[لب]?(?:ال)?)") + re.escape(core))
    return rf"(?<![{_AR}])" + r"\s+".join(parts) + rf"(?![{_AR}])"


def _compile(english: list[str], arabic: list[str]) -> list[re.Pattern]:
    return [re.compile(p) for p in [*map(_en, english), *map(_ar, arabic)]]


# ---------------------------------------------------------------------------
# GEM's own places and artefacts (every entity in knowledge/entities.json)
# english aliases, arabic aliases (Egyptian dialect spellings included)
# ---------------------------------------------------------------------------

_ENTITY_WORDS: dict[str, tuple[list[str], list[str]]] = {
    "hanging-obelisk": (["hanging obelisk", "obelisk"], ["المسلة المعلقة", "مسلة", "المسلة"]),
    "grand-hall": (["grand hall", "entrance hall", "main hall"], ["البهو العظيم", "البهو الكبير", "بهو", "البهو"]),
    "grand-stairs": (["grand stairs", "grand staircase", "grand stair", "stairs", "staircase"],
                     ["الدرج العظيم", "السلم العظيم", "السلم الكبير", "الدرج الكبير", "الدرج", "السلم"]),
    "main-galleries": (["main galleries", "main gallery", "main halls"],
                       ["قاعات العرض الرئيسة", "قاعات العرض الرئيسية", "القاعات الرئيسية", "القاعات الرئيسه", "قاعات رئيسية"]),
    "tutankhamun-galleries": (["tutankhamun galleries", "tutankhamun gallery", "tutankhamun hall", "tutankhamun treasures",
                               "tutankhamun", "tutankhamen", "tutankhamon", "king tut", "tut galleries", "tut"],
                              ["قاعات توت عنخ امون", "قاعات عرض كنوز توت عنخ امون", "كنوز توت عنخ امون", "قاعات توت", "قاعة توت",
                               "توت عنخ امون", "توت"]),
    "khufus-boats-museum": (["khufu boat", "khufu ship", "khufu solar boat", "solar boat", "boats museum", "khufu"],
                            ["متحف مراكب الملك خوفو", "مراكب خوفو", "مركب خوفو", "مركب الملك خوفو", "مراكب الملك خوفو", "خوفو"]),
    "colossal-statue-ramesses-ii": (["colossal statue", "statue of ramesses", "ramesses statue", "ramses statue", "rameses statue",
                                     "ramesses", "ramses", "rameses"],
                                    ["تمثال رمسيس", "تمثال الملك رمسيس", "التمثال الضخم", "تمثال حجري ضخم", "رمسيس"]),
    # a bare "obelisk" names the area (the Hanging Obelisk), not this artefact inside it
    "obelisk-ramesses-ii": (["obelisk of ramesses", "obelisk of ramses", "ramesses obelisk", "ramses obelisk", "ramesses", "ramses", "rameses"],
                            ["مسلة الملك رمسيس", "مسلة رمسيس", "رمسيس"]),
    "seated-statue-sekhmet": (["sekhmet", "sakhmet", "lioness goddess", "seated statue of goddess"],
                              ["سخمت", "المعبودة سخمت", "اللبوة"]),
    "doorway-amenemhat-i": (["amenemhat", "amenemhet", "doorway", "granite doorway"], ["امنمحات", "امنمحت", "بوابة"]),
    "standing-statue-thutmose-iii": (["thutmose", "tuthmosis", "thutmosis", "tuthmose"], ["تحتمس", "تحتموس"]),
    "ramesses-ii-and-a-goddess": (["ramesses ii and a goddess", "ramesses and a goddess", "ramses and a goddess", "ramesses", "ramses", "rameses"],
                                  ["رمسيس وإحدى المعبودات", "رمسيس والمعبودة", "رمسيس"]),
    "sarcophagus-djehutymose": (["djehutymose", "djehuty mose", "sarcophagus"], ["جحوتي مس", "جحوتي", "تابوت جحوتي مس"]),
    "golden-burial-mask": (["golden burial mask", "golden mask", "burial mask", "death mask", "gold mask", "tutankhamun mask", "mask"],
                           ["القناع الذهبي", "قناع الدفن الذهبي", "قناع الدفن", "قناع توت عنخ امون", "قناع"]),
    "royal-diadem": (["royal diadem", "diadem", "royal crown"], ["الاكليل الملكي", "الاكليل", "التاج الملكي", "اكليل"]),
    "outer-coffin": (["outer coffin", "coffin"], ["التابوت الخارجي", "التابوت", "تابوت"]),
    "golden-throne": (["golden throne", "throne", "gold throne"],
                      ["كرسي العرش الذهبي", "العرش الذهبي", "الكرسي الذهبي", "كرسي العرش", "العرش", "عرش"]),
    "canopic-chest": (["canopic chest", "canopic shrine", "canopic jars", "canopic"],
                      ["صندوق الاواني الكانوبية", "الاواني الكانوبية", "الكانوبي", "كانوبي", "كانوبية"]),
    "guardian-statues": (["guardian statues", "guardian statue", "ka statues", "ka statue", "guardian figures"],
                         ["تمثال الكا", "تماثيل الكا", "الحارسين", "تماثيل الحراسة", "التمثالين الحارسين"]),
    "anubis-on-a-chest": (["anubis"], ["انوبيس", "أنوبيس", "انوبس"]),
    "model-funerary-bed": (["funerary bed", "funeral bed", "model of tutankhamun", "tutankhamun on a bed"],
                           ["النعش", "تمثال الملك راقدا", "الملك راقدا على النعش"]),
    "mirror-of-mesehti": (["mesehti", "bronze mirror", "mirror"], ["مسحتي", "مرآة برونزية", "مراه برونزيه", "المرآة", "مراه"]),
}

# the museum itself
_GEM_NAMES = _compile(["grand egyptian museum", "gem", "g e m", "gem explorer"],
                      ["المتحف المصري الكبير", "المتحف الكبير", "متحف مصري كبير"])

# ---------------------------------------------------------------------------
# other museums a visitor might name: (name shown to the caller, patterns)
# ---------------------------------------------------------------------------

_OTHER_MUSEUMS: list[tuple[str, list[re.Pattern]]] = [
    ("Louvre Museum", _compile(["louvre"], ["لوفر"])),
    ("British Museum", _compile(["british museum"], ["المتحف البريطاني", "متحف بريطاني"])),
    ("Metropolitan Museum of Art", _compile(["metropolitan museum", "the met museum", "met museum"], ["متحف متروبوليتان", "المتروبوليتان"])),
    ("Egyptian Museum in Tahrir Square, Cairo", [
        re.compile(r"(?<!grand )egyptian museum(?:\s+(?:of|in|at|near|on|the|old|downtown|cairo|square))*\s*(?:tahrir|cairo|downtown)"),
        re.compile(r"(?<![a-z])(?:tahrir|downtown cairo|old cairo)\s+museum"),
        re.compile(r"(?<![a-z])cairo museum"),
        re.compile(r"(?<![a-z])museum\s+(?:in|at|of|near)\s+(?:the\s+)?tahrir"),
        re.compile(rf"(?<![{_AR}])[وفبكل]?(?:ال)?متحف\s+(?:ال)?مصري(?!\s+(?:ال)?كبير)(?:\s+\S+){{0,3}}?\s+(?:ب|في\s+|ل)?(?:ال)?(?:تحرير|قاهره|وسط البلد)"),
        re.compile(rf"(?<![{_AR}])[وفبكل]?(?:ال)?متحف\s+(?:ال)?(?:تحرير|قاهره)(?![{_AR}])"),
    ]),
    ("National Museum of Egyptian Civilization", _compile(["national museum of egyptian civilization", "national museum of egyptian civilisation", "nmec"],
                                                          ["المتحف القومي للحضارة المصرية", "متحف الحضارة المصرية", "متحف الحضارة"])),
    ("Luxor Museum", _compile(["luxor museum"], ["متحف الاقصر"])),
    ("Nubia Museum", _compile(["nubia museum", "nubian museum"], ["متحف النوبة"])),
    ("Alexandria National Museum", _compile(["alexandria national museum", "alexandria museum"], ["متحف الاسكندرية", "المتحف القومي بالاسكندرية"])),
    ("Egyptian Museum in Turin", [re.compile(r"museo egizio|egyptian museum (?:of |in )?turin"), re.compile(rf"متحف\s+(?:ال)?مصري\s+(?:في\s+|ب)?تورينو")]),
    ("Egyptian Museum in Berlin", [re.compile(r"neues museum|pergamon museum|egyptian museum (?:of |in )?berlin")]),
    ("Smithsonian", _compile(["smithsonian"], ["سميثسونيان"])),
    ("Vatican Museums", _compile(["vatican museum"], ["متحف الفاتيكان"])),
    ("Prado Museum", _compile(["prado"], ["متحف برادو"])),
    ("Hermitage Museum", _compile(["hermitage"], ["الهرميتاج"])),
    ("Rijksmuseum", _compile(["rijksmuseum"], [])),
    ("Uffizi Gallery", _compile(["uffizi"], [])),
    ("Musée d'Orsay", _compile(["orsay"], ["اورسيه"])),
    ("Tate", _compile(["tate modern", "tate britain"], [])),
    ("Museum of Modern Art", _compile(["moma", "museum of modern art"], [])),
    ("Acropolis Museum", _compile(["acropolis museum"], [])),
    ("Ashmolean Museum", _compile(["ashmolean"], [])),
    ("Petrie Museum", _compile(["petrie museum"], [])),
]

_ENTITY_PATTERNS = {key: _compile(*words) for key, words in _ENTITY_WORDS.items()}


@lru_cache(maxsize=1)
def _parents() -> dict[str, str | None]:
    try:
        return {e["entity_key"]: e.get("parent_key") for e in json.loads(_ENTITIES_FILE.read_text(encoding="utf-8"))}
    except (OSError, ValueError, KeyError):
        return {}


@lru_cache(maxsize=1)
def _names() -> dict[str, tuple[str, str]]:
    try:
        return {e["entity_key"]: (e.get("name_en") or "", e.get("name_ar") or "")
                for e in json.loads(_ENTITIES_FILE.read_text(encoding="utf-8"))}
    except (OSError, ValueError, KeyError):
        return {}


def part_of(entity_key: str | None, language: str) -> str | None:
    """The name of the area an artefact belongs to ("Tutankhamun Galleries"), from our entity data; None if it has none."""
    parent = _parents().get(entity_key) if entity_key else None
    names = _names().get(parent) if parent else None
    return (names[1] if language == "ar" else names[0]) or None if names else None


def known_entity_keys() -> set[str]:
    return set(_ENTITY_WORDS)


def mentioned_entities(question: str) -> frozenset[str]:
    """Entity keys the question names (aliases, Arabic clitics and spelling variants tolerated)."""
    text = fold(question)
    return frozenset(key for key, patterns in _ENTITY_PATTERNS.items() if any(p.search(text) for p in patterns))


def entity_match(entity_key: str | None, mentioned: frozenset[str]) -> str | None:
    """'exact' (the note is about a named thing), 'related' (its area or one of its artefacts), or None.

    If the visitor names both an area and one of its artefacts ("Tutankhamun's canopic chest"),
    only the artefact is 'exact'; the area is 'related'.
    """
    if not entity_key or not mentioned:
        return None
    parents = _parents()
    more_specific = {parents.get(m) for m in mentioned} - {None}
    exact = mentioned - more_specific
    if entity_key in exact:
        return "exact"
    # related: the area of a named artefact, or the artefacts of a named area (never its other artefacts)
    if entity_key in mentioned or parents.get(entity_key) in exact or any(parents.get(m) == entity_key for m in exact):
        return "related"
    return None


def names_gem(question: str) -> bool:
    """Does the question call the museum by name (Grand Egyptian Museum / GEM / المتحف المصري الكبير)?"""
    text = fold(question)
    return any(p.search(text) for p in _GEM_NAMES)


def other_museum(question: str) -> str | None:
    """The name of another museum the question asks about, or None.

    None whenever the question also names GEM itself ("Is GEM bigger than the Louvre?").
    """
    text = fold(question)
    for name, patterns in _OTHER_MUSEUMS:
        if any(p.search(text) for p in patterns):
            return None if names_gem(question) else name
    return None