import wave
from datetime import UTC, datetime
from io import BytesIO
from uuid import uuid4

import jwt
import pytest
from fastapi.testclient import TestClient

from providers.chain import TranscriptionResult, TranslationResult

_SECRET = "lokmitra-test-secret-key-at-least-32-bytes"
_ISSUER = "https://test.supabase.co/auth/v1"


def _headers(merchant_id) -> dict[str, str]:
    token = jwt.encode(
        {
            "sub": str(merchant_id),
            "aud": "authenticated",
            "iss": _ISSUER,
            "exp": int(datetime.now(UTC).timestamp()) + 3600,
            "role": "authenticated",
        },
        _SECRET,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def _wav_audio() -> bytes:
    output = BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(8_000)
        stream.writeframes(b"\x00\x00" * 8_000)
    return output.getvalue()


class FakeSpeechChain:
    async def transcribe(self, audio: bytes, mime: str, language: str):
        return TranscriptionResult("తెలుగు transcript", 0.9, "local_stt")

    async def translate(self, text: str, from_language: str, to_language: str):
        return TranslationResult(f"{text} translated", "sarvam_translate")


class FakeTTSProvider:
    async def synthesize(self, text: str, language: str) -> bytes:
        return b"RIFF\x04\x00\x00\x00WAVE"


def test_only_the_health_and_three_ai_routes_are_mounted(client: TestClient) -> None:
    paths = client.get("/openapi.json").json()["paths"]
    assert {"/api/asr", "/api/tts", "/api/translate"} <= paths.keys()
    assert client.get("/healthz").status_code == 200
    for path in (
        "/api/sync",
        "/api/v1/sync",
        "/api/v1/speech/parse",
        "/api/v1/ledger/customers",
        "/api/v1/merchants/me",
    ):
        assert client.post(path).status_code == 404


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/api/asr", b"unread body"),
        ("/api/tts", b'{"text":"hello","language":"en"}'),
        (
            "/api/translate",
            b'{"text":"hello","from_language":"en","to_language":"te"}',
        ),
    ],
)
def test_every_ai_route_rejects_invalid_authentication(
    client: TestClient, path: str, body: bytes
) -> None:
    response = client.post(
        path,
        content=body,
        headers={"Authorization": "Bearer invalid"},
    )
    assert response.status_code == 401


def test_asr_calls_configured_provider_with_authenticated_user(
    client: TestClient,
) -> None:
    client.app.state.speech_provider_chain = FakeSpeechChain()
    response = client.post(
        "/api/asr",
        headers=_headers(uuid4()),
        files={"file": ("speech.wav", _wav_audio(), "audio/wav")},
        data={"language": "te"},
    )
    assert response.status_code == 200
    assert response.json() == {
        "transcript": "తెలుగు transcript",
        "provider": "local_stt",
        "confidence": 0.9,
        "fallback": None,
    }


def test_tts_and_translation_return_expected_shapes(client: TestClient) -> None:
    client.app.state.tts_provider = FakeTTSProvider()
    client.app.state.speech_provider_chain = FakeSpeechChain()
    merchant_id = uuid4()

    tts = client.post(
        "/api/tts",
        headers=_headers(merchant_id),
        json={"text": "namaste", "language": "te"},
    )
    translation = client.post(
        "/api/translate",
        headers=_headers(uuid4()),
        json={"text": "hello", "from_language": "en", "to_language": "te"},
    )

    assert tts.status_code == 200
    assert tts.headers["content-type"] == "audio/wav"
    assert tts.content.startswith(b"RIFF")
    assert translation.status_code == 200
    assert translation.json() == {
        "translated_text": "hello translated",
        "provider": "sarvam_translate",
    }


def test_speech_quota_is_per_authenticated_user(
    client: TestClient, fake_connection
) -> None:
    client.app.state.speech_provider_chain = FakeSpeechChain()
    headers = _headers(uuid4())
    payload = {"text": "hello", "from_language": "en", "to_language": "te"}

    assert (
        client.post("/api/translate", headers=headers, json=payload).status_code == 200
    )
    limited = client.post("/api/translate", headers=headers, json=payload)
    assert limited.status_code == 429
    assert len(fake_connection.speech_quota) == 1
