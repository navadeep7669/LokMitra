import asyncio
import logging
import random
import time
from dataclasses import dataclass

import httpx

from config import get_settings
from providers.base import Provider, Transcript
from providers.local_stt import LocalSTTProvider
from providers.sarvam import SarvamTranslationProvider

logger = logging.getLogger("lokmitra.speech")


@dataclass(frozen=True, slots=True)
class TranscriptionResult:
    text: str
    confidence: float | None
    provider: str
    fallback: str | None = None


@dataclass(frozen=True, slots=True)
class TranslationResult:
    text: str
    provider: str


class _CircuitBreaker:
    def __init__(self) -> None:
        self.failures: list[float] = []
        self.open_until = 0.0

    def allows_request(self, now: float) -> bool:
        if now < self.open_until:
            return False
        self.failures = [failure for failure in self.failures if now - failure <= 60.0]
        if len(self.failures) >= 5:
            self.open_until = now + 60.0
            return False
        return True

    def record_failure(self, now: float) -> None:
        self.failures = [failure for failure in self.failures if now - failure <= 60.0]
        self.failures.append(now)
        if len(self.failures) >= 5:
            self.open_until = now + 60.0

    def record_success(self) -> None:
        self.failures.clear()
        self.open_until = 0.0


class ProviderChain:
    def __init__(
        self,
        providers: list[Provider] | None = None,
        translation_providers: list[Provider] | None = None,
    ) -> None:
        settings = get_settings()
        self.providers = providers if providers is not None else [LocalSTTProvider()]
        self.translation_providers = (
            translation_providers
            if translation_providers is not None
            else ([SarvamTranslationProvider()] if settings.SARVAM_API_KEY else [])
        )
        self._breakers = {
            provider.name: _CircuitBreaker() for provider in self.providers
        }
        self._locks = {provider.name: asyncio.Lock() for provider in self.providers}

    async def _transcribe_with_retry(
        self, provider: Provider, audio: bytes, mime: str, language: str
    ) -> Transcript:
        breaker = self._breakers[provider.name]
        async with self._locks[provider.name]:
            if not breaker.allows_request(time.monotonic()):
                raise RuntimeError("Provider circuit is open")

        for attempt in range(2):
            try:
                result = await asyncio.wait_for(
                    provider.transcribe(audio, mime, language),
                    timeout=90.0,
                )
                if not result.text.strip():
                    raise ValueError("Provider returned an empty transcript")
                async with self._locks[provider.name]:
                    breaker.record_success()
                return result
            except (httpx.HTTPError, TimeoutError, ValueError, TypeError, RuntimeError):
                async with self._locks[provider.name]:
                    breaker.record_failure(time.monotonic())
                if attempt == 0:
                    await asyncio.sleep(random.uniform(0.1, 0.35))
        raise RuntimeError("Provider failed")

    async def transcribe(
        self, audio: bytes, mime: str, language: str = "te"
    ) -> TranscriptionResult:
        for provider in self.providers:
            try:
                result = await self._transcribe_with_retry(
                    provider, audio, mime, language
                )
            except RuntimeError as error:
                logger.warning(
                    "speech_provider_failed",
                    extra={
                        "provider": provider.name,
                        "error_type": type(error).__name__,
                    },
                )
                continue
            return TranscriptionResult(
                text=result.text,
                confidence=result.confidence,
                provider=provider.name,
            )
        return TranscriptionResult(
            text="",
            confidence=None,
            provider="none",
            fallback="client",
        )

    async def translate(
        self, text: str, from_language: str, to_language: str
    ) -> TranslationResult:
        for provider in self.translation_providers:
            try:
                translated = await asyncio.wait_for(
                    provider.translate(text, from_language, to_language),
                    timeout=15.0,
                )
            except (
                httpx.HTTPError,
                NotImplementedError,
                TimeoutError,
                TypeError,
                ValueError,
                RuntimeError,
            ):
                continue
            if translated.strip():
                return TranslationResult(translated.strip(), provider.name)
        raise RuntimeError("Translation providers are unavailable")
