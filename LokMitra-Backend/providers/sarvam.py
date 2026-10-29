from collections.abc import Mapping

import httpx

from config import get_settings
from providers.base import Provider, Transcript

SARVAM_TRANSLATE_URL = "https://api.sarvam.ai/translate"
_LANGUAGE_CODES = {"te": "te-IN", "hi": "hi-IN", "en": "en-IN"}


class SarvamTranslationProvider(Provider):
    name = "sarvam_translate"

    async def transcribe(
        self, audio: bytes, mime: str, language: str = "te"
    ) -> Transcript:
        raise NotImplementedError("Sarvam is configured for translation only.")

    async def translate(self, text: str, from_language: str, to_language: str) -> str:
        if from_language not in _LANGUAGE_CODES or to_language not in _LANGUAGE_CODES:
            raise ValueError("Unsupported Sarvam translation language.")
        settings = get_settings()
        if settings.SARVAM_API_KEY is None:
            raise RuntimeError("Sarvam translation is not configured.")
        timeout = httpx.Timeout(15.0, connect=5.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                settings.SARVAM_TRANSLATE_URL,
                headers={
                    "api-subscription-key": settings.SARVAM_API_KEY.get_secret_value(),
                    "Content-Type": "application/json",
                },
                json={
                    "input": text,
                    "source_language_code": _LANGUAGE_CODES[from_language],
                    "target_language_code": _LANGUAGE_CODES[to_language],
                    "speaker_gender": "Female",
                    "mode": "formal",
                    "model": "mayura:v1",
                    "enable_preprocessing": True,
                },
            )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, Mapping):
            raise TypeError("Invalid Sarvam translation response.")
        translated_text = payload.get("translated_text")
        if not isinstance(translated_text, str) or not translated_text.strip():
            raise ValueError("Sarvam returned no translated text.")
        return translated_text.strip()
