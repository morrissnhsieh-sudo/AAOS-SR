/**
 * Scheduler Store — persists scheduled jobs to ~/.aaos-sr/schedules.json
 *
 * Job lifecycle:
 *   created → enabled → (running per cron tick) → paused | deleted
 */
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ScheduledJob {
    name:        string;   // unique slug, e.g. "daily-inventory-check"
    cron:        string;   // standard 5-field cron, e.g. "0 8 * * *"
    message:     string;   // agent instruction sent on each tick
    session_id:  string;   // session to run under, e.g. "scheduler:daily-inventory"
    enabled:     boolean;
    notify:      boolean;  // if true, broadcast result to all active WebSocket clients
    created_at:  string;   // ISO timestamp
    updated_at:  string;
    last_run_at: string | null;
    last_status: 'ok' | 'error' | 'never';
    last_result: string | null;  // first 500 chars of last agent response / error
    run_count:   number;
    tags:        string[];  // optional labels e.g. ["retail", "inventory"]
}

export type JobUpdate = Partial<Omit<ScheduledJob, 'name' | 'created_at'>>;

// ── Storage path ───────────────────────────────────────────────────────────────

function store_path(): string {
    const workspace = process.env.AAOS_WORKSPACE ||
        path.join(os.homedir(), '.aaos-sr');
    return path.join(workspace, 'schedules.json');
}

// ── Read / write ───────────────────────────────────────────────────────────────

export function load_jobs(): ScheduledJob[] {
    try {
        const raw = fs.readFileSync(store_path(), 'utf8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

function save_jobs(jobs: ScheduledJob[]): void {
    const p = store_path();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(jobs, null, 2), 'utf8');
}

// ── CRUD ───────────────────────────────────────────────────────────────────────

export function get_job(name: string): ScheduledJob | null {
    return load_jobs().find(j => j.name === name) ?? null;
}

export function upsert_job(job: ScheduledJob): void {
    const jobs = load_jobs();
    const idx  = jobs.findIndex(j => j.name === job.name);
    if (idx >= 0) jobs[idx] = job;
    else           jobs.push(job);
    save_jobs(jobs);
}

export function update_job(name: string, patch: JobUpdate): ScheduledJob | null {
    const jobs = load_jobs();
    const idx  = jobs.findIndex(j => j.name === name);
    if (idx < 0) return null;
    jobs[idx] = { ...jobs[idx], ...patch, updated_at: new Date().toISOString() };
    save_jobs(jobs);
    return jobs[idx];
}

export function delete_job(name: string): boolean {
    const jobs = load_jobs();
    const next = jobs.filter(j => j.name !== name);
    if (next.length === jobs.length) return false;
    save_jobs(next);
    return true;
}

export function make_job(
    name: string,
    cron: string,
    message: string,
    opts: { session_id?: string; tags?: string[]; notify?: boolean } = {}
): ScheduledJob {
    const now = new Date().toISOString();
    return {
        name,
        cron,
        message,
        session_id:  opts.session_id ?? `scheduler:${name}`,
        enabled:     true,
        notify:      opts.notify ?? false,
        created_at:  now,
        updated_at:  now,
        last_run_at: null,
        last_status: 'never',
        last_result: null,
        run_count:   0,
        tags:        opts.tags ?? [],
    };
}
