"""OAuth 2.0 (authorization code + PKCE) for Google and Microsoft mailboxes.

The owner registers their own OAuth client with the provider; NEXUS stores its
id/secret and the resulting tokens encrypted. Nothing here is shared or built in.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
import time
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx

from app.email.providers import OAUTH, OAuthProvider

STATE_TTL = 600.0  # seconds the owner has to finish signing in
REFRESH_MARGIN = 120  # refresh access tokens this many seconds before they expire


class OAuthError(Exception):
    pass


@dataclass
class Pending:
    account_id: str
    provider: str
    verifier: str
    redirect_uri: str
    expires: float


@dataclass
class Tokens:
    access_token: str
    refresh_token: str | None
    expires_at: float

    def dump(self) -> dict[str, object]:
        return {
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "expires_at": self.expires_at,
        }

    @classmethod
    def load(cls, data: dict[str, object]) -> Tokens:
        expires = data.get("expires_at")
        return cls(
            str(data.get("access_token") or ""),
            str(data["refresh_token"]) if data.get("refresh_token") else None,
            float(expires) if isinstance(expires, int | float) else 0.0,
        )

    def fresh(self) -> bool:
        return bool(self.access_token) and self.expires_at - REFRESH_MARGIN > time.time()


def _challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


class OAuthFlows:
    """Keeps sign-ins in progress (in memory: a restart just means signing in again)."""

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.transport = transport
        self._pending: dict[str, Pending] = {}

    def _provider(self, key: str) -> OAuthProvider:
        provider = OAUTH.get(key)
        if provider is None:
            raise OAuthError(f"OAuth is not supported for '{key}'.")
        return provider

    def start(
        self, account_id: str, provider_key: str, client_id: str, redirect_uri: str, login_hint: str
    ) -> str:
        provider = self._provider(provider_key)
        now = time.monotonic()
        self._pending = {k: p for k, p in self._pending.items() if p.expires > now}
        state = secrets.token_urlsafe(24)
        verifier = secrets.token_urlsafe(64)
        self._pending[state] = Pending(
            account_id, provider_key, verifier, redirect_uri, now + STATE_TTL
        )
        params = {
            "client_id": client_id,
            "response_type": "code",
            "redirect_uri": redirect_uri,
            "scope": " ".join(provider.scopes),
            "state": state,
            "code_challenge": _challenge(verifier),
            "code_challenge_method": "S256",
            "login_hint": login_hint,
        }
        if provider_key == "google":
            params |= {"access_type": "offline", "prompt": "consent"}
        return f"{provider.authorize_url}?{urlencode(params)}"

    def take(self, state: str) -> Pending:
        pending = self._pending.pop(state, None)
        if pending is None or pending.expires < time.monotonic():
            raise OAuthError("This sign-in link has expired or was already used. Start again.")
        return pending

    async def _token_request(self, provider: OAuthProvider, data: dict[str, str]) -> Tokens:
        async with httpx.AsyncClient(transport=self.transport, timeout=20) as client:
            try:
                response = await client.post(provider.token_url, data=data)
            except httpx.HTTPError as error:
                raise OAuthError(f"Could not reach the sign-in server: {error}") from error
        try:
            payload = response.json()
        except ValueError:
            payload = {}
        if response.status_code != 200 or "access_token" not in payload:
            reason = (
                payload.get("error_description") or payload.get("error") or response.reason_phrase
            )
            raise OAuthError(f"The provider refused the sign-in ({response.status_code}): {reason}")
        return Tokens(
            str(payload["access_token"]),
            payload.get("refresh_token"),
            time.time() + float(payload.get("expires_in") or 3600),
        )

    async def exchange(
        self, pending: Pending, code: str, client_id: str, client_secret: str | None
    ) -> Tokens:
        provider = self._provider(pending.provider)
        data = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": pending.redirect_uri,
            "client_id": client_id,
            "code_verifier": pending.verifier,
        }
        if client_secret:
            data["client_secret"] = client_secret
        tokens = await self._token_request(provider, data)
        if not tokens.refresh_token:
            raise OAuthError(
                "The provider did not return a refresh token, so the connection would stop "
                "working within an hour. Remove NEXUS from your account's connected apps and "
                "sign in again."
            )
        return tokens

    async def refresh(
        self, provider_key: str, tokens: Tokens, client_id: str, client_secret: str | None
    ) -> Tokens:
        provider = self._provider(provider_key)
        if not tokens.refresh_token:
            raise OAuthError("The sign-in has no refresh token; connect the account again.")
        data = {
            "grant_type": "refresh_token",
            "refresh_token": tokens.refresh_token,
            "client_id": client_id,
        }
        if client_secret:
            data["client_secret"] = client_secret
        fresh = await self._token_request(provider, data)
        # Providers may or may not rotate the refresh token.
        return Tokens(
            fresh.access_token, fresh.refresh_token or tokens.refresh_token, fresh.expires_at
        )

    async def revoke(self, provider_key: str, tokens: Tokens) -> bool:
        """Best effort: tells the provider to forget the grant (Google only)."""
        provider = self._provider(provider_key)
        token = tokens.refresh_token or tokens.access_token
        if not provider.revoke_url or not token:
            return False
        try:
            async with httpx.AsyncClient(transport=self.transport, timeout=10) as client:
                response = await client.post(provider.revoke_url, data={"token": token})
            return response.status_code == 200
        except httpx.HTTPError:
            return False
