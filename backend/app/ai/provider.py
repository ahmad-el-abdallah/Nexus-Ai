"""OpenAI-compatible inference client (NVIDIA build.nvidia.com / NIM endpoints).

Failures become `ProviderError`s with a kind the gateway and the owner can act on.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import httpx

RETRYABLE_STATUS = {429, 500, 502, 503, 504}


class ProviderError(Exception):
    def __init__(
        self,
        kind: str,
        message: str,
        *,
        status: int | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message)
        self.kind = kind
        self.status = status
        self.retry_after = retry_after

    @property
    def retryable(self) -> bool:
        return self.kind in {"rate_limited", "provider_unavailable", "network"}


def classify(status: int, body: str, headers: httpx.Headers | None = None) -> ProviderError:
    """Turns an HTTP error from the provider into a clear, actionable error."""
    detail = body[:300]
    try:
        parsed = json.loads(body)
        detail = str(
            parsed.get("detail")
            or parsed.get("error", {}).get("message")
            or parsed.get("title")
            or detail
        )[:300]
    except (ValueError, AttributeError):
        pass
    retry_after = None
    if headers and (raw := headers.get("retry-after")):
        try:
            retry_after = float(raw)
        except ValueError:
            retry_after = None
    if status in (401, 403):
        return ProviderError(
            "auth",
            "NVIDIA rejected the API key (unauthorised). Check or replace the key.",
            status=status,
        )
    if status == 402:
        return ProviderError(
            "quota",
            "NVIDIA reports no remaining credits for this key. No paid fallback is used.",
            status=status,
        )
    if status == 404:
        return ProviderError(
            "model_unavailable",
            f"This model isn't available to your NVIDIA account ({detail}).",
            status=status,
        )
    if status == 429:
        return ProviderError(
            "rate_limited",
            "NVIDIA rate limit reached (free-tier limits apply). The request was retried and then stopped.",
            status=status,
            retry_after=retry_after,
        )
    if status in (400, 422):
        return ProviderError("bad_request", f"NVIDIA rejected the request: {detail}", status=status)
    if status >= 500:
        return ProviderError(
            "provider_unavailable",
            f"NVIDIA had a server error ({status}).",
            status=status,
            retry_after=retry_after,
        )
    return ProviderError(
        "provider_error", f"Unexpected response from NVIDIA ({status}): {detail}", status=status
    )


@dataclass
class Completion:
    model: str
    content: str
    finish_reason: str | None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    reasoning_tokens: int | None = None
    first_token_ms: int | None = None
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class StreamEvent:
    """A text delta, a reasoning signal (content hidden) or the final usage."""

    kind: str  # "text" | "reasoning" | "done"
    text: str = ""
    completion: Completion | None = None


def _usage(payload: dict[str, Any], completion: Completion) -> None:
    usage = payload.get("usage") or {}
    completion.prompt_tokens = usage.get("prompt_tokens", completion.prompt_tokens)
    completion.completion_tokens = usage.get("completion_tokens", completion.completion_tokens)
    details = usage.get("completion_tokens_details") or {}
    completion.reasoning_tokens = details.get("reasoning_tokens", completion.reasoning_tokens)


class OpenAICompatibleProvider:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: float,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {api_key}", "Accept": "application/json"}
        self._timeout = httpx.Timeout(timeout, connect=10.0)
        self._transport = transport

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            timeout=self._timeout, transport=self._transport, headers=self._headers
        )

    async def list_models(self) -> list[dict[str, Any]]:
        try:
            async with self._client() as client:
                response = await client.get(f"{self.base_url}/models")
        except httpx.TimeoutException as error:
            raise ProviderError("timeout", "NVIDIA didn't answer in time.") from error
        except httpx.HTTPError as error:
            raise ProviderError(
                "network", f"Couldn't reach NVIDIA ({type(error).__name__})."
            ) from error
        if response.status_code != 200:
            raise classify(response.status_code, response.text, response.headers)
        return list(response.json().get("data", []))

    def _body(
        self,
        model: str,
        messages: list[dict[str, str]],
        max_tokens: int,
        temperature: float,
        stream: bool,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": stream,
        }
        if stream:
            body["stream_options"] = {"include_usage": True}
        return body

    async def complete(
        self, model: str, messages: list[dict[str, str]], max_tokens: int, temperature: float
    ) -> Completion:
        started = time.perf_counter()
        try:
            async with self._client() as client:
                response = await client.post(
                    f"{self.base_url}/chat/completions",
                    json=self._body(model, messages, max_tokens, temperature, False),
                )
        except httpx.TimeoutException as error:
            raise ProviderError(
                "timeout",
                "The model didn't answer within the timeout. It may be overloaded; try again or pick another model.",
            ) from error
        except httpx.HTTPError as error:
            raise ProviderError(
                "network", f"Couldn't reach NVIDIA ({type(error).__name__})."
            ) from error
        if response.status_code != 200:
            raise classify(response.status_code, response.text, response.headers)
        payload = response.json()
        choice = (payload.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        completion = Completion(
            model=payload.get("model", model),
            content=message.get("content") or "",
            finish_reason=choice.get("finish_reason"),
            first_token_ms=int((time.perf_counter() - started) * 1000),
        )
        _usage(payload, completion)
        return completion

    async def stream(
        self, model: str, messages: list[dict[str, str]], max_tokens: int, temperature: float
    ) -> AsyncIterator[StreamEvent]:
        """Server-sent events → StreamEvents. Reasoning text is never forwarded, only signalled."""
        started = time.perf_counter()
        completion = Completion(model=model, content="", finish_reason=None)
        try:
            async with (
                self._client() as client,
                client.stream(
                    "POST",
                    f"{self.base_url}/chat/completions",
                    json=self._body(model, messages, max_tokens, temperature, True),
                ) as response,
            ):
                if response.status_code != 200:
                    raise classify(
                        response.status_code,
                        (await response.aread()).decode(errors="replace"),
                        response.headers,
                    )
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        payload = json.loads(data)
                    except ValueError:
                        continue
                    _usage(payload, completion)
                    for choice in payload.get("choices") or []:
                        delta = choice.get("delta") or {}
                        if choice.get("finish_reason"):
                            completion.finish_reason = choice["finish_reason"]
                        if delta.get("reasoning_content") or delta.get("reasoning"):
                            if completion.first_token_ms is None:
                                completion.first_token_ms = int(
                                    (time.perf_counter() - started) * 1000
                                )
                            yield StreamEvent("reasoning")
                        if text := delta.get("content"):
                            if completion.first_token_ms is None:
                                completion.first_token_ms = int(
                                    (time.perf_counter() - started) * 1000
                                )
                            completion.content += text
                            yield StreamEvent("text", text=text)
        except httpx.TimeoutException as error:
            raise ProviderError(
                "timeout", "The model stopped responding within the timeout."
            ) from error
        except httpx.HTTPError as error:
            raise ProviderError(
                "network", f"Connection to NVIDIA failed ({type(error).__name__})."
            ) from error
        yield StreamEvent("done", completion=completion)
