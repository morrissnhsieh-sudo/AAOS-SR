---
name: outlook
description: Read, search, and send Outlook / Office 365 emails using IMAP (reliable, no browser). Falls back to browser if needed.
allowed-tools: bash_exec sys_info credentials_read credentials_save web_login browser_snapshot browser_setup
version: 2.0.0
---

# Outlook / Office 365 Skill — v2.0.0

## Overview

Read and send Outlook email using **IMAP/SMTP** — same approach as Gmail IMAP skill.
No browser, no bot-detection, no OAuth loops.

---

## PRIMARY METHOD: IMAP (always try first)

### Step 1 — Check credentials

```
credentials_read(service="outlook_imap")
```

- `found: true` → proceed to Step 3 with `{email}` and `{password}`.
- `found: false` → Step 2 (one-time setup).

### Step 2 — One-time setup

Tell the user:

> "Outlook IMAP needs a Microsoft App Password — a special password for email clients.
>
> Please:
> 1. Go to **https://account.microsoft.com/security**
> 2. Click **Advanced security options**
> 3. Under **App passwords**, click **Create a new app password**
> 4. Copy the generated password
>
> Tell me that password and I'll save it — you'll never be asked again."

After user replies:
```
credentials_save(service="outlook_imap", fields={email: "<their_email>", password: "<app_password>"})
```

### Step 3 — Run the IMAP script

Get Python path:
```
sys_info()  → pythonExe
```

Read unread emails:
```
bash_exec: "{pythonExe}" "{WORKSPACE}/scripts/outlook_imap.py" unread {N} "{email}" "{password}"
```

Search:
```
bash_exec: "{pythonExe}" "{WORKSPACE}/scripts/outlook_imap.py" search "FROM \"someone@example.com\"" {N} "{email}" "{password}"
```

Send:
```
bash_exec: "{pythonExe}" "{WORKSPACE}/scripts/outlook_imap.py" send "{email}" "{password}" "{to}" "{subject}" "{body}"
```

### Step 4 — Present results

Parse JSON output and present clearly:
```
[1] From: Alice <alice@co.com>
    Subject: Meeting tomorrow
    Date: Wed, 15 Apr 2026 09:00:00 +0800
    Preview: Hi, confirming the 10am meeting...
```

---

## ⚠️ WHY BROWSER DOES NOT WORK FOR OUTLOOK

Microsoft Outlook's web app uses MSAL.js with `sessionStorage` for auth tokens.
`sessionStorage` is **always cleared** when the browser process exits.
This means **no browser session can ever be persisted** across browser launches.
`web_login` and `browser_setup` will ALWAYS fail for Outlook — do not attempt them.

**IMAP with App Password is the ONLY reliable method for Outlook.**

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `Authentication failed` | Create/re-create App Password at account.microsoft.com/security |
| `IMAP not enabled` | Outlook Settings → Mail → Sync email → toggle IMAP on |
| `LOGIN failed` | Same as authentication failed — check App Password |
