"""Brevo (transactional email API, https://developers.brevo.com) as the sending method.

Brevo only sends: it has no inbox, so reading mail still needs the mailbox's IMAP.
Errors are classified like SMTP ones (see `transport.MailError`): a refusal means
nothing was sent; a timeout or server error after the request went out is
"uncertain". Every request carries Brevo's `idempotencyKey` (the draft's fixed
Message-ID), so Brevo itself also refuses to send the same draft twice.
"""

from __future__ import annotations

from typing import Any

import httpx

from app.email.transport import MailError

TIMEOUT = httpx.Timeout(30.0, connect=10.0)


def _reason(response: httpx.Response) -> str:
    try:
        data = response.json()
    except ValueError:
        data = {}
    message = data.get("message") if isinstance(data, dict) else None
    return f"{response.status_code} {message or response.reason_phrase}".strip()


class Brevo:
    def __init__(self, base_url: str, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self.transport = transport

    def _client(self, api_key: str) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self.base_url,
            transport=self.transport,
            timeout=TIMEOUT,
            headers={"api-key": api_key, "accept": "application/json"},
        )

    async def check(self, api_key: str, sender: str) -> str:
        """Checks the API key and that `sender` is a verified sender (or on an
        authenticated domain) in the Brevo account. Sends nothing."""
        try:
            async with self._client(api_key) as client:
                account = await client.get("/account")
                if account.status_code in (401, 403):
                    raise MailError("login", f"Brevo refused the API key ({_reason(account)}).")
                if account.status_code != 200:
                    raise MailError(
                        "connect", f"Brevo answered {_reason(account)}.", temporary=True
                    )
                senders = await client.get("/senders")
                domains = await client.get("/senders/domains")
        except httpx.HTTPError as error:
            raise MailError(
                "connect", f"Could not reach Brevo: {type(error).__name__}", temporary=True
            ) from error
        verified = {
            str(s.get("email", "")).lower()
            for s in (senders.json().get("senders") or [] if senders.status_code == 200 else [])
            if s.get("active", True)
        }
        authenticated = {
            str(d.get("domain_name", "")).lower()
            for d in (domains.json().get("domains") or [] if domains.status_code == 200 else [])
            if d.get("authenticated")
        }
        address = sender.lower()
        if address not in verified and address.rsplit("@", 1)[-1] not in authenticated:
            raise MailError(
                "sender",
                f"{sender} is not a verified sender in your Brevo account. Add it under "
                "Brevo → Senders, Domains & Dedicated IPs → Senders and confirm the email "
                "Brevo sends you, then test again.",
            )
        return f"API key accepted; {sender} is a verified sender{_plan(account.json())}"

    async def send(self, api_key: str, payload: dict[str, Any]) -> str:
        try:
            async with self._client(api_key) as client:
                response = await client.post("/smtp/email", json=payload)
        except (httpx.ConnectError, httpx.ConnectTimeout) as error:
            raise MailError(
                "connect", f"Could not reach Brevo: {type(error).__name__}", temporary=True
            ) from error
        except httpx.HTTPError as error:
            # The request may have reached Brevo before the connection failed.
            raise MailError(
                "data",
                f"The connection to Brevo broke while sending ({type(error).__name__}).",
                delivered=None,
            ) from error
        if response.status_code in (200, 201, 202):
            message_id = response.json().get("messageId", "")
            return f"Brevo accepted it ({response.status_code}, messageId {message_id})".strip()
        if response.status_code in (401, 403):
            raise MailError("login", f"Brevo refused the API key ({_reason(response)}).")
        if response.status_code == 429:
            raise MailError(
                "data", f"Brevo's sending limit was reached ({_reason(response)}).", temporary=True
            )
        if response.status_code >= 500:
            raise MailError("data", f"Brevo had an error ({_reason(response)}).", delivered=None)
        raise MailError("data", f"Brevo rejected the email ({_reason(response)}).")


def _plan(account: dict[str, Any]) -> str:
    """The plan and remaining credits exactly as Brevo reports them."""
    plans = account.get("plan") or []
    parts = []
    for plan in plans:
        kind = plan.get("type")
        credits = plan.get("credits")
        if kind and credits is not None:
            unit = "emails/day" if plan.get("creditsType") == "sendLimit" else "credits"
            parts.append(f"{kind} plan, {credits} {unit} left")
    return f" ({'; '.join(parts)})" if parts else ""


def payload(
    *,
    sender: str,
    sender_name: str,
    to: list[str],
    cc: list[str],
    subject: str,
    body: str,
    idempotency_key: str,
) -> dict[str, Any]:
    data: dict[str, Any] = {
        "sender": {"email": sender, **({"name": sender_name} if sender_name else {})},
        "to": [{"email": address} for address in to],
        "subject": subject or "(no subject)",
        "textContent": body,
        "headers": {"idempotencyKey": idempotency_key},
    }
    if cc:
        data["cc"] = [{"email": address} for address in cc]
    return data
