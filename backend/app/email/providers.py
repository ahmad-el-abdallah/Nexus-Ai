"""Server presets for common providers (the owner can override everything) and the
OAuth endpoints for providers that support it. No account or address is built in."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Preset:
    key: str
    label: str
    smtp_host: str
    smtp_port: int
    smtp_security: str
    imap_host: str | None
    imap_port: int | None
    imap_security: str | None
    oauth: str | None  # "google" | "microsoft" | None
    note: str
    # The provider stores sent mail in "Sent" by itself (no IMAP APPEND needed).
    saves_sent_copy: bool = False
    # Sends through an HTTP API with an API key instead of SMTP ("brevo").
    api: str | None = None


PRESETS: dict[str, Preset] = {
    p.key: p
    for p in (
        Preset(
            "brevo",
            "Brevo (recommended for sending)",
            "api.brevo.com",
            443,
            "ssl",
            None,
            None,
            None,
            None,
            "Sends through Brevo's API (free plan: 300 emails/day). Create an API key in Brevo → "
            "SMTP & API → API keys, and add your sender address under Senders (Brevo emails you "
            "a confirmation link). Brevo has no inbox: to read mail and draft replies, also add "
            "your mailbox's IMAP settings and password (Gmail: an app password).",
            api="brevo",
        ),
        Preset(
            "gmail",
            "Gmail / Google Workspace",
            "smtp.gmail.com",
            465,
            "ssl",
            "imap.gmail.com",
            993,
            "ssl",
            "google",
            "Use an app password (Google Account → Security → App passwords; needs 2-Step "
            "Verification) or connect with OAuth using your own Google Cloud OAuth client.",
            saves_sent_copy=True,
        ),
        Preset(
            "outlook",
            "Microsoft 365 / Outlook.com",
            "smtp.office365.com",
            587,
            "starttls",
            "outlook.office365.com",
            993,
            "ssl",
            "microsoft",
            "Microsoft is retiring password sign-in for SMTP/IMAP: connect with OAuth using "
            "your own Azure app registration. SMTP AUTH must be enabled for the mailbox.",
            saves_sent_copy=True,
        ),
        Preset(
            "yahoo",
            "Yahoo Mail",
            "smtp.mail.yahoo.com",
            465,
            "ssl",
            "imap.mail.yahoo.com",
            993,
            "ssl",
            None,
            "Use an app password (Yahoo Account Security → Generate app password).",
        ),
        Preset(
            "icloud",
            "iCloud Mail",
            "smtp.mail.me.com",
            587,
            "starttls",
            "imap.mail.me.com",
            993,
            "ssl",
            None,
            "Use an app-specific password (appleid.apple.com → Sign-In and Security).",
        ),
        Preset(
            "zoho",
            "Zoho Mail",
            "smtp.zoho.com",
            465,
            "ssl",
            "imap.zoho.com",
            993,
            "ssl",
            None,
            "Use an application-specific password if two-factor authentication is on.",
        ),
        Preset(
            "custom",
            "Other (SMTP / IMAP)",
            "",
            587,
            "starttls",
            "",
            993,
            "ssl",
            None,
            "Enter your provider's SMTP (sending) and IMAP (inbox) server settings.",
        ),
    )
}


@dataclass(frozen=True)
class OAuthProvider:
    key: str
    authorize_url: str
    token_url: str
    scopes: tuple[str, ...]
    revoke_url: str | None
    needs_secret: bool


OAUTH: dict[str, OAuthProvider] = {
    "google": OAuthProvider(
        "google",
        "https://accounts.google.com/o/oauth2/v2/auth",
        "https://oauth2.googleapis.com/token",
        ("https://mail.google.com/",),
        "https://oauth2.googleapis.com/revoke",
        needs_secret=True,
    ),
    "microsoft": OAuthProvider(
        "microsoft",
        "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        (
            "https://outlook.office.com/IMAP.AccessAsUser.All",
            "https://outlook.office.com/SMTP.Send",
            "offline_access",
        ),
        None,
        needs_secret=False,
    ),
}
