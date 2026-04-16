---
name: gog
description: DEPRECATED — gog CLI is not installed. For Gmail use the email skill (web_login + browser). For Google Calendar use the calendar skill. For Drive/Contacts use web_login + browser_navigate.
allowed-tools: web_login browser_navigate browser_snapshot browser_click browser_fill browser_type browser_press_key
version: 2.0.0
---

# gog — DEPRECATED

The `gog` CLI is **not installed** on this system. Do NOT call `bash_exec` with `gog` commands.

Use these replacements instead:

| Old gog command | Replacement |
|----------------|-------------|
| `gog gmail search …` | Use the **email skill**: `web_login(service="gmail")` → `browser_snapshot()` |
| `gog gmail send …` | Use the **email skill**: browser Compose flow |
| `gog calendar events …` | Use the **calendar skill**: `web_login(service="gmail")` → `browser_navigate(url="https://calendar.google.com")` |
| `gog drive search …` | `web_login(service="gmail")` → `browser_navigate(url="https://drive.google.com")` → `browser_snapshot()` |
| `gog contacts list …` | `web_login(service="gmail")` → `browser_navigate(url="https://contacts.google.com")` → `browser_snapshot()` |

**If you see a gog command in a plan, discard it and use the browser-based approach instead.**
