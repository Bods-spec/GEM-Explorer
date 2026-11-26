"""GEM Explorer AI service: entry point.

GET  /health       is the service running?                    (public, reveals no secrets)
POST /rag/search   find museum knowledge for a question       (needs a valid Supabase token)
POST /guide/chat   one turn with the AI Museum Guide          (needs a valid Supabase token)
POST /planner/chat one turn with the Smart Visit Planner      (development and tests; needs a valid Supabase token)
POST /planner/turn the Planner as a TOOL of the Booking Agent    (the visitor's own token, forwarded by Node)

It does not touch the Node booking system.
"""

import logging
from typing import Literal

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, field_validator

from .clients import UpstreamError
from .config import SERVICE_NAME, SERVICE_VERSION, get_settings
from .conversations import ID_PATTERN
from .guide import ConversationNotFound
from .rag import MAX_QUERY_CHARS
from .security import ApiError, require_guide_user, require_planner_user, require_user
from .services import Services, get_services

logger = logging.getLogger("gem_ai")

app = FastAPI(title="GEM Explorer AI Service", version=SERVICE_VERSION)

# Only the GEM Explorer website may call this service from a browser, and only to read.
# POST is deliberately NOT allowed here: /rag/search is a building block for the AI Guide
# (which calls it inside this service), not something the web page should call directly.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[get_settings().frontend_origin],
    allow_methods=["GET"],
    allow_headers=["Content-Type"],
)


@app.exception_handler(ApiError)
async def api_error_handler(_request: Request, error: ApiError) -> JSONResponse:
    headers = {"Retry-After": str(error.retry_after)} if error.retry_after else None
    return JSONResponse({"error": error.code}, status_code=error.status, headers=headers)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_request: Request, _error: RequestValidationError) -> JSONResponse:
    # A fixed message: the default one would echo the visitor's input back.
    return JSONResponse({"error": "INVALID_REQUEST"}, status_code=422)


@app.get("/health")
def health() -> dict:
    """Is the service running? Also says which keys are filled in (never their values)."""
    settings = get_settings()
    return {
        "status": "ok",
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "openai_configured": settings.openai_configured,
        "supabase_configured": settings.supabase_configured,
        "guide_configured": settings.guide_configured,
        "planner_configured": settings.planner_configured,
    }


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=MAX_QUERY_CHARS)
    language: Literal["en", "ar"] | None = None  # omit it and the language is detected
    limit: int = Field(default=5, ge=1, le=10)

    @field_validator("query")
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("blank")
        return value


@app.post("/rag/search")
def rag_search(
    body: SearchRequest,
    _user: dict = Depends(require_user),
    services: Services = Depends(get_services),
) -> dict:
    """Relevant museum notes for a question, each with its source page.

    `enough_evidence` false (and `results` empty) means: nothing in the knowledge base
    supports an answer, so the caller must say "I don't have that information".
    """
    services.daily.hit()
    try:
        return services.searcher.search(body.query, body.language, body.limit)
    except UpstreamError as error:
        # Safe to log: UpstreamError never holds keys, tokens or response bodies.
        logger.warning("knowledge search failed: %s", error)
        raise ApiError(502, "KNOWLEDGE_UNAVAILABLE") from None


MAX_MESSAGE_CHARS = 500


class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)
    conversation_id: str | None = Field(default=None, pattern=ID_PATTERN)   # omit it to start a new conversation

    @field_validator("message")
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("blank")
        return value


@app.post("/guide/chat")
def guide_chat(
    body: ChatRequest,
    user: dict = Depends(require_guide_user),
    services: Services = Depends(get_services),
) -> dict:
    """One turn with the AI Museum Guide.

    The reply is either an answer built from verified notes (with its sources), a fixed
    "I don't have that information" reply, or a hand-over to the booking system.
    The user is the one in the verified token; the body never says who the user is.
    """
    try:
        return services.guide.respond(user["id"], " ".join(body.message.split()), body.conversation_id)
    except ConversationNotFound:
        raise ApiError(404, "CONVERSATION_NOT_FOUND") from None
    except UpstreamError as error:
        logger.warning("guide search failed: %s", error)        # safe: UpstreamError never holds keys or bodies
        raise ApiError(502, "KNOWLEDGE_UNAVAILABLE") from None


TURN_ID_PATTERN = r"^[A-Za-z0-9_-]{8,128}$"      # exactly what the Booking Agent accepts as a conversation id
MAX_TURN_MESSAGE_CHARS = 2000                    # exactly what the Booking Agent accepts as a message


class TurnRequest(BaseModel):
    message: str = Field(min_length=1, max_length=MAX_TURN_MESSAGE_CHARS)
    conversation_id: str = Field(pattern=TURN_ID_PATTERN)         # chosen by the Booking Agent, scoped to the verified user
    language: Literal["en", "ar"] | None = None                    # the page language: only used when the message has no letters
    booking_handled: bool = False                                  # the caller already took the booking part of this message

    @field_validator("message")
    @classmethod
    def not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("blank")
        return value


@app.post("/planner/turn")
def planner_turn(
    body: TurnRequest,
    user: dict = Depends(require_planner_user),
    services: Services = Depends(get_services),
) -> dict:
    """The Smart Visit Planning tool for the Booking Agent: create or update a structured visit plan for ONE conversation.

    The visitor's own Supabase token is verified here again (the same check as every other route); a user id in the body
    is never read. The Booking Agent shows the answer to the visitor and owns everything about bookings: this route can
    not create, change or cancel one.
    """
    try:
        return services.planner.turn(user["id"], " ".join(body.message.split()), body.conversation_id, body.language,
                                     body.booking_handled)
    except UpstreamError as error:
        logger.warning("planner data failed: %s", error)
        raise ApiError(502, "KNOWLEDGE_UNAVAILABLE") from None


@app.post("/planner/chat")
def planner_chat(
    body: ChatRequest,
    user: dict = Depends(require_planner_user),
    services: Services = Depends(get_services),
) -> dict:
    """One turn with the Smart Visit Planner: a structured visit plan, a short question, or a hand-over to booking.

    The plan is built by code from the museum's verified entity table; the model only reads the visitor's wishes.
    Nothing is booked, changed or cancelled here. The user is the one in the verified token.
    """
    try:
        return services.planner.respond(user["id"], " ".join(body.message.split()), body.conversation_id)
    except ConversationNotFound:
        raise ApiError(404, "CONVERSATION_NOT_FOUND") from None
    except UpstreamError as error:
        logger.warning("planner data failed: %s", error)
        raise ApiError(502, "KNOWLEDGE_UNAVAILABLE") from None