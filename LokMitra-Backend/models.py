from datetime import UTC, datetime, timedelta
from enum import Enum
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    field_validator,
    model_validator,
)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class EventType(str, Enum):
    CREDIT_SALE = "credit_sale"
    PAYMENT_RECEIVED = "payment_received"
    REFUND = "refund"
    PAYABLE = "payable"
    REVERSAL = "reversal"


class SpeechUsage(str, Enum):
    MANUAL = "manual"
    BROWSER_SPEECH = "browser_speech"
    LOCAL_STT = "local_stt"
    SARVAM_SAARAS_V3 = "sarvam_saaras_v3"
    BHASHINI = "bhashini"
    SHERPA_ONNX = "sherpa_onnx"


class SyncItemStatus(str, Enum):
    ACCEPTED = "accepted"
    DUPLICATE = "duplicate"
    REJECTED = "rejected"


PositivePaise = Annotated[StrictInt, Field(gt=0, le=1_000_000_000)]
_MAX_SAFE_JAVASCRIPT_INTEGER = 9_007_199_254_740_991


class CustomerIn(StrictModel):
    id: UUID
    display_name: Annotated[StrictStr, Field(min_length=1, max_length=120)]
    phone_number: Annotated[StrictStr | None, Field(max_length=32)] = None
    updated_at: Annotated[
        StrictInt | None, Field(ge=0, le=_MAX_SAFE_JAVASCRIPT_INTEGER)
    ] = None

    @field_validator("display_name", "phone_number")
    @classmethod
    def reject_blank_text(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("Text fields must not be blank")
        return value


class EventIn(StrictModel):
    id: UUID
    customer_id: UUID
    type: EventType
    amount_paise: PositivePaise
    note: Annotated[StrictStr | None, Field(max_length=1000)] = None
    occurred_at: datetime
    client_timestamp: Annotated[StrictInt, Field(ge=0, le=9_223_372_036_854_775_807)]
    transcript_raw: Annotated[StrictStr | None, Field(max_length=2000)] = None
    confirmed_by_user: StrictBool
    reverses_id: UUID | None = None
    speech_usage: SpeechUsage
    vector_clock: dict[StrictStr, Annotated[StrictInt, Field(ge=0)]] | None = None

    @field_validator("occurred_at")
    @classmethod
    def require_utc_aware_datetime(cls, value: datetime) -> datetime:
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("occurred_at must include a timezone")
        if value.utcoffset() != timedelta(0):
            raise ValueError("occurred_at must be expressed in UTC")
        if value > datetime.now(UTC) + timedelta(hours=24):
            raise ValueError("occurred_at cannot be more than 24 hours in the future")
        return value

    @field_validator("note", "transcript_raw")
    @classmethod
    def reject_blank_optional_text(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("Text fields must not be blank")
        return value

    @field_validator("vector_clock")
    @classmethod
    def limit_vector_clock(cls, value: dict[str, int] | None) -> dict[str, int] | None:
        if value is not None and len(value) > 20:
            raise ValueError("vector_clock must contain at most 20 entries")
        return value

    @model_validator(mode="after")
    def validate_reversal_reference(self) -> "EventIn":
        if self.type is EventType.REVERSAL and self.reverses_id is None:
            raise ValueError("A reversal must reference the event it reverses")
        if self.type is not EventType.REVERSAL and self.reverses_id is not None:
            raise ValueError("Only a reversal may reference another event")
        if self.reverses_id == self.id:
            raise ValueError("An event cannot reverse itself")
        return self


OrderStatus = Literal["New", "In Progress", "Ready", "Completed"]


class SyncOrderIn(StrictModel):
    id: UUID
    customer_id: UUID
    description: Annotated[StrictStr, Field(min_length=1, max_length=1000)]
    status: OrderStatus
    created_at: Annotated[StrictInt, Field(ge=0, le=_MAX_SAFE_JAVASCRIPT_INTEGER)]
    updated_at: Annotated[StrictInt, Field(ge=0, le=_MAX_SAFE_JAVASCRIPT_INTEGER)]
    is_demo: StrictBool = False

    @field_validator("description")
    @classmethod
    def reject_blank_order_description(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Text fields must not be blank")
        return value


class SyncPushRequest(StrictModel):
    customers: Annotated[list[CustomerIn], Field(max_length=200)] = Field(
        default_factory=list
    )
    events: Annotated[list[EventIn], Field(max_length=200)] = Field(
        default_factory=list
    )
    orders: Annotated[list[SyncOrderIn], Field(max_length=200)] = Field(
        default_factory=list
    )
    cursor: Annotated[StrictStr | None, Field(max_length=512)] = None
    device_id: UUID


class LegacySyncPushRequest(SyncPushRequest):
    device_id: UUID | None = None


class SyncItemResult(StrictModel):
    id: UUID
    status: SyncItemStatus
    reason: Annotated[StrictStr | None, Field(max_length=200)] = None


class SyncPulledEvent(StrictModel):
    id: UUID
    seq: StrictInt
    customer_id: UUID
    type: EventType
    amount_paise: PositivePaise
    note: Annotated[StrictStr | None, Field(max_length=1000)] = None
    occurred_at: datetime
    client_timestamp: Annotated[StrictInt, Field(ge=0, le=9_223_372_036_854_775_807)]
    transcript_raw: Annotated[StrictStr | None, Field(max_length=2000)] = None
    confirmed_by_user: StrictBool
    reverses_id: UUID | None = None
    speech_usage: SpeechUsage
    vector_clock: dict[StrictStr, Annotated[StrictInt, Field(ge=0)]] | None = None


class SyncPulledOrder(StrictModel):
    id: UUID
    customer_id: UUID
    description: Annotated[StrictStr, Field(min_length=1, max_length=1000)]
    status: OrderStatus
    created_at: StrictInt
    is_demo: StrictBool
    updated_at: StrictInt
    updated_by_device: UUID


class SyncPulledCustomer(StrictModel):
    id: UUID
    display_name: Annotated[StrictStr, Field(min_length=1, max_length=120)]
    phone_number: Annotated[StrictStr | None, Field(max_length=32)] = None
    created_at: datetime
    updated_at: StrictInt
    updated_by_device: UUID


class SyncPullResponse(StrictModel):
    customers: list[SyncPulledCustomer]
    events: list[SyncPulledEvent]
    orders: list[SyncPulledOrder] = Field(default_factory=list)
    next_seq: Annotated[StrictInt, Field(ge=0)]
    next_cursor: Annotated[StrictStr | None, Field(max_length=512)] = None


class SyncPulledPage(StrictModel):
    customers: list[SyncPulledCustomer]
    events: list[SyncPulledEvent]
    orders: list[SyncPulledOrder]
    next_cursor: Annotated[StrictStr | None, Field(max_length=512)] = None


class SyncPushResponse(StrictModel):
    customers: list[SyncItemResult]
    events: list[SyncItemResult]
    orders: list[SyncItemResult] = Field(default_factory=list)
    pulled: SyncPulledPage


class AsrResponse(StrictModel):
    transcript: Annotated[StrictStr, Field(max_length=4000)]
    provider: Annotated[StrictStr, Field(min_length=1, max_length=40)]
    confidence: Annotated[float, Field(ge=0, le=1)] | None = None
    fallback: Annotated[StrictStr | None, Field(max_length=40)] = None


class TranslateRequest(StrictModel):
    text: Annotated[StrictStr, Field(min_length=1, max_length=4000)]
    from_language: Literal["te", "hi", "en"]
    to_language: Literal["te", "hi", "en"]

    @field_validator("text")
    @classmethod
    def reject_blank_translation_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Text must not be blank")
        return value


class TtsRequest(StrictModel):
    text: Annotated[StrictStr, Field(min_length=1, max_length=500)]
    language: Literal["te", "hi", "en"]

    @field_validator("text")
    @classmethod
    def validate_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Text must not be blank")
        return value


class TranslateResponse(StrictModel):
    translated_text: Annotated[StrictStr, Field(max_length=4000)]
    provider: Annotated[StrictStr, Field(min_length=1, max_length=40)]


class LedgerCustomer(StrictModel):
    id: UUID
    display_name: Annotated[StrictStr, Field(min_length=1, max_length=120)]
    phone_number: Annotated[StrictStr | None, Field(max_length=32)] = None
    owed_paise: StrictInt
    refund_paise: Annotated[StrictInt, Field(ge=0)]
    payable_paise: Annotated[StrictInt, Field(ge=0)]


class CustomerCandidate(StrictModel):
    id: UUID
    display_name: Annotated[StrictStr, Field(min_length=1, max_length=120)]
    score: Annotated[float, Field(ge=0, le=1)]


class SpeechParseResponse(StrictModel):
    transcript: Annotated[StrictStr, Field(max_length=4000)]
    confidence: Annotated[float, Field(ge=0, le=1)] | None
    provider: Annotated[StrictStr, Field(min_length=1, max_length=40)]
    customer_candidates: Annotated[list[CustomerCandidate], Field(max_length=3)]
    fallback: Annotated[StrictStr | None, Field(max_length=40)] = None
    intent: Literal[
        "add_credit",
        "record_payment",
        "show_balance",
        "pending_dues",
        "daily_summary",
        "remind_customer",
        "unknown",
    ]
    amount_paise: StrictInt | None
    needs_review: list[StrictStr]


class MerchantMeRequest(StrictModel):
    business_name: Annotated[StrictStr, Field(min_length=1, max_length=120)]
    preferred_language: Literal["te", "hi", "en"] = "te"

    @field_validator("business_name")
    @classmethod
    def reject_blank_merchant_text(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Text fields must not be blank")
        return value


class MerchantMeResponse(StrictModel):
    id: UUID
    phone_number: Annotated[StrictStr, Field(min_length=8, max_length=32)]
    business_name: Annotated[StrictStr, Field(min_length=1, max_length=120)]
    preferred_language: Literal["te", "hi", "en"]
    created_at: datetime
