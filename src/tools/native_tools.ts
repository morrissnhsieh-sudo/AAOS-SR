import * as child_process from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { register_tool } from './tool_dispatcher';
import * as yaml from 'js-yaml';
import { build_skill_from_description } from '../skills/skill_builder';
import { append_validated_memory_fact } from '../memory/memory_system';
import { GoogleGenAI } from '@google/genai';

interface DirEntry {
    name: string;
    path: string;
    type: 'file' | 'directory';
    size?: number;
}

function listEntries(dir: string, recursive: boolean): DirEntry[] {
    const results: DirEntry[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const type = entry.isDirectory() ? 'directory' : 'file';
        const item: DirEntry = { name: entry.name, path: fullPath, type };
        if (entry.isFile()) {
            try { item.size = fs.statSync(fullPath).size; } catch { /* ignore */ }
        }
        results.push(item);
        if (recursive && entry.isDirectory()) {
            results.push(...listEntries(fullPath, true));
        }
    }
    return results;
}

const EXEC_TIMEOUT_MS = 15000;
const MAX_OUTPUT_CHARS = 8000;

/**
 * Finds the Windows Python executable path using cmd.exe (always available on Windows).
 * Returns a Windows-native path like C:\Python314\python.exe that works with execFile().
 * Falls back to hardcoded candidates if where.exe lookup fails.
 */
function findWindowsPython(): string {
    if (process.platform !== 'win32') return 'python3';
    try {
        // shell: true uses cmd.exe on Windows — always reliable regardless of bash type
        const result = child_process.execSync('where python', {
            shell: true,
            timeout: 3000,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe']
        } as any);
        const lines = result.trim().split(/\r?\n/).map((l: string) => l.trim())
            .filter((l: string) => l.toLowerCase().endsWith('.exe') && !l.includes('WindowsApps'));
        if (lines.length > 0) return lines[0];
    } catch { /* fall through */ }
    // Hardcoded fallbacks in priority order
    const fallbacks = [
        'C:\\Python314\\python.exe',
        'C:\\Python313\\python.exe',
        'C:\\Python312\\python.exe',
        'C:\\Python311\\python.exe',
    ];
    for (const p of fallbacks) {
        try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
    }
    return 'python';
}

/** Cached Windows Python executable path — resolved once at startup. */
const WINDOWS_PYTHON = process.platform === 'win32' ? findWindowsPython() : 'python3';

/**
 * Resolves a path that may be in WSL or Unix format to a Windows-native path
 * that Node.js fs APIs can open directly.
 *
 * Handles:
 *  - Tilde expansion  ~/foo          → C:\Users\User\foo
 *  - WSL drive paths  /mnt/c/foo     → C:\foo
 *  - Git-Bash paths   /c/foo         → C:\foo
 *  - Already Windows  C:\foo         → C:\foo  (unchanged)
 */
function resolve_path(inputPath: string): string {
    if (process.platform !== 'win32') return inputPath;

    let p = inputPath.trim();

    // Expand ~ to Windows home directory
    if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
        p = path.join(os.homedir(), p.slice(1));
    }

    // WSL path: /mnt/<drive>/...  →  <drive>:\...
    const wslMatch = p.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
    if (wslMatch) {
        const drive = wslMatch[1].toUpperCase();
        const rest  = (wslMatch[2] || '').replace(/\//g, path.sep);
        return `${drive}:${rest || path.sep}`;
    }

    // Git Bash path: /<drive>/...  →  <drive>:\...
    const gitBashMatch = p.match(/^\/([a-zA-Z])(\/.*)?$/);
    if (gitBashMatch) {
        const drive = gitBashMatch[1].toUpperCase();
        const rest  = (gitBashMatch[2] || '').replace(/\//g, path.sep);
        return `${drive}:${rest || path.sep}`;
    }

    return p;
}

/**
 * Registers built-in tools that are always available to the LLM,
 * regardless of which skills are installed.
 */
export function register_native_tools(): void {

    // ── File system ──────────────────────────────────────────────────────────

    register_tool(
        {
            name: 'file_read',
            description: 'Read the contents of a local TEXT file. Returns text content. ' +
                'NOT for binary files — for .pdf/.docx/.xlsx use wiki_ingest instead.',
            parameters: {
                type: 'object',
                properties: {
                    path:     { type: 'string', description: 'Absolute or relative file path' },
                    encoding: { type: 'string', description: 'File encoding (default: utf8)', enum: ['utf8', 'base64'] }
                },
                required: ['path']
            }
        },
        async (args: { path: string; encoding?: BufferEncoding }) => {
            try {
                const resolved = resolve_path(args.path);

                // Block binary document formats — they produce megabytes of garbage as UTF-8
                const BINARY_EXTS = new Set([
                    '.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt',
                    '.zip', '.7z', '.rar', '.tar', '.gz', '.bz2',
                    '.exe', '.dll', '.bin', '.so', '.dylib',
                    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico',
                    '.mp4', '.mov', '.avi', '.mkv', '.mp3', '.wav', '.flac',
                ]);
                const ext = path.extname(resolved).toLowerCase();
                if (BINARY_EXTS.has(ext) && args.encoding !== 'base64') {
                    const docExts = new Set(['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt']);
                    if (docExts.has(ext)) {
                        return { error: `Cannot read binary document "${path.basename(resolved)}" as text. Use wiki_ingest to extract and compile its content into the knowledge base instead.` };
                    }
                    return { error: `"${path.basename(resolved)}" is a binary file (${ext}). Use encoding:"base64" to read raw bytes, or a dedicated tool for this file type.` };
                }

                // Guard against huge files that would blow up the context window
                const MAX_FILE_BYTES = 200 * 1024; // 200 KB
                const stat = fs.statSync(resolved);
                if (stat.size > MAX_FILE_BYTES && args.encoding !== 'base64') {
                    const kb = Math.round(stat.size / 1024);
                    return { error: `File is ${kb} KB — too large to read into context (limit: 200 KB). Use file_search to find specific content, or wiki_ingest to compile it into the knowledge base.` };
                }

                const content = fs.readFileSync(resolved, args.encoding ?? 'utf8');
                return { content: String(content), bytes: Buffer.byteLength(String(content)), resolved_path: resolved };
            } catch (err: any) {
                return { error: err.message };
            }
        }
    );

    register_tool(
        {
            name: 'file_write',
            description: 'Write text content to a local file. Creates the file and any missing parent directories.',
            parameters: {
                type: 'object',
                properties: {
                    path:    { type: 'string', description: 'Absolute or relative file path' },
                    content: { type: 'string', description: 'Text to write' },
                    append:  { type: 'boolean', description: 'Append instead of overwrite (default: false)' }
                },
                required: ['path', 'content']
            }
        },
        async (args: { path: string; content: string; append?: boolean }) => {
            try {
                const resolved = resolve_path(args.path);
                fs.mkdirSync(path.dirname(resolved), { recursive: true });
                if (args.append) {
                    fs.appendFileSync(resolved, args.content, 'utf8');
                } else {
                    fs.writeFileSync(resolved, args.content, 'utf8');
                }
                return { ok: true, path: resolved };
            } catch (err: any) {
                return { error: err.message };
            }
        }
    );

    register_tool(
        {
            name: 'file_list',
            description: 'List files and directories at a given path.',
            parameters: {
                type: 'object',
                properties: {
                    dir:       { type: 'string', description: 'Directory path to list' },
                    recursive: { type: 'boolean', description: 'List recursively (default: false)' }
                },
                required: ['dir']
            }
        },
        async (args: { dir: string; recursive?: boolean }) => {
            try {
                const entries = listEntries(resolve_path(args.dir), args.recursive ?? false);
                return { entries, count: entries.length };
            } catch (err: any) {
                return { error: err.message };
            }
        }
    );

    register_tool(
        {
            name: 'file_search',
            description: 'Search for files matching a name pattern under a directory.',
            parameters: {
                type: 'object',
                properties: {
                    dir:     { type: 'string', description: 'Root directory to search under' },
                    pattern: { type: 'string', description: 'Case-insensitive substring or glob to match against file names' }
                },
                required: ['dir', 'pattern']
            }
        },
        async (args: { dir: string; pattern: string }) => {
            try {
                const all   = listEntries(resolve_path(args.dir), true);
                const lower = args.pattern.toLowerCase();
                const matches = all.filter(e => e.name.toLowerCase().includes(lower));
                return { matches, count: matches.length };
            } catch (err: any) {
                return { error: err.message };
            }
        }
    );

    // ── System information ────────────────────────────────────────────────────

    register_tool(
        {
            name: 'sys_info',
            description:
                'Returns the current OS platform, architecture, shell, home directory, ' +
                'path separator, and Node.js version. ' +
                'Call this whenever you need to choose between Windows and Unix command syntax, ' +
                'or before writing any file path or shell command for the first time.',
            parameters: { type: 'object', properties: {}, required: [] }
        },
        async (_args: Record<string, never>) => {
            const platform = process.platform;
            const isWin    = platform === 'win32';
            const osLabel  = isWin ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux';

            // Detect which bash is active and which drive-path format it uses
            let shell = isWin ? 'cmd.exe' : (process.env.SHELL || '/bin/sh');
            let bashDrivePrefix = '';
            let bashNote = '';
            if (isWin) {
                try {
                    child_process.execSync('bash --version', { timeout: 1500, stdio: 'pipe' });
                    shell = 'bash';
                    // Probe whether /c/ (Git Bash/MSYS2) or /mnt/c/ (WSL) is the correct prefix
                    try {
                        child_process.execSync('ls /c/Windows/System32/cmd.exe', { shell: 'bash', timeout: 2000, stdio: 'pipe' });
                        bashDrivePrefix = '/c/';
                        shell = 'bash (Git Bash / MSYS2)';
                        bashNote = 'Drive C: maps to /c/ in bash. Example: C:\\foo\\bar → /c/foo/bar';
                    } catch {
                        try {
                            child_process.execSync('ls /mnt/c/Windows/System32/cmd.exe', { shell: 'bash', timeout: 2000, stdio: 'pipe' });
                            bashDrivePrefix = '/mnt/c/';
                            shell = 'bash (WSL)';
                            bashNote = 'Drive C: maps to /mnt/c/ in bash. Example: C:\\foo\\bar → /mnt/c/foo/bar';
                        } catch {
                            bashNote = 'Drive prefix unknown — avoid Windows paths in bash commands. Use webcam_capture and other native tools instead.';
                        }
                    }
                } catch { /* cmd.exe only */ }
            }

            return {
                os:              osLabel,
                platform,
                arch:            os.arch(),
                release:         os.release(),
                shell,
                bashDrivePrefix, // '/c/' for Git Bash, '/mnt/c/' for WSL, '' if unknown
                bashNote,        // human-readable explanation of the path mapping
                home:            os.homedir(),
                pathSep:         path.sep,
                nodeVersion:     process.version,
                pythonExe:       WINDOWS_PYTHON,  // correct Python executable to use with webcam_capture
                snapshotsDir:    process.env.AAOS_SNAPSHOTS_DIR || path.join(os.tmpdir(), 'aaos_snapshots'),  // where webcam photos are saved
                snapshotsUrl:    '/snapshots',   // web path to access saved photos
                commandStyle:    isWin
                    ? `The HOST OS is Windows (win32). bash_exec runs inside WSL (Linux), so bash commands like 'uname' and 'cat /etc/os-release' return Ubuntu/Linux — NOT the real OS. ALWAYS use sys_info (this tool) for OS detection, never shell commands. ${bashNote || 'check bashDrivePrefix before writing any path'}. NEVER use bare 'python' or 'python3' — always use the pythonExe value above.`
                    : 'Use POSIX syntax. Standard Unix tools available.'
            };
        }
    );

    // ── Reasoning & memory ───────────────────────────────────────────────────

    register_tool(
        {
            name: 'think',
            description:
                'Private reasoning scratchpad. Use BEFORE any multi-step task to plan your approach: ' +
                'state what is being asked, what tools you will use, in what order, and any edge cases. ' +
                'The user does not see this output — it is for your reasoning only.',
            parameters: {
                type: 'object',
                properties: {
                    reasoning: {
                        type: 'string',
                        description: 'Your step-by-step reasoning, plan, or analysis before acting'
                    }
                },
                required: ['reasoning']
            }
        },
        async (_args: { reasoning: string }) => {
            // The value is in the LLM writing it out, not in what we return.
            return { ok: true };
        }
    );

    register_tool(
        {
            name: 'remember',
            description:
                'Store a PERMANENT fact about the user in long-term memory. ' +
                'Only use for: user name, preferred language, timezone, city/country, long-term project names, stated preferences. ' +
                'NEVER store: weather, temperature, system scan results, OS versions, port numbers, ' +
                'tool/skill names, agent actions, or anything time-sensitive or volatile. ' +
                'Facts are validated server-side and rejected if they contain volatile content.',
            parameters: {
                type: 'object',
                properties: {
                    fact: {
                        type: 'string',
                        description: 'A concise declarative sentence to store, e.g. "User\'s name is Alex." or "User works in TypeScript."'
                    }
                },
                required: ['fact']
            }
        },
        async (args: { fact: string }) => {
            try {
                const workspace = process.env.AAOS_WORKSPACE ||
                    path.join(process.env.HOME || process.env.USERPROFILE || '', '.aaos');
                const result = append_validated_memory_fact(workspace, args.fact);
                if (!result.ok) return { ok: false, error: result.reason };
                return { ok: true, stored: args.fact };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    // ── Skill management ─────────────────────────────────────────────────────

    register_tool(
        {
            name: 'build_skill',
            description: 'Generate and register a new AAOS skill from a plain-English description. ' +
                'Use when the user asks to create, add, or build a skill. ' +
                'Returns the registered skill name, description, and allowed tools.',
            parameters: {
                type: 'object',
                properties: {
                    description: {
                        type: 'string',
                        description: 'Plain-English description of what the skill should do'
                    }
                },
                required: ['description']
            }
        },
        async (args: { description: string }) => {
            try {
                const skill = await build_skill_from_description(args.description);
                return {
                    ok: true,
                    name: skill.name,
                    description: skill.description,
                    allowed_tools: skill.allowed_tools ?? [],
                    version: skill.version,
                    message: `Skill "${skill.name}" has been created and is now active.`
                };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    // ── AI vision: analyze any image file ────────────────────────────────────

    register_tool(
        {
            name: 'analyze_image',
            description:
                'Analyze any image file using AI vision. Use this whenever the user uploads an image or asks you to ' +
                'look at, describe, read, extract text from, or analyze any image at a given file path. ' +
                'Works with PNG, JPG, GIF, WebP and other common formats. ' +
                'Returns a detailed description or answer to your prompt about the image.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Absolute path to the image file on disk'
                    },
                    prompt: {
                        type: 'string',
                        description: 'What you want to know about the image. E.g. "Describe in detail", "Extract all text", "List all UI components"'
                    }
                },
                required: ['path', 'prompt']
            }
        },
        async (args: { path: string; prompt: string }) => {
            try {
                const imgPath = args.path;
                if (!fs.existsSync(imgPath)) return { ok: false, error: `File not found: ${imgPath}` };

                const ext = path.extname(imgPath).toLowerCase();
                const mimeMap: Record<string, string> = {
                    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                    '.png': 'image/png', '.gif': 'image/gif',
                    '.webp': 'image/webp', '.bmp': 'image/bmp'
                };
                const mime = mimeMap[ext] || 'image/jpeg';

                const imgBytes = fs.readFileSync(imgPath);
                const base64Data = imgBytes.toString('base64');

                const project  = process.env.VERTEX_PROJECT_ID || 'd-sxd110x-ssd1-cdl';
                const location = process.env.VERTEX_LOCATION   || 'us-central1';
                const model    = process.env.VERTEX_MODEL       || 'gemini-2.0-flash';

                if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
                    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
                    process.env.GOOGLE_APPLICATION_CREDENTIALS = process.platform === 'win32'
                        ? path.join(appData, 'gcloud', 'application_default_credentials.json')
                        : path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
                }

                const ai = new GoogleGenAI({ vertexai: true, project, location });
                const response = await ai.models.generateContent({
                    model,
                    contents: [{
                        role: 'user',
                        parts: [
                            { inlineData: { mimeType: mime, data: base64Data } },
                            { text: args.prompt }
                        ]
                    }]
                });

                console.log(`[analyze_image] Analyzed ${path.basename(imgPath)} (${imgBytes.length} bytes)`);
                return { ok: true, description: response.text, path: imgPath, bytes: imgBytes.length };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    // ── AI vision: analyze video file ────────────────────────────────────────

    register_tool(
        {
            name: 'analyze_video',
            description:
                'Analyze a video file using AI vision by extracting frames and sending them to Gemini. ' +
                'Use this IMMEDIATELY when the user uploads any video file (.mp4, .mov, .avi, .mkv, etc.) — ' +
                'do NOT ask clarifying questions first, just call this tool right away. ' +
                'Returns a comprehensive description of what is happening in the video.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Absolute path to the video file on disk'
                    },
                    prompt: {
                        type: 'string',
                        description: 'What you want to know about the video. Defaults to a general overview if omitted.'
                    },
                    num_frames: {
                        type: 'number',
                        description: 'Number of frames to extract for analysis (default: 8, max: 16)'
                    }
                },
                required: ['path']
            }
        },
        async (args: { path: string; prompt?: string; num_frames?: number }) => {
            try {
                const videoPath = args.path;
                if (!fs.existsSync(videoPath)) return { ok: false, error: `File not found: ${videoPath}` };

                const numFrames = Math.min(args.num_frames ?? 8, 16);
                const analysisPrompt = args.prompt || 'Provide a comprehensive overview of this video: describe what is happening, who or what appears in it, the setting, any actions or events, and the overall content.';

                // Write an inline Python script to a temp file for frame extraction
                const tmpScript = path.join(os.tmpdir(), `aaos_video_extract_${Date.now()}.py`);
                const pyScript = `
import sys, json, base64, os
try:
    import cv2
except ImportError:
    print(json.dumps({"ok": False, "error": "cv2 not installed — run: pip install opencv-python-headless"}))
    sys.exit(1)

video_path = sys.argv[1]
num_frames = int(sys.argv[2]) if len(sys.argv) > 2 else 8

cap = cv2.VideoCapture(video_path)
if not cap.isOpened():
    print(json.dumps({"ok": False, "error": "Cannot open video: " + video_path}))
    sys.exit(1)

total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
fps = cap.get(cv2.CAP_PROP_FPS)
width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
duration = total / fps if fps > 0 else 0

frames_b64 = []
if total > 0:
    step = max(1, total // num_frames)
    indices = [min(i * step, total - 1) for i in range(num_frames)]
    for idx in indices:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ret, frame = cap.read()
        if ret:
            _, buf = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
            frames_b64.append(base64.b64encode(buf).decode('utf-8'))

cap.release()
print(json.dumps({"ok": True, "frames": frames_b64, "total_frames": total, "fps": round(fps, 2), "duration": round(duration, 2), "width": width, "height": height}))
`;
                fs.writeFileSync(tmpScript, pyScript, 'utf8');

                // Run the Python script to extract frames
                const extractResult: any = await new Promise((resolve) => {
                    child_process.execFile(
                        WINDOWS_PYTHON,
                        [tmpScript, videoPath, String(numFrames)],
                        { timeout: 60000, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
                        (err, stdout, stderr) => {
                            try { fs.unlinkSync(tmpScript); } catch { /* ignore */ }
                            const raw = (stdout || '').trim();
                            if (!raw) {
                                resolve({ ok: false, error: (stderr || err?.message || 'No output from Python').slice(0, 500) });
                                return;
                            }
                            try { resolve(JSON.parse(raw)); }
                            catch { resolve({ ok: false, error: `Non-JSON output: ${raw.slice(0, 300)}` }); }
                        }
                    );
                });

                if (!extractResult.ok) return extractResult;

                const frames: string[] = extractResult.frames || [];
                if (frames.length === 0) return { ok: false, error: 'No frames could be extracted from the video.' };

                console.log(`[analyze_video] Extracted ${frames.length} frames from ${path.basename(videoPath)} (${extractResult.duration}s, ${extractResult.width}x${extractResult.height})`);

                // Send all frames + prompt to Gemini Vision
                const project  = process.env.VERTEX_PROJECT_ID || 'd-sxd110x-ssd1-cdl';
                const location = process.env.VERTEX_LOCATION   || 'us-central1';
                const model    = process.env.VERTEX_MODEL       || 'gemini-2.0-flash';

                if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
                    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
                    process.env.GOOGLE_APPLICATION_CREDENTIALS = process.platform === 'win32'
                        ? path.join(appData, 'gcloud', 'application_default_credentials.json')
                        : path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
                }

                const ai = new GoogleGenAI({ vertexai: true, project, location });

                const parts: any[] = [
                    { text: `This is a video file: ${path.basename(videoPath)} (${extractResult.duration}s, ${extractResult.width}x${extractResult.height}, ${frames.length} frames sampled evenly). Analyze the following frames:\n` }
                ];
                frames.forEach((b64, i) => {
                    parts.push({ text: `Frame ${i + 1}/${frames.length}:` });
                    parts.push({ inlineData: { mimeType: 'image/jpeg', data: b64 } });
                });
                parts.push({ text: `\n${analysisPrompt}` });

                const response = await ai.models.generateContent({
                    model,
                    contents: [{ role: 'user', parts }]
                });

                console.log(`[analyze_video] Analysis complete for ${path.basename(videoPath)}`);
                return {
                    ok: true,
                    description: response.text,
                    path: videoPath,
                    frames_analyzed: frames.length,
                    duration: extractResult.duration,
                    resolution: `${extractResult.width}x${extractResult.height}`,
                    fps: extractResult.fps
                };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    // ── Webcam capture ───────────────────────────────────────────────────────

    register_tool(
        {
            name: 'webcam_capture',
            description:
                'Capture a photo from the laptop webcam and optionally analyze it with AI vision. ' +
                'Use when the user asks to take a photo, use the camera, or see what is visible. ' +
                'Returns JSON with ok, path, webPath, bytes, and description fields. ' +
                'IMPORTANT: After this tool returns, you MUST generate a text reply to the user that embeds the photo ' +
                'using ![photo](webPath) on its own line, then presents the description. ' +
                'Never skip the final text response. Never call remember before generating this reply.',
            parameters: {
                type: 'object',
                properties: {
                    prompt: {
                        type: 'string',
                        description: 'Vision question to ask about the captured image. Omit to capture without analysis.'
                    },
                    cam: {
                        type: 'number',
                        description: 'Camera index (default 0). Try 1 if 0 fails.'
                    }
                },
                required: []
            }
        },
        async (args: { prompt?: string; cam?: number }) => {
            return new Promise((resolve) => {
                const scriptPath = path.join(
                    process.env.AAOS_WORKSPACE ||
                    path.join(process.env.USERPROFILE || process.env.HOME || '', '.aaos'),
                    'scripts', 'webcam_capture.py'
                );
                const mode = args.prompt ? 'analyze' : 'capture';
                const cmdArgs = [scriptPath, mode];
                if (args.prompt) cmdArgs.push(args.prompt);
                if (args.cam !== undefined) cmdArgs.push('--cam', String(args.cam));

                console.log(`[webcam] Spawning: ${WINDOWS_PYTHON} ${cmdArgs.join(' ')}`);

                // Compute the canonical snapshots directory and pass it explicitly
                // so webcam_capture.py saves to the SAME folder the HTTP server serves.
                const snapshotsDir = path.resolve(
                    process.env.AAOS_SNAPSHOTS_DIR || path.join(os.tmpdir(), 'aaos_snapshots')
                );
                fs.mkdirSync(snapshotsDir, { recursive: true });

                child_process.execFile(
                    WINDOWS_PYTHON,
                    cmdArgs,
                    { timeout: 30000, encoding: 'utf8', env: { ...process.env, AAOS_SNAPSHOTS_DIR: snapshotsDir } },
                    (err, stdout, stderr) => {
                        const raw = (stdout || '').trim();
                        if (!raw && err) {
                            resolve({ ok: false, error: (stderr || err.message).slice(0, 500) });
                            return;
                        }
                        try {
                            const result = JSON.parse(raw);
                            // Add a web-accessible URL so the chat UI can display the image inline.
                            if (result.ok && result.path) {
                                const filename = path.basename(result.path);
                                result.webPath = `/snapshots/${filename}`;
                                // Verify the file actually landed on disk
                                try {
                                    const stat = fs.statSync(result.path);
                                    console.log(`[webcam] Saved: ${result.path} (${stat.size} bytes) → ${result.webPath}`);
                                } catch (statErr: any) {
                                    console.error(`[webcam] WARNING: file not found at ${result.path}: ${statErr.message}`);
                                }
                                // Explicit next-step instruction embedded in the result so the
                                // LLM knows it must generate a text reply showing the image.
                                result._next = `REQUIRED: Your very next message to the user must start with ![photo](${result.webPath}) on its own line, then present the description below it. Do not call any more tools first.`;
                            }
                            resolve(result);
                        } catch {
                            resolve({ ok: false, error: `Non-JSON output: ${raw.slice(0, 300)}` });
                        }
                    }
                );
            });
        }
    );

    // ── Web fetch ─────────────────────────────────────────────────────────────

    register_tool(
        {
            name: 'web_fetch',
            description:
                'Fetch the text content of any public URL (web page, RSS/Atom feed, API, raw file, gist, pastebin, etc.) ' +
                'directly from Node.js. ' +
                'ALWAYS use this tool whenever you need to read a URL — NEVER use bash_exec+curl for URL fetching. ' +
                'RSS and Atom feeds are automatically parsed into a clean structured list of items (title, link, date, summary). ' +
                'HTML pages are stripped to readable text. ' +
                'For GitHub Gists, automatically converts the viewer URL to the raw URL.',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: 'The URL to fetch'
                    },
                    raw: {
                        type: 'boolean',
                        description: 'Return the raw response body without any processing (default: false)'
                    },
                    max_items: {
                        type: 'number',
                        description: 'For RSS/Atom feeds: maximum number of items to return (default: 20)'
                    },
                    max_chars: {
                        type: 'number',
                        description: 'Maximum characters to return for non-feed content (default: 12000)'
                    }
                },
                required: ['url']
            }
        },
        async (args: { url: string; raw?: boolean; max_items?: number; max_chars?: number }) => {
            const https = await import('https');
            const http  = await import('http');
            const maxChars = args.max_chars ?? 12000;
            const maxItems = args.max_items ?? 20;

            // Auto-convert GitHub Gist viewer URL → raw URL
            let url = args.url.trim();
            const gistMatch = url.match(/^https?:\/\/gist\.github\.com\/([^/]+)\/([a-f0-9]+)\/?$/i);
            if (gistMatch) {
                url = `https://gist.github.com/${gistMatch[1]}/${gistMatch[2]}/raw`;
                console.log(`[web_fetch] Gist → raw URL: ${url}`);
            }

            const fetch_url = (target: string): Promise<{ body: string; status: number; contentType: string }> =>
                new Promise((resolve, reject) => {
                    const mod = target.startsWith('https') ? https : http;
                    const req = (mod as any).get(target, {
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (compatible; AAOS-Gateway/1.0)',
                            'Accept': 'application/rss+xml,application/atom+xml,text/html,application/xhtml+xml,text/plain,*/*'
                        },
                        timeout: 15000
                    }, (res: any) => {
                        // Follow redirects (up to 5)
                        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                            const next = res.headers.location.startsWith('http')
                                ? res.headers.location
                                : new URL(res.headers.location, target).href;
                            return fetch_url(next).then(resolve).catch(reject);
                        }
                        const chunks: Buffer[] = [];
                        res.on('data', (c: Buffer) => chunks.push(c));
                        res.on('end', () => resolve({
                            body: Buffer.concat(chunks).toString('utf8'),
                            status: res.statusCode,
                            contentType: res.headers['content-type'] || ''
                        }));
                    });
                    req.on('error', reject);
                    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
                });

            // ── RSS / Atom parser ──────────────────────────────────────────────
            const parse_feed = (xml: string, feedUrl: string): object | null => {
                const ct = feedUrl.toLowerCase();
                const isRssLike =
                    xml.trimStart().startsWith('<?xml') ||
                    xml.includes('<rss') || xml.includes('<feed') ||
                    xml.includes('<item>') || xml.includes('<entry>');
                if (!isRssLike) return null;

                // Helper: extract first tag value (handles CDATA)
                const tag = (src: string, name: string): string => {
                    const m = src.match(new RegExp(`<${name}(?:[^>]*)>([\\s\\S]*?)<\\/${name}>`, 'i'));
                    if (!m) return '';
                    return m[1]
                        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
                        .replace(/<[^>]+>/g, '')
                        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
                        .trim();
                };
                // Helper: extract attribute value
                const attr = (src: string, tagName: string, attrName: string): string => {
                    const m = src.match(new RegExp(`<${tagName}[^>]+${attrName}="([^"]*)"`, 'i'));
                    return m ? m[1] : '';
                };

                // Feed title
                const feedTitle = tag(xml, 'title');

                // RSS items
                const itemPattern = /<item[\s>]([\s\S]*?)<\/item>/gi;
                // Atom entries
                const entryPattern = /<entry[\s>]([\s\S]*?)<\/entry>/gi;

                const items: object[] = [];
                let m: RegExpExecArray | null;

                const processItem = (block: string, idx: number) => {
                    if (idx >= maxItems) return;
                    const title   = tag(block, 'title');
                    // RSS: <link> is text; Atom: <link href="..."/>
                    const linkText = tag(block, 'link');
                    const linkHref = attr(block, 'link', 'href');
                    const link = linkText || linkHref;
                    const pubDate = tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated');
                    const desc = (tag(block, 'description') || tag(block, 'summary') || tag(block, 'content')).slice(0, 300);
                    const source = tag(block, 'source');
                    items.push({ title, link, published: pubDate, summary: desc || undefined, source: source || undefined });
                };

                let idx = 0;
                while ((m = itemPattern.exec(xml)) !== null)  { processItem(m[1], idx++); }
                if (idx === 0) {
                    while ((m = entryPattern.exec(xml)) !== null) { processItem(m[1], idx++); }
                }

                if (idx === 0) return null; // doesn't look like a parseable feed
                return { ok: true, type: 'feed', feed_title: feedTitle, url: feedUrl, item_count: idx, items };
            };

            try {
                const { body, status, contentType } = await fetch_url(url);

                if (status < 200 || status >= 300) {
                    return { ok: false, error: `HTTP ${status}`, url };
                }

                if (args.raw) {
                    const truncated = body.length > maxChars;
                    return { ok: true, url, status, content_type: contentType, text: body.slice(0, maxChars), truncated, total_chars: body.length };
                }

                // ── Try feed parsing first ─────────────────────────────────────
                const isXml = contentType.includes('xml') || contentType.includes('rss') || contentType.includes('atom');
                if (isXml || body.trimStart().startsWith('<?xml') || body.includes('<rss') || body.includes('<feed')) {
                    const feed = parse_feed(body, url);
                    if (feed) {
                        console.log(`[web_fetch] Parsed RSS/Atom feed from ${url}`);
                        return feed;
                    }
                }

                // ── HTML stripping ─────────────────────────────────────────────
                const isHtml = contentType.includes('text/html');
                let text = body;
                if (isHtml) {
                    text = text
                        .replace(/<script[\s\S]*?<\/script>/gi, '')
                        .replace(/<style[\s\S]*?<\/style>/gi, '')
                        .replace(/<[^>]+>/g, ' ')
                        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
                        .replace(/\s{3,}/g, '\n\n')
                        .trim();
                }

                const truncated = text.length > maxChars;
                return {
                    ok: true,
                    url,
                    status,
                    content_type: contentType,
                    text: text.slice(0, maxChars),
                    truncated,
                    total_chars: text.length
                };
            } catch (err: any) {
                return { ok: false, error: err.message, url };
            }
        }
    );

    // ── Credentials (Windows Credential Manager via keyring) ─────────────────
    //
    // Credentials are stored encrypted in Windows Credential Manager (DPAPI),
    // NOT in any plaintext file.  The Python keyring library handles the OS
    // vault — on Windows it uses the native Windows Credential Manager, on
    // macOS it uses the Keychain, and on Linux the Secret Service.
    //
    // Tools:
    //   credentials_read   — retrieve stored credentials
    //   credentials_save   — store/update credentials (one-time setup per service)
    //   credentials_delete — remove stored credentials

    const CRED_SCRIPT = path.join(
        process.env.AAOS_WORKSPACE || path.join(process.env.USERPROFILE || process.env.HOME || '', '.aaos'),
        'scripts', 'credential_manager.py'
    );

    function run_cred_script(args: string[]): Promise<any> {
        return new Promise((resolve) => {
            child_process.execFile(
                WINDOWS_PYTHON,
                [CRED_SCRIPT, ...args],
                { timeout: 10_000, encoding: 'utf8' },
                (err, stdout, stderr) => {
                    const raw = (stdout || '').trim();
                    if (!raw) {
                        resolve({ error: (stderr || err?.message || 'No output').slice(0, 300) });
                        return;
                    }
                    try { resolve(JSON.parse(raw)); }
                    catch { resolve({ error: `Non-JSON output: ${raw.slice(0, 200)}` }); }
                }
            );
        });
    }

    register_tool(
        {
            name: 'credentials_read',
            description:
                'Retrieve stored login credentials (email, username, password, token, API key, etc.) ' +
                'for a named service from the Windows Credential Manager (encrypted by the OS). ' +
                'ALWAYS call this BEFORE asking the user for any login detail. ' +
                'If not found, call credentials_save to store them, then use them. ' +
                'Never ask the user for a password if credentials_read succeeds.',
            parameters: {
                type: 'object',
                properties: {
                    service: {
                        type: 'string',
                        description: 'Service name (e.g. "gmail", "outlook", "github"). Case-insensitive.'
                    }
                },
                required: ['service']
            }
        },
        async (args: { service: string }) => {
            const result = await run_cred_script(['get', '--service', args.service]);
            if (result.found) {
                const keys = Object.keys(result).filter(k => k !== 'found' && k !== 'service');
                console.log(`[credentials] Loaded ${keys.join(', ')} for "${args.service}" from Credential Manager`);
                // Mask sensitive fields — the LLM must NEVER see raw passwords.
                // Use web_login(service=...) to authenticate; credentials_read only confirms existence.
                const SENSITIVE = new Set(['password', 'passwd', 'secret', 'token', 'api_key', 'apikey', 'key', 'pin', 'otp']);
                const masked: Record<string, any> = { found: true, service: result.service };
                for (const k of keys) {
                    masked[k] = SENSITIVE.has(k.toLowerCase()) ? '***' : result[k];
                }
                masked._note = 'Sensitive fields masked. Call web_login(service="' + args.service + '") to authenticate automatically.';
                return masked;
            }
            return result;
        }
    );

    register_tool(
        {
            name: 'credentials_save',
            description:
                'Store or update login credentials for a service in Windows Credential Manager (encrypted). ' +
                'Use when the user provides credentials for the first time, or when updating after a password change. ' +
                'After saving, use credentials_read to confirm they were stored correctly. ' +
                'The credentials are encrypted by Windows — never stored in any plaintext file.',
            parameters: {
                type: 'object',
                properties: {
                    service: {
                        type: 'string',
                        description: 'Service name (e.g. "gmail", "outlook365", "github"). Case-insensitive.'
                    },
                    fields: {
                        type: 'object',
                        description: 'Key-value pairs to store (e.g. {"email": "user@gmail.com", "password": "secret"}). ' +
                                     'Use field names: email, username, password, token, url, or any custom name.'
                    }
                },
                required: ['service', 'fields']
            }
        },
        async (args: { service: string; fields: Record<string, string> }) => {
            const fieldsJson = JSON.stringify(args.fields);
            const result = await run_cred_script(['set', '--service', args.service, '--fields', fieldsJson]);
            if (result.ok) {
                console.log(`[credentials] Saved ${result.stored_fields?.join(', ')} for "${args.service}" to Credential Manager`);
            }
            return result;
        }
    );

    register_tool(
        {
            name: 'credentials_delete',
            description: 'Remove stored credentials for a service from Windows Credential Manager.',
            parameters: {
                type: 'object',
                properties: {
                    service: { type: 'string', description: 'Service name to delete.' }
                },
                required: ['service']
            }
        },
        async (args: { service: string }) => run_cred_script(['delete', '--service', args.service])
    );

    // ── Shell execution ───────────────────────────────────────────────────────

    register_tool(
        {
            name: 'bash_exec',
            description: 'Execute a shell command and return its stdout. Use for system queries and CLI tools declared in an active skill. ' +
                'NEVER use bash_exec+curl to fetch URLs — always use web_fetch instead. Avoid destructive commands.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'The shell command to run' }
                },
                required: ['command']
            }
        },
        async (args: { command: string }) => {
            try {
                // On Windows: use bash for Unix-style commands, but fall back to cmd.exe
                // when the command starts with a Windows absolute path (e.g. C:\Python\python.exe ...)
                // because bash cannot execute Windows paths with backslashes.
                let shell: string;
                if (process.platform === 'win32') {
                    const trimCmd = args.command.trimStart();
                    const isWindowsPath = /^[a-zA-Z]:[/\\]/.test(trimCmd);
                    // Windows paths (C:\...) need cmd.exe; Unix-style commands use Git Bash
                    shell = isWindowsPath ? 'cmd.exe' : 'bash';
                } else {
                    shell = '/bin/sh';
                }
                const stdout = child_process.execSync(args.command, {
                    shell,
                    timeout: EXEC_TIMEOUT_MS,
                    encoding: 'utf8' as const,
                }).toString();
                const trimmed = stdout.slice(0, MAX_OUTPUT_CHARS);
                return { output: trimmed, truncated: stdout.length > MAX_OUTPUT_CHARS };
            } catch (err: any) {
                // Include stderr in the error so the LLM can diagnose the actual failure
                const msg = (err.stderr?.toString() || err.message || 'Command failed').slice(0, 1000);
                return { error: msg };
            }
        }
    );
}
