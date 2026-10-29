import asyncio
from collections.abc import Mapping

import httpx

from config import get_settings
from providers.base import Provider, Transcript

_LANGUAGES = {"te": "te-IN", "hi": "hi-IN", "en": "en-IN"}
_POLL_INTERVAL_SECONDS = 0.25
_MAX_POLL_ATTEMPTS = 120


class LocalSTTProvider(Provider):
    name = "local_stt"

    def _headers(self) -> dict[str, str]:
        api_key = get_settings().LOCAL_STT_API_KEY
        return {"X-API-Key": api_key.get_secret_value()} if api_key is not None else {}

    async def transcribe(
        self, audio: bytes, mime: str, language: str = "te"
    ) -> Transcript:
        if language not in _LANGUAGES:
            raise ValueError("Unsupported local STT language")
        settings = get_settings()
        timeout = httpx.Timeout(30.0, connect=5.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                f"{settings.LOCAL_STT_URL}/batch/transcribe",
                headers=self._headers(),
                data={"language_code": _LANGUAGES[language]},
                files={"file": ("speech.wav", audio, mime)},
            )
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, Mapping):
                raise TypeError("Local STT returned an invalid job.")
            job_id = payload.get("job_id")
            if not isinstance(job_id, str) or not job_id:
                raise ValueError("Local STT returned no job identifier.")

            for attempt in range(_MAX_POLL_ATTEMPTS):
                result_response = await client.get(
                    f"{settings.LOCAL_STT_URL}/batch/result/{job_id}",
                    headers=self._headers(),
                )
                result_response.raise_for_status()
                result = result_response.json()
                if not isinstance(result, Mapping):
                    raise TypeError("Local STT returned an invalid result.")
                status = result.get("status")
                if status == "completed":
                    text = result.get("transcript")
                    if not isinstance(text, str) or not text.strip():
                        raise ValueError("Local STT returned an empty transcript.")
                    return Transcript(text=text.strip(), confidence=None)
                if status == "failed":
                    raise RuntimeError("Local STT transcription failed.")
                if status not in {"queued", "processing"}:
                    raise ValueError("Local STT returned an unknown job status.")
                if attempt + 1 < _MAX_POLL_ATTEMPTS:
                    await asyncio.sleep(_POLL_INTERVAL_SECONDS)
        raise TimeoutError("Local STT transcription timed out.")
