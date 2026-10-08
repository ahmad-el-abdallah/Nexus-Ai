"""SMTP and IMAP, using Python's standard library (run in a worker thread).

Sending reports *where* it stopped, because that decides whether a retry is safe:
before the server accepted the message (connect, TLS, login, sender, recipients, or
an explicit rejection of the data) nothing was sent; a connection that breaks while
the message is being transferred might have been delivered — that is "uncertain".
"""

from __future__ import annotations

import contextlib
import imaplib
import re
import smtplib
import socket
import ssl
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from email.message import EmailMessage as MimeMessage

TIMEOUT = 25.0


@dataclass
class Server:
    host: str
    port: int
    security: str  # ssl | starttls | none


@dataclass
class Credentials:
    username: str
    password: str | None = None
    access_token: str | None = None  # OAuth (XOAUTH2)
    api_key: str | None = None  # API sending (Brevo); `password` is then the IMAP password

    def xoauth2(self) -> str:
        return f"user={self.username}\x01auth=Bearer {self.access_token}\x01\x01"


class MailError(Exception):
    """A mail-server failure. `delivered` is False when nothing can have been sent,
    None when it is unknown (connection lost mid-transfer)."""

    def __init__(
        self,
        stage: str,
        message: str,
        *,
        delivered: bool | None = False,
        temporary: bool = False,
    ) -> None:
        super().__init__(message)
        self.stage = stage
        self.delivered = delivered
        self.temporary = temporary


def _tls() -> ssl.SSLContext:
    return ssl.create_default_context()


def _reason(error: BaseException) -> str:
    if isinstance(error, smtplib.SMTPResponseException):
        raw = error.smtp_error
        text = raw.decode(errors="replace") if isinstance(raw, bytes) else str(raw)
        return f"{error.smtp_code} {text}".strip()
    if isinstance(error, imaplib.IMAP4.error):
        detail = error.args[0] if error.args else error
        return detail.decode(errors="replace") if isinstance(detail, bytes) else str(detail)
    if isinstance(error, socket.timeout | TimeoutError):
        return "the server did not answer in time"
    if isinstance(error, ssl.SSLError):
        return f"TLS problem ({error.reason or error})"
    if isinstance(error, ConnectionRefusedError):
        return "connection refused"
    if isinstance(error, socket.gaierror):
        return "the server name could not be found"
    return f"{type(error).__name__}: {error}"


# ----------------------------------------------------------------------- SMTP


@contextmanager
def smtp_session(server: Server, credentials: Credentials) -> Iterator[smtplib.SMTP]:
    stage = "connect"
    smtp: smtplib.SMTP | None = None
    try:
        if server.security == "ssl":
            smtp = smtplib.SMTP_SSL(server.host, server.port, timeout=TIMEOUT, context=_tls())
        else:
            smtp = smtplib.SMTP(server.host, server.port, timeout=TIMEOUT)
        smtp.ehlo()
        if server.security == "starttls":
            stage = "tls"
            smtp.starttls(context=_tls())
            smtp.ehlo()
        stage = "login"
        if credentials.access_token:
            smtp.auth(
                "XOAUTH2", lambda challenge=None: credentials.xoauth2(), initial_response_ok=True
            )
        elif credentials.password is not None:
            smtp.login(credentials.username, credentials.password)
        yield smtp
    except MailError:
        raise
    except smtplib.SMTPAuthenticationError as error:
        raise MailError(stage, f"Login failed: {_reason(error)}") from error
    except smtplib.SMTPServerDisconnected as error:
        if stage != "login":
            raise MailError(
                stage,
                f"Could not complete {stage} with {server.host}:{server.port}: {_reason(error)}",
                temporary=True,
            ) from error
        # Some servers (Gmail) hang up after a rejected password instead of answering.
        raise MailError(
            stage,
            "Login failed: the server closed the connection while checking the username "
            "and password.",
        ) from error
    except smtplib.SMTPResponseException as error:
        raise MailError(
            stage,
            f"The server refused ({stage}): {_reason(error)}",
            temporary=400 <= error.smtp_code < 500,
        ) from error
    except (OSError, smtplib.SMTPException) as error:
        verb = "connect to" if stage == "connect" else f"complete {stage} with"
        raise MailError(
            stage,
            f"Could not {verb} {server.host}:{server.port}: {_reason(error)}",
            temporary=True,
        ) from error
    finally:
        if smtp is not None:
            try:
                smtp.quit()
            except (OSError, smtplib.SMTPException):
                smtp.close()


def smtp_check(server: Server, credentials: Credentials) -> str:
    """Connects and signs in without sending anything."""
    with smtp_session(server, credentials) as smtp:
        code, _ = smtp.noop()
        return f"Signed in to {server.host} (NOOP {code})"


def smtp_send(
    server: Server,
    credentials: Credentials,
    message: MimeMessage,
    sender: str,
    recipients: list[str],
) -> str:
    with smtp_session(server, credentials) as smtp:
        try:
            code, reply = smtp.mail(sender)
            if code != 250:
                raise MailError(
                    "sender",
                    f"Sender refused: {code} {reply.decode(errors='replace')}",
                    temporary=400 <= code < 500,
                )
            refused = []
            for rcpt in recipients:
                code, reply = smtp.rcpt(rcpt)
                if code not in (250, 251):
                    refused.append(f"{rcpt} ({code} {reply.decode(errors='replace')})")
            if refused:
                smtp.rset()
                raise MailError("recipients", "Recipient refused: " + "; ".join(refused))
        except MailError:
            raise
        except smtplib.SMTPResponseException as error:
            raise MailError(
                "sender", _reason(error), temporary=400 <= error.smtp_code < 500
            ) from error
        except (OSError, smtplib.SMTPException) as error:
            raise MailError(
                "sender", f"Connection lost before sending: {_reason(error)}", temporary=True
            ) from error
        # From here on the message is being transferred.
        try:
            code, reply = smtp.data(message.as_bytes())
        except smtplib.SMTPDataError as error:
            # An explicit rejection: the server did not accept the message.
            raise MailError(
                "data",
                f"The server rejected the message: {_reason(error)}",
                temporary=400 <= error.smtp_code < 500,
            ) from error
        except (OSError, smtplib.SMTPException) as error:
            raise MailError(
                "data", f"The connection broke while sending: {_reason(error)}", delivered=None
            ) from error
        text = f"{code} {reply.decode(errors='replace')}".strip()
        if code != 250:
            # The server answered the transfer with a refusal: it did not take the message.
            raise MailError(
                "data", f"The server rejected the message: {text}", temporary=400 <= code < 500
            )
        return text


# ----------------------------------------------------------------------- IMAP


@contextmanager
def imap_session(server: Server, credentials: Credentials) -> Iterator[imaplib.IMAP4]:
    stage = "connect"
    imap: imaplib.IMAP4 | None = None
    try:
        if server.security == "ssl":
            imap = imaplib.IMAP4_SSL(server.host, server.port, ssl_context=_tls(), timeout=TIMEOUT)
        else:
            imap = imaplib.IMAP4(server.host, server.port, timeout=TIMEOUT)
            if server.security == "starttls":
                stage = "tls"
                imap.starttls(ssl_context=_tls())
        stage = "login"
        if credentials.access_token:
            imap.authenticate("XOAUTH2", lambda _: credentials.xoauth2().encode())
        else:
            imap.login(credentials.username, credentials.password or "")
        stage = "inbox"
        yield imap
    except MailError:
        raise
    except imaplib.IMAP4.error as error:
        what = "Login failed" if stage == "login" else "The inbox server refused"
        raise MailError(stage, f"{what}: {_reason(error)}") from error
    except OSError as error:
        raise MailError(
            stage,
            f"Could not connect to {server.host}:{server.port}: {_reason(error)}",
            temporary=True,
        ) from error
    finally:
        if imap is not None:
            with contextlib.suppress(OSError, imaplib.IMAP4.error):
                imap.logout()


def imap_check(server: Server, credentials: Credentials) -> str:
    with imap_session(server, credentials) as imap:
        status, data = imap.select("INBOX", readonly=True)
        if status != "OK":
            raise MailError("select", "The INBOX folder could not be opened.")
        return f"Signed in; INBOX has {int(data[0] or 0)} message(s)"


@dataclass
class Fetched:
    uid: int
    raw: bytes


def _uidvalidity(imap: imaplib.IMAP4) -> int:
    _, values = imap.response("UIDVALIDITY")
    value = values[0] if values else None
    match = re.search(rb"\d+", value) if isinstance(value, bytes) else None
    return int(match.group()) if match else 0


def imap_fetch_new(
    server: Server,
    credentials: Credentials,
    after_uid: int | None,
    uidvalidity: int | None,
    limit: int,
) -> tuple[int, list[Fetched]]:
    """New messages in INBOX (the latest `limit` on a first sync). Returns the
    folder's UIDVALIDITY and the messages, oldest first."""
    with imap_session(server, credentials) as imap:
        status, _ = imap.select("INBOX", readonly=True)
        if status != "OK":
            raise MailError("select", "The INBOX folder could not be opened.")
        validity = _uidvalidity(imap)
        start = (after_uid or 0) + 1 if uidvalidity == validity and after_uid else 1
        _, data = imap.uid("SEARCH", f"UID {start}:*")
        uids = sorted(int(u) for u in (data[0] or b"").split() if int(u) >= start)[-limit:]
        out: list[Fetched] = []
        for uid in uids:
            _, parts = imap.uid("FETCH", str(uid), "(BODY.PEEK[])")
            for part in parts:
                if isinstance(part, tuple) and len(part) == 2:
                    out.append(Fetched(uid, part[1]))
                    break
        return validity, out


def _sent_folders(imap: imaplib.IMAP4) -> list[str]:
    _, data = imap.list()
    found = []
    for line in data or []:
        text = line.decode(errors="replace") if isinstance(line, bytes) else str(line)
        name = text.rsplit(" ", 1)[-1].strip().strip('"')
        if (
            "\\Sent" in text
            or "\\All" in text
            or name.lower() in ("sent", "sent items", "sent mail", "inbox.sent")
        ):
            found.append(name)
    return found or ["Sent"]


def _quote(folder: str) -> str:
    return '"' + folder.replace("\\", "\\\\").replace('"', '\\"') + '"'


def imap_find_sent(server: Server, credentials: Credentials, message_id: str) -> bool:
    """True if a message with this Message-ID is in a Sent (or All Mail) folder."""
    with imap_session(server, credentials) as imap:
        for folder in _sent_folders(imap):
            status, _ = imap.select(_quote(folder), readonly=True)
            if status != "OK":
                continue
            status, data = imap.uid("SEARCH", "HEADER", "Message-ID", _quote(message_id))
            if status == "OK" and (data[0] or b"").strip():
                return True
        return False


def imap_append_sent(server: Server, credentials: Credentials, message: MimeMessage) -> str | None:
    """Saves a copy in the Sent folder (for providers that don't do it themselves)."""
    with imap_session(server, credentials) as imap:
        folder = _sent_folders(imap)[0]
        status, _ = imap.append(
            _quote(folder), "(\\Seen)", imaplib.Time2Internaldate(time.time()), message.as_bytes()
        )
        return folder if status == "OK" else None
