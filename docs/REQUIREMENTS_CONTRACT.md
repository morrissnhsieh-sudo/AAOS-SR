# REQUIREMENTS CONTRACT v1.0
## AAOS ??Autonomous Agent Orchestration System

---

## SECTION 1 ??SYSTEM IDENTITY

| Field | Value |
|---|---|
| System Name | AAOS ??Autonomous Agent Orchestration System |
| Purpose | A persistent, self-hosted personal AI assistant platform that routes messages from users (via LINE and a browser Control UI) through a unified gateway to LLMs, skills, plugins, and file-based memory ??enabling stateful, tool-augmented conversations. |
| Success Metric | A user message sent via any connected channel receives a correct, tool-augmented response within 5 seconds under normal load |
| Version | v0.1.0 |
| Status | Pre-MVP |

---

## SECTION 2 ??USERS & WORKFLOWS

### Roles

| ID | Name | Responsibility |
|---|---|---|
| ROLE-01 | End User | Sends messages via LINE or Control UI; receives AI responses |
| ROLE-02 | System Administrator | Installs/disables skills, configures plugins, manages gateway via CLI |
| ROLE-03 | External MCP Client | Connects to the gateway's MCP server to share tools bidirectionally |

### Workflows

**WF-01 | Message Processing Pipeline**
- Actor: End User (ROLE-01)
- Steps: 1 ??Channel adapter receives raw message ??2 ??Authenticate & normalize message ??3 ??Route to session context ??4 ??Agent Runner prepends HEARTBEAT.md, BOOT.md, workspace memory ??5 ??Full history + new message sent to LLM ??6 ??LLM replies with text or tool call ??7 ??If tool call: Tool Dispatcher executes and returns result ??8 ??LLM generates final response ??9 ??Response sent back to originating channel
- Success: User receives coherent, optionally tool-augmented reply
- Failure: LLM or channel unavailable ??ACP runtime decides retry, surface error, or switch provider

**WF-02 | Skill Installation**
- Actor: System Administrator (ROLE-02)
- Steps: 1 ??Admin runs CLI `skills install <package-name>` ??2 ??Gateway reads skill manifest (YAML frontmatter) ??3 ??Auto-installs npm dependencies if declared ??4 ??Skill is registered and available for LLM tool calls
- Success: Skill appears in `skills list` and LLM can invoke it
- Failure: npm install fails ??error returned to CLI, skill not registered

**WF-03 | Heartbeat & Health Monitoring**
- Actor: Gateway (automated)
- Steps: 1 ??Every 300s: gateway pings all subsystems ??2 ??Sends keepalive frames to channel connections ??3 ??Triggers memory compaction if context window is near limit ??4 ??Flushes session JSONL logs to disk
- Success: All subsystems responsive; channels remain connected
- Failure: Channel fails to connect within 120s grace period ??flagged as degraded

**WF-04 | Context Compaction**
- Actor: Gateway (automated)
- Steps: 1 ??Conversation exceeds LLM context window limit ??2 ??Older messages summarized by LLM ??3 ??Summary saved to `memory/` directory ??4 ??Token budget freed for new messages
- Success: Conversation continues seamlessly beyond context window limit
- Failure: LLM summarization fails ??log error, retain raw history up to hard limit

**WF-05 | Multi-node Task Dispatch**
- Actor: Gateway (configured by ROLE-02)
- Steps: 1 ??Remote node connects to gateway via WebSocket ??2 ??Node registers with device identity ??3 ??Gateway dispatches task to node ??4 ??Node processes and returns result ??5 ??Gateway aggregates results
- Success: Distributed task completed and result returned to user
- Failure: Node disconnects mid-task ??gateway retries on next available node; surfaces error if none available

**WF-06 | MCP Client Integration**
- Actor: External MCP Client (ROLE-03)
- Steps: 1 ??MCP client connects to `http://127.0.0.1:<port>/mcp` ??2 ??Client discovers available tools ??3 ??Client invokes a tool ??4 ??Gateway executes and returns result
- Success: Bidirectional tool sharing between OpenClaw and external MCP clients
- Failure: Client sends malformed MCP request ??400 error returned

---

## SECTION 3 ??FUNCTIONAL REQUIREMENTS

### Functional Requirements

| ID | Priority | Requirement |
|---|---|---|
| FR-001 | MUST | The gateway shall receive messages from the LINE messaging channel via HTTP webhook |
| FR-002 | MUST | The gateway shall receive messages from the browser Control UI via WebSocket |
| FR-003 | MUST | All incoming messages shall be authenticated before processing |
| FR-004 | MUST | All incoming messages shall be normalized into the system's internal message format |
| FR-005 | MUST | The Channel Manager shall route normalized messages to the appropriate session context |
| FR-006 | MUST | The Agent Runner shall prepend HEARTBEAT.md, BOOT.md, and workspace memory to every LLM prompt |
| FR-007 | MUST | The system shall support LLM responses in the form of plain text |
| FR-008 | MUST | The system shall support LLM responses in the form of tool call requests |
| FR-009 | MUST | The Tool Dispatcher shall route tool calls to the correct skill, plugin, or built-in tool |
| FR-010 | MUST | Tool results shall be returned to the LLM as tool result messages |
| FR-011 | MUST | Final LLM responses shall be delivered back to the user via the originating channel |
| FR-012 | MUST | The gateway shall support installation of npm-based skill packages via CLI |
| FR-013 | MUST | The gateway shall read skill manifests (YAML frontmatter + markdown) to resolve dependencies |
| FR-014 | MUST | The gateway shall auto-install npm dependencies declared in a skill manifest |
| FR-015 | MUST | Installed skills shall expose tools callable by the LLM |
| FR-016 | MUST | The heartbeat subsystem shall ping all internal subsystems every 300 seconds |
| FR-017 | MUST | The heartbeat subsystem shall send keepalive frames to all active channel connections |
| FR-018 | MUST | The heartbeat subsystem shall trigger memory compaction when context window nears its limit |
| FR-019 | MUST | The heartbeat subsystem shall flush session JSONL logs to disk on every cycle |
| FR-020 | MUST | A channel that fails to connect within the 120-second grace period shall be flagged as degraded |
| FR-021 | MUST | The gateway shall perform automatic context compaction when a conversation exceeds the LLM context window |
| FR-022 | MUST | Context compaction shall summarize older messages via LLM and save summaries to the memory directory |
| FR-023 | MUST | The memory system shall persist conversation history as JSONL session logs under `~/.aaos/` |
| FR-024 | MUST | The agent shall read HEARTBEAT.md, BOOT.md, and MEMORY.md at the start of every run |
| FR-025 | MUST | The agent shall write user-requested facts to MEMORY.md |
| FR-026 | MUST | The Plugin Engine shall load and manage provider plugins (Anthropic, Ollama, Google, Browser) |
| FR-027 | MUST | The gateway shall support ACP (Agent Communication Protocol) for structured agent lifecycle management |
| FR-028 | MUST | The ACP runtime shall make failover decisions (retry, surface error, switch provider) on agent run failure |
| FR-029 | MUST | The gateway shall expose a loopback MCP server at `http://127.0.0.1:<port>/mcp` |
| FR-030 | MUST | The gateway shall support multi-node deployments where remote nodes register via WebSocket |
| FR-031 | MUST | The gateway shall dispatch tasks to registered remote nodes and aggregate results |
| FR-032 | MUST | All WebSocket Control UI connections shall require device identity authentication |
| FR-033 | MUST | The WebSocket Control UI protocol shall support request-response pairs with unique request IDs |
| FR-034 | MUST | The WebSocket Control UI protocol shall support server-push events for real-time updates |
| FR-035 | SHOULD | The gateway shall support listing installed skills via CLI |
| FR-036 | SHOULD | The gateway shall support disabling an installed skill via CLI |
| FR-037 | SHOULD | Startup shall observe a 60-second grace period before health monitoring activates |
| FR-038 | NICE-TO-HAVE | The gateway shall support plugin configuration via a structured config key scheme (`plugins.entries.<name>`) |

### Out of Scope

| ID | Exclusion |
|---|---|
| OOS-001 | Traditional machine learning, model fine-tuning, or training ??the system uses file-based memory only |
| OOS-002 | User-facing account management or sign-up ??device identity pairing is the auth model |
| OOS-003 | Cross-user data isolation ??the system is a single-user personal assistant |

### Build Priority Order

1. FR-003 ??Auth is the security foundation
2. FR-004 ??Message normalization required before routing
3. FR-005 ??Channel routing required before agent processing
4. FR-001 ??LINE webhook: primary channel
5. FR-002 ??Control UI WebSocket: secondary channel
6. FR-006 ??System context injection required before LLM calls
7. FR-007, FR-008 ??LLM text and tool call response handling
8. FR-009, FR-010, FR-011 ??Tool Dispatcher completes the round-trip
9. FR-023, FR-024, FR-025 ??Memory system for persistence
10. FR-012, FR-013, FR-014, FR-015 ??Skills system for extensibility
11. FR-016, FR-017, FR-018, FR-019, FR-020 ??Heartbeat for reliability
12. FR-021, FR-022 ??Context compaction for long sessions
13. FR-026 ??Plugin Engine for provider integrations
14. FR-027, FR-028 ??ACP for multi-agent lifecycle
15. FR-029 ??MCP server for external integrations
16. FR-030, FR-031 ??Multi-node for scalability
17. FR-032, FR-033, FR-034 ??Control UI protocol hardening
18. FR-035, FR-036 ??CLI convenience features
19. FR-037 ??Startup grace period
20. FR-038 ??Plugin config key scheme

---

## SECTION 4 ??DATA MODEL

### Entity: Session *(maps to FR-005, FR-023)*

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| id | uuid | yes | auto | primary key |
| channel_id | string | yes | ??| originating channel identifier |
| user_id | string | yes | ??| user identifier from channel |
| created_at | datetime | yes | now | session start time |
| last_active_at | datetime | yes | now | updated on every message |
| status | enum(active, degraded, closed) | yes | active | ??|
| context_token_count | int | yes | 0 | running token count for compaction trigger |

### Entity: Message *(maps to FR-004, FR-007, FR-008)*

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| id | uuid | yes | auto | primary key |
| session_id | uuid | yes | ??| FK ??Session |
| role | enum(user, assistant, tool, system) | yes | ??| LLM message role |
| content | string | yes | ??| normalized message text or tool payload |
| tool_name | string | no | null | populated if role=tool |
| tool_call_id | string | no | null | correlates tool result to its call |
| created_at | datetime | yes | now | ??|
| token_count | int | yes | 0 | per-message token count |

### Entity: Skill *(maps to FR-012, FR-013, FR-014, FR-015)*

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| id | uuid | yes | auto | primary key |
| name | string | yes | ??| npm package name |
| version | string | yes | ??| installed version |
| status | enum(enabled, disabled) | yes | enabled | ??|
| manifest_path | string | yes | ??| path to YAML manifest file |
| installed_at | datetime | yes | now | ??|
| tools | json | yes | [] | list of tool names exposed |

### Entity: Plugin *(maps to FR-026, FR-038)*

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| id | uuid | yes | auto | primary key |
| name | string | yes | ??| e.g. anthropic, ollama, google, browser |
| config_key | string | yes | ??| e.g. plugins.entries.anthropic |
| enabled | bool | yes | true | ??|
| config | json | no | {} | provider-specific settings |

### Entity: Node *(maps to FR-030, FR-031)*

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| id | uuid | yes | auto | primary key |
| address | string | yes | ??| WebSocket address of remote node |
| status | enum(connected, disconnected, degraded) | yes | disconnected | ??|
| paired_at | datetime | no | null | when device identity was approved |
| last_seen_at | datetime | no | null | last heartbeat received from node |

### Entity: MemoryFile *(maps to FR-023, FR-024, FR-025)*

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| id | uuid | yes | auto | primary key |
| file_path | string | yes | ??| absolute path under `~/.aaos/` |
| file_type | enum(HEARTBEAT, BOOT, MEMORY, session_summary, session_log) | yes | ??| ??|
| session_id | uuid | no | null | FK ??Session (for session logs/summaries) |
| created_at | datetime | yes | now | ??|
| last_modified_at | datetime | yes | now | ??|

### Relationships

| Relationship | Description |
|---|---|
| Session 1 ??N Message | A session contains many messages |
| Session 1 ??N MemoryFile | A session produces log and summary files |
| Skill 1 ??N tools | Tool names stored as json array within Skill entity |
| Node N ??1 Gateway | Logical relationship; nodes register with the gateway |

---

## SECTION 5 ??API CONTRACT

### POST /webhook/line *(maps to FR-001, FR-003, FR-004)*
- Auth required: yes | Role: ROLE-01 (LINE HMAC-SHA256 signature verification)
- Request: `{ destination: string, events: json[] }`
- Response 2xx: `{ status: "ok" }`
- Response error: `{ code: 401, reason: "Invalid LINE signature" }` 路 `{ code: 400, reason: "Malformed payload" }`
- Notes: Signature validated using LINE channel secret; responds 200 immediately, processing is async

### WS /ws/chat *(maps to FR-002, FR-032, FR-033, FR-034)*
- Auth required: yes | Role: ROLE-01 (JWT device identity token)
- Request (client?抯erver): `{ request_id: string, type: "message" | "command", content: string }`
- Response (server?抍lient): `{ request_id: string, type: "response" | "event", content: string, status: "ok" | "error" }`
- Server-push event: `{ type: "event", event: "heartbeat" | "model_status_changed" | "new_message", payload: json }`
- Response error: `{ code: 401, reason: "Device not authenticated" }`
- Notes: All connections require prior device pairing

### POST /skills/install *(maps to FR-012, FR-013, FR-014)*
- Auth required: yes | Role: ROLE-02
- Request: `{ package_name: string }`
- Response 2xx: `{ skill_id: uuid, name: string, tools: string[], status: "enabled" }`
- Response error: `{ code: 400, reason: "Package not found" }` 路 `{ code: 409, reason: "Skill already installed" }`

### GET /skills *(maps to FR-035)*
- Auth required: yes | Role: ROLE-02
- Request: (none)
- Response 2xx: `{ skills: [{ id: uuid, name: string, version: string, status: string, tools: string[] }] }`
- Response error: `{ code: 401, reason: "Unauthorized" }`

### PATCH /skills/:id/disable *(maps to FR-036)*
- Auth required: yes | Role: ROLE-02
- Request: `{ id: uuid }` (path param)
- Response 2xx: `{ id: uuid, status: "disabled" }`
- Response error: `{ code: 404, reason: "Skill not found" }` 路 `{ code: 409, reason: "Skill already disabled" }`

### GET /mcp *(maps to FR-029)*
- Auth required: no (loopback only) | Role: ROLE-03
- Request: MCP protocol handshake
- Response 2xx: MCP tool manifest
- Response error: `{ code: 400, reason: "Invalid MCP request" }`
- Notes: Bound to 127.0.0.1 only; not externally exposed

### POST /nodes/register *(maps to FR-030)*
- Auth required: yes | Role: ROLE-02 (JWT device identity)
- Request: `{ node_address: string, identity_token: string }`
- Response 2xx: `{ node_id: uuid, status: "connected" }`
- Response error: `{ code: 401, reason: "Identity verification failed" }` 路 `{ code: 409, reason: "Node already registered" }`

### GET /health *(maps to FR-016, FR-037)*
- Auth required: no
- Request: (none)
- Response 2xx: `{ status: "ok" | "degraded", subsystems: { [name]: "ok" | "degraded" }, uptime_seconds: int }`

---

## SECTION 6 ??EDGE CASES & BUSINESS RULES

### Business Rules

| ID | FR | Rule |
|---|---|---|
| BR-001 | FR-003 | A message that fails authentication must be rejected before any processing occurs |
| BR-002 | FR-001 | LINE webhook responses must be returned within 3,000ms (LINE platform requirement) |
| BR-003 | FR-018 | Memory compaction is triggered when token count exceeds 80% of the LLM context window limit |
| BR-004 | FR-015 | A disabled skill's tools must not be available to the LLM for invocation |
| BR-005 | FR-028 | ACP retry limit is 3 attempts before surfacing the error to the user |
| BR-006 | FR-020 | A channel is marked degraded, not terminated, when it misses its grace period |
| BR-007 | FR-025 | Only explicitly user-requested facts are written to MEMORY.md; the agent must not auto-write |
| BR-008 | FR-019 | Session JSONL logs are flushed every heartbeat cycle regardless of new message activity |
| BR-009 | FR-031 | Task dispatch to nodes is attempted in registration order; first available node wins |
| BR-010 | FR-021 | Context compaction preserves the most recent N messages verbatim before summarizing older ones |

### Edge Cases

**EC-001 | Missing LINE webhook signature**
- Condition: LINE webhook POST arrives without X-Line-Signature header
- Expected result: Reject with HTTP 401 `{ reason: "Missing signature" }`; log attempt
- Traces to: FR-001, FR-003

**EC-002 | Malformed internal message format**
- Condition: Channel adapter produces a message with missing required fields
- Expected result: Log error, drop message, do not route to Agent Runner
- Traces to: FR-004

**EC-003 | LLM provider unavailable (all providers)**
- Condition: All configured LLM providers return errors or time out
- Expected result: ACP runtime retries up to 3 times; after exhaustion, returns error message to user via originating channel
- Traces to: FR-028, BR-005

**EC-004 | Tool call references unknown skill/tool name**
- Condition: LLM emits a tool call for a name not registered in the Tool Dispatcher
- Expected result: Return `{ error: "Tool not found", tool_name: "<name>" }` as tool result; LLM incorporates error into response
- Traces to: FR-009

**EC-005 | Skill npm install failure**
- Condition: npm install fails during skill installation (network error, bad package name)
- Expected result: Skill is not registered; CLI returns error message with npm stderr output
- Traces to: FR-012, FR-014

**EC-006 | Duplicate skill install attempt**
- Condition: Admin attempts to install a skill already installed
- Expected result: Return HTTP 409 `{ reason: "Skill already installed" }`; existing skill unchanged
- Traces to: FR-012

**EC-007 | Context window at 100% before compaction completes**
- Condition: Token count reaches 100% before compaction finishes
- Expected result: Queue the LLM call until compaction finishes; do not drop the message
- Traces to: FR-021, FR-022

**EC-008 | Memory file write failure**
- Condition: File system full or permissions denied when writing MEMORY.md or session log
- Expected result: Log error with path and reason; continue agent run without writing; surface warning to user
- Traces to: FR-023, FR-025

**EC-009 | WebSocket Control UI disconnects mid-response**
- Condition: Client WebSocket drops while server is streaming a response
- Expected result: Server completes LLM call internally; logs response; no re-delivery attempted
- Traces to: FR-002, FR-034

**EC-010 | Expired device identity token on WebSocket**
- Condition: Client presents an expired JWT on WS /ws/chat
- Expected result: Server closes connection with 401; client must re-authenticate and re-pair
- Traces to: FR-032

**EC-011 | Remote node disconnects during task dispatch**
- Condition: Node disconnects after task dispatched but before result returned
- Expected result: Gateway marks node disconnected; retries on next available node; surfaces error if none available
- Traces to: FR-030, FR-031

**EC-012 | Heartbeat subsystem ping fails**
- Condition: A subsystem does not respond to internal ping within timeout
- Expected result: Subsystem flagged as degraded; gateway continues operation; alert logged
- Traces to: FR-016

**EC-013 | BOOT.md or HEARTBEAT.md missing at agent run start**
- Condition: Agent Runner cannot read one of the required system context files
- Expected result: Log warning; proceed with available files; do NOT abort
- Traces to: FR-006, FR-024

**EC-014 | Malformed MCP request**
- Condition: External MCP client sends non-conforming request
- Expected result: Return HTTP 400 `{ reason: "Invalid MCP request" }`; no tools executed
- Traces to: FR-029

**EC-015 | LLM emits multiple concurrent tool calls**
- Condition: LLM emits multiple tool calls in one response turn
- Expected result: Dispatch all tool calls in parallel; aggregate all results before returning to LLM
- Traces to: FR-008, FR-009

**EC-016 | LLM plugin disabled or unconfigured**
- Condition: Agent Runner requests an LLM provider whose plugin is disabled or unconfigured
- Expected result: ACP runtime skips disabled provider; tries next available; errors if none available
- Traces to: FR-026, FR-028

---

## SECTION 7 ??NON-FUNCTIONAL REQUIREMENTS

| ID | Category | Requirement | Threshold |
|---|---|---|---|
| NFR-001 | Performance | LINE webhook response time | < 3,000ms (LINE platform limit) |
| NFR-002 | Performance | Internal message processing latency (receive ??LLM send) | p95 < 500ms |
| NFR-003 | Performance | End-to-end response time (message in ??response out) | p95 < 10s |
| NFR-004 | Security | WebSocket connections require device identity authentication | 100% enforced |
| NFR-005 | Security | MCP server bound to loopback only | Not externally accessible |
| NFR-006 | Security | LINE webhook signature verification | All webhooks validated before processing |
| NFR-007 | Reliability | Heartbeat interval | 300s (configurable) |
| NFR-008 | Reliability | Gateway uptime target | 99.5% |
| NFR-009 | Reliability | ACP retry limit before error surfacing | 3 attempts |
| NFR-010 | Reliability | Session log flush frequency | Every heartbeat cycle |
| NFR-011 | Scalability | Concurrent active sessions | Minimum 5 concurrent sessions |
| NFR-012 | Maintainability | Skill manifests must be version-pinned | Required field in manifest |
| NFR-013 | Maintainability | Plugin configuration via structured config key scheme | `plugins.entries.<name>` |
| NFR-014 | Compliance | No model training or fine-tuning | File-based memory only |

---

## SECTION 8 ??AUTOMATION CONTRACT

### Tech Stack

| Item | Confirmed |
|---|---|
| Language | TypeScript |
| Framework | Express.js (HTTP) + `ws` library (WebSocket) |
| Database | File system (`~/.aaos/`) ??JSONL for session logs, Markdown for memory |
| ORM | None |
| Auth method | JWT (device identity / Control UI) + HMAC-SHA256 (LINE webhook) |
| Test runner | Jest |
| Package mgr | npm |
| Runtime | Docker container (Linux) |

### UI Style Preferences

| Item | Confirmed |
|---|---|
| Layout pattern | Dashboard ??left sidebar (channels/nodes/memory) + main chat panel + top health bar |
| Component density | Standard |
| Primary action position | Bottom-right (send message) |

### Pipeline Automation Defaults

| Scenario | Confirmed |
|---|---|
| File conflict (src/ already exists) | overwrite-all |
| Auto-fix (test failure / 50-line violation) | auto-fix-silently (max 3 attempts, log and continue) |
| Traceability gap | auto-resolve (infer from context, log decision) |
| SDD open question | apply-best-practice-default (log decision) |
| Conflicting requirements | higher-priority-FR-wins (per Section 3 build priority) |
| Minimum test coverage | 80% |
