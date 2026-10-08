"""Encryption for credentials stored in the database (Fernet / AES-128-CBC + HMAC).

The key is NEXUS_SECRET_KEY from backend/.env, generated locally by `make setup`.
"""

from __future__ import annotations

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import Settings


class SecretStoreError(Exception):
    pass


def _fernet(settings: Settings) -> Fernet:
    if settings.secret_key is None:
        raise SecretStoreError(
            "NEXUS_SECRET_KEY is not set; run `make setup` before saving credentials in the app"
        )
    try:
        return Fernet(settings.secret_key.get_secret_value().encode())
    except (ValueError, TypeError) as error:
        raise SecretStoreError(
            "NEXUS_SECRET_KEY is not a valid key; regenerate it with `make setup`"
        ) from error


def encrypt(settings: Settings, plaintext: str) -> str:
    return _fernet(settings).encrypt(plaintext.encode()).decode()


def decrypt(settings: Settings, token: str) -> str:
    try:
        return _fernet(settings).decrypt(token.encode()).decode()
    except InvalidToken as error:
        raise SecretStoreError(
            "The saved API key can't be decrypted (was NEXUS_SECRET_KEY changed?)"
        ) from error
