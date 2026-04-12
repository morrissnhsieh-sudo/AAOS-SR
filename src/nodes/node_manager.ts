import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { validate_device_jwt } from '../auth/auth_manager';

export interface Node { id: string; address: string; status: 'connected' | 'disconnected' | 'degraded'; paired_at?: Date; last_seen_at?: Date; }
export interface AgentTask { id: string; payload: any; }
export interface TaskResult { id: string; success: boolean; data: any; }
export interface AggregatedResult { results: TaskResult[]; }

export const NODE_TASK_TIMEOUT_MS = 30000;
const nodeRegistry = new Map<string, Node>();

export async function io_receive_node_registration(req: Request, res: Response): Promise<void> {
    const { identity_token, node_address } = req.body;
    if (!validate_node_identity(identity_token)) { res.status(401).json({ reason: 'Invalid identity token' }); return; }
    const node = register_node(node_address);
    res.status(200).json({ node_id: node.id, status: node.status });
}

export function validate_node_identity(identityToken: string): boolean {
    const secret = process.env.JWT_SECRET || 'secret';
    const payload = validate_device_jwt(identityToken, secret);
    return payload !== null && payload.role === 'node';
}

export function register_node(address: string): Node {
    const node: Node = { id: uuidv4(), address, status: 'connected', paired_at: new Date(), last_seen_at: new Date() };
    nodeRegistry.set(node.id, node);
    monitor_node_connection(node);
    return node;
}

export function monitor_node_connection(node: Node): void {
    // Monitor loop logic, e.g. ping
}

export function select_available_node(): Node | null {
    for (const [_, node] of nodeRegistry.entries()) {
        if (node.status === 'connected') return node;
    }
    return null;
}

export async function io_dispatch_task_to_node(node: Node, task: AgentTask): Promise<string> {
    const dispatchId = uuidv4();
    // Dispatch over WS logic
    return dispatchId;
}

export async function io_await_node_task_result(dispatchId: string, timeoutMs: number): Promise<TaskResult> {
    return new Promise((resolve, reject) => {
        setTimeout(() => reject(new Error('Task timeout')), timeoutMs);
    });
}

export function aggregate_node_results(results: TaskResult[]): AggregatedResult {
    return { results };
}
