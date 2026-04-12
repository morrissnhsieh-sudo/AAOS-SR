/**
 * OS Environment Detection
 *
 * Detects the host OS and selects the correct shell, Python executable,
 * and execution environment for scheduled agent tasks and tool execution.
 *
 * Supports: Windows (win32), macOS (darwin), Linux (linux)
 */
import * as fs             from 'fs';
import * as path           from 'path';
import * as os             from 'os';
import { execSync }        from 'child_process';

// ── Types ──────────────────────────────────────────────────────────────────────

export type OsPlatform = 'windows' | 'macos' | 'linux';

export interface OsEnvironment {
    platform:       OsPlatform;
    shell:          string;       // e.g. "bash", "cmd.exe", "/bin/zsh"
    shell_flag:     string;       // e.g. "-c" or "/c"
    python:         string;       // resolved Python executable
    python_version: string | null;
    home_dir:       string;
    path_sep:       string;       // "\" on Windows, "/" elsewhere
    line_ending:    '\r\n' | '\n';
    has_bash:       boolean;
    has_powershell: boolean;
    description:    string;       // human-readable summary
}

// ── Detection ─────────────────────────────────────────────────────────────────

let _cached: OsEnvironment | null = null;

export function detect_os_environment(): OsEnvironment {
    if (_cached) return _cached;

    const plat = process.platform;
    const platform: OsPlatform =
        plat === 'win32'  ? 'windows' :
        plat === 'darwin' ? 'macos'   : 'linux';

    const home_dir  = os.homedir();
    const path_sep  = path.sep;

    // ── Shell detection ────────────────────────────────────────────────────────
    let shell      = '';
    let shell_flag = '-c';
    let has_bash   = false;
    let has_powershell = false;

    if (platform === 'windows') {
        // Prefer bash (Git Bash / WSL) for Unix-compatible commands
        has_bash = _cmd_exists('bash --version');
        // PowerShell Core (pwsh) or Windows PowerShell
        has_powershell = _cmd_exists('powershell -Command "exit 0"');
        shell      = has_bash ? 'bash' : 'cmd.exe';
        shell_flag = has_bash ? '-c'   : '/c';
    } else if (platform === 'macos') {
        // macOS: zsh is default since Catalina, bash as fallback
        const zsh_path = '/bin/zsh';
        shell      = fs.existsSync(zsh_path) ? zsh_path : '/bin/bash';
        shell_flag = '-c';
        has_bash   = fs.existsSync('/bin/bash') || _cmd_exists('bash --version');
        has_powershell = _cmd_exists('pwsh --version');
    } else {
        // Linux: bash is standard
        shell      = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
        shell_flag = '-c';
        has_bash   = true;
        has_powershell = _cmd_exists('pwsh --version');
    }

    // ── Python detection ───────────────────────────────────────────────────────
    const python = _find_python(platform);
    const python_version = _get_python_version(python);

    // ── Result ─────────────────────────────────────────────────────────────────
    const env: OsEnvironment = {
        platform,
        shell,
        shell_flag,
        python,
        python_version,
        home_dir,
        path_sep,
        line_ending: platform === 'windows' ? '\r\n' : '\n',
        has_bash,
        has_powershell,
        description: _describe(platform, shell, python, python_version),
    };

    _cached = env;
    console.log(`[OS] Detected: ${env.description}`);
    return env;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _cmd_exists(cmd: string): boolean {
    try {
        execSync(cmd, { stdio: 'pipe', timeout: 3000 });
        return true;
    } catch { return false; }
}

function _find_python(platform: OsPlatform): string {
    if (platform === 'windows') {
        // Try `where python` via cmd.exe first — most reliable on Windows
        try {
            const result = execSync('where python', {
                shell: 'cmd.exe' as any,
                timeout: 3000,
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
            } as any) as string;
            const lines = result.trim().split(/\r?\n/)
                .map(l => l.trim())
                .filter(l => l.toLowerCase().endsWith('.exe') && !l.includes('WindowsApps'));
            if (lines.length > 0) return lines[0];
        } catch { /* fall through */ }
        // Hardcoded fallbacks
        for (const p of [
            'C:\\Python314\\python.exe', 'C:\\Python313\\python.exe',
            'C:\\Python312\\python.exe', 'C:\\Python311\\python.exe',
            'C:\\Python310\\python.exe',
        ]) {
            if (fs.existsSync(p)) return p;
        }
        return 'python';
    }

    if (platform === 'macos') {
        // Prefer Homebrew python3, then system
        for (const p of [
            '/opt/homebrew/bin/python3',  // Apple Silicon
            '/usr/local/bin/python3',     // Intel Mac
            '/usr/bin/python3',
        ]) {
            if (fs.existsSync(p)) return p;
        }
        return 'python3';
    }

    // Linux
    for (const p of ['/usr/bin/python3', '/usr/local/bin/python3', '/usr/bin/python']) {
        if (fs.existsSync(p)) return p;
    }
    return 'python3';
}

function _get_python_version(python: string): string | null {
    try {
        const v = execSync(`"${python}" --version`, {
            timeout: 5000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        } as any) as string;
        return (v as string).trim().replace('Python ', '');
    } catch { return null; }
}

function _describe(
    platform: OsPlatform,
    shell: string,
    python: string,
    pyver: string | null
): string {
    const os_name =
        platform === 'windows' ? `Windows ${os.release()}` :
        platform === 'macos'   ? `macOS ${os.release()}`   :
                                 `Linux ${os.release()}`;
    const py = pyver ? `Python ${pyver}` : 'Python (not found)';
    return `${os_name} | shell=${path.basename(shell)} | ${py}`;
}

// ── Utility: build a shell command appropriate for this OS ────────────────────

/**
 * Wrap a command string in the correct shell invocation for this OS.
 * Returns { shell, args } suitable for child_process.spawn/execFile.
 */
export function build_shell_command(cmd: string): { shell: string; args: string[] } {
    const env = detect_os_environment();
    return {
        shell: env.shell,
        args:  [env.shell_flag, cmd],
    };
}

/**
 * Resolve a user-supplied path (may be WSL /mnt/c/..., Git Bash /c/...,
 * ~ home, or native) to an absolute native path on this OS.
 */
export function resolve_native_path(inputPath: string): string {
    const env = detect_os_environment();
    let p = inputPath.trim();

    // Expand ~
    if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
        p = path.join(env.home_dir, p.slice(1));
    }

    if (env.platform === 'windows') {
        // WSL /mnt/<drive>/...
        const wsl = p.match(/^\/mnt\/([a-zA-Z])(\/.*)?$/);
        if (wsl) return `${wsl[1].toUpperCase()}:${(wsl[2] || '/').replace(/\//g, '\\')}`;
        // Git Bash /<drive>/...
        const gb = p.match(/^\/([a-zA-Z])(\/.*)?$/);
        if (gb)  return `${gb[1].toUpperCase()}:${(gb[2] || '/').replace(/\//g, '\\')}`;
        // Already Windows: C:/... → C:\...
        if (/^[a-zA-Z]:\//.test(p)) return p.replace(/\//g, '\\');
    }

    return p;
}

/** Temp directory appropriate for this OS */
export function get_temp_dir(): string {
    return os.tmpdir();
}
