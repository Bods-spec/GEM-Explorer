"""Short-term memory for the AI Museum Guide: the last few turns of each conversation.

* Kept on the SERVER, in memory, so a visitor cannot edit what the "assistant" said earlier.
* A conversation belongs to the user who started it. Another user (or an unknown id) gets
  exactly the same answer: "not found".
* Old conversations expire; the number of conversations is capped overall and per user.
* Nothing is written to a database. A restart of the service forgets everything (fine for a prototype).
"""

import secrets
import threading
import time
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from typing import Callable

MAX_TURNS = 6            # the last 6 visitor messages and 6 guide replies are remembered
MAX_TEXT = 600           # characters kept per remembered message
TRUSTED_STATUSES = ("verified", "corroborated", "single_source")
MAX_EVIDENCE = 8         # museum notes remembered from earlier answered turns (server side only)
ID_PATTERN = r"^[A-Za-z0-9_-]{16,64}$"


def _trusted(note: dict) -> bool:
    """Only a note that came from the knowledge base, with its source link and a trusted status, may be remembered."""
    source = note.get("source") or {}
    return (isinstance(note.get("chunk_key"), str) and isinstance(note.get("content"), str) and bool(note["content"])
            and note.get("verification_status") in TRUSTED_STATUSES
            and isinstance(source.get("url"), str) and source["url"].startswith("https://") and bool(source.get("title")))


@dataclass
class Conversation:
    id: str
    user_id: str
    messages: deque = field(default_factory=lambda: deque(maxlen=MAX_TURNS * 2))   # (role, text)
    updated: float = 0.0
    state: dict = field(default_factory=dict)           # the Visit Planner's small preferences record (never the visitor's words)
    evidence: list = field(default_factory=list)       # notes the guide used in earlier ANSWERED turns, newest first

    def remember_evidence(self, notes: list[dict]) -> None:
        """Keep the notes of an answered turn so a follow-up can be judged against them again (the judge still decides)."""
        notes = [n for n in notes if _trusted(n)]
        keys = {n["chunk_key"] for n in notes}
        kept = [dict(n) for n in notes] + [n for n in self.evidence if n["chunk_key"] not in keys]
        self.evidence = kept[:MAX_EVIDENCE]

    def remember(self, role: str, text: str) -> None:
        self.messages.append((role, " ".join(text.split())[:MAX_TEXT]))

    def history(self) -> list[tuple[str, str]]:
        return list(self.messages)


class ConversationStore:
    def __init__(self, ttl: float = 1800.0, max_total: int = 500, max_per_user: int = 5,
                 clock: Callable[[], float] = time.monotonic):
        self._ttl, self._max_total, self._max_per_user, self._clock = ttl, max_total, max_per_user, clock
        self._items: OrderedDict[str, Conversation] = OrderedDict()
        self._lock = threading.Lock()

    def _expire(self, now: float) -> None:
        for key in [k for k, c in self._items.items() if now - c.updated > self._ttl]:
            del self._items[key]

    def start(self, user_id: str) -> Conversation:
        with self._lock:
            now = self._clock()
            self._expire(now)
            mine = [k for k, c in self._items.items() if c.user_id == user_id]
            while len(mine) >= self._max_per_user:          # the user's oldest conversation makes room
                del self._items[mine.pop(0)]
            while len(self._items) >= self._max_total:      # the service-wide oldest makes room
                self._items.popitem(last=False)
            conversation = Conversation(id=secrets.token_urlsafe(18), user_id=user_id, updated=now)
            self._items[conversation.id] = conversation
            return conversation

    def get_or_start(self, user_id: str, conversation_id: str) -> Conversation:
        """For a trusted caller (the Booking Agent) that chooses the conversation id: the user's conversation with that id,
        created on first use. Ids are namespaced by user, so two users can never reach or overwrite each other's conversation."""
        key = f"{user_id}\x00{conversation_id}"
        with self._lock:
            now = self._clock()
            self._expire(now)
            conversation = self._items.get(key)
            if conversation is None:
                mine = [k for k, c in self._items.items() if c.user_id == user_id]
                while len(mine) >= self._max_per_user:
                    del self._items[mine.pop(0)]
                while len(self._items) >= self._max_total:
                    self._items.popitem(last=False)
                conversation = Conversation(id=conversation_id, user_id=user_id, updated=now)
                self._items[key] = conversation
            conversation.updated = now
            self._items.move_to_end(key)
            return conversation

    def get(self, user_id: str, conversation_id: str) -> Conversation | None:
        """The conversation, only if it exists, has not expired and belongs to this user."""
        with self._lock:
            now = self._clock()
            self._expire(now)
            conversation = self._items.get(conversation_id)
            if conversation is None or not secrets.compare_digest(conversation.user_id, user_id):
                return None
            conversation.updated = now
            self._items.move_to_end(conversation_id)
            return conversation