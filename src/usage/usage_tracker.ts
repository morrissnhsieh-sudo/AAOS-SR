/**
 * AAOS Usage Tracker — records token consumption and cost per LLM call.
 * Data is appended as JSONL to ~/.aaos/usage/usage.jsonl
 */
import * as fs from 'fs';
import * as path from 'path';

// ── Pricing table (USD per 1M tokens) ─────────────────────────────────────────
// Update these when provider pricing changes.
const PRICING: Record<string, { input: number; output: number }> = {
    // Google Vertex AI — Gemini
    'google/gemini-2.0-flash':         { input: 0.075,  output: 0.30  },
    'google/gemini-2.0-flash-lite':    { input: 0.0375, output: 0.15  },
    'google/gemini-1.5-flash':         { input: 0.075,  output: 0.30  },
    'google/gemini-1.5-pro':           { input: 1.25,   output: 5.00  },
    // Anthropic direct API
    'anthropic/claude-haiku-4-5':      { input: 0.80,   output: 4.00  },
    'anthropic/claude-sonnet-4-6':     { input: 3.00,   output: 15.00 },
    // Anthropic on Vertex AI
    'anthropic-vertex/claude-haiku-4-5':  { input: 0.80,  output: 4.00  },
    'anthropic-vertex/claude-sonnet-4-5': { input: 3.00,  output: 15.00 },
};

/** Fallback pricing for unknown models — conservative estimate */
const FALLBACK_PRICING = { input: 0.30, output: 1.20 };

export interface UsageRecord {
    timestamp: string;        // ISO-8601
    role: string;             // chatbot | skill_builder | wiki_compiler | memory_extractor
    provider: string;         // google | anthropic | anthropic-vertex
    model: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cost_usd: number;
    activity?: string;        // optional human-readable label (e.g. first 60 chars of user message)
    thinking_tokens?: number; // native model thinking/reasoning tokens (Claude 3.7 / Gemini 2.5)
}

export interface UsageSummary {
    total_cost_usd: number;
    total_input_tokens: number;
    total_output_tokens: number;
    total_tokens: number;
    total_thinking_tokens: number;
    call_count: number;
    by_role: Record<string, { cost_usd: number; total_tokens: number; call_count: number }>;
    by_model: Record<string, { cost_usd: number; total_tokens: number; call_count: number }>;
    timeline: Array<{ bucket: string; cost_usd: number; total_tokens: number; call_count: number }>;
}

// ── Path helpers ───────────────────────────────────────────────────────────────

function get_usage_dir(): string {
    const workspace = process.env.AAOS_WORKSPACE ||
        path.join(process.env.HOME || process.env.USERPROFILE || '', '.aaos');
    return path.join(workspace, 'usage');
}

function get_usage_file(): string {
    return path.join(get_usage_dir(), 'usage.jsonl');
}

// ── Cost calculation ───────────────────────────────────────────────────────────

export function calculate_cost(provider: string, model: string, inputTokens: number, outputTokens: number): number {
    const key = `${provider}/${model}`;
    const pricing = PRICING[key] ?? FALLBACK_PRICING;
    return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

export function get_model_pricing(provider: string, model: string): { input: number; output: number } {
    return PRICING[`${provider}/${model}`] ?? FALLBACK_PRICING;
}

// ── Write ──────────────────────────────────────────────────────────────────────

export function log_usage(record: UsageRecord): void {
    try {
        const dir = get_usage_dir();
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(get_usage_file(), JSON.stringify(record) + '\n', 'utf8');
    } catch (e: any) {
        console.warn(`[Usage] Failed to log usage: ${e.message}`);
    }
}

// ── Read ───────────────────────────────────────────────────────────────────────

export function load_usage(fromMs?: number, toMs?: number): UsageRecord[] {
    try {
        const raw = fs.readFileSync(get_usage_file(), 'utf8');
        const records: UsageRecord[] = raw
            .split('\n')
            .filter(l => l.trim())
            .map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(Boolean) as UsageRecord[];

        if (!fromMs && !toMs) return records;
        return records.filter(r => {
            const t = new Date(r.timestamp).getTime();
            if (fromMs && t < fromMs) return false;
            if (toMs   && t > toMs  ) return false;
            return true;
        });
    } catch {
        return [];
    }
}

// ── Aggregate ──────────────────────────────────────────────────────────────────

export function summarise_usage(records: UsageRecord[], bucketMs: number = 3600_000): UsageSummary {
    const summary: UsageSummary = {
        total_cost_usd: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_tokens: 0,
        total_thinking_tokens: 0,
        call_count: records.length,
        by_role: {},
        by_model: {},
        timeline: [],
    };

    const timelineBuckets = new Map<string, { cost_usd: number; total_tokens: number; call_count: number }>();

    for (const r of records) {
        summary.total_cost_usd        += r.cost_usd;
        summary.total_input_tokens    += r.input_tokens;
        summary.total_output_tokens   += r.output_tokens;
        summary.total_tokens          += r.total_tokens;
        summary.total_thinking_tokens += r.thinking_tokens ?? 0;

        // By role
        if (!summary.by_role[r.role]) summary.by_role[r.role] = { cost_usd: 0, total_tokens: 0, call_count: 0 };
        summary.by_role[r.role].cost_usd     += r.cost_usd;
        summary.by_role[r.role].total_tokens += r.total_tokens;
        summary.by_role[r.role].call_count   += 1;

        // By model (provider/model)
        const modelKey = `${r.provider}/${r.model}`;
        if (!summary.by_model[modelKey]) summary.by_model[modelKey] = { cost_usd: 0, total_tokens: 0, call_count: 0 };
        summary.by_model[modelKey].cost_usd     += r.cost_usd;
        summary.by_model[modelKey].total_tokens += r.total_tokens;
        summary.by_model[modelKey].call_count   += 1;

        // Timeline buckets
        const ts = new Date(r.timestamp).getTime();
        const bucketStart = Math.floor(ts / bucketMs) * bucketMs;
        const bucketLabel = new Date(bucketStart).toISOString();
        if (!timelineBuckets.has(bucketLabel)) {
            timelineBuckets.set(bucketLabel, { cost_usd: 0, total_tokens: 0, call_count: 0 });
        }
        const bucket = timelineBuckets.get(bucketLabel)!;
        bucket.cost_usd     += r.cost_usd;
        bucket.total_tokens += r.total_tokens;
        bucket.call_count   += 1;
    }

    // Sort timeline chronologically
    summary.timeline = [...timelineBuckets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([bucket, data]) => ({ bucket, ...data }));

    // Round totals
    summary.total_cost_usd = Math.round(summary.total_cost_usd * 1_000_000) / 1_000_000;
    for (const v of Object.values(summary.by_role))  v.cost_usd = Math.round(v.cost_usd * 1_000_000) / 1_000_000;
    for (const v of Object.values(summary.by_model)) v.cost_usd = Math.round(v.cost_usd * 1_000_000) / 1_000_000;
    for (const t of summary.timeline)                t.cost_usd = Math.round(t.cost_usd * 1_000_000) / 1_000_000;

    return summary;
}

export function get_pricing_table(): Record<string, { input: number; output: number }> {
    return { ...PRICING };
}
