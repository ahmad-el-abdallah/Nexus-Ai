"""Building outgoing messages and reading received ones.

Received mail is untrusted: only plain text is kept (HTML is reduced to text, never
rendered), attachments are listed by name and never opened or stored.
"""

from __future__ import annotations

import html
import re
from dataclasses import dataclass, field
from datetime import datetime
from email import policy
from email.headerregistry import Address
from email.message import EmailMessage as MimeMessage
from email.parser import BytesParser
from email.utils import format_datetime, getaddresses, make_msgid, parsedate_to_datetime

BODY_LIMIT = 50_000
ADDRESS = re.compile(r"^[^@\s<>,;\"]+@[^@\s<>,;\"]+\.[^@\s<>,;\"]+$")


def valid_address(value: str) -> bool:
    return bool(ADDRESS.match(value.strip())) and len(value) <= 254


def new_message_id(address: str) -> str:
    domain = address.rsplit("@", 1)[-1] if "@" in address else "nexus.local"
    return make_msgid(domain=domain)


def build(
    *,
    sender: str,
    sender_name: str,
    to: list[str],
    cc: list[str],
    subject: str,
    body: str,
    message_id: str,
    date: datetime,
    in_reply_to: str | None = None,
    references: str | None = None,
) -> MimeMessage:
    message = MimeMessage(policy=policy.SMTP)
    message["From"] = Address(display_name=sender_name, addr_spec=sender) if sender_name else sender
    message["To"] = ", ".join(to)
    if cc:
        message["Cc"] = ", ".join(cc)
    message["Subject"] = subject
    message["Date"] = format_datetime(date)
    message["Message-ID"] = message_id
    if in_reply_to:
        message["In-Reply-To"] = in_reply_to
        message["References"] = f"{references} {in_reply_to}".strip() if references else in_reply_to
    message.set_content(body)
    return message


_BLOCK = re.compile(r"</?(p|div|br|tr|li|h[1-6]|table|blockquote)[^>]*>", re.IGNORECASE)
_DROP = re.compile(r"<(script|style|head)[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
_TAG = re.compile(r"<[^>]+>")


def html_to_text(markup: str) -> str:
    text = _DROP.sub("", markup)
    text = _BLOCK.sub("\n", text)
    text = html.unescape(_TAG.sub("", text))
    lines = [re.sub(r"[ \t\u00a0]+", " ", line).strip() for line in text.splitlines()]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


@dataclass
class Parsed:
    message_id: str
    from_address: str
    from_name: str | None
    to: list[str]
    cc: list[str]
    subject: str
    body: str
    date: datetime | None
    in_reply_to: str | None
    references: str | None
    attachments: list[str] = field(default_factory=list)


def _addresses(values: list[str]) -> list[str]:
    return [addr for _, addr in getaddresses(values) if addr]


def parse(raw: bytes, fallback_id: str) -> Parsed:
    message = BytesParser(policy=policy.default).parsebytes(raw)
    plain: list[str] = []
    markup: list[str] = []
    attachments: list[str] = []
    for part in message.walk():
        if part.is_multipart():
            continue
        filename = part.get_filename()
        if filename or part.get_content_disposition() == "attachment":
            attachments.append(str(filename or "unnamed attachment")[:200])
            continue
        kind = part.get_content_type()
        if kind not in ("text/plain", "text/html"):
            continue
        try:
            content = part.get_content()
        except (LookupError, ValueError):
            payload = part.get_payload(decode=True)
            content = (
                payload.decode("utf-8", errors="replace") if isinstance(payload, bytes) else ""
            )
        (plain if kind == "text/plain" else markup).append(str(content))
    body = "\n".join(plain).strip() or html_to_text("\n".join(markup))
    if len(body) > BODY_LIMIT:
        body = body[:BODY_LIMIT].rstrip() + "\n[…shortened]"
    senders = getaddresses([str(message.get("From", ""))])
    name, address = senders[0] if senders else ("", "")
    try:
        date = parsedate_to_datetime(str(message["Date"])) if message["Date"] else None
    except (TypeError, ValueError):
        date = None
    if date is not None and date.tzinfo is None:
        date = None  # an unzoned date can't be placed reliably
    return Parsed(
        message_id=str(message.get("Message-ID", "")).strip()[:300] or fallback_id,
        from_address=address[:254] or "unknown",
        from_name=name[:200] or None,
        to=_addresses(message.get_all("To", [])),
        cc=_addresses(message.get_all("Cc", [])),
        subject=str(message.get("Subject", ""))[:500],
        body=body,
        date=date,
        in_reply_to=str(message.get("In-Reply-To", "")).strip()[:300] or None,
        references=str(message.get("References", "")).strip()[:4000] or None,
        attachments=attachments,
    )
