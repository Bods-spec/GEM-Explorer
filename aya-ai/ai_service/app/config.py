"""Settings, read from environment variables (and from ai_service/.env if it exists).

Nothing here talks to the network. Secrets are only *read*; they are never printed,
logged or returned by any endpoint.
"""

import os
import re
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# ai_service/.env  (one folder above "app")
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

SERVICE_NAME = "gem-ai-guide"
SERVICE_VERSION = "0.4.0"

# The database column is vector(1536) (see sql/knowledge_base.sql). OpenAI's
# text-embedding-3 models can return exactly this size, so it is fixed here.
EMBEDDING_DIMENSIONS = 1536


def _number(name: str, default: float, cast=float, minimum: float = 0):
    """A numeric setting; a missing, broken or too-small value falls back to the default."""
    try:
        value = cast(os.getenv(name, "").strip())
    except ValueError:
        return default
    return value if value >= minimum else default


@dataclass(frozen=True)
class Settings:
    frontend_origin: str
    app_env: str
    allow_guest_users: bool
    supabase_url: str
    supabase_secret_key: str
    supabase_publishable_key: str
    openai_api_key: str
    openai_embedding_model: str
    rag_min_similarity: float
    rag_user_per_minute: int
    rag_ip_per_minute: int
    rag_daily_limit: int
    # ---- Step 3: the AI Museum Guide ----
    openai_chat_model: str = ""          # no default on purpose: model names are retired from time to time
    guide_user_per_minute: int = 6
    guide_user_per_day: int = 100
    guide_daily_limit: int = 1000
    # ---- Step 4: the Smart Visit Planner (one model call per turn) ----
    planner_user_per_minute: int = 10
    planner_user_per_day: int = 200
    planner_daily_limit: int = 1000

    @property
    def openai_configured(self) -> bool:
        return bool(self.openai_api_key)

    @property
    def supabase_configured(self) -> bool:
        return bool(self.supabase_url and self.supabase_secret_key)

    @property
    def guide_configured(self) -> bool:
        return bool(self.openai_api_key and self.openai_chat_model)

    @property
    def planner_configured(self) -> bool:
        return bool(self.guide_configured and self.supabase_configured)


def get_settings() -> Settings:
    """Read the settings fresh each time (cheap, and keeps tests simple)."""
    env = os.getenv
    frontend_origin = env("FRONTEND_ORIGIN", "http://localhost:5600").strip()
    app_env = env("APP_ENV", "development").strip().lower()
    return Settings(
        frontend_origin=frontend_origin,
        app_env=app_env,
        # Same rule as the Node backend: guests only when explicitly switched on,
        # never in production, and only while the site runs on localhost.
        allow_guest_users=(
            env("ALLOW_GUEST_USERS", "").strip().lower() == "true"
            and app_env != "production"
            and re.fullmatch(r"http://localhost(:\d+)?", frontend_origin) is not None
        ),
        supabase_url=env("SUPABASE_URL", "").strip().rstrip("/"),
        supabase_secret_key=env("SUPABASE_SECRET_KEY", "").strip(),
        supabase_publishable_key=env("SUPABASE_PUBLISHABLE_KEY", "").strip(),
        openai_api_key=env("OPENAI_API_KEY", "").strip(),
        openai_embedding_model=env("OPENAI_EMBEDDING_MODEL", "").strip() or "text-embedding-3-small",
        # Provisional: must be checked against real embeddings in the first real test.
        rag_min_similarity=_number("RAG_MIN_SIMILARITY", 0.30),
        rag_user_per_minute=_number("RAG_USER_PER_MINUTE", 20, int, 1),
        rag_ip_per_minute=_number("RAG_IP_PER_MINUTE", 60, int, 1),
        rag_daily_limit=_number("RAG_DAILY_LIMIT", 2000, int, 1),
        openai_chat_model=env("OPENAI_CHAT_MODEL", "").strip(),
        guide_user_per_minute=_number("GUIDE_USER_PER_MINUTE", 6, int, 1),
        guide_user_per_day=_number("GUIDE_USER_PER_DAY", 100, int, 1),
        guide_daily_limit=_number("GUIDE_DAILY_LIMIT", 1000, int, 1),
        planner_user_per_minute=_number("PLANNER_USER_PER_MINUTE", 10, int, 1),
        planner_user_per_day=_number("PLANNER_USER_PER_DAY", 200, int, 1),
        planner_daily_limit=_number("PLANNER_DAILY_LIMIT", 1000, int, 1),
    )