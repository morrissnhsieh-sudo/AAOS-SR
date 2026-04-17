/**
 * AAOS A2A (Agent-to-Agent) Protocol Bridge
 *
 * Enables AAOS retail agents to delegate sub-tasks to external specialist agents
 * using the Google A2A protocol — supporting federated multi-agent topologies.
 *
 * Registers two tools:
 *   - a2a_delegate  : delegate a task to a specific named agent
 *   - a2a_broadcast : broadcast a task to all enabled A2A agents
 *
 * Agent registry is loaded from: {AAOS_WORKSPACE}/retail/a2a_agents.json
 */
import * as fs   from 'fs';
import * as path from 'path';
import * as os   from 'os';
import { register_tool } from './tool_dispatcher';

// ── Types ──────────────────────────────────────────────────────────────────────

interface A2AAgent {
    id:       string;
    name:     string;
    endpoint: string;
    skills:   string[];
    enabled:  boolean;
}

interface A2ADelegateResult {
    agent_id:   string;
    result:     any;
    latency_ms: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function get_workspace(): string {
    return process.env.AAOS_WORKSPACE ||
        path.join(os.homedir(), '.aaos');
}

function load_agent_registry(): A2AAgent[] {
    const registryPath = path.join(get_workspace(), 'retail', 'a2a_agents.json');
    try {
        const raw = fs.readFileSync(registryPath, 'utf8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

/**
 * POST a task to an A2A endpoint and poll for the result.
 * Returns the result or throws on timeout.
 */
async function invoke_a2a_agent(
    endpoint: string,
    agentId: string,
    task: string,
    context?: object,
    timeoutMs = 30000
): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        // Submit task
        const submitRes = await fetch(`${endpoint}/a2a`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ agent_id: agentId, task, context }),
            signal:  controller.signal,
        });

        if (!submitRes.ok) {
            throw new Error(`A2A submit failed: HTTP ${submitRes.status}`);
        }

        const { task_id } = await submitRes.json() as { task_id: string };

        // Poll for result
        const pollInterval = 1000;
        const deadline = Date.now() + timeoutMs;

        while (Date.now() < deadline) {
            await new Promise(r => setTimeout(r, pollInterval));

            const pollRes = await fetch(`${endpoint}/a2a/${task_id}`, {
                signal: controller.signal,
            });

            if (!pollRes.ok) continue;

            const pollData = await pollRes.json() as { status: string; result?: any };

            if (pollData.status === 'completed') {
                return pollData.result;
            }
            if (pollData.status === 'error') {
                throw new Error(`A2A task ${task_id} failed on agent ${agentId}`);
            }
            // status === 'pending' | 'running' → keep polling
        }

        throw new Error(`A2A task timed out after ${timeoutMs}ms`);
    } finally {
        clearTimeout(timer);
    }
}

// ── Tool registration ──────────────────────────────────────────────────────────

export function register_a2a_tools(): void {

    // ── 1. a2a_delegate ───────────────────────────────────────────────────────

    register_tool(
        {
            name: 'a2a_delegate',
            description:
                'Delegate a natural-language task to a specific external A2A agent by its ID. ' +
                'Polls for the result and returns it when complete. ' +
                'Use to hand off specialised sub-tasks to dedicated retail agents ' +
                '(e.g. inventory-agent, demand-agent, loss-prevention-agent). ' +
                'Agent registry is loaded from {WORKSPACE}/retail/a2a_agents.json.',
            parameters: {
                type: 'object',
                properties: {
                    target_agent_id: {
                        type: 'string',
                        description: 'ID of the target agent, e.g. "demand-forecast-agent"'
                    },
                    task: {
                        type: 'string',
                        description: 'Natural language task description for the agent'
                    },
                    context: {
                        type: 'object',
                        description: 'Optional JSON context passed to the target agent'
                    },
                    timeout_ms: {
                        type: 'number',
                        description: 'Maximum wait time in milliseconds (default: 30000)'
                    }
                },
                required: ['target_agent_id', 'task']
            }
        },
        async (args: { target_agent_id: string; task: string; context?: object; timeout_ms?: number }) => {
            const agents = load_agent_registry();
            const agent  = agents.find(a => a.id === args.target_agent_id && a.enabled);

            if (!agent) {
                return {
                    ok: false,
                    error: `Agent "${args.target_agent_id}" not found or disabled in registry`,
                    available_agents: agents.filter(a => a.enabled).map(a => a.id),
                };
            }

            const start = Date.now();
            try {
                const result = await invoke_a2a_agent(
                    agent.endpoint,
                    args.target_agent_id,
                    args.task,
                    args.context,
                    args.timeout_ms ?? 30000
                );
                return {
                    ok:         true,
                    agent_id:   args.target_agent_id,
                    agent_name: agent.name,
                    result,
                    latency_ms: Date.now() - start,
                };
            } catch (err: any) {
                return {
                    ok:         false,
                    agent_id:   args.target_agent_id,
                    agent_name: agent.name,
                    error:      err.message,
                    latency_ms: Date.now() - start,
                };
            }
        }
    );

    // ── 2. a2a_broadcast ──────────────────────────────────────────────────────

    register_tool(
        {
            name: 'a2a_broadcast',
            description:
                'Broadcast a task to all enabled A2A agents in the registry and collect responses within 15 seconds. ' +
                'Returns an array of per-agent results including latency. ' +
                'Use for fanout queries where multiple specialist agents should all respond ' +
                '(e.g. "summarise your domain status for store TW-001").',
            parameters: {
                type: 'object',
                properties: {
                    task: {
                        type: 'string',
                        description: 'Natural language task to broadcast to all enabled agents'
                    },
                    context: {
                        type: 'object',
                        description: 'Optional JSON context passed to all agents'
                    }
                },
                required: ['task']
            }
        },
        async (args: { task: string; context?: object }) => {
            const agents  = load_agent_registry().filter(a => a.enabled);
            const timeout = 15000;

            if (agents.length === 0) {
                return {
                    ok:      false,
                    error:   'No enabled agents in registry',
                    results: [],
                };
            }

            const invocations = agents.map(async (agent): Promise<A2ADelegateResult> => {
                const start = Date.now();
                try {
                    const result = await invoke_a2a_agent(
                        agent.endpoint, agent.id, args.task, args.context, timeout
                    );
                    return { agent_id: agent.id, result, latency_ms: Date.now() - start };
                } catch (err: any) {
                    return { agent_id: agent.id, result: { error: err.message }, latency_ms: Date.now() - start };
                }
            });

            const results = await Promise.all(invocations);

            return {
                ok:           true,
                agents_count: agents.length,
                results,
                message:      `Broadcast complete — ${results.length} agent(s) responded`,
            };
        }
    );

    console.log('[A2A] Tools registered: a2a_delegate, a2a_broadcast');
}
