/**
 * Scheduler Engine — node-cron based job runner
 *
 * Loads persisted jobs from ~/.aaos/schedules.json at startup,
 * runs each job's message through the AAOS agent on schedule,
 * and records results back to the store.
 *
 * Fully cross-platform: uses os_env.ts for OS-specific execution context.
 */
import * as cron from 'node-cron';
import { load_jobs, update_job, ScheduledJob } from './scheduler_store';
import { detect_os_environment }               from './os_env';

// ── Types ──────────────────────────────────────────────────────────────────────

interface RunningTask {
    job:  ScheduledJob;
    task: cron.ScheduledTask;
}

// ── State ──────────────────────────────────────────────────────────────────────

const _running = new Map<string, RunningTask>();
let   _started = false;

// ── Engine lifecycle ───────────────────────────────────────────────────────────

/**
 * Start the scheduler engine.
 * Called once at AAOS server startup (from index.ts).
 * Loads all enabled jobs from disk and activates their cron tasks.
 */
export function start_scheduler_engine(): void {
    if (_started) return;
    _started = true;

    const env  = detect_os_environment();
    const jobs = load_jobs();
    let   n    = 0;

    for (const job of jobs) {
        if (job.enabled) {
            _activate(job);
            n++;
        }
    }

    console.log(`[Scheduler] Engine started on ${env.description}`);
    console.log(`[Scheduler] ${n} job(s) activated from persistent store`);
}

/** Stop all running cron tasks (called on server shutdown). */
export function stop_scheduler_engine(): void {
    for (const { task } of _running.values()) task.stop();
    _running.clear();
    _started = false;
    console.log('[Scheduler] Engine stopped');
}

// ── Job management ─────────────────────────────────────────────────────────────

/** Activate a job: validate its cron expression and start the task. */
export function activate_job(job: ScheduledJob): { ok: boolean; error?: string } {
    if (!cron.validate(job.cron)) {
        return { ok: false, error: `Invalid cron expression: "${job.cron}"` };
    }
    _activate(job);
    return { ok: true };
}

/** Deactivate (pause) a running job without deleting it. */
export function deactivate_job(name: string): boolean {
    const entry = _running.get(name);
    if (!entry) return false;
    entry.task.stop();
    _running.delete(name);
    return true;
}

/** Returns true if the job is currently active in the cron runner. */
export function is_job_active(name: string): boolean {
    return _running.has(name);
}

/** List all currently active job names. */
export function list_active_jobs(): string[] {
    return [..._running.keys()];
}

/**
 * Trigger a job to run immediately (outside its normal schedule).
 * Used for "run now" / test commands.
 */
export async function run_job_now(job: ScheduledJob): Promise<string> {
    return _execute_job(job);
}

// ── Internal ───────────────────────────────────────────────────────────────────

function _activate(job: ScheduledJob): void {
    // Stop any existing instance first (handles re-activation after update)
    if (_running.has(job.name)) {
        _running.get(job.name)!.task.stop();
        _running.delete(job.name);
    }

    if (!cron.validate(job.cron)) {
        console.warn(`[Scheduler] Skipping job "${job.name}" — invalid cron: "${job.cron}"`);
        return;
    }

    const task = cron.schedule(job.cron, async () => {
        console.log(`[Scheduler] Firing job "${job.name}" (cron: ${job.cron})`);
        const result = await _execute_job(job);
        // Reload latest job definition from disk (may have been updated)
        update_job(job.name, {
            last_run_at: new Date().toISOString(),
            last_status: result.startsWith('ERROR:') ? 'error' : 'ok',
            last_result: result.slice(0, 500),
            run_count:   (job.run_count || 0) + 1,
        });
    }, {
        timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    });

    _running.set(job.name, { job, task });
    console.log(`[Scheduler] Activated: "${job.name}" → ${job.cron}`);
}

async function _execute_job(job: ScheduledJob): Promise<string> {
    try {
        // Dynamically import to avoid circular dependency at module load time
        const { get_or_create_session, broadcast_to_all_ws } = await import('../channel/channel_manager');
        const { start_agent_run }                            = await import('../agent/agent_runner');
        const { v4: uuidv4 }                                 = await import('uuid');

        // job.session_id is already fully-qualified (e.g. "scheduler:test-ping").
        // Split into channel + userId so get_or_create_session doesn't double-prefix it.
        const colonIdx  = job.session_id.indexOf(':');
        const channelPart = colonIdx >= 0 ? job.session_id.slice(0, colonIdx) : 'scheduler';
        const userPart    = colonIdx >= 0 ? job.session_id.slice(colonIdx + 1) : job.session_id;
        const session = get_or_create_session(channelPart, userPart);
        const msg = {
            id:         uuidv4(),
            session_id: session.id,
            role:       'user' as const,
            content:    job.message,
            created_at: new Date(),
            token_count: 0,
        };

        const result   = await start_agent_run(session, msg);
        const response = result.finalResponse ?? '(no response)';
        console.log(`[Scheduler] Job "${job.name}" completed — ${response.length} chars`);

        // ── Push notification to all active WebSocket clients ──────────────────
        if (job.notify) {
            const notification = `🔔 **Reminder — ${job.name}**\n\n${response}`;
            broadcast_to_all_ws(notification);
            console.log(`[Scheduler] Notification broadcast for "${job.name}"`);
        }

        return response;
    } catch (err: any) {
        const errMsg = `ERROR: ${err.message}`;
        console.error(`[Scheduler] Job "${job.name}" failed: ${err.message}`);
        return errMsg;
    }
}
