import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';
import { WebSocket } from 'ws';
import { validate_line_signature, validate_device_jwt, DeviceTokenPayload, InternalMessage, FileAttachment } from '../auth/auth_manager';
import { start_agent_run } from '../agent/agent_runner';
import { Session } from '../memory/memory_system';
import { ThinkingLevel } from '../plugins/plugin_engine';
import { responseBus, ResponseEvent, InterimEvent } from './response_bus';

export interface LineEvent { type: string; replyToken?: string; message?: { text: string }; source: { userId: string } }
export interface WsMessage { request_id: string; type: string; content: string; thinking_level?: ThinkingLevel; }
export interface WsEvent { type: string; event: string; payload: unknown; }
export interface WsResponse { request_id: string; type: string; content: string; status: string; }
export interface ChannelAdapter { type: string; }
export interface ChannelConnection { id: string; active: boolean; }

export const CHANNEL_LINE = 'line';
export const CHANNEL_WS = 'ws';
export const LINE_REPLY_URL = 'https://api.line.me/v2/bot/message/reply';

const sessionStore = new Map<string, Session>();
const wsClients = new Map<string, WebSocket>();
const lineReplyTokens = new Map<string, string>(); // sessionId -> lastReplyToken

// Deliver LLM responses back to the originating client
responseBus.on('response', (event: ResponseEvent) => {
    if (event.sessionId.startsWith(CHANNEL_WS)) {
        const clientId = event.sessionId.slice(CHANNEL_WS.length + 1);
        const response: WsResponse = { request_id: '', type: 'response', content: event.text, status: 'ok' };
        io_deliver_to_ws_client(clientId, response);
    } else if (event.sessionId.startsWith(CHANNEL_LINE)) {
        const userId = event.sessionId.slice(CHANNEL_LINE.length + 1);
        const token = lineReplyTokens.get(event.sessionId);
        if (token) {
            io_deliver_to_line(userId, event.text, token).catch(console.error);
            lineReplyTokens.delete(event.sessionId); // Reply tokens are single-use
        }
    }
});

// Stream interim events (thinking, steps, results) to WS clients in real-time
responseBus.on('interim', (event: InterimEvent) => {
    if (!event.sessionId.startsWith(CHANNEL_WS)) return;
    const clientId = event.sessionId.slice(CHANNEL_WS.length + 1);
    io_deliver_to_ws_client(clientId, {
        request_id: '',
        type: 'interim',
        content: JSON.stringify({ kind: event.kind, label: event.label, text: event.text }),
        status: 'ok'
    });
});

export async function io_receive_line_webhook(req: Request, res: Response): Promise<void> {
    const sig = req.headers['x-line-signature'] as string;
    const bodyStr = JSON.stringify(req.body);
    if (!validate_line_signature(bodyStr, sig, process.env.LINE_CHANNEL_SECRET || 'secret')) {
        res.status(401).json({ reason: 'Invalid signature' }); return;
    }

    io_ack_line_webhook(res);

    for (const event of req.body.events) {
        if (event.type === 'message' && event.message?.text) {
            const userId = event.source.userId;
            const sessionId = `${CHANNEL_LINE}:${userId}`;
            if (event.replyToken) {
                lineReplyTokens.set(sessionId, event.replyToken);
            }
            enqueue_line_message_for_processing(transform_line_event_to_message(event));
        }
    }
}

export function transform_line_event_to_message(event: LineEvent): InternalMessage {
    return { id: uuidv4(), session_id: event.source.userId, role: 'user', content: event.message?.text || '', created_at: new Date(), token_count: 0 };
}

export function validate_line_event_fields(event: LineEvent): { valid: boolean; reason?: string } {
    if (!event.source || !event.source.userId) return { valid: false, reason: 'No source' };
    return { valid: true };
}

export function io_ack_line_webhook(res: Response): void { res.status(200).send('OK'); }

export function enqueue_line_message_for_processing(m: InternalMessage): void {
    const session = route_message_to_session(m);
    start_agent_run(session, m).catch(console.error);
}

export function io_accept_ws_connection(ws: WebSocket, req: Request): void {
    const token = new URL(req.url || '', 'http://t').searchParams.get('token');
    const payload = validate_ws_device_token(token || '');
    if (!payload) { reject_expired_device_token(ws); return; }

    const clientId = payload.deviceId;
    wsClients.set(clientId, ws);

    ws.on('message', (data) => {
        const msg = io_read_ws_message(data.toString());
        if (msg) route_ws_message_to_session(msg, clientId);
    });
    ws.on('close', () => io_handle_ws_disconnect(clientId));
}

export function io_read_ws_message(raw: string): WsMessage | null {
    try { return JSON.parse(raw); } catch { return null; }
}

export function validate_ws_message_schema(msg: unknown): { valid: boolean; reason?: string } {
    return { valid: true };
}

export function route_ws_message_to_session(msg: WsMessage, clientId: string): void {
    const session = get_or_create_session(CHANNEL_WS, clientId);
    // Persist thinking level for the lifetime of this session (per-conversation)
    if (msg.thinking_level) session.thinking_level = msg.thinking_level;
    const internalMsg: InternalMessage = {
        id: uuidv4(),
        session_id: session.id,
        role: 'user',
        content: msg.content,
        attachment: (msg as any).attachment as FileAttachment | undefined,
        created_at: new Date(),
        token_count: 0
    };
    start_agent_run(session, internalMsg).catch(console.error);
}

export function io_push_ws_event(clients: WebSocket[], event: WsEvent): void {
    const str = JSON.stringify(event);
    clients.forEach(c => c.send(str));
}

export function io_handle_ws_disconnect(clientId: string): void {
    wsClients.delete(clientId);
}

export function get_or_create_session(channelId: string, userId: string): Session {
    const sid = `${channelId}:${userId}`;
    if (!sessionStore.has(sid)) sessionStore.set(sid, { id: sid, user_id: userId, last_active_at: new Date(), context_token_count: 0, status: 'active' });
    return sessionStore.get(sid)!;
}

export function update_session_last_active(sessionId: string): void {
    const s = sessionStore.get(sessionId);
    if (s) s.last_active_at = new Date();
}

export function route_message_to_session(m: InternalMessage): Session {
    return get_or_create_session(CHANNEL_LINE, m.session_id);
}

export function resolve_delivery_channel(s: Session): ChannelAdapter { return { type: s.id.split(':')[0] }; }

export async function io_deliver_to_line(userId: string, text: string, token: string): Promise<void> {
    const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    if (!accessToken) {
        console.error('Missing LINE_CHANNEL_ACCESS_TOKEN');
        return;
    }
    try {
        const response = await fetch(LINE_REPLY_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify({
                replyToken: token,
                messages: [{ type: 'text', text }]
            })
        });
        if (!response.ok) {
            const err = await response.text();
            throw new Error(`LINE API error: ${err}`);
        }
    } catch (e: any) {
        console.error(`Failed to deliver to LINE: ${e.message}`);
    }
}

export function io_deliver_to_ws_client(clientId: string, r: WsResponse): void {
    const ws = wsClients.get(clientId);
    if (ws) ws.send(JSON.stringify(r));
}

/**
 * Push a plain text message to ALL currently connected WebSocket clients.
 * Used by the scheduler engine to deliver job notifications and reminders.
 */
export function broadcast_to_all_ws(content: string): void {
    if (wsClients.size === 0) {
        console.warn('[Channel] broadcast_to_all_ws: no active WS clients — notification dropped');
        return;
    }
    const msg: WsResponse = { request_id: '', type: 'response', content, status: 'ok' };
    const str = JSON.stringify(msg);
    for (const ws of wsClients.values()) {
        try { ws.send(str); } catch { /* ignore closed sockets */ }
    }
}

export function validate_ws_device_token(t: string): DeviceTokenPayload | null { return validate_device_jwt(t, process.env.JWT_SECRET || 'secret'); }

export function reject_expired_device_token(ws: WebSocket): void {
    ws.close(4001, 'Unauthorized');
}

export function correlate_ws_response_to_request(id: string, r: WsResponse): WsResponse { r.request_id = id; return r; }

export function validate_ws_request_id_present(m: WsMessage): boolean { return !!m.request_id; }

export function broadcast_event_to_ws_clients(e: WsEvent): void {
    io_push_ws_event(Array.from(wsClients.values()), e);
}

export function build_ws_event_payload(type: string, payload: unknown): WsEvent { return { type: 'event', event: type, payload }; }

export function monitor_channel_connect_grace(c: ChannelConnection, graceMs: number): void {
    setTimeout(() => { if (!c.active) mark_channel_degraded(c.id); }, graceMs);
}

export function mark_channel_degraded(cid: string): void { console.warn(`Channel ${cid} degraded`); }
