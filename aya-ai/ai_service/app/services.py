"""Builds the long-lived objects (clients, searcher, limiters) once, from the settings.

The tests replace `get_services` with a version wired to fake servers.
"""

import threading
from dataclasses import dataclass

import httpx

from .clients import OpenAIChat, OpenAIEmbedder, SupabaseRest, TIMEOUT
from .conversations import ConversationStore
from .guide import GuideAgent
from .planner import PlannerAgent
from .config import Settings, get_settings
from .rag import RagSearcher


@dataclass
class Services:
    settings: Settings
    supabase: SupabaseRest | None
    embedder: OpenAIEmbedder | None
    searcher: RagSearcher | None
    ip_limiter: object
    user_limiter: object
    daily: object
    guide: GuideAgent | None = None
    guide_user_limiter: object = None       # per minute
    guide_user_daily: object = None         # per user per day
    guide_daily: object = None              # whole service per day
    planner: PlannerAgent | None = None
    planner_user_limiter: object = None
    planner_user_daily: object = None
    planner_daily: object = None


def build_services(settings: Settings, http_client: httpx.Client | None = None) -> Services:
    # Imported here so security.py can import this module without a circle.
    from .security import DailyCap, RateLimiter

    client = http_client or httpx.Client(timeout=TIMEOUT)
    supabase = (
        SupabaseRest(settings.supabase_url, settings.supabase_secret_key, settings.supabase_publishable_key, client)
        if settings.supabase_configured and settings.supabase_publishable_key
        else None
    )
    embedder = (
        OpenAIEmbedder(settings.openai_api_key, settings.openai_embedding_model, client)
        if settings.openai_configured
        else None
    )
    searcher = RagSearcher(supabase, embedder, settings.rag_min_similarity) if supabase else None
    chat = (
        OpenAIChat(settings.openai_api_key, settings.openai_chat_model, client)
        if settings.guide_configured
        else None
    )
    return Services(
        settings=settings,
        supabase=supabase,
        embedder=embedder,
        searcher=searcher,
        ip_limiter=RateLimiter(settings.rag_ip_per_minute),
        user_limiter=RateLimiter(settings.rag_user_per_minute),
        daily=DailyCap(settings.rag_daily_limit),
        guide=GuideAgent(searcher, chat, ConversationStore()) if searcher and chat else None,
        guide_user_limiter=RateLimiter(settings.guide_user_per_minute),
        guide_user_daily=RateLimiter(settings.guide_user_per_day, window=86400.0),
        guide_daily=DailyCap(settings.guide_daily_limit),
        planner=PlannerAgent(supabase, chat, ConversationStore()) if supabase and chat else None,
        planner_user_limiter=RateLimiter(settings.planner_user_per_minute),
        planner_user_daily=RateLimiter(settings.planner_user_per_day, window=86400.0),
        planner_daily=DailyCap(settings.planner_daily_limit),
    )


_services: Services | None = None
_lock = threading.Lock()


def get_services() -> Services:
    """The shared services, built on first use."""
    global _services
    with _lock:
        if _services is None:
            _services = build_services(get_settings())
        return _services