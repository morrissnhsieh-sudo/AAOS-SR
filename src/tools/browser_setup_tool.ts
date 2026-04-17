/**
 * browser_setup_tool.ts
 *
 * Opens a VISIBLE browser window so the user can log in to a service manually.
 *
 * KEY DESIGN: This tool restarts the playwright-mcp bridge in HEADED (visible)
 * mode.  The user logs in through that real browser window.  Cookies are saved
 * to the shared profile (~/.aaos-sr/playwright_profile/).  Then the bridge is
 * shut down; the next web_login call restarts it in HEADLESS mode with the
 * saved session — no login ever needed again.
 *
 * Why this design is correct:
 *   - Uses the SAME playwright-mcp binary for headed and headless modes.
 *   - Therefore the SAME Chromium binary, the SAME cookie encryption scheme,
 *     and the SAME profile format — zero compatibility issues.
 *   - No separate playwright import, no version mismatches, no lock conflicts
 *     from two different Chromium processes trying to share a profile.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';
import { register_tool } from './tool_dispatcher';
import { get_bridge, shutdown_playwright, call_playwright_tool } from './playwright_mcp_bridge';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Kill any chrome.exe processes holding our profile dir open.
 * Needed because shutdown_playwright() kills the playwright-mcp wrapper but
 * the Chromium subprocess it spawned can linger on Windows.
 */
function kill_chromium_for_profile(profileDir: string): void {
    if (process.platform !== 'win32') return;
    try {
        const profileKey = path.basename(profileDir);
        const out = child_process.execSync(
            `powershell.exe -NoProfile -Command "` +
            `Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | ` +
            `Where-Object { $_.CommandLine -like '*${profileKey}*' } | ` +
            `Select-Object -ExpandProperty ProcessId"`,
            { timeout: 6000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        ) as string;
        const pids = (out as string).trim().split(/\r?\n/).map((l: string) => l.trim()).filter(Boolean);
        for (const pid of pids) {
            try {
                child_process.execSync(`taskkill.exe /PID ${pid} /T /F`, { timeout: 4000, stdio: 'pipe' });
                console.log(`[browser_setup] Killed Chromium PID ${pid}`);
            } catch { /* already gone */ }
        }
    } catch { /* ignore */ }
}

// ─── Service maps ─────────────────────────────────────────────────────────────

const SERVICE_URLS: Record<string, string> = {
    gmail:      'https://mail.google.com',
    outlook:    'https://outlook.office.com/mail',
    outlook365: 'https://outlook.office.com/mail',
    microsoft:  'https://outlook.office.com/mail',
    github:     'https://github.com',
};

// Domains that appear in the URL when NOT yet logged in
const LOGIN_DOMAINS: Record<string, string[]> = {
    gmail:      ['accounts.google.com'],
    outlook:    ['login.microsoftonline.com', 'login.live.com', 'login.microsoft.com'],
    outlook365: ['login.microsoftonline.com', 'login.live.com', 'login.microsoft.com'],
    microsoft:  ['login.microsoftonline.com', 'login.live.com', 'login.microsoft.com'],
    github:     ['github.com/login', 'github.com/session'],
};

// Text markers that appear in the accessibility tree when logged in
// Both English and Traditional/Simplified Chinese variants included
const LOGGED_IN_MARKERS: Record<string, string[]> = {
    gmail:      ['Inbox', 'inbox', 'Compose', 'compose', 'Primary', '收件匣', '撰寫', '主要', '收件箱', '撰写'],
    outlook:    ['Inbox', 'inbox', 'New message', 'Compose', 'Focused', '收件匣', '新郵件', '焦點'],
    outlook365: ['Inbox', 'inbox', 'New message', 'Compose', 'Focused', '收件匣', '新郵件', '焦點'],
    microsoft:  ['Inbox', 'inbox', 'New message', 'Compose', 'Focused', '收件匣', '新郵件', '焦點'],
    github:     ['Dashboard', 'Pull requests', 'Issues', 'Notifications'],
};

// ─── Lock file helper ─────────────────────────────────────────────────────────

function clean_profile_locks(profileDir: string): void {
    const staleFiles = ['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket'];
    for (const f of staleFiles) {
        const p = path.join(profileDir, f);
        try {
            if (fs.existsSync(p)) {
                fs.rmSync(p, { recursive: true, force: true });
                console.log(`[browser_setup] Removed stale lock: ${p}`);
            }
        } catch { /* OS may still hold the handle — bridge._boot() will retry */ }
    }
}

// ─── Login detection ──────────────────────────────────────────────────────────

function detect_logged_in(snapshot: string, key: string): boolean {
    const markers = LOGGED_IN_MARKERS[key] || [];
    if (markers.some(m => snapshot.includes(m))) return true;

    // URL-based: if we're on the service domain and NOT on a login sub-domain
    const urlMatch = snapshot.match(/Page URL:\s*(https?:\/\/[^\s\n]+)/i);
    if (urlMatch) {
        const url = urlMatch[1];
        const serviceHost = (SERVICE_URLS[key] || '').replace(/^https?:\/\//, '').split('/')[0];
        const onLoginDomain = (LOGIN_DOMAINS[key] || []).some(d => url.includes(d));
        if (serviceHost && url.includes(serviceHost) && !onLoginDomain) return true;
    }
    return false;
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function register_browser_setup_tool(): void {
    register_tool(
        {
            name: 'browser_setup',
            description:
                'Opens a VISIBLE browser window so the user can log in to a service manually. ' +
                'ALWAYS call this when web_login returns status="login_failed". ' +
                'The user logs in once through the visible window; the session is saved permanently. ' +
                'After browser_setup succeeds, web_login(service=...) will work silently forever. ' +
                'Supported services: gmail, outlook365, github.',
            parameters: {
                type: 'object',
                properties: {
                    service: {
                        type: 'string',
                        description: 'Service to set up: "gmail", "outlook365", "github"'
                    }
                },
                required: ['service']
            }
        },
        async (args: { service: string }) => {
            const key = args.service.toLowerCase().replace(/[^a-z0-9]/g, '');
            const url = SERVICE_URLS[key];
            if (!url) {
                return {
                    ok: false,
                    error: `Unknown service "${args.service}". Supported: gmail, outlook365, github.`,
                    _next: `Unknown service. Try with "gmail", "outlook365", or "github".`
                };
            }

            const workspace = process.env.AAOS_WORKSPACE ||
                path.join(process.env.USERPROFILE || process.env.HOME || '', '.aaos-sr');
            const profileDir = path.join(workspace, 'playwright_profile');
            fs.mkdirSync(profileDir, { recursive: true });

            console.log(`[browser_setup] ── Starting setup for ${args.service} ──`);

            // ── STEP 1: Restart the bridge in HEADED mode ─────────────────────────
            // This stops any running headless instance (freeing the profile lock),
            // waits for file handles to release, then starts playwright-mcp WITHOUT
            // the --headless flag so a real browser window appears on screen.
            // Using the SAME binary ensures cookie encryption compatibility.
            console.log(`[browser_setup] Restarting bridge in headed mode...`);
            try {
                await get_bridge().restartHeaded();
            } catch (e: any) {
                console.error(`[browser_setup] Failed to start headed browser: ${e.message}`);
                // Clean up and return error
                shutdown_playwright();
                await sleep(1000);
                clean_profile_locks(profileDir);
                return {
                    ok: false,
                    service: args.service,
                    error: `Could not start browser: ${e.message}`,
                    _next: `browser_setup failed to start the browser: ${e.message}. Try calling browser_setup again. If it keeps failing, check that @playwright/mcp is installed (run: npx playwright install chromium).`
                };
            }

            // ── STEP 2: Navigate to the login page ───────────────────────────────
            console.log(`[browser_setup] Navigating to ${url}`);
            try {
                await call_playwright_tool('browser_navigate', { url });
            } catch (e: any) {
                console.error(`[browser_setup] Navigation failed: ${e.message}`);
                shutdown_playwright();
                await sleep(1500);
                clean_profile_locks(profileDir);
                return {
                    ok: false,
                    service: args.service,
                    error: `Navigation to ${url} failed: ${e.message}`,
                    _next: `browser_setup failed to navigate. Try calling browser_setup again.`
                };
            }

            console.log(`[browser_setup] Browser window open — waiting for user to log in (up to 5 minutes)...`);

            // ── STEP 3: Poll for login (up to 5 minutes) ─────────────────────────
            const timeoutMs = 5 * 60 * 1000;
            const start = Date.now();
            let loggedIn = false;

            while (Date.now() - start < timeoutMs) {
                await sleep(3000); // check every 3 seconds
                try {
                    const snapshot = await call_playwright_tool('browser_snapshot', {});
                    if (detect_logged_in(snapshot, key)) {
                        loggedIn = true;
                        break;
                    }
                } catch { /* page may be navigating — try again next cycle */ }
            }

            // ── STEP 4: Give cookies time to flush, then shut down the headed browser
            if (loggedIn) {
                console.log(`[browser_setup] Login detected — flushing cookies...`);
                await sleep(3000); // let the page fully settle and write all cookies to disk
            }

            // ── Graceful shutdown sequence ────────────────────────────────────────
            // CRITICAL: we must flush Chrome's cookies AND LevelDB (localStorage) to
            // disk before killing the process.  Force-kill (taskkill /F) truncates the
            // LevelDB write-ahead log, losing auth tokens.  Outlook stores MSAL tokens
            // in localStorage → if lost, the next session can't skip the OAuth login.
            //
            // Fix: navigate to about:blank first (triggers per-origin data flush),
            // then call browser_close (proper Chrome shutdown with full flush),
            // THEN kill the playwright-mcp wrapper process.
            console.log(`[browser_setup] Flushing session data to disk...`);
            try {
                // Navigate away from the service page → Chrome writes all pending
                // cookies and LevelDB entries for that origin
                await call_playwright_tool('browser_navigate', { url: 'about:blank' });
                await sleep(2000); // wait for flush to complete
                console.log(`[browser_setup] Navigated to about:blank — data flushed`);
            } catch { /* ignore if navigation fails */ }
            try {
                // Close the browser gracefully through the MCP API — this is
                // equivalent to clicking "×" on the window: Chrome writes remaining
                // data and syncs the SQLite WAL before exiting
                await call_playwright_tool('browser_close', {});
                await sleep(1500);
                console.log(`[browser_setup] Browser closed gracefully`);
            } catch { /* ignore — will force kill below */ }

            console.log(`[browser_setup] Shutting down playwright-mcp...`);
            shutdown_playwright();
            await sleep(1500);
            kill_chromium_for_profile(profileDir); // kill any surviving Chromium processes
            await sleep(1000);
            clean_profile_locks(profileDir);

            if (loggedIn) {
                console.log(`[browser_setup] ✓ Login session saved to ${profileDir}`);
                return {
                    ok: true,
                    service: args.service,
                    message: `Login session for ${args.service} saved permanently.`,
                    _next: `browser_setup succeeded — session is saved. NOW call web_login(service="${args.service}") to verify, then proceed with the original task.`
                };
            } else {
                return {
                    ok: false,
                    service: args.service,
                    message: `browser_setup timed out — login not completed within 5 minutes.`,
                    _next: `Login was not completed in time. Ask the user: "The browser window opened for ${args.service} — did you finish logging in? If so, please tell me and I will try again."`
                };
            }
        }
    );
}
