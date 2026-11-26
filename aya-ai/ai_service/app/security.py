"""Who may call the RAG endpoint, and how often.

* Every request needs a valid Supabase access token (the same tokens the website
  already has; guests only if guest mode is on, exactly like the Node backend).
* The user id always comes from the verified token, never from the request body.
* Limits protect the OpenAI bill: per IP, per user, and a daily cap for the whole service.
* If Supabase is not configured the service refuses everything (fails closed).

The limits live in memory, so they reset when the service restarts. That is fine for a
single local prototype; a shared store would be needed for several servers.
"""

import re
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Callable

from fastapi import Depends, Request

from .clients import UpstreamError
from .services import Services, get_services

_BEARER_RE = re.compile(r"^Bearer\s+(\S+)$", re.IGNORECASE)


class ApiError(Exception):
    """Turned into a JSON body {"error": CODE} by the handler in main.py."""

    def __init__(self, status: int, code: str, retry_after: int | None = None):
        self.status = status
        self.code = code
        self.retry_after = retry_after
        super().__init__(code)


class RateLimiter:
    """At most `limit` hits per `window` seconds for each key (sliding window)."""

    def __init__(self, limit: int, window: float = 60.0, clock: Callable[[], float] = time.monotonic):
        self.limit, self.window, self._clock = limit, window, clock
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: str) -> None:
        now = self._clock()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] >= self.window:
                hits.popleft()
            if len(hits) >= self.limit:
                raise ApiError(429, "RATE_LIMITED", retry_after=max(1, int(self.window - (now - hits[0])) + 1))
            hits.append(now)
            if len(self._hits) > 5000:  # forget idle keys so memory cannot grow forever
                for k in [k for k, v in self._hits.items() if not v or now - v[-1] >= self.window]:
                    self._hits.pop(k, None)


class DailyCap:
    """A cap on total searches per UTC day: the last line of defence for the OpenAI budget."""

    def __init__(self, limit: int, today: Callable[[], str] | None = None):
        self.limit = limit
        self._today = today or (lambda: datetime.now(timezone.utc).strftime("%Y-%m-%d"))
        self._day, self._count = self._today(), 0
        self._lock = threading.Lock()

    def hit(self) -> None:
        with self._lock:
            today = self._today()
            if today != self._day:
                self._day, self._count = today, 0
            if self._count >= self.limit:
                raise ApiError(429, "DAILY_LIMIT_REACHED", retry_after=3600)
            self._count += 1


def require_user(request: Request, services: Services = Depends(get_services)) -> dict:
    """FastAPI dependency: the verified user, or a clean 401 / 403 / 429 / 503."""
    if services.supabase is None:
        raise ApiError(503, "SERVICE_NOT_CONFIGURED")

    services.ip_limiter.check(request.client.host if request.client else "unknown")

    match = _BEARER_RE.match(request.headers.get("authorization", ""))
    if not match:
        raise ApiError(401, "UNAUTHORIZED")

    try:
        user = services.supabase.verify_user(match.group(1))
    except UpstreamError:
        raise ApiError(503, "AUTH_UNAVAILABLE") from None
    if user is None:
        raise ApiError(401, "UNAUTHORIZED")
    if user["is_anonymous"] and not services.settings.allow_guest_users:
        raise ApiError(403, "GUESTS_NOT_ALLOWED")

    services.user_limiter.check(user["id"])
    return user


def require_guide_user(user: dict = Depends(require_user), services: Services = Depends(get_services)) -> dict:
    """The verified user, who must also be inside the (stricter) AI-guide limits: each chat turn costs several model calls."""
    if services.guide is None:
        raise ApiError(503, "GUIDE_NOT_CONFIGURED")
    services.guide_user_limiter.check(user["id"])
    services.guide_user_daily.check(user["id"])
    services.guide_daily.hit()
    return user


def require_planner_user(user: dict = Depends(require_user), services: Services = Depends(get_services)) -> dict:
    """The verified user, inside the visit planner's own limits (one model call per turn)."""
    if services.planner is None:
        raise ApiError(503, "PLANNER_NOT_CONFIGURED")
    services.planner_user_limiter.check(user["id"])
    services.planner_user_daily.check(user["id"])
    services.planner_daily.hit()
    return user