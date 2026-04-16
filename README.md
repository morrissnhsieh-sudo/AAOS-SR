# USI AI‑OS<sup>®</sup>
## AAOS — Autonomous Agent Operating System

A self-hosted, cross-platform AI agent gateway. AAOS runs a persistent agent server that connects to your choice of LLM provider, executes tools, manages long-term memory, ingests documents into a knowledge base, controls IoT devices, and schedules background agent tasks — all without cloud lock-in.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Architecture Overview](#architecture-overview)
3. [Environment Configuration](#environment-configuration)
   - [Windows](#windows)
   - [Linux](#linux)
   - [macOS](#macos)
4. [LLM Providers & Model Selection](#llm-providers--model-selection)
5. [Native Tools](#native-tools)
6. [Skills System](#skills-system)
7. [Scheduler — Background Agent Tasks](#scheduler--background-agent-tasks)
8. [Wiki — Knowledge Base](#wiki--knowledge-base)
9. [Memory System](#memory-system)
10. [IoT Tools](#iot-tools)
11. [API Reference](#api-reference)
12. [MCP Server](#mcp-server)
13. [Directory Layout](#directory-layout)
14. [NPM Scripts](#npm-scripts)

---

## Quick Start

### Prerequisites

| Requirement | Windows | Linux | macOS |
|---|---|---|---|
| Node.js 18+ | ✅ | ✅ | ✅ |
| npm 9+ | ✅ | ✅ | ✅ |
| Git Bash / WSL (for shell tools) | ✅ required | — | — |
| Python 3.10+ (for OCR / Vision) | optional | optional | optional |
| `pdftotext` / poppler (for PDF ingestion) | optional | optional | optional |

### Install & Run

```bash
# 1. Clone and install dependencies
git clone https://github.com/your-org/aaos.git
cd aaos
npm install

# 2. Create your environment file from the template
cp .env.example .env
# Open .env and fill in your API keys and workspace path
# (see Environment Configuration section below for all options)

# 3. Start the server
npm run dev          # development (hot-reload via tsx)
npm start            # production (compiled JS)
```

The server starts on **http://localhost:3000**.  
The MCP loopback starts on **http://127.0.0.1:3001** (local only).  
Connect via WebSocket at **ws://localhost:3000/ws/chat**.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│           USI AI‑OS® - Personal Assistant (port 3000)   │
│                                                         │
│  WebSocket ──► Channel Manager ──► Agent Runner         │
│  REST API  ──►                     │                    │
│  LINE Webhook                      ▼                    │
│                              Tool Dispatcher            │
│                         ┌─────────┴──────────┐         │
│                    Native Tools          Skills          │
│                    (always on)       (SKILL.md files)   │
│                         │                               │
│              ┌──────────┼──────────┐                   │
│           Plugin     Memory     Scheduler               │
│           Engine     System     Engine                  │
│        (LLM calls)  (facts/    (cron jobs)              │
│                      sessions)                          │
└─────────────────────────────────────────────────────────┘
```

**Key design principles:**
- **Skills extend the agent** — drop a `SKILL.md` file into `workspace/skills/<name>/` to give the agent new capabilities; skills are versioned with the code
- **Provider-agnostic LLM** — swap between Anthropic, Google Gemini, Claude-on-Vertex, or Ollama by changing one env var
- **Cross-platform** — runs identically on Windows, Linux, and macOS; OS is detected at startup and the correct shell/Python is selected automatically
- **Configurable workspace** — skills and scripts live in `workspace/` by default; override with `AAOS_WORKSPACE` in `.env` to point anywhere

---

## Environment Configuration

All configuration is done via a `.env` file in the project root (loaded by `dotenv` at startup) or by setting environment variables in your shell.

### Minimal `.env` (choose one provider)

**Using Anthropic (Claude):**
```env
AAOS_LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-api03-...
```

**Using Google Vertex AI (Gemini):**
```env
AAOS_LLM_PROVIDER=google
VERTEX_PROJECT_ID=your-gcp-project-id
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

**Using Claude on Vertex AI:**
```env
AAOS_LLM_PROVIDER=anthropic-vertex
VERTEX_PROJECT_ID=your-gcp-project-id
GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
```

---

### Windows

```env
# LLM Provider
AAOS_LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-api03-...

# Workspace — default is ./workspace inside the repo; override here if needed
AAOS_WORKSPACE=C:\Users\YourName\Code\AAOS\workspace

# Snapshots (webcam captures)
AAOS_SNAPSHOTS_DIR=C:/Temp/aaos_snapshots

# Google credentials (if using Vertex/Gemini)
GOOGLE_APPLICATION_CREDENTIALS=C:/Users/YourName/.config/gcloud/service-account.json

# Scheduler timezone
TZ=Asia/Hong_Kong
```

**Windows-specific notes:**
- AAOS auto-detects Git Bash (`bash.exe`) and prefers it for Unix-style shell commands
- Falls back to `cmd.exe` when a command starts with a Windows drive path (e.g. `C:\`)
- Python is located automatically via `where python` (cmd.exe); you can override with `PYTHON_EXE=C:\Python312\python.exe`
- Install [Git for Windows](https://git-scm.com/download/win) to get bash support
- Install [poppler for Windows](https://github.com/oschwartz10612/poppler-windows) and add to PATH for PDF text extraction

---

### Linux

```env
# LLM Provider
AAOS_LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-api03-...

# Workspace (default: ~/.aaos — usually no need to set)
AAOS_WORKSPACE=/home/yourname/.aaos

# Google credentials (if using Vertex/Gemini)
GOOGLE_APPLICATION_CREDENTIALS=/home/yourname/.config/gcloud/service-account.json

# Scheduler timezone
TZ=Asia/Hong_Kong
```

**Linux-specific notes:**
- Shell defaults to `/bin/bash` (falls back to `/bin/sh`)
- Python resolved from `/usr/bin/python3` → `/usr/local/bin/python3`
- Install poppler-utils for PDF extraction: `sudo apt install poppler-utils`
- Install PyMuPDF for scanned PDF OCR: `pip3 install pymupdf`
- Snapshots default to `/tmp/aaos_snapshots` (no configuration needed)

---

### macOS

```env
# LLM Provider
AAOS_LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-api03-...

# Workspace (default: ~/.aaos — usually no need to set)
AAOS_WORKSPACE=/Users/yourname/.aaos

# Google credentials (if using Vertex/Gemini)
GOOGLE_APPLICATION_CREDENTIALS=/Users/yourname/.config/gcloud/service-account.json

# Scheduler timezone
TZ=Asia/Hong_Kong
```

**macOS-specific notes:**
- Shell defaults to `/bin/zsh` (falls back to `/bin/bash`)
- Python resolved from Homebrew paths first: `/opt/homebrew/bin/python3` (Apple Silicon), `/usr/local/bin/python3` (Intel)
- Install poppler via Homebrew: `brew install poppler`
- Install PyMuPDF: `pip3 install pymupdf`
- Snapshots default to `/var/folders/.../T/aaos_snapshots` (macOS tmpdir)

---

### Complete Environment Variable Reference

| Variable | Default | Description |
|---|---|---|
| **LLM** | | |
| `AAOS_LLM_PROVIDER` | `google` | Active LLM provider: `anthropic`, `google`, `anthropic-vertex`, `ollama` |
| `ANTHROPIC_API_KEY` | — | Anthropic API key (required for `anthropic` provider) |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | Anthropic model name |
| `VERTEX_PROJECT_ID` | — | Google Cloud project ID (required for `google` / `anthropic-vertex`) |
| `VERTEX_LOCATION` | `us-central1` | Vertex AI region |
| `VERTEX_MODEL` | `gemini-2.0-flash` | Gemini model name |
| `ANTHROPIC_VERTEX_MODEL` | `claude-sonnet-4-5` | Claude model when using Vertex |
| `ANTHROPIC_VERTEX_REGION` | `us-east5` | Vertex region for Claude |
| `GOOGLE_APPLICATION_CREDENTIALS` | auto-detected | Path to GCP service account JSON |
| **Storage** | | |
| `AAOS_WORKSPACE` | `~/.aaos` | Root workspace directory for all AAOS data |
| `AAOS_SNAPSHOTS_DIR` | `$TMPDIR/aaos_snapshots` | Directory for webcam snapshot images |
| **Server** | | |
| `JWT_SECRET` | `secret` | Secret for signing device JWT tokens — **change in production** |
| `LINE_CHANNEL_SECRET` | — | LINE Messaging API channel secret |
| `LINE_CHANNEL_ACCESS_TOKEN` | — | LINE Messaging API access token |
| **Agent** | | |
| `COMPACTION_KEEP_RECENT` | `20` | Number of recent messages to retain during context compaction |
| **Scheduler** | | |
| `TZ` | system timezone | Timezone for cron jobs (e.g. `Asia/Hong_Kong`, `America/New_York`) |
| **Heartbeat** | | |
| `HEARTBEAT_INTERVAL_MS` | `300000` | Health check interval (milliseconds) |
| `STARTUP_GRACE_MS` | `60000` | Grace period before first health check (milliseconds) |

---

## LLM Providers & Model Selection

### Supported Providers

| Provider | `AAOS_LLM_PROVIDER` value | Description |
|---|---|---|
| Anthropic API | `anthropic` | Direct Anthropic API — simplest setup |
| Google Vertex AI | `google` | Gemini models via Google Cloud |
| Claude on Vertex | `anthropic-vertex` | Claude models served through Google Cloud |
| Ollama | `ollama` | Local models (experimental) |

### Available Models

**Anthropic (`anthropic`):**
| Model | Speed | Best for |
|---|---|---|
| `claude-haiku-4-5` | Fast | Quick tasks, high-volume |
| `claude-sonnet-4-6` | Balanced | General use (default) |

**Google Vertex AI (`google`):**
| Model | Speed | Best for |
|---|---|---|
| `gemini-2.0-flash` | Fast | General use (default) |
| `gemini-2.0-flash-lite` | Fastest | High-volume, simple tasks |
| `gemini-1.5-flash` | Fast | Stable production use |
| `gemini-1.5-pro` | Slower | Complex reasoning |

**Claude on Vertex (`anthropic-vertex`):**
| Model | Speed | Best for |
|---|---|---|
| `claude-haiku-4-5` | Fast | Quick tasks |
| `claude-sonnet-4-5` | Balanced | General use |

### Per-Role Model Overrides

AAOS uses four internal agent roles. You can assign a different model to each role:

| Role | Purpose |
|---|---|
| `chatbot` | Main conversational agent the user talks to |
| `skill_builder` | Generates new SKILL.md files from descriptions |
| `memory_extractor` | Extracts facts from conversations to save to memory |
| `wiki_compiler` | Compiles ingested documents into structured wiki pages |

**To set a model for a specific role via API:**
```bash
# Use Haiku for the wiki compiler (fast, cheaper for bulk ingestion)
curl -X POST http://localhost:3000/api/model-config/wiki_compiler \
  -H "Content-Type: application/json" \
  -d '{"provider": "anthropic", "model": "claude-haiku-4-5"}'

# Reset a role back to the active provider default
curl -X POST http://localhost:3000/api/model-config/wiki_compiler/reset
```

**To switch the active provider for all roles at once:**
```bash
curl -X POST http://localhost:3000/api/model \
  -H "Content-Type: application/json" \
  -d '{"provider": "anthropic"}'
```

Role overrides are persisted to `workspace/model_config.json` and survive server restarts.

---

## Native Tools

These tools are always available to the agent regardless of installed skills.

| Tool | Description |
|---|---|
| `file_read` | Read text files (max 200 KB). Blocks binary formats — use `wiki_ingest` for PDFs/DOCX. |
| `file_write` | Write or append text to files. Creates missing parent directories. |
| `file_list` | List directory contents recursively with file sizes. |
| `file_search` | Regex search across file contents in a directory. |
| `sys_info` | Get OS, platform, shell, Python executable, home directory, and snapshots path. |
| `think` | Internal reasoning step — lets the agent think out loud without side effects. |
| `remember` | Persist a fact to long-term memory at `workspace/memory/MEMORY.md`. |
| `web_fetch` | Fetch any URL. **Automatically parses RSS/Atom feeds** into clean structured items. Strips HTML to readable text. Never use `bash_exec+curl` for URLs — always use this. |
| `bash_exec` | Run shell commands. Uses bash on Linux/macOS, auto-selects bash or cmd.exe on Windows. |
| `analyze_image` | Vision analysis of local images (PNG/JPG/WebP) via Google Gemini Vision. |
| `analyze_video` | Vision analysis of local video files (MP4/MOV/WebM) via Gemini. |
| `webcam_capture` | Capture a snapshot from the system webcam. |
| `build_skill` | Generate a new SKILL.md from a natural language description. |
| `wiki_ingest` | Ingest a document (PDF, DOCX, XLSX, URL, text) into the knowledge base. |
| `wiki_search` | Full-text search across all compiled wiki pages. |
| `wiki_lint` | Validate wiki structure; optionally auto-fix broken links. |
| `schedule_create` | Create a scheduled background agent task. |
| `schedule_list` | List all scheduled jobs with status and last run result. |
| `schedule_delete` | Permanently remove a scheduled job. |
| `schedule_pause` | Disable a job without deleting it. |
| `schedule_resume` | Re-enable a paused job. |
| `schedule_run_now` | Trigger a job immediately outside its normal schedule. |
| `iot_scan` | Scan the local network for IoT devices. |
| `iot_devices` | Query the scanned device registry. |
| `iot_mqtt_subscribe` | Subscribe to MQTT topics and buffer messages. |
| `iot_mqtt_read` | Read buffered MQTT messages. |
| `iot_mqtt_publish` | Publish a message to an MQTT topic. |
| `iot_tcp_send` | Send a raw TCP command to a device (RFID, barcode scanners, etc.). |
| `iot_mqtt_connections` | List or close active MQTT broker connections. |

---

## Skills System

Skills are Markdown files (`SKILL.md`) that extend the agent with domain-specific instructions, tool permissions, and workflows. The agent reads all enabled skills at the start of each session.

### Storage

Skills live in the workspace `skills/` directory, versioned with the source code:

```
workspace/skills/
├── gmail/
│   └── SKILL.md          # Gmail via browser session or IMAP
├── outlook/
│   └── SKILL.md          # Outlook via IMAP
├── browser/
│   └── SKILL.md          # Browser automation via Playwright
├── github/
│   └── SKILL.md
└── registry.json         # Tracks enabled/disabled status (relative paths)
```

The workspace location is set by `AAOS_WORKSPACE` in `.env`. Default: `./workspace` (inside the repo). Override to use a shared team workspace or a personal one:

```env
# Default — versioned alongside the code
AAOS_WORKSPACE=C:\Users\YourName\Code\AAOS\workspace

# Personal override — your own workspace outside the repo
AAOS_WORKSPACE=C:\Users\YourName\.aaos

# Shared team workspace on a network drive
AAOS_WORKSPACE=\\server\shared\aaos-workspace
```

Skill SKILL.md files may use `{WORKSPACE}` as a placeholder — it is automatically resolved to the active workspace path at load time.

### SKILL.md Format

```markdown
---
name: my-skill
description: "When to activate this skill and what it does"
allowed-tools: bash_exec, file_write, web_fetch
version: 1.0.0
---

# My Skill

Instructions for the agent go here — what commands to run,
what patterns to follow, example invocations, etc.
```

### Managing Skills

```bash
# List installed skills
curl http://localhost:3000/api/skills

# Build a new skill from a description
curl -X POST http://localhost:3000/api/skills/build \
  -H "Content-Type: application/json" \
  -d '{"description": "Search Slack and summarize unread messages"}'

# Install a skill from a directory
curl -X POST http://localhost:3000/api/skills/install \
  -H "Content-Type: application/json" \
  -d '{"path": "/path/to/skill-directory"}'

# Disable a skill
curl -X DELETE http://localhost:3000/api/skills/my-skill
```

Or just ask the agent:
> *"Build me a skill that monitors our PostgreSQL database for slow queries"*

---

## Scheduler — Background Agent Tasks

The built-in cron engine runs agent tasks on a schedule using `node-cron`. Jobs persist across server restarts.

### Creating a Scheduled Job

Just ask the agent:
> *"Every morning at 8am, search Google News for AI headlines and save the top 5 to memory"*

The agent will call `schedule_create` and then `schedule_run_now` to verify it works before confirming.

### Schedule Formats

Both cron expressions and natural language are accepted:

| Natural Language | Cron |
|---|---|
| `every day at 8:00am` | `0 8 * * *` |
| `every monday at 9am` | `0 9 * * 1` |
| `every 30 minutes` | `*/30 * * * *` |
| `every hour` | `0 * * * *` |
| `every friday at 5:30pm` | `30 17 * * 5` |
| `weekdays at 7am` | `0 7 * * 1-5` |
| `@daily` | `0 0 * * *` |
| `@hourly` | `0 * * * *` |

### Timezone

Set `TZ` in your `.env`:
```env
TZ=Asia/Hong_Kong      # UTC+8
TZ=Europe/London       # GMT/BST
TZ=America/New_York    # EST/EDT
```

### Job Persistence

Jobs are stored at `workspace/scheduler/jobs.json` and automatically re-activated when the server starts.

---

## Wiki — Knowledge Base

The wiki is a three-layer Karpathy-style compiled knowledge base stored at `workspace/wiki/`.

```
workspace/wiki/
├── sources/      # Raw ingested content (snapshots of URLs, PDFs, pastes)
├── pages/        # LLM-compiled structured Markdown pages
└── SCHEMA.md     # Rules and templates the wiki_compiler follows
```

### Ingesting Documents

```
# Via agent chat:
"Ingest the ISO 26262 documentation from C:\Wiki\ISO26262"
"Add this URL to the wiki: https://example.com/docs"

# Via API:
curl -X POST http://localhost:3000/api/wiki/ingest \
  -H "Content-Type: application/json" \
  -d '{"source": "C:/Wiki/ISO26262", "title": "ISO-26262"}'
```

**Supported formats:**
- Plain text / Markdown
- Web URLs (fetched and stripped)
- PDF (text-based via `pdftotext`; scanned via PyMuPDF + Gemini Vision OCR)
- DOCX (extracted via `unzip` + XML parsing)
- XLSX (shared strings extracted)
- Directories (all supported files batched automatically)

### Searching the Wiki

```
"What does the wiki say about functional safety requirements?"
```

Or via API:
```bash
curl "http://localhost:3000/api/wiki/pages/ISO-26262"
```

---

## Memory System

Long-term facts are stored as a Markdown list at `workspace/memory/MEMORY.md`. The agent loads this file at the start of every session.

```bash
# Add a fact
curl -X POST http://localhost:3000/api/memory \
  -H "Content-Type: application/json" \
  -d '{"fact": "The production database is at db.internal:5432"}'

# View all facts
curl http://localhost:3000/api/memory

# Remove a fact
curl -X DELETE http://localhost:3000/api/memory \
  -H "Content-Type: application/json" \
  -d '{"fact": "The production database is at db.internal:5432"}'
```

Session conversation logs are stored at `workspace/sessions/{sessionId}.jsonl` (one JSON message per line).

---

## IoT Tools

AAOS can scan your local network, subscribe to MQTT brokers, and send TCP commands to connected devices.

### Supported Device Types (auto-detected during scan)

- MQTT brokers (port 1883)
- IP cameras
- Temperature / humidity sensors
- RFID readers
- Electronic price tags (ESL)
- Modbus devices
- Smart plugs
- Generic HTTP / TCP devices

### Example

```
"Scan the 192.168.1.0/24 network for IoT devices"
"Subscribe to the topic sensors/# on the broker at 192.168.1.10"
"Publish {temperature: 22.5} to sensors/room1/temp"
```

Device registry is stored at `workspace/iot/devices.json`.

---

## API Reference

**Base URL:** `http://localhost:3000`

### Agent

| Method | Path | Body / Params | Description |
|---|---|---|---|
| `WS` | `/ws/chat` | — | Main chat WebSocket |
| `POST` | `/api/agent/run` | `{ message, session_id? }` | Run agent programmatically (used by scheduler) |

### Skills

| Method | Path | Body / Params | Description |
|---|---|---|---|
| `GET` | `/api/skills` | — | List all installed skills |
| `POST` | `/api/skills/install` | `{ path }` | Install skill from directory |
| `DELETE` | `/api/skills/:id` | — | Disable a skill |
| `POST` | `/api/skills/build` | `{ description }` | Generate skill from description |

### Model Configuration

| Method | Path | Body / Params | Description |
|---|---|---|---|
| `GET` | `/api/model` | — | Get active provider |
| `POST` | `/api/model` | `{ provider }` | Switch active provider (clears role overrides) |
| `GET` | `/api/model-config` | — | Get per-role model assignments |
| `POST` | `/api/model-config/:role` | `{ provider, model }` | Set model for a role |
| `POST` | `/api/model-config/:role/reset` | — | Reset role to active provider |

Valid roles: `chatbot`, `skill_builder`, `memory_extractor`, `wiki_compiler`

### Wiki

| Method | Path | Body / Params | Description |
|---|---|---|---|
| `GET` | `/api/wiki/pages` | — | List all wiki pages |
| `GET` | `/api/wiki/pages/*` | — | Read a page by name |
| `POST` | `/api/wiki/ingest` | `{ source, title? }` | Ingest document or URL |
| `POST` | `/api/wiki/lint` | `{ auto_fix? }` | Validate wiki; optionally auto-fix |

### Memory

| Method | Path | Body / Params | Description |
|---|---|---|---|
| `GET` | `/api/memory` | — | Get all memory facts |
| `POST` | `/api/memory` | `{ fact }` | Add a fact |
| `DELETE` | `/api/memory` | `{ fact }` | Remove a fact |

### Files

| Method | Path | Body / Params | Description |
|---|---|---|---|
| `POST` | `/api/upload` | `multipart/form-data` | Upload a file (max 200 MB) |
| `GET` | `/uploads/:filename` | — | Serve an uploaded file |
| `GET` | `/snapshots/:filename` | — | Serve a webcam snapshot |

### Monitoring

| Method | Path | Body / Params | Description |
|---|---|---|---|
| `GET` | `/api/health` | — | Gateway health report |
| `GET` | `/api/usage` | `?period=24h` | Token usage and cost (periods: `1h` `6h` `24h` `7d` `30d` `all`) |

### Auth & Integrations

| Method | Path | Body / Params | Description |
|---|---|---|---|
| `GET` | `/auth/ui-token` | — | Generate a short-lived JWT for UI access |
| `POST` | `/webhook/line` | LINE event payload | LINE Messaging API webhook |

---

## MCP Server

AAOS exposes all registered tools over the [Model Context Protocol](https://modelcontextprotocol.io/) on a local loopback server at **http://127.0.0.1:3001**.

This allows Claude Code and other MCP-compatible clients to invoke AAOS tools directly.

| Method | Path | Description |
|---|---|---|
| `GET` | `/mcp/manifest` | Returns all available tool definitions |
| `POST` | `/mcp` | Invoke a tool: `{ "tool": "...", "args": { ... } }` |

The MCP server is **localhost-only** and carries no authentication — it is not reachable from the network.

---

## Directory Layout

```
AAOS/
├── src/
│   ├── index.ts                  # Express server, routes, startup
│   ├── agent/
│   │   └── agent_runner.ts       # Agent loop, tool invocation, history management
│   ├── plugins/
│   │   └── plugin_engine.ts      # LLM provider abstraction, model selection
│   ├── tools/
│   │   ├── native_tools.ts       # Built-in tools (file, web, bash, vision, etc.)
│   │   ├── iot_tools.ts          # IoT tools (MQTT, TCP, network scan)
│   │   ├── wiki_tools.ts         # Wiki ingestion, compilation, search
│   │   └── tool_dispatcher.ts    # Tool registry and execution
│   ├── scheduler/
│   │   ├── scheduler_engine.ts   # node-cron runner, job lifecycle
│   │   ├── scheduler_tools.ts    # schedule_* tools for the agent
│   │   ├── scheduler_store.ts    # Job persistence (schedules.json)
│   │   └── os_env.ts             # OS detection, shell/Python resolution
│   ├── skills/
│   │   ├── skill_manager.ts      # Skill registry, loading, enabling/disabling
│   │   └── skill_builder.ts      # LLM-based skill generation
│   ├── memory/
│   │   └── memory_system.ts      # MEMORY.md, session logs, compaction
│   ├── channel/
│   │   └── channel_manager.ts    # WebSocket sessions, LINE webhook
│   ├── mcp/
│   │   └── mcp_server.ts         # MCP protocol loopback server
│   ├── auth/
│   │   └── auth_manager.ts       # JWT signing/verification
│   ├── heartbeat/
│   │   └── heartbeat_monitor.ts  # Health checks, subsystem pings
│   ├── usage/
│   │   └── usage_tracker.ts      # Token count and cost logging
│   └── acp/
│       └── acp_runtime.ts        # Agent Control Protocol pipeline
│
├── workspace/                    # Default workspace (set AAOS_WORKSPACE to override)
│   ├── skills/                   # ✅ VERSIONED — SKILL.md files & registry.json
│   │   ├── gmail/SKILL.md
│   │   ├── outlook/SKILL.md
│   │   └── registry.json         # Relative paths — works for any user
│   ├── scripts/                  # ✅ VERSIONED — Python helper scripts
│   │   ├── gmail_imap.py
│   │   └── outlook_imap.py
│   ├── BOOT.md                   # ✅ VERSIONED — Agent boot instructions
│   ├── memory/                   # 🔒 gitignored — runtime facts
│   ├── sessions/                 # 🔒 gitignored — conversation logs
│   ├── uploads/                  # 🔒 gitignored — user-uploaded files
│   ├── playwright_profile/       # 🔒 gitignored — browser login sessions
│   └── credentials.yaml          # 🔒 gitignored — saved credentials
│
├── .env                          # Environment configuration (create this)
├── package.json
└── tsconfig.json
```

---

## NPM Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start in development mode with hot-reload (`tsx`) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled production build from `dist/` |
| `npm test` | Run Jest test suite with coverage |
