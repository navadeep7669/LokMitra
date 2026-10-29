import asyncio
import base64
import binascii
from collections.abc import Mapping

import httpx

from config import get_settings

_LANGUAGES = {"te": "te-IN", "hi": "hi-IN", "en": "en-IN"}
_POLL_INTERVAL_SECONDS = 0.25
_MAX_POLL_ATTEMPTS = 180
_MAX_AUDIO_BYTES = 10_000_000


class LocalTTSProvider:
    def _headers(self) -> dict[str, str]:
        api_key = get_settings().LOCAL_TTS_API_KEY
        return {"X-API-Key": api_key.get_secret_value()} if api_key is not None else {}

    async def synthesize(self, text: str, language: str) -> bytes:
        if language not in _LANGUAGES:
            raise ValueError("Unsupported local TTS language")
        settings = get_settings()
        timeout = httpx.Timeout(30.0, connect=5.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                f"{settings.LOCAL_TTS_URL}/batch/synthesize",
                headers=self._headers(),
                json={"text": text, "lang": _LANGUAGES[language], "style": "default"},
            )
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, Mapping):
                raise TypeError("Local TTS returned an invalid job.")
            job_id = payload.get("job_id")
            if not isinstance(job_id, str) or not job_id:
                raise ValueError("Local TTS returned no job identifier.")

            for attempt in range(_MAX_POLL_ATTEMPTS):
                result_response = await client.get(
                    f"{settings.LOCAL_TTS_URL}/batch/result/{job_id}",
                    headers=self._headers(),
                )
                result_response.raise_for_status()
                result = result_response.json()
                if not isinstance(result, Mapping):
                    raise TypeError("Local TTS returned an invalid result.")
                status = result.get("status")
                if status == "completed":
                    encoded_audio = result.get("audio_b64")
                    if not isinstance(encoded_audio, str):
                        raise ValueError("Local TTS returned no audio.")
                    try:
                        audio = base64.b64decode(encoded_audio, validate=True)
                    except (binascii.Error, ValueError) as error:
                        raise ValueError("Local TTS returned invalid audio.") from error
                    if (
                        len(audio) < 12
                        or len(audio) > _MAX_AUDIO_BYTES
                        or audio[:4] != b"RIFF"
                        or audio[8:12] != b"WAVE"
                    ):
                        raise ValueError("Local TTS returned invalid WAV audio.")
                    return audio
                if status == "failed":
                    raise RuntimeError("Local TTS synthesis failed.")
                if status not in {"queued", "processing"}:
                    raise ValueError("Local TTS returned an unknown job status.")
                if attempt + 1 < _MAX_POLL_ATTEMPTS:
                    await asyncio.sleep(_POLL_INTERVAL_SECONDS)
        raise TimeoutError("Local TTS synthesis timed out.")
