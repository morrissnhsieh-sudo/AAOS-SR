---
name: playwright
description: "Persistent-session browser automation via the Playwright MCP server. Provides dedicated browser_* tools for navigation, clicking, typing, form filling, screenshots, accessibility snapshots, JavaScript evaluation, tab management, network inspection, and PDF export. Credentials are stored in Windows Credential Manager — never in plaintext files."
version: 2.0.0
metadata:
  {
    "openclaw":
      {
        "emoji": "🎭",
        "requires": { "bins": ["playwright-mcp"] },
        "install":
          [
            {
              "id": "npm-playwright-mcp",
              "kind": "npm",
              "package": "@playwright/mcp",
              "label": "Install Playwright MCP"
            },
            {
              "id": "playwright-install-chromium",
              "kind": "shell",
              "command": "npx playwright install chromium",
              "label": "Install Chromium browser"
            },
            {
              "id": "pip-keyring",
              "kind": "pip",
              "package": "keyring",
              "label": "Install keyring for Windows Credential Manager"
            }
          ]
      }
  }
---

# Playwright MCP Skill

Full browser automation using a **persistent Chromium session** managed by the
`@playwright/mcp` server. Credentials are stored once in **Windows Credential Manager**
(encrypted by the OS) — no YAML files, no manual password maintenance.

---

## ⚠️ Mandatory Rules

### Rule 1 — Use `web_login` for ALL authentication (never navigate + fill manually)
```
FOR ANY web service task (Gmail, Outlook, GitHub, etc.):
  1. web_login(service="gmail")             ← FIRST action, always
  2. Follow the _next field in the result
  3a. status="already_logged_in" → proceed with task directly ✅
  3b. status="logged_in"         → proceed with task directly ✅
  3c. status="need_credentials"  → ask user for BOTH email+password
                                    in ONE message → credentials_save
                                    → web_login again ✅

NEVER manually call browser_navigate + browser_fill for login.
NEVER ask "which method?" or ask for credentials before calling web_login.
```

### Rule 2 — After login, use browser_snapshot to read content
After `web_login` succeeds, call `browser_snapshot()` to read page content.
Never call `web_login` again if already logged in — it detects this automatically.

### Rule 3 — Screenshot instruction
After every `browser_screenshot()` call, embed the image in your reply:
```
![screenshot](/snapshots/pw_<timestamp>.png)
```

---

## Credential Lifecycle

```
First time accessing a service:
  web_login(service="gmail")
  → status: "need_credentials"
  → _next: "Ask user for BOTH email AND password in ONE message"
  → Ask: "To log in to Gmail, please provide your email address and password."
  → credentials_save(service="gmail", fields={email: "...", password: "..."})
  → web_login(service="gmail")   ← call again after saving
  → status: "logged_in" ✅

Every time after:
  web_login(service="gmail")
  → status: "already_logged_in"  ← session persists, no login needed ✅

Password changed:
  User says "update my Gmail password"
  → Ask: "Please provide your new Gmail password."
  → credentials_save(service="gmail", fields={email: "...", password: "<new>"})
  → Credentials Manager updated ✅  — AAOS uses new password from now on
```

---

## Gmail — Full Autonomous Workflow

```
# Step 1 — web_login handles everything (navigate + detect + credentials + fill form)
web_login(service="gmail")
# → status: "already_logged_in"  (most common — session persists)
# → status: "logged_in"          (first time or session expired)
# → status: "need_credentials"   (follow _next: ask user for BOTH fields at once)

# Step 2 — read inbox content
browser_snapshot()

# Step 3 — if 2FA shown (web_login _next field will indicate this)
# Ask user for the code → browser_fill → browser_click

# Step 4 — show inbox
browser_screenshot()
```

---

## Outlook 365 — Full Autonomous Workflow

```
# Step 1 — web_login handles everything
web_login(service="outlook365")
# → status: "already_logged_in"  or "logged_in"  or "need_credentials"
# Follow the _next field in the result for each case.

# Step 2 — read inbox
browser_snapshot()

# Step 3 — show inbox
browser_screenshot()
```

**Service aliases:** `"outlook365"`, `"outlook"`, `"microsoft"` — all resolve to the same credentials.

---

## Reading Emails

### List inbox (snapshot approach — no screenshot needed)
```
browser_navigate(url="https://mail.google.com")   # or outlook.office.com/mail
browser_wait_for(text="Inbox")
browser_snapshot()   ← returns structured list of emails with subjects, senders, dates
```

### Open a specific email
```
browser_snapshot()   ← get ref values for email rows
browser_click(ref=<ref of the email row>)
browser_wait_for(selector="[role=main]")
browser_snapshot()   ← read full email content
```

### Search emails
```
browser_fill(element="Search", value="invoice from Amazon")
browser_press_key(key="Enter")
browser_wait_for(selector=".zA")
browser_snapshot()
```

---

## Tool Reference

### Navigation
| Tool | Parameters |
|------|-----------|
| `browser_navigate` | `url` |
| `browser_navigate_back` | — |
| `browser_navigate_forward` | — |
| `browser_reload` | — |

### Page Inspection
| Tool | Parameters |
|------|-----------|
| `browser_snapshot` | — (returns full accessibility tree) |
| `browser_screenshot` | — (saves PNG → `/snapshots/pw_*.png`) |
| `browser_evaluate` | `expression` |
| `browser_network_requests` | — |
| `browser_console_messages` | — |

### Interaction
| Tool | Parameters |
|------|-----------|
| `browser_click` | `element` (description), `ref` (from snapshot) |
| `browser_fill` | `element`, `ref`, `value` |
| `browser_type` | `text` |
| `browser_select_option` | `element`, `ref`, `values` |
| `browser_check` / `browser_uncheck` | `element`, `ref` |
| `browser_press_key` | `key` (e.g. `"Enter"`, `"Tab"`, `"Escape"`) |
| `browser_hover` | `element`, `ref` |

### Tabs & Window
| Tool | Parameters |
|------|-----------|
| `browser_tab_list` | — |
| `browser_new_page` | `url` |
| `browser_tab_select` | `index` |
| `browser_close_page` | — |
| `browser_resize` | `width`, `height` |
| `browser_wait_for` | `text` or `selector` |
| `browser_pdf_save` | `filename` |

---

## When to Use vs Other Skills

| Scenario | Use |
|----------|-----|
| Simple page fetch / API call | `web_fetch` (faster) |
| Gmail / Outlook inbox | **This skill** |
| Any login-required web app | **This skill** |
| Custom scraping with Python logic | `browser` skill |
| Local file reading | `file_read` |

---

## Session Persistence

The Playwright browser uses profile `~/.aaos/playwright_profile/`.
Login sessions (cookies) survive AAOS restarts. Typical session lifetimes:
- **Gmail**: months (Google rarely forces re-login)
- **Outlook 365**: months (especially after clicking "Stay signed in")

When a session expires, AAOS detects the login page via `browser_snapshot()`,
reads credentials from Windows Credential Manager, and re-logs in automatically.
