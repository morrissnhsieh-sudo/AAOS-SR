import * as dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';
import multer from 'multer';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { io_accept_ws_connection, io_receive_line_webhook } from './channel/channel_manager';
import { bind_mcp_to_loopback } from './mcp/mcp_server';
import { schedule_heartbeat } from './heartbeat/heartbeat_monitor';
import { generate_device_jwt } from './auth/auth_manager';
import { io_list_installed_skills, io_disable_skill, io_receive_skill_install_request, io_load_active_skill_contents, Skill } from './skills/skill_manager';
import { register_native_tools } from './tools/native_tools';
import { register_iot_tools } from './tools/iot_tools';
import { register_wiki_tools, list_wiki_pages, read_wiki_page, ensure_wiki_structure } from './tools/wiki_tools';
import { start_scheduler_engine, stop_scheduler_engine, activate_job, deactivate_job, run_job_now } from './scheduler/scheduler_engine';
import { register_scheduler_tools } from './scheduler/scheduler_tools';
import { register_playwright_tools, shutdown_playwright } from './tools/playwright_mcp_bridge';
import { register_deep_think_tool } from './tools/deep_think_tool';
import { register_web_login_tool } from './tools/web_login_tool';
import { register_browser_setup_tool } from './tools/browser_setup_tool';
import { load_jobs, get_job, upsert_job, delete_job, update_job, make_job } from './scheduler/scheduler_store';
import { detect_os_environment } from './scheduler/os_env';
import { execute_tool } from './tools/tool_dispatcher';
import { load_usage, summarise_usage, get_pricing_table } from './usage/usage_tracker';
import { build_skill_from_description } from './skills/skill_builder';
import { collect_gateway_health, get_last_health } from './heartbeat/heartbeat_monitor';
import { pluginRegistry, load_plugins_from_config, initialize_plugin, SUPPORTED_PLUGINS, load_model_config, save_model_config, update_role_model, reset_role_model, get_model_config_api_response, AGENT_ROLES, ModelAssignment, AVAILABLE_MODELS } from './plugins/plugin_engine';

const app = express();
app.use(express.json());

// Serve webcam snapshots — registered BEFORE express.static so it always wins.
import * as os from 'os';
const SNAPSHOTS_DIR = path.resolve(process.env.AAOS_SNAPSHOTS_DIR || path.join(os.tmpdir(), 'aaos_snapshots'));
fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
console.log(`[Snapshots] Directory: ${SNAPSHOTS_DIR}`);
try {
    const existing = fs.readdirSync(SNAPSHOTS_DIR);
    console.log(`[Snapshots] ${existing.length} file(s) on disk: ${existing.slice(-3).join(', ') || '(none)'}`);
} catch { /* ignore */ }

app.get('/snapshots/:filename', (req, res) => {
    const filename = req.params.filename;
    if (!/^[a-zA-Z0-9_.\-]+$/.test(filename)) {
        res.status(400).send('Invalid filename'); return;
    }
    const filePath = path.join(SNAPSHOTS_DIR, filename);
    console.log(`[Snapshots] GET ${filename} → ${filePath}`);
    fs.readFile(filePath, (err, data) => {
        if (err) {
            console.error(`[Snapshots] Read failed: ${err.message}`);
            res.status(404).send('Not found'); return;
        }
        const ext = path.extname(filename).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
        res.set('Content-Type', mime);
        res.set('Content-Length', String(data.length));
        res.end(data);
        console.log(`[Snapshots] Served ${filename} (${data.length} bytes)`);
    });
});

app.use(express.static('public'));

// --- File Upload API ---
const UPLOADS_DIR = path.resolve(
    path.join(process.env.AAOS_WORKSPACE || path.join(process.env.USERPROFILE || process.env.HOME || '', '.aaos'), 'uploads')
);
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
console.log(`[Uploads] Directory: ${UPLOADS_DIR}`);

// Serve uploaded files — registered BEFORE express.static so it always wins.
// Supports HTTP Range requests so browsers can seek within video/audio files.
app.get('/uploads/:filename', (req, res) => {
    const filename = req.params.filename;
    if (!/^[a-zA-Z0-9_.\-]+$/.test(filename)) {
        res.status(400).send('Invalid filename'); return;
    }
    const filePath = path.join(UPLOADS_DIR, filename);
    if (!fs.existsSync(filePath)) {
        res.status(404).send('Not found'); return;
    }
    // Express res.sendFile handles Accept-Ranges / Range headers automatically,
    // which is required for HTML5 video seek and audio scrubbing.
    res.sendFile(filePath, (err) => {
        if (err) console.error(`[Uploads] Serve error for ${filename}: ${(err as any).message}`);
    });
});

const upload = multer({
    storage: multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
        filename: (_req, file, cb) => {
            const ext = path.extname(file.originalname);
            // Use HYPHENS not underscores — underscores in filenames are parsed as
            // markdown italic markers by LLMs, corrupting paths like _ISO_26262_ → ISO26262
            const base = path.basename(file.originalname, ext)
                .replace(/[^a-zA-Z0-9.\-]/g, '-')  // spaces, underscores, special chars → hyphen
                .replace(/-{2,}/g, '-')             // collapse multiple hyphens
                .replace(/^-+|-+$/g, '')            // trim leading/trailing hyphens
                .slice(0, 80);
            cb(null, `${Date.now()}-${base}${ext}`);
        }
    }),
    limits: { fileSize: 200 * 1024 * 1024 } // 200 MB — generous for video files
});

app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) { res.status(400).json({ ok: false, error: 'No file' }); return; }
    const mime = req.file.mimetype;
    const isImage = mime.startsWith('image/');
    const isVideo = mime.startsWith('video/');
    const webPath = `/uploads/${req.file.filename}`;
    console.log(`[Uploads] Received: ${req.file.originalname} (${req.file.size} bytes) → ${req.file.filename}`);
    res.json({
        ok: true,
        name: req.file.originalname,
        filename: req.file.filename,
        path: req.file.path,
        webPath,
        size: req.file.size,
        mime,
        isImage,
        isVideo
    });
});

app.post('/webhook/line', (req, res) => {
    io_receive_line_webhook(req, res);
});

// ── Background agent trigger — called by scheduled tasks (schtasks, cron, etc.) ──
// POST /api/agent/run  { message: string, session_id?: string }
// Runs a full agent turn and returns the response.
app.post('/api/agent/run', async (req, res) => {
    const { message, session_id } = req.body || {};
    if (!message || typeof message !== 'string') {
        res.status(400).json({ ok: false, error: 'message is required' });
        return;
    }
    const sid = (typeof session_id === 'string' && session_id) ? session_id : 'scheduler';
    const { get_or_create_session } = await import('./channel/channel_manager');
    const { start_agent_run } = await import('./agent/agent_runner');
    const { v4: uuidv4 } = await import('uuid');
    const session = get_or_create_session('scheduler', sid);
    const internalMsg = { id: uuidv4(), session_id: session.id, role: 'user' as const, content: message, created_at: new Date(), token_count: 0 };
    console.log(`[Scheduler] Agent run triggered — session=${session.id} message="${message.slice(0, 80)}"`);
    try {
        const result = await start_agent_run(session, internalMsg);
        res.json({ ok: true, session_id: session.id, response: (result.finalResponse ?? '').slice(0, 2000) });
    } catch (err: any) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.get('/auth/ui-token', (req, res) => {
    const token = generate_device_jwt('control-ui', process.env.JWT_SECRET || 'secret');
    res.json({ token });
});

// --- Skills API ---
app.get('/api/skills', (req, res) => {
    res.json(io_list_installed_skills());
});

app.post('/api/skills/install', (req, res) => {
    io_receive_skill_install_request(req, res);
});

app.delete('/api/skills/:id', (req, res) => {
    try {
        const skill = io_disable_skill(req.params.id);
        res.json({ status: 'disabled', skill });
    } catch (e: any) {
        res.status(404).json({ reason: e.message });
    }
});

app.post('/api/skills/build', async (req, res) => {
    const { description } = req.body;
    if (!description || typeof description !== 'string' || !description.trim()) {
        res.status(400).json({ reason: 'description is required' });
        return;
    }
    try {
        const skill = await build_skill_from_description(description.trim());
        res.json({
            ok: true,
            skill,
            allowed_tools: skill.allowed_tools ?? [],
        });
    } catch (e: any) {
        res.status(500).json({ ok: false, reason: e.message });
    }
});

// --- Model / Provider API ---
const MODEL_LABELS: Record<string, string> = {
    'anthropic-vertex': 'Claude Sonnet (Vertex AI)',
    'anthropic':        'Claude (Anthropic API)',
    'google':           'Gemini Flash (Vertex AI)',
};

app.get('/api/model', (_req, res) => {
    const provider = process.env.AAOS_LLM_PROVIDER || 'google';
    res.json({
        provider,
        label: MODEL_LABELS[provider] || provider,
        available: Object.entries(MODEL_LABELS).map(([id, label]) => ({ id, label }))
    });
});

app.post('/api/model', async (req, res) => {
    const { provider } = req.body;
    if (!provider || !(SUPPORTED_PLUGINS as readonly string[]).includes(provider)) {
        res.status(400).json({ ok: false, error: `Unknown provider: ${provider}` }); return;
    }
    try {
        process.env.AAOS_LLM_PROVIDER = provider;
        pluginRegistry.clear();
        const plugins = load_plugins_from_config({ plugins: { entries: { [provider]: {} } } });
        await Promise.all(plugins.map(initialize_plugin));
        // Clear all per-role overrides so every role inherits the new active provider
        save_model_config(getWorkspace(), {});
        console.log(`[Model] Switched to provider: ${provider} — all role overrides cleared, inheriting active provider`);
        res.json({ ok: true, provider, label: MODEL_LABELS[provider] || provider });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// --- Per-role Model Config API ---
app.get('/api/model-config', (req, res) => {
    res.json(get_model_config_api_response(getWorkspace()));
});

app.post('/api/model-config/:role', (req, res) => {
    const { role } = req.params;
    const { provider, model } = req.body as ModelAssignment;
    if (!role || !provider || !model) {
        res.status(400).json({ ok: false, error: 'role, provider, and model are required' }); return;
    }
    if (!(AGENT_ROLES as readonly string[]).includes(role)) {
        res.status(400).json({ ok: false, error: `Unknown role: ${role}. Valid roles: ${AGENT_ROLES.join(', ')}` }); return;
    }
    const validModels = (AVAILABLE_MODELS[provider] || []).map(m => m.id);
    if (validModels.length > 0 && !validModels.includes(model)) {
        res.status(400).json({ ok: false, error: `Unknown model '${model}' for provider '${provider}'` }); return;
    }
    try {
        update_role_model(getWorkspace(), role, { provider, model });
        res.json({ ok: true, role, provider, model });
    } catch (e: any) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

app.post('/api/model-config/:role/reset', (req, res) => {
    const { role } = req.params;
    if (!(AGENT_ROLES as readonly string[]).includes(role)) {
        res.status(400).json({ ok: false, error: `Unknown role: ${role}` }); return;
    }
    try {
        reset_role_model(getWorkspace(), role);
        res.json({ ok: true, role });
    } catch (e: any) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

app.get('/api/health', async (req, res) => {
    const last = get_last_health();
    if (last && (Date.now() - new Date(last.timestamp).getTime()) < 30000) {
        res.json(last); return;
    }
    const health = await collect_gateway_health();
    res.json(health);
});


// --- Memory API ---
function getWorkspace() {
    return process.env.AAOS_WORKSPACE ||
        path.join(process.env.HOME || process.env.USERPROFILE || '', '.aaos');
}

app.get('/api/memory', (req, res) => {
    const memFile = path.join(getWorkspace(), 'memory', 'MEMORY.md');
    try {
        const content = fs.readFileSync(memFile, 'utf8');
        const facts = content.split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2).trim());
        res.json({ facts });
    } catch {
        res.json({ facts: [] });
    }
});

app.post('/api/memory', (req, res) => {
    const { fact } = req.body;
    if (!fact) { res.status(400).json({ reason: 'fact required' }); return; }
    const memDir = path.join(getWorkspace(), 'memory');
    if (!fs.existsSync(memDir)) fs.mkdirSync(memDir, { recursive: true });
    fs.appendFileSync(path.join(memDir, 'MEMORY.md'), `- ${fact}\n`);
    res.json({ ok: true });
});

app.delete('/api/memory', (req, res) => {
    const { fact } = req.body;
    const memFile = path.join(getWorkspace(), 'memory', 'MEMORY.md');
    try {
        const lines = fs.readFileSync(memFile, 'utf8').split('\n');
        const filtered = lines.filter(l => l.trim() !== `- ${fact}`);
        fs.writeFileSync(memFile, filtered.join('\n'));
        res.json({ ok: true });
    } catch {
        res.status(404).json({ reason: 'Memory file not found' });
    }
});

// --- Usage / Cost API ---
app.get('/api/usage', (req, res) => {
    const period = String(req.query.period || '24h');
    const now = Date.now();
    const PERIODS: Record<string, number> = {
        '1h':   1 * 3600_000,
        '6h':   6 * 3600_000,
        '24h': 24 * 3600_000,
        '7d':   7 * 86400_000,
        '30d': 30 * 86400_000,
    };
    const fromMs = period === 'all' ? undefined : now - (PERIODS[period] ?? PERIODS['24h']);
    // Bucket size: scales with period so timeline has ~24 bars max
    const bucketMs = period === '1h' ? 5*60_000 : period === '6h' ? 15*60_000 :
                     period === '24h' ? 60*60_000 : period === '7d' ? 6*3600_000 :
                     period === '30d' ? 24*3600_000 : 24*3600_000;
    const records  = load_usage(fromMs, undefined);
    const summary  = summarise_usage(records, bucketMs);
    // Also return recent 50 individual records for the activity log
    const recent   = records.slice(-50).reverse();
    res.json({ period, summary, recent, pricing: get_pricing_table() });
});

// --- Wiki API ---
app.get('/api/wiki/pages', (_req, res) => {
    try {
        ensure_wiki_structure();
        const pages = list_wiki_pages();
        res.json({ pages: pages.map(p => ({ name: p.name, size: p.size, modified: p.modified })) });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/wiki/pages/*', (req, res) => {
    const name = (req.params as any)[0] as string;
    if (!name || /\.\./.test(name)) { res.status(400).json({ error: 'Invalid page name' }); return; }
    const content = read_wiki_page(name);
    if (!content) { res.status(404).json({ error: `Page not found: ${name}` }); return; }
    res.json({ name, content });
});

app.post('/api/wiki/ingest', async (req, res) => {
    const { source, title, focus } = req.body;
    if (!source) { res.status(400).json({ ok: false, error: 'source is required' }); return; }
    try {
        const result = await execute_tool({ id: 'http', name: 'wiki_ingest', args: { source, title, focus } });
        res.json(result.result);
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post('/api/wiki/lint', async (req, res) => {
    const { auto_fix = false } = req.body || {};
    try {
        const result = await execute_tool({ id: 'http', name: 'wiki_lint', args: { auto_fix } });
        res.json(result.result);
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ── Scheduler REST API ─────────────────────────────────────────────────────────

app.get('/api/schedule', (_req, res) => {
    res.json(load_jobs());
});

app.post('/api/schedule', (req, res) => {
    try {
        const { name, cron, message, notify = false, tags = [], session_id } = req.body || {};
        if (!name || !cron || !message) { res.status(400).json({ ok: false, error: 'name, cron and message are required' }); return; }
        const safeName = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        deactivate_job(safeName);
        const job = make_job(safeName, cron, message, { notify, tags, session_id });
        upsert_job(job);
        const activation = activate_job(job);
        if (!activation.ok) { delete_job(safeName); res.status(500).json({ ok: false, error: activation.error }); return; }
        res.json({ ok: true, job });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/schedule/:name/pause', (req, res) => {
    const job = get_job(req.params.name);
    if (!job) { res.status(404).json({ ok: false, error: 'Job not found' }); return; }
    deactivate_job(job.name);
    update_job(job.name, { enabled: false });
    res.json({ ok: true });
});

app.post('/api/schedule/:name/resume', (req, res) => {
    const job = get_job(req.params.name);
    if (!job) { res.status(404).json({ ok: false, error: 'Job not found' }); return; }
    const updated = update_job(job.name, { enabled: true });
    if (updated) { activate_job(updated); }
    res.json({ ok: true });
});

app.post('/api/schedule/:name/run', async (req, res) => {
    const job = get_job(req.params.name);
    if (!job) { res.status(404).json({ ok: false, error: 'Job not found' }); return; }
    try {
        const result = await run_job_now(job);
        res.json({ ok: true, result: result.slice(0, 1000) });
    } catch (e: any) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete('/api/schedule/:name', (req, res) => {
    deactivate_job(req.params.name);
    const deleted = delete_job(req.params.name);
    res.json({ ok: deleted });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/chat' });

wss.on('connection', (ws, req) => {
    io_accept_ws_connection(ws, req as any);
});

// Suppress WSS-forwarded port errors — handled by server.on('error') below
wss.on('error', () => {});

// ── Pre-start: kill any processes already holding ports 3000 or 3001 ─────────
function kill_port_conflicts(ports: number[]): void {
    if (process.platform !== 'win32') return;
    try {
        const { execSync } = require('child_process');
        const out: string = execSync('netstat -ano', { encoding: 'utf8', stdio: 'pipe' });
        for (const line of out.split('\n')) {
            for (const port of ports) {
                if (line.includes(`:${port}`) && line.includes('LISTENING')) {
                    const parts = line.trim().split(/\s+/);
                    const pid = parts[parts.length - 1];
                    if (pid && pid !== String(process.pid) && /^\d+$/.test(pid)) {
                        try {
                            execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'pipe' });
                            console.log(`[AAOS] Pre-start: killed conflicting PID ${pid} on port ${port}`);
                        } catch { /* already gone */ }
                    }
                }
            }
        }
    } catch { /* ignore */ }
}

// ── Startup sequence: kill conflicts → wait for OS to free ports → listen ────
server.on('error', (err: any) => {
    if (err.code !== 'EADDRINUSE') {
        console.error('[AAOS] Server error:', err);
        process.exit(1);
    }
    // Should not normally reach here since we pre-kill, but handle as last resort
    console.warn('[AAOS] Port 3000 still in use after pre-kill — retrying in 3s...');
    setTimeout(() => server.listen(3000, onListening), 3000);
});

async function start_server(): Promise<void> {
    kill_port_conflicts([3000, 3001]);
    // Wait for OS to fully release the ports after kill
    await new Promise<void>(resolve => setTimeout(resolve, 800));
    bind_mcp_to_loopback(3001);
    server.listen(3000, onListening);
}

start_server();

function onListening() {
    console.log('USI AI\u2011OS\u00ae - Personal Assistant listening on port 3000');
    load_model_config(getWorkspace());
    register_native_tools();
    register_deep_think_tool();
    register_web_login_tool();
    register_browser_setup_tool();
    console.log('Native tools registered: think, problem_solve, verify_solution, remember, credentials_read, web_login, browser_setup, web_fetch, file_read, file_write, file_list, file_search, bash_exec, build_skill, analyze_image, analyze_video, webcam_capture');
    register_iot_tools();
    register_wiki_tools();
    register_scheduler_tools();
    // Playwright MCP — browser automation tools (browser_navigate, browser_click, …)
    register_playwright_tools().catch((e: any) =>
        console.warn('[playwright-mcp] Deferred registration failed:', e.message)
    );
    start_scheduler_engine();

    // Pre-initialize the LLM plugin at startup so the heartbeat ping can verify it
    // immediately rather than reporting a false "degraded" on first check.
    const llmProvider = process.env.AAOS_LLM_PROVIDER || 'google';
    if (pluginRegistry.size === 0) {
        const plugins = load_plugins_from_config({ plugins: { entries: { [llmProvider]: {} } } });
        Promise.all(plugins.map(initialize_plugin))
            .then(() => console.log(`LLM plugin '${llmProvider}' pre-initialized.`))
            .catch((e: any) => console.error(`LLM plugin '${llmProvider}' pre-init failed: ${e.message}`));
    }

    schedule_heartbeat(300000, 60000);
    
    const skills: Skill[] = io_list_installed_skills();
    const enabledSkills = skills.filter(s => s.status === 'enabled');
    const loadedContents = io_load_active_skill_contents(enabledSkills);

    console.log(`Skills registered: ${loadedContents.length}/${enabledSkills.length} enabled skills loaded OK`);
    loadedContents.forEach(c => console.log(`  ✓ ${c.frontmatter.name} — ${c.frontmatter.description.slice(0, 60)}`));

    const broken = enabledSkills.filter(s => !loadedContents.find(c => c.frontmatter.name === s.name));
    broken.forEach(s => console.warn(`  ✗ ${s.name} — SKILL.md missing or unparseable at: ${s.skill_md_path}`));

    // Log OS environment detected for scheduled tasks
    const osEnv = detect_os_environment();
    console.log(`[OS] ${osEnv.description}`);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────
function graceful_shutdown(signal: string) {
    console.log(`\n[AAOS] Received ${signal} — shutting down gracefully...`);
    stop_scheduler_engine();
    shutdown_playwright();
    server.close(() => {
        console.log('[AAOS] Server closed. Goodbye.');
        process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000); // force exit after 5s
}
process.on('SIGINT',  () => graceful_shutdown('SIGINT'));
process.on('SIGTERM', () => graceful_shutdown('SIGTERM'));
