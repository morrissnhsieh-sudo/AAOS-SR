import { Plugin } from '../plugins/plugin_engine';

export interface AgentRunResult { finalResponse: string; }
export interface AgentStage { name: string; fn: (input: StageInput) => Promise<StageOutput>; }
export interface StageInput { data: any; }
export interface StageOutput { data: any; }

export const ACP_MAX_RETRIES = 3;
export const ACP_MAX_PIPELINE_STAGES = 10;
export const ACP_MAX_AGENT_ITERATIONS = 12;

export async function execute_with_acp_retry(fn: () => Promise<any>, maxRetries: number): Promise<any> {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            return await fn();
        } catch (e) {
            attempt++;
            if (attempt >= maxRetries) throw e;
            // Exponential backoff: 500ms → 1s → 2s → 4s (capped at 8s)
            const delayMs = Math.min(500 * Math.pow(2, attempt - 1), 8000);
            console.warn(`[ACP] Retry ${attempt}/${maxRetries - 1} — waiting ${delayMs}ms before next attempt.`);
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
