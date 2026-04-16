import * as dotenv from 'dotenv';
dotenv.config();
import WebSocket from 'ws';
import * as jwt from 'jsonwebtoken';
import { generate_device_jwt } from '../auth/auth_manager';

const args = process.argv.slice(2);
const nodeId = args.includes('--id') ? args[args.indexOf('--id') + 1] : 'default-node';
const secret = process.env.JWT_SECRET || 'secret';
const GATEWAY_URL = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:3000/ws/chat';

// Sign a node-role JWT ??validate_node_identity requires role === 'node'
const nodeToken = jwt.sign({ deviceId: nodeId, role: 'node' }, secret, { algorithm: 'HS256' });
const wsUrl = `${GATEWAY_URL}?token=${nodeToken}`;

function connect(): void {
    console.log(`[${nodeId}] Connecting to USI AI\u2011OS\u00ae - Personal Assistant at ${GATEWAY_URL}...`);
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        console.log(`[${nodeId}] Connected to USI AI\u2011OS\u00ae - Personal Assistant.`);
    });

    ws.on('message', (data) => {
        console.log(`[${nodeId}] Received: ${data.toString()}`);
    });

    ws.on('error', (err) => {
        console.error(`[${nodeId}] WebSocket error: ${err.message}`);
    });

    ws.on('close', (code, reason) => {
        console.log(`[${nodeId}] Disconnected (code=${code}). Reconnecting in 5s...`);
        setTimeout(connect, 5000);
    });
}

connect();
