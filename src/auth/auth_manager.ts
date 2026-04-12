import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';

export const JWT_ALGORITHM = 'HS256';
export const LINE_SIGNATURE_HEADER = 'x-line-signature';

export interface DeviceTokenPayload { deviceId: string; role?: string; }
export interface ValidationResult { valid: boolean; reason?: string; }
export interface FileAttachment {
    name: string;       // original filename
    path: string;       // absolute path on server disk
    size: number;       // bytes
    mime: string;       // MIME type
    isImage: boolean;   // true for image/* types
}

export interface InternalMessage {
    id: string;
    session_id: string;
    role: 'user' | 'assistant' | 'tool' | 'system';
    content: string;
    attachment?: FileAttachment;
    tool_name?: string;
    tool_call_id?: string;
    created_at: Date;
    token_count: number;
}
export interface RawMessage { raw: string; source: string; session_id: string; }

export function generate_device_jwt(deviceId: string, secret: string): string {
    return jwt.sign({ deviceId }, secret, { algorithm: JWT_ALGORITHM });
}

export function validate_device_jwt(token: string, secret: string): DeviceTokenPayload | null {
    try {
        return jwt.verify(token, secret) as DeviceTokenPayload;
    } catch (e) {
        return null;
    }
}

export function validate_admin_role(payload: DeviceTokenPayload): boolean {
    return payload.role === 'admin';
}

export function validate_line_signature(body: string, signature: string, secret: string): boolean {
    const hash = crypto.createHmac('sha256', secret).update(body).digest('base64');
    try {
        return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
    } catch {
        return false;
    }
}

export function validate_internal_message(msg: unknown): ValidationResult {
    const message = msg as any;
    if (!message || typeof message !== 'object') return { valid: false, reason: 'Payload must be an object' };
    if (typeof message.id !== 'string') return { valid: false, reason: 'Missing integer or string id' };
    if (typeof message.content !== 'string') return { valid: false, reason: 'Missing content' };
    return { valid: true };
}

export function transform_to_internal_message(raw: RawMessage, channel: string): InternalMessage {
    return { 
        id: uuidv4(), 
        session_id: raw.session_id, 
        role: 'user', 
        content: raw.raw, 
        created_at: new Date(), 
        token_count: raw.raw.length // Simplistic token counting
    };
}
