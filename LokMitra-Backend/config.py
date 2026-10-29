from functools import lru_cache
from urllib.parse import unquote, urlsplit

from pydantic import SecretStr, ValidationInfo, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_PLACEHOLDER_SECRET_MARKERS = (
    "replace-with-",
    "your_project",
    "your-project",
    "placeholder",
    "change-me",
    "changeme",
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    DATABASE_URL: SecretStr
    SUPABASE_JWT_SECRET: SecretStr | None = None
    SUPABASE_JWKS_URL: str | None = None
    SARVAM_API_KEY: SecretStr | None = None
    SARVAM_TRANSLATE_URL: str = "https://api.sarvam.ai/translate"
    LOCAL_STT_URL: str = "http://127.0.0.1:8091"
    LOCAL_STT_API_KEY: SecretStr | None = None
    LOCAL_TTS_URL: str = "http://127.0.0.1:8092"
    LOCAL_TTS_API_KEY: SecretStr | None = None

    SUPABASE_JWT_AUDIENCE: str = "authenticated"
    SUPABASE_JWT_ISSUER: str
    CORS_ORIGINS: str = "http://localhost:5173"
    DAILY_SPEECH_BUDGET: int = 100
    MAX_BODY_BYTES: int = 2_000_000

    @field_validator(
        "DATABASE_URL",
    )
    @classmethod
    def require_nonempty_secret(cls, value: SecretStr) -> SecretStr:
        secret = value.get_secret_value().strip()
        if not secret:
            raise ValueError("Secret settings must not be empty")
        if any(marker in secret.lower() for marker in _PLACEHOLDER_SECRET_MARKERS):
            raise ValueError("Secret settings must not use placeholder values")
        return value

    @field_validator("DATABASE_URL")
    @classmethod
    def require_restricted_database_role(cls, value: SecretStr) -> SecretStr:
        uri = value.get_secret_value().strip()
        try:
            parsed = urlsplit(uri)
            username = unquote(parsed.username or "")
            valid_port = parsed.port is not None and 1 <= parsed.port <= 65535
        except ValueError as error:
            raise ValueError(
                "DATABASE_URL must be a valid PostgreSQL connection URI"
            ) from error

        if (
            parsed.scheme not in {"postgres", "postgresql"}
            or not parsed.hostname
            or not parsed.path.strip("/")
            or not parsed.password
            or not valid_port
        ):
            raise ValueError(
                "DATABASE_URL must be a complete PostgreSQL connection URI"
            )
        if username != "lokmitra_pool" and not (
            username.startswith("lokmitra_pool.")
            and len(username) > len("lokmitra_pool.")
        ):
            raise ValueError(
                "DATABASE_URL must use the restricted lokmitra_pool login role"
            )
        return value

    @field_validator(
        "SARVAM_API_KEY",
        "LOCAL_STT_API_KEY",
        "LOCAL_TTS_API_KEY",
        mode="before",
    )
    @classmethod
    def normalize_optional_provider_key(
        cls, value: SecretStr | str | None
    ) -> SecretStr | str | None:
        if value is None or (isinstance(value, str) and not value.strip()):
            return None
        return value

    @field_validator("SARVAM_API_KEY", "LOCAL_STT_API_KEY", "LOCAL_TTS_API_KEY")
    @classmethod
    def validate_optional_provider_key(
        cls, value: SecretStr | None
    ) -> SecretStr | None:
        if value is not None and any(
            marker in value.get_secret_value().lower()
            for marker in _PLACEHOLDER_SECRET_MARKERS
        ):
            raise ValueError("Provider API keys must not use placeholder values")
        return value

    @field_validator("LOCAL_STT_URL", "LOCAL_TTS_URL", mode="before")
    @classmethod
    def normalize_local_speech_url(cls, value: str | None, info: ValidationInfo) -> str:
        if value is None or not value.strip():
            return (
                "http://127.0.0.1:8091"
                if info.field_name == "LOCAL_STT_URL"
                else "http://127.0.0.1:8092"
            )
        return value.strip().rstrip("/")

    @field_validator("LOCAL_STT_URL", "LOCAL_TTS_URL")
    @classmethod
    def validate_local_speech_url(cls, value: str) -> str:
        parsed = urlsplit(value)
        local_http = parsed.scheme == "http" and parsed.hostname in {
            "localhost",
            "127.0.0.1",
            "::1",
        }
        if parsed.scheme != "https" and not local_http:
            raise ValueError("Local speech service URLs must use HTTPS except for localhost.")
        if not parsed.hostname:
            raise ValueError("Local speech service URLs must include a host.")
        return value

    @field_validator("SARVAM_TRANSLATE_URL", mode="before")
    @classmethod
    def normalize_sarvam_translate_url(cls, value: str | None) -> str:
        if value is None or not value.strip():
            return "https://api.sarvam.ai/translate"
        return value.strip().rstrip("/")

    @field_validator("SUPABASE_JWT_SECRET", mode="before")
    @classmethod
    def normalize_optional_jwt_secret(
        cls, value: SecretStr | str | None
    ) -> SecretStr | str | None:
        if value is None or (isinstance(value, str) and not value.strip()):
            return None
        return value

    @field_validator("SUPABASE_JWT_SECRET")
    @classmethod
    def validate_optional_jwt_secret(cls, value: SecretStr | None) -> SecretStr | None:
        if value is None:
            return None
        secret = value.get_secret_value().strip()
        if not secret:
            raise ValueError("SUPABASE_JWT_SECRET must not be empty")
        if any(marker in secret.lower() for marker in _PLACEHOLDER_SECRET_MARKERS):
            raise ValueError("SUPABASE_JWT_SECRET must not use placeholder values")
        return value

    @field_validator("SUPABASE_JWKS_URL", mode="before")
    @classmethod
    def normalize_optional_jwks_url(cls, value: str | None) -> str | None:
        if value is None or not value.strip():
            return None
        return value.strip()

    @field_validator("SUPABASE_JWT_AUDIENCE", "SUPABASE_JWT_ISSUER")
    @classmethod
    def require_nonempty_jwt_setting(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("JWT audience and issuer must not be empty")
        return value

    @field_validator("CORS_ORIGINS")
    @classmethod
    def validate_cors_origins(cls, value: str) -> str:
        origins = [origin.strip() for origin in value.split(",") if origin.strip()]
        if not origins or "*" in origins:
            raise ValueError("CORS_ORIGINS must be a non-empty allowlist")
        return ",".join(origins)

    @field_validator("DAILY_SPEECH_BUDGET", "MAX_BODY_BYTES")
    @classmethod
    def require_positive_limits(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("Configured limits must be positive")
        return value

    @model_validator(mode="after")
    def validate_jwt_issuer(self) -> "Settings":
        issuer = self.SUPABASE_JWT_ISSUER
        if not issuer.startswith("https://"):
            raise ValueError("SUPABASE_JWT_ISSUER must use HTTPS")
        if any(marker in issuer.lower() for marker in _PLACEHOLDER_SECRET_MARKERS):
            raise ValueError("SUPABASE_JWT_ISSUER must not use placeholder values")
        if self.SUPABASE_JWKS_URL and not self.SUPABASE_JWKS_URL.startswith("https://"):
            raise ValueError("SUPABASE_JWKS_URL must use HTTPS")
        if self.SUPABASE_JWKS_URL and any(
            marker in self.SUPABASE_JWKS_URL.lower()
            for marker in _PLACEHOLDER_SECRET_MARKERS
        ):
            raise ValueError("SUPABASE_JWKS_URL must not use placeholder values")
        parsed_sarvam_url = urlsplit(self.SARVAM_TRANSLATE_URL)
        if parsed_sarvam_url.scheme != "https" or not parsed_sarvam_url.hostname:
            raise ValueError("SARVAM_TRANSLATE_URL must use HTTPS")
        if self.SUPABASE_JWT_SECRET is None and not self.SUPABASE_JWKS_URL:
            raise ValueError("Configure SUPABASE_JWT_SECRET or SUPABASE_JWKS_URL")
        return self

    @property
    def cors_origins(self) -> list[str]:
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",")]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
