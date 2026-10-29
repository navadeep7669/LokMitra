import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Annotated
from uuid import UUID

import asyncpg
from fastapi import Depends, FastAPI, Request

from auth import get_merchant_id
from config import get_settings

logger = logging.getLogger("lokmitra.database")
_DATABASE_CONNECTION_ERRORS = (
    asyncpg.PostgresError,
    asyncpg.InterfaceError,
    OSError,
    TimeoutError,
)


class DatabaseConnectionError(RuntimeError):
    pass


async def _create_pool() -> asyncpg.Pool:
    settings = get_settings()
    try:
        return await asyncpg.create_pool(
            dsn=settings.DATABASE_URL.get_secret_value(),
            min_size=1,
            max_size=10,
            command_timeout=15,
            timeout=5,
        )
    except _DATABASE_CONNECTION_ERRORS:
        raise DatabaseConnectionError(
            "Database connection failed. Check the Supabase host, port, restricted "
            "lokmitra_pool credentials, and network access."
        ) from None


async def check_database_connectivity(pool: asyncpg.Pool) -> None:
    try:
        async with pool.acquire() as connection:
            result = await connection.fetchval("SELECT 1")
    except _DATABASE_CONNECTION_ERRORS:
        raise DatabaseConnectionError(
            "Database connectivity check failed. Check the Supabase host, port, "
            "restricted lokmitra_pool credentials, and network access."
        ) from None
    if result != 1:
        raise DatabaseConnectionError(
            "Database connectivity check failed: SELECT 1 returned an unexpected result."
        )


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    pool = await _create_pool()
    try:
        await check_database_connectivity(pool)
    except DatabaseConnectionError:
        await pool.close()
        raise
    logger.info("database_connectivity_check_succeeded")
    app.state.db_pool = pool
    try:
        yield
    finally:
        await pool.close()


@asynccontextmanager
async def tenant_transaction(
    request: Request, merchant_id: UUID
) -> AsyncIterator[asyncpg.Connection]:
    pool: asyncpg.Pool = request.app.state.db_pool
    async with pool.acquire() as connection, connection.transaction():
        await connection.fetchval(
            "SELECT set_config('app.merchant_id', $1, true)",
            str(merchant_id),
        )
        yield connection


async def get_connection(
    request: Request,
    merchant_id: Annotated[UUID, Depends(get_merchant_id)],
) -> AsyncIterator[asyncpg.Connection]:
    async with tenant_transaction(request, merchant_id) as connection:
        yield connection


async def _run_database_check() -> None:
    pool = await _create_pool()
    try:
        await check_database_connectivity(pool)
    finally:
        await pool.close()


def main() -> None:
    try:
        asyncio.run(_run_database_check())
    except DatabaseConnectionError as error:
        raise SystemExit(str(error)) from None
    print("Database connectivity check succeeded (SELECT 1).")


if __name__ == "__main__":
    main()
