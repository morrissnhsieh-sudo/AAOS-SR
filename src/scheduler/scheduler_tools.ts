/**
 * Scheduler Tools — agent-facing tools for managing scheduled jobs.
 *
 * Registers 6 tools:
 *   schedule_create   — create or replace a scheduled job
 *   schedule_list     — list all jobs with status
 *   schedule_delete   — permanently remove a job
 *   schedule_pause    — disable without deleting
 *   schedule_resume   — re-enable a paused job
 *   schedule_run_now  — trigger a job immediately
 */
import * as cron        from 'node-cron';
import { register_tool }                              from '../tools/tool_dispatcher';
import { make_job, load_jobs, get_job, upsert_job,
         update_job, delete_job }                     from './scheduler_store';
import { activate_job, deactivate_job, is_job_active,
         run_job_now, list_active_jobs }              from './scheduler_engine';
import { detect_os_environment }                      from './os_env';

// ── Cron expression helper ────────────────────────────────────────────────────

/** Convert natural-language shorthand to a cron expression. */
function resolve_cron(expr: string): string {
    const e = expr.trim().toLowerCase();
    // Pass-through if it already looks like a cron expression (5 fields)
    if (/^[\d/*,\-]+ [\d/*,\-]+ [\d/*,\-]+ [\d/*,\-]+ [\d/*,\-]+$/.test(e)) return expr.trim();

    // Natural language shortcuts
    const shortcuts: Record<string, string> = {
        '@hourly':              '0 * * * *',
        '@daily':               '0 0 * * *',
        '@midnight':            '0 0 * * *',
        '@weekly':              '0 0 * * 0',
        '@monthly':             '0 0 1 * *',
        '@yearly':              '0 0 1 1 *',
        '@annually':            '0 0 1 1 *',
        'every minute':         '* * * * *',
        'every hour':           '0 * * * *',
        'every day':            '0 0 * * *',
        'every day at midnight':'0 0 * * *',
        'every week':           '0 0 * * 0',
        'every month':          '0 0 1 * *',
        'every monday':         '0 0 * * 1',
        'every tuesday':        '0 0 * * 2',
        'every wednesday':      '0 0 * * 3',
        'every thursday':       '0 0 * * 4',
        'every friday':         '0 0 * * 5',
        'every saturday':       '0 0 * * 6',
        'every sunday':         '0 0 * * 0',
        'weekdays':             '0 0 * * 1-5',
        'weekends':             '0 0 * * 0,6',
    };
    if (shortcuts[e]) return shortcuts[e];

    // "every N minutes/hours"
    const everyMin = e.match(/^every (\d+) min(utes?)?$/);
    if (everyMin) return `*/${everyMin[1]} * * * *`;
    const everyHr = e.match(/^every (\d+) hours?$/);
    if (everyHr) return `0 */${everyHr[1]} * * *`;

    // "daily at HH:MM"
    const dailyAt = e.match(/^(daily|every day) at (\d{1,2}):(\d{2})(?:\s*(am|pm))?$/);
    if (dailyAt) {
        let h = parseInt(dailyAt[2]);
        const m = parseInt(dailyAt[3]);
        if (dailyAt[4] === 'pm' && h < 12) h += 12;
        if (dailyAt[4] === 'am' && h === 12) h = 0;
        return `${m} ${h} * * *`;
    }

    // "every monday at HH:MM"
    const days: Record<string, number> = {
        sunday:0, monday:1, tuesday:2, wednesday:3, thursday:4, friday:5, saturday:6
    };
    const weeklyAt = e.match(/^every (sunday|monday|tuesday|wednesday|thursday|friday|saturday) at (\d{1,2}):(\d{2})(?:\s*(am|pm))?$/);
    if (weeklyAt) {
        const dow = days[weeklyAt[1]];
        let h = parseInt(weeklyAt[2]);
        const m = parseInt(weeklyAt[3]);
        if (weeklyAt[4] === 'pm' && h < 12) h += 12;
        if (weeklyAt[4] === 'am' && h === 12) h = 0;
        return `${m} ${h} * * ${dow}`;
    }

    // Return as-is and let node-cron validate it
    return expr.trim();
}

/** Next scheduled run time as a human-readable string. */
function next_run_label(cronExpr: string): string {
    try {
        // node-cron doesn't expose next-run natively; compute manually
        const now   = new Date();
        const parts = cronExpr.split(' ');
        if (parts.length !== 5) return 'unknown';
        // Simple approximation: just state the cron expression
        return `(cron: ${cronExpr})`;
    } catch { return 'unknown'; }
}

// ── Tool registration ──────────────────────────────────────────────────────────

export function register_scheduler_tools(): void {

    const env = detect_os_environment();

    // ── schedule_create ───────────────────────────────────────────────────────

    // ── Helper: detect if a job is a user-facing reminder / notification ─────────
    const REMINDER_KEYWORDS = /\b(remind|reminder|alert|notify|notification|drink|eat|take|meeting|deadline|alarm|ping|check in)\b/i;

    register_tool(
        {
            name: 'schedule_create',
            description:
                'Create or replace a scheduled background agent task. ' +
                'The agent will receive "message" on each scheduled tick and run with full tool access. ' +
                'Use cron expressions (e.g. "0 8 * * *") or natural language ' +
                '("every day at 8:00am", "every monday at 9am", "every 30 minutes", "@hourly"). ' +
                'Set notify=true for reminders/alerts so the result is pushed back to the user chat. ' +
                'IMPORTANT: After calling this tool you MUST call schedule_run_now with the same name to verify the job works, ' +
                'then show the test result to the user. ' +
                'NEVER use a "reminder_scheduler" tool — it does not exist. Use schedule_create directly.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'Unique job name — lowercase, hyphens only (e.g. "daily-inventory-check")'
                    },
                    cron: {
                        type: 'string',
                        description: 'Schedule: cron expression OR natural language (e.g. "every day at 8:00am", "every 30 minutes", "every monday at 9am", "@hourly")'
                    },
                    message: {
                        type: 'string',
                        description: 'The instruction the agent receives each time this job runs'
                    },
                    notify: {
                        type: 'boolean',
                        description: 'If true, the job result is pushed to the user chat as a notification when the job fires. Set to true for reminders, alerts, and any job the user should see. Auto-set to true when the job involves reminding/alerting the user.'
                    },
                    session_id: {
                        type: 'string',
                        description: 'Session ID for job runs (default: "scheduler:<name>"). Use same ID to group related jobs.'
                    },
                    tags: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional labels for grouping (e.g. ["retail", "inventory"])'
                    },
                    run_now: {
                        type: 'boolean',
                        description: 'If true, also run the job immediately after creating it for verification (default: false). RECOMMENDED: always set true to confirm the job works.'
                    }
                },
                required: ['name', 'cron', 'message']
            }
        },
        async (args: { name: string; cron: string; message: string; notify?: boolean; session_id?: string; tags?: string[]; run_now?: boolean }) => {
            try {
                // Sanitise name
                const name = args.name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
                if (!name) return { ok: false, error: 'Job name must contain at least one alphanumeric character.' };

                // Resolve and validate cron
                const cronExpr = resolve_cron(args.cron);
                if (!cron.validate(cronExpr)) {
                    return { ok: false, error: `Invalid schedule: "${args.cron}" (resolved to "${cronExpr}"). Use a valid cron expression or natural language like "every day at 8am".` };
                }

                // Auto-detect notify: true when the job or message looks like a reminder/alert
                const autoNotify = REMINDER_KEYWORDS.test(name) || REMINDER_KEYWORDS.test(args.message);
                const notify = args.notify ?? autoNotify;

                // Deactivate existing if present
                deactivate_job(name);

                // Create and persist
                const job = make_job(name, cronExpr, args.message, {
                    session_id: args.session_id,
                    tags:       args.tags,
                    notify,
                });
                upsert_job(job);

                // Activate in cron engine
                const activation = activate_job(job);
                if (!activation.ok) {
                    delete_job(name);
                    return { ok: false, error: activation.error };
                }

                let test_result: string | null = null;
                if (args.run_now) {
                    console.log(`[Scheduler] Running "${name}" immediately as requested`);
                    test_result = (await run_job_now(job)).slice(0, 500);
                }

                return {
                    ok: true,
                    name,
                    cron: cronExpr,
                    schedule_input: args.cron,
                    message: args.message,
                    notify,
                    session_id: job.session_id,
                    status: 'active',
                    next_run: next_run_label(cronExpr),
                    os: env.platform,
                    test_result,
                    verification_required: !args.run_now
                        ? 'IMPORTANT: Call schedule_run_now(name="' + name + '") NOW to verify this job works, then show the result to the user.'
                        : null,
                };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    // ── schedule_list ─────────────────────────────────────────────────────────

    register_tool(
        {
            name: 'schedule_list',
            description:
                'List all scheduled agent jobs with their status, cron schedule, last run result, ' +
                'and whether they are currently active. Use to check what background tasks are running.',
            parameters: {
                type: 'object',
                properties: {
                    tag: { type: 'string', description: 'Filter by tag (e.g. "retail")' },
                    status: { type: 'string', enum: ['all', 'active', 'paused'], description: 'Filter by status (default: all)' }
                },
                required: []
            }
        },
        async (args: { tag?: string; status?: string }) => {
            try {
                let jobs = load_jobs();
                if (args.tag)    jobs = jobs.filter(j => j.tags?.includes(args.tag!));
                if (args.status === 'active') jobs = jobs.filter(j => j.enabled && is_job_active(j.name));
                if (args.status === 'paused') jobs = jobs.filter(j => !j.enabled || !is_job_active(j.name));

                const summary = jobs.map(j => ({
                    name:        j.name,
                    cron:        j.cron,
                    status:      is_job_active(j.name) ? 'active' : 'paused',
                    enabled:     j.enabled,
                    message:     j.message.slice(0, 80) + (j.message.length > 80 ? '…' : ''),
                    session_id:  j.session_id,
                    tags:        j.tags,
                    run_count:   j.run_count,
                    last_run_at: j.last_run_at,
                    last_status: j.last_status,
                    last_result: j.last_result?.slice(0, 150),
                }));

                return {
                    ok: true,
                    total: jobs.length,
                    active_count: list_active_jobs().length,
                    os: env.platform,
                    jobs: summary,
                };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    // ── schedule_delete ───────────────────────────────────────────────────────

    register_tool(
        {
            name: 'schedule_delete',
            description: 'Permanently delete a scheduled job. The job will stop running and be removed from storage.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Job name to delete' }
                },
                required: ['name']
            }
        },
        async (args: { name: string }) => {
            try {
                deactivate_job(args.name);
                const deleted = delete_job(args.name);
                if (!deleted) return { ok: false, error: `Job "${args.name}" not found.` };
                return { ok: true, name: args.name, message: `Job "${args.name}" deleted and stopped.` };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    // ── schedule_pause ────────────────────────────────────────────────────────

    register_tool(
        {
            name: 'schedule_pause',
            description: 'Pause a scheduled job without deleting it. The job keeps its settings and can be resumed later.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Job name to pause' }
                },
                required: ['name']
            }
        },
        async (args: { name: string }) => {
            try {
                const job = get_job(args.name);
                if (!job) return { ok: false, error: `Job "${args.name}" not found.` };
                deactivate_job(args.name);
                update_job(args.name, { enabled: false });
                return { ok: true, name: args.name, message: `Job "${args.name}" paused. Use schedule_resume to re-enable.` };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    // ── schedule_resume ───────────────────────────────────────────────────────

    register_tool(
        {
            name: 'schedule_resume',
            description: 'Resume a previously paused scheduled job.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Job name to resume' }
                },
                required: ['name']
            }
        },
        async (args: { name: string }) => {
            try {
                const job = get_job(args.name);
                if (!job) return { ok: false, error: `Job "${args.name}" not found.` };
                const updated = update_job(args.name, { enabled: true })!;
                const result  = activate_job(updated);
                if (!result.ok) return { ok: false, error: result.error };
                return { ok: true, name: args.name, status: 'active', cron: job.cron, message: `Job "${args.name}" resumed.` };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    // ── schedule_run_now ──────────────────────────────────────────────────────

    register_tool(
        {
            name: 'schedule_run_now',
            description:
                'Trigger a scheduled job to run immediately, outside its normal schedule. ' +
                'Use to test a new job or force an early run. Returns the agent\'s response.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Job name to run now' }
                },
                required: ['name']
            }
        },
        async (args: { name: string }) => {
            try {
                const job = get_job(args.name);
                if (!job) return { ok: false, error: `Job "${args.name}" not found.` };

                console.log(`[Scheduler] Manual trigger: "${args.name}"`);
                const result = await run_job_now(job);
                const status = result.startsWith('ERROR:') ? 'error' : 'ok';

                update_job(args.name, {
                    last_run_at: new Date().toISOString(),
                    last_status: status,
                    last_result: result.slice(0, 500),
                    run_count:   (job.run_count || 0) + 1,
                });

                return {
                    ok:     status === 'ok',
                    name:   args.name,
                    status,
                    result: result.slice(0, 1000),
                };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    console.log('[Scheduler] Tools registered: schedule_create, schedule_list, schedule_delete, schedule_pause, schedule_resume, schedule_run_now');
}
