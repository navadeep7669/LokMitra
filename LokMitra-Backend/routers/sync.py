import base64
import json
from datetime import UTC, datetime
from typing import Annotated, Any
from uuid import UUID, uuid4

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query

from auth import get_merchant_id
from database import get_connection
from models import (
    EventType,
    LegacySyncPushRequest,
    SyncItemResult,
    SyncItemStatus,
    SyncOrderIn,
    SyncPulledCustomer,
    SyncPulledEvent,
    SyncPulledOrder,
    SyncPulledPage,
    SyncPullResponse,
    SyncPushRequest,
    SyncPushResponse,
)

router = APIRouter(tags=["sync"])
_GENERIC_REJECTION = "Item could not be accepted."


def _encode_cursor(
    customers: tuple[datetime, UUID] | None,
    events: tuple[datetime, UUID] | None,
    orders: tuple[datetime, UUID] | None = None,
) -> str:
    payload: dict[str, list[str] | None] = {
        "customers": (
            [customers[0].isoformat(), str(customers[1])] if customers else None
        ),
        "events": [events[0].isoformat(), str(events[1])] if events else None,
        "orders": [orders[0].isoformat(), str(orders[1])] if orders else None,
    }
    return (
        base64.urlsafe_b64encode(
            json.dumps(payload, separators=(",", ":")).encode("utf-8")
        )
        .decode("ascii")
        .rstrip("=")
    )


def _decode_cursor(
    cursor: str | None,
) -> tuple[
    tuple[datetime, UUID] | None,
    tuple[datetime, UUID] | None,
    tuple[datetime, UUID] | None,
]:
    if cursor is None:
        return None, None, None
    try:
        payload = json.loads(
            base64.urlsafe_b64decode(cursor.encode("ascii") + b"=" * (-len(cursor) % 4))
        )
        if not isinstance(payload, dict):
            raise TypeError("Invalid cursor")

        def decode_key(key: str) -> tuple[datetime, UUID] | None:
            value = payload.get(key)
            if value is None:
                return None
            if not isinstance(value, list) or len(value) != 2:
                raise ValueError("Invalid cursor")
            created_at = datetime.fromisoformat(value[0])
            event_id = UUID(value[1])
            if created_at.tzinfo is None or created_at.utcoffset() is None:
                raise ValueError("Cursor timestamp must include a timezone")
            return created_at, event_id

        return decode_key("customers"), decode_key("events"), decode_key("orders")
    except (ValueError, KeyError, TypeError, UnicodeError, json.JSONDecodeError):
        raise HTTPException(status_code=422, detail="Invalid cursor.") from None


async def _push_customer(
    connection: asyncpg.Connection, merchant_id: UUID, device_id: UUID, customer: Any
) -> SyncItemResult:
    existing = await connection.fetchrow(
        """
        SELECT display_name, phone_number, updated_at, updated_by_device
        FROM public.customers
        WHERE id = $1 AND merchant_id = $2
        """,
        customer.id,
        merchant_id,
    )
    updated_at = customer.updated_at
    if updated_at is None:
        if (
            existing is not None
            and existing["display_name"] == customer.display_name
            and existing["phone_number"] == customer.phone_number
        ):
            return SyncItemResult(id=customer.id, status=SyncItemStatus.DUPLICATE)
        updated_at = int(datetime.now(UTC).timestamp() * 1000)
        if existing is not None:
            updated_at = max(updated_at, existing["updated_at"] + 1)
    try:
        async with connection.transaction():
            saved = await connection.fetchval(
                """
                SELECT public.upsert_customer_for_merchant($1, $2, $3, $4, $5, $6)
                """,
                customer.id,
                merchant_id,
                customer.display_name,
                customer.phone_number,
                updated_at,
                device_id,
            )
    except asyncpg.InsufficientPrivilegeError:
        return SyncItemResult(
            id=customer.id,
            status=SyncItemStatus.REJECTED,
            reason=_GENERIC_REJECTION,
        )
    if saved is not None:
        return SyncItemResult(id=customer.id, status=SyncItemStatus.ACCEPTED)
    return SyncItemResult(
        id=customer.id,
        status=SyncItemStatus.DUPLICATE
        if existing is not None
        else SyncItemStatus.REJECTED,
        reason=_GENERIC_REJECTION if existing is None else None,
    )


async def _push_order(
    connection: asyncpg.Connection,
    merchant_id: UUID,
    device_id: UUID,
    order: SyncOrderIn,
) -> SyncItemResult:
    try:
        async with connection.transaction():
            saved = await connection.fetchval(
                """
                SELECT public.upsert_order_for_merchant(
                    $1, $2, $3, $4, $5, $6, $7, $8, $9
                )
                """,
                order.id,
                merchant_id,
                order.customer_id,
                order.description,
                order.status,
                order.created_at,
                order.is_demo,
                order.updated_at,
                device_id,
            )
    except asyncpg.IntegrityConstraintViolationError:
        return SyncItemResult(
            id=order.id,
            status=SyncItemStatus.REJECTED,
            reason=_GENERIC_REJECTION,
        )
    if saved is not None:
        return SyncItemResult(id=order.id, status=SyncItemStatus.ACCEPTED)
    existing = await connection.fetchval(
        "SELECT id FROM public.orders WHERE id = $1 AND merchant_id = $2",
        order.id,
        merchant_id,
    )
    return SyncItemResult(
        id=order.id,
        status=(
            SyncItemStatus.DUPLICATE
            if existing is not None
            else SyncItemStatus.REJECTED
        ),
        reason=_GENERIC_REJECTION if existing is None else None,
    )


async def _push_sync(
    payload: SyncPushRequest,
    merchant_id: UUID,
    connection: asyncpg.Connection,
) -> SyncPushResponse:
    if payload.orders and payload.device_id is None:
        raise HTTPException(status_code=422, detail="Invalid request.")
    if payload.cursor is not None:
        _decode_cursor(payload.cursor)
    customer_results: list[SyncItemResult] = []
    event_results: dict[UUID, SyncItemResult] = {}
    order_results: list[SyncItemResult] = []

    async with connection.transaction():
        for customer in payload.customers:
            customer_results.append(
                await _push_customer(
                    connection, merchant_id, payload.device_id or uuid4(), customer
                )
            )

        for order in payload.orders:
            order_results.append(
                await _push_order(
                    connection,
                    merchant_id,
                    payload.device_id or uuid4(),
                    order,
                )
            )

        ordered_events = sorted(
            payload.events,
            key=lambda event: event.type is EventType.REVERSAL,
        )
        for event in ordered_events:
            if not event.confirmed_by_user:
                event_results[event.id] = SyncItemResult(
                    id=event.id,
                    status=SyncItemStatus.REJECTED,
                    reason=_GENERIC_REJECTION,
                )
                continue

            customer_exists = await connection.fetchval(
                """
                SELECT id
                FROM public.customers
                WHERE id = $1 AND merchant_id = $2
                """,
                event.customer_id,
                merchant_id,
            )
            if customer_exists is None:
                event_results[event.id] = SyncItemResult(
                    id=event.id,
                    status=SyncItemStatus.REJECTED,
                    reason=_GENERIC_REJECTION,
                )
                continue

            try:
                async with connection.transaction():
                    inserted = await connection.fetchval(
                        """
                        INSERT INTO public.transaction_events
                            (id, merchant_id, customer_id, type, amount_paise, note,
                             occurred_at, client_timestamp, transcript_raw,
                             confirmed_by_user, reverses_id, speech_usage,
                             vector_clock)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                                $12, $13::jsonb)
                        ON CONFLICT (id) DO NOTHING
                        RETURNING id
                        """,
                        event.id,
                        merchant_id,
                        event.customer_id,
                        event.type.value,
                        event.amount_paise,
                        event.note,
                        event.occurred_at,
                        event.client_timestamp,
                        event.transcript_raw,
                        event.confirmed_by_user,
                        event.reverses_id,
                        event.speech_usage.value,
                        (
                            json.dumps(event.vector_clock)
                            if event.vector_clock is not None
                            else None
                        ),
                    )
            except asyncpg.IntegrityConstraintViolationError:
                event_results[event.id] = SyncItemResult(
                    id=event.id,
                    status=SyncItemStatus.REJECTED,
                    reason=_GENERIC_REJECTION,
                )
                continue
            if inserted is not None:
                event_results[event.id] = SyncItemResult(
                    id=event.id, status=SyncItemStatus.ACCEPTED
                )
                continue

            existing = await connection.fetchval(
                """
                SELECT id
                FROM public.transaction_events
                WHERE id = $1 AND merchant_id = $2
                """,
                event.id,
                merchant_id,
            )
            status = (
                SyncItemStatus.DUPLICATE
                if existing is not None
                else SyncItemStatus.REJECTED
            )
            event_results[event.id] = SyncItemResult(
                id=event.id,
                status=status,
                reason=_GENERIC_REJECTION if existing is None else None,
            )

    pulled = await _pull_sync(connection, merchant_id, payload.cursor, 500)
    return SyncPushResponse(
        customers=customer_results,
        events=[event_results[event.id] for event in payload.events],
        orders=order_results,
        pulled=SyncPulledPage(
            customers=pulled.customers,
            events=pulled.events,
            orders=pulled.orders,
            next_cursor=pulled.next_cursor,
        ),
    )


@router.post(
    "/api/sync",
    response_model=SyncPushResponse,
    response_model_exclude_none=True,
)
async def push_sync(
    payload: SyncPushRequest,
    merchant_id: Annotated[UUID, Depends(get_merchant_id)],
    connection: Annotated[asyncpg.Connection, Depends(get_connection)],
) -> SyncPushResponse:
    return await _push_sync(payload, merchant_id, connection)


@router.post(
    "/api/v1/sync",
    response_model=SyncPushResponse,
    response_model_exclude_none=True,
    include_in_schema=False,
)
async def push_sync_legacy(
    payload: LegacySyncPushRequest,
    merchant_id: Annotated[UUID, Depends(get_merchant_id)],
    connection: Annotated[asyncpg.Connection, Depends(get_connection)],
) -> SyncPushResponse:
    return await _push_sync(payload, merchant_id, connection)


@router.get(
    "/api/v1/sync/pull", response_model=SyncPullResponse, include_in_schema=False
)
async def pull_sync(
    merchant_id: Annotated[UUID, Depends(get_merchant_id)],
    connection: Annotated[asyncpg.Connection, Depends(get_connection)],
    cursor: Annotated[str | None, Query(max_length=512)] = None,
    limit: Annotated[int, Query(ge=1)] = 500,
) -> SyncPullResponse:
    return await _pull_sync(connection, merchant_id, cursor, min(limit, 500))


async def _pull_sync(
    connection: asyncpg.Connection,
    merchant_id: UUID,
    cursor: str | None,
    effective_limit: int,
) -> SyncPullResponse:
    customer_cursor, event_cursor, order_cursor = _decode_cursor(cursor)
    customer_rows = await connection.fetch(
        """
        SELECT id, display_name, phone_number, created_at, updated_at,
               updated_by_device, server_updated_at
        FROM public.customers
        WHERE merchant_id = $1
          AND (
              $2::timestamptz IS NULL
              OR (server_updated_at, id) > ($2::timestamptz, $3::uuid)
          )
        ORDER BY server_updated_at, id
        LIMIT $4
        """,
        merchant_id,
        customer_cursor[0] if customer_cursor else None,
        customer_cursor[1] if customer_cursor else None,
        effective_limit,
    )
    rows = await connection.fetch(
        """
        SELECT id, seq, customer_id, type, amount_paise, note, occurred_at,
               client_timestamp, transcript_raw, confirmed_by_user, reverses_id,
               speech_usage, vector_clock, created_at
        FROM public.transaction_events
        WHERE merchant_id = $1
          AND (
              $2::timestamptz IS NULL
              OR (created_at, id) > ($2::timestamptz, $3::uuid)
          )
        ORDER BY created_at, id
        LIMIT $4
        """,
        merchant_id,
        event_cursor[0] if event_cursor else None,
        event_cursor[1] if event_cursor else None,
        effective_limit,
    )
    order_rows = await connection.fetch(
        """
        SELECT id, customer_id, description, status, created_at, is_demo,
               updated_at, updated_by_device, server_updated_at
        FROM public.orders
        WHERE merchant_id = $1
          AND (
              $2::timestamptz IS NULL
              OR (server_updated_at, id) > ($2::timestamptz, $3::uuid)
          )
        ORDER BY server_updated_at, id
        LIMIT $4
        """,
        merchant_id,
        order_cursor[0] if order_cursor else None,
        order_cursor[1] if order_cursor else None,
        effective_limit,
    )
    customers = [
        SyncPulledCustomer(
            id=row["id"],
            display_name=row["display_name"],
            phone_number=row["phone_number"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            updated_by_device=row["updated_by_device"],
        )
        for row in customer_rows
    ]
    events = [
        SyncPulledEvent(
            id=row["id"],
            seq=row["seq"],
            customer_id=row["customer_id"],
            type=row["type"],
            amount_paise=row["amount_paise"],
            note=row["note"],
            occurred_at=row["occurred_at"],
            client_timestamp=row["client_timestamp"],
            transcript_raw=row["transcript_raw"],
            confirmed_by_user=row["confirmed_by_user"],
            reverses_id=row["reverses_id"],
            speech_usage=row["speech_usage"],
            vector_clock=(
                json.loads(row["vector_clock"])
                if isinstance(row["vector_clock"], str)
                else row["vector_clock"]
            ),
        )
        for row in rows
    ]
    orders = [
        SyncPulledOrder(
            id=row["id"],
            customer_id=row["customer_id"],
            description=row["description"],
            status=row["status"],
            created_at=row["created_at"],
            is_demo=row["is_demo"],
            updated_at=row["updated_at"],
            updated_by_device=row["updated_by_device"],
        )
        for row in order_rows
    ]
    next_customer_cursor = (
        (customer_rows[-1]["server_updated_at"], customer_rows[-1]["id"])
        if customer_rows
        else customer_cursor
    )
    next_event_cursor = (
        (rows[-1]["created_at"], rows[-1]["id"]) if rows else event_cursor
    )
    next_order_cursor = (
        (order_rows[-1]["server_updated_at"], order_rows[-1]["id"])
        if order_rows
        else order_cursor
    )
    next_cursor = (
        _encode_cursor(next_customer_cursor, next_event_cursor, next_order_cursor)
        if customer_rows or rows or order_rows or cursor is not None
        else None
    )
    return SyncPullResponse(
        customers=customers,
        events=events,
        orders=orders,
        next_seq=events[-1].seq if events else 0,
        next_cursor=next_cursor,
    )
