---
name: gmail
description: Read, search, and send Gmail emails. Uses saved browser session (login once, never asked again).
allowed-tools: bash_exec sys_info credentials_read credentials_save web_login browser_snapshot browser_setup browser_navigate browser_click browser_type browser_press_key
version: 4.2.0
---

# Gmail Skill — v4.2.0

## ABSOLUTE RULES — read before anything else

1. **NEVER call `browser_evaluate`** — it always fails. Never use it.
2. **NEVER call `browser_screenshot`** — useless, returns no data. Never use it.
3. **NEVER call `problem_solve`** for email reading steps — just follow this skill exactly.
4. **NEVER call `browser_wait_for`** unless you know the exact parameters.
5. If any step fails, go to the NEXT step in this skill. Do not loop. Do not retry more than once.

---

## Step 1 — Check login

```
web_login(service="gmail")
```

- `already_logged_in` → go to Step 3
- anything else → go to Step 2

## Step 2 — One-time manual login

```
browser_setup(service="gmail")
```

A browser window opens. User types email + password once. Session saved permanently. Then go to Step 3.

## Step 3 — Get Gmail inbox snapshot

```
browser_navigate(url="https://mail.google.com/mail/u/0/#inbox")
browser_snapshot()
```

## Step 4 — Extract emails FROM THE SNAPSHOT TEXT

**The snapshot IS the data. You do not need to click anything to see the email list.**

The snapshot accessibility tree contains email rows. Each row includes sender name, subject line, and date as plain text. Read the snapshot text and extract:
- Sender
- Subject
- Date/time
- The ref value of the row (looks like `e123`)

**Present the email list to the user immediately from the snapshot text.**

Example output:
```
Here are your latest emails:

[1] From: Google <no-reply@google.com>
    Subject: Security alert
    Date: Today, 10:30 AM

[2] From: Alice <alice@example.com>
    Subject: Meeting tomorrow
    Date: Yesterday
```

## Step 5 — Open a specific email (only if user asks for full content)

Find the ref of the email row in the snapshot (e.g. `e47`). Then:

```
browser_click(ref="e47")
browser_snapshot()
```

Read the snapshot and present the full email body text.

**If you cannot find the ref**, use keyboard navigation instead:
```
browser_press_key(key="j")
browser_press_key(key="o")
browser_snapshot()
```

---

## SEARCHING for emails

```
browser_navigate(url="https://mail.google.com/mail/u/0/#search/from:sender@example.com")
browser_snapshot()
```

Read email list from snapshot. Click ref to open if needed.

---

## SENDING EMAIL

1. `browser_navigate(url="https://mail.google.com/mail/u/0/#inbox")`
2. `browser_snapshot()` — find Compose button ref
3. `browser_click(ref="<compose ref>")` 
4. `browser_snapshot()` — find To/Subject/Body field refs
5. Click To field ref → `browser_type(text="recipient@example.com")`
6. Click Subject field ref → `browser_type(text="subject")`
7. Click Body field ref → `browser_type(text="body")`
8. `browser_snapshot()` — find Send button ref → click it

---

## FALLBACK: IMAP (only if browser login keeps failing)

```
credentials_read(service="gmail_imap")
```

If `found: true`:
```
sys_info() → pythonExe
bash_exec: "{pythonExe}" "{WORKSPACE}/scripts/gmail_imap.py" unread 5 "{email}" "{password}"
```

If `found: false` — do NOT ask for App Password. Report the browser error to the user.
