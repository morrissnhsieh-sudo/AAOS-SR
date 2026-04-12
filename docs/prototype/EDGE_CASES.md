# Edge Case Inventory

| ID | AC-NNN | Scenario | Type | Expected Behavior | Status |
|---|---|---|---|---|---|
| EC-001 | AC-001.1 | Missing LINE webhook signature | EXPLICIT | Reject with HTTP 401 | ??EXPLICIT |
| EC-002 | AC-003.2 | Malformed internal message format | EXPLICIT | Drop, log error | ??EXPLICIT |
| EC-003 | AC-004.1 | LLM provider unavailable | EXPLICIT | ACP retry up to 3 times | ??EXPLICIT |
| EC-004 | AC-009.1 | Tool call references unknown skill | EXPLICIT | Return tool error to LLM | ??EXPLICIT |
| EC-005 | AC-018.1 | Skill npm install failure | EXPLICIT | Return error, do not register | ??EXPLICIT |
| EC-006 | AC-017.1 | Duplicate skill install attempt | EXPLICIT | Return HTTP 409 | ??EXPLICIT |
| EC-007 | AC-031.1 | Context window at 100% | EXPLICIT | Queue LLM call | ??EXPLICIT |
| EC-008 | AC-038.1 | Memory file write failure | EXPLICIT | Log error, surface warning | ??EXPLICIT |
| EC-009 | AC-015.1 | WebSocket Control UI disconnects | EXPLICIT | Save internally, no retry | ??EXPLICIT |
| EC-010 | AC-012.1 | Expired device identity token | EXPLICIT | Close socket with 401 | ??EXPLICIT |
| EC-011 | AC-051.1 | Remote node disconnects | EXPLICIT | Retry on next node | ??EXPLICIT |
| EC-012 | AC-025.1 | Heartbeat subsystem ping fails | EXPLICIT | Flag degraded | ??EXPLICIT |
| EC-013 | AC-006.1 | BOOT.md missing at start | EXPLICIT | Log warning, proceed | ??EXPLICIT |
| EC-014 | AC-047.1 | Malformed MCP request | EXPLICIT | HTTP 400 | ??EXPLICIT |
| EC-015 | AC-010.1 | LLM emits multiple auth tool calls | EXPLICIT | Dispatch parallel | ??EXPLICIT |
| EC-016 | AC-040.1 | LLM plugin disabled | EXPLICIT | Skip to next available | ??EXPLICIT |
| EC-017 | AC-XXX.X | Concurrent file memory writes | INFERRED | Last-write-wins | ?”§ AUTO-RESOLVED |
