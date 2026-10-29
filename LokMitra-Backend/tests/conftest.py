import os
from datetime import UTC, datetime
from uuid import UUID

import pytest
from fastapi.testclient import TestClient

os.environ.update(
    {
        "DATABASE_URL": "postgresql://lokmitra_pool:test-only-password@localhost:5432/lokmitra_test",
        "SUPABASE_JWT_SECRET": "lokmitra-test-secret-key-at-least-32-bytes",
        "SUPABASE_JWT_ISSUER": "https://test.supabase.co/auth/v1",
        "SUPABASE_JWT_AUDIENCE": "authenticated",
        "CORS_ORIGINS": "http://localhost:3000",
        "DAILY_SPEECH_BUDGET": "1",
        "MAX_BODY_BYTES": "2000000",
    }
)

import asyncpg
from fastapi import FastAPI

import config
from database import get_connection
from main import create_app


class FakeTransaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False


class FakeConnection:
    def __init__(self) -> None:
        self.merchants: dict[UUID, dict] = {}
        self.customers: dict[UUID, dict] = {}
        self.events: dict[UUID, dict] = {}
        self.orders: dict[UUID, dict] = {}
        self.speech_quota: dict[tuple[UUID, str, object], int] = {}
        self.ledger_rows: list[dict] = []

    def transaction(self) -> FakeTransaction:
        return FakeTransaction()

    async def execute(self, query: str, *args):
        normalized = " ".join(query.lower().split())
        if normalized.startswith("select set_config"):
            return "SELECT 1"
        if normalized.startswith("update public.speech_quota"):
            merchant_id, user_id_hash = args
            key = (merchant_id, user_id_hash, datetime.now(UTC).date())
            self.speech_quota[key] = max(0, self.speech_quota.get(key, 0) - 1)
            return "UPDATE 1"
        if normalized.startswith("select public.upsert_merchant_profile"):
            merchant_id, phone_number, business_name, preferred_language = args
            current = self.merchants.get(merchant_id)
            self.merchants[merchant_id] = {
                "id": merchant_id,
                "phone_number": current["phone_number"] if current else phone_number,
                "business_name": business_name,
                "preferred_language": preferred_language,
                "created_at": current["created_at"] if current else datetime.now(UTC),
            }
            return "SELECT 1"
        if normalized.startswith("insert into public.merchants"):
            merchant_id, phone_number, business_name, preferred_language = args
            current = self.merchants.get(merchant_id)
            self.merchants[merchant_id] = {
                "id": merchant_id,
                "phone_number": current["phone_number"] if current else phone_number,
                "business_name": business_name,
                "preferred_language": preferred_language,
                "created_at": current["created_at"] if current else datetime.now(UTC),
            }
            return "INSERT 0 1"
        raise AssertionError(f"Unmocked execute query: {normalized}")

    async def fetchval(self, query: str, *args):
        normalized = " ".join(query.lower().split())
        if normalized == "select 1":
            return 1
        if normalized.startswith("select set_config"):
            return args[0]
        if normalized.startswith("select public.upsert_customer_for_merchant"):
            (
                customer_id,
                merchant_id,
                display_name,
                phone_number,
                updated_at,
                device_id,
            ) = args
            current = self.customers.get(customer_id)
            if current is not None and current["merchant_id"] != merchant_id:
                return None
            if current is not None and (updated_at, device_id) <= (
                current["updated_at"],
                current["updated_by_device"],
            ):
                return None
            self.customers[customer_id] = {
                "id": customer_id,
                "merchant_id": merchant_id,
                "display_name": display_name,
                "phone_number": phone_number,
                "updated_at": updated_at,
                "updated_by_device": device_id,
                "server_updated_at": datetime.now(UTC),
                "created_at": (current["created_at"] if current else datetime.now(UTC)),
            }
            return customer_id
        if normalized.startswith("insert into public.customers"):
            customer_id, merchant_id, display_name, phone_number = args
            current = self.customers.get(customer_id)
            if current is not None and current["merchant_id"] != merchant_id:
                return None
            self.customers[customer_id] = {
                "id": customer_id,
                "merchant_id": merchant_id,
                "display_name": display_name,
                "phone_number": phone_number,
                "created_at": (current["created_at"] if current else datetime.now(UTC)),
            }
            return customer_id
        if normalized.startswith("select id from public.customers"):
            customer_id, merchant_id = args
            customer = self.customers.get(customer_id)
            return (
                customer_id
                if customer and customer["merchant_id"] == merchant_id
                else None
            )
        if normalized.startswith("select id from public.transaction_events"):
            event_id, merchant_id = args
            event = self.events.get(event_id)
            return event_id if event and event["merchant_id"] == merchant_id else None
        if normalized.startswith("select id from public.orders"):
            order_id, merchant_id = args
            order = self.orders.get(order_id)
            return order_id if order and order["merchant_id"] == merchant_id else None
        if normalized.startswith("select public.upsert_order_for_merchant"):
            (
                order_id,
                merchant_id,
                customer_id,
                description,
                status,
                created_at,
                is_demo,
                updated_at,
                device_id,
            ) = args
            customer = self.customers.get(customer_id)
            if customer is None or customer["merchant_id"] != merchant_id:
                return None
            current = self.orders.get(order_id)
            if current is not None and current["merchant_id"] != merchant_id:
                return None
            if current is not None and (updated_at, device_id) <= (
                current["updated_at"],
                current["updated_by_device"],
            ):
                return None
            self.orders[order_id] = {
                "id": order_id,
                "merchant_id": merchant_id,
                "customer_id": customer_id,
                "description": description,
                "status": status,
                "created_at": created_at,
                "is_demo": is_demo,
                "updated_at": updated_at,
                "updated_by_device": device_id,
                "server_updated_at": datetime.now(UTC),
            }
            return order_id
        if normalized.startswith("insert into public.transaction_events"):
            (
                event_id,
                merchant_id,
                customer_id,
                event_type,
                amount_paise,
                note,
                occurred_at,
                client_timestamp,
                transcript_raw,
                confirmed_by_user,
                reverses_id,
                speech_usage,
                vector_clock,
            ) = args
            if event_id in self.events:
                return None
            if event_type == "reversal" and (
                reverses_id not in self.events
                or self.events[reverses_id]["type"] == "reversal"
                or any(
                    existing["reverses_id"] == reverses_id
                    for existing in self.events.values()
                )
            ):
                return None
            if not any(
                customer["id"] == customer_id and customer["merchant_id"] == merchant_id
                for customer in self.customers.values()
            ):
                return None
            self.events[event_id] = {
                "id": event_id,
                "merchant_id": merchant_id,
                "customer_id": customer_id,
                "type": event_type,
                "amount_paise": amount_paise,
                "note": note,
                "occurred_at": occurred_at,
                "client_timestamp": client_timestamp,
                "transcript_raw": transcript_raw,
                "confirmed_by_user": confirmed_by_user,
                "reverses_id": reverses_id,
                "speech_usage": speech_usage,
                "vector_clock": vector_clock,
                "seq": len(self.events) + 1,
                "created_at": datetime.now(UTC),
            }
            return event_id
        raise AssertionError(f"Unmocked fetchval query: {normalized}")

    async def fetchrow(self, query: str, *args):
        normalized = " ".join(query.lower().split())
        if normalized.startswith("select preferred_language from public.merchants"):
            merchant = self.merchants.get(args[0])
            return (
                {"preferred_language": merchant["preferred_language"]}
                if merchant
                else None
            )
        if normalized.startswith(
            "select display_name, phone_number, updated_at, updated_by_device from public.customers"
        ):
            customer = self.customers.get(args[0])
            if customer is not None and customer["merchant_id"] == args[1]:
                return {
                    "display_name": customer["display_name"],
                    "phone_number": customer["phone_number"],
                    "updated_at": customer["updated_at"],
                    "updated_by_device": customer["updated_by_device"],
                }
            return None
        if normalized.startswith("select id, phone_number, business_name"):
            merchant = self.merchants.get(args[0])
            return merchant.copy() if merchant else None
        if normalized.startswith("insert into public.speech_quota"):
            merchant_id, user_id_hash, budget = args
            key = (merchant_id, user_id_hash, datetime.now(UTC).date())
            count = self.speech_quota.get(key, 0)
            if count >= budget:
                return None
            self.speech_quota[key] = count + 1
            return {"request_count": count + 1}
        raise AssertionError(f"Unmocked fetchrow query: {normalized}")

    async def fetch(self, query: str, *args):
        normalized = " ".join(query.lower().split())
        if normalized.startswith("select id, seq, customer_id"):
            merchant_id, after_created_at, after_id, limit = args
            rows = [
                event.copy()
                for event in self.events.values()
                if event["merchant_id"] == merchant_id
                and (
                    after_created_at is None
                    or (event["created_at"], event["id"]) > (after_created_at, after_id)
                )
            ]
            return sorted(rows, key=lambda row: (row["created_at"], row["id"]))[:limit]
        if normalized.startswith("select id, customer_id, description, status"):
            merchant_id, after_updated_at, after_id, limit = args
            rows = [
                order.copy()
                for order in self.orders.values()
                if order["merchant_id"] == merchant_id
                and (
                    after_updated_at is None
                    or (order["server_updated_at"], order["id"])
                    > (after_updated_at, after_id)
                )
            ]
            return sorted(rows, key=lambda row: (row["server_updated_at"], row["id"]))[
                :limit
            ]
        if normalized.startswith("select id, display_name, phone_number, owed_paise"):
            return self.ledger_rows
        if normalized.startswith(
            "select id, display_name, phone_number, created_at, updated_at"
        ):
            merchant_id, after_updated_at, after_id, limit = args
            rows = [
                customer.copy()
                for customer in self.customers.values()
                if customer["merchant_id"] == merchant_id
                and (
                    after_updated_at is None
                    or (customer["server_updated_at"], customer["id"])
                    > (after_updated_at, after_id)
                )
            ]
            return sorted(rows, key=lambda row: (row["server_updated_at"], row["id"]))[
                :limit
            ]
        if normalized.startswith("select id, display_name from public.customers"):
            merchant_id = args[0]
            return [
                {"id": customer["id"], "display_name": customer["display_name"]}
                for customer in self.customers.values()
                if customer["merchant_id"] == merchant_id
            ]
        raise AssertionError(f"Unmocked fetch query: {normalized}")


class FakePool:
    def __init__(self) -> None:
        self.connection = FakeConnection()
        self._in_use = 0

    def acquire(self):
        return FakeAcquire(self)

    def get_size(self) -> int:
        return 1

    def get_idle_size(self) -> int:
        return 1 - self._in_use

    async def close(self) -> None:
        return None


class FakeAcquire:
    def __init__(self, pool: FakePool) -> None:
        self.pool = pool

    async def __aenter__(self) -> FakeConnection:
        self.pool._in_use += 1
        return self.pool.connection

    async def __aexit__(self, exc_type, exc, traceback) -> bool:
        self.pool._in_use -= 1
        return False


class FallbackSpeechChain:
    async def transcribe(self, audio: bytes, mime: str, language: str = "te"):
        from providers.chain import TranscriptionResult

        return TranscriptionResult(
            text="",
            confidence=None,
            provider="none",
            fallback="client",
        )


@pytest.fixture
def fake_connection() -> FakeConnection:
    return FakeConnection()


@pytest.fixture
def app(monkeypatch: pytest.MonkeyPatch, fake_connection: FakeConnection) -> FastAPI:
    config.get_settings.cache_clear()
    fake_pool = FakePool()
    fake_pool.connection = fake_connection
    monkeypatch.setattr(asyncpg, "create_pool", lambda **kwargs: _fake_pool(fake_pool))
    application = create_app()
    application.state.speech_provider_chain = FallbackSpeechChain()

    async def override_connection():
        yield fake_connection

    application.dependency_overrides[get_connection] = override_connection
    return application


async def _fake_pool(pool: FakePool) -> FakePool:
    return pool


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    with TestClient(app) as test_client:
        yield test_client
