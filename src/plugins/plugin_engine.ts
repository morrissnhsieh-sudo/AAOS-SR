import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import AnthropicVertex from '@anthropic-ai/vertex-sdk';
import { ToolDefinition, ToolCall } from '../tools/tool_dispatcher';
import { log_usage, calculate_cost } from '../usage/usage_tracker';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';

export interface Plugin { name: string; enabled: boolean; init: () => Promise<void>; invoke?: (prompt: LlmPrompt) => Promise<LlmResponse>; }
export interface PluginConfig { [key: string]: string; }
export interface GatewayConfig { plugins?: { entries?: { [key: string]: PluginConfig } }; }
export interface LlmUsage { input_tokens: number; output_tokens: number; total_tokens: number; thinking_tokens?: number; }
export interface LlmResponse { text?: string; reasoning?: string; tools?: ToolCall[]; usage?: LlmUsage; }
export interface LlmPrompt {
    system: string;
    messages: any[];
    tools?: ToolDefinition[];
    /** Enable native model thinking/reasoning mode.
     *  Set to a token budget (e.g. 8000–32000). The model will reason internally
     *  before producing its answer. Requires a thinking-capable model
     *  (gemini-2.5-pro, gemini-2.5-flash, claude-3-7-sonnet-20250219). */
    thinking_budget?: number;
}

export const SUPPORTED_PLUGINS: readonly string[] = ['anthropic', 'anthropic-vertex', 'ollama', 'google', 'browser'];
export const PLUGIN_CONFIG_PREFIX: string = 'plugins.entries';

export const pluginRegistry = new Map<string, Plugin>();

// ── Per-role model configuration ──────────────────────────────────────────────

export interface ModelAssignment { provider: string; model: string; }
export type RoleModelConfig = Record<string, ModelAssignment>;

export const AGENT_ROLES = ['chatbot', 'skill_builder', 'memory_extractor', 'wiki_compiler', 'thinker'] as const;
export type AgentRole = typeof AGENT_ROLES[number];

export const ROLE_LABELS: Record<string, string> = {
    chatbot:          'Chatbot',
    skill_builder:    'Skill Builder',
    memory_extractor: 'Memory Extractor',
    wiki_compiler:    'Wiki Compiler',
    thinker:          'Deep Thinker',
};

export const AVAILABLE_MODELS: Record<string, Array<{ id: string; label: string; thinking?: boolean }>> = {
    'google': [
        { id: 'gemini-2.5-pro',        label: 'Gemini 2.5 Pro (deep thinking ✨)',   thinking: true },
        { id: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash (thinking, fast ✨)', thinking: true },
        { id: 'gemini-2.0-flash',      label: 'Gemini 2.0 Flash (fast)' },
        { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite (lightweight)' },
        { id: 'gemini-1.5-flash',      label: 'Gemini 1.5 Flash (stable)' },
        { id: 'gemini-1.5-pro',        label: 'Gemini 1.5 Pro (powerful)' },
    ],
    'anthropic': [
        { id: 'claude-3-7-sonnet-20250219', label: 'Claude 3.7 Sonnet (extended thinking ✨)', thinking: true },
        { id: 'claude-haiku-4-5',           label: 'Claude Haiku (fast)' },
        { id: 'claude-sonnet-4-6',          label: 'Claude Sonnet (balanced)' },
    ],
    'anthropic-vertex': [
        { id: 'claude-3-7-sonnet@20250219', label: 'Claude 3.7 Sonnet on Vertex (thinking ✨)', thinking: true },
        { id: 'claude-haiku-4-5',           label: 'Claude Haiku on Vertex (fast)' },
        { id: 'claude-sonnet-4-5',          label: 'Claude Sonnet on Vertex (balanced)' },
    ],
};

const PROVIDER_LABELS: Record<string, string> = {
    'google':           'Google Vertex AI',
    'anthropic':        'Anthropic API',
    'anthropic-vertex': 'Claude on Vertex',
};

/**
 * Returns the active provider's model from environment variables — never hardcoded.
 * This is the live, user-configured model for the currently selected provider.
 */
function get_active_provider_model(): ModelAssignment {
    const provider = process.env.AAOS_LLM_PROVIDER || 'google';
    let model: string;
    switch (provider) {
        case 'anthropic':        model = process.env.ANTHROPIC_MODEL        || 'claude-sonnet-4-6'; break;
        case 'anthropic-vertex': model = process.env.ANTHROPIC_VERTEX_MODEL || 'claude-sonnet-4-5'; break;
        case 'google':
        default:                 model = process.env.VERTEX_MODEL            || 'gemini-2.0-flash';  break;
    }
    return { provider, model };
}

/**
 * Per-role overrides saved to disk. An empty map means "use the active provider for everything."
 * Roles NOT present in this map inherit the live active provider/model automatically.
 */
let _modelConfig: RoleModelConfig = {};

export function get_model_config(): RoleModelConfig {
    return { ..._modelConfig };
}

export function load_model_config(workspace: string): RoleModelConfig {
    const cfgFile = path.join(workspace, 'model_config.json');
    try {
        const raw = fs.readFileSync(cfgFile, 'utf8');
        _modelConfig = JSON.parse(raw) as RoleModelConfig;
        console.log('[ModelConfig] Loaded per-role overrides:', JSON.stringify(_modelConfig));
    } catch {
        _modelConfig = {};
    }
    return { ..._modelConfig };
}

export function save_model_config(workspace: string, config: RoleModelConfig): void {
    fs.mkdirSync(workspace, { recursive: true });
    const cfgFile = path.join(workspace, 'model_config.json');
    fs.writeFileSync(cfgFile, JSON.stringify(config, null, 2), 'utf8');
    _modelConfig = { ...config };
}

export function update_role_model(workspace: string, role: string, assignment: ModelAssignment): void {
    if (!AGENT_ROLES.includes(role as AgentRole)) throw new Error(`Unknown role: ${role}`);
    if (!SUPPORTED_PLUGINS.includes(assignment.provider)) throw new Error(`Unknown provider: ${assignment.provider}`);
    const updated = { ..._modelConfig, [role]: assignment };
    save_model_config(workspace, updated);
    console.log(`[ModelConfig] Role '${role}' → ${assignment.provider}/${assignment.model}`);
}

export function reset_role_model(workspace: string, role: string): void {
    if (!AGENT_ROLES.includes(role as AgentRole)) throw new Error(`Unknown role: ${role}`);
    const updated = { ..._modelConfig };
    delete updated[role];
    save_model_config(workspace, updated);
    console.log(`[ModelConfig] Role '${role}' reset to active provider`);
}

// ── Shared credential path ─────────────────────────────────────────────────────

// Resolve Google credentials:
//   1. GOOGLE_APPLICATION_CREDENTIALS env var (recommended — set this in your .env)
//   2. Standard gcloud SDK location (~/.config/gcloud/application_default_credentials.json)
//   3. Windows gcloud SDK location (%APPDATA%\gcloud\application_default_credentials.json)
import * as _os_pg from 'os';
import * as _path_pg from 'path';
function _default_google_cred_path(): string {
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || _path_pg.join(_os_pg.homedir(), 'AppData', 'Roaming');
        return _path_pg.join(appData, 'gcloud', 'application_default_credentials.json');
    }
    return _path_pg.join(_os_pg.homedir(), '.config', 'gcloud', 'application_default_credentials.json');
}

function ensure_google_credentials(): void {
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = _default_google_cred_path();
    }
}

// ── Message format converters ──────────────────────────────────────────────────

/**
 * Converts internal message history to Anthropic's API format.
 * Groups consecutive tool results into a single user message (Anthropic requirement).
 */
function convert_messages_to_anthropic(messages: any[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];
    let i = 0;
    while (i < messages.length) {
        const msg = messages[i];
        if (msg.role === 'user') {
            result.push({ role: 'user', content: msg.content || '' });
            i++;
        } else if (msg.role === 'assistant') {
            const content: any[] = [];
            if (msg.content) content.push({ type: 'text', text: msg.content });
            if (msg.tool_calls?.length) {
                for (const tc of msg.tool_calls) {
                    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args || {} });
                }
            }
            result.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] } as any);
            i++;
        } else if (msg.role === 'tool') {
            // Collect all consecutive tool results into one user turn
            const toolResults: Anthropic.ToolResultBlockParam[] = [];
            while (i < messages.length && messages[i].role === 'tool') {
                const tr = messages[i];
                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: tr.tool_call_id || tr.id,
                    content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content)
                });
                i++;
            }
            result.push({ role: 'user', content: toolResults });
        } else {
            i++;
        }
    }
    return result;
}

/**
 * Converts internal message history to Google Gemini's contents format.
 * Consecutive tool-result messages are collapsed into ONE user turn
 * with multiple functionResponse parts (Google API requirement).
 */
function convert_messages_to_google(messages: any[]): any[] {
    const contents: any[] = [];
    let mi = 0;
    while (mi < messages.length) {
        const m = messages[mi];
        if (m.role === 'tool') {
            // Collect all consecutive tool messages into one user turn
            const fnParts: any[] = [];
            while (mi < messages.length && messages[mi].role === 'tool') {
                const tr = messages[mi];
                fnParts.push({
                    functionResponse: {
                        name: tr.tool_name,
                        response: { result: tr.content }
                    }
                });
                mi++;
            }
            contents.push({ role: 'user', parts: fnParts });
        } else if (m.role === 'assistant') {
            const parts: any[] = [];
            if (m.content) parts.push({ text: m.content });
            if (m.tool_calls?.length) {
                m.tool_calls.forEach((tc: any) => parts.push({ functionCall: { name: tc.name, args: tc.args } }));
            }
            contents.push({ role: 'model', parts });
            mi++;
        } else {
            contents.push({ role: 'user', parts: [{ text: m.content || '' }] });
            mi++;
        }
    }
    return contents;
}

// ── Standalone provider invoke functions ───────────────────────────────────────
// These are used by both the pluginRegistry plugins (global provider switch)
// and invoke_for_role (per-role model selection). They are self-contained —
// no prior initialization or plugin registry state is required.

async function invoke_google(prompt: LlmPrompt, model: string): Promise<LlmResponse> {
    ensure_google_credentials();
    const project  = process.env.VERTEX_PROJECT_ID || 'd-sxd110x-ssd1-cdl';
    const location = process.env.VERTEX_LOCATION   || 'us-central1';

    const ai = new GoogleGenAI({ vertexai: true, project, location });

    let tools: any[] | undefined;
    if (prompt.tools && prompt.tools.length > 0) {
        tools = [{
            functionDeclarations: prompt.tools.map(t => ({
                name: t.name,
                description: t.description || t.name,
                parameters: t.parameters || { type: 'OBJECT', properties: {} }
            }))
        }];
    }

    const contents = convert_messages_to_google(prompt.messages);

    // Build config — add thinkingConfig when a budget is requested.
    // Supported on gemini-2.5-pro and gemini-2.5-flash.
    const genConfig: Record<string, any> = { systemInstruction: prompt.system, tools };
    if (prompt.thinking_budget && prompt.thinking_budget > 0) {
        genConfig.thinkingConfig = { thinkingBudget: prompt.thinking_budget };
        console.log(`[invoke_google] Thinking mode ON — budget=${prompt.thinking_budget} tokens`);
    }

    const response = await ai.models.generateContent({
        model,
        contents,
        config: genConfig,
    });

    const result: LlmResponse = { text: response.text ?? '' };
    const calls = response.functionCalls;
    if (calls?.length) {
        result.tools = calls.map((c: any) => ({ id: uuidv4(), name: c.name, args: c.args }));
    }
    // Capture token usage from Gemini usageMetadata
    const meta = (response as any).usageMetadata;
    if (meta) {
        const input_tokens     = meta.promptTokenCount     ?? 0;
        const output_tokens    = meta.candidatesTokenCount ?? 0;
        const thinking_tokens  = meta.thoughtsTokenCount   ?? 0;
        result.usage = { input_tokens, output_tokens, total_tokens: input_tokens + output_tokens, thinking_tokens };
        if (thinking_tokens > 0) console.log(`[invoke_google] Thinking tokens used: ${thinking_tokens}`);
    }
    return result;
}

async function invoke_anthropic(prompt: LlmPrompt, model: string): Promise<LlmResponse> {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const tools: Anthropic.Tool[] | undefined = prompt.tools?.length
        ? prompt.tools.map(t => ({
            name: t.name,
            description: t.description || t.name,
            input_schema: (t.parameters as Anthropic.Tool['input_schema']) || { type: 'object' as const, properties: {} }
        }))
        : undefined;

    const messages = convert_messages_to_anthropic(prompt.messages);
    const useThinking = (prompt.thinking_budget ?? 0) > 0;

    if (useThinking) console.log(`[invoke_anthropic] Extended thinking ON — budget=${prompt.thinking_budget} tokens`);

    // Extended thinking requires temperature=1 and max_tokens > budget_tokens.
    const max_tokens = useThinking
        ? Math.max(16000, (prompt.thinking_budget ?? 0) + 4096)
        : 8096;

    const response = await client.messages.create({
        model,
        max_tokens,
        system: prompt.system,
        messages,
        ...(tools ? { tools } : {}),
        ...(useThinking ? {
            temperature: 1,              // required for extended thinking
            thinking: { type: 'enabled' as const, budget_tokens: prompt.thinking_budget! },
        } : {}),
    } as any);  // 'as any' covers SDK versions where thinking field isn't typed yet

    const result: LlmResponse = {};
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const block of response.content) {
        if (block.type === 'text')          textParts.push(block.text);
        else if (block.type === 'thinking') reasoningParts.push((block as any).thinking ?? '');
        else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, args: block.input as Record<string, any> });
    }
    if (textParts.length)      result.text      = textParts.join('\n');
    if (reasoningParts.length) result.reasoning = reasoningParts.join('\n');
    if (toolCalls.length)      result.tools     = toolCalls;
    if (response.usage) {
        const input_tokens     = response.usage.input_tokens  ?? 0;
        const output_tokens    = response.usage.output_tokens ?? 0;
        const thinking_tokens  = (response.usage as any).thinking_input_tokens ?? 0;
        result.usage = { input_tokens, output_tokens, total_tokens: input_tokens + output_tokens, thinking_tokens };
        if (thinking_tokens > 0) console.log(`[invoke_anthropic] Thinking tokens: ${thinking_tokens}`);
    }
    return result;
}

async function invoke_anthropic_vertex(prompt: LlmPrompt, model: string): Promise<LlmResponse> {
    ensure_google_credentials();
    const project  = process.env.VERTEX_PROJECT_ID       || 'd-sxd110x-ssd1-cdl';
    const location = process.env.ANTHROPIC_VERTEX_REGION || 'us-east5';

    const client = new AnthropicVertex({ projectId: project, region: location });

    const tools: any[] | undefined = prompt.tools?.length
        ? prompt.tools.map(t => ({
            name: t.name,
            description: t.description || t.name,
            input_schema: t.parameters || { type: 'object', properties: {} }
        }))
        : undefined;

    const messages = convert_messages_to_anthropic(prompt.messages);
    const useThinking = (prompt.thinking_budget ?? 0) > 0;

    if (useThinking) console.log(`[invoke_anthropic_vertex] Extended thinking ON — budget=${prompt.thinking_budget} tokens`);

    const max_tokens = useThinking
        ? Math.max(16000, (prompt.thinking_budget ?? 0) + 4096)
        : 8096;

    const response = await client.messages.create({
        model,
        max_tokens,
        system: prompt.system,
        messages,
        ...(tools ? { tools } : {}),
        ...(useThinking ? {
            temperature: 1,
            thinking: { type: 'enabled' as const, budget_tokens: prompt.thinking_budget! },
        } : {}),
    } as any);

    const result: LlmResponse = {};
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: ToolCall[] = [];
    for (const block of response.content) {
        if (block.type === 'text')          textParts.push(block.text);
        else if (block.type === 'thinking') reasoningParts.push((block as any).thinking ?? '');
        else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, args: block.input as Record<string, any> });
    }
    if (textParts.length)      result.text      = textParts.join('\n');
    if (reasoningParts.length) result.reasoning = reasoningParts.join('\n');
    if (toolCalls.length)      result.tools     = toolCalls;
    if (response.usage) {
        const input_tokens    = response.usage.input_tokens  ?? 0;
        const output_tokens   = response.usage.output_tokens ?? 0;
        const thinking_tokens = (response.usage as any).thinking_input_tokens ?? 0;
        result.usage = { input_tokens, output_tokens, total_tokens: input_tokens + output_tokens, thinking_tokens };
    }
    return result;
}

// ── Per-role invocation (main public API for sub-agents) ───────────────────────

/**
 * Invokes the LLM configured for the given agent role.
 *
 * Resolution order:
 *   1. Per-role override saved in model_config.json  (user explicitly set this role)
 *   2. Active provider + model from environment vars  (AAOS_LLM_PROVIDER / VERTEX_MODEL / etc.)
 *
 * This means every role automatically inherits whatever the user has selected as their
 * active model — no hardcoded model names anywhere.
 */
export async function invoke_for_role(role: string, prompt: LlmPrompt, activity?: string): Promise<LlmResponse> {
    const assignment = _modelConfig[role] ?? get_active_provider_model();
    const { provider, model } = assignment;
    console.log(`[invoke_for_role] role=${role} provider=${provider} model=${model}`);

    let response: LlmResponse;
    switch (provider) {
        case 'anthropic':        response = await invoke_anthropic(prompt, model);        break;
        case 'anthropic-vertex': response = await invoke_anthropic_vertex(prompt, model); break;
        case 'google':
        default:                 response = await invoke_google(prompt, model);            break;
    }

    // Log token usage and cost
    if (response.usage) {
        const { input_tokens, output_tokens, total_tokens } = response.usage;
        const cost_usd = calculate_cost(provider, model, input_tokens, output_tokens);
        log_usage({
            timestamp: new Date().toISOString(),
            role,
            provider,
            model,
            input_tokens,
            output_tokens,
            total_tokens,
            cost_usd,
            activity,
        });
        console.log(`[Usage] ${role} ${model}: ${total_tokens} tokens, $${cost_usd.toFixed(6)}`);
    }

    return response;
}

// ── Plugin registry (global provider switch, backward compat) ──────────────────

/**
 * Returns the active LLM provider plugin.
 * Reads AAOS_LLM_PROVIDER env var (default: 'google').
 * Use invoke_for_role() for per-agent model selection instead.
 */
export function get_active_provider(): Plugin | undefined {
    const name = process.env.AAOS_LLM_PROVIDER || 'google';
    return pluginRegistry.get(name);
}

export function load_plugins_from_config(config: GatewayConfig): Plugin[] {
    const loaded: Plugin[] = [];
    if (!config.plugins?.entries) return loaded;

    for (const [name] of Object.entries(config.plugins.entries)) {
        if (!SUPPORTED_PLUGINS.includes(name)) continue;

        const plugin: Plugin = {
            name,
            enabled: true,
            init: async () => { console.log(`Initialized plugin ${name}`); }
        };

        if (name === 'google') {
            const project  = process.env.VERTEX_PROJECT_ID || 'd-sxd110x-ssd1-cdl';
            const location = process.env.VERTEX_LOCATION   || 'us-central1';
            plugin.init = async () => {
                ensure_google_credentials();
                console.log(`Initializing Vertex AI for project ${project}, location ${location}`);
            };
            plugin.invoke = (prompt) => invoke_google(prompt, process.env.VERTEX_MODEL || 'gemini-2.0-flash');
        }

        if (name === 'anthropic') {
            plugin.init = async () => {
                if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set in environment.');
                console.log(`Initialized Anthropic plugin (model: ${process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6'})`);
            };
            plugin.invoke = (prompt) => invoke_anthropic(prompt, process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6');
        }

        if (name === 'anthropic-vertex') {
            const project  = process.env.VERTEX_PROJECT_ID       || 'd-sxd110x-ssd1-cdl';
            const location = process.env.ANTHROPIC_VERTEX_REGION || 'us-east5';
            plugin.init = async () => {
                ensure_google_credentials();
                const model = process.env.ANTHROPIC_VERTEX_MODEL || 'claude-sonnet-4-5';
                console.log(`Initialized Anthropic-Vertex plugin (project: ${project}, region: ${location}, model: ${model})`);
            };
            plugin.invoke = (prompt) => invoke_anthropic_vertex(prompt, process.env.ANTHROPIC_VERTEX_MODEL || 'claude-sonnet-4-5');
        }

        pluginRegistry.set(name, plugin);
        loaded.push(plugin);
    }
    return loaded;
}

export function validate_plugin_config(plugin: unknown): any {
    if (typeof plugin !== 'object' || !plugin) return { valid: false, reason: 'Invalid format' };
    const p = plugin as Plugin;
    if (!SUPPORTED_PLUGINS.includes(p.name)) return { valid: false, reason: 'Unsupported plugin' };
    return { valid: true };
}

export async function initialize_plugin(plugin: Plugin): Promise<void> {
    try {
        await plugin.init();
    } catch (e) {
        console.error(`Failed to initialize plugin ${plugin.name}`, e);
        throw e;
    }
}

export function enable_plugin(pluginName: string): void {
    const p = pluginRegistry.get(pluginName);
    if (p) { p.enabled = true; console.log(`Enabled plugin ${pluginName}`); }
}

export function disable_plugin(pluginName: string): void {
    const p = pluginRegistry.get(pluginName);
    if (p) { p.enabled = false; console.log(`Disabled plugin ${pluginName}`); }
}

export function resolve_plugin_config_key(config: GatewayConfig, pluginName: string): PluginConfig {
    return config.plugins?.entries?.[pluginName] || {};
}

export function validate_plugin_config_key_format(key: string): boolean {
    return /^plugins\.entries\.[a-z]+$/.test(key);
}

// ── Model config API helpers (for REST endpoints) ──────────────────────────────

export function get_model_config_api_response(_workspace: string) {
    const activeDefault = get_active_provider_model();
    return {
        roles: AGENT_ROLES.map(role => ({
            id: role,
            label: ROLE_LABELS[role],
            assignment: _modelConfig[role] ?? activeDefault,
            is_default: !_modelConfig[role],  // true = inheriting from active provider
        })),
        active_default: activeDefault,
        available_providers: Object.entries(AVAILABLE_MODELS).map(([id, models]) => ({
            id,
            label: PROVIDER_LABELS[id] || id,
            models,
        })),
    };
}
