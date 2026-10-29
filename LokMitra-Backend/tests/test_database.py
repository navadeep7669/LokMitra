import asyncio
import os
from types import SimpleNamespace
from uuid import uuid4

import asyncpg
import pytest
from fastapi import HTTPException

from routers.speech import (
    _consume_daily_budget,
    _refund_daily_budget,
    _user_id_hash,
)

pytestmark = pytest.mark.skipif(
    not os.environ.get("TEST_DATABASE_URL"),
    reason="TEST_DATABASE_URL is not configured",
)


async def _seed_user(connection: asyncpg.Connection, user_id) -> None:
    await connection.execute(
        """
        INSERT INTO auth.users
            (id, aud, role, email, encrypted_password, raw_app_meta_data,
             raw_user_meta_data, created_at, updated_at)
        VALUES ($1, 'authenticated', 'authenticated', $2, '',
                '{}'::jsonb, '{}'::jsonb, now(), now())
        """,
        user_id,
        f"lokmitra-{user_id}@example.test",
    )


async def _consume_as_pool_role(
    pool: asyncpg.Pool, user_id, user_hash: str, budget: int
) -> int:
    async with pool.acquire() as connection, connection.transaction():
        await connection.execute("SET LOCAL ROLE lokmitra_pool")
        await connection.fetchval(
            "SELECT set_config('app.merchant_id', $1, true)",
            str(user_id),
        )
        return await _consume_daily_budget(connection, user_id, user_hash, budget)


@pytest.mark.asyncio
async def test_user_speech_budget_is_atomic_under_concurrency() -> None:
    pool = await asyncpg.create_pool(
        os.environ["TEST_DATABASE_URL"], min_size=1, max_size=8
    )
    user_id = uuid4()
    user_hash = _user_id_hash(user_id)
    limit = 5
    try:
        async with pool.acquire() as connection:
            await _seed_user(connection, user_id)

        granted = await asyncio.gather(
            *(
                _consume_as_pool_role(pool, user_id, user_hash, limit)
                for _ in range(limit)
            )
        )
        assert sorted(granted) == list(range(1, limit + 1))

        with pytest.raises(HTTPException) as error:
            await _consume_as_pool_role(pool, user_id, user_hash, limit)
        assert error.value.status_code == 429
    finally:
        async with pool.acquire() as connection:
            await connection.execute("DELETE FROM auth.users WHERE id = $1", user_id)
        await pool.close()


@pytest.mark.asyncio
async def test_speech_budget_refund_allows_retry() -> None:
    pool = await asyncpg.create_pool(
        os.environ["TEST_DATABASE_URL"], min_size=1, max_size=2
    )
    user_id = uuid4()
    user_hash = _user_id_hash(user_id)
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(db_pool=pool)))
    try:
        async with pool.acquire() as connection:
            await _seed_user(connection, user_id)
        assert await _consume_as_pool_role(pool, user_id, user_hash, 1) == 1

        await _refund_daily_budget(request, user_id, user_hash)

        assert await _consume_as_pool_role(pool, user_id, user_hash, 1) == 1
    finally:
        async with pool.acquire() as connection:
            await connection.execute("DELETE FROM auth.users WHERE id = $1", user_id)
        await pool.close()
