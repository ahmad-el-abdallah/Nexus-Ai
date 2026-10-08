"""Company email: accounts, the approval queue, sending, the inbox and the log."""

from __future__ import annotations

from typing import Annotated, Any, Literal
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session
from app.email.oauth import OAuthError
from app.email.providers import OAUTH, PRESETS
from app.email.service import (
    EmailError,
    EmailService,
    account_out,
    event_out,
    message_out,
)
from app.models import EmailAccount, EmailEvent, EmailMessage, EmailStatus

router = APIRouter(prefix="/api/email", tags=["email"])
Session = Annotated[AsyncSession, Depends(get_session)]


def service(request: Request) -> EmailService:
    return request.app.state.email


Mail = Annotated[EmailService, Depends(service)]
Security = Literal["ssl", "starttls", "none"]


def _error(error: EmailError) -> HTTPException:
    return HTTPException(error.status, str(error))


class AccountCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    provider: str = Field(max_length=24)
    auth_method: Literal["password", "oauth", "api_key"] = "password"
    address: str = Field(max_length=254)
    label: str | None = Field(default=None, max_length=80)
    display_name: str | None = Field(default=None, max_length=120)
    username: str | None = Field(default=None, max_length=254)
    password: str | None = Field(default=None, max_length=1000)
    oauth_client_id: str | None = Field(default=None, max_length=300)
    oauth_client_secret: str | None = Field(default=None, max_length=1000)
    api_key: str | None = Field(default=None, max_length=500)
    imap_password: str | None = Field(default=None, max_length=1000)
    # Not needed for API providers (Brevo).
    smtp_host: str = Field(default="", max_length=253)
    smtp_port: int | None = Field(default=None, ge=1, le=65535)
    smtp_security: Security = "ssl"
    imap_host: str | None = Field(default=None, max_length=253)
    imap_port: int | None = Field(default=None, ge=1, le=65535)
    imap_security: Security | None = None


class AccountUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: str | None = Field(default=None, max_length=80)
    display_name: str | None = Field(default=None, max_length=120)
    username: str | None = Field(default=None, max_length=254)
    password: str | None = Field(default=None, max_length=1000)
    oauth_client_id: str | None = Field(default=None, max_length=300)
    oauth_client_secret: str | None = Field(default=None, max_length=1000)
    api_key: str | None = Field(default=None, max_length=500)
    imap_password: str | None = Field(default=None, max_length=1000)
    smtp_host: str | None = Field(default=None, max_length=253)
    smtp_port: int | None = Field(default=None, ge=1, le=65535)
    smtp_security: Security | None = None
    imap_host: str | None = Field(default=None, max_length=253)
    imap_port: int | None = Field(default=None, ge=1, le=65535)
    imap_security: Security | None = None
    clear_imap: bool = False
    make_default: bool = False


class Disconnect(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Also delete the account and every email stored for it.
    purge: bool = False


class DraftCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_id: str | None = None
    to: list[str] = Field(default_factory=list, max_length=20)
    cc: list[str] = Field(default_factory=list, max_length=20)
    subject: str = Field(default="", max_length=300)
    body: str = Field(default="", max_length=20000)
    reply_to_id: str | None = None


class DraftGenerate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    account_id: str | None = None
    to: list[str] = Field(default_factory=list, max_length=20)
    cc: list[str] = Field(default_factory=list, max_length=20)
    instructions: str = Field(max_length=4000)
    employee_id: str | None = None
    reply_to_id: str | None = None


class DraftEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    to: list[str] | None = Field(default=None, max_length=20)
    cc: list[str] | None = Field(default=None, max_length=20)
    subject: str | None = Field(default=None, max_length=300)
    body: str | None = Field(default=None, max_length=20000)


class Rejection(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: str = Field(default="", max_length=1000)


class Resend(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirm_possible_duplicate: bool = False


# ---------------------------------------------------------------- providers


@router.get("/providers")
async def providers() -> list[dict[str, Any]]:
    return [
        {
            "key": p.key,
            "label": p.label,
            "smtp_host": p.smtp_host,
            "smtp_port": p.smtp_port,
            "smtp_security": p.smtp_security,
            "imap_host": p.imap_host,
            "imap_port": p.imap_port,
            "imap_security": p.imap_security,
            "oauth": p.oauth,
            "oauth_needs_secret": OAUTH[p.oauth].needs_secret if p.oauth else False,
            "api": p.api,
            "note": p.note,
        }
        for p in PRESETS.values()
    ]


# ----------------------------------------------------------------- accounts


@router.get("/accounts")
async def list_accounts(session: Session, mail: Mail) -> dict[str, Any]:
    accounts = list(await session.scalars(select(EmailAccount).order_by(EmailAccount.created_at)))
    return {
        "accounts": [account_out(a) for a in accounts],
        "secret_key_present": mail.settings.secret_key is not None,
        "oauth_redirect_uri": mail.redirect_uri,
    }


@router.post("/accounts", status_code=201)
async def create_account(body: AccountCreate, session: Session, mail: Mail) -> dict[str, Any]:
    """Saves the account (credentials encrypted); unless it still needs an OAuth sign-in,
    the connection is tested at once."""
    try:
        account = await mail.create_account(session, body.model_dump())
    except EmailError as error:
        raise _error(error) from error
    test = await mail.test_account(account.id) if account.auth_method != "oauth" else None
    await session.refresh(account)
    return {"account": account_out(account), "test": test}


@router.patch("/accounts/{account_id}")
async def update_account(
    account_id: str, body: AccountUpdate, session: Session, mail: Mail
) -> dict[str, Any]:
    try:
        account = await mail.update_account(session, account_id, body.model_dump())
    except EmailError as error:
        raise _error(error) from error
    return account_out(account)


@router.post("/accounts/{account_id}/test")
async def test_account(account_id: str, session: Session, mail: Mail) -> dict[str, Any]:
    try:
        await mail.account(session, account_id)
    except EmailError as error:
        raise _error(error) from error
    return await mail.test_account(account_id)


@router.post("/accounts/{account_id}/sync")
async def sync(account_id: str, mail: Mail) -> dict[str, Any]:
    try:
        return await mail.sync(account_id)
    except EmailError as error:
        raise _error(error) from error


@router.post("/accounts/{account_id}/disconnect", status_code=204)
async def disconnect(account_id: str, body: Disconnect, session: Session, mail: Mail) -> None:
    try:
        await mail.disconnect(session, account_id, body.purge)
    except EmailError as error:
        raise _error(error) from error


@router.post("/accounts/{account_id}/oauth/start")
async def oauth_start(account_id: str, session: Session, mail: Mail) -> dict[str, str]:
    """The provider's sign-in page; it returns to /api/email/oauth/callback."""
    try:
        return {"url": await mail.start_oauth(session, account_id)}
    except (EmailError, OAuthError) as error:
        raise HTTPException(getattr(error, "status", 422), str(error)) from error


@router.get("/oauth/callback", include_in_schema=False)
async def oauth_callback(
    mail: Mail, state: str = "", code: str | None = None, error: str | None = None
) -> RedirectResponse:
    base = mail.settings.public_url.rstrip("/") + "/settings/email"
    try:
        account_id = await mail.finish_oauth(state, code, error)
    except (OAuthError, EmailError) as failure:
        query = urlencode({"oauth": "error", "message": str(failure)[:300]})
        return RedirectResponse(f"{base}?{query}", status_code=302)
    return RedirectResponse(f"{base}?{urlencode({'oauth': 'ok', 'account': account_id})}", 302)


# ----------------------------------------------------------------- messages


FOLDERS: dict[str, tuple[str, list[str]]] = {
    "approval": (
        "outbound",
        [EmailStatus.PENDING_APPROVAL, EmailStatus.DRAFTING, EmailStatus.DRAFT_FAILED],
    ),
    "outbox": (
        "outbound",
        [EmailStatus.APPROVED, EmailStatus.SENDING, EmailStatus.FAILED, EmailStatus.UNCERTAIN],
    ),
    "sent": ("outbound", [EmailStatus.SENT]),
    "rejected": ("outbound", [EmailStatus.REJECTED]),
    "inbox": ("inbound", [EmailStatus.RECEIVED]),
}


@router.get("/messages")
async def list_messages(
    session: Session,
    folder: str = "approval",
    account_id: str | None = None,
    q: str | None = None,
    limit: int = 100,
) -> list[dict[str, Any]]:
    if folder not in FOLDERS:
        raise HTTPException(422, f"Unknown folder '{folder}'.")
    direction, statuses = FOLDERS[folder]
    query = select(EmailMessage).where(
        EmailMessage.direction == direction, EmailMessage.status.in_(statuses)
    )
    if account_id:
        query = query.where(EmailMessage.account_id == account_id)
    if q and q.strip():
        like = f"%{q.strip()}%"
        query = query.where(
            or_(
                EmailMessage.subject.ilike(like),
                EmailMessage.from_address.ilike(like),
                EmailMessage.body.ilike(like),
            )
        )
    order = (
        EmailMessage.received_at.desc().nulls_last()
        if direction == "inbound"
        else EmailMessage.updated_at.desc()
    )
    rows = await session.scalars(
        query.order_by(order, EmailMessage.created_at.desc()).limit(max(1, min(limit, 500)))
    )
    return [message_out(m) for m in rows]


@router.get("/counts")
async def counts(session: Session) -> dict[str, int]:
    out: dict[str, int] = {}
    for folder, (direction, statuses) in FOLDERS.items():
        rows = await session.scalars(
            select(EmailMessage.id).where(
                EmailMessage.direction == direction, EmailMessage.status.in_(statuses)
            )
        )
        out[folder] = len(list(rows))
    return out


@router.get("/messages/{message_id}")
async def get_message(message_id: str, session: Session, mail: Mail) -> dict[str, Any]:
    try:
        return message_out(await mail.message(session, message_id))
    except EmailError as error:
        raise _error(error) from error


@router.post("/drafts", status_code=201)
async def create_draft(body: DraftCreate, session: Session, mail: Mail) -> dict[str, Any]:
    """A draft written by the owner. It still waits in the approval queue."""
    try:
        return message_out(await mail.create_draft(session, body.model_dump()))
    except EmailError as error:
        raise _error(error) from error


@router.post("/drafts/generate", status_code=202)
async def generate_draft(body: DraftGenerate, session: Session, mail: Mail) -> dict[str, Any]:
    """An AI employee writes the draft (status "drafting" until it is ready)."""
    try:
        return message_out(await mail.generate_draft(session, body.model_dump()))
    except EmailError as error:
        raise _error(error) from error


async def _act(coro: Any) -> dict[str, Any]:
    try:
        return message_out(await coro)
    except EmailError as error:
        raise _error(error) from error


@router.patch("/messages/{message_id}")
async def edit(message_id: str, body: DraftEdit, session: Session, mail: Mail) -> dict[str, Any]:
    """Edits a draft; it goes back to the approval queue."""
    return await _act(mail.edit(session, message_id, body.model_dump()))


@router.delete("/messages/{message_id}", status_code=204)
async def delete(message_id: str, session: Session, mail: Mail) -> None:
    try:
        await mail.delete(session, message_id)
    except EmailError as error:
        raise _error(error) from error


@router.post("/messages/{message_id}/approve")
async def approve(message_id: str, session: Session, mail: Mail) -> dict[str, Any]:
    """The owner approves this exact message; it is then sent."""
    return await _act(mail.approve(session, message_id))


@router.post("/messages/{message_id}/reject")
async def reject(message_id: str, body: Rejection, session: Session, mail: Mail) -> dict[str, Any]:
    return await _act(mail.reject(session, message_id, body.reason))


@router.post("/messages/{message_id}/redraft")
async def redraft(message_id: str, session: Session, mail: Mail) -> dict[str, Any]:
    return await _act(mail.redraft(session, message_id))


@router.post("/messages/{message_id}/retry")
async def retry(message_id: str, session: Session, mail: Mail) -> dict[str, Any]:
    """Sends a failed email again (it was definitely not delivered)."""
    return await _act(mail.retry(session, message_id))


@router.post("/messages/{message_id}/verify")
async def verify(message_id: str, mail: Mail) -> dict[str, Any]:
    """Uncertain send: looks for the email in the Sent folder."""
    try:
        return await mail.verify(message_id)
    except EmailError as error:
        raise _error(error) from error


@router.post("/messages/{message_id}/resend")
async def resend(message_id: str, body: Resend, session: Session, mail: Mail) -> dict[str, Any]:
    """Uncertain send: sends again only with explicit confirmation of a possible duplicate."""
    return await _act(mail.resend(session, message_id, body.confirm_possible_duplicate))


# ---------------------------------------------------------------------- log


@router.get("/log")
async def email_log(
    session: Session, account_id: str | None = None, message_id: str | None = None, limit: int = 200
) -> list[dict[str, Any]]:
    query = select(EmailEvent)
    if account_id:
        query = query.where(EmailEvent.account_id == account_id)
    if message_id:
        query = query.where(EmailEvent.message_id == message_id)
    rows = await session.scalars(
        query.order_by(EmailEvent.id.desc()).limit(max(1, min(limit, 1000)))
    )
    return [event_out(e) for e in rows]
