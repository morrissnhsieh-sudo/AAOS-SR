#!/usr/bin/env python3
"""
outlook365_token_manager.py
Outlook 365 Skill — Token Manager (AAOS adaptation)

Handles loading, validating, and auto-refreshing OAuth tokens.
Used internally by outlook365_skill.py — not called directly.

Credentials are read from AAOS keyring (service="outlook365").
Token file defaults to AAOS workspace path.
"""

import os
import json
import time
import logging
import keyring
import json as _json
from pathlib import Path

import requests as _requests
import msal

log = logging.getLogger("outlook365-token")

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

# ─── TOKEN FILE PATH ──────────────────────────────────────────────────────────

_workspace = os.environ.get("AAOS_WORKSPACE") or os.path.join(
    os.environ.get("USERPROFILE") or os.path.expanduser("~"), ".aaos"
)
TOKEN_FILE = os.environ.get(
    "OUTLOOK_TOKEN_FILE",
    os.path.join(_workspace, ".outlook365_tokens.json")
)

# ─── SCOPES ───────────────────────────────────────────────────────────────────

SCOPES = [
    "Mail.Read",
    "Mail.Send",
    "Mail.ReadWrite",
    "offline_access",
    "User.Read",
]

# Buffer: refresh token 5 minutes before actual expiry
EXPIRY_BUFFER_SECONDS = 300

# ─── PROXY-SAFE HTTP CLIENT ──────────────────────────────────────────────────

def _make_http_client():
    s = _requests.Session()
    s.trust_env = False
    return s

# ─── TOKEN HELPERS ───────────────────────────────────────────────────────────

def _load_tokens() -> dict:
    """Load tokens from disk."""
    path = Path(TOKEN_FILE)
    if not path.exists():
        raise FileNotFoundError(
            f"Token file not found: {TOKEN_FILE}\n"
            f"Run scripts/outlook365_auth_setup.py to authorize the agent."
        )
    with open(path) as f:
        return json.load(f)

def _save_tokens(tokens: dict):
    """Save updated tokens to disk with secure permissions."""
    path = Path(TOKEN_FILE)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        json.dump(tokens, f, indent=2)
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass  # chmod may not work on Windows; non-critical

def _is_expired(tokens: dict) -> bool:
    """Check if access token is expired or about to expire."""
    acquired_at = tokens.get("acquired_at", 0)
    expires_in  = tokens.get("expires_in", 3600)
    expires_at  = acquired_at + expires_in - EXPIRY_BUFFER_SECONDS
    return time.time() >= expires_at

def _refresh(tokens: dict) -> dict:
    """Exchange refresh token for a new access token."""
    log.info("Access token expired — refreshing via refresh token...")

    refresh_token = tokens.get("refresh_token")
    if not refresh_token:
        raise ValueError(
            "No refresh token available. "
            "Run scripts/outlook365_auth_setup.py to re-authorize."
        )

    app = msal.ConfidentialClientApplication(
        CLIENT_ID,
        authority=f"https://login.microsoftonline.com/{TENANT_ID}",
        client_credential=CLIENT_SECRET,
        http_client=_make_http_client(),
    )

    result = app.acquire_token_by_refresh_token(refresh_token, scopes=SCOPES)

    if "error" in result:
        raise RuntimeError(
            f"Token refresh failed: {result.get('error_description', result['error'])}\n"
            f"Run scripts/outlook365_auth_setup.py to re-authorize."
        )

    # Update tokens — preserve refresh token if new one not issued
    tokens["access_token"] = result["access_token"]
    tokens["expires_in"]   = result.get("expires_in", 3600)
    tokens["acquired_at"]  = int(time.time())
    if "refresh_token" in result:
        tokens["refresh_token"] = result["refresh_token"]
        log.info("Refresh token rotated.")

    _save_tokens(tokens)
    log.info(f"Token refreshed. Expires in {tokens['expires_in'] // 60} minutes.")
    return tokens

# ─── PUBLIC API ───────────────────────────────────────────────────────────────

def get_access_token() -> str:
    """
    Get a valid access token. Auto-refreshes if expired.
    This is the main entry point used by outlook365_skill.py.
    """
    tokens = _load_tokens()

    if _is_expired(tokens):
        tokens = _refresh(tokens)

    return tokens["access_token"]

def get_token_info() -> dict:
    """Return token metadata without exposing actual token values."""
    try:
        tokens = _load_tokens()
        acquired_at = tokens.get("acquired_at", 0)
        expires_in  = tokens.get("expires_in", 3600)
        expires_at  = acquired_at + expires_in
        remaining   = max(0, expires_at - int(time.time()))

        return {
            "user_name":          tokens.get("user_name", "unknown"),
            "token_file":         TOKEN_FILE,
            "access_token_valid": not _is_expired(tokens),
            "expires_in_seconds": remaining,
            "has_refresh_token":  bool(tokens.get("refresh_token")),
            "scope":              tokens.get("scope", ""),
        }
    except FileNotFoundError:
        return {
            "status":  "not_authorized",
            "message": "Run scripts/outlook365_auth_setup.py to authorize."
        }

if __name__ == "__main__":
    # Quick test: print token info
    info = get_token_info()
    print(json.dumps(info, indent=2))
