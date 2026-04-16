---
name: calendar
description: View, create and update Google Calendar events via browser automation. Use web_login then browser tools. Never use gog CLI.
allowed-tools: web_login browser_navigate browser_snapshot browser_click browser_fill browser_type browser_press_key browser_wait_for browser_screenshot
version: 2.0.0
---

# Calendar Skill — Browser Automation

All Google Calendar operations use `web_login` + Playwright browser tools.
**Never use `gog` or any CLI.**

---

## Step 1 — Always start with web_login

```
web_login(service="gmail")
→ already_logged_in or logged_in → proceed
→ need_credentials              → follow _next instructions
```

Then navigate to Calendar:
```
browser_navigate(url="https://calendar.google.com")
browser_snapshot()    ← read calendar content
```

---

## List Upcoming Events

```
web_login(service="gmail")
browser_navigate(url="https://calendar.google.com")
browser_snapshot()    ← shows today's events and upcoming schedule
```

Parse snapshot to report: event title, date/time, location if present.

---

## Create an Event

```
web_login(service="gmail")
browser_navigate(url="https://calendar.google.com")
browser_click(element="Create")                       ← or ref from snapshot
browser_fill(ref=<title-ref>, value="Event Title")
browser_fill(ref=<date-ref>, value="2026-04-20")
browser_fill(ref=<time-ref>, value="10:00 AM")
# Show user the details and confirm before saving
browser_click(element="Save")
```

**Always confirm** date, time, and title with the user before saving.

---

## Navigate to a Specific Date

```
browser_navigate(url="https://calendar.google.com/calendar/r/week/2026/4/20")
browser_snapshot()
```

---

## Guidelines

- **Always call `web_login(service="gmail")` first** — sessions persist, usually no login needed
- **Always confirm** before creating or modifying events
- Present events cleanly: title, date, time, location
- If browser action fails → call `browser_screenshot` to diagnose
