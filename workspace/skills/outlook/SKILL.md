---
name: outlook
description: Read, search, and send Outlook / Office 365 emails using IMAP. Credentials are read securely from Windows Credential Manager — never passed on the command line.
allowed-tools: bash_exec sys_info credentials_read credentials_save
version: 3.0.0
---

# Outlook / Office 365 Skill — v3.0.0

## Overview

Read and send Outlook email using **IMAP/SMTP**.
The script reads credentials from Windows Credential Manager internally — the password is **never** passed as a CLI argument.

---

## Step 1 — Check credentials

```
credentials_read(service="outlookimap")
```

- `found: true` → proceed to Step 3.
- `found: false` → Step 2 (one-time setup).

---

## Step 2 — One-time setup (only if credentials not found)

Tell the user:

> "Outlook IMAP needs a Microsoft App Password.
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
credentials_save(service="outlookimap", fields={"email": "<their_email>", "password": "<app_password>"})
```

---

## Step 3 — Run the IMAP script

Get the Python executable:
```
sys_info()  → use pythonExe field
```

**Read unread emails (N = number to fetch):**
```
bash_exec: "{pythonExe}" "{WORKSPACE}/scripts/outlook_imap.py" unread {N} --service outlookimap
```

**Search emails:**
```
bash_exec: "{pythonExe}" "{WORKSPACE}/scripts/outlook_imap.py" search "FROM \"someone@example.com\"" {N} --service outlookimap
```

**Read a specific email by UID:**
```
bash_exec: "{pythonExe}" "{WORKSPACE}/scripts/outlook_imap.py" read {uid} --service outlookimap
```

**Send an email:**
```
bash_exec: "{pythonExe}" "{WORKSPACE}/scripts/outlook_imap.py" send "{to}" "{subject}" "{body}" --service outlookimap
```

> ⚠️ NEVER pass email address or password as command-line arguments.
> The script reads them from Windows Credential Manager via `--service`.

---

## Step 4 — Present results

Parse JSON output and present clearly:
```
[1] From: Alice <alice@co.com>
    Subject: Meeting tomorrow
    Date: Wed, 15 Apr 2026 09:00:00 +0800
    Preview: Hi, confirming the 10am meeting...
```

---

## ⚠️ WHY BROWSER DOES NOT WORK FOR OUTLOOK

Microsoft Outlook uses MSAL.js with `sessionStorage` for auth tokens.
`sessionStorage` is **always cleared** when the browser process exits — auth cannot be persisted.
`web_login` and `browser_setup` will ALWAYS fail for Outlook — do not attempt them.

**IMAP with App Password is the ONLY reliable method for Outlook.**

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `No credentials found for service 'outlookimap'` | Run Step 2 (one-time setup) |
| `Authentication failed` | Create/re-create App Password at account.microsoft.com/security |
| `IMAP not enabled` | Outlook Settings → Mail → Sync email → toggle IMAP on |
| `LOGIN failed` | Same as authentication failed — check App Password |
