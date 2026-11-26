"""Load the prepared museum dataset (knowledge/*.json) into Supabase.

    python -m app.ingest            DRY RUN (default): checks the files, prints what would happen.
                                    Needs no keys and sends nothing anywhere.
    python -m app.ingest --apply    REAL RUN: embeds the notes with OpenAI and writes them to Supabase.
                                    Only after sql/knowledge_base.sql has been run and approved.

Safe to repeat: rows are matched by their keys, and a note is only embedded again when
its text (or the embedding model) changed.
"""

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .clients import OpenAIEmbedder, SupabaseRest, UpstreamError, vector_literal
from .config import get_settings

KNOWLEDGE_DIR = Path(__file__).resolve().parent.parent / "knowledge"

_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,80}$")
_CHUNK_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,100}$")
_STATUSES = {"verified", "corroborated", "single_source", "conflicting"}
_SOURCE_FIELDS = ("source_key", "title", "url", "publisher", "source_type", "license", "retrieved_on", "notes")
_ENTITY_FIELDS = (
    "entity_key", "kind", "parent_key", "name_en", "name_ar", "summary_en", "summary_ar", "period", "ruler",
    "suggested_minutes", "minutes_basis", "visit_order", "interest_tags", "verification_status", "source_keys",
)
_ARABIC_RE = re.compile(r"[\u0600-\u06FF]")
_LATIN_RE = re.compile(r"[A-Za-z]")
# A team estimate is a planner input, never a fact the assistant may state as official.
# (The official "about 2 hours" tour length is in hours and is allowed.)
_MINUTES_RE = re.compile(r"\b\d+\s*(?:minutes?|mins?)\b|\d+\s*(?:دقيقة|دقائق|دقيقه)", re.IGNORECASE)
_CHUNK_FIELDS = ("chunk_key", "entity_key", "language", "content", "verification_status", "time_sensitive", "content_hash")


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_dataset(directory: Path = KNOWLEDGE_DIR) -> dict[str, list[dict]]:
    return {
        name: json.loads((directory / f"{name}.json").read_text(encoding="utf-8"))
        for name in ("sources", "entities", "chunks")
    }


def minutes_missing(entity: dict) -> bool:
    return entity.get("suggested_minutes") is None


def validate_dataset(ds: dict[str, list[dict]]) -> list[str]:
    """Every rule the database enforces, checked here first. An empty list means the data is fine."""
    errors: list[str] = []
    sources, entities, chunks = ds["sources"], ds["entities"], ds["chunks"]

    source_keys = [s.get("source_key") for s in sources]
    entity_keys = [e.get("entity_key") for e in entities]
    chunk_keys = [c.get("chunk_key") for c in chunks]
    for label, keys in (("source_key", source_keys), ("entity_key", entity_keys), ("chunk_key", chunk_keys)):
        if len(set(keys)) != len(keys):
            errors.append(f"duplicate {label}")
    if len({s.get("url") for s in sources}) != len(sources):
        errors.append("duplicate source url")

    for s in sources:
        if not _KEY_RE.match(str(s.get("source_key"))):
            errors.append(f"source {s.get('source_key')!r}: bad key")
        if not str(s.get("url", "")).startswith("https://"):
            errors.append(f"source {s.get('source_key')!r}: url must start with https://")
        if s.get("source_type") not in ("official", "institutional", "team_note"):
            errors.append(f"source {s.get('source_key')!r}: bad source_type")
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(s.get("retrieved_on", ""))):
            errors.append(f"source {s.get('source_key')!r}: retrieved_on must be YYYY-MM-DD")

    known_sources, known_entities = set(source_keys), set(entity_keys)
    for e in entities:
        key = e.get("entity_key")
        if not _KEY_RE.match(str(key)):
            errors.append(f"entity {key!r}: bad key")
        if e.get("kind") not in ("area", "artifact"):
            errors.append(f"entity {key!r}: bad kind")
        if e.get("verification_status") not in _STATUSES:
            errors.append(f"entity {key!r}: bad verification_status")
        keys = e.get("source_keys")
        if not isinstance(keys, list) or not keys or not all(isinstance(k, str) and k for k in keys):
            errors.append(f"entity {key!r}: source_keys must be a non-empty list of keys")
        else:
            if len(set(keys)) != len(keys):
                errors.append(f"entity {key!r}: duplicate source_keys")
            for missing in sorted(set(keys) - known_sources):
                errors.append(f"entity {key!r}: source_keys has {missing!r}, which is not in sources.json")
        for field in ("name_ar", "summary_ar"):
            if e.get(field) and not _ARABIC_RE.search(e[field]):
                errors.append(f"entity {key!r}: {field} has no Arabic letters")
        if e.get("minutes_basis") and minutes_missing(e):
            errors.append(f"entity {key!r}: minutes_basis without suggested_minutes")
        if e.get("parent_key") is not None and e["parent_key"] not in known_entities:
            errors.append(f"entity {key!r}: unknown parent")
        minutes = e.get("suggested_minutes")
        if minutes is not None and not (5 <= minutes <= 240 and e.get("minutes_basis")):
            errors.append(f"entity {key!r}: suggested_minutes needs 5..240 and a minutes_basis")

    for c in chunks:
        key = c.get("chunk_key")
        if not _CHUNK_KEY_RE.match(str(key)):
            errors.append(f"chunk {key!r}: bad key")
        if c.get("source_key") not in known_sources:
            errors.append(f"chunk {key!r}: unknown source")
        if c.get("entity_key") is not None and c["entity_key"] not in known_entities:
            errors.append(f"chunk {key!r}: unknown entity")
        if c.get("language") not in ("en", "ar"):
            errors.append(f"chunk {key!r}: bad language")
        if c.get("verification_status") not in _STATUSES:
            errors.append(f"chunk {key!r}: bad verification_status")
        content = c.get("content", "")
        if not 20 <= len(content) <= 1500:
            errors.append(f"chunk {key!r}: content must be 20..1500 characters")
        if c.get("content_hash") != sha256(content):
            errors.append(f"chunk {key!r}: content_hash does not match the text")
        arabic, latin = len(_ARABIC_RE.findall(content)), len(_LATIN_RE.findall(content))
        if c.get("language") == "ar" and arabic <= latin:
            errors.append(f"chunk {key!r}: marked Arabic but the text is mostly not Arabic")
        if c.get("language") == "en" and arabic > latin:
            errors.append(f"chunk {key!r}: marked English but the text is mostly Arabic")
        if _MINUTES_RE.search(content):
            errors.append(f"chunk {key!r}: states minutes; visit durations are team estimates and live only in entities")
    return errors


def _pick(row: dict, fields: tuple[str, ...]) -> dict:
    return {f: row.get(f) for f in fields}


def run_ingest(
    ds: dict[str, list[dict]],
    supabase: SupabaseRest,
    embedder: OpenAIEmbedder,
    now: datetime | None = None,
) -> dict[str, int]:
    """Write the dataset. Order matters: sources, then areas, then artefacts, then notes."""
    errors = validate_dataset(ds)
    if errors:
        raise ValueError("dataset is invalid: " + "; ".join(errors[:5]))
    stamp = (now or datetime.now(timezone.utc)).isoformat()

    supabase.upsert("museum_sources", [_pick(s, _SOURCE_FIELDS) for s in ds["sources"]], "source_key")

    # Read the sources back from the database and make sure every key that an entity or a note
    # points at really exists there, BEFORE writing anything that refers to it.
    source_ids = {r["source_key"]: r["id"] for r in supabase.select("museum_sources", "id,source_key")}
    dangling = sorted(
        {k for e in ds["entities"] for k in e["source_keys"]} | {c["source_key"] for c in ds["chunks"]}
    )
    dangling = [k for k in dangling if k not in source_ids]
    if dangling:
        raise ValueError("source_keys not found in museum_sources: " + ", ".join(dangling[:5]))

    # Areas first, then artefacts (an artefact points at its area).
    for kind in ("area", "artifact"):
        rows = [{**_pick(e, _ENTITY_FIELDS), "updated_at": stamp} for e in ds["entities"] if e["kind"] == kind]
        if rows:
            supabase.upsert("museum_entities", rows, "entity_key")

    existing = {
        r["chunk_key"]: r
        for r in supabase.select(
            "museum_chunks", "chunk_key,content_hash,embedding_model,entity_key,language,verification_status,time_sensitive"
        )
    }

    to_embed, metadata_only, unchanged = [], [], 0
    for c in ds["chunks"]:
        old = existing.get(c["chunk_key"])
        if old is None or old["content_hash"] != c["content_hash"] or old["embedding_model"] != embedder.model:
            to_embed.append(c)
        elif any(old[f] != c[f] for f in ("entity_key", "language", "verification_status", "time_sensitive")):
            metadata_only.append(c)
        else:
            unchanged += 1

    def row(c: dict) -> dict:
        return {**_pick(c, _CHUNK_FIELDS), "source_id": source_ids[c["source_key"]], "updated_at": stamp}

    if to_embed:
        vectors = embedder.embed([c["content"] for c in to_embed])
        supabase.upsert(
            "museum_chunks",
            [
                {**row(c), "embedding": vector_literal(v), "embedding_model": embedder.model}
                for c, v in zip(to_embed, vectors)
            ],
            "chunk_key",
        )
    if metadata_only:
        supabase.upsert("museum_chunks", [row(c) for c in metadata_only], "chunk_key")

    return {
        "sources": len(ds["sources"]),
        "entities": len(ds["entities"]),
        "chunks_embedded": len(to_embed),
        "chunks_metadata_updated": len(metadata_only),
        "chunks_unchanged": unchanged,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Load knowledge/*.json into Supabase (dry run unless --apply).")
    parser.add_argument("--apply", action="store_true", help="really embed and write (default is a dry run)")
    args = parser.parse_args(argv)

    ds = load_dataset()
    errors = validate_dataset(ds)
    chars = sum(len(c["content"]) for c in ds["chunks"])
    print(f"Dataset: {len(ds['sources'])} sources, {len(ds['entities'])} entities, {len(ds['chunks'])} notes")
    print(f"Embedding size would be about {chars // 3} tokens (a fraction of a cent).")
    if errors:
        print("The dataset has problems, nothing was sent:")
        for e in errors:
            print("  -", e)
        return 1

    if not args.apply:
        print("DRY RUN: the files are valid. Nothing was sent to OpenAI or Supabase.")
        print("To load for real (after approving sql/knowledge_base.sql):  python -m app.ingest --apply")
        return 0

    settings = get_settings()
    if not (settings.supabase_configured and settings.openai_configured):
        print("Cannot apply: fill in SUPABASE_URL, SUPABASE_SECRET_KEY and OPENAI_API_KEY in ai_service/.env first.")
        return 2
    try:
        report = run_ingest(
            ds,
            SupabaseRest(settings.supabase_url, settings.supabase_secret_key, settings.supabase_publishable_key),
            OpenAIEmbedder(settings.openai_api_key, settings.openai_embedding_model),
        )
    except UpstreamError as error:
        print(f"Stopped: {error}")
        return 3
    print("Done:", json.dumps(report))
    return 0


if __name__ == "__main__":
    sys.exit(main())
