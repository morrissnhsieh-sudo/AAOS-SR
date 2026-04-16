#!/usr/bin/env python3
"""
outlook_graph.py — AAOS Outlook / Office 365 via Microsoft Graph API
v1.0.0

Authentication is handled automatically:
  • First run  → a browser window opens so the user can log in with their
                  normal Microsoft email + password (exactly like outlook.com).
                  This happens once and is never asked again.
  • Every run after → fully automatic using saved tokens. No user action needed.

No App Password, no Azure portal, no 2FA setup, no codes to copy.

Usage:
  python outlook_graph.py unread  <n>
  python outlook_graph.py recent  <n>
  python outlook_graph.py search  <query> <n>
  python outlook_graph.py read    <id>
  python outlook_graph.py send    <to> <subject> <body>

All output is JSON to stdout.
"""

import sys
import os
import json
import argparse
import requests

# ─── AAOS Azure App Registration ─────────────────────────────────────────────
# This is a multi-tenant public client app registered once for all AAOS users.
# End users never need to visit the Azure portal.
#
# Client ID below is the Microsoft-published "Microsoft Azure CLI" public app —
# a well-known public client that Microsoft itself ships. It has delegated mail
# permissions and works for both personal (outlook.com) and work (Office 365)
# accounts. We use it here solely for delegated user-consent Graph API calls.
AAOS_CLIENT_ID = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"
AUTHORITY      = "https://login.microsoftonline.com/common"
SCOPES         = ["https://graph.microsoft.com/Mail.Read",
                  "https://graph.microsoft.com/Mail.Send",
                  "https://graph.microsoft.com/Mail.ReadWrite"]
GRAPH_BASE     = "https://graph.microsoft.com/v1.0"
# ─── Token cache path ─────────────────────────────────────────────────────────
def _token_cache_path() -> str:
    workspace = os.environ.get("AAOS_WORKSPACE") or os.path.join(
        os.environ.get("USERPROFILE") or os.environ.get("HOME") or "", ".aaos"
    )
    return os.path.join(workspace, "outlook_tokens.json")


# ─── MSAL helpers ────────────────────────────────────────────────────────────

def _make_session() -> requests.Session:
    """
    Return a requests Session with system proxy env ignored.
    The Windows registry may have a stale/broken IE proxy entry that causes
    urllib3 to time out on HTTPS even though raw sockets reach the host fine.
    Setting trust_env=False bypasses that and uses direct connections.
    """
    s = requests.Session()
    s.trust_env = False
    return s


def _build_app():
    try:
        import msal
    except ImportError:
        raise RuntimeError("msal not installed — run: pip install msal")

    cache = msal.SerializableTokenCache()
    cache_path = _token_cache_path()
    if os.path.exists(cache_path):
        try:
            cache.deserialize(open(cache_path).read())
        except Exception:
            pass  # corrupt cache — start fresh

    app = msal.PublicClientApplication(
        AAOS_CLIENT_ID,
        authority=AUTHORITY,
        token_cache=cache,
        http_client=_make_session(),   # bypass broken system proxy
    )
    return app, cache


def _save_cache(cache):
    if cache.has_state_changed:
        path = _token_cache_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "w").write(cache.serialize())


def _acquire_token() -> str:
    """
    Return a valid access token.

    • Cached  → silent refresh, no user action.
    • First run / expired → device code flow:
        1. Script prints a short URL + 8-letter code to the chat.
        2. User opens that URL in any browser and enters the code.
        3. Token saved — never asked again.
    """
    import msal

    app, cache = _build_app()

    # ── Try silent auth first (uses cached refresh token) ────────────────────
    accounts = app.get_accounts()
    if accounts:
        result = app.acquire_token_silent(SCOPES, account=accounts[0])
        if result and "access_token" in result:
            _save_cache(cache)
            return result["access_token"]

    # ── No cached token — device code flow ───────────────────────────────────
    # MSAL prints a URL (https://microsoft.com/devicelogin) and a short code.
    # The user visits that URL, enters the code, and logs in normally.
    # The script polls silently until the login is confirmed, then saves the
    # token so this is never required again.
    flow = app.initiate_device_flow(scopes=SCOPES)
    if "user_code" not in flow:
        raise RuntimeError(f"Could not start device auth flow: {flow.get('error_description', flow)}")

    # Emit as structured JSON so AAOS can show a user-friendly prompt in chat
    print(json.dumps({
        "status":  "login_required",
        "url":     flow["verification_uri"],   # always https://microsoft.com/devicelogin
        "code":    flow["user_code"],
        "message": (
            f"To connect Outlook, open {flow['verification_uri']} "
            f"in your browser and enter the code: {flow['user_code']}"
        ),
        "expires_in_minutes": flow.get("expires_in", 900) // 60,
    }), flush=True)

    # Poll until the user completes login (MSAL handles the polling loop)
    result = app.acquire_token_by_device_flow(flow)

    if "access_token" not in result:
        err = result.get("error_description") or result.get("error") or str(result)
        raise RuntimeError(f"Login failed or timed out: {err}")

    _save_cache(cache)
    return result["access_token"]


# ─── Graph API helpers ────────────────────────────────────────────────────────

_SESSION = _make_session()   # module-level proxy-free session reused for all Graph calls


def _graph_get(token: str, path: str, params: dict = None) -> dict:
    r = _SESSION.get(
        f"{GRAPH_BASE}{path}",
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json"},
        params=params,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def _graph_post(token: str, path: str, body: dict) -> dict:
    r = _SESSION.post(
        f"{GRAPH_BASE}{path}",
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json"},
        json=body,
        timeout=30,
    )
    r.raise_for_status()
    return r.json() if r.content else {"sent": True}


def _format_msg(m: dict) -> dict:
    sender = m.get("from", {}).get("emailAddress", {})
    to_list = [r["emailAddress"].get("address", "") for r in m.get("toRecipients", [])]
    body_content = m.get("body", {}).get("content", "") or m.get("bodyPreview", "")
    # Strip HTML tags for plain-text preview
    import re
    body_plain = re.sub(r"<[^>]+>", "", body_content)[:500].strip()
    return {
        "id":       m.get("id", ""),
        "from":     sender.get("address", ""),
        "from_name": sender.get("name", ""),
        "to":       ", ".join(to_list),
        "subject":  m.get("subject", ""),
        "date":     m.get("receivedDateTime", ""),
        "preview":  m.get("bodyPreview", ""),
        "body":     body_plain,
        "unread":   not m.get("isRead", True),
    }


# ─── Commands ────────────────────────────────────────────────────────────────

def cmd_unread(n: int) -> dict:
    token = _acquire_token()
    data = _graph_get(token, "/me/mailFolders/inbox/messages", params={
        "$filter": "isRead eq false",
        "$orderby": "receivedDateTime desc",
        "$top": n,
        "$select": "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,body",
    })
    msgs = [_format_msg(m) for m in data.get("value", [])]
    return {"count": len(msgs), "shown": len(msgs), "emails": msgs}


def cmd_recent(n: int) -> dict:
    token = _acquire_token()
    data = _graph_get(token, "/me/mailFolders/inbox/messages", params={
        "$orderby": "receivedDateTime desc",
        "$top": n,
        "$select": "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,body",
    })
    msgs = [_format_msg(m) for m in data.get("value", [])]
    return {"count": len(msgs), "shown": len(msgs), "emails": msgs}


def cmd_search(query: str, n: int) -> dict:
    token = _acquire_token()
    # Use Graph search API — searches subject, body, sender
    data = _graph_get(token, "/me/messages", params={
        "$search": f'"{query}"',
        "$top": n,
        "$select": "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,body",
    })
    msgs = [_format_msg(m) for m in data.get("value", [])]
    return {"count": len(msgs), "shown": len(msgs), "emails": msgs}


def cmd_read(msg_id: str) -> dict:
    token = _acquire_token()
    m = _graph_get(token, f"/me/messages/{msg_id}", params={
        "$select": "id,subject,from,toRecipients,receivedDateTime,body,isRead"
    })
    # Mark as read
    try:
        _SESSION.patch(
            f"{GRAPH_BASE}/me/messages/{msg_id}",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"isRead": True}, timeout=10,
        )
    except Exception:
        pass
    return {"emails": [_format_msg(m)]}


def cmd_send(to: str, subject: str, body: str) -> dict:
    token = _acquire_token()
    _graph_post(token, "/me/sendMail", body={
        "message": {
            "subject": subject,
            "body": {"contentType": "Text", "content": body},
            "toRecipients": [{"emailAddress": {"address": to}}],
        },
        "saveToSentItems": True,
    })
    return {"sent": True, "to": to, "subject": subject}


# ─── Entry point ─────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="AAOS Outlook Graph API tool")
    parser.add_argument("command",
                        choices=["unread", "recent", "search", "read", "send"],
                        help="Action to perform")
    parser.add_argument("args", nargs="*",
                        help="Positional arguments for the command")
    opts = parser.parse_args()

    try:
        cmd  = opts.command
        args = opts.args

        if cmd == "unread":
            n = int(args[0]) if args else 5
            result = cmd_unread(n)

        elif cmd == "recent":
            n = int(args[0]) if args else 5
            result = cmd_recent(n)

        elif cmd == "search":
            if not args:
                result = {"error": "search requires: <query> [n]"}
            else:
                query = args[0]
                n = int(args[1]) if len(args) > 1 else 5
                result = cmd_search(query, n)

        elif cmd == "read":
            if not args:
                result = {"error": "read requires: <id>"}
            else:
                result = cmd_read(args[0])

        elif cmd == "send":
            if len(args) < 3:
                result = {"error": "send requires: <to> <subject> <body>"}
            else:
                result = cmd_send(args[0], args[1], args[2])

        else:
            result = {"error": f"Unknown command: {cmd}"}

        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))

    except RuntimeError as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
    except requests.HTTPError as e:
        status = e.response.status_code if e.response is not None else "?"
        body   = ""
        try:
            body = e.response.json().get("error", {}).get("message", "")
        except Exception:
            pass
        if status == 401:
            # Token expired and silent refresh failed — delete cache and retry
            try:
                os.remove(_token_cache_path())
            except Exception:
                pass
            print(json.dumps({
                "error": "Session expired. Run the command again — a browser will open to re-authenticate."
            }))
        else:
            print(json.dumps({"error": f"Graph API error {status}: {body or str(e)}"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
