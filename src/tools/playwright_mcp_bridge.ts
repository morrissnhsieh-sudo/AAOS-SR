/**
 * playwright_mcp_bridge.ts
 *
 * Connects AAOS to the @playwright/mcp server over stdio.
 * Spawns `playwright-mcp` as a child process, performs the MCP handshake,
 * then dynamically registers every Playwright tool into the AAOS tool registry.
 *
 * Supports both headless mode (normal operation) and headed mode (browser_setup:
 * lets the user log in through a visible window for one-time manual login).
 * Both modes use the SAME playwright-mcp binary and the SAME profile directory,
 * guaranteeing cookie/session compatibility between login and normal use.
 */

import * as child_process from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { register_tool } from './tool_dispatcher';

// ─── Types ───────────────────────────────────────────────────────────────────

interface McpTool {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties?: Record<string, any>;
        required?: string[];
    };
}

interface PendingCall {
    resolve: (value: any) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}

// ─── Profile helpers ─────────────────────────────────────────────────────────

function get_profile_dir(): string {
    const workspace = process.env.AAOS_WORKSPACE ||
        path.join(process.env.USERPROFILE || process.env.HOME || '', '.aaos');
    const dir = path.join(workspace, 'playwright_profile');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Kill any Chromium / chrome.exe processes that still have the profile directory
 * open.  On Windows, SIGTERM on the playwright-mcp wrapper does NOT kill its
 * Chromium child process — we must hunt those down explicitly.
 */
function kill_profile_orphans(profileDir: string): void {
    if (process.platform !== 'win32') return;
    try {
        // Find chrome.exe processes whose command line references our profile dir.
        // We search for the profile basename (playwright_profile) to keep the
        // query short and avoid quoting issues.
        const profileKey = path.basename(profileDir).replace(/\\/g, '/');
        const out = child_process.execSync(
            `powershell.exe -NoProfile -Command "` +
            `Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | ` +
            `Where-Object { $_.CommandLine -like '*${profileKey}*' } | ` +
            `Select-Object -ExpandProperty ProcessId"`,
            { timeout: 6000, encoding: 'utf8' }
        );
        const pids = out.trim().split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
        for (const pid of pids) {
            try {
                child_process.execSync(`taskkill.exe /PID ${pid} /T /F`, {
                    timeout: 4000, stdio: 'pipe'
                });
                console.log(`[playwright-mcp] Killed orphan Chromium PID ${pid}`);
            } catch { /* already gone */ }
        }
        if (pids.length > 0) {
            // Give the OS a moment to release file handles after the kill
            // Use a short synchronous spin (no execSync with shell:true to avoid overload issues)
            const deadline = Date.now() + 2000;
            while (Date.now() < deadline) { /* spin wait */ }
        }
    } catch { /* PowerShell not available or query failed — continue */ }
}

/**
 * Delete stale lock files that playwright-mcp / Chromium leave behind after
 * an abrupt process termination (SIGTERM, crash).  Without this, the next
 * start fails with "Browser is already in use".
 */
function clean_profile_locks(profileDir: string): void {
    const staleFiles = ['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    for (const f of staleFiles) {
        const p = path.join(profileDir, f);
        try {
            if (fs.existsSync(p)) {
                fs.rmSync(p, { recursive: true, force: true });
                console.log(`[playwright-mcp] Removed stale lock: ${p}`);
            }
        } catch { /* locked by OS — ignore, will retry next boot */ }
    }
}

// ─── Bridge ──────────────────────────────────────────────────────────────────

class PlaywrightMcpBridge {
    private proc: child_process.ChildProcess | null = null;
    private pending = new Map<number, PendingCall>();
    private nextId = 1;
    private ready = false;
    private startPromise: Promise<void> | null = null;
    private headedMode = false;   // set by restartHeaded(); resets to false on new instance

    /** Lazily start playwright-mcp on first use (headless by default). */
    ensureReady(): Promise<void> {
        if (this.ready) return Promise.resolve();
        if (this.startPromise) return this.startPromise;
        this.startPromise = this._boot().catch((e) => {
            this.startPromise = null;
            throw e;
        });
        return this.startPromise;
    }

    /**
     * Stop any running bridge, then restart in HEADED (visible) mode.
     * Used by browser_setup so the user can log in through a real browser window.
     * After the user logs in, call shutdown_playwright() — the next ensureReady()
     * will restart in headless mode with the saved session.
     */
    async restartHeaded(): Promise<void> {
        // Stop any existing headless instance
        this.shutdown();
        const profileDir = get_profile_dir();
        // Wait for OS to release all file handles on the profile
        await new Promise<void>(r => setTimeout(r, 3000));
        clean_profile_locks(profileDir);
        // Boot in headed mode
        this.headedMode = true;
        this.startPromise = this._boot().catch((e) => {
            this.startPromise = null;
            this.headedMode = false;
            throw e;
        });
        return this.startPromise;
    }

    private _boot(): Promise<void> {
        const headed = this.headedMode;
        return new Promise<void>((resolve, reject) => {
            // Prefer the locally installed binary; fall back to npx.
            const localBin = path.join(
                process.cwd(), 'node_modules', '.bin',
                process.platform === 'win32' ? 'playwright-mcp.cmd' : 'playwright-mcp'
            );

            const userDataDir = get_profile_dir();

            // Kill any Chromium processes still holding the profile directory open.
            // This handles the case where a previous playwright-mcp was SIGTERM'd but
            // its Chromium subprocess survived (common on Windows).
            kill_profile_orphans(userDataDir);

            // Clean stale lock files left after an abrupt termination.
            clean_profile_locks(userDataDir);

            // Build args:
            //  --headless      omitted when headed=true (opens a real visible window)
            //  --no-sandbox    required on Windows / CI to avoid Chromium sandbox failures
            //  --user-data-dir persist cookies/sessions — SAME dir for both headed & headless
            const mcpArgs = [
                ...(headed ? [] : ['--headless']),
                '--no-sandbox',
                '--user-data-dir', userDataDir,
            ];

            const [cmd, args] = fs.existsSync(localBin)
                ? [localBin, mcpArgs]
                : ['npx', ['@playwright/mcp@latest', ...mcpArgs]];

            console.log(`[playwright-mcp] Spawning ${headed ? 'HEADED' : 'headless'}: ${cmd} ${args.join(' ')}`);

            this.proc = child_process.spawn(cmd, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                shell: process.platform === 'win32', // .cmd files need shell on Windows
            });

            // ── Read NDJSON responses from stdout ─────────────────────────
            const rl = readline.createInterface({ input: this.proc.stdout! });
            rl.on('line', (line) => {
                const text = line.trim();
                if (!text || !text.startsWith('{')) return;
                try {
                    const msg = JSON.parse(text);
                    if (msg.id !== undefined) {
                        const p = this.pending.get(msg.id);
                        if (p) {
                            clearTimeout(p.timer);
                            this.pending.delete(msg.id);
                            if (msg.error) {
                                p.reject(new Error(`MCP error [${msg.error.code}]: ${msg.error.message}`));
                            } else {
                                p.resolve(msg.result);
                            }
                        }
                    }
                } catch { /* non-JSON / partial line — skip */ }
            });

            this.proc.stderr?.on('data', (chunk: Buffer) => {
                const text = chunk.toString().trim();
                if (text) console.log(`[playwright-mcp] ${text}`);
            });

            this.proc.on('error', (err) => {
                console.error('[playwright-mcp] spawn error:', err.message);
                reject(err);
                this._cleanupPending();
            });

            this.proc.on('exit', (code, signal) => {
                console.log(`[playwright-mcp] exited code=${code} signal=${signal}`);
                this.ready = false;
                this.proc = null;
                this.startPromise = null;
                this._cleanupPending();
            });

            // ── MCP handshake ─────────────────────────────────────────────
            // Give playwright-mcp time to start.  On Windows with .cmd wrapper
            // overhead, startup typically takes 1.5–2.5 s.  Use 2.5 s to be safe.
            setTimeout(async () => {
                try {
                    await this._rpc('initialize', {
                        protocolVersion: '2024-11-05',
                        capabilities: {},
                        clientInfo: { name: 'aaos-gateway', version: '1.0.0' },
                    });
                    this._notify('notifications/initialized', {});
                    this.ready = true;
                    console.log(`[playwright-mcp] Ready (${headed ? 'headed' : 'headless'})`);
                    resolve();
                } catch (e: any) {
                    reject(e);
                }
            }, 2500);
        });
    }

    // ── Low-level transport ───────────────────────────────────────────────

    private _rpc(method: string, params: any, timeoutMs = 60_000): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            const id = this.nextId++;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`playwright-mcp: timeout waiting for ${method} (id=${id})`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
            this.proc!.stdin!.write(msg + '\n');
        });
    }

    private _notify(method: string, params: any): void {
        const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
        this.proc?.stdin?.write(msg + '\n');
    }

    private _cleanupPending(): void {
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error('playwright-mcp process terminated'));
        }
        this.pending.clear();
    }

    // ── Public API ────────────────────────────────────────────────────────

    async listTools(): Promise<McpTool[]> {
        await this.ensureReady();
        const result = await this._rpc('tools/list', {});
        return (result?.tools as McpTool[]) || [];
    }

    async callTool(name: string, args: any): Promise<any> {
        await this.ensureReady();
        // Browser actions can be slow (navigation, waits) — allow up to 120s.
        return this._rpc('tools/call', { name, arguments: args }, 120_000);
    }

    shutdown(): void {
        this._cleanupPending();
        if (this.proc) {
            const pid = this.proc.pid;
            this.proc = null;   // clear first so exit handler is a no-op
            if (pid) {
                if (process.platform === 'win32') {
                    // Kill the ENTIRE process tree (playwright-mcp node + its Chromium children).
                    // SIGTERM on Windows does NOT propagate to child processes, so we must use
                    // taskkill /T (tree) /F (force).  This prevents orphaned Chromium processes
                    // from keeping the profile locked after we shut down.
                    try {
                        child_process.execSync(`taskkill.exe /PID ${pid} /T /F`, {
                            timeout: 5000, stdio: 'pipe'
                        });
                        console.log(`[playwright-mcp] Killed process tree (PID ${pid})`);
                    } catch { /* already gone — ignore */ }
                } else {
                    // On Linux/macOS, kill the process group
                    try { process.kill(-pid, 'SIGKILL'); } catch {
                        try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
                    }
                }
            }
        }
        this.ready = false;
        this.startPromise = null;
        this.headedMode = false;
    }
}

// ─── Module-level singleton ───────────────────────────────────────────────────

let _bridge: PlaywrightMcpBridge | null = null;

export function get_bridge(): PlaywrightMcpBridge {
    if (!_bridge) _bridge = new PlaywrightMcpBridge();
    return _bridge;
}

/**
 * Call a Playwright MCP tool directly from code (not via the LLM tool dispatcher).
 * Used by web_login_tool and browser_setup_tool to drive the browser internally.
 */
export async function call_playwright_tool(name: string, args: any): Promise<string> {
    const bridge = get_bridge();
    const result = await bridge.callTool(name, args);
    return extract_mcp_content(result?.content ?? []);
}

/** Gracefully shut down the Playwright MCP process and reset the singleton. */
export function shutdown_playwright(): void {
    if (_bridge) {
        _bridge.shutdown();
        _bridge = null;
    }
}

// ─── Content extraction ───────────────────────────────────────────────────────

function extract_mcp_content(content: any[]): string {
    if (!Array.isArray(content)) return JSON.stringify(content);

    const snapshotsDir = path.resolve(
        process.env.AAOS_SNAPSHOTS_DIR || path.join(os.tmpdir(), 'aaos_snapshots')
    );

    const parts: string[] = [];
    const imageHints: string[] = [];

    for (const item of content) {
        if (item.type === 'text') {
            parts.push(item.text);
        } else if (item.type === 'image' && item.data) {
            try {
                fs.mkdirSync(snapshotsDir, { recursive: true });
                const ext = (item.mimeType || 'image/png').split('/')[1]?.replace('+xml', '') || 'png';
                const filename = `pw_${Date.now()}.${ext}`;
                const filePath = path.join(snapshotsDir, filename);
                fs.writeFileSync(filePath, Buffer.from(item.data, 'base64'));
                const webPath = `/snapshots/${filename}`;
                parts.push(webPath);
                imageHints.push(
                    `IMPORTANT: Embed the screenshot in your reply using: ![screenshot](${webPath})`
                );
                console.log(`[playwright-mcp] Screenshot saved → ${filePath}`);
            } catch (e: any) {
                parts.push(`[image capture failed: ${e.message}]`);
            }
        } else {
            parts.push(JSON.stringify(item));
        }
    }

    if (imageHints.length > 0) {
        parts.push('', ...imageHints);
    }
    return parts.join('\n');
}

// ─── Registration ─────────────────────────────────────────────────────────────

export async function register_playwright_tools(): Promise<void> {
    const bridge = get_bridge();
    let tools: McpTool[];

    try {
        tools = await bridge.listTools();
    } catch (e: any) {
        console.warn('[playwright-mcp] Startup failed:', e.message);
        console.warn('[playwright-mcp] To enable: npm install @playwright/mcp && npx playwright install chromium');
        return;
    }

    if (tools.length === 0) {
        console.warn('[playwright-mcp] No tools returned from server');
        return;
    }

    for (const tool of tools) {
        register_tool(
            {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema ?? { type: 'object', properties: {} },
            },
            async (args: any) => {
                const result = await bridge.callTool(tool.name, args);
                return extract_mcp_content(result?.content ?? []);
            }
        );
    }

    console.log(`[playwright-mcp] Registered ${tools.length} tools: ${tools.map(t => t.name).join(', ')}`);
}

export function shutdown_playwright_bridge(): void {
    shutdown_playwright();
}
