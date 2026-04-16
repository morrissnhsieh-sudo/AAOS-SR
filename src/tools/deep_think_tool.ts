/**
 * deep_think_tool.ts
 *
 * Registers two cooperative tools that give AAOS autonomous problem-solving:
 *
 *   problem_solve   — Phase 1: analyse the problem and emit a structured,
 *                     step-by-step plan with explicit verification criteria.
 *
 *   verify_solution — Phase 2: evaluate whether executed steps actually fixed
 *                     the problem.  Must be called ≥ 2 times (two independent
 *                     verification cycles) before a problem is declared solved.
 *                     If a cycle fails the agent revises the plan and retries.
 *
 * Flow enforced by tool descriptions + _next fields:
 *
 *   problem_solve()
 *     └─► execute steps with available tools
 *           └─► verify_solution(cycle=1)  ← checks evidence
 *                 ├─ PASSED ──► verify_solution(cycle=2)  ← double-check
 *                 │                ├─ PASSED ──► solved ✅
 *                 │                └─ FAILED ──► problem_solve(previous_attempt=…)
 *                 └─ FAILED ──► problem_solve(previous_attempt=…) ──► retry loop
 */

import { register_tool, get_all_tool_definitions } from './tool_dispatcher';
import { invoke_for_role, LlmPrompt } from '../plugins/plugin_engine';
import { v4 as uuidv4 } from 'uuid';

// ─── Prompts ──────────────────────────────────────────────────────────────────

const PLANNER_SYSTEM = `\
You are the planning module of an autonomous AI assistant called AAOS.
Your job: analyse the given problem and produce a precise, executable plan.

Respond with ONLY valid JSON — no markdown fences, no commentary:
{
  "problem_analysis": "1–2 sentences: what is wrong and why",
  "root_cause": "the single most likely root cause",
  "steps": [
    {
      "id": 1,
      "action": "Exact instruction — name the tool and parameters. E.g. 'Call bash_exec(command=\"systemctl status postgresql\")' or 'Call file_read(path=\"~/.aaos/.env\") and look for DB_URL'",
      "verification": "Observable, binary criterion that proves THIS step succeeded. E.g. 'Output contains active (running)'"
    }
  ],
  "success_criteria": [
    "High-level observable test 1 that proves the whole problem is solved",
    "High-level observable test 2"
  ]
}

Rules:
- At most 5 steps.
- Step actions must name the exact AAOS tool to call.
- Verification criteria must be measurable — avoid vague phrases like "it works".
- If a previous attempt failed, analyse those failures and change your approach.`;

const VERIFIER_SYSTEM = `\
You are the verification module of an autonomous AI assistant called AAOS.
Your job: judge whether the executed plan steps actually solved the problem.

Respond with ONLY valid JSON — no markdown fences, no commentary:
{
  "verdict": "PASSED" | "FAILED" | "PARTIAL",
  "passed_steps": [1, 3],
  "failed_steps": [
    {
      "step_id": 2,
      "expected": "what the verification criterion required",
      "actual": "what the evidence shows instead",
      "suggested_fix": "specific, actionable fix for this step only"
    }
  ],
  "overall_assessment": "1–2 sentences summarising the state",
  "unresolved_issues": ["remaining issue 1", "remaining issue 2"]
}

Verdict rules:
- PASSED  → every step's evidence meets its verification criterion AND success_criteria are met.
- PARTIAL → some steps passed but at least one failed, or success criteria partially met.
- FAILED  → most or all steps failed, or the core problem is unchanged.`;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract the first JSON object from an LLM text response. */
function extract_json(text: string): any {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`No JSON object found in response: ${text.slice(0, 200)}`);
    return JSON.parse(match[0]);
}

/** In-memory store: plan_id → plan data (lives for the duration of the server process). */
const planStore = new Map<string, { plan: any; created: number }>();

// ─── Registration ─────────────────────────────────────────────────────────────

export function register_deep_think_tool(): void {

    // ── Tool 1: problem_solve ─────────────────────────────────────────────────
    register_tool(
        {
            name: 'problem_solve',
            description:
                'PHASE 1 of autonomous problem solving. ' +
                'Call this whenever you face an error, failure, or complex problem you cannot ' +
                'immediately resolve. It analyses the problem and returns a numbered, ' +
                'step-by-step plan where every step has an explicit verification criterion. ' +
                '\n\nMANDATORY WORKFLOW after receiving the plan:\n' +
                '  1. Execute EVERY step in order using the specified tools.\n' +
                '  2. Collect the result of each step.\n' +
                '  3. Call verify_solution(cycle=1, ...) with the evidence.\n' +
                '  4. If cycle 1 passes → call verify_solution(cycle=2, ...) for mandatory double-check.\n' +
                '  5. If any cycle fails → call problem_solve(previous_attempt=...) for a revised plan.\n' +
                'Minimum 2 successful verification cycles are required before declaring the problem solved.',
            parameters: {
                type: 'object',
                properties: {
                    problem: {
                        type: 'string',
                        description:
                            'What went wrong. Include: what you were doing, what happened, ' +
                            'exact error messages, and what you have already tried.',
                    },
                    context: {
                        type: 'string',
                        description:
                            'Optional: relevant code, file contents, tool outputs, configuration ' +
                            'snippets, or environment details that help diagnose the problem.',
                    },
                    previous_attempt: {
                        type: 'string',
                        description:
                            'If this is a re-plan after a failed verification cycle, describe ' +
                            'what was tried and exactly what failed. The planner will avoid ' +
                            'repeating the same approach.',
                    },
                },
                required: ['problem'],
            },
        },
        async (args: { problem: string; context?: string; previous_attempt?: string }) => {
            // Inject current tool list so planner never hallucinates non-existent tools
            const availableTools = get_all_tool_definitions()
                .map(t => `  - ${t.name}: ${t.description.split('.')[0]}`)
                .join('\n');
            const systemWithTools = PLANNER_SYSTEM +
                `\n\nAVAILABLE TOOLS (use ONLY these — never invent tool names):\n${availableTools}`;

            // Build prompt
            let userContent = `## Problem\n${args.problem}`;
            if (args.context)          userContent += `\n\n## Context\n${args.context}`;
            if (args.previous_attempt) userContent += `\n\n## Previous Attempt (failed — do NOT repeat)\n${args.previous_attempt}`;

            const prompt: LlmPrompt = {
                system: systemWithTools,
                messages: [{ role: 'user', content: userContent }],
                thinking_budget: 6_000,
            };

            console.log('[problem_solve] Generating plan via thinker model…');
            const start = Date.now();
            let response;
            try {
                response = await invoke_for_role('thinker', prompt, 'problem_solve:plan');
            } catch (e: any) {
                return { error: `Planner model failed: ${e.message}` };
            }

            let plan: any;
            try {
                plan = extract_json(response.text || '');
            } catch (e: any) {
                return { error: `Could not parse plan JSON: ${e.message}`, raw: response.text?.slice(0, 500) };
            }

            const plan_id = uuidv4().slice(0, 8);
            planStore.set(plan_id, { plan, created: Date.now() });
            console.log(`[problem_solve] Plan ${plan_id} created in ${((Date.now() - start) / 1000).toFixed(1)}s with ${plan.steps?.length ?? 0} steps`);

            const stepList = (plan.steps ?? [])
                .map((s: any) => `  Step ${s.id}: ${s.action}\n           ✓ verify: ${s.verification}`)
                .join('\n');

            return {
                plan_id,
                problem_analysis:   plan.problem_analysis,
                root_cause:         plan.root_cause,
                steps:              plan.steps,
                success_criteria:   plan.success_criteria,
                _next:
                    `REQUIRED — follow this workflow exactly:\n` +
                    `\nPLAN ${plan_id} (${plan.steps?.length ?? 0} steps):\n${stepList}\n` +
                    `\n1. Execute each step above using the named tools.\n` +
                    `2. After ALL steps are done, call:\n` +
                    `   verify_solution(plan_id="${plan_id}", cycle=1, evidence=[{step_id, action_taken, result}, …])\n` +
                    `3. If cycle=1 PASSES → call verify_solution(plan_id="${plan_id}", cycle=2, evidence=[…]) for double confirmation.\n` +
                    `4. If any cycle FAILS → call problem_solve(problem="…", previous_attempt="…") for a revised plan.\n` +
                    `Do NOT skip steps. Do NOT skip verification. Minimum 2 verification cycles.`,
            };
        }
    );

    // ── Tool 2: verify_solution ───────────────────────────────────────────────
    register_tool(
        {
            name: 'verify_solution',
            description:
                'PHASE 2 of autonomous problem solving. ' +
                'Evaluates whether the executed plan steps actually solved the problem. ' +
                '\n\nRules:\n' +
                '  • MUST be called at least TWICE (cycle=1 then cycle=2) for every problem.\n' +
                '  • Provide evidence for every step: what tool was called, what it returned.\n' +
                '  • If verdict is FAILED or PARTIAL → call problem_solve with previous_attempt.\n' +
                '  • Only after cycle=2 PASSED is the problem considered solved.',
            parameters: {
                type: 'object',
                properties: {
                    plan_id: {
                        type: 'string',
                        description: 'The plan_id returned by problem_solve.',
                    },
                    cycle: {
                        type: 'number',
                        description: 'Verification cycle number. Start at 1, then 2 (mandatory). Use 3+ if re-plan was needed.',
                    },
                    evidence: {
                        type: 'array',
                        description:
                            'Array of objects describing what happened for each plan step: ' +
                            '[{step_id: 1, action_taken: "called bash_exec(…)", result: "output was …"}, …]',
                        items: {
                            type: 'object',
                            properties: {
                                step_id:      { type: 'number' },
                                action_taken: { type: 'string' },
                                result:       { type: 'string' },
                            },
                        },
                    },
                    overall_state: {
                        type: 'string',
                        description: 'Optional: current system state / any additional observations.',
                    },
                },
                required: ['plan_id', 'cycle', 'evidence'],
            },
        },
        async (args: {
            plan_id: string;
            cycle: number;
            evidence: Array<{ step_id: number; action_taken: string; result: string }>;
            overall_state?: string;
        }) => {
            // Retrieve stored plan for context
            const stored = planStore.get(args.plan_id);
            const planSummary = stored
                ? JSON.stringify(stored.plan, null, 2)
                : `(plan ${args.plan_id} not found in memory — use the evidence alone)`;

            let userContent =
                `## Original Plan\n${planSummary}\n\n` +
                `## Verification Cycle: ${args.cycle}\n\n` +
                `## Evidence (what was executed and what happened)\n` +
                args.evidence
                    .map(e => `Step ${e.step_id}:\n  action: ${e.action_taken}\n  result: ${e.result}`)
                    .join('\n\n');

            if (args.overall_state) {
                userContent += `\n\n## Current System State\n${args.overall_state}`;
            }

            const prompt: LlmPrompt = {
                system: VERIFIER_SYSTEM,
                messages: [{ role: 'user', content: userContent }],
                thinking_budget: 4_000,
            };

            console.log(`[verify_solution] Cycle ${args.cycle} for plan ${args.plan_id}…`);
            const start = Date.now();
            let response;
            try {
                response = await invoke_for_role('thinker', prompt, `verify_solution:cycle${args.cycle}`);
            } catch (e: any) {
                return { error: `Verifier model failed: ${e.message}` };
            }

            let verification: any;
            try {
                verification = extract_json(response.text || '');
            } catch (e: any) {
                return { error: `Could not parse verification JSON: ${e.message}`, raw: response.text?.slice(0, 500) };
            }

            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            console.log(`[verify_solution] Cycle ${args.cycle} verdict=${verification.verdict} in ${elapsed}s`);

            // ── Generate _next instruction based on verdict + cycle ──────────
            const plan_id = args.plan_id;
            let next: string;

            if (verification.verdict === 'PASSED') {
                if (args.cycle < 2) {
                    next =
                        `✅ Cycle ${args.cycle} PASSED.\n` +
                        `REQUIRED: A second independent verification cycle is mandatory.\n` +
                        `Call verify_solution(plan_id="${plan_id}", cycle=2, evidence=[…]) ` +
                        `with fresh evidence confirming the fix is still in place.`;
                } else {
                    next =
                        `✅✅ Both verification cycles PASSED. Problem is confirmed solved.\n` +
                        `Present a clear solution summary to the user explaining:\n` +
                        `  • What the root cause was\n` +
                        `  • What was done to fix it\n` +
                        `  • How you confirmed it works (evidence from both cycles)`;
                }
            } else {
                // FAILED or PARTIAL
                const failedSteps = (verification.failed_steps ?? [])
                    .map((f: any) => `  Step ${f.step_id}: expected "${f.expected}", got "${f.actual}". Fix: ${f.suggested_fix}`)
                    .join('\n');

                next =
                    `❌ Cycle ${args.cycle} ${verification.verdict}.\n` +
                    `Failed steps:\n${failedSteps || '  (see overall_assessment)'}\n\n` +
                    `REQUIRED: Revise and retry.\n` +
                    `Call problem_solve(\n` +
                    `  problem="<original problem>",\n` +
                    `  previous_attempt="Cycle ${args.cycle} failed. ${verification.overall_assessment} ` +
                    `Failed steps: ${JSON.stringify(verification.failed_steps ?? [])}"\n` +
                    `) to generate a revised plan, then execute it and verify again.`;
            }

            return {
                plan_id,
                cycle:               args.cycle,
                verdict:             verification.verdict,
                passed_steps:        verification.passed_steps   ?? [],
                failed_steps:        verification.failed_steps   ?? [],
                overall_assessment:  verification.overall_assessment,
                unresolved_issues:   verification.unresolved_issues ?? [],
                elapsed_seconds:     parseFloat(elapsed),
                _next:               next,
            };
        }
    );
}
