/**
 * web_login_tool.ts
 *
 * Composite autonomous login tool for AAOS.
 *
 * KEY DESIGN PRINCIPLE: Language-independent form filling.
 * Uses browser_type (types at focused element) + browser_evaluate (JavaScript
 * to focus fields by CSS selector) instead of browser_fill (which relies on
 * ARIA/label text that changes with the page language).
 *
 * Flow:
 *   1. Navigate to the service URL
 *   2. Snapshot → check if already logged in
 *   3. Login page → read credentials from Windows Credential Manager
 *   4. If found → fill form using keyboard (language-independent)
 *   5. If not found → ask user for BOTH email+password in ONE message
 *   6. Verify login, return status + _next instructions
 */

import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { register_tool } from './tool_dispatcher';
import { call_playwright_tool } from './playwright_mcp_bridge';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ─── Types ────────────────────────────────────────────────────────────────────

interface LoginResult {
    status: 'already_logged_in' | 'logged_in' | 'need_credentials' | 'login_failed' | 'error';
    service: string;
    email?: string;
    message: string;
    _next: string;
}

interface ServiceConfig {
    url: string;
    loginDomains: string[];
    loggedInMarkers: string[];
    login: (email: string, password: string) => Promise<void>;
}

// ─── Language-independent form helpers ───────────────────────────────────────

/**
 * Extract an element ref from a Playwright MCP snapshot string.
 * The snapshot uses format: - textbox "label" [ref=eNNN]
 * We search by input type keyword (textbox/email for email, password for password).
 */
function extract_ref(snapshot: string, type: 'email' | 'password'): string | null {
    let patterns: RegExp[];
    if (type === 'email') {
        // Match textbox entries — the email field is always a textbox on login pages
        patterns = [
            /textbox[^\n\[]*\[ref=(e\d+)\]/i,
            /\btext\b[^\n\[]*\[ref=(e\d+)\]/i,
            /input[^\n\[]*email[^\n\[]*\[ref=(e\d+)\]/i,
        ];
    } else {
        patterns = [
            /password[^\n\[]*\[ref=(e\d+)\]/i,
            /\[ref=(e\d+)\][^\n]*password/i,
        ];
    }
    for (const re of patterns) {
        const m = snapshot.match(re);
        if (m) return m[1];
    }
    return null;
}

/**
 * Fill an input by Playwright ref (language-independent, proper React events).
 * Falls back to browser_type if no ref found.
 */
async function fill_by_ref(snapshot: string, type: 'email' | 'password', value: string): Promise<void> {
    const ref = extract_ref(snapshot, type);
    if (ref) {
        console.log(`[web_login] Filling ${type} field by ref=${ref}`);
        await call_playwright_tool('browser_fill', { ref, value });
    } else {
        // Fallback: fill by CSS selector via JavaScript (no ref needed, language-independent)
        console.log(`[web_login] No ref found for ${type}, falling back to JS fill`);
        const selector = type === 'email'
            ? 'input[type="email"], input#identifierId, input:not([type="password"]):not([type="checkbox"]):not([type="hidden"]):not([type="submit"])'
            : 'input[type="password"], input[name="Passwd"]';
        await js_fill_selector(selector, value);
    }
    await sleep(300);
}

// ─── Service login procedures ─────────────────────────────────────────────────

/**
 * Fill a field using JavaScript (stable across all languages).
 * Uses native value setter to properly trigger React/Angular form events.
 */
async function js_fill_selector(selector: string, value: string): Promise<boolean> {
    const result = await call_playwright_tool('browser_evaluate', {
        expression: `
            (function() {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return false;
                el.focus();
                const proto = Object.getPrototypeOf(el);
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (setter) setter.call(el, ${JSON.stringify(value)});
                else el.value = ${JSON.stringify(value)};
                el.dispatchEvent(new Event('input',  { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
            })()`
    });
    return String(result).includes('true');
}

async function js_click_selector(selector: string): Promise<boolean> {
    const result = await call_playwright_tool('browser_evaluate', {
        expression: `
            (function() {
                const el = document.querySelector(${JSON.stringify(selector)});
                if (!el) return false;
                el.click();
                return true;
            })()`
    });
    return String(result).includes('true');
}

/**
 * Gmail multi-step login — uses Google's stable element IDs (language-independent):
 *  Step 1: fill #identifierId → click #identifierNext
 *  Step 2: fill input[name="Passwd"] → click #passwordNext
 */
async function login_gmail(email: string, password: string): Promise<void> {
    // ── Email step ────────────────────────────────────────────────────────────
    // Google's email input always has id="identifierId" regardless of language
    let filled = await js_fill_selector('#identifierId', email);
    if (!filled) {
        // Fallback: try snapshot ref
        console.log('[web_login] Gmail: #identifierId not found, trying ref-based fill');
        const snap = await call_playwright_tool('browser_snapshot', {});
        await fill_by_ref(snap, 'email', email);
    }
    await sleep(400);

    // Click Next button — Google uses id="identifierNext"
    const nextClicked = await js_click_selector('#identifierNext');
    if (!nextClicked) {
        // Fallback: press Enter (works if input is focused)
        await call_playwright_tool('browser_press_key', { key: 'Enter' });
    }
    console.log('[web_login] Gmail: submitted email, waiting for password page...');

    // ── Wait for password step ────────────────────────────────────────────────
    // Poll up to 12s for the password field to appear
    let passwordVisible = false;
    for (let i = 0; i < 24; i++) {
        await sleep(500);
        const check = await call_playwright_tool('browser_evaluate', {
            expression: `!!document.querySelector('input[type="password"], input[name="Passwd"]')`
        });
        if (String(check).includes('true')) { passwordVisible = true; break; }
    }
    if (!passwordVisible) {
        console.log('[web_login] Gmail: password field not detected after wait, proceeding anyway');
    }

    // ── Password step ─────────────────────────────────────────────────────────
    // Try Google's stable password selectors in order
    const pwSelectors = ['input[name="Passwd"]', 'input[type="password"]', '#password input'];
    let pwFilled = false;
    for (const sel of pwSelectors) {
        pwFilled = await js_fill_selector(sel, password);
        if (pwFilled) { console.log(`[web_login] Gmail: filled password via ${sel}`); break; }
    }
    if (!pwFilled) {
        console.log('[web_login] Gmail: falling back to ref-based password fill');
        const snap2 = await call_playwright_tool('browser_snapshot', {});
        await fill_by_ref(snap2, 'password', password);
    }
    await sleep(400);

    // Click Sign in — Google uses id="passwordNext"
    const signInClicked = await js_click_selector('#passwordNext');
    if (!signInClicked) {
        await call_playwright_tool('browser_press_key', { key: 'Enter' });
    }
    console.log('[web_login] Gmail: submitted password');
}

/**
 * Outlook / Microsoft 365 multi-step login (language-independent):
 *  Page 1 → snapshot → fill email by ref → Enter
 *  Page 2 → snapshot → fill password by ref → Enter
 *  Optional: "Stay signed in?" → click Yes button by ref
 */
async function login_outlook(email: string, password: string): Promise<void> {
    const snap1 = await call_playwright_tool('browser_snapshot', {});
    await fill_by_ref(snap1, 'email', email);
    await call_playwright_tool('browser_press_key', { key: 'Enter' });
    console.log('[web_login] Outlook: submitted email, waiting for password page...');

    let snap2 = '';
    for (let i = 0; i < 20; i++) {
        await sleep(500);
        snap2 = await call_playwright_tool('browser_snapshot', {});
        if (extract_ref(snap2, 'password')) break;
        const lower = snap2.toLowerCase();
        if (lower.includes('password') || lower.includes('密碼')) break;
    }

    await fill_by_ref(snap2, 'password', password);
    await call_playwright_tool('browser_press_key', { key: 'Enter' });
    console.log('[web_login] Outlook: submitted password');

    // Handle "Stay signed in?" — find Yes button by ref
    await sleep(2000);
    const snap3 = await call_playwright_tool('browser_snapshot', {});
    // Look for button with ref near "stay" or "Yes" or Chinese equivalent
    const yesRef = snap3.match(/button[^\n\[]*(?:yes|是|stay)[^\n\[]*\[ref=(e\d+)\]/i)?.[1] ||
                   snap3.match(/\[ref=(e\d+)\][^\n]*(?:yes|是|stay)/i)?.[1];
    if (yesRef) {
        await call_playwright_tool('browser_click', { ref: yesRef });
        console.log('[web_login] Outlook: clicked Stay signed in');
    }
}

/**
 * GitHub login — both fields on the same page, find by ref.
 */
async function login_github(email: string, password: string): Promise<void> {
    const snap1 = await call_playwright_tool('browser_snapshot', {});
    await fill_by_ref(snap1, 'email', email);
    await sleep(200);
    // For GitHub both fields are visible — get fresh snapshot for password ref
    const snap2 = await call_playwright_tool('browser_snapshot', {});
    await fill_by_ref(snap2, 'password', password);
    await call_playwright_tool('browser_press_key', { key: 'Enter' });
    console.log('[web_login] GitHub: submitted login form');
}

// ─── Service configs ──────────────────────────────────────────────────────────

const SERVICE_CONFIGS: Record<string, ServiceConfig> = {
    gmail: {
        url: 'https://mail.google.com',
        loginDomains: ['accounts.google.com'],
        // Text-only markers — NO URL fragments here (they appear in login page redirect params too)
        loggedInMarkers: [
            'Inbox', 'Compose', 'inbox', 'compose', 'Primary', 'Promotions',
            '收件匣', '撰寫', '主要', '收件箱', '撰写',   // Chinese Gmail
        ],
        login: login_gmail,
    },
    outlook: {
        url: 'https://outlook.office.com/mail',
        loginDomains: ['login.microsoftonline.com', 'login.live.com'],
        loggedInMarkers: [
            'Inbox', 'inbox', 'New message', 'Compose', 'Focused',
            '收件匣', '新郵件', '草稿', '收件箱',         // Chinese Outlook
        ],
        login: login_outlook,
    },
    github: {
        url: 'https://github.com',
        loginDomains: ['github.com/login', 'github.com/session'],
        loggedInMarkers: ['Dashboard', 'Pull requests', 'Issues', 'Notifications'],
        login: login_github,
    },
};

SERVICE_CONFIGS['outlook365'] = SERVICE_CONFIGS['outlook'];
SERVICE_CONFIGS['microsoft']  = SERVICE_CONFIGS['outlook'];

// ─── Credential helpers ───────────────────────────────────────────────────────

function find_windows_python(): string {
    if (process.platform !== 'win32') return 'python3';
    try {
        const result = child_process.execSync('where python', {
            shell: true, timeout: 3000, encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
        } as any);
        const lines = (result as string).trim().split(/\r?\n/).map((l: string) => l.trim())
            .filter((l: string) => l.toLowerCase().endsWith('.exe') && !l.includes('WindowsApps'));
        if (lines.length > 0) return lines[0];
    } catch { /* fall through */ }
    const fallbacks = [
        'C:\\Python314\\python.exe', 'C:\\Python313\\python.exe',
        'C:\\Python312\\python.exe', 'C:\\Python311\\python.exe',
    ];
    for (const p of fallbacks) {
        try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
    }
    return 'python';
}

const WINDOWS_PYTHON = process.platform === 'win32' ? find_windows_python() : 'python3';

const CRED_SCRIPT = path.join(
    process.env.AAOS_WORKSPACE || path.join(process.env.USERPROFILE || process.env.HOME || '', '.aaos'),
    'scripts', 'credential_manager.py'
);

function read_credentials(service: string): Promise<any> {
    return new Promise((resolve) => {
        child_process.execFile(
            WINDOWS_PYTHON, [CRED_SCRIPT, 'get', '--service', service],
            { timeout: 10_000, encoding: 'utf8' },
            (_err, stdout) => {
                const raw = (stdout || '').trim();
                if (!raw) { resolve({ found: false }); return; }
                try { resolve(JSON.parse(raw)); }
                catch { resolve({ found: false }); }
            }
        );
    });
}

// ─── Login detection ──────────────────────────────────────────────────────────

function is_login_page(snapshotText: string, currentUrl: string, config: ServiceConfig): boolean {
    if (config.loginDomains.some(d => currentUrl.includes(d))) return true;
    const lower = snapshotText.toLowerCase();
    const hasLoginHint = lower.includes('sign in') || lower.includes('log in') ||
                         lower.includes('password') || lower.includes('email');
    const loggedIn = config.loggedInMarkers.some(m => snapshotText.includes(m));
    return hasLoginHint && !loggedIn;
}

function is_logged_in(snapshotText: string, config: ServiceConfig): boolean {
    if (config.loggedInMarkers.some(m => snapshotText.includes(m))) return true;
    // Also detect by URL: if we're on the service domain and NOT a login domain, we're in
    const urlMatch = snapshotText.match(/Page URL:\s*(https?:\/\/[^\s\n]+)/i);
    if (urlMatch) {
        const url = urlMatch[1];
        const onLoginDomain = config.loginDomains.some(d => url.includes(d));
        const onServiceDomain = config.url && url.startsWith(config.url.split('/').slice(0, 3).join('/'));
        if (onServiceDomain && !onLoginDomain) return true;
    }
    return false;
}

function still_on_login(postUrl: string, config: ServiceConfig): boolean {
    return config.loginDomains.some(d => postUrl.includes(d));
}

// ─── Main logic ───────────────────────────────────────────────────────────────

async function perform_web_login(service: string): Promise<LoginResult> {
    const key = service.toLowerCase().replace(/[^a-z0-9]/g, '');
    const config = SERVICE_CONFIGS[key];

    if (!config) {
        return {
            status: 'error', service,
            message: `Unknown service "${service}". Known: gmail, outlook365, github.`,
            _next: `Unknown service. Navigate manually with browser_navigate then browser_snapshot.`
        };
    }

    // ── Outlook / Microsoft 365: browser approach is permanently broken ───────
    // Microsoft's Outlook SPA uses MSAL.js with sessionStorage for auth tokens.
    // sessionStorage is cleared every time the browser process exits, so the
    // session can NEVER persist across browser launches.  browser_setup will
    // always fail.  Skip directly to IMAP.
    const isOutlook = ['outlook', 'outlook365', 'microsoft'].includes(key);
    if (isOutlook) {
        return {
            status: 'login_failed', service,
            message: `Outlook browser login is not supported — Microsoft MSAL uses sessionStorage which cannot persist across browser launches.`,
            _next: `Do NOT call browser_setup for Outlook — it will always fail. ` +
                   `MANDATORY: Use IMAP instead. ` +
                   `1. Call credentials_read(service="outlook_imap") to check for saved credentials. ` +
                   `2. If not found: ask the user to create a Microsoft App Password at https://account.microsoft.com/security → Advanced security options → App passwords, then call credentials_save(service="outlook_imap", fields={email:"...", password:"..."}).` +
                   `3. Call sys_info() to get pythonExe, then run: bash_exec("{pythonExe} C:/Users/User/.aaos/scripts/outlook_imap.py unread 3 {email} {password}").`
        };
    }

    // Step 1: Navigate
    console.log(`[web_login] Navigating to ${config.url}`);
    await call_playwright_tool('browser_navigate', { url: config.url });
    await sleep(1500); // give page time to settle

    // Step 2: Snapshot
    const snapshot = await call_playwright_tool('browser_snapshot', {});
    const urlMatch = snapshot.match(/Page URL:\s*(https?:\/\/[^\s\n]+)/i);
    const currentUrl = urlMatch ? urlMatch[1] : config.url;

    // Step 3: Already logged in?
    if (is_logged_in(snapshot, config)) {
        return {
            status: 'already_logged_in', service,
            message: `Already logged in to ${service}. Session active.`,
            _next: `Already logged in to ${service}. Proceed with the task — call browser_snapshot to read content.`
        };
    }

    // Not on login page either (unusual)
    if (!is_login_page(snapshot, currentUrl, config)) {
        return {
            status: 'already_logged_in', service,
            message: `Page loaded for ${service}. No login form detected.`,
            _next: `Page loaded. Use browser_snapshot to read content and proceed with the task.`
        };
    }

    // Step 4: Login page → get credentials
    console.log(`[web_login] Login page detected for ${service} — reading credentials`);
    const creds = await read_credentials(service);

    if (!creds.found) {
        return {
            status: 'need_credentials', service,
            message: `No saved credentials for "${service}". One-time setup required.`,
            _next: `Credentials for "${service}" are not set up yet. Tell the user in ONE message: "I navigated to ${service} but no credentials are saved yet. Please provide your email and password — I'll save them securely in Windows Credential Manager so you never need to provide them again." After the user replies, call credentials_save(service="${service}", fields={email: "<email>", password: "<password>"}) then call web_login(service="${service}") again.`
        };
    }

    const email    = creds.email    || creds.username || creds.user || '';
    const password = creds.password || '';

    if (!email || !password) {
        return {
            status: 'need_credentials', service,
            message: `Saved credentials for "${service}" are incomplete.`,
            _next: `Credentials incomplete. Tell user: "Your saved ${service} credentials are incomplete. Please provide both email and password." Then call credentials_save and web_login again.`
        };
    }

    // Step 5: Fill the form (language-independent keyboard/JS approach)
    console.log(`[web_login] Filling login form for ${service} — ${email.slice(0, 4)}***`);
    try {
        await config.login(email, password);
    } catch (e: any) {
        console.error(`[web_login] Login step error: ${e.message}`);
        return {
            status: 'login_failed', service, email,
            message: `Login form error (likely bot detection): ${e.message}`,
            _next: `MANDATORY ACTION: call browser_setup(service="${service}") RIGHT NOW. Do NOT apologize. Do NOT give up. browser_setup opens a VISIBLE browser for one-time manual login and saves the session permanently.`
        };
    }

    // Step 6: Wait and verify
    await sleep(3000); // give post-submit page time to load
    const postSnapshot = await call_playwright_tool('browser_snapshot', {});
    const postUrlMatch = postSnapshot.match(/Page URL:\s*(https?:\/\/[^\s\n]+)/i);
    const postUrl = postUrlMatch ? postUrlMatch[1] : '';

    // Check for 2FA
    const lower = postSnapshot.toLowerCase();
    const is2FA = lower.includes('2-step') || lower.includes('two-step') ||
                  lower.includes('verification code') || lower.includes('authenticator') ||
                  lower.includes('verify it') || lower.includes('security key') ||
                  lower.includes('驗證') || lower.includes('兩步驟'); // Chinese 2FA terms

    if (is2FA) {
        return {
            status: 'login_failed', service, email,
            message: `2FA required for ${service}.`,
            _next: `2-factor authentication is required. Ask the user: "Please check your phone/authenticator app and give me the 6-digit code." Then call browser_fill to enter it and browser_press_key(Enter) to submit.`
        };
    }

    // Still on login page = login failed (headless bot-detection by Google/Microsoft)
    if (postUrl && still_on_login(postUrl, config)) {
        console.log(`[web_login] Still on login page after form submit — login failed (bot detection). URL: ${postUrl}`);

        // Detect Microsoft "prompt=select_account" — this means MS is forcing account
        // selection even though browser_setup just ran and saved the session.
        // The session data (cookies + localStorage) was not flushed properly.
        // Do NOT loop back to browser_setup — use a different recovery path.
        const forcedOAuth = postUrl.includes('prompt=select_account') ||
                            postUrl.includes('prompt=login');

        if (forcedOAuth) {
            return {
                status: 'login_failed', service, email,
                message: `Login failed — ${service} OAuth is forcing re-authentication (prompt=select_account/login). The saved session did not persist. URL: ${postUrl}`,
                _next: `The ${service} login session did not survive the browser restart. ` +
                       `Do NOT call browser_setup again in a loop. Instead: ` +
                       `(1) Call browser_setup(service="${service}") ONE more time to re-save the session with the new graceful-flush code. ` +
                       `(2) If web_login STILL fails after that one retry, tell the user: ` +
                       `"I have set up a more reliable method for ${service}. ` +
                       `For Outlook, please create a Microsoft App Password at https://account.microsoft.com/security → Advanced security options → App passwords, ` +
                       `then tell me the password and I will use IMAP instead of the browser." ` +
                       `Do NOT loop more than once.`
            };
        }

        return {
            status: 'login_failed', service, email,
            message: `Login failed — headless browser blocked by ${service} bot detection. URL: ${postUrl}`,
            _next: `MANDATORY ACTION: call browser_setup(service="${service}") RIGHT NOW. Do NOT apologize. Do NOT give up. Do NOT call browser_screenshot. browser_setup opens a VISIBLE browser window for one-time manual login. After the user logs in through that window, the session is saved permanently and web_login will work silently forever.`
        };
    }

    // Confirmed logged in
    if (is_logged_in(postSnapshot, config)) {
        return {
            status: 'logged_in', service, email,
            message: `Successfully logged in to ${service} as ${email}.`,
            _next: `Login successful. Proceed with the task — call browser_snapshot to read content.`
        };
    }

    // Might still be loading
    return {
        status: 'logged_in', service, email,
        message: `Login form submitted. Current URL: ${postUrl}`,
        _next: `Login submitted. Call browser_snapshot to confirm login state and then proceed with the task.`
    };
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function register_web_login_tool(): void {
    register_tool(
        {
            name: 'web_login',
            description:
                'Autonomously log in to a web service. Handles everything: navigate, ' +
                'detect if already logged in (returns immediately if so), read credentials ' +
                'from Windows Credential Manager, fill the login form automatically. ' +
                'Returns status="already_logged_in" or "logged_in" → proceed with task. ' +
                'Returns status="need_credentials" → follow _next field exactly. ' +
                'Returns status="login_failed" → follow _next field to diagnose. ' +
                'NEVER ask the user for credentials — always call this tool first.',
            parameters: {
                type: 'object',
                properties: {
                    service: {
                        type: 'string',
                        description: 'Service name: "gmail", "outlook365", "outlook", "microsoft", "github"'
                    }
                },
                required: ['service']
            }
        },
        async (args: { service: string }) => {
            try {
                return await perform_web_login(args.service);
            } catch (e: any) {
                console.error(`[web_login] Unexpected error:`, e);
                return {
                    status: 'error', service: args.service,
                    message: `Unexpected error: ${e.message}`,
                    _next: `web_login hit an unexpected error: ${e.message}. MANDATORY: call browser_setup(service="${args.service}") to open a visible browser for manual login. Do NOT give up.`
                };
            }
        }
    );
}
