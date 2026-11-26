"""What the Visit Planner is allowed to put in a plan: the museum's areas and artefacts, read from Supabase.

The planner reads ONLY the `museum_entities` and `museum_sources` tables (the same verified data the AI Guide's notes
come from). Nothing here is written by a model: if an area or artefact is not in these tables it cannot be in a plan,
and every source link in a plan is a row of `museum_sources` that an entity points at.

An area is PLANNABLE only if it has a team-estimated visit time (suggested_minutes with minutes_basis = team_estimate)
and at least one known source. Areas without a time (for example Khufu's Boats Museum) can be named but never scheduled.
"""

from dataclasses import dataclass

from .clients import SupabaseRest

ENTITY_COLUMNS = ("entity_key,kind,parent_key,name_en,name_ar,summary_en,summary_ar,suggested_minutes,minutes_basis,"
                  "visit_order,interest_tags,verification_status,source_keys")
SOURCE_COLUMNS = "source_key,title,url,source_type"
_RANK = {"official": 0, "institutional": 1, "team_note": 2}


@dataclass(frozen=True)
class Place:
    key: str
    kind: str                      # "area" or "artifact"
    parent: str | None
    name_en: str
    name_ar: str
    summary_en: str
    summary_ar: str
    minutes: int | None            # team estimate; None = never scheduled
    order: int | None              # order used in the museum's own group-tour description
    tags: tuple[str, ...]
    status: str
    sources: tuple[dict, ...]      # {"title", "url", "type"}

    def name(self, language: str) -> str:
        return (self.name_ar if language == "ar" and self.name_ar else self.name_en)

    def summary(self, language: str) -> str:
        return (self.summary_ar if language == "ar" and self.summary_ar else self.summary_en) or ""

    def links(self, language: str, limit: int = 2) -> list[dict]:
        """Official sources first, in the visitor's language when a page in that language exists."""
        def rank(source: dict):
            arabic = "/ar/" in source["url"]
            return (arabic != (language == "ar"), _RANK.get(source["type"], 3))
        return [dict(s) for s in sorted(self.sources, key=rank)[:limit]]


class Catalog:
    def __init__(self, places: dict[str, Place]):
        self.places = places

    def get(self, key: str) -> Place | None:
        return self.places.get(key)

    def areas(self) -> list[Place]:
        """Areas that may be scheduled, in the museum's own tour order."""
        found = [p for p in self.places.values() if p.kind == "area" and p.minutes]
        return sorted(found, key=lambda p: (p.order is None, p.order or 0, p.key))

    def children(self, area_key: str) -> list[Place]:
        return [p for p in self.places.values() if p.parent == area_key]

    def area_of(self, key: str) -> Place | None:
        place = self.places.get(key)
        if place is None:
            return None
        return place if place.kind == "area" else self.places.get(place.parent or "")

    def tags(self) -> list[str]:
        return sorted({t for p in self.places.values() for t in p.tags})

    def keys(self) -> list[str]:
        return sorted(self.places)

    def tag_score(self, area: Place, wanted: set[str]) -> int:
        """2 points for a tag of the area itself, 1 for each further tag only its artefacts have."""
        own = set(area.tags)
        below = {t for c in self.children(area.key) for t in c.tags} - own
        return 2 * len(own & wanted) + len(below & wanted)


def build_catalog(entities: list[dict], sources: list[dict]) -> Catalog:
    by_key = {s["source_key"]: {"title": s["title"], "url": s["url"], "type": s.get("source_type") or "team_note"}
              for s in sources if s.get("source_key") and s.get("title") and str(s.get("url", "")).startswith("https://")}
    places: dict[str, Place] = {}
    for row in entities:
        key = row.get("entity_key")
        linked = tuple(by_key[k] for k in (row.get("source_keys") or []) if k in by_key)
        if not key or not row.get("name_en") or not linked or row.get("verification_status") == "conflicting":
            continue                                                  # no trusted source: it does not exist for the planner
        minutes = row.get("suggested_minutes")
        if row.get("minutes_basis") != "team_estimate" or not isinstance(minutes, int) or minutes <= 0:
            minutes = None
        places[key] = Place(
            key=key, kind=row.get("kind") or "artifact", parent=row.get("parent_key"),
            name_en=row["name_en"], name_ar=row.get("name_ar") or "",
            summary_en=row.get("summary_en") or "", summary_ar=row.get("summary_ar") or "",
            minutes=minutes, order=row.get("visit_order"), tags=tuple(row.get("interest_tags") or ()),
            status=row.get("verification_status") or "single_source", sources=linked,
        )
    return Catalog(places)


def load_catalog(supabase: SupabaseRest) -> Catalog:
    """Read-only. Raises UpstreamError if Supabase cannot be read."""
    return build_catalog(supabase.select("museum_entities", ENTITY_COLUMNS), supabase.select("museum_sources", SOURCE_COLUMNS))