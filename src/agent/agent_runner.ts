import { v4 as uuidv4 } from 'uuid';
import { InternalMessage } from '../auth/auth_manager';
import { execute_tool, ToolCall, ToolResult, ToolResultMap, get_all_tool_definitions } from '../tools/tool_dispatcher';
import { execute_with_acp_retry, AgentRunResult, AgentStage, StageInput, StageOutput, ACP_MAX_PIPELINE_STAGES, ACP_MAX_AGENT_ITERATIONS } from '../acp/acp_runtime';
import { io_load_workspace_memory_files, io_append_message_to_session_log, io_initialize_session_log_file, io_load_session_history, append_validated_memory_fact, Session, Message } from '../memory/memory_system';
import { LlmResponse, LlmPrompt, Plugin, pluginRegistry, load_plugins_from_config, initialize_plugin, get_active_provider, invoke_for_role, load_model_config, thinking_level_to_budget, ThinkingLevel } from '../plugins/plugin_engine';
import { io_list_installed_skills, io_load_active_skill_contents, assemble_skill_system_prompt_block } from '../skills/skill_manager';
import { responseBus, ResponseEvent, InterimEvent, InterimType } from '../channel/response_bus';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const WORKSPACE_ENV_KEY = 'AAOS_WORKSPACE';
const runStates = new Map<string, { status: string }>();

export function io_read_context_file(filePath: string): string | null {
    // Stubbed since memory_system already loads context files natively
    return null; 
}

export function validate_context_file_exists(filePath: string): boolean {
    return false;
}

/**
 * Classify each memory line as either a BEHAVIORAL INSTRUCTION or a USER FACT.
 *
 * Instruction patterns — imperative phrases the agent must obey:
 *   "search X first", "always use X", "never do Y", "prefer X", "use X for Y", etc.
 * Everything else is treated as a passive fact about the user.
 */
const INSTRUCTION_PATTERN = /\b(always|never|don't|do not|must|should|use\s+\w|search|check|look|prefer|prioritize|first|before|instead|avoid|make sure|remember to|only use|don't use)\b/i;

export function split_memory_into_sections(memory: string | null): { instructions: string; facts: string } {
    if (!memory) return { instructions: '', facts: '' };
    const lines = memory.split('\n').filter(l => l.trim());
    const instructions: string[] = [];
    const facts: string[] = [];
    for (const line of lines) {
        (INSTRUCTION_PATTERN.test(line) ? instructions : facts).push(line);
    }
    return {
        instructions: instructions.join('\n'),
        facts:        facts.join('\n'),
    };
}

export function build_system_context_prefix(heartbeat: string | null, boot: string | null, memory: string | null, skills: string = ''): string {
    const { instructions, facts } = split_memory_into_sections(memory);

    const instructionsBlock = instructions
        ? `\n## MANDATORY BEHAVIORAL INSTRUCTIONS\nThe user has set the following rules. You MUST follow them in EVERY response without exception:\n${instructions}\n`
        : '';

    const factsBlock = facts
        ? `\n## USER CONTEXT & FACTS\n${facts}\n`
        : '';

    return [
        boot       ? `[BOOT]\n${boot}`           : '',
        heartbeat  ? `[HEARTBEAT]\n${heartbeat}` : '',
        instructionsBlock,
        factsBlock,
        skills     ? skills                       : '',
    ].filter(Boolean).join('\n');
}

export function assemble_llm_prompt(systemPrefix: string, history: Message[], newMessage: InternalMessage): LlmPrompt {
    return {
        system: systemPrefix,
        messages: [...history, { role: 'user', content: newMessage.content }]
    };
}

export function extract_text_response(llmResponse: LlmResponse): string | null {
    return llmResponse.text || null;
}

export async function deliver_text_response_to_channel(session: Session, text: string): Promise<void> {
    const event: ResponseEvent = { sessionId: session.id, text };
    responseBus.emit('response', event);
}

function emit_interim(session: Session, kind: InterimType, label: string, text: string): void {
    const event: InterimEvent = { sessionId: session.id, kind, label, text };
    responseBus.emit('interim', event);
}

/** Produces a concise, human-readable summary of a tool call for display in the UI. */
function summarise_tool_call(name: string, args: any): string {
    if (!args || Object.keys(args).length === 0) return '';
    switch (name) {
        case 'think':       return '';   // reasoning shown separately via 'thinking' event
        case 'bash_exec':   return `\`${String(args.command || '').slice(0, 120)}\``;
        case 'file_read':   return `→ \`${args.path}\``;
        case 'file_write':  return `→ \`${args.path}\`${args.append ? ' (append)' : ''}`;
        case 'file_list':   return `→ \`${args.dir}\`${args.recursive ? ' (recursive)' : ''}`;
        case 'file_search': return `→ \`${args.dir}\` pattern: \`${args.pattern}\``;
        case 'build_skill': return `description: "${String(args.description || '').slice(0, 80)}"`;
        case 'remember':    return `"${String(args.fact || '').slice(0, 100)}"`;
        case 'iot_scan':    return args.subnet ? `subnet: ${args.subnet}` : 'all local subnets';
        case 'iot_mqtt_subscribe': return `${args.brokerUrl} → \`${args.topic}\``;
        case 'iot_mqtt_publish':   return `${args.brokerUrl} \`${args.topic}\` = "${args.payload}"`;
        case 'iot_tcp_send':       return `${args.ip}:${args.port} → "${String(args.command || '').slice(0, 60)}"`;
        case 'webcam_capture':     return args.prompt ? `analyzing: "${String(args.prompt).slice(0, 60)}"` : 'capturing photo';
        case 'web_fetch':          return String(args.url || '').slice(0, 100);
        case 'analyze_image':      return `"${String(args.prompt || '').slice(0, 80)}" → \`${path.basename(String(args.path || ''))}\``;
        case 'analyze_video':      return `"${String(args.prompt || 'general overview').slice(0, 80)}" → \`${path.basename(String(args.path || ''))}\``;
        default: {
            const first = Object.values(args)[0];
            return first ? `${String(first).slice(0, 100)}` : '';
        }
    }
}

/** Produces a concise summary of a tool result for display in the UI. */
function summarise_tool_result(name: string, result: any): string {
    if (!result) return '';
    if (result.error) return `❌ ${String(result.error).slice(0, 150)}`;
    switch (name) {
        case 'think':       return '';
        case 'bash_exec':   return result.output ? String(result.output).trim().slice(0, 200) : '(no output)';
        case 'file_read':   return result.content ? `${result.bytes} bytes read` : '(empty)';
        case 'file_write':  return result.ok ? `Saved to \`${result.path}\`` : '(failed)';
        case 'file_list':   return result.count !== undefined ? `${result.count} entries` : '';
        case 'file_search': return result.count !== undefined ? `${result.count} matches` : '';
        case 'build_skill': return result.ok ? `✓ Skill "${result.name}" created` : `❌ ${result.error}`;
        case 'remember':    return result.ok ? `✓ Stored` : `❌ ${result.error}`;
        case 'iot_scan':    return result.ok ? `Found ${result.found} device(s)` : `❌ ${result.error}`;
        case 'iot_mqtt_subscribe': return result.ok ? `✓ Subscribed` : `❌ ${result.error}`;
        case 'iot_mqtt_publish':   return result.ok ? `✓ Published` : `❌ ${result.error}`;
        case 'iot_tcp_send':       return result.ok ? result.received?.slice(0, 120) || '(no response)' : `❌ ${result.error}`;
        case 'webcam_capture':
            if (!result.ok) return `❌ ${result.error}`;
            return result.webPath ? `![photo](${result.webPath})` : `${result.bytes} bytes captured`;
        case 'web_fetch':
            if (!result.ok) return `❌ ${result.error}`;
            return result.truncated
                ? `✓ ${result.total_chars} chars (truncated to ${result.text?.length}) — ${result.url}`
                : `✓ ${result.total_chars} chars — ${result.url}`;
        case 'analyze_image':
            if (!result.ok) return `❌ ${result.error}`;
            return result.description ? `✓ ${String(result.description).slice(0, 150)}` : '✓ Analyzed';
        case 'analyze_video':
            if (!result.ok) return `❌ ${result.error}`;
            return result.description
                ? `✓ ${result.frames_analyzed} frames · ${result.duration}s · ${String(result.description).slice(0, 120)}`
                : '✓ Analyzed';
        default:
            if (result.ok === true)  return '✓ Done';
            if (result.ok === false) return `❌ ${result.error || 'failed'}`;
            return JSON.stringify(result).slice(0, 150);
    }
}

export function parse_tool_calls_from_llm_response(llmResponse: LlmResponse): ToolCall[] {
    if (!llmResponse.tools) return [];
    return llmResponse.tools.map((t: any) => ({ id: t.id || uuidv4(), name: t.name, args: t.args }));
}

export function validate_tool_call_schema(toolCall: unknown): { valid: boolean; reason?: string } {
    return { valid: true };
}

export async function dispatch_tool_calls_parallel(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    return Promise.all(toolCalls.map(execute_tool));
}

export function aggregate_tool_results(results: ToolResult[]): ToolResultMap {
    const map: ToolResultMap = {};
    results.forEach(r => map[r.id] = r);
    return map;
}

export function build_tool_result_message(result: ToolResult, toolCall: ToolCall): Message {
    return { 
        id: uuidv4(), 
        session_id: 'tool', 
        role: 'tool', 
        content: JSON.stringify(result.result), 
        tool_name: toolCall.name, 
        tool_call_id: toolCall.id, 
        created_at: new Date(), 
        token_count: 10 
    };
}

export function inject_tool_results_into_context(history: Message[], toolCalls: ToolCall[], results: ToolResult[]): Message[] {
    const injected = [...history];
    results.forEach((r, i) => injected.push(build_tool_result_message(r, toolCalls[i])));
    return injected;
}

class PipelineLimitError extends Error { constructor() { super('Pipeline exceeded max stages'); } }

/**
 * Runs a background LLM call to extract memorable facts from a conversation turn.
 * Facts are appended to MEMORY.md without blocking the main response.
 */
async function extract_and_persist_memory_facts(
    userInput: string,
    agentReply: string,
    workspace: string
): Promise<void> {
    try {
        const provider = get_active_provider();
        if (!provider?.invoke) return;

        // Load existing memory so we can skip duplicates
        const memFile = path.join(workspace, 'memory', 'MEMORY.md');
        let existingMemory = '';
        try { existingMemory = fs.readFileSync(memFile, 'utf8'); } catch { /* file may not exist yet */ }

        const extractPrompt: LlmPrompt = {
            system: `You are a long-term memory extraction agent. Extract facts AND behavioral instructions from the conversation that should persist across all future sessions.

GOOD candidates — save these:
- User's real name, preferred name, or identity
- User's stated language, timezone, or location
- User's long-term project names, role, or occupation
- User's explicit behavioral instructions (e.g. "always search the wiki first", "never use Python 2", "respond in Chinese", "check local data before answering")
- User's persistent preferences about HOW the agent should behave

DO NOT save:
- Weather, temperature, or any time-sensitive data
- System scan results or runtime environment details
- Greetings, casual exchanges, or one-off questions
- Anything already present verbatim in existing memory
- Agent actions, tool results, or what the assistant did

Behavioral instructions are HIGH PRIORITY — if the user says how the agent should behave, always extract it.
Output ONLY a JSON array of concise strings. E.g.: ["User's name is Alex.", "Always search local wiki before answering domain questions."]
Output [] if nothing qualifies.`,
            messages: [{
                role: 'user',
                content: `Existing memory:\n${existingMemory.trim() || '(empty)'}\n\nNew exchange:\nUser: ${userInput}\nAssistant: ${agentReply}`
            }]
        };
        const res = await invoke_for_role('memory_extractor', extractPrompt, userInput.slice(0, 60));
        const raw = (res.text || '[]').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const facts: string[] = JSON.parse(raw);
        if (!Array.isArray(facts) || facts.length === 0) return;
        let stored = 0;
        for (const fact of facts) {
            const result = append_validated_memory_fact(workspace, fact);
            if (result.ok) stored++;
        }
        if (stored > 0) console.log(`[Memory] Auto-stored ${stored}/${facts.length} validated fact(s).`);
    } catch (e: any) {
        console.warn(`[Memory] Auto-extraction failed: ${e.message}`);
    }
}

/**
 * Replaces /snapshots/<filename> URLs in the response text with inline base64
 * data URIs so the browser can display images without a separate HTTP request.
 * The session log always stores the original compact URL; this runs only on the
 * copy sent over WebSocket.
 */
async function embed_snapshot_images(text: string, workspace: string): Promise<string> {
    const snapshotsDir = path.resolve(process.env.AAOS_SNAPSHOTS_DIR || path.join(os.tmpdir(), 'aaos_snapshots'));
    const pattern = /\/snapshots\/([a-zA-Z0-9_.\-]+)/g;
    const matches = [...new Set([...text.matchAll(pattern)].map(m => m[0]))];
    if (matches.length === 0) return text;

    let result = text;
    for (const urlPath of matches) {
        const filename = urlPath.slice('/snapshots/'.length);
        const filePath = path.join(snapshotsDir, filename);
        try {
            const data = fs.readFileSync(filePath);
            const ext = path.extname(filename).toLowerCase();
            const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
            const dataUri = `data:${mime};base64,${data.toString('base64')}`;
            result = result.split(urlPath).join(dataUri);
            console.log(`[Snapshots] Embedded ${filename} as base64 (${data.length} bytes)`);
        } catch (e: any) {
            console.warn(`[Snapshots] Could not embed ${filename}: ${e.message}`);
        }
    }
    return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// 5-STAGE PIPELINE
// User Input → Intake → Planner → Executor → Verifier → Memory Update
// ══════════════════════════════════════════════════════════════════════════════

interface IntakeResult {
    is_simple:      boolean;
    clarified_goal: string;
    sub_tasks:      string[];
    complexity:     'simple' | 'medium' | 'complex';
}

interface PlannerResult {
    plan_summary: string;
    steps: Array<{ order: number; action: string; tool?: string; expected_output: string }>;
}

interface VerifierResult {
    passed:       boolean;
    score:        number;   // 0–10
    issues:       string[];
    final_answer: string;   // full revised response (copy of executor output if no issues)
}

/**
 * Stage 1 — Intake Agent
 * Classifies the request and breaks complex tasks into sub-tasks.
 * Always falls back to is_simple=true on parse/LLM errors so the pipeline
 * degrades gracefully without blocking the executor.
 */
async function run_intake_stage(userInput: string, activity: string): Promise<IntakeResult> {
    const FALLBACK: IntakeResult = { is_simple: true, clarified_goal: userInput, sub_tasks: [], complexity: 'simple' };
    try {
        const prompt: LlmPrompt = {
            system: `You are an Intake Agent. Analyse the user request and classify it.

SIMPLE (is_simple=true): greetings, thanks, casual chat, yes/no, single factual questions, short clarifications.
COMPLEX (is_simple=false): multi-step tasks, research, writing/editing code, file or system operations, anything that needs tools, analysis, or planning.

Respond ONLY with compact valid JSON — no markdown fences, no explanation:
{"is_simple":bool,"clarified_goal":"one clear sentence","sub_tasks":["..."],"complexity":"simple|medium|complex"}`,
            messages: [{ role: 'user', content: userInput }],
        };
        const res = await invoke_for_role('intake', prompt, activity);
        const raw = (res.text || '{}').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(raw) as IntakeResult;
        return { ...FALLBACK, ...parsed };
    } catch (e: any) {
        console.warn(`[Pipeline] Intake failed — treating as simple: ${e.message}`);
        return FALLBACK;
    }
}

/**
 * Stage 2 — Planner
 * Creates an ordered execution plan with tool hints.
 * Falls back to a single-step plan from the intake sub-tasks on error.
 */
async function run_planner_stage(intake: IntakeResult, toolNames: string[], activity: string): Promise<PlannerResult> {
    const FALLBACK: PlannerResult = {
        plan_summary: intake.clarified_goal,
        steps: intake.sub_tasks.length
            ? intake.sub_tasks.map((t, i) => ({ order: i + 1, action: t, expected_output: 'completed' }))
            : [{ order: 1, action: intake.clarified_goal, expected_output: 'task complete' }],
    };
    try {
        const prompt: LlmPrompt = {
            system: `You are a Planner Agent. Produce an ordered execution plan.
Available tools: ${toolNames.slice(0, 30).join(', ')}

Respond ONLY with compact valid JSON — no markdown fences:
{"plan_summary":"brief summary","steps":[{"order":1,"action":"what to do","tool":"tool_name_or_null","expected_output":"success criterion"}]}`,
            messages: [{
                role: 'user',
                content: `Goal: ${intake.clarified_goal}\nSub-tasks:\n${intake.sub_tasks.map((t, i) => `${i + 1}. ${t}`).join('\n') || '(see goal)'}`,
            }],
        };
        const res = await invoke_for_role('planner', prompt, activity);
        const raw = (res.text || '{}').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(raw) as PlannerResult;
        return { ...FALLBACK, ...parsed };
    } catch (e: any) {
        console.warn(`[Pipeline] Planner failed — using fallback plan: ${e.message}`);
        return FALLBACK;
    }
}

/**
 * Stage 4 — Verifier
 * Checks executor output against the original goal.
 * Falls back to passing the executor output unchanged on error.
 */
async function run_verifier_stage(goal: string, executorOutput: string, activity: string): Promise<VerifierResult> {
    const FALLBACK: VerifierResult = { passed: true, score: 8, issues: [], final_answer: executorOutput };
    try {
        const prompt: LlmPrompt = {
            system: `You are a Verifier Agent. Evaluate whether the output fully satisfies the original goal.

Respond ONLY with compact valid JSON — no markdown fences:
{"passed":bool,"score":0-10,"issues":["issue"],"final_answer":"complete response to show the user — copy executor output verbatim if no issues, or provide a revised version"}`,
            messages: [{
                role: 'user',
                content: `Original goal: ${goal}\n\nExecutor output:\n${executorOutput.slice(0, 4000)}`,
            }],
        };
        const res = await invoke_for_role('verifier', prompt, activity);
        const raw = (res.text || '{}').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(raw) as VerifierResult;
        return { ...FALLBACK, ...parsed };
    } catch (e: any) {
        console.warn(`[Pipeline] Verifier failed — using executor output: ${e.message}`);
        return FALLBACK;
    }
}

/**
 * Stage 2b — Replanner
 * Produces a revised execution plan when the first attempt fails verification.
 * Receives the failed plan and the list of issues reported by the verifier.
 */
async function run_replan_stage(
    intake: IntakeResult,
    failedPlan: PlannerResult,
    failureReasons: string[],
    toolNames: string[],
    activity: string
): Promise<PlannerResult> {
    const FALLBACK: PlannerResult = {
        plan_summary: `Retry: ${intake.clarified_goal}`,
        steps: intake.sub_tasks.length
            ? intake.sub_tasks.map((t, i) => ({ order: i + 1, action: t, expected_output: 'completed' }))
            : [{ order: 1, action: intake.clarified_goal, expected_output: 'task complete' }],
    };
    try {
        const prompt: LlmPrompt = {
            system: `You are a Replanner Agent. A previous execution plan failed verification.
Produce a REVISED execution plan that specifically addresses the reported issues.
Available tools: ${toolNames.slice(0, 30).join(', ')}

Respond ONLY with compact valid JSON — no markdown fences:
{"plan_summary":"brief summary","steps":[{"order":1,"action":"what to do","tool":"tool_name_or_null","expected_output":"success criterion"}]}`,
            messages: [{
                role: 'user',
                content: [
                    `Goal: ${intake.clarified_goal}`,
                    ``,
                    `Failed plan summary: ${failedPlan.plan_summary}`,
                    `Failed steps:`,
                    failedPlan.steps.map(s => `  ${s.order}. ${s.action} → ${s.expected_output}`).join('\n'),
                    ``,
                    `Verification failures:`,
                    failureReasons.map(r => `  - ${r}`).join('\n'),
                    ``,
                    `Produce a revised plan that avoids these failures.`,
                ].join('\n'),
            }],
        };
        const res = await invoke_for_role('planner', prompt, activity);
        const raw = (res.text || '{}').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        const parsed = JSON.parse(raw) as PlannerResult;
        return { ...FALLBACK, ...parsed };
    } catch (e: any) {
        console.warn(`[Pipeline] Replanner failed — using fallback plan: ${e.message}`);
        return FALLBACK;
    }
}

/**
 * Stage 3 — Executor Loop
 * Runs the LLM+tool execution loop until a final text response is produced
 * or the iteration cap is hit. Returns the final response text and updated history.
 */
async function run_executor_loop(
    session: Session,
    initialHistory: Message[],
    pipelineSystem: string,
    planBlock: string,
    tools: any[],
    thinkingBudget: number | undefined,
    activity: string,
    memCtx: { heartbeat: string; boot: string; memory: string }
): Promise<{ finalResponse: string; history: Message[] }> {
    let currentPrompt: LlmPrompt = {
        system: pipelineSystem,
        messages: initialHistory,
        tools: tools,
        ...(thinkingBudget !== undefined ? { thinking_budget: thinkingBudget } : {}),
    };

    let finalResponse = '';
    let iterCount = 0;
    let lastToolSig = '';
    let lastPartialText = '';
    let history = initialHistory;
    let brokeClean = false;   // true when loop exited via a text-only final turn

    while (iterCount < ACP_MAX_AGENT_ITERATIONS) {
        iterCount++;
        const res = await execute_with_acp_retry(async () => {
            console.log(`[Agent] Step ${iterCount}/${ACP_MAX_AGENT_ITERATIONS} — invoking chatbot model...`);
            return await invoke_for_role('chatbot', currentPrompt, activity);
        }, 3);

        if (res.tools && res.tools.length > 0) {
            // Stuck-loop guard: same tool signatures twice in a row means the LLM is spinning
            const sig = JSON.stringify(res.tools.map((t: any) => ({ n: t.name, a: t.args })));
            if (sig === lastToolSig) {
                console.warn(`[Agent] Identical tool calls at step ${iterCount} — breaking to avoid infinite loop.`);
                finalResponse = lastPartialText ||
                    'I reached a point where I was repeating the same steps. Please rephrase or provide more context.';
                const stuckMsg: Message = {
                    id: uuidv4(), session_id: session.id, role: 'assistant',
                    content: finalResponse, created_at: new Date(), token_count: finalResponse.length
                };
                await io_append_message_to_session_log(session.id, stuckMsg);
                break;
            }
            lastToolSig = sig;
            lastPartialText = res.text || '';

            // Emit interim events so the UI can show thinking + steps in real-time
            for (const toolCall of res.tools) {
                if (toolCall.name === 'think') {
                    emit_interim(session, 'thinking', '💭 Thinking', toolCall.args?.reasoning || toolCall.args?.thought || '');
                } else {
                    const callSummary = summarise_tool_call(toolCall.name, toolCall.args);
                    emit_interim(session, 'step', `⚙️ ${toolCall.name}`, callSummary);
                }
            }

            const assistantMsg: Message = {
                id: uuidv4(),
                session_id: session.id,
                role: 'assistant',
                content: res.text || '',
                tool_calls: res.tools,
                created_at: new Date(),
                token_count: (res.text || '').length
            };
            history.push(assistantMsg);
            await io_append_message_to_session_log(session.id, assistantMsg);

            const toolResults = await dispatch_tool_calls_parallel(res.tools);

            // Emit result events after execution so the UI updates with outcomes
            for (let i = 0; i < toolResults.length; i++) {
                const tName = res.tools[i].name;
                if (tName !== 'think') {
                    const resultSummary = summarise_tool_result(tName, toolResults[i].result);
                    if (resultSummary) emit_interim(session, 'result', `✓ ${tName}`, resultSummary);
                }
            }

            history = inject_tool_results_into_context(history, res.tools, toolResults);

            for (let i = 0; i < toolResults.length; i++) {
                const trMsg = build_tool_result_message(toolResults[i], res.tools[i]);
                await io_append_message_to_session_log(session.id, trMsg);
            }

            // Hot-reload skills into system prompt if build_skill was just called.
            const builtSkill = res.tools.some((t: any) => t.name === 'build_skill');
            if (builtSkill) {
                const refreshedSkills = io_list_installed_skills().filter(s => s.status === 'enabled');
                const refreshedBlock = assemble_skill_system_prompt_block(io_load_active_skill_contents(refreshedSkills));
                const baseRefreshed = build_system_context_prefix(
                    memCtx.heartbeat || null, memCtx.boot || null, memCtx.memory || null, refreshedBlock
                );
                const refreshedSystem = planBlock ? baseRefreshed + planBlock : baseRefreshed;
                currentPrompt = { ...currentPrompt, system: refreshedSystem, messages: history };
                console.log(`[Agent] Skills hot-reloaded after build_skill call.`);
            } else {
                currentPrompt = { ...currentPrompt, messages: history };
            }
        } else {
            if (res.text) {
                finalResponse = res.text;
                const assistantMsg: Message = {
                    id: uuidv4(), session_id: session.id, role: 'assistant',
                    content: finalResponse, created_at: new Date(), token_count: finalResponse.length
                };
                history.push(assistantMsg);
                await io_append_message_to_session_log(session.id, assistantMsg);
                console.log(`[Agent] Final reply (first 200): ${finalResponse.slice(0, 200).replace(/\n/g, '↵')}`);
            } else {
                // LLM returned empty text on its final turn (e.g. after a tool-only step).
                // The real response was already saved in the previous tool-call message via
                // lastPartialText — reuse it so we don't emit a duplicate or blank message.
                finalResponse = lastPartialText;
                console.log(`[Agent] Empty final text — reusing lastPartialText as response.`);
            }
            brokeClean = true;
            break;
        }
    }

    // Hit the iteration cap without a clean text exit
    if (!brokeClean && !finalResponse) {
        finalResponse = lastPartialText ||
            `Task required more than ${ACP_MAX_AGENT_ITERATIONS} steps and was stopped. Try breaking it into smaller parts.`;
        const capMsg: Message = {
            id: uuidv4(), session_id: session.id, role: 'assistant',
            content: finalResponse, created_at: new Date(), token_count: finalResponse.length
        };
        await io_append_message_to_session_log(session.id, capMsg);
        console.warn(`[Agent] Hit iteration cap (${ACP_MAX_AGENT_ITERATIONS} steps).`);
    }

    return { finalResponse, history };
}

export async function start_agent_run(session: Session, message: InternalMessage): Promise<AgentRunResult> {
    const runId = uuidv4();
    runStates.set(runId, { status: 'running' });
    console.log(`Started agent run ${runId}`);
    try {
        const providerName = process.env.AAOS_LLM_PROVIDER || 'google';
        const config = { plugins: { entries: { [providerName]: {} } } };
        if (pluginRegistry.size === 0) {
            const plugins = load_plugins_from_config(config);
            await Promise.all(plugins.map(initialize_plugin));
        }

        const workspace = process.env.AAOS_WORKSPACE ||
            require('path').join(process.env.HOME || process.env.USERPROFILE || '', '.aaos');
        load_model_config(workspace);  // refresh per-role config from disk on each run
        const memCtx = io_load_workspace_memory_files(workspace);
        const activeSkills = io_list_installed_skills().filter(s => s.status === 'enabled');
        const skillsBlock = assemble_skill_system_prompt_block(io_load_active_skill_contents(activeSkills));
        const systemPrefix = build_system_context_prefix(
            memCtx.heartbeat || null, memCtx.boot || null, memCtx.memory || null, skillsBlock
        );

        const tools = get_all_tool_definitions();

        // Load prior conversation history so the agent has full context across turns
        await io_initialize_session_log_file(session.id);
        const rawHistory = io_load_session_history(session.id, 50);

        // Sanitize history: cap individual oversized messages so stale tool results
        // from previous runs cannot blow up the context window (Gemini limit: 1M tokens).
        const MAX_MSG_CHARS   = 12000;  // per message content cap (~3k tokens each)
        const MAX_HIST_CHARS  = 80000;  // total history budget (~20k tokens)
        let historyChars = 0;
        const sanitizedHistory = rawHistory.map(msg => {
            let content = msg.content || '';
            if (content.length > MAX_MSG_CHARS) {
                const truncNote = `\n[...content truncated from ${content.length} to ${MAX_MSG_CHARS} chars to fit context window...]`;
                content = content.slice(0, MAX_MSG_CHARS) + truncNote;
            }
            return { ...msg, content };
        });
        // If total still exceeds budget, drop oldest messages until it fits
        const priorHistory: typeof sanitizedHistory = [];
        for (let i = sanitizedHistory.length - 1; i >= 0; i--) {
            const len = (sanitizedHistory[i].content || '').length;
            if (historyChars + len > MAX_HIST_CHARS) break;
            priorHistory.unshift(sanitizedHistory[i]);
            historyChars += len;
        }
        // Ensure history still starts with a user turn (Anthropic requirement)
        const firstUserIdx = priorHistory.findIndex(m => m.role === 'user');
        const safeHistory = firstUserIdx > 0 ? priorHistory.slice(firstUserIdx) : priorHistory;

        // If a file was attached, prepend context so the agent knows what to work with
        let userContent = message.content;
        if (message.attachment) {
            const att = message.attachment;
            const sizeStr = att.size > 1024 * 1024
                ? `${(att.size / 1024 / 1024).toFixed(1)} MB`
                : `${(att.size / 1024).toFixed(1)} KB`;
            let fileInstructions: string;
            // Use forward slashes in all paths given to the LLM — backslashes in Windows
            // paths require double-escaping in JSON and can be dropped by markdown renderers.
            const fwdPath = att.path.replace(/\\/g, '/');
            const titleSafe = att.name.replace(/\.[^.]+$/, '').replace(/[_]/g, '-');

            if (att.isImage) {
                fileInstructions = `IMPORTANT: Call analyze_image(path="${fwdPath}", prompt="<your question>") immediately to see and analyze this image. Do not say you cannot view images.`;
            } else if (att.mime.startsWith('video/')) {
                fileInstructions = `IMPORTANT: Call analyze_video(path="${fwdPath}", prompt="<your question>") immediately to analyze this video. Do NOT ask clarifying questions — start analyzing now. If the user's message is vague, use a general overview prompt.`;
            } else if (att.mime === 'application/pdf' || att.name.endsWith('.docx') || att.name.endsWith('.doc') || att.name.endsWith('.xlsx')) {
                fileInstructions = `IMPORTANT: Call wiki_ingest(source="${fwdPath}", title="${titleSafe}") immediately to extract and analyze this document. Do NOT use file_read or bash_exec on binary files.`;
            } else {
                fileInstructions = `Use file_read(path="${fwdPath}") to read the file contents (works for text, code, JSON, CSV, Markdown).`;
            }
            userContent = `[Attached file: ${att.name} (${sizeStr}, ${att.mime})\nFile path: ${fwdPath}\n${fileInstructions}]\n\n${message.content || 'Please analyze this file.'}`;
        }

        const userMsg: Message = { id: uuidv4(), session_id: session.id, role: 'user', content: userContent, created_at: new Date(), token_count: userContent.length };
        await io_append_message_to_session_log(session.id, userMsg);

        let history: Message[] = [...safeHistory, userMsg];
        // Resolve thinking budget from per-session level (default: auto = no budget injected)
        const sessionThinkingLevel = (session.thinking_level ?? 'auto') as ThinkingLevel;
        const thinkingBudget = thinking_level_to_budget(sessionThinkingLevel);
        const activity = message.content?.slice(0, 60).replace(/\n/g, ' ') || '(no message)';

        // ── Pipeline Stage 1: Intake ─────────────────────────────────────────
        emit_interim(session, 'step', '📥 Intake', 'Classifying task...');
        const intakeResult = await run_intake_stage(userContent, activity);

        let planBlock = '';
        let pipelineSystem = systemPrefix;
        let planResult: PlannerResult | null = null;

        if (!intakeResult.is_simple) {
            emit_interim(session, 'result', '📥 Intake',
                `${intakeResult.complexity} · ${intakeResult.sub_tasks.length} sub-task(s) · ${intakeResult.clarified_goal}`);

            // ── Pipeline Stage 2: Planner ────────────────────────────────────
            emit_interim(session, 'step', '📋 Planner', 'Sequencing steps...');
            planResult = await run_planner_stage(intakeResult, tools.map(t => t.name), activity);
            planBlock = [
                '\n## ACTIVE TASK PLAN (follow these steps in order)',
                `Goal: ${intakeResult.clarified_goal}`,
                planResult.steps.map(s =>
                    `${s.order}. ${s.action}${s.tool ? ` [tool: ${s.tool}]` : ''} → ${s.expected_output}`
                ).join('\n'),
                '\nMark each step complete before moving to the next.\n',
            ].join('\n');
            pipelineSystem = systemPrefix + planBlock;
            emit_interim(session, 'result', '📋 Planner',
                `${planResult.steps.length} step(s): ${planResult.plan_summary}`);
        } else {
            emit_interim(session, 'result', '📥 Intake', 'Conversational — responding directly');
        }

        // ── Pipeline Stages 3 + 4: Execute → Verify (with one replan retry) ─
        //
        //  [Plan] → [Execute] → [Verify: PASS] → done
        //                  ↓
        //           [Verify: FAIL, replanned=false]
        //                  ↓
        //    set replanned=true, pass failure_reason
        //                  ↓
        //           [Replan] → [Execute] → [Verify: PASS] → done
        //                                ↓
        //                         [Verify: FAIL, replanned=true]
        //                                ↓
        //                         escalate to user
        // ─────────────────────────────────────────────────────────────────────
        let verifiedResponse = '';

        if (!intakeResult.is_simple) {
            // ── First attempt ─────────────────────────────────────────────────
            const exec1 = await run_executor_loop(
                session, history, pipelineSystem, planBlock, tools, thinkingBudget, activity, memCtx
            );
            emit_interim(session, 'step', '✅ Verifier', 'Checking output against original goal...');
            const verify1 = await run_verifier_stage(intakeResult.clarified_goal, exec1.finalResponse, activity);
            emit_interim(session, 'result', '✅ Verifier',
                verify1.passed
                    ? `Score ${verify1.score}/10 — goal achieved`
                    : `Score ${verify1.score}/10 — ${verify1.issues.slice(0, 2).join('; ')}`);

            if (verify1.passed) {
                // ✅ First attempt passed — done
                verifiedResponse = verify1.final_answer || exec1.finalResponse;
            } else {
                // ❌ First attempt failed — replan and retry once
                emit_interim(session, 'step', '🔄 Replanner', 'Revising plan based on failure...');
                const replanResult = await run_replan_stage(
                    intakeResult, planResult!, verify1.issues, tools.map(t => t.name), activity
                );
                const replanBlock = [
                    '\n## REVISED TASK PLAN (previous attempt failed — follow this revised plan)',
                    `Goal: ${intakeResult.clarified_goal}`,
                    replanResult.steps.map(s =>
                        `${s.order}. ${s.action}${s.tool ? ` [tool: ${s.tool}]` : ''} → ${s.expected_output}`
                    ).join('\n'),
                    '\nMark each step complete before moving to the next.\n',
                ].join('\n');
                const replanSystem = systemPrefix + replanBlock;
                emit_interim(session, 'result', '🔄 Replanner',
                    `${replanResult.steps.length} revised step(s): ${replanResult.plan_summary}`);

                // ── Second attempt with revised plan ──────────────────────────
                const exec2 = await run_executor_loop(
                    session, exec1.history, replanSystem, replanBlock, tools, thinkingBudget, activity, memCtx
                );
                emit_interim(session, 'step', '✅ Verifier', 'Re-checking revised output...');
                const verify2 = await run_verifier_stage(intakeResult.clarified_goal, exec2.finalResponse, activity);
                emit_interim(session, 'result', '✅ Verifier',
                    verify2.passed
                        ? `Score ${verify2.score}/10 — goal achieved after replan`
                        : `Score ${verify2.score}/10 — could not resolve: ${verify2.issues.slice(0, 2).join('; ')}`);

                if (verify2.passed) {
                    // ✅ Second attempt passed after replan — done
                    verifiedResponse = verify2.final_answer || exec2.finalResponse;
                } else {
                    // ❌ Second attempt also failed — escalate to user
                    verifiedResponse = [
                        `⚠️ I was unable to fully complete this task even after replanning.`,
                        ``,
                        `**Goal:** ${intakeResult.clarified_goal}`,
                        ``,
                        `**Remaining issues:**`,
                        verify2.issues.map(i => `- ${i}`).join('\n'),
                        ``,
                        `**Best result I could produce:**`,
                        exec2.finalResponse,
                        ``,
                        `Please review the issues above and clarify your request or provide additional context.`,
                    ].join('\n');
                    emit_interim(session, 'result', '⚠️ Escalated',
                        'Could not satisfy goal after replan — escalating to you');
                }
            }
        } else {
            // Simple / conversational task — executor only, no verify/replan overhead
            const exec = await run_executor_loop(
                session, history, pipelineSystem, planBlock, tools, thinkingBudget, activity, memCtx
            );
            verifiedResponse = exec.finalResponse;
        }

        // ── Pipeline Stage 5: Memory Update (emit hint — actual write below) ─
        if (!intakeResult.is_simple) {
            emit_interim(session, 'step', '🧠 Memory', 'Storing what was learned...');
        }

        // Sanitize artefacts that must never reach the user or be stored in history.
        // "No response generated." was a historic fallback string; strip it wherever
        // the LLM may have echoed it from earlier (now-cleaned) session logs.
        verifiedResponse = verifiedResponse.replace(/\n?No response generated\.$/g, '').trimEnd();

        // Replace /snapshots/filename URLs with inline base64 data URIs before sending
        // to the browser. This bypasses HTTP entirely — the image is embedded in the
        // WebSocket message itself. The session log keeps the compact URL.
        let displayResponse = await embed_snapshot_images(verifiedResponse, workspace);

        // If an image was uploaded, also embed it in the reply if the LLM references the path
        if (message.attachment?.isImage) {
            const att = message.attachment;
            try {
                const data = fs.readFileSync(att.path);
                const dataUri = `data:${att.mime};base64,${data.toString('base64')}`;
                displayResponse = displayResponse.split(att.path).join(dataUri);
            } catch { /* ignore */ }
        }

        await deliver_text_response_to_channel(session, displayResponse);

        // Auto-extract facts from this turn in the background (Stage 5: Memory Update)
        extract_and_persist_memory_facts(message.content, verifiedResponse, workspace)
            .catch(e => console.warn(`[Memory] Background extraction error: ${e.message}`));

        return { finalResponse: verifiedResponse };
    } catch (e: any) {
        // ── Classify the error and deliver a human-readable message to the chat ──
        const errMsg = build_llm_error_message(e);
        console.error(`[Agent] Run ${runId} failed: ${e?.message || e}`);
        try {
            await deliver_text_response_to_channel(session, errMsg);
        } catch { /* best-effort — don't throw if delivery itself fails */ }
        return { finalResponse: errMsg };
    } finally {
        runStates.delete(runId);
    }
}

/**
 * Convert a raw LLM API error into a friendly, actionable message for the user.
 */
function build_llm_error_message(e: any): string {
    const raw   = String(e?.message || e || 'Unknown error');
    const status = e?.status ?? e?.statusCode ?? e?.code;

    // ── Google Vertex AI — 403 PERMISSION_DENIED ───────────────────────────────
    if (raw.includes('PERMISSION_DENIED') || raw.includes('"code":403') || status === 403) {
        const project = process.env.VERTEX_PROJECT_ID || 'd-sxd110x-ssd1-cdl';
        return [
            `⚠️ **LLM Error — Google Vertex AI permission denied** (HTTP 403)`,
            ``,
            `Your Google Cloud project **\`${project}\`** does not have permission to call Vertex AI.`,
            ``,
            `**Quick fix — switch to Anthropic Claude:**`,
            `1. Get an API key at https://console.anthropic.com`,
            `2. Add to your \`.env\` file:`,
            `   \`\`\``,
            `   AAOS_LLM_PROVIDER=anthropic`,
            `   ANTHROPIC_API_KEY=sk-ant-...`,
            `   \`\`\``,
            `3. Restart AAOS`,
            ``,
            `**Or fix Vertex AI access:**`,
            `- Enable the Vertex AI API: https://console.cloud.google.com/apis/library/aiplatform.googleapis.com`,
            `- Grant your service account the \`Vertex AI User\` role`,
            `- Verify \`GOOGLE_APPLICATION_CREDENTIALS\` points to the correct service account JSON`,
        ].join('\n');
    }

    // ── 401 Unauthorized / Unauthenticated ────────────────────────────────────
    if (raw.includes('UNAUTHENTICATED') || raw.includes('"code":401') || status === 401) {
        const provider = process.env.AAOS_LLM_PROVIDER || 'google';
        return [
            `⚠️ **LLM Error — Authentication failed** (HTTP 401)`,
            ``,
            `Provider: \`${provider}\``,
            ``,
            `Check that your API key / credentials are set correctly in \`.env\`:`,
            provider === 'anthropic'
                ? '- `ANTHROPIC_API_KEY=sk-ant-...`'
                : '- `GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json`',
        ].join('\n');
    }

    // ── 429 Rate limit ────────────────────────────────────────────────────────
    if (raw.includes('RESOURCE_EXHAUSTED') || raw.includes('Resource exhausted') || raw.includes('"code":429') || status === 429) {
        const provider = process.env.AAOS_LLM_PROVIDER || 'google';
        const isGoogle = provider === 'google' || provider === 'anthropic-vertex';
        return [
            `⚠️ **LLM Error — API quota exhausted** (HTTP 429)`,
            ``,
            `Provider \`${provider}\` is rate-limiting requests. This is usually caused by:`,
            `- A scheduled job running too frequently (e.g. every minute)`,
            `- Hitting the free-tier daily token or request cap`,
            ``,
            `**Quick fixes:**`,
            `1. Delete any frequent scheduled jobs (🗓 Scheduler tab → 🗑 Delete)`,
            `2. Switch provider: set \`AAOS_LLM_PROVIDER=anthropic\` in \`.env\` and restart`,
            isGoogle ? `3. Check quota: https://console.cloud.google.com/apis/api/aiplatform.googleapis.com/quotas?project=${process.env.VERTEX_PROJECT_ID || 'd-sxd110x-ssd1-cdl'}` : `3. Check usage at your provider's console`,
            ``,
            `AAOS will retry automatically in 15–30 seconds if you send your message again.`,
        ].join('\n');
    }

    // ── 404 Model not found ───────────────────────────────────────────────────
    if (raw.includes('"code":404') || status === 404) {
        const model = process.env.VERTEX_MODEL || process.env.ANTHROPIC_MODEL || 'unknown';
        return [
            `⚠️ **LLM Error — Model not found** (HTTP 404)`,
            ``,
            `Model \`${model}\` was not found on the provider's API.`,
            `Check that \`VERTEX_MODEL\` or \`ANTHROPIC_MODEL\` is set to a valid model name.`,
        ].join('\n');
    }

    // ── Generic fallback ──────────────────────────────────────────────────────
    return `⚠️ **LLM Error**\n\n${raw.slice(0, 500)}\n\nCheck the server logs for the full stack trace.`;
}

export function pause_agent_run(runId: string): void {
    const s = runStates.get(runId);
    if (s) s.status = 'paused';
}

export function resume_agent_run(runId: string): void {
    const s = runStates.get(runId);
    if (s) s.status = 'running';
}

export function cancel_agent_run(runId: string): void {
    const s = runStates.get(runId);
    if (s) s.status = 'cancelled';
}

export async function chain_agent_run_stages(stages: AgentStage[]): Promise<AgentRunResult> {
    if (stages.length > ACP_MAX_PIPELINE_STAGES) throw new PipelineLimitError();
    let prevOut: StageOutput | null = null;
    for (const stage of stages) {
        prevOut = await stage.fn(transform_stage_output_to_next_input(prevOut));
    }
    return { finalResponse: "done" };
}

export function transform_stage_output_to_next_input(output: StageOutput | null): StageInput {
    return { data: output ? output.data : null };
}
