---
name: outlook
description: Read, search, and send Outlook / Office 365 emails via Playwright browser automation. First-time use opens a browser for a normal Microsoft login — after that, fully automatic forever. No App Password, no Azure setup.
allowed-tools: bash_exec sys_info
version: 5.1.0
---

# Outlook / Office 365 Skill — v5.1.0

## How authentication works

- **First time only:** A browser window opens. The user logs in with their
  normal Microsoft email and password — exactly like visiting outlook.com.
  Nothing else is needed. Takes about 30 seconds.
- **Every time after:** Fully silent and headless. No user action ever again.

> No App Password. No Azure portal. No API keys. No codes. Just a normal
> browser login once, then fully automatic forever.

---

## IMPORTANT — Do NOT use IMAP or credentials_read for Outlook

IMAP basic auth is permanently blocked by Microsoft since 2023.
App Passwords require complex 2FA setup.
**The ONLY working method is Playwright browser automation below.**

---

## Step 1 — Get the Python executable

```
sys_info()  →  note the pythonExe value (e.g. C:\Python314\python.exe)
```

The workspace path is already embedded in the commands below as `{WORKSPACE}`.

---

## Step 2 — Run the script

Use the `pythonExe` value from sys_info() in the commands below.

**List 3 most recent emails:**
```
bash_exec: "<pythonExe>" "{WORKSPACE}/scripts/outlook_playwright.py" recent 3
```

**List latest N unread emails:**
```
bash_exec: "<pythonExe>" "{WORKSPACE}/scripts/outlook_playwright.py" unread <N>
```

**Search emails:**
```
bash_exec: "<pythonExe>" "{WORKSPACE}/scripts/outlook_playwright.py" search "<query>" <N>
```

**Read a specific email by index:**
```
bash_exec: "<pythonExe>" "{WORKSPACE}/scripts/outlook_playwright.py" read <index>
```

**Send an email:**
```
bash_exec: "<pythonExe>" "{WORKSPACE}/scripts/outlook_playwright.py" send "<to>" "<subject>" "<body>"
```

---

## Step 3 — First-time login handling

If the JSON output contains `"status": "login_required"`, tell the user:

> "A browser window has opened on your screen. Please log in with your
> Microsoft email and password — exactly like logging into outlook.com.
> You will never be asked again after this first login."

The script polls silently and continues automatically once login is complete.

---

## Step 4 — Present results

Format and present the JSON emails clearly to the user:

```
[1] From:    sender@example.com
    Subject: Meeting tomorrow
    Date:    2026/4/16 上午 09:39
    Preview: Hi, confirming the 10am meeting...
```

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `playwright not installed` | `bash_exec: <pythonExe> -m pip install playwright && <pythonExe> -m playwright install chromium` |
| `Login timed out` | Run again — complete the browser login within 3 minutes |
| `Could not find OWA search box` | OWA layout changed — try `recent 10` instead |
| `Email index N not found` | Run `recent 10` first to see available indexes |
