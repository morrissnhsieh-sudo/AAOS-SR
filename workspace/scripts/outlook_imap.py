#!/usr/bin/env python3
"""
outlook_imap.py — AAOS Outlook / Office 365 IMAP reader/sender
v2.2.0 — credentials read from Windows Credential Manager (never passed as CLI args)
        default service name standardised to "outlookimap" (no underscore)

Usage:
  python outlook_imap.py unread  <n>                          --service <svc>
  python outlook_imap.py search  <query> <n>                  --service <svc>
  python outlook_imap.py read    <uid>                        --service <svc>
  python outlook_imap.py send    <to> <subject> <body>        --service <svc>

<svc> is the AAOS credential-manager service name (e.g. "outlookimap").
Credentials (email + password) are retrieved securely from the OS keyring —
they are NEVER passed on the command line.

All output is JSON to stdout.
"""

import imaplib
import smtplib
import email
import json
import sys
import ssl
import argparse
from email.header import decode_header
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

# Outlook/Office 365 IMAP and SMTP settings
IMAP_HOST = "outlook.office365.com"
IMAP_PORT = 993
SMTP_HOST = "smtp.office365.com"
SMTP_PORT = 587

KEYRING_NAMESPACE = "AAOS"


# ─── Credential loader ────────────────────────────────────────────────────────

def load_credentials(service: str) -> tuple[str, str]:
    """
    Read email + password from Windows Credential Manager via keyring.
    Raises RuntimeError with a user-friendly message on failure.
    """
    try:
        import keyring
    except ImportError:
        raise RuntimeError("keyring not installed — run: pip install keyring")

    raw = keyring.get_password(KEYRING_NAMESPACE, service.lower())
    if raw is None:
        raise RuntimeError(
            f"No credentials found for service '{service}'. "
            f"Use credentials_save(service='outlookimap', fields={{email:'...', password:'<app_password>'}}) to store them first."
        )
    try:
        fields = json.loads(raw)
    except Exception as e:
        raise RuntimeError(f"Corrupt credential data for '{service}': {e}")

    email_addr = fields.get("email") or fields.get("username")
    password   = fields.get("password") or fields.get("passwd")
    if not email_addr or not password:
        raise RuntimeError(
            f"Credentials for '{service}' are missing 'email' or 'password' fields. "
            f"Re-save with: credentials_save(service='outlookimap', fields={{email:'...', password:'<app_password>'}})"
        )
    return email_addr, password


# ─── Helpers ─────────────────────────────────────────────────────────────────

def decode_str(s):
    if not s:
        return ""
    parts = decode_header(s)
    result = []
    for fragment, enc in parts:
        if isinstance(fragment, bytes):
            result.append(fragment.decode(enc or "utf-8", errors="replace"))
        else:
            result.append(str(fragment))
    return " ".join(result).strip()


def get_body(msg):
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                payload = part.get_payload(decode=True)
                if payload:
                    return payload.decode(
                        part.get_content_charset() or "utf-8", errors="replace"
                    )[:500]
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            return payload.decode(
                msg.get_content_charset() or "utf-8", errors="replace"
            )[:500]
    return ""


def connect(email_addr, password):
    ctx = ssl.create_default_context()
    mail = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT, ssl_context=ctx)
    mail.login(email_addr, password)
    return mail


def fetch_emails(mail, uids):
    results = []
    for uid in uids:
        try:
            _, data = mail.fetch(uid, "(RFC822)")
            if not data or not data[0]:
                continue
            msg = email.message_from_bytes(data[0][1])
            results.append({
                "uid":     uid.decode() if isinstance(uid, bytes) else str(uid),
                "from":    decode_str(msg["from"]),
                "to":      decode_str(msg["to"]),
                "subject": decode_str(msg["subject"]),
                "date":    msg["date"] or "",
                "body":    get_body(msg),
            })
        except Exception as e:
            results.append({"uid": str(uid), "error": str(e)})
    return results


# ─── Commands ────────────────────────────────────────────────────────────────

def cmd_unread(n, email_addr, password):
    mail = connect(email_addr, password)
    mail.select("INBOX")
    _, msgs = mail.search(None, "UNSEEN")
    uids = msgs[0].split() if msgs[0] else []
    recent = uids[-n:] if len(uids) >= n else uids
    results = fetch_emails(mail, list(reversed(recent)))
    mail.close()
    mail.logout()
    return {"count": len(uids), "shown": len(results), "emails": results}


def cmd_search(query, n, email_addr, password):
    mail = connect(email_addr, password)
    mail.select("INBOX")
    _, msgs = mail.search(None, query)
    uids = msgs[0].split() if msgs[0] else []
    recent = uids[-n:] if len(uids) >= n else uids
    results = fetch_emails(mail, list(reversed(recent)))
    mail.close()
    mail.logout()
    return {"count": len(uids), "shown": len(results), "emails": results}


def cmd_read(uid, email_addr, password):
    mail = connect(email_addr, password)
    mail.select("INBOX")
    results = fetch_emails(mail, [uid.encode() if isinstance(uid, str) else uid])
    mail.close()
    mail.logout()
    return {"emails": results}


def cmd_send(email_addr, password, to, subject, body):
    msg = MIMEMultipart()
    msg["From"] = email_addr
    msg["To"] = to
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain", "utf-8"))

    ctx = ssl.create_default_context()
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as server:
        server.ehlo()
        server.starttls(context=ctx)
        server.login(email_addr, password)
        server.sendmail(email_addr, to, msg.as_string())
    return {"sent": True, "to": to, "subject": subject}


# ─── Entry point ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="AAOS Outlook IMAP tool")
    parser.add_argument("command", choices=["unread", "search", "read", "send"],
                        help="Action to perform")
    parser.add_argument("args", nargs="*",
                        help="Positional arguments for the command")
    parser.add_argument("--service", default="outlookimap",
                        help="AAOS credential-manager service name (default: outlookimap)")
    opts = parser.parse_args()

    try:
        email_addr, password = load_credentials(opts.service)
    except RuntimeError as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

    try:
        cmd  = opts.command
        args = opts.args

        if cmd == "unread":
            n = int(args[0]) if args else 5
            result = cmd_unread(n, email_addr, password)

        elif cmd == "search":
            if len(args) < 1:
                result = {"error": "search requires: <query> [n]"}
            else:
                query = args[0]
                n     = int(args[1]) if len(args) > 1 else 5
                result = cmd_search(query, n, email_addr, password)

        elif cmd == "read":
            if not args:
                result = {"error": "read requires: <uid>"}
            else:
                result = cmd_read(args[0], email_addr, password)

        elif cmd == "send":
            if len(args) < 3:
                result = {"error": "send requires: <to> <subject> <body>"}
            else:
                result = cmd_send(email_addr, password, args[0], args[1], args[2])

        else:
            result = {"error": f"Unknown command: {cmd}"}

        print(json.dumps(result, ensure_ascii=False, indent=2))

    except imaplib.IMAP4.error as e:
        err = str(e)
        err_up = err.upper()
        if "BASICAUTHBLOCKED" in err_up or "BASIC AUTH" in err_up:
            print(json.dumps({
                "error": "Microsoft has blocked basic IMAP authentication for this account.",
                "steps": [
                    "1. Enable IMAP: outlook.live.com → Settings → Mail → Sync email → IMAP On",
                    "2. Enable 2FA: account.microsoft.com/security → Two-step verification",
                    "3. Create App Password: account.microsoft.com/security → Advanced security → App passwords",
                    f"4. Re-save credentials: credentials_save(service='{opts.service}', fields={{email:'...', password:'<16-char app password>'}})",
                    "5. If still blocked: account needs OAuth 2.0 IMAP (ask AAOS to implement it)"
                ]
            }))
        elif "AUTHENTICATIONFAILED" in err_up or "LOGIN failed" in err_up:
            print(json.dumps({
                "error": "Authentication failed — wrong App Password.",
                "hint": (
                    "Create a new App Password at: account.microsoft.com/security "
                    "→ Advanced security options → App passwords. "
                    f"Then re-save: credentials_save(service='{opts.service}', "
                    "fields={email:'...', password:'<app_password>'})"
                )
            }))
        else:
            print(json.dumps({"error": f"IMAP error: {err}"}))
        sys.exit(1)

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
