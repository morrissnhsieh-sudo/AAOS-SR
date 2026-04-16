---
name: scheduler
description: "Schedule background agent tasks to run automatically on a recurring schedule or at a specific future time. Use when: (1) user wants AAOS to do something automatically every day/week/hour, (2) user wants a one-time or recurring future reminder or alert, (3) listing, pausing, or cancelling scheduled tasks. Examples: 'summarize my emails every morning', 'remind me to drink water at 9pm', 'check stock prices every hour', 'run a weekly sales report every Monday', 'pause the inventory check'."
allowed-tools: schedule_create, schedule_list, schedule_delete, schedule_pause, schedule_resume, schedule_run_now
version: 2.1.0
---

# Scheduler Skill — Background Agent Tasks

Schedule AAOS agent tasks using the **built-in cross-platform cron engine**.
Works identically on Windows, macOS, and Linux — no OS-specific commands needed.

## ⚠️ Critical Rules

1. **NEVER use a `reminder_scheduler` tool — it does not exist.** Use `schedule_create` directly.
2. **ALWAYS call `schedule_run_now` after `schedule_create`** to verify the job works.
3. **ALWAYS set `notify=true`** when the user wants to be alerted (reminders, drink water, meeting, deadline, etc.).
4. **NEVER confirm success until `schedule_run_now` returns `status: "ok"`.**

---

## When to Use

✅ **USE this skill when the user says things like:**
- "Remind me to drink water at 9pm"
- "Every morning at 8am, check the news and summarize it"
- "Remind me about the meeting at 3pm"
- "Run a weekly ISO 26262 compliance report every Monday"
- "Every 30 minutes, check if the server is healthy"
- "Schedule a daily inventory check"
- "Pause / resume / delete the daily-news job"
- "What scheduled tasks are running?"

❌ **DON'T use this skill for:**
- Instant one-off tasks → just do them directly now
- OS-level system tasks (backups, reboots) → use bash_exec + OS tools directly

---

## Available Tools (use these directly — no bash_exec needed)

| Tool | Purpose |
|---|---|
| `schedule_create` | Create or replace a scheduled job |
| `schedule_list` | List all jobs with status, last run, next run |
| `schedule_delete` | Permanently remove a job |
| `schedule_pause` | Disable a job without deleting it |
| `schedule_resume` | Re-enable a paused job |
| `schedule_run_now` | Trigger a job immediately (mandatory verification after create) |

---

## Creating a Scheduled Task — Mandatory Workflow

### Step 1 — Identify parameters

| Parameter | Notes |
|---|---|
| `name` | Short lowercase slug: `drink-water`, `daily-news`, `meeting-3pm` |
| `cron` | Natural language or cron expression (see formats below) |
| `message` | Exact instruction the agent runs — be specific |
| `notify` | **`true` if user should see output in chat** (reminders, alerts). `false` for background jobs only. |

**Set `notify=true` whenever the job involves:** remind, alert, drink, eat, take medication, meeting, deadline, alarm, check-in, ping.

### Step 2 — Call schedule_create

```
schedule_create(
    name    = "drink-water",
    cron    = "every day at 21:00",
    message = "Remind the user: Time to drink water! Stay hydrated.",
    notify  = true
)
```

### Step 3 — MANDATORY: Call schedule_run_now immediately

```
schedule_run_now(name="drink-water")
```

Check the result. If `status` is `"error"`, fix the message or tool access before confirming to the user.

### Step 4 — Confirm to the user with verified proof

Only confirm success after `schedule_run_now` returns `status: "ok"`:

```
✅ Reminder confirmed:

  Name:      drink-water
  Schedule:  every day at 21:00  (cron: 0 21 * * *)
  Notify:    yes — you will see this in chat when it fires
  Status:    active

🧪 Test run result:
  "Time to drink water! Stay hydrated."

To view all jobs:   ask "list scheduled tasks"
To pause:           ask "pause drink-water"
To delete:          ask "delete drink-water"
```

---

## How notify=true Works

When `notify=true`:
- When the job fires on schedule, the agent runs the message as normal
- The result is **pushed directly to your chat** as a notification
- You will see it appear in the chat window automatically — no need to check anywhere else

When `notify=false` (background jobs):
- Job runs silently in the background
- Result is stored in `~/.aaos/schedules.json` as `last_result`
- Check with: `schedule_list()` or ask "show last result for <job-name>"

---

## Schedule Formats

Both **cron expressions** and **natural language** are accepted:

### Natural Language (recommended)
| Say | Cron |
|---|---|
| `every day at 8:00am` | `0 8 * * *` |
| `every day at 21:00` | `0 21 * * *` |
| `every monday at 9am` | `0 9 * * 1` |
| `every 30 minutes` | `*/30 * * * *` |
| `every minute` | `* * * * *` |
| `every hour` | `0 * * * *` |
| `every friday at 5:30pm` | `30 17 * * 5` |
| `weekdays at 7am` | `0 7 * * 1-5` |
| `@daily` | `0 0 * * *` |
| `@hourly` | `0 * * * *` |
| `@weekly` | `0 0 * * 0` |

**Note:** Minimum interval is 1 minute (`* * * * *`). There is no sub-minute scheduling.

### Cron Expression (5 fields)
```
┌─── minute (0-59)
│  ┌─── hour (0-23)
│  │  ┌─── day of month (1-31)
│  │  │  ┌─── month (1-12)
│  │  │  │  ┌─── day of week (0=Sun, 6=Sat)
*  *  *  *  *
```

---

## Managing Scheduled Tasks

### List all jobs
```
schedule_list()
```
Returns: name, cron, notify status, enabled/paused, last run time, last result.

### Run a job immediately
```
schedule_run_now(name="weekly-report")
```

### Pause a job (keeps settings, stops running)
```
schedule_pause(name="daily-news")
```

### Resume a paused job
```
schedule_resume(name="daily-news")
```

### Delete a job permanently
```
schedule_delete(name="daily-news")
```

---

## Example Jobs

### Personal reminder (notify=true — user sees it in chat)
```
schedule_create(
    name    = "drink-water-evening",
    cron    = "every day at 21:00",
    message = "Remind the user: It's 9pm — time to drink water and wind down.",
    notify  = true
)
```

### Daily inventory check (notify=false — background only)
```
schedule_create(
    name    = "daily-inventory",
    cron    = "every day at 7:00am",
    message = "Query the inventory database for all products with stock below their reorder point. List each item with current stock, reorder point, and recommended order quantity. Save findings to memory.",
    tags    = ["retail", "inventory"]
)
```

### Weekly sales report (background)
```
schedule_create(
    name    = "weekly-sales-report",
    cron    = "every monday at 9:00am",
    message = "Generate a weekly sales report for last week. Include: total revenue, top 10 products by units sold, bottom 5 products, and week-over-week comparison. Format as a clear summary.",
    tags    = ["retail", "analytics"]
)
```

---

## Notes

- Scheduled jobs run in their own session (`scheduler:<name>` by default)
- All session history is saved to `~/.aaos/sessions/` and reviewable
- Job definitions persist to `~/.aaos/schedules.json` — survive server restarts
- Timezone is read from the `TZ` environment variable (defaults to system timezone)
- Jobs are automatically re-activated when the AAOS server starts
