#!/usr/bin/env python3
"""
outlook365_skill.py
Outlook 365 Skill — Graph API Tools (AAOS adaptation)

Provides discrete, safe tools for AAOS agent use:
  - search_inbox(query, top, unread)
  - read_thread(message_id)
  - draft_response(message_id, content)
  - send_draft(draft_id)
  - send_email(to, subject, body)
  - list_drafts(top)
  - delete_draft(draft_id)
  - get_auth_status()

Run as CLI (for AAOS bash_exec calls):
  python3 scripts/outlook365_skill.py --tool search_inbox --query "invoice"
  python3 scripts/outlook365_skill.py --status
"""

import os
import sys
import json
import logging
import argparse
import requests
from typing import Optional

# Import token manager from same directory
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from outlook365_token_manager import get_access_token, get_token_info

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger("outlook365-skill")

GRAPH_BASE = "https://graph.microsoft.com/v1.0"

# ─── PROXY-SAFE SESSION ──────────────────────────────────────────────────────

_SESSION = requests.Session()
_SESSION.trust_env = False

# ─── HTTP HELPERS ─────────────────────────────────────────────────────────────

def _headers() -> dict:
    """Return auth headers with fresh access token."""
    return {
        "Authorization": f"Bearer {get_access_token()}",
        "Content-Type":  "application/json",
        "Accept":        "application/json",
    }

def _get(path: str, params: dict = None) -> dict:
    r = _SESSION.get(f"{GRAPH_BASE}{path}", headers=_headers(), params=params, timeout=30)
    r.raise_for_status()
    return r.json()

def _post(path: str, body: dict = None) -> dict:
    r = _SESSION.post(f"{GRAPH_BASE}{path}", headers=_headers(), json=body, timeout=30)
    r.raise_for_status()
    return r.json() if r.content else {"status": "ok", "code": r.status_code}

def _patch(path: str, body: dict) -> dict:
    r = _SESSION.patch(f"{GRAPH_BASE}{path}", headers=_headers(), json=body, timeout=30)
    r.raise_for_status()
    return r.json() if r.content else {"status": "ok"}

def _delete(path: str) -> dict:
    r = _SESSION.delete(f"{GRAPH_BASE}{path}", headers=_headers(), timeout=30)
    r.raise_for_status()
    return {"status": "deleted", "code": r.status_code}

# ─── TOOL 1: SEARCH INBOX ─────────────────────────────────────────────────────

def search_inbox(query: str, top: int = 10, unread: bool = False) -> list:
    """
    Search inbox by keyword, sender, or subject.

    Args:
        query:  Search string (e.g. "invoice from supplier", "meeting tomorrow").
                Pass empty string "" to list recent emails without filtering.
                Pass "isRead:false" (or use unread=True) to filter unread.
        top:    Maximum number of results to return (default 10, max 50)
        unread: Convenience flag — if True, filters to unread messages only.

    Returns:
        List of message summaries with id, subject, from, date, preview.

    Example:
        search_inbox("invoice from ABC supplier", top=5)
        search_inbox("", top=20)
        search_inbox("", top=10, unread=True)
    """
    top = min(top, 50)

    # Build effective query
    effective_query = query or ""
    if unread:
        effective_query = "isRead:false"
        if query:
            effective_query = f"{query} isRead:false"

    log.info(f"Searching inbox: '{effective_query}' (top={top})")

    params = {
        "$top":     top,
        "$select":  "id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments",
        "$orderby": "receivedDateTime desc",
    }
    if effective_query:
        params["$search"] = f'"{effective_query}"'

    try:
        data = _get("/me/messages", params=params)
        messages = data.get("value", [])
        log.info(f"Found {len(messages)} messages.")

        # Clean up for agent consumption
        return [{
            "id":              m["id"],
            "subject":         m.get("subject", "(no subject)"),
            "from":            m.get("from", {}).get("emailAddress", {}).get("address", "unknown"),
            "from_name":       m.get("from", {}).get("emailAddress", {}).get("name", ""),
            "received":        m.get("receivedDateTime", ""),
            "preview":         m.get("bodyPreview", "")[:200],
            "is_read":         m.get("isRead", False),
            "has_attachments": m.get("hasAttachments", False),
        } for m in messages]

    except requests.HTTPError as e:
        log.error(f"search_inbox failed: {e}")
        return {"error": str(e)}

# ─── TOOL 2: READ THREAD ──────────────────────────────────────────────────────

def read_thread(message_id: str) -> dict:
    """
    Read the full content of an email by its ID.
    Always call search_inbox first to get the message_id.

    Args:
        message_id: The email ID from search_inbox results.

    Returns:
        Full message with subject, from, to, body, date.

    Example:
        read_thread("AAMkAGI2NGVhZTVlLTI1OGMtNDI4...")
    """
    log.info(f"Reading message: {message_id[:16]}...")

    try:
        msg = _get(f"/me/messages/{message_id}", params={
            "$select": "id,subject,from,toRecipients,ccRecipients,body,"
                       "receivedDateTime,isRead,hasAttachments,importance,conversationId"
        })

        # Mark as read
        try:
            _patch(f"/me/messages/{message_id}", {"isRead": True})
        except Exception:
            pass  # Non-critical

        return {
            "id":              msg["id"],
            "conversation_id": msg.get("conversationId", ""),
            "subject":         msg.get("subject", "(no subject)"),
            "from":            msg.get("from", {}).get("emailAddress", {}),
            "to":              [r["emailAddress"] for r in msg.get("toRecipients", [])],
            "cc":              [r["emailAddress"] for r in msg.get("ccRecipients", [])],
            "received":        msg.get("receivedDateTime", ""),
            "importance":      msg.get("importance", "normal"),
            "body_type":       msg.get("body", {}).get("contentType", "text"),
            "body":            msg.get("body", {}).get("content", ""),
            "has_attachments": msg.get("hasAttachments", False),
        }

    except requests.HTTPError as e:
        log.error(f"read_thread failed: {e}")
        return {"error": str(e)}

# ─── TOOL 3: DRAFT RESPONSE ───────────────────────────────────────────────────

def draft_response(message_id: str, content: str,
                   content_type: str = "Text") -> dict:
    """
    Create a DRAFT reply to an existing message.
    Does NOT send — user must review and confirm before sending.
    This is the SAFE default for agent-generated replies.

    Args:
        message_id:   ID of the message to reply to.
        content:      Draft reply body text.
        content_type: "Text" or "HTML" (default: "Text")

    Returns:
        {"draft_id": "...", "status": "draft_created", "subject": "..."}

    Example:
        draft_response("AAMkAGI2...", "Thank you for your email...")
    """
    log.info(f"Creating draft reply for message: {message_id[:16]}...")

    try:
        # Create reply draft
        draft = _post(f"/me/messages/{message_id}/createReply")
        draft_id = draft["id"]

        # Update with agent-generated content
        _patch(f"/me/messages/{draft_id}", {
            "body": {
                "contentType": content_type,
                "content": content
            }
        })

        # Fetch draft to confirm
        saved = _get(f"/me/messages/{draft_id}", params={
            "$select": "id,subject,toRecipients,isDraft"
        })

        log.info(f"Draft created: {draft_id[:16]}...")
        return {
            "draft_id": draft_id,
            "status":   "draft_created",
            "subject":  saved.get("subject", ""),
            "to":       [r["emailAddress"]["address"]
                         for r in saved.get("toRecipients", [])],
            "note":     "Draft saved. Call send_draft(draft_id) to send after user review."
        }

    except requests.HTTPError as e:
        log.error(f"draft_response failed: {e}")
        return {"error": str(e)}

# ─── TOOL 3b: SEND DRAFT ──────────────────────────────────────────────────────

def send_draft(draft_id: str) -> dict:
    """
    Send a previously created draft.
    Only call after user has reviewed and confirmed the draft content.

    Args:
        draft_id: ID from draft_response() result.

    Returns:
        {"status": "sent"} or {"status": "failed", "error": "..."}
    """
    log.info(f"Sending draft: {draft_id[:16]}...")

    try:
        _SESSION.post(
            f"{GRAPH_BASE}/me/messages/{draft_id}/send",
            headers=_headers(),
            timeout=30
        ).raise_for_status()

        log.info("Draft sent successfully.")
        return {"status": "sent", "draft_id": draft_id}

    except requests.HTTPError as e:
        log.error(f"send_draft failed: {e}")
        return {"status": "failed", "error": str(e)}

# ─── TOOL 4: SEND EMAIL ───────────────────────────────────────────────────────

def send_email(to: list, subject: str, body: str,
               cc: list = None, body_type: str = "Text") -> dict:
    """
    Send a NEW email. Use sparingly.
    ALWAYS confirm with the user before calling this tool.
    Prefer draft_response for replies to existing messages.

    Args:
        to:        List of recipient email addresses.
        subject:   Email subject line.
        body:      Email body text.
        cc:        Optional list of CC addresses.
        body_type: "Text" or "HTML" (default: "Text")

    Returns:
        {"status": "sent"} or {"status": "failed", "error": "..."}

    Example:
        send_email(["manager@store.com"], "Stock Alert", "Shelf B2 is critical.")
    """
    log.info(f"Sending email to {to} — subject: '{subject}'")

    payload = {
        "message": {
            "subject": subject,
            "body": {
                "contentType": body_type,
                "content": body,
            },
            "toRecipients": [
                {"emailAddress": {"address": addr}} for addr in to
            ],
        },
        "saveToSentItems": True,
    }

    if cc:
        payload["message"]["ccRecipients"] = [
            {"emailAddress": {"address": addr}} for addr in cc
        ]

    try:
        r = _SESSION.post(
            f"{GRAPH_BASE}/me/sendMail",
            headers=_headers(),
            json=payload,
            timeout=30
        )
        r.raise_for_status()
        log.info("Email sent successfully.")
        return {"status": "sent", "to": to, "subject": subject}

    except requests.HTTPError as e:
        log.error(f"send_email failed: {e}")
        return {"status": "failed", "error": str(e)}

# ─── HELPER: LIST DRAFTS ──────────────────────────────────────────────────────

def list_drafts(top: int = 10) -> list:
    """List saved draft emails."""
    try:
        data = _get("/me/mailFolders/Drafts/messages", params={
            "$top": min(top, 50),
            "$select": "id,subject,toRecipients,createdDateTime,bodyPreview",
            "$orderby": "createdDateTime desc",
        })
        return [{
            "id":      m["id"],
            "subject": m.get("subject", "(no subject)"),
            "to":      [r["emailAddress"]["address"]
                        for r in m.get("toRecipients", [])],
            "created": m.get("createdDateTime", ""),
            "preview": m.get("bodyPreview", "")[:100],
        } for m in data.get("value", [])]
    except requests.HTTPError as e:
        return {"error": str(e)}

# ─── HELPER: DELETE DRAFT ─────────────────────────────────────────────────────

def delete_draft(draft_id: str) -> dict:
    """Delete a draft that should not be sent."""
    try:
        return _delete(f"/me/messages/{draft_id}")
    except requests.HTTPError as e:
        return {"error": str(e)}

# ─── HELPER: AUTH STATUS ──────────────────────────────────────────────────────

def get_auth_status() -> dict:
    """Check authorization status without exposing tokens."""
    return get_token_info()

# ─── CLI ──────────────────────────────────────────────────────────────────────

TOOLS = {
    "search_inbox":    search_inbox,
    "read_thread":     read_thread,
    "draft_response":  draft_response,
    "send_draft":      send_draft,
    "send_email":      send_email,
    "list_drafts":     list_drafts,
    "delete_draft":    delete_draft,
    "get_auth_status": get_auth_status,
}

def main():
    parser = argparse.ArgumentParser(description="Outlook 365 Skill")
    parser.add_argument("--tool",    help="Tool to call")
    parser.add_argument("--query",   help="search_inbox: query string")
    parser.add_argument("--top",     type=int, default=10)
    parser.add_argument("--unread",  action="store_true",
                        help="search_inbox: filter to unread messages only")
    parser.add_argument("--id",      help="message_id or draft_id")
    parser.add_argument("--content", help="draft_response: body content")
    parser.add_argument("--to",      help="send_email: comma-separated recipients")
    parser.add_argument("--subject", help="send_email: subject")
    parser.add_argument("--body",    help="send_email: body text")
    parser.add_argument("--status",  action="store_true", help="Show auth status")
    args = parser.parse_args()

    if args.status or args.tool == "get_auth_status":
        result = get_auth_status()
        print(json.dumps(result, indent=2))
        return

    if not args.tool:
        print("Available tools:", list(TOOLS.keys()))
        print("Usage: python3 outlook365_skill.py --tool search_inbox --query 'invoice'")
        return

    if args.tool == "search_inbox":
        result = search_inbox(args.query or "", args.top, unread=args.unread)
    elif args.tool == "read_thread":
        result = read_thread(args.id)
    elif args.tool == "draft_response":
        result = draft_response(args.id, args.content or "")
    elif args.tool == "send_draft":
        result = send_draft(args.id)
    elif args.tool == "send_email":
        to = [addr.strip() for addr in (args.to or "").split(",")]
        result = send_email(to, args.subject or "", args.body or "")
    elif args.tool == "list_drafts":
        result = list_drafts(args.top)
    elif args.tool == "delete_draft":
        result = delete_draft(args.id)
    else:
        result = {"error": f"Unknown tool: {args.tool}"}

    print(json.dumps(result, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    main()
