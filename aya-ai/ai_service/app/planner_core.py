"""Builds a visit plan from the visitor's preferences. Plain code: no model, no network, nothing invented.

    preferences (minutes, pace, interests, must-see, removed)
        |  1. candidates   must-see areas  >  areas matching the interests  >  (no interests) all areas in tour order
        |  2. select       a candidate is taken only if it still fits when every stop is given its SHORT visit
        |  3. spare time   leftover minutes first give must-see stops their full time, then the others;
        |                  stops that are only "optional" are added last and only if everyone still fits at full time
        |  4. order        the museum's own group-tour order (NOT a computed route: there is no map or distance data)
        v
    stops with minutes, reasons, highlights and the sources of the knowledge base

Every number of minutes comes from `suggested_minutes` (a team estimate stored in Supabase) scaled by the visitor's
pace, or from the flat buffers below. Stops, artefacts and links come only from the Catalog.
"""

import math
from dataclasses import dataclass, field

from .catalog import Catalog, Place

MAX_MINUTES = 480
REST_FROM_MINUTES = 150            # a plan of at least this long gets one rest buffer
REST_MINUTES = 10
MAX_HIGHLIGHTS = 3
PACES = {"relaxed": (1.25, 10), "normal": (1.0, 5), "fast": (0.8, 5)}     # (time factor, minutes between stops)


@dataclass
class Preferences:
    minutes: int | None = None
    pace: str = "normal"
    interests: list[str] = field(default_factory=list)       # tags
    must_see: list[str] = field(default_factory=list)        # entity keys, in the order the visitor named them
    removed: list[str] = field(default_factory=list)         # entity keys the visitor does not want

    def to_state(self) -> dict:
        return {"minutes": self.minutes, "pace": self.pace, "interests": list(self.interests),
                "must_see": list(self.must_see), "removed": list(self.removed)}

    @classmethod
    def from_state(cls, state: dict | None) -> "Preferences":
        state = state or {}
        return cls(state.get("minutes"), state.get("pace") or "normal", list(state.get("interests", [])),
                   list(state.get("must_see", [])), list(state.get("removed", [])))


def ceil5(value: float) -> int:
    return int(math.ceil(round(value, 6) / 5.0)) * 5


def _short_visit(place: Place) -> int:
    """The least time a stop gets: 60% of its estimate, never below 10 minutes (and never above the estimate)."""
    return min(place.minutes, max(10, ceil5(0.6 * place.minutes)))


def _full_visit(place: Place, pace: str) -> int:
    return max(_short_visit(place), min(240, ceil5(place.minutes * PACES[pace][0])))


def build_plan(prefs: Preferences, catalog: Catalog, language: str = "en") -> dict:
    pace = prefs.pace if prefs.pace in PACES else "normal"
    transition = PACES[pace][1]
    budget = min(int(prefs.minutes or 0), MAX_MINUTES)
    removed = set(prefs.removed)
    areas = {a.key: a for a in catalog.areas()}
    issues: list[dict] = []
    not_included: list[dict] = []

    def skip(key: str, why: str) -> None:
        place = catalog.get(key)
        if place and all(n["key"] != key for n in not_included):
            not_included.append({"key": key, "name": place.name(language), "reason": why})

    # ---- 1) candidates, in priority order ----
    must: list[str] = []
    unschedulable: list[str] = []          # named by the visitor, but no verified time estimate exists for them
    asked_for: dict[str, list[str]] = {}
    for key in prefs.must_see:
        place = catalog.get(key)
        area = catalog.area_of(key)
        if place is None or area is None:
            continue
        if key in removed or area.key in removed:
            issues.append({"code": "asked_and_removed", "name": place.name(language)})
            continue
        if area.key not in areas:
            skip(area.key, "no_verified_estimate")
            if place.name(language) not in unschedulable:
                unschedulable.append(place.name(language))
            continue
        if area.key not in must:
            must.append(area.key)
        asked_for.setdefault(area.key, []).append(place.name(language))

    wanted = set(prefs.interests)
    interest = []
    if wanted:
        scored = [(catalog.tag_score(a, wanted), a) for k, a in areas.items() if k not in must and k not in removed]
        interest = [a.key for s, a in sorted(((s, a) for s, a in scored if s > 0), key=lambda t: (-t[0], t[1].order or 99))]
    general: list[str] = []
    if not must and not interest:
        general = [k for k in areas if k not in removed]
    priority = [("must_see", k) for k in must] + [("interest", k) for k in interest] + [("general", k) for k in general]
    fillers = [k for k in areas if k not in removed and k not in {k2 for _p, k2 in priority}]

    # ---- 2) select what fits ----
    rest = REST_MINUTES if budget >= REST_FROM_MINUTES else 0
    room = budget - rest
    short = {k: _short_visit(a) for k, a in areas.items()}
    full = {k: _full_visit(a, pace) for k, a in areas.items()}

    def cost(keys: list[str], minutes: dict) -> int:
        return sum(minutes[k] for k in keys) + transition * max(0, len(keys) - 1)

    chosen: list[tuple[str, str]] = []
    for kind, key in priority:
        if cost([k for _p, k in chosen] + [key], short) <= room:
            chosen.append((kind, key))
        else:
            skip(key, "no_time")
    if unschedulable and not must:
        # everything the visitor insisted on has no verified time: do not hand back unrelated stops as if that were the request
        issues.append({"code": "must_see_no_estimate", "names": unschedulable})
        chosen = []
    if must and not any(kind == "must_see" for kind, _k in chosen):
        # nothing the visitor insisted on fits: do not hand back a different plan, say what the must-sees need
        issues.append({"code": "must_see_does_not_fit", "needs_minutes": short[must[0]] + rest,
                       "names": [_asked(catalog, k, asked_for, language) for k in must]})
        chosen = []
    if chosen:
        for key in fillers:
            if cost([k for _p, k in chosen] + [key], full) <= room:
                chosen.append(("filler", key))
    keys = [k for _p, k in chosen]

    # ---- 3) spare minutes: must-see first, then in priority order ----
    minutes = {k: short[k] for k in keys}
    spare = room - cost(keys, short)
    for _kind, key in chosen:
        add = min(full[key] - minutes[key], spare // 5 * 5)
        minutes[key] += add
        spare -= add

    # ---- 4) the museum's own order, with highlights and sources ----
    kind_of = dict((k, p) for p, k in chosen)
    ordered = sorted(keys, key=lambda k: (areas[k].order is None, areas[k].order or 0, k))
    stops = []
    for number, key in enumerate(ordered, 1):
        area = areas[key]
        stops.append({
            "order": number, "key": key, "name": area.name(language), "minutes": minutes[key],
            "priority": kind_of[key],
            "because": {"asked_for": asked_for.get(key, []), "interests": sorted(wanted & _area_tags(catalog, area))},
            "summary": area.summary(language),
            "verification_status": area.status,
            "highlights": _highlights(catalog, area, prefs, removed, language),
            "sources": area.links(language),
        })

    for key in prefs.removed:
        if catalog.get(key) is not None and catalog.get(key).kind == "area":
            skip(key, "removed_by_visitor")
    if not must and not prefs.interests:
        for place in catalog.places.values():
            if place.kind == "area" and not place.minutes:
                skip(place.key, "no_verified_estimate")

    transitions = transition * max(0, len(keys) - 1)
    total = sum(minutes.values()) + transitions + (rest if keys else 0)
    if int(prefs.minutes or 0) > MAX_MINUTES:
        issues.append({"code": "capped", "minutes": MAX_MINUTES})
    dropped = [n for n in not_included if n["reason"] == "no_time" and any(n["key"] == k for _p, k in priority)]
    if dropped and keys:
        issues.append({"code": "left_out_for_time", "names": [_asked(catalog, n["key"], asked_for, language) for n in dropped]})
    return {
        "budget_minutes": budget, "stops": stops, "not_included": not_included, "issues": issues,
        "transition_minutes_each": transition, "transitions_total": transitions,
        "rest_buffer_minutes": rest if keys else 0, "total_estimated_minutes": total,
        "free_minutes": max(0, budget - total) if keys else budget,
        "shortest_stop_minutes": min(short.values()) if short else None,
    }


def _asked(catalog: Catalog, area_key: str, asked_for: dict, language: str) -> str:
    """"Golden Throne (Tutankhamun Galleries)" when the visitor asked for an artefact of that area, else the area name."""
    area = catalog.get(area_key)
    names = asked_for.get(area_key)
    return f"{', '.join(names)} ({area.name(language)})" if names and names != [area.name(language)] else area.name(language)


def _area_tags(catalog: Catalog, area: Place) -> set[str]:
    return set(area.tags) | {t for c in catalog.children(area.key) for t in c.tags}


def _highlights(catalog: Catalog, area: Place, prefs: Preferences, removed: set[str], language: str) -> list[dict]:
    """Artefacts the visitor asked for first, then artefacts that match the interests. Never random ones."""
    wanted = set(prefs.interests)
    children = {c.key: c for c in catalog.children(area.key) if c.key not in removed}
    picked = [children[k] for k in prefs.must_see if k in children]
    rest = sorted((c for c in children.values() if c not in picked and wanted & set(c.tags)),
                  key=lambda c: (-len(wanted & set(c.tags)), c.key))
    return [{"key": c.key, "name": c.name(language), "summary": c.summary(language), "sources": c.links(language),
             "verification_status": c.status} for c in (picked + rest)[:MAX_HIGHLIGHTS]]