import asyncio
import time
from collections.abc import Mapping
from typing import Annotated
from uuid import UUID

import httpx
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from config import get_settings

_bearer_scheme = HTTPBearer(auto_error=False)
_ALLOWED_ALGORITHMS = {"HS256", "ES256", "RS256"}
_JWKS_CACHE_TTL_SECONDS = 300
_JWKS_FETCH_TIMEOUT_SECONDS = 2.0
_jwks_cache: dict[str, tuple[float, list[dict[str, object]]]] = {}
_jwks_lock = asyncio.Lock()


class TokenVerificationError(Exception):
    pass


def _unauthorized() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Unauthorized",
        headers={"WWW-Authenticate": "Bearer"},
    )


async def _jwks_keys(url: str, *, refresh: bool = False) -> list[dict[str, object]]:
    async with _jwks_lock:
        cached = _jwks_cache.get(url)
        if not refresh and cached is not None and cached[0] > time.monotonic():
            return cached[1]
        try:
            timeout = httpx.Timeout(
                _JWKS_FETCH_TIMEOUT_SECONDS,
                connect=_JWKS_FETCH_TIMEOUT_SECONDS,
            )
            async with httpx.AsyncClient(timeout=timeout) as client:
                response = await client.get(url)
                response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as error:
            raise TokenVerificationError("JWKS unavailable") from error
        if not isinstance(payload, Mapping) or not isinstance(
            payload.get("keys"), list
        ):
            raise TokenVerificationError("Invalid JWKS response")
        keys = payload["keys"]
        if not all(isinstance(item, dict) for item in keys):
            raise TokenVerificationError("Invalid JWKS key")
        _jwks_cache[url] = (time.monotonic() + _JWKS_CACHE_TTL_SECONDS, keys)
        return keys


async def _signing_key(token: str, algorithm: str) -> object:
    settings = get_settings()
    if algorithm == "HS256":
        if settings.SUPABASE_JWT_SECRET is None:
            raise TokenVerificationError("HS256 is not configured")
        return settings.SUPABASE_JWT_SECRET.get_secret_value()
    if settings.SUPABASE_JWKS_URL is None:
        raise TokenVerificationError("JWKS is not configured")
    header = jwt.get_unverified_header(token)
    key_id = header.get("kid")
    if not isinstance(key_id, str) or not key_id:
        raise TokenVerificationError("Missing signing key id")

    def find_key(keys: list[dict[str, object]]) -> dict[str, object] | None:
        return next(
            (
                item
                for item in keys
                if item.get("kid") == key_id
                and item.get("use", "sig") == "sig"
                and item.get("alg", algorithm) == algorithm
            ),
            None,
        )

    match = find_key(await _jwks_keys(settings.SUPABASE_JWKS_URL))
    if match is None:
        match = find_key(await _jwks_keys(settings.SUPABASE_JWKS_URL, refresh=True))
    if match is None:
        raise TokenVerificationError("Signing key was not found")
    try:
        return jwt.PyJWK.from_dict(match, algorithm=algorithm).key
    except (jwt.PyJWTError, TypeError, ValueError) as error:
        raise TokenVerificationError("Invalid signing key") from error


async def decode_token(token: str) -> dict[str, object]:
    try:
        header = jwt.get_unverified_header(token)
        algorithm = header.get("alg")
        if not isinstance(algorithm, str) or algorithm not in _ALLOWED_ALGORITHMS:
            raise jwt.InvalidAlgorithmError("Unsupported algorithm")
        key = await _signing_key(token, algorithm)
        claims = jwt.decode(
            token,
            key,
            algorithms=[algorithm],
            audience=get_settings().SUPABASE_JWT_AUDIENCE,
            issuer=get_settings().SUPABASE_JWT_ISSUER,
            options={"require": ["exp", "aud", "iss", "sub"]},
        )
    except (jwt.PyJWTError, TokenVerificationError) as error:
        raise TokenVerificationError("Invalid token") from error
    if not isinstance(claims, dict) or not isinstance(claims.get("sub"), str):
        raise TokenVerificationError("Invalid token claims")
    if "role" in claims and claims["role"] != "authenticated":
        raise TokenVerificationError("Invalid token role")
    try:
        UUID(claims["sub"])
    except ValueError as error:
        raise TokenVerificationError("Invalid token subject") from error
    return claims


async def get_verified_claims(
    credentials: Annotated[
        HTTPAuthorizationCredentials | None, Depends(_bearer_scheme)
    ],
) -> dict[str, object]:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise _unauthorized()
    try:
        return await decode_token(credentials.credentials)
    except TokenVerificationError:
        raise _unauthorized() from None


async def get_merchant_id(
    claims: Annotated[dict[str, object], Depends(get_verified_claims)],
) -> UUID:
    subject = claims.get("sub")
    if not isinstance(subject, str):
        raise _unauthorized()
    try:
        return UUID(subject)
    except ValueError:
        raise _unauthorized() from None
