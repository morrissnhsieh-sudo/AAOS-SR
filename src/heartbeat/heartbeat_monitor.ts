import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Session, orchestrate_context_compaction, io_write_session_jsonl } from '../memory/memory_system';
import { pluginRegistry, get_active_provider } from '../plugins/plugin_engine';
import { io_list_installed_skills } from '../skills/skill_manager';

export interface Subsystem { name: string; }
export interface PingResult { name: string; ok: boolean; latency?: number; detail?: string; }
export interface HeartbeatConfig { intervalMs: number; graceMs: number; }
export interface GatewayHealth {
    uptime: number;
    timestamp: string;
    subsystems: PingResult[];
    memory: { workspace: string; memoryFileExists: boolean; sessionCount: number };
    skills: { installedCount: number; enabledCount: number };
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 300000;
export const DEFAULT_STARTUP_GRACE_MS = 60000;
export const DEFAULT_CHANNEL_CONNECT_GRACE_MS = 120000;
export const SUBSYSTEM_PING_TIMEOUT_MS = 10000;

let lastHealthResult: GatewayHealth | null = null;

function getWorkspace(): string {
    return process.env.AAOS_WORKSPACE || path.join(os.homedir(), '.aaos');
}

/** Pings the filesystem memory subsystem */
async function ping_memory_subsystem(): Promise<PingResult> {
    const start = Date.now();
    try {
        const workspace = getWorkspace();
        fs.mkdirSync(workspace, { recursive: true });
        const probe = path.join(workspace, '.heartbeat_probe');
        fs.writeFileSync(probe, new Date().toISOString());
        fs.unlinkSync(probe);
        return { name: 'memory', ok: true, latency: Date.now() - start };
    } catch (e: any) {
        return { name: 'memory', ok: false, latency: Date.now() - start, detail: e.message };
    }
}

/** Checks that the active LLM plugin is loaded and has invoke capability */
async function ping_llm_subsystem(): Promise<PingResult> {
    const providerName = process.env.AAOS_LLM_PROVIDER || 'google';
    const provider = get_active_provider();
    if (provider?.enabled && provider?.invoke) return { name: 'llm', ok: true, detail: `${providerName} plugin active` };
    return { name: 'llm', ok: false, detail: `${providerName} plugin not initialized or missing invoke()` };
}

/** Checks the skills registry is readable */
async function ping_skills_subsystem(): Promise<PingResult> {
    try {
        const skills = io_list_installed_skills();
        return { name: 'skills', ok: true, detail: `${skills.length} skills in registry` };
    } catch (e: any) {
        return { name: 'skills', ok: false, detail: e.message };
    }
}

/** Collects full gateway health snapshot */
export async function collect_gateway_health(): Promise<GatewayHealth> {
    const [memPing, llmPing, skillPing] = await Promise.all([
        ping_memory_subsystem(),
        ping_llm_subsystem(),
        ping_skills_subsystem(),
    ]);

    const workspace = getWorkspace();
    const memFile = path.join(workspace, 'memory', 'MEMORY.md');
    const sessionDir = path.join(workspace, 'sessions');
    let sessionCount = 0;
    try { sessionCount = fs.readdirSync(sessionDir).length; } catch {}

    const skills = io_list_installed_skills();

    const health: GatewayHealth = {
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        subsystems: [memPing, llmPing, skillPing],
        memory: {
            workspace,
            memoryFileExists: fs.existsSync(memFile),
            sessionCount
        },
        skills: {
            installedCount: skills.length,
            enabledCount: skills.filter(s => s.status === 'enabled').length
        }
    };
    lastHealthResult = health;

    const allOk = health.subsystems.every(s => s.ok);
    if (!allOk) {
        const degraded = health.subsystems.filter(s => !s.ok).map(s => s.name).join(', ');
        console.warn(`[Heartbeat] Degraded subsystems: ${degraded}`);
    } else {
        console.log(`[Heartbeat] All subsystems healthy. Uptime: ${health.uptime}s | Sessions: ${sessionCount} | Skills: ${skills.length}`);
    }

    write_heartbeat_md(health);
    return health;
}

/**
 * Writes a human-readable status snapshot to ~/.aaos/HEARTBEAT.md.
 * The agent reads this file at the start of every run so it has live context
 * about its own system health, uptime, loaded skills, and session history.
 */
function detect_shell(): string {
    if (process.platform === 'win32') {
        // Check if Git Bash / MSYS bash is available (preferred for Unix commands)
        try {
            require('child_process').execSync('bash --version', { timeout: 2000, stdio: 'pipe' });
            return 'bash (Git Bash / MSYS2)';
        } catch {
            return 'cmd.exe (bash unavailable)';
        }
    }
    return process.env.SHELL || '/bin/sh';
}

function write_heartbeat_md(health: GatewayHealth): void {
    try {
        const workspace = getWorkspace();
        const uptimeSec = health.uptime % 60;
        const uptimeMin = Math.floor(health.uptime / 60) % 60;
        const uptimeHr  = Math.floor(health.uptime / 3600);
        const uptimeStr = uptimeHr > 0
            ? `${uptimeHr}h ${uptimeMin}m`
            : uptimeMin > 0
            ? `${uptimeMin}m ${uptimeSec}s`
            : `${uptimeSec}s`;
        const allOk = health.subsystems.every(s => s.ok);

        // OS / environment facts written once per heartbeat so the LLM
        // always knows what platform it is running on and which command
        // syntax and path conventions to use.
        const platform  = process.platform;                        // 'win32' | 'linux' | 'darwin'
        const arch      = os.arch();                               // 'x64' | 'arm64' etc.
        const release   = os.release();
        const shell     = detect_shell();
        const homedir   = os.homedir();
        const pathSep   = path.sep;                                // '\\' on Windows, '/' on Unix
        const nodeVer   = process.version;

        const osLabel =
            platform === 'win32'  ? 'Windows' :
            platform === 'darwin' ? 'macOS'   : 'Linux';

        const cmdNotes =
            platform === 'win32'
                ? 'Use bash (Git Bash) syntax for shell commands. Path separator: \\. ' +
                  'Use forward slashes in curl URLs. Home dir: ' + homedir.replace(/\\/g, '/')
                : `Use POSIX sh/bash syntax. Path separator: /. Home dir: ${homedir}`;

        const lines = [
            '# System Status',
            `Updated: ${health.timestamp}`,
            `Uptime: ${uptimeStr}`,
            `Overall: ${allOk ? '✓ All systems healthy' : '⚠ One or more subsystems degraded'}`,
            '',
            '## Environment',
            `- OS: ${osLabel} (${platform} ${arch}, kernel ${release})`,
            `- Shell: ${shell}`,
            `- Node.js: ${nodeVer}`,
            `- Home: ${homedir}`,
            `- Path separator: ${pathSep === '\\' ? '\\\\ (Windows backslash)' : '/ (Unix)'}`,
            `- Command style: ${cmdNotes}`,
            '',
            '## Subsystems',
            ...health.subsystems.map(s => {
                const detail = s.detail ? ` — ${s.detail}` : '';
                const latency = s.latency !== undefined ? ` (${s.latency}ms)` : '';
                return `- **${s.name}**: ${s.ok ? '✓' : '✗'}${latency}${detail}`;
            }),
            '',
            '## Skills',
            `- Installed: ${health.skills.installedCount}`,
            `- Enabled: ${health.skills.enabledCount}`,
            '',
            '## Memory',
            `- Sessions logged: ${health.memory.sessionCount}`,
            `- Memory file: ${health.memory.memoryFileExists ? 'present' : 'not yet created'}`,
            `- Workspace: ${health.memory.workspace}`,
        ];

        fs.writeFileSync(
            path.join(workspace, 'HEARTBEAT.md'),
            lines.join('\n') + '\n',
            'utf8'
        );
    } catch (e: any) {
        console.warn(`[Heartbeat] Failed to write HEARTBEAT.md: ${e.message}`);
    }
}

export function get_last_health(): GatewayHealth | null { return lastHealthResult; }

export function schedule_heartbeat(intervalMs: number, gracePeriodMs: number): NodeJS.Timeout {
    return setTimeout(() => {
        collect_gateway_health().catch(console.error);
        setInterval(() => {
            collect_gateway_health().catch(console.error);
            guarantee_log_flush_on_heartbeat([]).catch(console.error);
        }, intervalMs);
    }, gracePeriodMs);
}

export async function ping_all_subsystems(subsystems: Subsystem[]): Promise<PingResult[]> {
    return Promise.all(subsystems.map(async sub => {
        const timeout = new Promise<PingResult>(res => setTimeout(() => res({ name: sub.name, ok: false }), SUBSYSTEM_PING_TIMEOUT_MS));
        const ping = new Promise<PingResult>(res => setTimeout(() => res({ name: sub.name, ok: true }), 100));
        return Promise.race([ping, timeout]);
    }));
}

export function update_subsystem_health_status(results: PingResult[]): void {
    results.forEach(r => { if (!r.ok) console.warn(`Subsystem degraded: ${r.name}`); });
}

export function send_channel_keepalive_frames(connections: any[]): void {}
export function validate_channel_still_connected(c: any): boolean { return true; }

export function check_compaction_threshold(session: Session, maxTokens: number): boolean {
    return session.context_token_count >= maxTokens * 0.8;
}

export async function trigger_compaction_if_needed(session: Session, maxTokens: number): Promise<void> {
    if (check_compaction_threshold(session, maxTokens)) await orchestrate_context_compaction(session);
}

export async function flush_session_logs(sessions: Session[]): Promise<void> {
    for (const session of sessions) await io_write_session_jsonl(session.id, []);
}

export function monitor_channel_connect_grace(c: any, g: number): void {}

export function apply_startup_grace_period(graceMs: number, onComplete: () => void): void {
    setTimeout(onComplete, graceMs);
}

export function load_heartbeat_config(): HeartbeatConfig {
    return {
        intervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS ?? String(DEFAULT_HEARTBEAT_INTERVAL_MS)),
        graceMs: parseInt(process.env.STARTUP_GRACE_MS ?? String(DEFAULT_STARTUP_GRACE_MS))
    };
}

export function compute_gateway_uptime(): number { return process.uptime(); }
export function enforce_acp_retry_limit(attempt: number, max: number): boolean { return attempt <= max; }

export async function guarantee_log_flush_on_heartbeat(sessions: Session[]): Promise<void> {
    return flush_session_logs(sessions);
}
