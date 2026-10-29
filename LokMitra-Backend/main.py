import ipaddress
import logging
import os
import uuid
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from limits import RateLimitItemPerMinute
from limits.errors import StorageError
from slowapi import Limiter
from slowapi.util import get_remote_address
from starlette.responses import JSONResponse

from auth import TokenVerificationError, decode_token
from config import get_settings
from database import lifespan as database_lifespan
from routers import speech

logger = logging.getLogger("lokmitra")
_REQUEST_ID_HEADER = b"x-request-id"
_SECURITY_HEADERS = (
    (b"strict-transport-security", b"max-age=31536000; includeSubDomains"),
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (
        b"content-security-policy",
        b"default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    ),
    (b"referrer-policy", b"no-referrer"),
)


def _trusted_proxy_networks() -> tuple[
    ipaddress.IPv4Network | ipaddress.IPv6Network, ...
]:
    configured = os.environ.get("TRUSTED_PROXY_IPS", "").strip()
    if not configured:
        return ()
    networks: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for item in configured.split(","):
        value = item.strip()
        if value:
            networks.append(ipaddress.ip_network(value, strict=False))
    return tuple(networks)


def _is_trusted_proxy(
    address: ipaddress.IPv4Address | ipaddress.IPv6Address,
    networks: tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, ...],
) -> bool:
    return any(
        address.version == network.version and address in network
        for network in networks
    )


def _effective_client(scope: dict[str, Any], networks: tuple[Any, ...]) -> str:
    client = scope.get("client")
    peer_text = client[0] if client else ""
    try:
        peer = ipaddress.ip_address(peer_text)
    except ValueError:
        return peer_text or "unknown"
    if not _is_trusted_proxy(peer, networks):
        return str(peer)

    forwarded_value = next(
        (
            value.decode("latin-1")
            for name, value in scope.get("headers", [])
            if name.lower() == b"x-forwarded-for"
        ),
        "",
    )
    forwarded: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    for entry in forwarded_value.split(","):
        try:
            forwarded.append(ipaddress.ip_address(entry.strip()))
        except ValueError:
            continue
    for address in reversed([*forwarded, peer]):
        if not _is_trusted_proxy(address, networks):
            return str(address)
    return str(forwarded[0]) if forwarded else str(peer)


async def _merchant_id_for_rate_limit(request: Request) -> str | None:
    merchant_id = getattr(request.state, "merchant_id", None)
    if isinstance(merchant_id, uuid.UUID):
        return str(merchant_id)
    authorization = request.headers.get("authorization", "")
    scheme, separator, token = authorization.partition(" ")
    if not separator or scheme.lower() != "bearer" or not token:
        return None
    try:
        claims = await decode_token(token)
    except TokenVerificationError:
        return None
    subject = claims.get("sub")
    return str(uuid.UUID(subject)) if isinstance(subject, str) else None


class RequestSecurityMiddleware:
    def __init__(
        self,
        app: Callable[..., Awaitable[None]],
        *,
        max_body_bytes: int,
        limiter: Limiter,
        trusted_networks: tuple[Any, ...],
    ) -> None:
        self.app = app
        self.max_body_bytes = max_body_bytes
        self.limiter = limiter
        self.trusted_networks = trusted_networks

    async def __call__(
        self,
        scope: dict[str, Any],
        receive: Callable[..., Awaitable[Any]],
        send: Callable[..., Awaitable[None]],
    ) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = list(scope.get("headers", []))
        request_id = str(uuid.uuid4())
        scope["headers"] = [
            (name, value)
            for name, value in headers
            if name.lower() != _REQUEST_ID_HEADER
        ]
        scope["headers"].append((_REQUEST_ID_HEADER, request_id.encode("ascii")))
        scope.setdefault("state", {})["request_id"] = request_id

        client_ip = _effective_client(scope, self.trusted_networks)
        scope["client"] = (client_ip, scope.get("client", (client_ip, 0))[1])

        path = scope.get("path", "")
        is_write_route = scope.get("method") == "POST" and path in {
            "/api/asr",
            "/api/tts",
            "/api/translate",
        }
        if is_write_route:
            request = Request(scope)
            authorization = request.headers.get("authorization", "")
            scheme, separator, token = authorization.partition(" ")
            if not separator or scheme.lower() != "bearer" or not token:
                await self._send_error(
                    send,
                    401,
                    "Unauthorized",
                    request_id,
                    extra_headers=[(b"www-authenticate", b"Bearer")],
                )
                return
            try:
                claims = await decode_token(token)
            except TokenVerificationError:
                await self._send_error(
                    send,
                    401,
                    "Unauthorized",
                    request_id,
                    extra_headers=[(b"www-authenticate", b"Bearer")],
                )
                return
            scope["state"]["merchant_id"] = uuid.UUID(str(claims["sub"]))

        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            if message["type"] != "http.request":
                continue
            body.extend(message.get("body", b""))
            if len(body) > self.max_body_bytes:
                await self._send_error(send, 413, "Request body too large.", request_id)
                return
            if not message.get("more_body", False):
                break

        route_limit: int | None = None
        if path in {"/api/asr", "/api/tts", "/api/translate"}:
            route_limit = 10
            rate_group = "speech"
        else:
            rate_group = ""
        if route_limit is not None:
            from starlette.requests import Request as StarletteRequest

            request = StarletteRequest(scope)
            ip_key = f"ip:{get_remote_address(request)}"
            merchant_key_value = await _merchant_id_for_rate_limit(request)
            keys = [ip_key]
            if merchant_key_value is not None:
                keys.append(f"merchant:{merchant_key_value}")
            try:
                accepted = all(
                    self.limiter.limiter.hit(
                        RateLimitItemPerMinute(route_limit),
                        f"{rate_group}:{key}",
                    )
                    for key in keys
                )
            except StorageError:
                logger.error(
                    "rate_limit_backend_error", extra={"request_id": request_id}
                )
                await self._send_error(
                    send, 503, "Service temporarily unavailable.", request_id
                )
                return
            if not accepted:
                await self._send_error(
                    send,
                    429,
                    "Rate limit exceeded.",
                    request_id,
                    extra_headers=[(b"retry-after", b"60")],
                )
                return

        body_sent = False

        async def replay_receive() -> dict[str, Any]:
            nonlocal body_sent
            if not body_sent:
                body_sent = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            return {"type": "http.disconnect"}

        async def secure_send(message: dict[str, Any]) -> None:
            if message["type"] == "http.response.start":
                response_headers = list(message.get("headers", []))
                response_headers = [
                    (name, value)
                    for name, value in response_headers
                    if name.lower() not in {header for header, _ in _SECURITY_HEADERS}
                    and name.lower() != _REQUEST_ID_HEADER
                ]
                response_headers.extend(_SECURITY_HEADERS)
                response_headers.append(
                    (_REQUEST_ID_HEADER, request_id.encode("ascii"))
                )
                message["headers"] = response_headers
            await send(message)

        await self.app(scope, replay_receive, secure_send)

    @staticmethod
    async def _send_error(
        send: Callable[..., Awaitable[None]],
        status_code: int,
        detail: str,
        request_id: str,
        extra_headers: list[tuple[bytes, bytes]] | None = None,
    ) -> None:
        response = JSONResponse(
            status_code=status_code,
            content={"detail": detail},
            headers={"X-Request-ID": request_id},
        )
        raw_headers = list(response.raw_headers)
        raw_headers = [
            (name, value)
            for name, value in raw_headers
            if name.lower() not in {header for header, _ in _SECURITY_HEADERS}
        ]
        raw_headers.extend(_SECURITY_HEADERS)
        if extra_headers:
            raw_headers.extend(extra_headers)
        await send(
            {
                "type": "http.response.start",
                "status": response.status_code,
                "headers": raw_headers,
            }
        )
        await send({"type": "http.response.body", "body": response.body})


def create_app() -> FastAPI:
    settings = get_settings()
    origins = settings.cors_origins
    if not origins or "*" in origins:
        raise ValueError("CORS_ORIGINS must be a non-empty allowlist")
    trusted_networks = _trusted_proxy_networks()
    limiter = Limiter(
        key_func=get_remote_address,
        storage_uri=os.environ.get("RATELIMIT_STORAGE_URI", "memory://"),
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.limiter = limiter
        async with database_lifespan(app):
            yield

    application = FastAPI(
        title="LokMitra API",
        version="1.0.0",
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url=None,
        openapi_url="/openapi.json",
    )
    application.state.limiter = limiter
    application.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=False,
        allow_methods=["GET", "POST"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "X-Request-ID",
        ],
        expose_headers=["X-Request-ID", "Retry-After"],
    )
    application.add_middleware(
        RequestSecurityMiddleware,
        max_body_bytes=settings.MAX_BODY_BYTES,
        limiter=limiter,
        trusted_networks=trusted_networks,
    )

    @application.exception_handler(HTTPException)
    async def http_error_handler(request: Request, exc: HTTPException) -> JSONResponse:
        messages = {
            401: "Unauthorized",
            403: "Forbidden.",
            404: "Not found.",
            413: "Request body too large.",
            415: "Unsupported media type.",
            422: "Invalid request.",
            429: "Rate limit exceeded.",
        }
        return JSONResponse(
            status_code=exc.status_code,
            content={"detail": messages.get(exc.status_code, "Request failed.")},
            headers=exc.headers,
        )

    @application.exception_handler(RequestValidationError)
    async def validation_error_handler(
        request: Request, exc: RequestValidationError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=422,
            content={"detail": "Invalid request."},
        )

    @application.exception_handler(Exception)
    async def unexpected_error_handler(
        request: Request, exc: Exception
    ) -> JSONResponse:
        request_id = getattr(request.state, "request_id", "unknown")
        logger.error("unhandled_request_error", extra={"request_id": request_id})
        return JSONResponse(
            status_code=500,
            content={"detail": "Internal server error."},
        )

    @application.get("/healthz", include_in_schema=False)
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    application.include_router(speech.router)
    return application


app = create_app()
