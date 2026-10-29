import pytest
from pydantic import ValidationError

from config import Settings

_ISSUER = "https://test.supabase.co/auth/v1"
_SECRET = "lokmitra-test-secret-key-at-least-32-bytes"
_VALID_SETTINGS = {
    "DATABASE_URL": (
        "postgresql://lokmitra_pool:test-only-password@localhost:5432/lokmitra_test"
    ),
    "SUPABASE_JWT_SECRET": _SECRET,
    "SUPABASE_JWT_ISSUER": _ISSUER,
}


@pytest.mark.parametrize(
    "setting",
    ["DATABASE_URL"],
)
def test_missing_required_credentials_are_rejected(
    setting: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(setting, raising=False)
    values = _VALID_SETTINGS.copy()
    values.pop(setting)

    with pytest.raises(ValidationError):
        Settings(_env_file=None, **values)


@pytest.mark.parametrize(
    ("setting", "placeholder"),
    [
        ("DATABASE_URL", "postgresql://replace-with-role-password@localhost:5432/db"),
    ],
)
def test_placeholder_required_credentials_are_rejected(
    setting: str, placeholder: str
) -> None:
    values = _VALID_SETTINGS.copy()
    values[setting] = placeholder

    with pytest.raises(ValidationError, match="placeholder|configured"):
        Settings(_env_file=None, **values)


@pytest.mark.parametrize(
    "username",
    ["postgres", "postgres.test-project", "service_role"],
)
def test_database_uri_rejects_non_pool_roles(username: str) -> None:
    values = _VALID_SETTINGS.copy()
    values["DATABASE_URL"] = (
        f"postgresql://{username}:test-only-password@localhost:5432/lokmitra_test"
    )

    with pytest.raises(ValidationError, match="lokmitra_pool"):
        Settings(_env_file=None, **values)


@pytest.mark.parametrize("username", ["lokmitra_pool", "lokmitra_pool.test-project"])
def test_database_uri_accepts_restricted_pool_role(username: str) -> None:
    values = _VALID_SETTINGS.copy()
    values["DATABASE_URL"] = (
        f"postgresql://{username}:test-only-password@localhost:5432/lokmitra_test"
    )

    assert (
        Settings(_env_file=None, **values).DATABASE_URL.get_secret_value()
        == values["DATABASE_URL"]
    )


def test_database_uri_requires_dashboard_port() -> None:
    values = _VALID_SETTINGS.copy()
    values["DATABASE_URL"] = (
        "postgresql://lokmitra_pool:test-only-password@localhost/lokmitra_test"
    )

    with pytest.raises(ValidationError, match="complete PostgreSQL"):
        Settings(_env_file=None, **values)


def test_missing_jwt_verification_configuration_is_rejected() -> None:
    values = _VALID_SETTINGS.copy()
    values["SUPABASE_JWT_SECRET"] = ""

    with pytest.raises(ValidationError, match="Configure SUPABASE_JWT_SECRET"):
        Settings(_env_file=None, **values)


def test_jwks_only_configuration_is_accepted() -> None:
    values = _VALID_SETTINGS.copy()
    values["SUPABASE_JWT_SECRET"] = ""
    values["SUPABASE_JWKS_URL"] = (
        "https://test.supabase.co/auth/v1/.well-known/jwks.json"
    )

    settings = Settings(_env_file=None, **values)

    assert settings.SUPABASE_JWT_SECRET is None
    assert settings.SUPABASE_JWKS_URL == (
        "https://test.supabase.co/auth/v1/.well-known/jwks.json"
    )


@pytest.mark.parametrize(
    ("setting", "placeholder"),
    [
        ("SUPABASE_JWT_SECRET", "replace-with-jwt-secret"),
        ("SUPABASE_JWKS_URL", "https://replace-with-project-ref.example/jwks.json"),
    ],
)
def test_placeholder_jwt_verification_settings_are_rejected(
    setting: str, placeholder: str
) -> None:
    values = _VALID_SETTINGS.copy()
    values[setting] = placeholder

    with pytest.raises(ValidationError, match="placeholder"):
        Settings(_env_file=None, **values)


def test_sarvam_translation_key_is_optional() -> None:
    settings = Settings(_env_file=None, SARVAM_API_KEY="", **_VALID_SETTINGS)
    assert settings.SARVAM_API_KEY is None


def test_sarvam_translation_url_requires_https() -> None:
    with pytest.raises(ValidationError, match="SARVAM_TRANSLATE_URL must use HTTPS"):
        Settings(
            _env_file=None,
            SARVAM_TRANSLATE_URL="http://api.sarvam.ai/translate",
            **_VALID_SETTINGS,
        )
