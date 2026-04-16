#!/usr/bin/env python3
"""
gmail_imap.py — AAOS Gmail IMAP reader/sender

Uses Python's built-in imaplib + smtplib (no external packages needed).
Requires a Google App Password (NOT your regular password).

Usage:
  python gmail_imap.py unread   <n> <email> <app_password>
  python gmail_imap.py search   <query> <n> <email> <app_password>
  python gmail_imap.py read     <uid> <email> <app_password>
  python gmail_imap.py send     <email> <app_password> <to> <subject> <body>

All output is JSON to stdout.
"""

import imaplib
import smtplib
import email
import json
import sys
import ssl
from email.header import decode_header
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart


# ─── Helpers ─────────────────────────────────────────────────────────────────

def decode_str(s):
    """Decode a possibly-encoded email header string to plain text."""
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
    """Extract plain-text body (first 500 chars)."""
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
    """Connect and authenticate via IMAP SSL."""
    ctx = ssl.create_default_context()
    mail = imaplib.IMAP4_SSL("imap.gmail.com", 993, ssl_context=ctx)
    mail.login(email_addr, password)
    return mail


def fetch_emails(mail, uids):
    """Fetch a list of email UIDs and return structured dicts."""
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
    """Return the N most-recent UNREAD emails from the inbox."""
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
    """Search inbox with an IMAP query string (e.g. 'FROM "boss@co.com"')."""
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
    """Read a single email by UID and mark it as read."""
    mail = connect(email_addr, password)
    mail.select("INBOX")
    results = fetch_emails(mail, [uid.encode()])
    # Mark as read
    mail.store(uid.encode(), "+FLAGS", "\\Seen")
    mail.close()
    mail.logout()
    return results[0] if results else {"error": "Email not found"}


def cmd_send(email_addr, password, to, subject, body):
    """Send a plain-text email via Gmail SMTP."""
    msg = MIMEMultipart()
    msg["From"] = email_addr
    msg["To"] = to
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain", "utf-8"))

    ctx = ssl.create_default_context()
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ctx) as server:
        server.login(email_addr, password)
        server.sendmail(email_addr, to, msg.as_string())
    return {"sent": True, "to": to, "subject": subject}


# ─── Entry point ─────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No command given. Use: unread|search|read|send"}))
        sys.exit(1)

    cmd = sys.argv[1]

    try:
        if cmd == "unread":
            n          = int(sys.argv[2])
            email_addr = sys.argv[3]
            password   = sys.argv[4]
            result = cmd_unread(n, email_addr, password)

        elif cmd == "search":
            query      = sys.argv[2]
            n          = int(sys.argv[3])
            email_addr = sys.argv[4]
            password   = sys.argv[5]
            result = cmd_search(query, n, email_addr, password)

        elif cmd == "read":
            uid        = sys.argv[2]
            email_addr = sys.argv[3]
            password   = sys.argv[4]
            result = cmd_read(uid, email_addr, password)

        elif cmd == "send":
            email_addr = sys.argv[2]
            password   = sys.argv[3]
            to         = sys.argv[4]
            subject    = sys.argv[5]
            body       = sys.argv[6]
            result = cmd_send(email_addr, password, to, subject, body)

        else:
            result = {"error": f"Unknown command: {cmd}"}

        print(json.dumps(result, ensure_ascii=False, indent=2))

    except imaplib.IMAP4.error as e:
        err = str(e)
        if "AUTHENTICATIONFAILED" in err or "Invalid credentials" in err:
            print(json.dumps({
                "error": "Authentication failed",
                "hint": "Gmail IMAP requires a Google App Password, not your regular password. "
                        "Create one at: https://myaccount.google.com/apppasswords"
            }))
        else:
            print(json.dumps({"error": f"IMAP error: {err}"}))
        sys.exit(1)

    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
