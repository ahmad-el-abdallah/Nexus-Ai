"""A fake mail provider for tests: an SMTP server (aiosmtpd) and a minimal IMAP
server, both on 127.0.0.1 without TLS. Nothing leaves this computer.

Run standalone for the e2e tests:
    uv run python -m tests.fake_mail --smtp-port 18325 --imap-port 18326 --control-port 18327
The control port takes JSON commands (set a failure mode, deliver mail, list sent mail)
and also serves a fake Brevo API under /v3 (point NEXUS_BREVO_API_URL at it).
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import socketserver
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.message import EmailMessage
from email.utils import format_datetime, make_msgid
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

from aiosmtpd.controller import Controller
from aiosmtpd.smtp import SMTP, AuthResult, Envelope, LoginPassword, Session

USER = "owner@example.com"
PASSWORD = "fake-app-password"
TOKEN = "fake-access-token"


@dataclass
class Received:
    sender: str
    recipients: list[str]
    data: bytes

    @property
    def message_id(self) -> str | None:
        match = re.search(rb"^Message-ID:\s*(\S+)", self.data, re.MULTILINE | re.IGNORECASE)
        return match.group(1).decode() if match else None


@dataclass
class Mailbox:
    uidvalidity: int = 1001
    next_uid: int = 1
    messages: list[tuple[int, bytes]] = field(default_factory=list)

    def add(self, raw: bytes) -> int:
        uid = self.next_uid
        self.next_uid += 1
        self.messages.append((uid, raw))
        return uid


def sample(
    sender: str = "client@example.org",
    subject: str = "Question about your services",
    body: str = "Hello, could you send me your prices?",
    *,
    html: str | None = None,
    attachment: str | None = None,
) -> bytes:
    message = EmailMessage()
    message["From"] = f"A Client <{sender}>"
    message["To"] = USER
    message["Subject"] = subject
    message["Date"] = format_datetime(datetime.now(UTC))
    message["Message-ID"] = make_msgid(domain="example.org")
    message.set_content(body)
    if html is not None:
        message.add_alternative(html, subtype="html")
    if attachment:
        message.add_attachment(
            b"%PDF-1.4 fake", maintype="application", subtype="pdf", filename=attachment
        )
    return message.as_bytes()


BREVO_KEY = "xkeysib-" + "f" * 24  # a fake Brevo API key (test only)


class FakeBrevo:
    """Stands in for Brevo's API (/v3/account, /v3/senders, /v3/senders/domains,
    /v3/smtp/email). `mode`: None, "reject" (400), "limit" (429), "error" (500, the
    email was accepted anyway) or "drop" (accepted, then the connection breaks)."""

    def __init__(self, api_key: str = BREVO_KEY, senders: tuple[str, ...] = (USER,)) -> None:
        self.api_key = api_key
        self.senders = list(senders)
        self.mode: str | None = None
        self.sent: list[dict[str, Any]] = []

    def handle(self, method: str, path: str, api_key: str | None, body: bytes) -> tuple[int, Any]:
        """Returns (status, json); status 0 means "break the connection"."""
        if api_key != self.api_key:
            return 401, {"code": "unauthorized", "message": "Key not found"}
        path = path.split("/v3", 1)[-1]
        if method == "GET" and path == "/account":
            return 200, {
                "plan": [
                    {"type": "free", "credits": 300 - len(self.sent), "creditsType": "sendLimit"}
                ]
            }
        if method == "GET" and path == "/senders":
            return 200, {"senders": [{"email": e, "active": True} for e in self.senders]}
        if method == "GET" and path == "/senders/domains":
            return 200, {"domains": []}
        if method == "POST" and path == "/smtp/email":
            payload = json.loads(body or b"{}")
            if self.mode == "reject":
                return 400, {"code": "invalid_parameter", "message": "sender is not valid"}
            if self.mode == "limit":
                return 429, {"code": "too_many_requests", "message": "Rate limit"}
            self.sent.append(payload)
            if self.mode == "error":
                return 500, {"code": "internal", "message": "Internal error"}
            if self.mode == "drop":
                return 0, None
            return 201, {"messageId": f"<{len(self.sent)}@smtp-relay.brevo.test>"}
        return 404, {"code": "not_found", "message": "Not found"}


class FakeMail:
    """`smtp_mode`: None (accept), "reject" (554 on DATA), "tempfail" (451 on DATA),
    "tempfail_once", "drop" (accepts the message, then breaks the connection before
    answering), "bad_rcpt" (550 for every recipient). `imap_mode`: None or "down"."""

    def __init__(self, user: str = USER, password: str = PASSWORD, token: str = TOKEN) -> None:
        self.user = user
        self.password = password
        self.token = token
        self.smtp_mode: str | None = None
        self.imap_mode: str | None = None
        self.sent: list[Received] = []
        self.data_attempts = 0
        self.logins: list[str] = []
        self.folders: dict[str, Mailbox] = {"INBOX": Mailbox(), "Sent": Mailbox(uidvalidity=2002)}
        self.lock = threading.Lock()
        self._smtp: Controller | None = None
        self._imap: _ImapServer | None = None
        self.smtp_port = 0
        self.imap_port = 0

    # ----------------------------------------------------------------- control

    def deliver(self, raw: bytes) -> int:
        with self.lock:
            return self.folders["INBOX"].add(raw)

    def check(self, user: str, secret: str, oauth: bool) -> bool:
        ok = user == self.user and secret == (self.token if oauth else self.password)
        self.logins.append(f"{'xoauth2' if oauth else 'password'}:{'ok' if ok else 'fail'}")
        return ok

    def start(self, smtp_port: int = 0, imap_port: int = 0) -> FakeMail:
        self._imap = _ImapServer(("127.0.0.1", imap_port), _imap_handler(self))
        self.imap_port = self._imap.server_address[1]
        threading.Thread(target=self._imap.serve_forever, daemon=True).start()
        if not smtp_port:
            with socketserver.TCPServer(("127.0.0.1", 0), socketserver.BaseRequestHandler) as probe:
                smtp_port = probe.server_address[1]
        self.smtp_port = smtp_port
        self._smtp = _Controller(self, smtp_port)
        self._smtp.start()
        return self

    def stop(self) -> None:
        if self._smtp:
            self._smtp.stop()
        if self._imap:
            self._imap.shutdown()
            self._imap.server_close()


# ------------------------------------------------------------------------ SMTP


class _Handler:
    def __init__(self, mail: FakeMail) -> None:
        self.mail = mail

    async def auth_XOAUTH2(self, server: SMTP, args: list[str]) -> AuthResult:
        try:
            decoded = base64.b64decode(args[1]).decode() if len(args) > 1 else ""
        except ValueError:
            decoded = ""
        match = re.match(r"user=([^\x01]*)\x01auth=Bearer ([^\x01]*)\x01\x01$", decoded)
        ok = bool(match) and self.mail.check(match.group(1), match.group(2), oauth=True)  # type: ignore[union-attr]
        return AuthResult(success=ok, handled=False)

    async def handle_MAIL(
        self, server: SMTP, session: Session, envelope: Envelope, address: str, options: list[str]
    ) -> str:
        if not session.authenticated:
            return "530 5.7.0 Authentication required"
        envelope.mail_from = address
        envelope.mail_options.extend(options)
        return "250 OK"

    async def handle_RCPT(
        self, server: SMTP, session: Session, envelope: Envelope, address: str, options: list[str]
    ) -> str:
        if self.mail.smtp_mode == "bad_rcpt":
            return "550 5.1.1 No such user here"
        envelope.rcpt_tos.append(address)
        return "250 OK"

    async def handle_DATA(self, server: SMTP, session: Session, envelope: Envelope) -> str:
        mail = self.mail
        mail.data_attempts += 1
        mode = mail.smtp_mode
        if mode == "tempfail_once":
            mail.smtp_mode = None
            return "451 4.3.0 Temporary problem, try again"
        if mode == "tempfail":
            return "451 4.3.0 Temporary problem, try again"
        if mode == "reject":
            return "554 5.7.1 Message rejected as spam"
        received = Received(
            str(envelope.mail_from),
            list(envelope.rcpt_tos),
            bytes(envelope.original_content or b""),
        )
        with mail.lock:
            mail.sent.append(received)
        if mode == "drop":
            server.transport.close()  # the message arrived, but the client never hears so
            return "250 OK (never delivered to the client)"
        return "250 2.0.0 OK queued as fake"


def _authenticator(mail: FakeMail):  # type: ignore[no-untyped-def]
    def authenticate(
        server: SMTP, session: Session, envelope: Envelope, mechanism: str, data: Any
    ) -> AuthResult:
        if isinstance(data, LoginPassword):
            ok = mail.check(data.login.decode(), data.password.decode(), oauth=False)
            return AuthResult(success=ok, handled=False)
        return AuthResult(success=False, handled=False)

    return authenticate


class _Controller(Controller):
    def __init__(self, mail: FakeMail, port: int) -> None:
        self.mail = mail
        super().__init__(
            _Handler(mail),
            hostname="127.0.0.1",
            port=port,
            authenticator=_authenticator(mail),
            auth_require_tls=False,
        )


# ------------------------------------------------------------------------ IMAP


class _ImapServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True  # restart right away (e2e runs) despite TIME_WAIT
    daemon_threads = True


def _args(text: str) -> list[str]:
    """Splits IMAP arguments, honouring quoted strings and parenthesised lists."""
    out: list[str] = []
    i = 0
    while i < len(text):
        c = text[i]
        if c == " ":
            i += 1
        elif c == '"':
            j = i + 1
            buf = ""
            while j < len(text) and text[j] != '"':
                if text[j] == "\\" and j + 1 < len(text):
                    j += 1
                buf += text[j]
                j += 1
            out.append(buf)
            i = j + 1
        elif c == "(":
            depth, j = 0, i
            while j < len(text):
                depth += text[j] == "("
                depth -= text[j] == ")"
                j += 1
                if depth == 0:
                    break
            out.append(text[i:j])
            i = j
        else:
            j = text.find(" ", i)
            j = len(text) if j == -1 else j
            out.append(text[i:j])
            i = j
    return out


def _imap_handler(mail: FakeMail) -> type[socketserver.StreamRequestHandler]:
    class Handler(socketserver.StreamRequestHandler):
        def send(self, line: str | bytes) -> None:
            data = line.encode() if isinstance(line, str) else line
            self.wfile.write(data + b"\r\n")
            self.wfile.flush()

        def handle(self) -> None:
            if mail.imap_mode == "down":
                self.send("* BYE service unavailable")
                return
            self.send("* OK fake IMAP ready")
            authed = False
            selected: str | None = None
            while True:
                raw = self.rfile.readline()
                if not raw:
                    return
                line = raw.decode(errors="replace").rstrip("\r\n")
                tag, _, rest = line.partition(" ")
                command, _, argtext = rest.partition(" ")
                command = command.upper()
                args = _args(argtext)
                if command == "CAPABILITY":
                    self.send("* CAPABILITY IMAP4rev1 AUTH=PLAIN AUTH=XOAUTH2")
                    self.send(f"{tag} OK CAPABILITY completed")
                elif command == "NOOP":
                    self.send(f"{tag} OK NOOP completed")
                elif command == "LOGOUT":
                    self.send("* BYE logging out")
                    self.send(f"{tag} OK LOGOUT completed")
                    return
                elif command == "LOGIN":
                    authed = len(args) == 2 and mail.check(args[0], args[1], oauth=False)
                    self.send(
                        f"{tag} OK LOGIN completed"
                        if authed
                        else f"{tag} NO [AUTHENTICATIONFAILED] Invalid credentials"
                    )
                elif command == "AUTHENTICATE" and args[:1] == ["XOAUTH2"]:
                    self.send("+ ")
                    response = self.rfile.readline().decode().strip()
                    try:
                        decoded = base64.b64decode(response).decode()
                    except ValueError:
                        decoded = ""
                    match = re.match(r"user=([^\x01]*)\x01auth=Bearer ([^\x01]*)\x01\x01$", decoded)
                    authed = bool(match) and mail.check(match.group(1), match.group(2), oauth=True)  # type: ignore[union-attr]
                    self.send(
                        f"{tag} OK AUTHENTICATE completed"
                        if authed
                        else f"{tag} NO [AUTHENTICATIONFAILED] Invalid credentials"
                    )
                elif not authed:
                    self.send(f"{tag} BAD not authenticated")
                elif command in ("SELECT", "EXAMINE"):
                    name = args[0] if args else ""
                    box = mail.folders.get(name)
                    if box is None:
                        self.send(f"{tag} NO no such mailbox")
                        continue
                    selected = name
                    self.send(f"* {len(box.messages)} EXISTS")
                    self.send(f"* OK [UIDVALIDITY {box.uidvalidity}] UIDs valid")
                    self.send(f"* OK [UIDNEXT {box.next_uid}] next uid")
                    mode = "READ-ONLY" if command == "EXAMINE" else "READ-WRITE"
                    self.send(f"{tag} OK [{mode}] {command} completed")
                elif command == "LIST":
                    self.send('* LIST (\\HasNoChildren) "/" "INBOX"')
                    self.send('* LIST (\\HasNoChildren \\Sent) "/" "Sent"')
                    self.send(f"{tag} OK LIST completed")
                elif command == "APPEND":
                    name = args[0]
                    size = int(re.search(r"\{(\d+)\}$", argtext).group(1))  # type: ignore[union-attr]
                    self.send("+ Ready for literal data")
                    data = self.rfile.read(size)
                    self.rfile.readline()
                    with mail.lock:
                        mail.folders.setdefault(name, Mailbox()).add(data)
                    self.send(f"{tag} OK APPEND completed")
                elif command == "UID" and selected is not None:
                    self.uid(tag, args, mail.folders[selected])
                else:
                    self.send(f"{tag} BAD unsupported command")

        def uid(self, tag: str, args: list[str], box: Mailbox) -> None:
            sub = args[0].upper() if args else ""
            if sub == "SEARCH":
                rest = args[1:]
                if rest[:1] == ["UID"]:
                    start = int(rest[1].split(":")[0])
                    uids = [u for u, _ in box.messages if u >= start]
                    if not uids and box.messages:
                        uids = [box.messages[-1][0]]  # "n:*" always includes the last message
                elif rest[:1] and rest[0].upper() == "HEADER":
                    header, value = rest[1], rest[2]
                    pattern = re.compile(
                        rb"^" + re.escape(header.encode()) + rb":\s*" + re.escape(value.encode()),
                        re.IGNORECASE | re.MULTILINE,
                    )
                    uids = [u for u, raw in box.messages if pattern.search(raw)]
                else:
                    uids = [u for u, _ in box.messages]
                self.send("* SEARCH" + "".join(f" {u}" for u in uids))
                self.send(f"{tag} OK SEARCH completed")
            elif sub == "FETCH":
                wanted = {int(u) for u in args[1].split(",")}
                for seq, (uid, raw) in enumerate(box.messages, start=1):
                    if uid in wanted:
                        self.wfile.write(
                            f"* {seq} FETCH (UID {uid} BODY[] {{{len(raw)}}}\r\n".encode()
                        )
                        self.wfile.write(raw)
                        self.send(")")
                self.send(f"{tag} OK FETCH completed")
            else:
                self.send(f"{tag} BAD unsupported UID command")

    return Handler


# ---------------------------------------------------------------- standalone


def _control(mail: FakeMail, brevo: FakeBrevo, port: int) -> HTTPServer:
    class Control(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:
            pass

        def _reply(self, data: Any) -> None:
            body = json.dumps(data).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _brevo(self, method: str) -> bool:
            if not self.path.startswith("/v3/"):
                return False
            length = int(self.headers.get("content-length") or 0)
            status, data = brevo.handle(
                method, self.path, self.headers.get("api-key"), self.rfile.read(length)
            )
            if status == 0:
                self.close_connection = True
                self.connection.close()
                return True
            body = json.dumps(data).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return True

        def do_GET(self) -> None:
            if self._brevo("GET"):
                return
            self._reply(
                {
                    "sent": [
                        {
                            "sender": r.sender,
                            "recipients": r.recipients,
                            "message_id": r.message_id,
                            "data": r.data.decode(errors="replace"),
                        }
                        for r in mail.sent
                    ],
                    "data_attempts": mail.data_attempts,
                    "smtp_mode": mail.smtp_mode,
                    "brevo_sent": brevo.sent,
                }
            )

        def do_POST(self) -> None:
            if self._brevo("POST"):
                return
            length = int(self.headers.get("content-length") or 0)
            command = json.loads(self.rfile.read(length) or b"{}")
            if "smtp_mode" in command:
                mail.smtp_mode = command["smtp_mode"]
            if "imap_mode" in command:
                mail.imap_mode = command["imap_mode"]
            if "brevo_mode" in command:
                brevo.mode = command["brevo_mode"]
            if command.get("deliver"):
                mail.deliver(sample(**command["deliver"]))
            if command.get("reset"):
                mail.sent.clear()
                mail.data_attempts = 0
                mail.smtp_mode = mail.imap_mode = None
                mail.folders = {"INBOX": Mailbox(), "Sent": Mailbox(uidvalidity=2002)}
                brevo.sent.clear()
                brevo.mode = None
            self._reply({"ok": True})

    server = HTTPServer(("127.0.0.1", port), Control)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--smtp-port", type=int, default=18325)
    parser.add_argument("--imap-port", type=int, default=18326)
    parser.add_argument("--control-port", type=int, default=18327)
    options = parser.parse_args()
    mail = FakeMail().start(options.smtp_port, options.imap_port)
    _control(mail, FakeBrevo(), options.control_port)
    print(
        f"fake mail: SMTP {mail.smtp_port}, IMAP {mail.imap_port}, control {options.control_port}",
        flush=True,
    )
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        mail.stop()


if __name__ == "__main__":
    main()
