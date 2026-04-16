#!/usr/bin/env python3
"""
outlook_playwright.py — AAOS Outlook via Playwright browser automation
v1.0.0

No Azure app, no App Password, no API keys required.

Authentication:
  • First run  — opens a real browser window. User logs in with their normal
                 Microsoft email + password, exactly like outlook.com.
                 Browser session (cookies) are saved to disk automatically.
  • Every run after — fully headless, no user action ever again.
                 If the session expires (weeks/months later), the browser
                 window re-opens for a quick re-login.

Usage:
  python outlook_playwright.py recent  <n>
  python outlook_playwright.py unread  <n>
  python outlook_playwright.py search  <query> <n>
  python outlook_playwright.py read    <index>
  python outlook_playwright.py send    <to> <subject> <body>

All output is JSON to stdout.
"""

import sys
import os
import json
import argparse
import re
import time
from pathlib import Path

# ─── Browser executable ──────────────────────────────────────────────────────

def _find_edge() -> str | None:
    """Return the path to Microsoft Edge if installed (Windows only)."""
    candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    for p in candidates:
        if os.path.exists(p):
            return p
    return None


# ─── Paths ───────────────────────────────────────────────────────────────────

def _workspace() -> str:
    return os.environ.get("AAOS_WORKSPACE") or str(Path.home() / ".aaos")

def _profile_dir() -> str:
    d = os.path.join(_workspace(), "outlook_browser_profile")
    os.makedirs(d, exist_ok=True)
    return d

def _has_saved_session() -> bool:
    """True if the profile directory has existing browser data (cookies, etc.)."""
    d = _profile_dir()
    return any(os.scandir(d))  # non-empty directory → previous session exists


# ─── URL helpers ─────────────────────────────────────────────────────────────

OUTLOOK_START    = "https://outlook.live.com/mail/0/inbox"
OUTLOOK_O365     = "https://outlook.office365.com/mail/inbox"
LOGIN_SIGNATURES = ["login.microsoftonline.com", "login.live.com",
                    "login.microsoft.com", "account.live.com",
                    "account.microsoft.com"]
INBOX_SIGNATURES = ["outlook.live.com/mail", "outlook.office365.com/mail",
                    "outlook.office.com/mail"]

def _is_login(url: str) -> bool:
    return any(s in url for s in LOGIN_SIGNATURES)

def _is_inbox(url: str) -> bool:
    return any(s in url for s in INBOX_SIGNATURES)


# ─── Browser context factory ─────────────────────────────────────────────────

def _open_context(playwright, headless: bool):
    """
    Open a persistent browser context using Microsoft Edge (pre-installed on
    Windows 10/11). Saved cookies are loaded automatically so returning users
    are never asked to log in again.
    """
    edge_path = _find_edge()

    kwargs = dict(
        user_data_dir    = _profile_dir(),
        headless         = headless,
        viewport         = {"width": 1400, "height": 900},
        user_agent       = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0"
        ),
    )
    if edge_path:
        kwargs["executable_path"] = edge_path
    # NOTE: do NOT pass storage_state to launch_persistent_context —
    # it persists cookies automatically via user_data_dir.

    ctx  = playwright.chromium.launch_persistent_context(**kwargs)
    page = ctx.new_page()
    return ctx, page


# ─── Login / session management ──────────────────────────────────────────────

def _navigate_to_inbox(page) -> bool:
    """Navigate to Outlook inbox. Returns True if already authenticated."""
    try:
        page.goto(OUTLOOK_START, wait_until="domcontentloaded", timeout=30_000)
    except Exception:
        try:
            page.goto(OUTLOOK_O365, wait_until="domcontentloaded", timeout=30_000)
        except Exception:
            return False
    time.sleep(3)
    return _is_inbox(page.url) and not _is_login(page.url)


def _wait_for_login(page, timeout_s: int = 180) -> bool:
    """
    Block until the user completes login in the open browser window.
    Returns True on success, False on timeout.
    """
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        url = page.url
        if _is_inbox(url) and not _is_login(url):
            time.sleep(2)   # let the inbox fully render
            return True
        time.sleep(1)
    return False


def _save_session(ctx):
    """No-op: launch_persistent_context saves to user_data_dir automatically."""
    pass


# ─── Email scraping ───────────────────────────────────────────────────────────

_SCRAPE_JS = """
(maxCount) => {
    // OWA renders email rows as role="option" inside the message list.
    // Fallback to data-convid or listitem roles for alternate OWA builds.
    let rows = Array.from(document.querySelectorAll('[role="option"]'));
    if (rows.length === 0)
        rows = Array.from(document.querySelectorAll('[data-convid]'));
    if (rows.length === 0)
        rows = Array.from(document.querySelectorAll('[role="listitem"]'));

    rows = rows
        .filter(r => (r.innerText || '').trim().length > 5)
        .slice(0, maxCount);

    function txt(el, sel) {
        const n = el.querySelector(sel);
        return n ? (n.innerText || n.textContent || '').trim() : '';
    }

    return rows.map(row => {
        // Try to extract structured fields from child elements.
        // OWA uses many class-name variations across locales/versions,
        // so we try multiple selectors for each field.
        const sender = txt(row, '[class*="sender"],[class*="Sender"],[class*="from"],[class*="From"]')
                    || txt(row, '[class*="personName"],[class*="PersonName"]');
        const subject = txt(row, '[class*="subject"],[class*="Subject"],[class*="conversationSubject"]');
        const date    = txt(row, '[class*="date"],[class*="Date"],[class*="time"],[class*="Time"],[class*="received"]');
        const preview = txt(row, '[class*="preview"],[class*="Preview"],[class*="snippet"],[class*="Snippet"]');

        // Fallback: split innerText into lines
        const lines = (row.innerText || '').split('\\n').map(s => s.trim()).filter(s => s);

        return {
            sender:  sender  || lines[0] || '',
            subject: subject || lines[1] || '',
            date:    date    || lines[lines.length - 1] || '',
            preview: preview || lines.slice(2).join(' ').slice(0, 200) || '',
            aria:    row.getAttribute('aria-label') || '',
            convid:  row.getAttribute('data-convid') || ''
        };
    });
}
"""

def _parse_row(raw: dict, idx: int) -> dict:
    """Turn a raw scraped row into a clean structured email dict."""
    return {
        "index":   idx,
        "from":    raw.get("sender",  ""),
        "subject": raw.get("subject", ""),
        "date":    raw.get("date",    ""),
        "preview": raw.get("preview", ""),
        "convid":  raw.get("convid",  ""),
    }


def _scrape_inbox(page, count: int, unread_only: bool = False) -> list:
    """Return up to `count` emails from the already-loaded inbox page."""
    # Wait for email rows to appear (up to 15 s)
    for selector in ['[role="option"]', '[data-convid]', '[role="listitem"]']:
        try:
            page.wait_for_selector(selector, timeout=15_000)
            break
        except Exception:
            continue

    page.wait_for_timeout(1_500)   # let virtualised list settle

    raw_rows = page.evaluate(_SCRAPE_JS, count * 3)   # fetch extra in case some are read

    results = []
    for i, raw in enumerate(raw_rows):
        if unread_only:
            # OWA marks unread in aria-label with "Unread" or 未讀
            aria = raw.get("aria", "").lower()
            if "unread" not in aria and "未讀" not in aria:
                continue
        results.append(_parse_row(raw, len(results) + 1))
        if len(results) >= count:
            break

    return results


# ─── Commands ─────────────────────────────────────────────────────────────────

def _run(command: str, args: list) -> dict:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return {"error": "playwright not installed — run: pip install playwright && python -m playwright install chromium"}

    with sync_playwright() as pw:
        # ── Determine whether we need a visible browser ────────────────────
        headless    = _has_saved_session()   # silent if we have a saved profile
        ctx, page   = _open_context(pw, headless)

        try:
            already_in  = _navigate_to_inbox(page)

            if not already_in:
                if headless:
                    # Saved session expired — reopen visibly for re-login
                    ctx.close()
                    headless = False
                    ctx, page = _open_context(pw, headless)
                    _navigate_to_inbox(page)

                # Prompt user in AAOS chat
                print(json.dumps({
                    "status":  "login_required",
                    "message": "A browser window has opened. Please log in with "
                               "your Microsoft email and password. "
                               "You will never be asked again after this.",
                }), flush=True)

                if not _wait_for_login(page):
                    return {"error": "Login timed out (3 min). Please try again."}

                _save_session(ctx)

            # ── Dispatch command ───────────────────────────────────────────
            if command in ("recent", "unread"):
                n       = int(args[0]) if args else 5
                emails  = _scrape_inbox(page, n, unread_only=(command == "unread"))
                _save_session(ctx)
                return {"count": len(emails), "emails": emails}

            elif command == "search":
                if not args:
                    return {"error": "search requires: <query> [n]"}
                query = args[0]
                n     = int(args[1]) if len(args) > 1 else 5

                # Type query into OWA search box
                try:
                    page.click('[aria-label*="Search"], [placeholder*="Search"], [placeholder*="搜尋"]', timeout=5_000)
                    page.keyboard.type(query)
                    page.keyboard.press("Enter")
                    page.wait_for_timeout(3_000)
                except Exception:
                    return {"error": "Could not find OWA search box — try upgrading Outlook Web."}

                emails = _scrape_inbox(page, n)
                _save_session(ctx)
                return {"query": query, "count": len(emails), "emails": emails}

            elif command == "read":
                if not args:
                    return {"error": "read requires: <index>"}
                idx = int(args[0])

                # Click the nth email row to open it
                rows = page.query_selector_all('[role="option"]') or \
                       page.query_selector_all('[data-convid]')
                if not rows or idx > len(rows):
                    return {"error": f"Email index {idx} not found (only {len(rows)} visible)."}

                rows[idx - 1].click()
                page.wait_for_timeout(2_000)

                body = page.evaluate("""
                    () => {
                        // Reading pane body selectors
                        const sel = [
                            '[role="main"] [class*="body"]',
                            '[data-testid="messageBody"]',
                            '[class*="ReadingPaneContent"]',
                            '[aria-label*="Message body"]'
                        ];
                        for (const s of sel) {
                            const el = document.querySelector(s);
                            if (el) return el.innerText.slice(0, 2000);
                        }
                        return "(body not found — email may need to be opened manually)";
                    }
                """)
                _save_session(ctx)
                return {"index": idx, "body": body}

            elif command == "send":
                if len(args) < 3:
                    return {"error": "send requires: <to> <subject> <body>"}
                to, subject, body = args[0], args[1], args[2]

                # Open compose window
                try:
                    page.click('[aria-label*="New mail"], [aria-label*="Compose"], '
                               '[aria-label*="新郵件"]', timeout=8_000)
                    page.wait_for_timeout(1_500)
                except Exception:
                    return {"error": "Could not open compose window."}

                # Fill To
                page.fill('[aria-label="To"], [aria-label="收件者"]', to)
                page.keyboard.press("Tab")
                page.wait_for_timeout(500)

                # Fill Subject
                page.fill('[aria-label="Subject"], [aria-label="主旨"], [aria-label="Add a subject"]', subject)

                # Fill Body
                page.click('[aria-label="Message body"], [aria-label="郵件內文"], '
                           '[contenteditable="true"][class*="body"]')
                page.keyboard.type(body)

                # Send
                page.click('[aria-label="Send"], [aria-label="傳送"]', timeout=5_000)
                page.wait_for_timeout(1_500)
                _save_session(ctx)
                return {"sent": True, "to": to, "subject": subject}

            else:
                return {"error": f"Unknown command: {command}"}

        finally:
            ctx.close()


# ─── Entry point ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="AAOS Outlook Playwright tool")
    parser.add_argument("command",
                        choices=["recent", "unread", "search", "read", "send"])
    parser.add_argument("args", nargs="*")
    opts = parser.parse_args()

    try:
        result = _run(opts.command, opts.args)
        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
