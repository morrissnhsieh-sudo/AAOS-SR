---
name: reminder-scheduler
description: Schedule a reminder popup to appear at a specific time. Use when the user wants to be reminded of something at a particular time.
allowed-tools: file_write bash_exec
version: 1.1.0
---

# Reminder Scheduler

Use Windows Task Scheduler (`schtasks`) to display a popup dialog at the requested time.
Do NOT use the `at` command — it is deprecated on Windows.

## Steps

1. Extract from the user's request:
   - **time** — convert to 24-hour `HH:MM` format (e.g. "10:50 AM" → `10:50`, "2:30 PM" → `14:30`)
   - **message** — the reminder text (e.g. "drink water")

2. Generate a safe task name: lowercase letters and hyphens only, no spaces (e.g. `drink-water-1050`).

3. Call `file_write` to create a PowerShell script at `C:\Temp\aaos-{task-name}.ps1`:

   ```
   Add-Type -AssemblyName System.Windows.Forms
   [System.Windows.Forms.MessageBox]::Show('{message}', 'AAOS Reminder', 'OK', 'Information') | Out-Null
   ```

   Use `append: false` to overwrite if it already exists.

4. Call `bash_exec` to create the one-time scheduled task:

   ```
   schtasks /create /f /tn "AAOS-{task-name}" /tr "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\Temp\aaos-{task-name}.ps1" /sc once /st {HH:MM}
   ```

5. Tell the user: "Done — I'll remind you to {message} at {time}. A popup will appear on your screen."

## Managing reminders

- **List all AAOS reminders**: call `bash_exec` with `schtasks /query /fo LIST /tn "AAOS-*"`
- **Delete a reminder**: call `bash_exec` with `schtasks /delete /f /tn "AAOS-{task-name}"`

## Error handling

- If `schtasks` fails with "time has already passed", the requested time is in the past — ask the user for a future time.
- If `schtasks` fails with "access denied", inform the user that Task Scheduler may require elevated permissions.
- Always check the `bash_exec` output for `SUCCESS` before confirming to the user.
