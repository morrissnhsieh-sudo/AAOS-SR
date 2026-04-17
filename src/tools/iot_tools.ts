/**
 * AAOS IoT Native Tools
 * Registers 7 tools the LLM can call to discover and control IoT devices.
 */
import { register_tool } from './tool_dispatcher';
import {
    scan_network,
    io_load_device_registry,
    mqtt_connect,
    mqtt_subscribe,
    mqtt_publish,
    mqtt_read,
    mqtt_disconnect,
    mqtt_list_connections,
    tcp_send,
    get_local_subnets,
    IoTDevice,
} from '../iot/iot_manager';

export function register_iot_tools(): void {

    // ── 1. Network scan ───────────────────────────────────────────────────────

    register_tool(
        {
            name: 'iot_scan',
            description:
                'Scan the local network for IoT devices (IP cameras, MQTT brokers, sensors, RFID readers, ' +
                'digital price tags, Modbus devices, smart plugs, etc.). ' +
                'Probes common IoT ports and fingerprints each device by type. ' +
                'Stores results in the device registry. Use when the user asks to discover, find, or list network devices.',
            parameters: {
                type: 'object',
                properties: {
                    subnet: {
                        type: 'string',
                        description: 'Optional /24 subnet prefix to scan, e.g. "192.168.1". ' +
                            'Defaults to all subnets this host is on.'
                    }
                },
                required: []
            }
        },
        async (args: { subnet?: string }) => {
            try {
                const subnets = args.subnet ? [args.subnet] : get_local_subnets();
                console.log(`[IoT] Starting scan on subnet(s): ${subnets.join(', ')}`);
                const devices = await scan_network(args.subnet);
                const summary = devices.map(d => ({
                    id: d.id,
                    ip: d.ip,
                    type: d.type,
                    openPorts: d.openPorts,
                    mqttBroker: d.mqttBroker,
                    status: d.status,
                }));
                return {
                    ok: true,
                    found: devices.length,
                    subnets,
                    devices: summary,
                    message: devices.length === 0
                        ? 'No IoT devices found on the network.'
                        : `Found ${devices.length} device(s). Results saved to device registry.`
                };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    // ── 2. List/query registered devices ─────────────────────────────────────

    register_tool(
        {
            name: 'iot_devices',
            description:
                'List all IoT devices in the registry, or filter by type or status. ' +
                'Use to check what devices are known, their IPs, types, open ports, and online/offline status.',
            parameters: {
                type: 'object',
                properties: {
                    type: {
                        type: 'string',
                        description: 'Filter by device type: mqtt-broker, ip-camera, temperature-humidity-sensor, ' +
                            'rfid-reader, digital-price-tag-gateway, modbus-device, smart-plug, generic-http, generic-tcp, unknown'
                    },
                    status: {
                        type: 'string',
                        enum: ['online', 'offline', 'unknown'],
                        description: 'Filter by status'
                    }
                },
                required: []
            }
        },
        async (args: { type?: string; status?: string }) => {
            try {
                let devices = io_load_device_registry();
                if (args.type)   devices = devices.filter(d => d.type === args.type);
                if (args.status) devices = devices.filter(d => d.status === args.status);
                return {
                    ok: true,
                    count: devices.length,
                    devices,
                };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    // ── 3. MQTT subscribe ─────────────────────────────────────────────────────

    register_tool(
        {
            name: 'iot_mqtt_subscribe',
            description:
                'Connect to an MQTT broker and subscribe to a topic. ' +
                'Messages will be buffered in memory. Use iot_mqtt_read to retrieve them. ' +
                'Supports wildcards: + (single level) and # (multi-level). ' +
                'Example brokerUrl: "mqtt://192.168.1.10:1883".',
            parameters: {
                type: 'object',
                properties: {
                    brokerUrl: {
                        type: 'string',
                        description: 'MQTT broker URL, e.g. "mqtt://192.168.1.10:1883"'
                    },
                    topic: {
                        type: 'string',
                        description: 'MQTT topic or wildcard, e.g. "sensors/#" or "tele/+/STATE"'
                    }
                },
                required: ['brokerUrl', 'topic']
            }
        },
        async (args: { brokerUrl: string; topic: string }) => {
            try {
                await mqtt_subscribe(args.brokerUrl, args.topic);
                return {
                    ok: true,
                    brokerUrl: args.brokerUrl,
                    topic: args.topic,
                    message: `Subscribed to "${args.topic}" on ${args.brokerUrl}. Use iot_mqtt_read to get messages.`
                };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    // ── 4. MQTT read ──────────────────────────────────────────────────────────

    register_tool(
        {
            name: 'iot_mqtt_read',
            description:
                'Read buffered MQTT messages received since last subscription or last read. ' +
                'Returns the most recent messages with their topic, payload, and timestamp.',
            parameters: {
                type: 'object',
                properties: {
                    brokerUrl: {
                        type: 'string',
                        description: 'MQTT broker URL used in iot_mqtt_subscribe'
                    },
                    topic: {
                        type: 'string',
                        description: 'Topic to read messages from'
                    },
                    limit: {
                        type: 'number',
                        description: 'Maximum number of messages to return (default: 20)'
                    },
                    clear: {
                        type: 'boolean',
                        description: 'Clear the buffer after reading (default: false)'
                    }
                },
                required: ['brokerUrl', 'topic']
            }
        },
        async (args: { brokerUrl: string; topic: string; limit?: number; clear?: boolean }) => {
            try {
                const msgs = mqtt_read(args.brokerUrl, args.topic, args.clear ?? false);
                const limit = args.limit ?? 20;
                const recent = msgs.slice(-limit);
                return {
                    ok: true,
                    brokerUrl: args.brokerUrl,
                    topic: args.topic,
                    count: recent.length,
                    messages: recent,
                };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    // ── 5. MQTT publish ───────────────────────────────────────────────────────

    register_tool(
        {
            name: 'iot_mqtt_publish',
            description:
                'Publish a message to an MQTT topic to control a device. ' +
                'Use to send commands to smart plugs, price tags, actuators, or any MQTT-enabled device. ' +
                'The payload format depends on the device (JSON, plain text, or binary-as-hex).',
            parameters: {
                type: 'object',
                properties: {
                    brokerUrl: {
                        type: 'string',
                        description: 'MQTT broker URL, e.g. "mqtt://192.168.1.10:1883"'
                    },
                    topic: {
                        type: 'string',
                        description: 'MQTT topic to publish to, e.g. "cmnd/tasmota_device/POWER"'
                    },
                    payload: {
                        type: 'string',
                        description: 'Message payload, e.g. "ON", "OFF", or JSON string'
                    },
                    retain: {
                        type: 'boolean',
                        description: 'Set retain flag on the message (default: false)'
                    }
                },
                required: ['brokerUrl', 'topic', 'payload']
            }
        },
        async (args: { brokerUrl: string; topic: string; payload: string; retain?: boolean }) => {
            try {
                await mqtt_publish(args.brokerUrl, args.topic, args.payload, args.retain ?? false);
                return {
                    ok: true,
                    brokerUrl: args.brokerUrl,
                    topic: args.topic,
                    payload: args.payload,
                    message: `Published "${args.payload}" to ${args.topic} on ${args.brokerUrl}`
                };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    // ── 6. TCP send ───────────────────────────────────────────────────────────

    register_tool(
        {
            name: 'iot_tcp_send',
            description:
                'Send a raw TCP command to an IoT device and return its response. ' +
                'Use for devices that communicate over plain TCP: RFID readers, barcode scanners, ' +
                'serial-to-Ethernet converters, industrial controllers, or any device with a TCP API.',
            parameters: {
                type: 'object',
                properties: {
                    ip: {
                        type: 'string',
                        description: 'Device IP address'
                    },
                    port: {
                        type: 'number',
                        description: 'TCP port number'
                    },
                    command: {
                        type: 'string',
                        description: 'Command string to send (newline appended automatically if not present)'
                    },
                    timeoutMs: {
                        type: 'number',
                        description: 'Response wait timeout in milliseconds (default: 5000)'
                    }
                },
                required: ['ip', 'port', 'command']
            }
        },
        async (args: { ip: string; port: number; command: string; timeoutMs?: number }) => {
            try {
                const result = await tcp_send(args.ip, args.port, args.command, args.timeoutMs ?? 5000);
                return { ok: true, ...result };
            } catch (err: any) {
                return { ok: false, ip: args.ip, port: args.port, error: err.message };
            }
        }
    );

    // ── 7. MQTT connection management ─────────────────────────────────────────

    register_tool(
        {
            name: 'iot_mqtt_connections',
            description:
                'List active MQTT broker connections, or disconnect from a specific broker. ' +
                'Use to check which brokers are currently connected.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['list', 'disconnect'],
                        description: '"list" to show active connections, "disconnect" to close a broker connection'
                    },
                    brokerUrl: {
                        type: 'string',
                        description: 'Required when action is "disconnect"'
                    }
                },
                required: ['action']
            }
        },
        async (args: { action: 'list' | 'disconnect'; brokerUrl?: string }) => {
            try {
                if (args.action === 'list') {
                    const connections = mqtt_list_connections();
                    return { ok: true, connected: connections, count: connections.length };
                }
                if (args.action === 'disconnect') {
                    if (!args.brokerUrl) return { ok: false, error: 'brokerUrl required for disconnect' };
                    await mqtt_disconnect(args.brokerUrl);
                    return { ok: true, message: `Disconnected from ${args.brokerUrl}` };
                }
                return { ok: false, error: 'Unknown action' };
            } catch (err: any) {
                return { ok: false, error: err.message };
            }
        }
    );

    console.log('[IoT] Tools registered: iot_scan, iot_devices, iot_mqtt_subscribe, iot_mqtt_read, iot_mqtt_publish, iot_tcp_send, iot_mqtt_connections');

    // ── 8. Retail shelf sensor read ───────────────────────────────────────────
    //
    // Reads from weight-based shelf sensors via MQTT and returns a structured
    // list of RetailShelfReading objects with low_stock detection.
    //
    // Example MQTT payload on topic retail/TW-001/shelf/A3/sensors:
    //   { "sku": "SKU-WATER-1L", "weight_kg": 0.8, "threshold_kg": 5.0,
    //     "bay_id": "A3-B2", "last_restocked": "2025-04-15T08:00:00Z" }

    interface RetailShelfReading {
        sku: string;
        weight_kg: number;
        threshold_kg: number;
        bay_id: string;
        last_restocked: string;
        low_stock: boolean;
    }

    register_tool(
        {
            name: 'retail_shelf_read',
            description:
                'Read retail shelf weight sensor data from MQTT for a given store and aisle. ' +
                'Subscribes to shelf sensor topics, waits up to 5 seconds for readings, and returns ' +
                'structured inventory data with low_stock flags (true when weight < 20% of threshold). ' +
                'Use when checking shelf stock levels, inventory status, or identifying restock needs.',
            parameters: {
                type: 'object',
                properties: {
                    store_id: {
                        type: 'string',
                        description: 'Store identifier, e.g. "TW-001"'
                    },
                    aisle_id: {
                        type: 'string',
                        description: 'Aisle identifier, e.g. "A3"'
                    },
                    sku_filter: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional array of SKUs to filter results, e.g. ["SKU-WATER-1L"]'
                    }
                },
                required: ['store_id', 'aisle_id']
            }
        },
        async (args: { store_id: string; aisle_id: string; sku_filter?: string[] }) => {
            const brokerUrl = process.env.MQTT_BROKER_URL || process.env.MQTT_HOST
                ? `mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT || 1883}`
                : 'mqtt://localhost:1883';
            const topic = `retail/${args.store_id}/shelf/${args.aisle_id}/sensors`;
            try {
                await mqtt_subscribe(brokerUrl, topic);
                // Wait 5 seconds for messages to arrive
                await new Promise(resolve => setTimeout(resolve, 5000));
                const raw = mqtt_read(brokerUrl, topic, false);
                const readings: RetailShelfReading[] = [];
                for (const msg of raw) {
                    try {
                        const payload = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
                        if (!payload || typeof payload !== 'object') continue;
                        const reading: RetailShelfReading = {
                            sku: payload.sku ?? '',
                            weight_kg: Number(payload.weight_kg ?? 0),
                            threshold_kg: Number(payload.threshold_kg ?? 1),
                            bay_id: payload.bay_id ?? '',
                            last_restocked: payload.last_restocked ?? '',
                            low_stock: Number(payload.weight_kg ?? 0) < Number(payload.threshold_kg ?? 1) * 0.2,
                        };
                        if (args.sku_filter && args.sku_filter.length > 0) {
                            if (!args.sku_filter.includes(reading.sku)) continue;
                        }
                        readings.push(reading);
                    } catch { /* skip malformed message */ }
                }
                return {
                    ok: true,
                    store_id: args.store_id,
                    aisle_id: args.aisle_id,
                    topic,
                    count: readings.length,
                    readings,
                    message: readings.length === 0
                        ? 'No shelf sensor readings received within 5 seconds.'
                        : `Received ${readings.length} shelf reading(s). ${readings.filter(r => r.low_stock).length} low-stock item(s) detected.`
                };
            } catch (err: any) {
                return { ok: false, store_id: args.store_id, aisle_id: args.aisle_id, error: err.message };
            }
        }
    );

    // ── 9. BLE proximity dwell tool ───────────────────────────────────────────
    //
    // Reads BLE dwell events from an ESP32 BLE gateway via MQTT.
    // Returns events where the customer has dwelled beyond the threshold.
    //
    // Example MQTT payload on topic retail/TW-001/ble/frozen-aisle/events:
    //   { "device_id": "BLE-001", "rssi": -65, "dwell_sec": 25,
    //     "member_id": "MBR-042", "timestamp": "2025-04-15T10:30:00Z" }

    interface BLEDwellEvent {
        device_id: string;
        rssi: number;
        dwell_sec: number;
        member_id?: string;
        timestamp: string;
        triggered_upsell: boolean;
    }

    register_tool(
        {
            name: 'retail_ble_dwell',
            description:
                'Read BLE proximity dwell events from a retail zone via MQTT. ' +
                'Subscribes to BLE gateway events for a specific store zone and returns customers who ' +
                'have dwelled longer than the threshold (default 10 seconds). ' +
                'Use for personalized upsell triggers, zone traffic analysis, or dwell time reporting.',
            parameters: {
                type: 'object',
                properties: {
                    store_id: {
                        type: 'string',
                        description: 'Store identifier, e.g. "TW-001"'
                    },
                    zone_id: {
                        type: 'string',
                        description: 'Store zone identifier, e.g. "frozen-aisle"'
                    },
                    dwell_threshold_sec: {
                        type: 'number',
                        description: 'Minimum dwell time in seconds to include in results (default: 10)'
                    }
                },
                required: ['store_id', 'zone_id']
            }
        },
        async (args: { store_id: string; zone_id: string; dwell_threshold_sec?: number }) => {
            const threshold = args.dwell_threshold_sec ?? 10;
            const brokerUrl = process.env.MQTT_BROKER_URL || process.env.MQTT_HOST
                ? `mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT || 1883}`
                : 'mqtt://localhost:1883';
            const topic = `retail/${args.store_id}/ble/${args.zone_id}/events`;
            try {
                await mqtt_subscribe(brokerUrl, topic);
                // Wait 8 seconds for BLE events
                await new Promise(resolve => setTimeout(resolve, 8000));
                const raw = mqtt_read(brokerUrl, topic, false);
                const events: BLEDwellEvent[] = [];
                for (const msg of raw) {
                    try {
                        const payload = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
                        if (!payload || typeof payload !== 'object') continue;
                        const dwellSec = Number(payload.dwell_sec ?? 0);
                        if (dwellSec < threshold) continue;
                        events.push({
                            device_id: payload.device_id ?? '',
                            rssi: Number(payload.rssi ?? 0),
                            dwell_sec: dwellSec,
                            member_id: payload.member_id ?? undefined,
                            timestamp: payload.timestamp ?? new Date().toISOString(),
                            triggered_upsell: false,
                        });
                    } catch { /* skip malformed message */ }
                }
                return {
                    ok: true,
                    store_id: args.store_id,
                    zone_id: args.zone_id,
                    topic,
                    dwell_threshold_sec: threshold,
                    count: events.length,
                    events,
                    message: events.length === 0
                        ? `No BLE dwell events >= ${threshold}s received within 8 seconds.`
                        : `Found ${events.length} dwell event(s) above ${threshold}s threshold.`
                };
            } catch (err: any) {
                return { ok: false, store_id: args.store_id, zone_id: args.zone_id, error: err.message };
            }
        }
    );

    // ── 10. Checkout queue depth tool ─────────────────────────────────────────
    //
    // Reads checkout lane queue data from computer vision publisher via MQTT.
    // Computes a store_congestion_score for staff routing decisions.
    //
    // Example MQTT payload on topic retail/TW-001/checkout/queue:
    //   { "lane_id": "L1", "queue_depth": 5, "avg_wait_sec": 120,
    //     "is_open": true, "cashier_id": "C-03" }

    interface CheckoutLane {
        lane_id: string;
        queue_depth: number;
        avg_wait_sec: number;
        is_open: boolean;
        cashier_id?: string;
    }

    register_tool(
        {
            name: 'retail_queue_read',
            description:
                'Read checkout lane queue depths and wait times from MQTT. ' +
                'Returns all open lanes (or filtered by lane_ids) and a computed store_congestion_score ' +
                '(average queue depth across open lanes, rounded to 1 decimal place). ' +
                'Use for checkout management, staff allocation, and self-checkout routing decisions.',
            parameters: {
                type: 'object',
                properties: {
                    store_id: {
                        type: 'string',
                        description: 'Store identifier, e.g. "TW-001"'
                    },
                    lane_ids: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional array of lane IDs to filter, e.g. ["L1", "L2"]'
                    }
                },
                required: ['store_id']
            }
        },
        async (args: { store_id: string; lane_ids?: string[] }) => {
            const brokerUrl = process.env.MQTT_BROKER_URL || process.env.MQTT_HOST
                ? `mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT || 1883}`
                : 'mqtt://localhost:1883';
            const topic = `retail/${args.store_id}/checkout/queue`;
            try {
                await mqtt_subscribe(brokerUrl, topic);
                // Wait 5 seconds for queue data
                await new Promise(resolve => setTimeout(resolve, 5000));
                const raw = mqtt_read(brokerUrl, topic, false);
                let lanes: CheckoutLane[] = [];
                for (const msg of raw) {
                    try {
                        const payload = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
                        if (!payload || typeof payload !== 'object') continue;
                        // Support both single lane and array payloads
                        const items = Array.isArray(payload) ? payload : [payload];
                        for (const item of items) {
                            const lane: CheckoutLane = {
                                lane_id: item.lane_id ?? '',
                                queue_depth: Number(item.queue_depth ?? 0),
                                avg_wait_sec: Number(item.avg_wait_sec ?? 0),
                                is_open: Boolean(item.is_open ?? false),
                                cashier_id: item.cashier_id ?? undefined,
                            };
                            if (args.lane_ids && args.lane_ids.length > 0) {
                                if (!args.lane_ids.includes(lane.lane_id)) continue;
                            }
                            lanes.push(lane);
                        }
                    } catch { /* skip malformed message */ }
                }
                // Deduplicate by lane_id (keep last seen)
                const laneMap = new Map<string, CheckoutLane>();
                for (const lane of lanes) laneMap.set(lane.lane_id, lane);
                lanes = Array.from(laneMap.values());

                const openLanes = lanes.filter(l => l.is_open);
                const congestionScore = openLanes.length > 0
                    ? Math.round((openLanes.reduce((sum, l) => sum + l.queue_depth, 0) / openLanes.length) * 10) / 10
                    : 0;

                return {
                    ok: true,
                    store_id: args.store_id,
                    topic,
                    lane_count: lanes.length,
                    open_lane_count: openLanes.length,
                    store_congestion_score: congestionScore,
                    lanes,
                    message: lanes.length === 0
                        ? 'No checkout queue data received within 5 seconds.'
                        : `${lanes.length} lane(s) read. Congestion score: ${congestionScore} (${openLanes.length} open lanes).`
                };
            } catch (err: any) {
                return { ok: false, store_id: args.store_id, error: err.message };
            }
        }
    );

    console.log('[IoT] Retail tools registered: retail_shelf_read, retail_ble_dwell, retail_queue_read');
}
