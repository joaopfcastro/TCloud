# TCloud — Authentication Module
# JWT-based authentication for API access (mobile apps, remote access).

from __future__ import annotations

import json
import logging
import secrets
import time
from functools import wraps

import jwt
from aiohttp import web

logger = logging.getLogger("tcloud.auth")


def create_token(username: str, secret: str, expiry_hours: int = 72) -> str:
    """Create a JWT token for the given username."""
    payload = {
        "sub": username,
        "iat": int(time.time()),
        "exp": int(time.time()) + (expiry_hours * 3600),
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def create_app_runtime_token(
    *,
    app_id: str,
    install_id: str,
    secret: str,
    allowed_functions: list[str],
    granted_permissions: list[str],
    user: str = "",
    expiry_seconds: int = 900,
) -> str:
    now = int(time.time())
    payload = {
        "kind": "app_runtime",
        "app_id": app_id,
        "install_id": install_id,
        "functions": list(allowed_functions),
        "permissions": list(granted_permissions),
        "sub": user or "anonymous",
        "iat": now,
        "exp": now + max(60, int(expiry_seconds)),
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def create_public_share_token(
    *,
    public_id: str,
    path: str,
    is_directory: bool,
    secret: str,
    expiry_seconds: int = 1800,
) -> str:
    now = int(time.time())
    payload = {
        "kind": "public_share",
        "public_id": str(public_id or "").strip(),
        "path": str(path or "").strip(),
        "is_directory": bool(is_directory),
        "sub": "public-share",
        "iat": now,
        "exp": now + max(60, int(expiry_seconds)),
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def verify_token(token: str, secret: str) -> dict | None:
    """Verify and decode a JWT token. Returns payload or None."""
    try:
        return jwt.decode(token, secret, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        logger.debug("Token expired")
        return None
    except jwt.InvalidTokenError as e:
        logger.debug(f"Invalid token: {e}")
        return None


def verify_app_runtime_token(token: str, secret: str) -> dict | None:
    payload = verify_token(token, secret)
    if not payload or payload.get("kind") != "app_runtime":
        return None
    return payload


def verify_public_share_token(token: str, secret: str, *, allow_expired: bool = False) -> dict | None:
    if allow_expired:
        try:
            payload = jwt.decode(
                token,
                secret,
                algorithms=["HS256"],
                options={"verify_exp": False},
            )
        except jwt.InvalidTokenError as e:
            logger.debug(f"Invalid public share token: {e}")
            return None
    else:
        payload = verify_token(token, secret)
    if not payload or payload.get("kind") != "public_share":
        return None
    return payload


# Routes that don't require authentication
PUBLIC_ROUTES = {
    "/",                    # Web UI
    "/favicon.ico",         # Site icon
    "/apple-touch-icon.png",# iOS home screen icon
    "/site.webmanifest",    # PWA manifest
    "/api/auth/login",      # Login endpoint
    "/api/apps",            # App listing (metadata only, not sensitive)
    "/api/apps/runtime/execute",  # Scoped runtime calls for apps
    "/api/apps/runtime/file",  # Scoped runtime file streaming for apps
}

# Prefixes that don't require authentication
PUBLIC_PREFIXES = (
    "/apps/",               # App static files (served in iframe)
    "/static/",             # Static site assets
    "/s/",                  # Public share pages
    "/api/shared_item/",    # Public share APIs
    "/stream/shared/",      # Public share streaming
)


@web.middleware
async def auth_middleware(request: web.Request, handler):
    """Middleware that validates JWT tokens on protected routes."""
    from config import Config

    # Skip if auth is disabled
    if not Config.AUTH_ENABLED:
        return await handler(request)

    path = request.path

    # Allow public routes
    if path in PUBLIC_ROUTES:
        return await handler(request)

    # Allow public prefixes
    for prefix in PUBLIC_PREFIXES:
        if path.startswith(prefix):
            return await handler(request)

    # Extract token from Authorization header or query param
    token = None
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        token = auth_header[7:]
    else:
        # Fallback: check query parameter (useful for stream URLs in <video> tags)
        token = request.query.get("token")

    if not token:
        return web.json_response(
            {"error": "Autenticação necessária", "code": "AUTH_REQUIRED"},
            status=401,
        )

    payload = verify_token(token, Config.JWT_SECRET)
    if not payload:
        return web.json_response(
            {"error": "Token inválido ou expirado", "code": "AUTH_INVALID"},
            status=401,
        )

    # Attach user info to request
    request["user"] = payload.get("sub", "unknown")
    return await handler(request)


@web.middleware
async def cors_middleware(request: web.Request, handler):
    """Middleware that adds CORS headers to all responses."""
    # Handle preflight OPTIONS requests
    if request.method == "OPTIONS":
        response = web.Response(status=204)
    else:
        try:
            response = await handler(request)
        except web.HTTPException as ex:
            response = ex

    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    response.headers["Access-Control-Max-Age"] = "3600"

    return response
