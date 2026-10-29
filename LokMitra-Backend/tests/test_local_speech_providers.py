import base64
import wave
from io import BytesIO

import pytest
import respx
from httpx import Response

import config
from providers.chain import ProviderChain
from providers.local_stt import LocalSTTProvider
from providers.local_tts import LocalTTSProvider
from providers.sarvam import SARVAM_TRANSLATE_URL, SarvamTranslationProvider


@pytest.fixture
def sarvam_settings(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("SARVAM_API_KEY", "sarvam-test-key")
    config.get_settings.cache_clear()
    yield
    config.get_settings.cache_clear()


@pytest.fixture
def local_speech_settings(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LOCAL_STT_URL", "http://127.0.0.1:8091")
    monkeypatch.setenv("LOCAL_STT_API_KEY", "stt-test-key")
    monkeypatch.setenv("LOCAL_TTS_URL", "http://127.0.0.1:8092")
    monkeypatch.setenv("LOCAL_TTS_API_KEY", "tts-test-key")
    config.get_settings.cache_clear()
    yield
    config.get_settings.cache_clear()


@pytest.mark.asyncio
async def test_local_stt_submits_and_polls_a_transcription_job(local_speech_settings) -> None:
    with respx.mock(assert_all_called=True) as mock:
        submission = mock.post("http://127.0.0.1:8091/batch/transcribe").mock(
            return_value=Response(200, json={"job_id": "job-1"})
        )
        poll = mock.get("http://127.0.0.1:8091/batch/result/job-1").mock(
            side_effect=[
                Response(200, json={"status": "processing"}),
                Response(
                    200,
                    json={"status": "completed", "transcript": "namaskaram"},
                ),
            ]
        )
        transcript = await LocalSTTProvider().transcribe(b"RIFF", "audio/wav", "te")

    assert transcript.text == "namaskaram"
    assert submission.calls[0].request.headers["X-API-Key"] == "stt-test-key"
    assert poll.call_count == 2


@pytest.mark.parametrize("api_key", ["", " \t "])
@pytest.mark.asyncio
async def test_local_stt_omits_header_when_api_key_is_blank(
    local_speech_settings,
    monkeypatch: pytest.MonkeyPatch,
    api_key: str,
) -> None:
    monkeypatch.setenv("LOCAL_STT_API_KEY", api_key)
    config.get_settings.cache_clear()
    with respx.mock(assert_all_called=True) as mock:
        submission = mock.post("http://127.0.0.1:8091/batch/transcribe").mock(
            return_value=Response(200, json={"job_id": "job-blank-stt"})
        )
        mock.get("http://127.0.0.1:8091/batch/result/job-blank-stt").mock(
            return_value=Response(
                200,
                json={"status": "completed", "transcript": "namaskaram"},
            )
        )
        await LocalSTTProvider().transcribe(b"RIFF", "audio/wav", "te")

    assert "X-API-Key" not in submission.calls[0].request.headers
    config.get_settings.cache_clear()


@pytest.mark.asyncio
async def test_local_tts_submits_and_returns_validated_wav(local_speech_settings) -> None:
    output = BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(8_000)
        stream.writeframes(b"\x00\x00" * 800)
    wav = output.getvalue()
    with respx.mock(assert_all_called=True) as mock:
        submission = mock.post("http://127.0.0.1:8092/batch/synthesize").mock(
            return_value=Response(200, json={"job_id": "job-2"})
        )
        mock.get("http://127.0.0.1:8092/batch/result/job-2").mock(
            return_value=Response(
                200,
                json={
                    "status": "completed",
                    "audio_b64": base64.b64encode(wav).decode("ascii"),
                    "sample_rate": 8_000,
                },
            )
        )
        synthesized = await LocalTTSProvider().synthesize("namaste", "hi")

    assert synthesized == wav
    assert submission.calls[0].request.headers["X-API-Key"] == "tts-test-key"


@pytest.mark.parametrize("api_key", ["", " \t "])
@pytest.mark.asyncio
async def test_local_tts_omits_header_when_api_key_is_blank(
    local_speech_settings,
    monkeypatch: pytest.MonkeyPatch,
    api_key: str,
) -> None:
    monkeypatch.setenv("LOCAL_TTS_API_KEY", api_key)
    config.get_settings.cache_clear()
    output = BytesIO()
    with wave.open(output, "wb") as stream:
        stream.setnchannels(1)
        stream.setsampwidth(2)
        stream.setframerate(8_000)
        stream.writeframes(b"\x00\x00" * 800)
    wav = output.getvalue()
    with respx.mock(assert_all_called=True) as mock:
        submission = mock.post("http://127.0.0.1:8092/batch/synthesize").mock(
            return_value=Response(200, json={"job_id": "job-blank-tts"})
        )
        mock.get("http://127.0.0.1:8092/batch/result/job-blank-tts").mock(
            return_value=Response(
                200,
                json={
                    "status": "completed",
                    "audio_b64": base64.b64encode(wav).decode("ascii"),
                    "sample_rate": 8_000,
                },
            )
        )
        await LocalTTSProvider().synthesize("namaste", "hi")

    assert "X-API-Key" not in submission.calls[0].request.headers
    config.get_settings.cache_clear()


@pytest.mark.asyncio
async def test_sarvam_translates_text_with_supported_language_codes(
    sarvam_settings,
) -> None:
    with respx.mock(assert_all_called=True) as mock:
        request = mock.post(SARVAM_TRANSLATE_URL).mock(
            return_value=Response(
                200,
                json={"translated_text": "నమస్కారం"},
            )
        )
        translated = await SarvamTranslationProvider().translate("hello", "en", "te")

    sent = request.calls[0].request
    assert sent.headers["api-subscription-key"] == "sarvam-test-key"
    assert sent.read() == (
        b'{"input":"hello","source_language_code":"en-IN",'
        b'"target_language_code":"te-IN","speaker_gender":"Female",'
        b'"mode":"formal","model":"mayura:v1","enable_preprocessing":true}'
    )
    assert translated == "నమస్కారం"


def test_sarvam_is_the_only_configured_translation_provider(
    sarvam_settings,
) -> None:
    chain = ProviderChain()
    assert [provider.name for provider in chain.providers] == ["local_stt"]
    assert [provider.name for provider in chain.translation_providers] == [
        "sarvam_translate"
    ]


@pytest.mark.asyncio
async def test_translation_does_not_fall_back_when_sarvam_is_not_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SARVAM_API_KEY", "")
    config.get_settings.cache_clear()
    chain = ProviderChain()
    assert chain.translation_providers == []
    with pytest.raises(RuntimeError, match="unavailable"):
        await chain.translate("hello", "en", "te")
    config.get_settings.cache_clear()
