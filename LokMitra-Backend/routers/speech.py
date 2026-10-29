import struct
from datetime import UTC, datetime, time, timedelta
from hashlib import sha256
from io import BytesIO
from typing import Annotated, Literal
from uuid import UUID

import asyncpg
import httpx
from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
    status,
)
from mutagen import File as MutagenFile
from starlette.responses import Response

from auth import get_merchant_id
from config import get_settings
from database import tenant_transaction
from models import AsrResponse, TranslateRequest, TranslateResponse, TtsRequest
from providers.chain import ProviderChain
from providers.local_tts import LocalTTSProvider

router = APIRouter(tags=["speech"])
_MAX_AUDIO_BYTES = 1_000_000
_MAX_AUDIO_SECONDS = 10.0
_MIME_SIGNATURES = {
    "audio/wav": (b"RIFF",),
    "audio/x-wav": (b"RIFF",),
    "audio/webm": (b"\x1a\x45\xdf\xa3",),
    "video/webm": (b"\x1a\x45\xdf\xa3",),
    "audio/ogg": (b"OggS",),
    "application/ogg": (b"OggS",),
}
_CANONICAL_MIME = {
    "audio/wav": "audio/wav",
    "audio/x-wav": "audio/wav",
    "audio/webm": "audio/webm",
    "video/webm": "audio/webm",
    "audio/ogg": "audio/ogg",
    "application/ogg": "audio/ogg",
}


def _seconds_until_utc_midnight(now: datetime) -> int:
    next_midnight = datetime.combine(
        now.date() + timedelta(days=1), time.min, tzinfo=UTC
    )
    return max(1, int((next_midnight - now).total_seconds()))


async def _consume_daily_budget(
    connection: asyncpg.Connection,
    merchant_id: UUID,
    user_id_hash: str,
    budget: int,
) -> int:
    retry_after = _seconds_until_utc_midnight(datetime.now(UTC))
    row = await connection.fetchrow(
        """
        INSERT INTO public.speech_quota
            (merchant_id, user_id_hash, usage_date, request_count)
        VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date, 1)
        ON CONFLICT (merchant_id, user_id_hash, usage_date)
        DO UPDATE SET request_count = speech_quota.request_count + 1
        WHERE speech_quota.request_count < $3
        RETURNING request_count
        """,
        merchant_id,
        user_id_hash,
        budget,
    )
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Speech budget exceeded.",
            headers={"Retry-After": str(retry_after)},
        )
    return row["request_count"]


async def _refund_daily_budget(
    request: Request, merchant_id: UUID, user_id_hash: str
) -> None:
    async with tenant_transaction(request, merchant_id) as connection:
        await connection.execute(
            """
            UPDATE public.speech_quota
            SET request_count = request_count - 1
            WHERE merchant_id = $1
              AND user_id_hash = $2
              AND usage_date = (now() AT TIME ZONE 'UTC')::date
              AND request_count > 0
            """,
            merchant_id,
            user_id_hash,
        )


def _validated_audio_mime(upload: UploadFile, audio: bytes) -> str:
    supplied_mime = (upload.content_type or "").split(";", 1)[0].strip().lower()
    signatures = _MIME_SIGNATURES.get(supplied_mime)
    if signatures is None or not any(
        audio.startswith(signature) for signature in signatures
    ):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Unsupported audio format.",
        )
    if supplied_mime in {"audio/wav", "audio/x-wav"} and audio[8:12] != b"WAVE":
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Unsupported audio format.",
        )
    if supplied_mime in {"audio/webm", "video/webm"} and (
        audio[:4] != b"\x1a\x45\xdf\xa3" or b"webm" not in audio[:128]
    ):
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Unsupported audio format.",
        )
    return _CANONICAL_MIME[supplied_mime]


def _read_ebml_vint(data: bytes, offset: int, *, element_id: bool) -> tuple[int, int]:
    if offset >= len(data) or data[offset] == 0:
        raise ValueError("Invalid EBML variable integer")
    first = data[offset]
    marker = 0x80
    width = 1
    while not first & marker:
        marker >>= 1
        width += 1
    if width > 8 or offset + width > len(data):
        raise ValueError("Invalid EBML variable integer")
    value = first if element_id else first & (marker - 1)
    for byte in data[offset + 1 : offset + width]:
        value = (value << 8) | byte
    return value, width


def _webm_duration_seconds(data: bytes) -> float | None:
    segment_id = 0x18538067
    info_id = 0x1549A966
    duration_id = 0x4489
    timecode_scale_id = 0x2AD7B1
    offset = 0

    while offset < len(data):
        element_id, id_width = _read_ebml_vint(data, offset, element_id=True)
        size, size_width = _read_ebml_vint(data, offset + id_width, element_id=False)
        payload_start = offset + id_width + size_width
        payload_end = min(len(data), payload_start + size)
        if element_id == segment_id:
            child_offset = payload_start
            timecode_scale = 1_000_000
            duration_value: float | None = None
            while child_offset < payload_end:
                child_id, child_id_width = _read_ebml_vint(
                    data, child_offset, element_id=True
                )
                child_size, child_size_width = _read_ebml_vint(
                    data, child_offset + child_id_width, element_id=False
                )
                child_start = child_offset + child_id_width + child_size_width
                child_end = min(payload_end, child_start + child_size)
                if child_id == info_id:
                    info_offset = child_start
                    while info_offset < child_end:
                        info_id_value, info_id_width = _read_ebml_vint(
                            data, info_offset, element_id=True
                        )
                        info_size, info_size_width = _read_ebml_vint(
                            data, info_offset + info_id_width, element_id=False
                        )
                        info_start = info_offset + info_id_width + info_size_width
                        info_end = min(child_end, info_start + info_size)
                        field = data[info_start:info_end]
                        if info_id_value == timecode_scale_id and field:
                            timecode_scale = int.from_bytes(field, "big")
                        elif info_id_value == duration_id and len(field) in (4, 8):
                            duration_value = struct.unpack(
                                ">f" if len(field) == 4 else ">d", field
                            )[0]
                        info_offset = info_end
                child_offset = child_end
            if duration_value is None:
                return None
            return duration_value * timecode_scale / 1_000_000_000
        if size == (1 << (7 * size_width)) - 1 or payload_end <= offset:
            return None
        offset = payload_end
    return None


def _validate_audio_duration(audio: bytes, mime: str) -> None:
    try:
        if mime == "audio/webm":
            duration = _webm_duration_seconds(audio)
        else:
            media = MutagenFile(BytesIO(audio))
            duration = (
                float(media.info.length)
                if media is not None and media.info is not None
                else None
            )
    except (OSError, ValueError, TypeError, struct.error):
        duration = None
    if duration is None or duration <= 0:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Unsupported audio format.",
        )
    if duration > _MAX_AUDIO_SECONDS:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail="Audio duration is too long.",
        )


def _user_id_hash(user_id: UUID) -> str:
    return sha256(user_id.bytes).hexdigest()


async def _read_audio(request: Request, audio_file: UploadFile) -> tuple[bytes, str]:
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared_length = int(content_length)
        except ValueError:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid request.",
            ) from None
        if declared_length > _MAX_AUDIO_BYTES + 64_000:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail="Audio file is too large.",
            )
    audio = await audio_file.read(_MAX_AUDIO_BYTES + 1)
    if len(audio) > _MAX_AUDIO_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail="Audio file is too large.",
        )
    mime = _validated_audio_mime(audio_file, audio)
    _validate_audio_duration(audio, mime)
    return audio, mime


def _provider_chain(request: Request) -> ProviderChain:
    chain = getattr(request.app.state, "speech_provider_chain", None)
    if chain is None:
        chain = ProviderChain()
        request.app.state.speech_provider_chain = chain
    return chain


async def _consume_user_budget(request: Request, merchant_id: UUID) -> str:
    user_id_hash = _user_id_hash(merchant_id)
    async with tenant_transaction(request, merchant_id) as connection:
        await _consume_daily_budget(
            connection,
            merchant_id,
            user_id_hash,
            get_settings().DAILY_SPEECH_BUDGET,
        )
    return user_id_hash


@router.post("/api/asr", response_model=AsrResponse)
async def transcribe_audio(
    request: Request,
    merchant_id: Annotated[UUID, Depends(get_merchant_id)],
    audio_file: Annotated[UploadFile, File(alias="file")],
    language: Annotated[Literal["te", "hi", "en"], Form()] = "te",
) -> AsrResponse:
    audio, mime = await _read_audio(request, audio_file)
    user_id_hash = await _consume_user_budget(request, merchant_id)
    try:
        result = await _provider_chain(request).transcribe(audio, mime, language)
    except (httpx.HTTPError, RuntimeError, TimeoutError, TypeError, ValueError):
        await _refund_daily_budget(request, merchant_id, user_id_hash)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Speech service is temporarily unavailable.",
        ) from None
    if result.provider == "none" or not result.text:
        await _refund_daily_budget(request, merchant_id, user_id_hash)
    return AsrResponse(
        transcript=result.text,
        provider=result.provider,
        confidence=result.confidence,
        fallback=result.fallback,
    )


@router.post("/api/translate", response_model=TranslateResponse)
async def translate_text(
    payload: TranslateRequest,
    request: Request,
    merchant_id: Annotated[UUID, Depends(get_merchant_id)],
) -> TranslateResponse:
    if payload.from_language == payload.to_language:
        return TranslateResponse(
            translated_text=payload.text,
            provider="identity",
        )
    user_id_hash = await _consume_user_budget(request, merchant_id)
    try:
        result = await _provider_chain(request).translate(
            payload.text,
            payload.from_language,
            payload.to_language,
        )
    except (httpx.HTTPError, RuntimeError, TimeoutError, TypeError, ValueError):
        await _refund_daily_budget(request, merchant_id, user_id_hash)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Translation service is temporarily unavailable.",
        ) from None
    return TranslateResponse(
        translated_text=result.text,
        provider=result.provider,
    )


@router.post("/api/tts")
async def synthesize_speech(
    payload: TtsRequest,
    request: Request,
    merchant_id: Annotated[UUID, Depends(get_merchant_id)],
) -> Response:
    user_id_hash = await _consume_user_budget(request, merchant_id)
    provider = getattr(request.app.state, "tts_provider", None) or LocalTTSProvider()
    try:
        audio = await provider.synthesize(payload.text.strip(), payload.language)
    except (httpx.HTTPError, RuntimeError, TimeoutError, TypeError, ValueError):
        await _refund_daily_budget(request, merchant_id, user_id_hash)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Speech service is temporarily unavailable.",
        ) from None
    return Response(
        content=audio,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store"},
    )
