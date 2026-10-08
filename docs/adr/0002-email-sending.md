# ADR 0002 — Company email: approval-gated, duplicate-safe sending

- **Status:** Accepted (Stage 9)
- **Date:** 2026-10-08

## Context

Stage 9 connects the company's real mailbox. Sending email is an external, irreversible
action: the owner must approve every message, a retry must never deliver the same email
twice, credentials must stay secret, and received mail is untrusted input that agents
must not obey. No sender address may be built in.

## Decisions

| Area | Choice | Why |
| --- | --- | --- |
| Sending service | **Brevo transactional API** (owner's choice, recommended in the UI); direct SMTP stays available | Better deliverability than sending straight from a personal mailbox, clear HTTP errors, a free plan (300/day) and an `idempotencyKey` per request. Brevo has no inbox, so inbox reading stays IMAP |
| Protocols | **SMTP + IMAP with Python's stdlib** (`smtplib`, `imaplib`, run in worker threads) | Works with every provider (Gmail, Microsoft 365, Yahoo, iCloud, Zoho, custom) without provider SDKs or paid APIs; no new runtime dependency |
| Sign-in | Password / app password, or **OAuth 2.0 authorization code + PKCE** with the owner's own Google/Microsoft app; XOAUTH2 for SMTP/IMAP | OAuth is required for Microsoft and preferred for Google; using the owner's own client keeps NEXUS free of shared credentials |
| Secrets | Fernet with `NEXUS_SECRET_KEY` (same as the NVIDIA key) | One local master key; nothing secret in the API, logs or browser |
| Approval | A backend state machine; only `pending_approval → approved` queues a send (atomic conditional UPDATE); edits withdraw approval | Approval can't be bypassed by a prompt, a double click or a concurrent request |
| Idempotency | Message-ID fixed at draft creation; a single worker claims `approved → sending`; auto-retry only when the server **definitely** didn't accept the message | SMTP has no idempotency key. The only unsafe moment is a connection lost during DATA; it becomes `uncertain` and needs the owner (check Sent by Message-ID, or confirm a resend) |
| Inbox | IMAP read-only, plain text, attachment names only | Untrusted content can't execute, track or change the mailbox |
| Testing | A local fake SMTP/IMAP server (`tests/fake_mail.py`, aiosmtpd as a dev dependency) | Every failure mode (reject, 4xx, dropped connection, bad login, OAuth) is tested without real mail |

## Consequences

- Brevo-sent mail is plain text; threading headers (In-Reply-To) are not passed to
  Brevo, so replies thread by subject only.
- Provider-specific APIs (Gmail API, Microsoft Graph) are not used. They could be added
  behind the same service later if a provider stops supporting SMTP/IMAP.
- A real provider connection needs the owner's own account; automated tests use the
  fake server only.
- OAuth sign-ins in progress live in memory: restarting the backend mid-sign-in means
  starting the sign-in again.
