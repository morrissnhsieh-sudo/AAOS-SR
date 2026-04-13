import { Plugin } from '../plugins/plugin_engine';

export interface AgentRunResult { finalResponse: string; }
export interface AgentStage { name: string; fn: (input: StageInput) => Promise<StageOutput>; }
export interface StageInput { data: any; }
export interface StageOutput { data: any; }

export const ACP_MAX_RETRIES = 3;
export const ACP_MAX_PIPELINE_STAGES = 10;
export const ACP_MAX_AGENT_ITERATIONS = 12;

/**
 * HTTP status codes that are NEVER worth retrying:
 *   400 Bad Request      — the request is malformed; retrying won't fix it
 *   401 Unauthorized     — wrong / missing API key
 *   403 Forbidden        — permission denied (IAM / quota / wrong project)
 *   404 Not Found        — model or endpoint doesn't exist
 *   422 Unprocessable    — bad parameters
 */
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 422]);

/**
 * 429 Rate-limit — worth retrying but needs a much longer delay.
 * Short backoff (500ms) is useless against a per-minute quota; use 15s → 30s instead.
 */
const RATE_LIMIT_BASE_MS = 15_000;

function is_non_retryable(e: unknown): boolean {
    if (e && typeof e === 'object') {
        const status = (e as any).status ?? (e as any).statusCode ?? (e as any).code;
        if (typeof status === 'number' && NON_RETRYABLE_STATUS.has(status)) return true;
        const msg = String((e as any).message || '');
        if (msg.includes('"code":403') || msg.includes('"code":401') ||
            msg.includes('"code":400') || msg.includes('"code":404') ||
            msg.includes('PERMISSION_DENIED') || msg.includes('UNAUTHENTICATED')) return true;
    }
    return false;
}

function is_rate_limit(e: unknown): boolean {
    if (e && typeof e === 'object') {
        const status = (e as any).status ?? (e as any).statusCode ?? (e as any).code;
        if (status === 429) return true;
        const msg = String((e as any).message || '');
        if (msg.includes('"code":429') || msg.includes('RESOURCE_EXHAUSTED') ||
            msg.includes('Resource exhausted') || msg.includes('rate limit')) return true;
    }
    return false;
}

export async function execute_with_acp_retry(fn: () => Promise<any>, maxRetries: number): Promise<any> {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            return await fn();
        } catch (e) {
            // Never retry auth/permission errors — they will never succeed
            if (is_non_retryable(e)) throw e;

            attempt++;
            if (attempt >= maxRetries) throw e;

            // Rate-limit (429): wait 15s → 30s — short delays are useless here
            // Other errors: exponential backoff 500ms → 1s → 2s (capped at 8s)
            const delayMs = is_rate_limit(e)
                ? RATE_LIMIT_BASE_MS * attempt
                : Math.min(500 * Math.pow(2, attempt - 1), 8000);

            const reason = is_rate_limit(e) ? 'rate-limited (429)' : 'transient error';
            console.warn(`[ACP] Retry ${attempt}/${maxRetries - 1} — ${reason}, waiting ${delayMs / 1000}s...`);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
}

export function select_next_available_provider(attempted: string[]): Plugin | null {
    // In a real implementation this hooks to plugin_engine's registry of providers
    return null; 
}

export function validate_provider_available(plugin: Plugin): boolean {
    return plugin.enabled === true;
}
