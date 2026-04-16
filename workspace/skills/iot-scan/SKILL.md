---
name: iot-scan
description: Discover IoT devices on the local network by scanning for open ports and fingerprinting device types. Use when the user asks to find, discover, or list network devices, cameras, sensors, or MQTT brokers.
allowed-tools: iot_scan iot_devices think
version: 1.0.0
---

# IoT Network Scanner

## Discovering devices

1. Call `think` to reason: What subnet to scan? Has a scan run recently? What device types is the user interested in?

2. Call `iot_scan` with no arguments to scan all local subnets (or pass `subnet: "192.168.1"` if the user specifies one):
   ```
   iot_scan
   ```
   This probes ports: 1883 (MQTT), 554 (RTSP/camera), 80/8080 (HTTP), 502 (Modbus), 4196 (price tags), 10001 (RFID), and more.

3. Present results in a clean table:
   | IP | Type | Open Ports | Status |
   |----|------|------------|--------|
   For each device, note what it likely is and how to interact with it.

## Querying saved devices

To list devices without rescanning, call `iot_devices`:
- All devices: `iot_devices {}`
- Filter by type: `iot_devices { type: "ip-camera" }`
- Filter by status: `iot_devices { status: "online" }`

## Device type reference

| Type | Common Ports | How to interact |
|------|-------------|-----------------|
| `mqtt-broker` | 1883, 8883 | Use `iot_mqtt_subscribe` / `iot_mqtt_publish` |
| `ip-camera` | 554, 8554 | RTSP stream at `rtsp://{ip}:554/stream` |
| `rfid-reader` | 10001, 6001 | Use `iot_tcp_send` |
| `digital-price-tag-gateway` | 4196, 8080 | HTTP REST API or MQTT |
| `modbus-device` | 502 | Modbus TCP protocol |
| `generic-http` | 80, 8080, 8000 | REST API via `bash_exec` with curl |
| `generic-tcp` | varies | Use `iot_tcp_send` |

## Guidelines

- A scan of a /24 subnet (254 hosts) takes approximately 5–10 seconds.
- Devices already in the registry appear instantly via `iot_devices` — no rescan needed.
- After scanning, tell the user: how many devices were found, their types and IPs, and suggest next steps (e.g. "I found an MQTT broker at 192.168.1.10 — want me to subscribe to a topic?").
