---
name: browser
description: "Headless browser automation via Playwright + Python. Navigate URLs, click buttons, fill forms, extract page content, take screenshots, and scrape structured data. Use when: (1) fetching pages that require JavaScript rendering, (2) form submission or login flows, (3) scraping dynamic web content, (4) taking screenshots of web pages, (5) automating repetitive web tasks."
metadata:
  {
    "openclaw":
      {
        "emoji": "🌐",
        "requires": { "bins": ["python"] },
        "install":
          [
            {
              "id": "pip-playwright",
              "kind": "pip",
              "package": "playwright",
              "label": "Install Playwright Python"
            }
          ]
      }
  }
---

# Browser Automation Skill

Automate real web browsers using **Playwright** (headless Chromium). Can navigate, click, fill
forms, extract content, and take screenshots — fully JavaScript-aware.

## When to Use

✅ **USE this skill when:**
- A page requires JavaScript to render (SPAs, React/Vue apps, dashboards)
- You need to fill and submit a form
- Logging into a website and performing actions
- Scraping structured data from dynamic pages (tables, listings)
- Taking a screenshot of a live web page
- Checking if a URL is reachable and what it shows
- Automating repetitive web workflows (download reports, check status pages)

❌ **DON'T use this skill when:**
- Simple static page fetch → use `web_fetch` (faster, no browser overhead)
- The page is an API endpoint returning JSON → use `web_fetch`
- Reading local files → use `file_read`

---

## How to Execute

All browser tasks are run by writing a Python script to a temp file and executing it with
`bash_exec`. Always use the pattern below.

### PYTHON BINARY
Use: `C:/Python314/python` (Windows path, forward slashes, no quotes around path)

### BASE SCRIPT TEMPLATE

```python
import json, sys, os, tempfile
from playwright.sync_api import sync_playwright

SCREENSHOTS_DIR = os.path.join(os.environ.get('USERPROFILE', ''), '.aaos', 'uploads')
os.makedirs(SCREENSHOTS_DIR, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    ctx = browser.new_context(
        viewport={"width": 1280, "height": 900},
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    )
    page = ctx.new_page()
    page.set_default_timeout(15000)
    try:
        # ── YOUR TASK HERE ────────────────────────────────────
        result = {}
        # ─────────────────────────────────────────────────────
    finally:
        browser.close()

print(json.dumps(result))
```

---

## Common Task Patterns

### 1. Navigate and Extract Text

```python
page.goto("https://example.com")
page.wait_for_load_state("networkidle")
title   = page.title()
content = page.inner_text("body")
result  = {"title": title, "content": content[:3000]}
```

### 2. Take a Screenshot

```python
import time
page.goto("https://example.com")
page.wait_for_load_state("networkidle")
fname = f"screenshot_{int(time.time())}.png"
fpath = os.path.join(SCREENSHOTS_DIR, fname)
page.screenshot(path=fpath, full_page=True)
result = {"screenshot": f"/uploads/{fname}", "title": page.title()}
```
After running, show the screenshot using: `![screenshot](/uploads/filename.png)`

### 3. Fill and Submit a Form

```python
page.goto("https://example.com/login")
page.fill("#username", "myuser")
page.fill("#password", "mypass")
page.click("button[type=submit]")
page.wait_for_load_state("networkidle")
result = {"url": page.url, "title": page.title()}
```

### 4. Scrape a Table

```python
page.goto("https://example.com/data")
page.wait_for_selector("table")
rows = page.eval_on_selector_all(
    "table tr",
    "els => els.map(r => Array.from(r.querySelectorAll('td,th')).map(c => c.innerText.trim()))"
)
result = {"rows": rows}
```

### 5. Click and Wait for Navigation

```python
page.goto("https://example.com")
page.click("a.some-link")
page.wait_for_load_state("networkidle")
result = {"url": page.url, "title": page.title()}
```

### 6. Extract All Links

```python
page.goto("https://example.com")
page.wait_for_load_state("networkidle")
links = page.eval_on_selector_all(
    "a[href]",
    "els => els.map(e => ({text: e.innerText.trim(), href: e.href}))"
)
result = {"links": links[:50]}
```

### 7. Scroll and Load More Content

```python
page.goto("https://example.com/infinite-scroll")
for _ in range(3):
    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    page.wait_for_timeout(1500)
content = page.inner_text("body")
result = {"content": content[:4000]}
```

---

## How to Write and Run the Script

**Step 1** — Write the script to a temp file using `file_write`:
```
file_write(path="C:/Windows/Temp/aaos_browser.py", content="<script>")
```

**Step 2** — Execute it using `bash_exec`:
```
bash_exec(command="C:/Python314/python C:/Windows/Temp/aaos_browser.py")
```

**Step 3** — Parse the JSON output returned by the script.

**Step 4** — If a screenshot was saved, display it in your reply:
```
![Page screenshot](/uploads/screenshot_<timestamp>.png)
```

---

## Error Handling

If the script fails, common causes and fixes:

| Error | Cause | Fix |
|---|---|---|
| `TimeoutError` | Page too slow or selector wrong | Increase timeout or use `wait_for_load_state("domcontentloaded")` |
| `Target closed` | Browser crashed | Add try/finally around the task |
| `No element found` | Selector doesn't match | Use `page.query_selector_all("*")` to inspect available elements |
| `net::ERR_NAME_NOT_RESOLVED` | No internet / wrong URL | Check URL and connectivity with `web_fetch` first |
| Blank content | JS not loaded yet | Use `wait_for_load_state("networkidle")` |

---

## Security Notes

- Only navigate to URLs the user explicitly provides or has approved
- Never store or log passwords in output — mask sensitive fields in `result`
- Headless browser runs in user context — respect robots.txt and rate limits
- Screenshots are saved to `~/.aaos/uploads/` and served at `/uploads/`
