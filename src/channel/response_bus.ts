import { EventEmitter } from 'events';

/**
 * Decoupled response bus to break the circular dependency
 * between agent_runner.ts and channel_manager.ts.
 *
 * agent_runner emits 'response' events here.
 * channel_manager listens and delivers via WebSocket.
 *
 * @traces FR-013, AC-012
 */
export const responseBus = new EventEmitter();

export interface ResponseEvent {
    sessionId: string;
    text: string;
}

/**
 * Interim events are emitted during an agent run — before the final response.
 * Types:
 *   'thinking' — the agent's private reasoning from the `think` tool
 *   'step'     — a tool call being executed (name + args summary)
 *   'result'   — the outcome of a tool call (brief, not raw output)
 */
export type InterimType = 'thinking' | 'step' | 'result';

export interface InterimEvent {
    sessionId: string;
    kind: InterimType;
    label: string;    // short title shown in the UI header
    text: string;     // body text
}
