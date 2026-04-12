/**
 * AAOS IoT Manager
 * Handles: network discovery, device registry, MQTT connection pool, TCP I/O.
 */
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as child_process from 'child_process';
import * as mqtt from 'mqtt';

// ─── Types ──────────────────────────────────────────────────────────────────

export type DeviceType =
    | 'mqtt-broker'
    | 'ip-camera'
    | 'temperature-humidity-sensor'
    | 'rfid-reader'
    | 'digital-price-tag-gateway'
    | 'modbus-device'
    | 'smart-plug'
    | 'generic-http'
    | 'generic-tcp'
    | 'unknown';

export interface IoTDevice {
    id: string;           // primary key: ip:firstOpenPort
    ip: string;
    mac?: string;
    hostname?: string;
    type: DeviceType;
    openPorts: number[];
    mqttBroker?: string;  // broker URL if device is reachable via MQTT
    mqttTopics?: string[];
    metadata: Record<string, any>;
    firstSeen: string;
    lastSeen: string;
    status: 'online' | 'offline' | 'unknown';
}

export interface MqttMessage {
    topic: string;
    payload: string;
    ts: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Ports probed during a network scan, in order of IoT relevance */
const IOT_PORT_HINTS: Array<{ port: number; type: DeviceType | null }> = [
    { port: 1883,  type: 'mqtt-broker' },
    { port: 8883,  type: 'mqtt-broker' },
    { port: 554,   type: 'ip-camera' },
    { port: 8554,  type: 'ip-camera' },
    { port: 502,   type: 'modbus-device' },
    { port: 4196,  type: 'digital-price-tag-gateway' },
    { port: 10001, type: 'rfid-reader' },
    { port: 6001,  type: 'rfid-reader' },
    { port: 80,    type: null },
    { port: 8080,  type: null },
    { port: 8000,  type: null },
    { port: 443,   type: null },
    { port: 23,    type: null },
];

const PROBE_TIMEOUT_MS  = 350;
const SCAN_HOST_BATCH   = 24;   // concurrent hosts per scan wave
const MAX_MSG_BUFFER    = 100;  // messages buffered per topic
const DEVICE_REGISTRY   = path.join(
    process.env.AAOS_WORKSPACE || path.join(os.homedir(), '.aaos'),
    'iot', 'devices.json'
);

// ─── Device Registry ─────────────────────────────────────────────────────────

export function io_load_device_registry(): IoTDevice[] {
    try {
        return JSON.parse(fs.readFileSync(DEVICE_REGISTRY, 'utf8'));
    } catch {
        return [];
    }
}

function io_save_device_registry(devices: IoTDevice[]): void {
    const dir = path.dirname(DEVICE_REGISTRY);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DEVICE_REGISTRY, JSON.stringify(devices, null, 2), 'utf8');
}

export function io_upsert_device(device: IoTDevice): void {
    const all = io_load_device_registry();
    const idx = all.findIndex(d => d.id === device.id);
    if (idx >= 0) {
        all[idx] = { ...all[idx], ...device, lastSeen: new Date().toISOString() };
    } else {
        all.push(device);
    }
    io_save_device_registry(all);
}

export function io_update_device_status(id: string, status: IoTDevice['status']): void {
    const all = io_load_device_registry();
    const dev = all.find(d => d.id === id);
    if (dev) {
        dev.status = status;
        dev.lastSeen = new Date().toISOString();
        io_save_device_registry(all);
    }
}

// ─── Network Utilities ───────────────────────────────────────────────────────

/** Returns all /24 subnets this host is on (e.g. ["192.168.1", "172.30.48"]) */
export function get_local_subnets(): string[] {
    const subnets = new Set<string>();
    const ifaces = os.networkInterfaces();
    for (const iface of Object.values(ifaces)) {
        if (!iface) continue;
        for (const addr of iface) {
            if (addr.family !== 'IPv4' || addr.internal) continue;
            const parts = addr.address.split('.');
            if (parts[0] === '127') continue;
            subnets.add(`${parts[0]}.${parts[1]}.${parts[2]}`);
        }
    }
    return Array.from(subnets);
}

/** Reads the OS ARP table and returns known IPs on the LAN */
function read_arp_hosts(): string[] {
    try {
        const out = child_process.execSync('arp -a', { encoding: 'utf8', timeout: 3000 });
        const hosts: string[] = [];
        for (const line of out.split('\n')) {
            const m = line.match(/\s+([\d]+\.[\d]+\.[\d]+\.[\d]+)\s/);
            if (m && !m[1].endsWith('.255') && m[1] !== '127.0.0.1') {
                hosts.push(m[1]);
            }
        }
        return [...new Set(hosts)];
    } catch {
        return [];
    }
}

/** Probes a single TCP port on a host. Returns true if the port is open. */
function probe_port(ip: string, port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
    return new Promise(resolve => {
        const socket = new net.Socket();
        let done = false;
        const finish = (open: boolean) => {
            if (done) return;
            done = true;
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(timeoutMs);
        socket.on('connect', () => finish(true));
        socket.on('timeout', () => finish(false));
        socket.on('error', () => finish(false));
        socket.connect(port, ip);
    });
}

/** Probes all IoT ports on a host concurrently. Returns list of open ports. */
async function probe_host(ip: string): Promise<number[]> {
    const results = await Promise.all(
        IOT_PORT_HINTS.map(async ({ port }) => (await probe_port(ip, port)) ? port : null)
    );
    return results.filter((p): p is number => p !== null);
}

/** Determines device type from open ports */
function fingerprint_device(openPorts: number[]): DeviceType {
    const portSet = new Set(openPorts);
    if (portSet.has(1883) || portSet.has(8883)) return 'mqtt-broker';
    if (portSet.has(554)  || portSet.has(8554)) return 'ip-camera';
    if (portSet.has(502))  return 'modbus-device';
    if (portSet.has(4196)) return 'digital-price-tag-gateway';
    if (portSet.has(10001) || portSet.has(6001)) return 'rfid-reader';
    if (portSet.has(80) || portSet.has(8080) || portSet.has(8000)) return 'generic-http';
    if (openPorts.length > 0) return 'generic-tcp';
    return 'unknown';
}

/** Generates candidate IPs for a /24 subnet */
function subnet_hosts(subnet: string): string[] {
    return Array.from({ length: 254 }, (_, i) => `${subnet}.${i + 1}`);
}

/** Runs network scan. Returns all discovered IoTDevices. */
export async function scan_network(
    subnet?: string,
    onProgress?: (done: number, total: number) => void
): Promise<IoTDevice[]> {
    const subnets = subnet ? [subnet] : get_local_subnets();
    const arpHosts = read_arp_hosts();

    // Priority: ARP-known hosts first, then full subnet sweep
    const allTargets = [...new Set([
        ...arpHosts,
        ...subnets.flatMap(subnet_hosts)
    ])];

    const found: IoTDevice[] = [];
    let done = 0;

    for (let i = 0; i < allTargets.length; i += SCAN_HOST_BATCH) {
        const batch = allTargets.slice(i, i + SCAN_HOST_BATCH);
        await Promise.all(batch.map(async (ip) => {
            const openPorts = await probe_host(ip);
            done++;
            onProgress?.(done, allTargets.length);
            if (openPorts.length === 0) return;

            const type = fingerprint_device(openPorts);
            const id = `${ip}:${openPorts[0]}`;
            const now = new Date().toISOString();
            const existing = io_load_device_registry().find(d => d.id === id);

            const device: IoTDevice = {
                id,
                ip,
                type,
                openPorts,
                mqttBroker: (openPorts.includes(1883)) ? `mqtt://${ip}:1883` : undefined,
                metadata: {},
                firstSeen: existing?.firstSeen ?? now,
                lastSeen: now,
                status: 'online',
            };
            found.push(device);
            io_upsert_device(device);
        }));
    }

    // Mark devices not found in this scan as offline
    const foundIds = new Set(found.map(d => d.id));
    for (const existing of io_load_device_registry()) {
        if (!foundIds.has(existing.id)) {
            io_update_device_status(existing.id, 'offline');
        }
    }

    return found;
}

// ─── MQTT Connection Pool ────────────────────────────────────────────────────

interface PoolEntry {
    client: mqtt.MqttClient;
    buffer: Map<string, MqttMessage[]>;
}

const mqttPool = new Map<string, PoolEntry>();

/** Returns (or creates) an MQTT client connected to brokerUrl */
export async function mqtt_connect(brokerUrl: string): Promise<void> {
    if (mqttPool.has(brokerUrl)) return; // already connected

    const client = await mqtt.connectAsync(brokerUrl, {
        reconnectPeriod: 3000,
        connectTimeout: 8000,
        clean: true,
    });

    const entry: PoolEntry = { client, buffer: new Map() };
    mqttPool.set(brokerUrl, entry);

    client.on('message', (topic: string, payload: Buffer) => {
        const msgs = entry.buffer.get(topic) ?? [];
        msgs.push({ topic, payload: payload.toString('utf8'), ts: new Date().toISOString() });
        if (msgs.length > MAX_MSG_BUFFER) msgs.shift();
        entry.buffer.set(topic, msgs);
    });

    client.on('error', (err: Error) => {
        console.warn(`[IoT/MQTT] ${brokerUrl} error: ${err.message}`);
    });
}

/** Subscribe to a topic on a broker (connects if needed) */
export async function mqtt_subscribe(brokerUrl: string, topic: string): Promise<void> {
    await mqtt_connect(brokerUrl);
    const entry = mqttPool.get(brokerUrl)!;
    if (!entry.buffer.has(topic)) {
        entry.buffer.set(topic, []);
        await entry.client.subscribeAsync(topic, { qos: 1 });
    }
}

/** Read buffered messages for a topic. Optionally clears the buffer. */
export function mqtt_read(brokerUrl: string, topic: string, clear = false): MqttMessage[] {
    const entry = mqttPool.get(brokerUrl);
    if (!entry) return [];
    const msgs = entry.buffer.get(topic) ?? [];
    if (clear) entry.buffer.set(topic, []);
    return msgs;
}

/** Publish a message to a topic on a broker */
export async function mqtt_publish(
    brokerUrl: string,
    topic: string,
    payload: string,
    retain = false
): Promise<void> {
    await mqtt_connect(brokerUrl);
    const entry = mqttPool.get(brokerUrl)!;
    await entry.client.publishAsync(topic, payload, { qos: 1, retain });
}

/** Disconnect a broker and remove from pool */
export async function mqtt_disconnect(brokerUrl: string): Promise<void> {
    const entry = mqttPool.get(brokerUrl);
    if (entry) {
        await entry.client.endAsync();
        mqttPool.delete(brokerUrl);
    }
}

/** List active MQTT broker connections */
export function mqtt_list_connections(): string[] {
    return Array.from(mqttPool.keys());
}

// ─── Raw TCP I/O ─────────────────────────────────────────────────────────────

export interface TcpResponse {
    sent: string;
    received: string;
    durationMs: number;
}

/** Open a TCP connection, send a command, wait for a response, then close. */
export async function tcp_send(
    ip: string,
    port: number,
    command: string,
    timeoutMs = 5000
): Promise<TcpResponse> {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        let received = '';
        const socket = new net.Socket();
        let settled = false;

        const finish = () => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve({ sent: command, received, durationMs: Date.now() - start });
        };

        socket.setTimeout(timeoutMs);
        socket.on('data', (chunk) => { received += chunk.toString(); });
        socket.on('timeout', finish);
        socket.on('close', finish);
        socket.on('error', (e) => {
            if (!settled) { settled = true; reject(e); }
        });

        socket.connect(port, ip, () => {
            socket.write(command.includes('\n') ? command : command + '\r\n');
        });
    });
}
