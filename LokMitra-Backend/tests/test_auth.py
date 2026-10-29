import base64
import json
from datetime import UTC, datetime

import jwt
import pytest
import respx
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from fastapi.testclient import TestClient
from httpx import Response

import config
from auth import TokenVerificationError, decode_token

_SECRET = "lokmitra-test-secret-key-at-least-32-bytes"
_ISSUER = "https://test.supabase.co/auth/v1"
_JWKS_URL = "https://test.supabase.co/auth/v1/.well-known/jwks.json"


@pytest.fixture(autouse=True)
def clear_settings_cache():
    config.get_settings.cache_clear()
    yield
    config.get_settings.cache_clear()


def _claims(**overrides):
    claims = {
        "sub": "6e91b857-a07b-4e51-9937-c3e8fa85939d",
        "aud": "authenticated",
        "iss": _ISSUER,
        "exp": int(datetime.now(UTC).timestamp()) + 3600,
        "role": "authenticated",
        "phone": "+919876543210",
    }
    claims.update(overrides)
    return claims


@pytest.mark.asyncio
async def test_hs256_token_is_verified() -> None:
    signed = jwt.encode(_claims(), _SECRET, algorithm="HS256")
    assert (await decode_token(signed))["role"] == "authenticated"


@pytest.mark.asyncio
async def test_hs256_invalid_signature_is_rejected() -> None:
    signed = jwt.encode(
        _claims(), "different-test-secret-key-at-least-32-bytes", algorithm="HS256"
    )

    with pytest.raises(TokenVerificationError):
        await decode_token(signed)


@pytest.mark.parametrize(
    "claims",
    [
        _claims(exp=1),
        _claims(aud="wrong-audience"),
        _claims(iss="https://wrong.example/auth/v1"),
        _claims(role="anon"),
    ],
)
@pytest.mark.asyncio
async def test_invalid_hs256_claims_fail_closed(claims) -> None:
    signed = jwt.encode(claims, _SECRET, algorithm="HS256")
    with pytest.raises(TokenVerificationError):
        await decode_token(signed)


@pytest.mark.asyncio
async def test_none_algorithm_is_rejected() -> None:
    signed = jwt.encode(_claims(), key="", algorithm="none")
    with pytest.raises(TokenVerificationError):
        await decode_token(signed)


@pytest.mark.asyncio
async def test_es256_token_is_verified_using_mocked_jwks(monkeypatch) -> None:
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key().public_numbers()

    def encode_integer(value: int) -> str:
        raw = value.to_bytes(32, "big")
        return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")

    jwk = {
        "kty": "EC",
        "crv": "P-256",
        "x": encode_integer(public_key.x),
        "y": encode_integer(public_key.y),
        "kid": "lokmitra-test-key",
        "alg": "ES256",
        "use": "sig",
    }
    monkeypatch.setenv("SUPABASE_JWKS_URL", _JWKS_URL)
    config.get_settings.cache_clear()
    signed = jwt.encode(
        _claims(),
        private_key,
        algorithm="ES256",
        headers={"kid": "lokmitra-test-key"},
    )
    with respx.mock(assert_all_called=True) as mock:
        mock.get(_JWKS_URL).mock(Response(200, json={"keys": [jwk]}))
        assert (await decode_token(signed))["sub"] == _claims()["sub"]


@pytest.mark.asyncio
async def test_rs256_token_is_verified_using_mocked_jwks(monkeypatch) -> None:
    url = "https://test.supabase.co/auth/v1/.well-known/jwks-rs256.json"
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key()))
    jwk.update({"kid": "lokmitra-test-rsa-key", "alg": "RS256", "use": "sig"})
    monkeypatch.setenv("SUPABASE_JWKS_URL", url)
    config.get_settings.cache_clear()
    signed = jwt.encode(
        _claims(),
        private_key,
        algorithm="RS256",
        headers={"kid": "lokmitra-test-rsa-key"},
    )

    with respx.mock(assert_all_called=True) as mock:
        mock.get(url).mock(Response(200, json={"keys": [jwk]}))
        assert (await decode_token(signed))["sub"] == _claims()["sub"]


@pytest.mark.asyncio
async def test_jwks_fetch_failure_fails_closed(monkeypatch) -> None:
    url = "https://test.supabase.co/auth/v1/unavailable-jwks"
    monkeypatch.setenv("SUPABASE_JWKS_URL", url)
    config.get_settings.cache_clear()
    signed = jwt.encode(
        _claims(),
        ec.generate_private_key(ec.SECP256R1()),
        algorithm="ES256",
        headers={"kid": "missing"},
    )
    with respx.mock(assert_all_called=True) as mock:
        mock.get(url).mock(return_value=Response(503))
        with pytest.raises(TokenVerificationError):
            await decode_token(signed)


def test_unauthenticated_write_rejects_before_buffering_body(
    client: TestClient,
) -> None:
    response = client.post(
        "/api/asr",
        content=b"x" * 100_000,
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 401
