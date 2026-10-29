import asyncpg
import pytest

import config
from database import (
    DatabaseConnectionError,
    _create_pool,
    check_database_connectivity,
)

_CONNECTION_SECRET = (
    "postgresql://lokmitra_pool:never-log-this@database.example/lokmitra"
)


class _FakeConnection:
    def __init__(self, result: object = 1, error: Exception | None = None) -> None:
        self.result = result
        self.error = error

    async def fetchval(self, query: str) -> object:
        assert query == "SELECT 1"
        if self.error is not None:
            raise self.error
        return self.result


class _FakeAcquire:
    def __init__(self, connection: _FakeConnection) -> None:
        self.connection = connection

    async def __aenter__(self) -> _FakeConnection:
        return self.connection

    async def __aexit__(self, exc_type, exc, traceback) -> bool:
        return False


class _FakePool:
    def __init__(self, connection: _FakeConnection) -> None:
        self.connection = connection

    def acquire(self) -> _FakeAcquire:
        return _FakeAcquire(self.connection)


@pytest.mark.asyncio
async def test_database_connectivity_check_runs_select_one() -> None:
    await check_database_connectivity(_FakePool(_FakeConnection()))


@pytest.mark.asyncio
async def test_database_connectivity_failure_is_sanitized() -> None:
    pool = _FakePool(_FakeConnection(error=OSError(_CONNECTION_SECRET)))

    with pytest.raises(DatabaseConnectionError) as error:
        await check_database_connectivity(pool)

    assert "never-log-this" not in str(error.value)
    assert "postgresql://" not in str(error.value)


@pytest.mark.asyncio
async def test_database_connectivity_rejects_unexpected_query_result() -> None:
    pool = _FakePool(_FakeConnection(result=0))

    with pytest.raises(DatabaseConnectionError, match="unexpected result"):
        await check_database_connectivity(pool)


@pytest.mark.asyncio
async def test_pool_creation_failure_is_sanitized(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config.get_settings.cache_clear()

    async def fail_to_create_pool(**kwargs):
        raise asyncpg.PostgresConnectionError(_CONNECTION_SECRET)

    monkeypatch.setattr(asyncpg, "create_pool", fail_to_create_pool)

    with pytest.raises(DatabaseConnectionError) as error:
        await _create_pool()

    assert "never-log-this" not in str(error.value)
    assert "postgresql://" not in str(error.value)
