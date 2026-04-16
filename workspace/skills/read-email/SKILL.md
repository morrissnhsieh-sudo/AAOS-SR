---
name: read-email
description: Read email from Gmail or Outlook. Routes to the correct skill based on the service.
allowed-tools: bash_exec sys_info credentials_read credentials_save web_login browser_snapshot browser_setup browser_navigate browser_click browser_type
version: 2.0.0
---

# Read Email Skill — v2.0.0

## Routing

| Service | Method |
|---------|--------|
| Gmail / Google Mail | Use the `gmail` skill — **browser session** (login once via browser, never asked again) |
| Outlook / Office 365 / outlook365 | Use the `outlook` skill — IMAP with App Password |

---

## For Gmail → use the `gmail` skill (browser-first)

Read and follow `{WORKSPACE}/skills\gmail\SKILL.md` exactly.

**Primary method: browser session** — call `web_login(service="gmail")` first.
- Already logged in → `browser_navigate` to inbox → `browser_snapshot` → click email ref → `browser_snapshot` for content
- Not logged in → call `browser_setup(service="gmail")` → user logs in once → session saved forever

**NEVER use browser_evaluate or browser_screenshot for Gmail.**
**NEVER call credentials_read or ask for App Password** unless the browser method fails completely.
**NEVER call problem_solve for routine email reading steps** — just follow the gmail skill steps.

---

## For Outlook / Office 365 / outlook365 → use the `outlook` skill (Playwright)

Read and follow `{WORKSPACE}/skills/outlook/SKILL.md` exactly.

Primary method: Playwright browser automation via `outlook_playwright.py`.
First run opens a browser for a one-time normal login; all subsequent runs are fully automatic.
**Do NOT use IMAP, App Password, or credentials_read/save for Outlook — those are obsolete.**
**Do NOT say browser login is impossible for Outlook — it works via Playwright.**

Alternatively, use the `outlook365` skill for full Graph API access (search, read, draft, send).
