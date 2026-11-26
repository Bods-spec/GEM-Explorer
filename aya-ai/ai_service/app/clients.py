"""The two outside services this app talks to, as small, mockable HTTP clients.

* OpenAIEmbedder : text -> embedding vectors   (POST https://api.openai.com/v1/embeddings)
* SupabaseRest   : the Supabase REST API (PostgREST) and token check (Auth)

Both take an `httpx.Client`, so the tests hand them a fake transport and nothing
ever leaves the computer. Errors raised here never contain keys, tokens, URLs
with secrets or response bodies, so they are safe to log.
"""

import json
import re
import time
from typing import Any, Callable

import httpx

from .config import EMBEDDING_DIMENSIONS

TIMEOUT = httpx.Timeout(20.0, connect=10.0)


class UpstreamError(Exception):
    """An outside service failed. `service` and `status` are safe to show; nothing else is kept."""

    def __init__(self, service: str, status: int | None = None, hint: str = ""):
        self.service = service
        self.status = status
        self.hint = hint
        super().__init__(f"{service} request failed (status {status})" + (f": {hint}" if hint else ""))


# ---------------------------------------------------------------------------
# OpenAI embeddings
# ---------------------------------------------------------------------------

class OpenAIEmbedder:
    def __init__(
        self,
        api_key: str,
        model: str,
        client: httpx.Client | None = None,
        base_url: str = "https://api.openai.com/v1",
        retries: int = 2,
        sleep: Callable[[float], None] = time.sleep,
    ):
        self._api_key = api_key
        self.model = model
        self._client = client or httpx.Client(timeout=TIMEOUT)
        self._url = f"{base_url.rstrip('/')}/embeddings"
        self._retries = retries
        self._sleep = sleep

    def embed(self, texts: list[str]) -> list[list[float]]:
        """One embedding per text, in the same order. Retries 429 / 5xx / timeouts a couple of times."""
        cleaned = [" ".join(t.split()) for t in texts]
        if not cleaned or any(not t for t in cleaned):
            raise ValueError("embed() needs non-empty texts")

        body = {
            "model": self.model,
            "input": cleaned,
            "dimensions": EMBEDDING_DIMENSIONS,
            "encoding_format": "float",
        }
        headers = {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"}

        last_status: int | None = None
        for attempt in range(self._retries + 1):
            try:
                response = self._client.post(self._url, json=body, headers=headers)
                last_status = response.status_code
            except httpx.TimeoutException:
                last_status = None
                response = None
            except httpx.HTTPError as error:  # connection problems
                raise UpstreamError("openai", None, type(error).__name__) from None

            if response is not None and response.status_code == 200:
                return self._parse(response, len(cleaned))
            retryable = response is None or response.status_code == 429 or response.status_code >= 500
            if not retryable or attempt == self._retries:
                break
            self._sleep(0.5 * (2 ** attempt))

        raise UpstreamError("openai", last_status)

    @staticmethod
    def _parse(response: httpx.Response, expected: int) -> list[list[float]]:
        try:
            items = sorted(response.json()["data"], key=lambda item: item["index"])
            vectors = [[float(x) for x in item["embedding"]] for item in items]
        except (ValueError, KeyError, TypeError):
            raise UpstreamError("openai", 200, "unexpected response shape") from None
        if len(vectors) != expected or any(len(v) != EMBEDDING_DIMENSIONS for v in vectors):
            raise UpstreamError("openai", 200, "unexpected embedding size")
        return vectors


# ---------------------------------------------------------------------------
# OpenAI chat (structured JSON answers)
# ---------------------------------------------------------------------------

class OpenAIChat:
    """One chat-completion call that must return JSON matching a schema (Structured Outputs).

    No temperature or reasoning settings are sent, so the same code works with any current chat
    model. Errors never contain the key, the prompt or the model's text.
    """

    def __init__(
        self,
        api_key: str,
        model: str,
        client: httpx.Client | None = None,
        base_url: str = "https://api.openai.com/v1",
        retries: int = 1,
        sleep: Callable[[float], None] = time.sleep,
        max_tokens: int = 1500,
    ):
        self._api_key = api_key
        self.model = model
        self._client = client or httpx.Client(timeout=httpx.Timeout(45.0, connect=10.0))
        self._url = f"{base_url.rstrip('/')}/chat/completions"
        self._retries = retries
        self._sleep = sleep
        self._max_tokens = max_tokens

    def complete_json(self, system: str, user: str, schema_name: str, schema: dict) -> dict:
        body = {
            "model": self.model,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "max_completion_tokens": self._max_tokens,
            "response_format": {"type": "json_schema", "json_schema": {"name": schema_name, "strict": True, "schema": schema}},
        }
        headers = {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"}
        last_status: int | None = None
        for attempt in range(self._retries + 1):
            try:
                response = self._client.post(self._url, json=body, headers=headers)
                last_status = response.status_code
            except httpx.TimeoutException:
                response, last_status = None, None
            except httpx.HTTPError as error:
                raise UpstreamError("openai-chat", None, type(error).__name__) from None
            if response is not None and response.status_code == 200:
                return self._parse(response)
            retryable = response is None or response.status_code == 429 or response.status_code >= 500
            if not retryable or attempt == self._retries:
                break
            self._sleep(0.5 * (2 ** attempt))
        raise UpstreamError("openai-chat", last_status)

    @staticmethod
    def _parse(response: httpx.Response) -> dict:
        try:
            choice = response.json()["choices"][0]
            message = choice["message"]
            if message.get("refusal") or choice.get("finish_reason") not in ("stop", None):
                raise ValueError("no usable answer")
            data = json.loads(message["content"])
        except (ValueError, KeyError, IndexError, TypeError):
            raise UpstreamError("openai-chat", 200, "unusable response") from None
        if not isinstance(data, dict):
            raise UpstreamError("openai-chat", 200, "unusable response")
        return data


def vector_literal(vector: list[float]) -> str:
    """pgvector's text form, '[0.1,0.2,...]'. Used for the database column and for search."""
    return "[" + ",".join(format(x, ".8g") for x in vector) + "]"


# ---------------------------------------------------------------------------
# Supabase REST
# ---------------------------------------------------------------------------

_TOKEN_RE = re.compile(r"^[A-Za-z0-9._~+/=-]{20,4096}$")


class SupabaseRest:
    def __init__(
        self,
        url: str,
        secret_key: str,
        publishable_key: str = "",
        client: httpx.Client | None = None,
    ):
        url = url.rstrip("/")
        if not (url.startswith("https://") or re.match(r"^http://(localhost|127\.0\.0\.1)(:\d+)?$", url)):
            raise ValueError("SUPABASE_URL must start with https://")
        self._url = url
        self._secret = secret_key
        self._publishable = publishable_key
        self._client = client or httpx.Client(timeout=TIMEOUT)

    @staticmethod
    def _key_headers(key: str) -> dict[str, str]:
        # New-style keys (sb_secret_..., sb_publishable_...) are not JWTs and go ONLY in
        # "apikey". Old-style keys are JWTs and may also be sent as the bearer token.
        headers = {"apikey": key}
        if key.startswith("eyJ"):
            headers["Authorization"] = f"Bearer {key}"
        return headers

    def _request(self, method: str, path: str, *, headers: dict, **kwargs) -> httpx.Response:
        try:
            return self._client.request(method, f"{self._url}{path}", headers=headers, **kwargs)
        except httpx.HTTPError as error:
            raise UpstreamError("supabase", None, type(error).__name__) from None

    def _data_headers(self, extra: dict | None = None) -> dict:
        return {**self._key_headers(self._secret), "Content-Type": "application/json", **(extra or {})}

    @staticmethod
    def _check(response: httpx.Response, ok=(200, 201, 204)) -> None:
        if response.status_code not in ok:
            hint = "tables or function not found: run sql/knowledge_base.sql first" if response.status_code == 404 else ""
            raise UpstreamError("supabase", response.status_code, hint)

    # ---- data (secret key: backend only) ----

    def rpc(self, function: str, params: dict[str, Any]) -> list[dict]:
        response = self._request("POST", f"/rest/v1/rpc/{function}", headers=self._data_headers(), json=params)
        self._check(response, ok=(200,))
        data = response.json()
        return data if isinstance(data, list) else []

    def select(self, table: str, columns: str) -> list[dict]:
        response = self._request("GET", f"/rest/v1/{table}", headers=self._data_headers(), params={"select": columns})
        self._check(response, ok=(200,))
        return response.json()

    def upsert(self, table: str, rows: list[dict], on_conflict: str, batch: int = 100) -> None:
        for start in range(0, len(rows), batch):
            response = self._request(
                "POST",
                f"/rest/v1/{table}",
                headers=self._data_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
                params={"on_conflict": on_conflict},
                json=rows[start:start + batch],
            )
            self._check(response, ok=(200, 201, 204))

    # ---- who is calling? (publishable key + the visitor's own token) ----

    def verify_user(self, token: str) -> dict | None:
        """The verified user {id, is_anonymous}, or None if the token is not valid."""
        if not self._publishable or not _TOKEN_RE.match(token):
            return None
        response = self._request(
            "GET",
            "/auth/v1/user",
            headers={"apikey": self._publishable, "Authorization": f"Bearer {token}"},
        )
        if response.status_code in (401, 403):
            return None
        self._check(response, ok=(200,))
        user = response.json()
        if not isinstance(user, dict) or not user.get("id"):
            return None
        return {"id": str(user["id"]), "is_anonymous": user.get("is_anonymous") is True}