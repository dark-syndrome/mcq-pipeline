"""
Module: llm_client.py
Thin wrapper around the Anthropic, Groq, and OpenRouter SDKs + instructor for
structured-output calls.

Public API:
- TokenUsage        — Pydantic model for token usage metadata.
- LLMClient         — Abstract base with a unified .call() signature.
- AnthropicClient   — Concrete client for Anthropic Claude models.
- GroqClient        — Concrete client for Groq-hosted open-source models.
- OpenRouterClient  — Concrete client for OpenRouter (OpenAI-compatible).
- make_client()     — Factory that returns the right client based on provider.
"""

import time
from abc import ABC, abstractmethod
from typing import TypeVar

import instructor
import structlog
from pydantic import BaseModel
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

log = structlog.get_logger(__name__)

T = TypeVar("T", bound=BaseModel)


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


class TokenUsage(BaseModel):
    """Token usage metadata returned alongside every LLM response."""

    input_tokens: int
    output_tokens: int
    model: str


# Sentinel returned when a cache hit means no LLM was called.
_NULL_USAGE = TokenUsage(input_tokens=0, output_tokens=0, model="cache")


# ---------------------------------------------------------------------------
# Abstract base
# ---------------------------------------------------------------------------


class LLMClient(ABC):
    """
    Abstract base for LLM clients.

    Concrete subclasses wrap their respective SDKs but expose the same
    ``.call()`` signature so downstream code is provider-agnostic.
    """

    def __init__(
        self,
        api_key: str,
        default_model: str,
        max_retries: int = 3,
        initial_backoff: float = 2.0,
    ) -> None:
        self._api_key = api_key
        self._default_model = default_model
        self._max_retries = max_retries
        self._initial_backoff = initial_backoff
        self._client = self._build_client()
        self._retryable = self._build_retryable_exceptions()

    @abstractmethod
    def _build_client(self):
        """Construct the underlying instructor-wrapped SDK client."""

    @abstractmethod
    def _build_retryable_exceptions(self) -> tuple:
        """Return the tuple of exception types that should trigger retries."""

    @abstractmethod
    def _extract_usage(self, raw, model: str) -> TokenUsage:
        """Pull token counts out of a raw provider response."""

    @abstractmethod
    def _build_kwargs(
        self,
        *,
        model: str,
        max_tokens: int,
        temperature: float,
        prompt: str,
        system_prompt: str | None,
        response_model: type,
    ) -> dict:
        """Build the kwargs dict passed to the SDK's .create() call."""

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def call(
        self,
        prompt: str,
        response_model: type[T],
        temperature: float,
        model: str | None = None,
        max_tokens: int = 8000,
        system_prompt: str | None = None,
    ) -> tuple[T, TokenUsage]:
        """
        Send *prompt* to the provider and parse the response into *response_model*.

        Returns ``(parsed_response, token_usage)``.
        """
        resolved_model = model or self._default_model

        @retry(
            retry=retry_if_exception_type(self._retryable),
            stop=stop_after_attempt(self._max_retries + 1),
            wait=wait_exponential(
                multiplier=self._initial_backoff,
                min=self._initial_backoff,
            ),
            reraise=True,
        )
        def _invoke() -> tuple[T, TokenUsage]:
            kwargs = self._build_kwargs(
                model=resolved_model,
                max_tokens=max_tokens,
                temperature=temperature,
                prompt=prompt,
                system_prompt=system_prompt,
                response_model=response_model,
            )

            start_ms = time.monotonic()
            response, raw = self._client.chat.completions.create_with_completion(
                **kwargs
            )
            elapsed_ms = round((time.monotonic() - start_ms) * 1000)

            usage = self._extract_usage(raw, resolved_model)

            log.info(
                "llm_call_complete",
                provider=self.__class__.__name__,
                model=resolved_model,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                duration_ms=elapsed_ms,
            )

            return response, usage

        return _invoke()

    @staticmethod
    def estimate_cost(
        usage: TokenUsage,
        input_price_per_million: float,
        output_price_per_million: float,
    ) -> float:
        """Estimate USD cost for the given token usage."""
        input_cost = (usage.input_tokens / 1_000_000) * input_price_per_million
        output_cost = (usage.output_tokens / 1_000_000) * output_price_per_million
        return input_cost + output_cost


# ---------------------------------------------------------------------------
# Anthropic implementation
# ---------------------------------------------------------------------------


class AnthropicClient(LLMClient):
    """LLM client backed by the Anthropic Claude API."""

    def _build_client(self):
        from anthropic import Anthropic

        return instructor.from_anthropic(Anthropic(api_key=self._api_key))

    def _build_retryable_exceptions(self) -> tuple:
        import anthropic

        return (
            anthropic.RateLimitError,
            anthropic.APITimeoutError,
            anthropic.APIConnectionError,
        )

    def _build_kwargs(
        self,
        *,
        model: str,
        max_tokens: int,
        temperature: float,
        prompt: str,
        system_prompt: str | None,
        response_model: type,
    ) -> dict:
        kwargs: dict = dict(
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            messages=[{"role": "user", "content": prompt}],
            response_model=response_model,
        )
        if system_prompt:
            kwargs["system"] = system_prompt
        return kwargs

    def _extract_usage(self, raw, model: str) -> TokenUsage:
        return TokenUsage(
            input_tokens=raw.usage.input_tokens,
            output_tokens=raw.usage.output_tokens,
            model=model,
        )


# ---------------------------------------------------------------------------
# Groq implementation
# ---------------------------------------------------------------------------


class GroqClient(LLMClient):
    """
    LLM client backed by the Groq API.

    Groq is OpenAI-compatible, so we use instructor's `from_groq` adapter
    with JSON mode. System prompts go inside the messages list (no separate
    top-level parameter), and usage fields follow the OpenAI shape
    (``prompt_tokens`` / ``completion_tokens``).
    """

    def _build_client(self):
        from groq import Groq

        return instructor.from_groq(
            Groq(api_key=self._api_key),
            mode=instructor.Mode.JSON,
        )

    def _build_retryable_exceptions(self) -> tuple:
        import groq

        return (
            groq.RateLimitError,
            groq.APITimeoutError,
            groq.APIConnectionError,
        )

    def _build_kwargs(
        self,
        *,
        model: str,
        max_tokens: int,
        temperature: float,
        prompt: str,
        system_prompt: str | None,
        response_model: type,
    ) -> dict:
        messages: list[dict] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})

        return dict(
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            messages=messages,
            response_model=response_model,
        )

    def _extract_usage(self, raw, model: str) -> TokenUsage:
        # Groq follows OpenAI's usage shape.
        return TokenUsage(
            input_tokens=raw.usage.prompt_tokens,
            output_tokens=raw.usage.completion_tokens,
            model=model,
        )


# ---------------------------------------------------------------------------
# OpenRouter implementation
# ---------------------------------------------------------------------------


class OpenRouterClient(LLMClient):
    """
    LLM client backed by OpenRouter (https://openrouter.ai).

    OpenRouter is OpenAI-API-compatible, so we use instructor's
    ``from_openai`` adapter pointed at the OpenRouter base URL.

    Usage fields follow the OpenAI shape (``prompt_tokens`` /
    ``completion_tokens``).  A ``site_url`` and ``app_name`` are sent as
    custom HTTP headers for OpenRouter analytics — harmless to omit.

    Set in .env:
        OPENROUTER_API_KEY=sk-or-...

    Example models (pass as ``model`` in config.yaml):
        openai/gpt-4o
        anthropic/claude-sonnet-4-6          # billed via OpenRouter
        google/gemini-2.5-pro
        meta-llama/llama-4-scout-17b-16e-instruct
        mistralai/mistral-7b-instruct
    """

    OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

    def _build_client(self):
        from openai import OpenAI

        raw_client = OpenAI(
            api_key=self._api_key,
            base_url=self.OPENROUTER_BASE_URL,
            default_headers={
                "HTTP-Referer": "https://nxtwave.com",
                "X-Title": "MCQ-Pipeline",
            },
        )
        return instructor.from_openai(raw_client, mode=instructor.Mode.JSON)

    def _build_retryable_exceptions(self) -> tuple:
        import openai

        return (
            openai.RateLimitError,
            openai.APITimeoutError,
            openai.APIConnectionError,
        )

    def _build_kwargs(
        self,
        *,
        model: str,
        max_tokens: int,
        temperature: float,
        prompt: str,
        system_prompt: str | None,
        response_model: type,
    ) -> dict:
        messages: list[dict] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})

        return dict(
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            messages=messages,
            response_model=response_model,
        )

    def _extract_usage(self, raw, model: str) -> TokenUsage:
        # OpenRouter follows OpenAI's usage shape.
        return TokenUsage(
            input_tokens=raw.usage.prompt_tokens,
            output_tokens=raw.usage.completion_tokens,
            model=model,
        )


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def make_client(
    provider: str,
    api_key: str,
    default_model: str,
    max_retries: int = 3,
    initial_backoff: float = 2.0,
) -> LLMClient:
    """
    Build the right concrete client for *provider*.

    Args:
        provider:        ``"anthropic"``, ``"groq"``, or ``"openrouter"``
                         (case-insensitive).
        api_key:         Provider API key.
        default_model:   Model identifier used when no override is passed.
        max_retries:     Maximum retry attempts on transient errors.
        initial_backoff: Initial backoff duration (seconds).

    Raises:
        ValueError: if *provider* is not recognised.
    """
    provider_norm = provider.strip().lower()

    if provider_norm == "anthropic":
        return AnthropicClient(
            api_key=api_key,
            default_model=default_model,
            max_retries=max_retries,
            initial_backoff=initial_backoff,
        )
    if provider_norm == "groq":
        return GroqClient(
            api_key=api_key,
            default_model=default_model,
            max_retries=max_retries,
            initial_backoff=initial_backoff,
        )
    if provider_norm == "openrouter":
        return OpenRouterClient(
            api_key=api_key,
            default_model=default_model,
            max_retries=max_retries,
            initial_backoff=initial_backoff,
        )

    raise ValueError(
        f"Unknown provider: {provider!r}. Must be 'anthropic', 'groq', or 'openrouter'."
    )
