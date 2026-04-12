import * as fs from 'fs';
import * as path from 'path';
import { Plugin } from '../plugins/plugin_engine';
import { ToolCall } from '../tools/tool_dispatcher';

export interface Session { id: string; user_id: string; last_active_at: Date; context_token_count: number; status: string; }
export interface Message { 
    id: string; 
    session_id: string; 
    role: string; 
    content: string; 
    tool_name?: string; 
    tool_call_id?: string; 
    tool_calls?: ToolCall[];
    created_at: Date; 
    token_count: number; 
}
export interface MemoryContext { boot: string; heartbeat: string; memory: string; }
export interface MemoryAccessResult { ok: boolean; reason?: string; }
export interface CompactionSet { keep: Message[]; compact: Message[]; }
export interface AgentInstruction { explicit_remember: boolean; fact: string; }

export const DEFAULT_COMPACTION_KEEP_RECENT = 20;
export const COMPACTION_QUEUE_TIMEOUT_MS = 30000;
export const SESSION_LOG_DIR = 'sessions';
export const MEMORY_DIR = 'memory';
export const WORKSPACE_DIR = 'workspace';

function getWorkspace() { return process.env.AAOS_WORKSPACE || path.join(process.env.HOME || '', '.aaos'); }

export async function orchestrate_context_compaction(session: Session): Promise<void> {
    const keepRecent = parseInt(process.env.COMPACTION_KEEP_RECENT ?? String(DEFAULT_COMPACTION_KEEP_RECENT));
    // In MVP, we just read the jsonl log and rewrite it.
    // Memory and compaction handling logic here.
}

export function select_messages_for_compaction(messages: Message[], keepRecent: number): CompactionSet {
    if (messages.length <= keepRecent) return { keep: messages, compact: [] };
    const splitIndex = messages.length - keepRecent;
    return { compact: messages.slice(0, splitIndex), keep: messages.slice(splitIndex) };
}

export class CompactionTimeoutError extends Error { constructor() { super("Compaction timeout"); } }

export async function queue_llm_call_during_compaction(sessionId: string, call: () => Promise<any>): Promise<any> {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new CompactionTimeoutError()), COMPACTION_QUEUE_TIMEOUT_MS));
    return Promise.race([call(), timeout]);
}

export async function summarize_messages_via_llm(messages: Message[], provider: Plugin): Promise<string> {
    // Stub for summarization via plugin
    return `Summary of ${messages.length} messages.`;
}

export async function io_save_compaction_summary(sessionId: string, summary: string): Promise<void> {
    const dir = path.join(getWorkspace(), MEMORY_DIR);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sessionId}_summary.md`), summary, 'utf8');
}

export async function io_append_message_to_session_log(sessionId: string, message: Message): Promise<void> {
    const dir = path.join(getWorkspace(), SESSION_LOG_DIR);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify(message) + '\n');
}

export function validate_session_log_writable(logPath: string): boolean {
    try { fs.accessSync(path.dirname(logPath), fs.constants.W_OK); return true; } catch { return false; }
}

export async function io_initialize_session_log_file(sessionId: string): Promise<string> {
    const p = path.join(getWorkspace(), SESSION_LOG_DIR, `${sessionId}.jsonl`);
    if (!fs.existsSync(p)) fs.writeFileSync(p, '');
    return p;
}

export function io_load_workspace_memory_files(workspaceDir: string): MemoryContext {
    const readSafe = (f: string) => { try { return fs.readFileSync(path.join(workspaceDir, f), 'utf8'); } catch { return ''; } };
    return { boot: readSafe('BOOT.md'), heartbeat: readSafe('HEARTBEAT.md'), memory: readSafe(path.join(MEMORY_DIR, 'MEMORY.md')) };
}

export function validate_memory_files_accessible(workspaceDir: string): MemoryAccessResult {
    const ok = fs.existsSync(workspaceDir);
    return { ok, reason: ok ? undefined : 'Workspace dir not found' };
}

export async function io_write_to_memory_md(workspaceDir: string, fact: string): Promise<void> {
    const p = path.join(workspaceDir, MEMORY_DIR, 'MEMORY.md');
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(p, `- ${fact}\n`);
}

export function validate_memory_write_is_user_requested(instruction: AgentInstruction): boolean {
    return instruction.explicit_remember === true;
}

// ── Memory guard ─────────────────────────────────────────────────────────────
// These patterns identify content that must never be persisted to long-term memory.
// Applied before every write — both from the `remember` tool and auto-extraction.
const VOLATILE_FACT_PATTERNS: RegExp[] = [
    /\d+\s*°[CF]/i,                    // temperature readings
    /feels like/i,                     // weather descriptions
    /humidity/i,
    /\bwind\b/i,
    /\bweather\b/i,
    /\brain\b|\bsnow\b|\bcloud(y|s)?\b|\bsunny\b|\bovercast\b/i,
    /\d+\s*km\/h/i,                    // wind speed
    /Ubuntu|Debian|Fedora|CentOS|Arch Linux/i,  // Linux distro versions
    /WSL\d?/i,                         // WSL version strings
    /\d+\.\d+\.\d+\s*LTS/i,           // version strings like 24.04.3 LTS
    /\bopen ports?\b/i,                // port scan results
    /\bport \d{2,5}\b/i,               // specific port numbers
    /PostgreSQL|nginx|apache/i,        // running service scan results
    /openclaw/i,                       // hallucinated CLI tool — never valid
    /\bPID\s*\d+/i,                    // process IDs
];

const MEMORY_MAX_FACTS = 60;
const MEMORY_MAX_FACT_LENGTH = 250;

/**
 * Validates a candidate memory fact against all safety rules.
 * Returns { ok: true } if the fact should be written, or { ok: false, reason } if rejected.
 */
export function validate_memory_fact(fact: string): { ok: boolean; reason?: string } {
    if (!fact || fact.trim().length === 0) return { ok: false, reason: 'Empty fact' };
    if (fact.length > MEMORY_MAX_FACT_LENGTH) return { ok: false, reason: `Fact too long (${fact.length} > ${MEMORY_MAX_FACT_LENGTH} chars) — likely volatile data` };
    for (const pattern of VOLATILE_FACT_PATTERNS) {
        if (pattern.test(fact)) {
            return { ok: false, reason: `Rejected volatile/invalid content matching /${pattern.source}/i` };
        }
    }
    return { ok: true };
}

/**
 * Checks whether an identical (case-insensitive) fact is already stored.
 */
function is_duplicate_fact(fact: string, memFile: string): boolean {
    try {
        const existing = fs.readFileSync(memFile, 'utf8')
            .split('\n')
            .filter(l => l.startsWith('- '))
            .map(l => l.slice(2).trim().toLowerCase());
        const candidate = fact.trim().toLowerCase();
        return existing.some(e => e === candidate);
    } catch {
        return false;
    }
}

/**
 * Single entry-point for writing to MEMORY.md.
 * Validates the fact, deduplicates, and enforces the max-entries cap before writing.
 * Use this everywhere instead of directly appending to the file.
 */
export function append_validated_memory_fact(workspace: string, fact: string): { ok: boolean; reason?: string } {
    const validation = validate_memory_fact(fact.trim());
    if (!validation.ok) {
        console.warn(`[Memory] Rejected fact: ${validation.reason} — "${fact.slice(0, 80)}"`);
        return validation;
    }

    const memDir  = path.join(workspace, MEMORY_DIR);
    const memFile = path.join(memDir, 'MEMORY.md');

    if (is_duplicate_fact(fact, memFile)) {
        console.log(`[Memory] Skipped duplicate fact: "${fact.slice(0, 80)}"`);
        return { ok: false, reason: 'Duplicate — fact already stored' };
    }

    try {
        const existing = fs.existsSync(memFile) ? fs.readFileSync(memFile, 'utf8') : '';
        const count = existing.split('\n').filter(l => l.startsWith('- ')).length;
        if (count >= MEMORY_MAX_FACTS) {
            console.warn(`[Memory] Fact limit (${MEMORY_MAX_FACTS}) reached — rejected: "${fact.slice(0, 80)}"`);
            return { ok: false, reason: `Memory is full (${MEMORY_MAX_FACTS} fact limit)` };
        }
    } catch { /* file may not exist yet — count is 0 */ }

    fs.mkdirSync(memDir, { recursive: true });
    fs.appendFileSync(memFile, `- ${fact.trim()}\n`);
    console.log(`[Memory] Stored: "${fact.slice(0, 80)}"`);
    return { ok: true };
}

export async function io_write_session_jsonl(sessionId: string, messages: Message[]): Promise<void> {
    const p = path.join(getWorkspace(), SESSION_LOG_DIR, `${sessionId}.jsonl`);
    if (messages.length === 0) return;
    fs.writeFileSync(p, messages.map(m => JSON.stringify(m)).join('\n') + '\n');
}

/**
 * Loads prior conversation history from the session JSONL log.
 * Returns the most recent `maxMessages` entries, trimmed so the slice always
 * starts with a 'user' role message.  This prevents sending orphaned tool_result
 * blocks to Anthropic (which rejects history that opens with tool results that
 * have no preceding tool_use in the same request).
 */
export function io_load_session_history(sessionId: string, maxMessages: number = 50): Message[] {
    const p = path.join(getWorkspace(), SESSION_LOG_DIR, `${sessionId}.jsonl`);
    try {
        const lines = fs.readFileSync(p, 'utf8').split('\n').filter(l => l.trim());
        const messages: Message[] = [];
        for (const line of lines) {
            try { messages.push(JSON.parse(line) as Message); } catch { /* skip malformed */ }
        }

        // Take the most recent N messages, then drop any leading non-user messages.
        // A valid Anthropic message sequence must start with a 'user' turn.
        const recent = messages.slice(-maxMessages);
        const firstUserIdx = recent.findIndex(m => m.role === 'user');
        return firstUserIdx > 0 ? recent.slice(firstUserIdx) : recent;
    } catch {
        return [];
    }
}
