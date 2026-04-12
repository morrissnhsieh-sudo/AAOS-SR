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
}
