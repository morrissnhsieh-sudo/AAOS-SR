# ARCHITECTURE BLUEPRINT
## AAOS ??Autonomous Agent Orchestration System
Auto-generated from SDD-revised.md, FEATURE_TREE.md, and REQUIREMENTS_CONTRACT.md.
This document is the primary input for /codegenerate.
Do NOT edit manually ??re-run /docblueprint if changes are needed.

---

## Quick Reference

| Metric | Value |
|---|---|
| Total components | 11 |
| Total FN-NNN mapped | 141 |
| Dependency layers | 4 (Layer 0??) |
| Build positions | 11 |
| Constraints resolved | 23 |
| Responsibility conflicts | 0 |
| Cycles detected | 0 |
| Auto-fixes applied | 0 |

---

## 1. Constraint Decision Log

*(Full content ??see `docs/blueprint/CONSTRAINT_LOG.md`)*

### Critical Constraints Summary

| ID | Constraint | Scope |
|---|---|---|
| C-001 | TypeScript only | All src/ files |
| C-002 | Express.js for HTTP | channel_manager, mcp_server, skill_manager, node_manager |
| C-003 | `ws` library for WebSocket | channel_manager, node_manager |
| C-004 | File system only (no DB) | memory_system, skill_manager |
| C-005 | JWT + HMAC-SHA256 auth only | auth_manager, channel_manager |
| C-006 | Jest for tests | tests/ |
| C-007 | npm only | package management, skill install |
| C-008 | Docker Linux runtime | All I/O paths must use posix-style |
| C-009 | No ORM | All persistence functions |
| C-010 | LINE webhook ack < 3000ms | channel_manager ??sync 200 before async processing |
| C-011 | MCP bound to 127.0.0.1 | mcp_server ??listen on loopback only |
| C-012 | WS auth before connection accept | channel_manager ??check at upgrade event |
| C-013 | LINE sig checked as middleware | channel_manager ??before route handler |
| C-014 | Heartbeat interval via env var | heartbeat_monitor ??HEARTBEAT_INTERVAL_MS |
| C-015 | 80% test coverage | jest.config.ts |
| C-016 | Compaction keeps last 20 msgs | memory_system ??COMPACTION_KEEP_RECENT env |
| C-017 | Compaction queue timeout 30s | memory_system ??CompactionTimeoutError |
| C-018 | LINE `message` type only (MVP) | channel_manager ??ignore other event types |
| C-019 | SkillStore ??registry.json | skill_manager ??~/.aaos/skills/registry.json |
| C-020 | SessionStore in-memory + warm start | channel_manager ??Map<string, Session> |
| C-021 | ACP pipeline max 10 stages | acp_runtime ??PipelineLimitError |
| C-022 | Subsystem ping timeout 10s | heartbeat_monitor ??Promise.race |
| C-023 | Functions ??50 LOC | All src/ files |

---

## 2. Component Responsibility Matrix

*(Full content ??see `docs/blueprint/RESPONSIBILITY_MATRIX.md`)*

### Ownership Summary

| Component File | Owns |
|---|---|
| `auth_manager.ts` | JWT ops, HMAC verification, admin role check, message validation |
| `tool_dispatcher.ts` | Tool registry, tool execution, skill handler invocation |
| `plugin_engine.ts` | LLM provider load/init/enable/disable, config key resolution |
| `memory_system.ts` | Compaction orchestration, session JSONL, workspace memory R/W |
| `skill_manager.ts` | npm install, manifest parse, skill store, tool registration |
| `acp_runtime.ts` | ACP retry/failover, provider selection, pipeline execution |
| `mcp_server.ts` | MCP endpoint, tool manifest, loopback binding |
| `node_manager.ts` | Node registration, task dispatch, result aggregation |
| `agent_runner.ts` | Prompt assembly, LLM response handling, agent lifecycle |
| `channel_manager.ts` | Channel I/O, session routing, message delivery, WS protocol |
| `heartbeat_monitor.ts` | Health scheduling, keepalive, compaction trigger, log flush |

---

## 3. Directed Dependency Graph

*(Full content ??see `docs/blueprint/DEPENDENCY_GRAPH.md`)*

```
LAYER 0 (foundation):
  auth_manager.ts         ??(none)
  tool_dispatcher.ts      ??(none)
  plugin_engine.ts        ??(none)

LAYER 1 (services):
  memory_system.ts        ??plugin_engine
  skill_manager.ts        ??tool_dispatcher
  acp_runtime.ts          ??plugin_engine
  mcp_server.ts           ??tool_dispatcher
  node_manager.ts         ??auth_manager

LAYER 2 (features):
  agent_runner.ts         ??auth_manager, tool_dispatcher, acp_runtime, memory_system, plugin_engine

LAYER 3 (coordinators):
  channel_manager.ts      ??auth_manager, agent_runner
  heartbeat_monitor.ts    ??memory_system, channel_manager
```

**No cycles ??| Topological sort valid ??*

---

## 4. Build Order & Interface Contracts

*(Full content ??see `docs/blueprint/BUILD_ORDER.md`)*

| Position | File | Layer | Key Exports |
|---|---|---|---|
| 01 | `src/auth/auth_manager.ts` | 0 | generate_device_jwt, validate_device_jwt, validate_line_signature, validate_internal_message, transform_to_internal_message |
| 02 | `src/tools/tool_dispatcher.ts` | 0 | register_tool, lookup_tool_handler, execute_tool, io_invoke_skill_handler |
| 03 | `src/plugins/plugin_engine.ts` | 0 | load_plugins_from_config, initialize_plugin, enable_plugin, disable_plugin, resolve_plugin_config_key |
| 04 | `src/memory/memory_system.ts` | 1 | orchestrate_context_compaction, io_append_message_to_session_log, io_load_workspace_memory_files, io_write_to_memory_md, io_write_session_jsonl |
| 05 | `src/skills/skill_manager.ts` | 1 | io_run_npm_install, parse_skill_manifest_yaml, register_skill_tools, io_list_installed_skills, io_disable_skill |
| 06 | `src/acp/acp_runtime.ts` | 1 | execute_with_acp_retry, select_next_available_provider |
| 07 | `src/mcp/mcp_server.ts` | 1 | io_handle_mcp_request, build_mcp_tool_manifest, bind_mcp_to_loopback |
| 08 | `src/nodes/node_manager.ts` | 1 | io_receive_node_registration, register_node, select_available_node, io_dispatch_task_to_node |
| 09 | `src/agent/agent_runner.ts` | 2 | start_agent_run, assemble_llm_prompt, dispatch_tool_calls_parallel, chain_agent_run_stages |
| 10 | `src/channel/channel_manager.ts` | 3 | io_receive_line_webhook, io_accept_ws_connection, get_or_create_session, io_deliver_to_line, io_deliver_to_ws_client |
| 11 | `src/heartbeat/heartbeat_monitor.ts` | 3 | schedule_heartbeat, ping_all_subsystems, flush_session_logs, apply_startup_grace_period |

---

## CODEGENERATE INSTRUCTIONS

```
CODEGENERATE INSTRUCTIONS (derived from Blueprint):

1. Read this file (docs/ARCHITECTURE_BLUEPRINT.md) before writing any file.

2. Write files in the exact sequence from Section 4 (Build Order).
   Do NOT generate files out of order.

3. For each file, implement ONLY the functions listed in its Exposes section.
   No additional functions.

4. For each function, use EXACTLY the signature declared in docs/blueprint/BUILD_ORDER.md.
   No parameter additions or removals.

5. Add ONLY the imports listed in docs/blueprint/DEPENDENCY_GRAPH.md Import Allowlist.
   No other internal imports are permitted.

6. Apply every relevant CONSTRAINT from docs/blueprint/CONSTRAINT_LOG.md.
   Constraints marked with this file's scope are mandatory.

7. Respect the Responsibility Matrix (docs/blueprint/RESPONSIBILITY_MATRIX.md).
   If a behavior belongs to another component, call its declared API ??never re-implement.

8. After writing each file, verify:
   - Line count ??50 per function
   - All declared functions are implemented
   - All imports are on the allowlist
   - No behavior from another component is implemented here
```
