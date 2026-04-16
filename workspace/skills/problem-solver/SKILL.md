---
name: problem-solver
description: "Autonomous problem-solving protocol. When AAOS encounters an error, failure, or complex issue it cannot immediately resolve, it MUST follow the Plan → Execute → Verify loop (minimum 2 verification cycles) before asking the user for help or giving up."
version: 1.0.0
metadata:
  { "openclaw": { "emoji": "🔍" } }
---

# Autonomous Problem-Solving Protocol

When AAOS encounters ANY problem it cannot immediately solve, it MUST follow this protocol.
**Never ask the user for help or give up before completing at least 2 verification cycles.**

---

## ⚠️ When to Activate This Protocol

Activate whenever:
- A tool call returns an error
- A browser action fails
- Code doesn't compile or run correctly
- A service is unavailable
- An expected result doesn't match actual result
- You are unsure how to proceed with a multi-step task

Do NOT activate for:
- Simple factual questions (answer directly)
- Requests that need user input by design (e.g. "what's your name?")

---

## The Protocol: Plan → Execute → Verify (×2)

### Step 1 — PLAN
```
problem_solve(
  problem  = "describe exactly what went wrong + error messages",
  context  = "relevant code / config / tool output",
  previous_attempt = "(only on retry) what failed in previous cycle"
)
```
Returns a numbered plan where each step has:
- `action`: which tool to call with what parameters
- `verification`: observable criterion that proves the step worked

---

### Step 2 — EXECUTE
Execute **every step** in the plan in order using the specified tools.
Collect the exact output/result of each tool call.

Do NOT skip steps. Do NOT guess results.

---

### Step 3 — VERIFY (Cycle 1)
```
verify_solution(
  plan_id       = "<from problem_solve>",
  cycle         = 1,
  evidence      = [
    { step_id: 1, action_taken: "called bash_exec(…)", result: "…output…" },
    { step_id: 2, action_taken: "called file_read(…)", result: "…content…" },
    …
  ],
  overall_state = "current state of the system"
)
```

---

### Step 4 — VERIFY (Cycle 2) — MANDATORY even if Cycle 1 passed
```
verify_solution(
  plan_id  = "<same id>",
  cycle    = 2,
  evidence = [ … fresh evidence … ]
)
```
Cycle 2 uses **independent evidence** — don't just repeat the same outputs.
Example: if Cycle 1 verified a file was written, Cycle 2 reads it back and checks the content.

---

### Step 5 — Decision

| Result | Action |
|--------|--------|
| Cycle 1 PASSED, Cycle 2 PASSED | ✅ Declare solved, present solution summary to user |
| Cycle 1 FAILED | Call `problem_solve(previous_attempt="…")` for revised plan → re-execute → re-verify |
| Cycle 2 FAILED | Call `problem_solve(previous_attempt="…")` for second revision → re-execute → Cycle 3+4 |
| 3+ consecutive FAILED cycles | Present detailed failure report to user: what was tried, what failed, what the blocker is |

---

## Verification Evidence Rules

Good evidence:
```json
{
  "step_id": 1,
  "action_taken": "bash_exec(command='systemctl status postgresql')",
  "result": "postgresql.service - PostgreSQL... Active: active (running) since..."
}
```

Bad evidence (do NOT use):
```json
{
  "step_id": 1,
  "action_taken": "checked the service",
  "result": "it seems to be running"
}
```

**Use actual tool outputs, not summaries.**

---

## Example: Database Connection Failure

```
Problem: "db.connect() throws ECONNREFUSED 127.0.0.1:5432"

PLAN generated:
  Step 1: bash_exec("systemctl status postgresql")  → verify: "Active: active (running)"
  Step 2: file_read(".env")                          → verify: "DB_URL contains port 5432"
  Step 3: bash_exec("psql -h localhost -p 5432 -c '\\l'")  → verify: "returns list of databases"

EXECUTE:
  Step 1 result: "Active: inactive (dead)"          ← PostgreSQL was stopped
  Step 2 result: "DB_URL=postgresql://…:5432/…"     ← config is correct
  Step 3 result: "connection refused"               ← confirms Step 1

VERIFY Cycle 1:
  Step 1 FAILED (inactive, not running) → suggested fix: start the service
  → verdict: FAILED

RE-PLAN (previous_attempt: "PostgreSQL was not running"):
  Revised Step 1: bash_exec("sudo systemctl start postgresql") → verify: exits with code 0
  Revised Step 2: bash_exec("systemctl status postgresql")     → verify: "Active: active (running)"
  Revised Step 3: bash_exec("psql -h localhost -p 5432 -c '\\l'") → verify: returns databases

RE-EXECUTE → all steps pass

VERIFY Cycle 1 (revised plan):
  All steps PASSED → verdict: PASSED ✅

VERIFY Cycle 2:
  bash_exec("pg_isready -h localhost") → "localhost:5432 - accepting connections" ✅
  → verdict: PASSED ✅

SOLUTION: PostgreSQL service was stopped. Started it → connection restored.
```
