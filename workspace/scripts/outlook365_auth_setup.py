#!/usr/bin/env python3
"""
outlook365_auth_setup.py
Outlook 365 Skill — One-Time Authorization Script (AAOS adaptation)

Run this ONCE to authorize the agent to access a user's Outlook 365 mailbox.
Opens a browser for the user to log in with their Microsoft account.
Saves Access Token + Refresh Token to the configured token file.

Credentials are read from AAOS keyring (service="outlook365").
Outputs JSON to stdout so AAOS can parse results.

Usage:
  python3 scripts/outlook365_auth_setup.py
  python3 scripts/outlook365_auth_setup.py --no-browser   # print URL manually
  python3 scripts/outlook365_auth_setup.py --token-file /custom/path/tokens.json

After this runs successfully, the skill operates autonomously.
The refresh token is valid for 90 days (rolling) and auto-renews.
"""

import os
import sys
import json
import time
import argparse
import webbrowser
import keyring
import json as _json
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from http.server import HTTPServer, BaseHTTPRequestHandler

import requests as _requests
import msal

# ─── AAOS CREDENTIAL LOADING ─────────────────────────────────────────────────

def _load_aaos_creds():
    raw = keyring.get_password("AAOS", "outlook365")
    if not raw:
        raise RuntimeError(
            "Outlook365 credentials not found. Run: "
            "credentials_save(service='outlook365', fields={"
            "client_id:'...', tenant_id:'...', client_secret:'...'})"
        )
    return _json.loads(raw)

_creds = _load_aaos_creds()
CLIENT_ID     = _creds.get("client_id", "")
TENANT_ID     = _creds.get("tenant_id", "common")
CLIENT_SECRET = _creds.get("client_secret", "")

# ─── CONFIG ───────────────────────────────────────────────────────────────────

REDIRECT_URI = os.getenv("OUTLOOK_REDIRECT_URI", "http://localhost:8400/callback")

_workspace = os.environ.get("AAOS_WORKSPACE") or os.path.join(
    os.environ.get("USERPROFILE") or os.path.expanduser("~"), ".aaos"
)
TOKEN_FILE = os.environ.get(
    "OUTLOOK_TOKEN_FILE",
    os.path.join(_workspace, ".outlook365_tokens.json")
)

SCOPES = [
    "Mail.Read",
    "Mail.Send",
    "Mail.ReadWrite",
    "offline_access",   # required for refresh tokens
    "User.Read",        # for /me endpoint
]

# ─── PROXY-SAFE HTTP CLIENT ──────────────────────────────────────────────────

def _make_http_client():
    s = _requests.Session()
    s.trust_env = False
    return s

# ─── AUTH CODE CAPTURE ────────────────────────────────────────────────────────

captured_code  = None
captured_error = None

class OAuthCallbackHandler(BaseHTTPRequestHandler):
    """Minimal HTTP server to capture OAuth callback."""

    def do_GET(self):
        global captured_code, captured_error
        params = parse_qs(urlparse(self.path).query)

        if "code" in params:
            captured_code = params["code"][0]
            body = b"<h2>Authorization successful!</h2><p>You can close this window.</p>"
        elif "error" in params:
            captured_error = params.get("error_description", ["Unknown error"])[0]
            body = f"<h2>Authorization failed</h2><p>{captured_error}</p>".encode()
        else:
            body = b"<h2>Unexpected response</h2>"

        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass  # suppress request logging

# ─── MAIN ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Outlook 365 One-Time Authorization")
    parser.add_argument("--no-browser", action="store_true",
                        help="Print URL instead of opening browser")
    parser.add_argument("--token-file", default=TOKEN_FILE,
                        help="Path to save tokens")
    args = parser.parse_args()

    # Validate config
    if not CLIENT_ID:
        print(json.dumps({"error": "client_id not found in AAOS keyring for outlook365"}),
              file=sys.stderr)
        sys.exit(1)
    if not CLIENT_SECRET:
        print(json.dumps({"error": "client_secret not found in AAOS keyring for outlook365"}),
              file=sys.stderr)
        sys.exit(1)

    # Signal start to AAOS
    print(json.dumps({
        "status":       "starting",
        "message":      "Opening browser for Microsoft login...",
        "redirect_uri": REDIRECT_URI,
    }), flush=True)

    # Build MSAL app (proxy-safe)
    app = msal.ConfidentialClientApplication(
        CLIENT_ID,
        authority=f"https://login.microsoftonline.com/{TENANT_ID}",
        client_credential=CLIENT_SECRET,
        http_client=_make_http_client(),
    )

    # Generate auth URL
    auth_url = app.get_authorization_request_url(
        SCOPES,
        redirect_uri=REDIRECT_URI,
        prompt="select_account",   # always show account picker
    )

    if not args.no_browser:
        webbrowser.open(auth_url)
    else:
        print(json.dumps({"status": "manual_url", "url": auth_url}), flush=True)

    # Start local callback server
    server = HTTPServer(("localhost", 8400), OAuthCallbackHandler)
    server.handle_request()  # handle exactly one request

    if captured_error:
        print(json.dumps({"error": f"Authorization failed: {captured_error}"}),
              file=sys.stderr)
        sys.exit(1)

    if not captured_code:
        print(json.dumps({"error": "No authorization code received."}),
              file=sys.stderr)
        sys.exit(1)

    # Exchange code for tokens
    result = app.acquire_token_by_authorization_code(
        captured_code,
        scopes=SCOPES,
        redirect_uri=REDIRECT_URI,
    )

    if "error" in result:
        print(json.dumps({
            "error": f"Token exchange failed: {result.get('error_description', result['error'])}"
        }), file=sys.stderr)
        sys.exit(1)

    # Extract token info
    access_token  = result["access_token"]
    refresh_token = result.get("refresh_token")
    expires_in    = result.get("expires_in", 3600)
    id_token      = result.get("id_token_claims", {})
    username      = id_token.get("preferred_username", "unknown")

    # Save tokens
    token_path = Path(args.token_file)
    token_path.parent.mkdir(parents=True, exist_ok=True)

    token_data = {
        "access_token":  access_token,
        "refresh_token": refresh_token,
        "expires_in":    expires_in,
        "acquired_at":   int(time.time()),
        "scope":         " ".join(SCOPES),
        "user_name":     username,
        "user_id":       id_token.get("oid", "unknown"),
    }

    with open(token_path, "w") as f:
        json.dump(token_data, f, indent=2)

    try:
        os.chmod(token_path, 0o600)
    except Exception:
        pass  # chmod may not work on Windows; non-critical

    # Signal success to AAOS
    print(json.dumps({
        "status":     "authorized",
        "user":       username,
        "token_file": str(token_path),
    }), flush=True)

if __name__ == "__main__":
    main()
