---
name: mqtt
description: Connect to MQTT brokers, subscribe to topics, read live sensor data, and publish control commands to IoT devices. Use for any MQTT-based communication with smart devices, sensors, or automation systems.
allowed-tools: iot_mqtt_subscribe iot_mqtt_read iot_mqtt_publish iot_mqtt_connections iot_devices think
version: 1.0.0
---

# MQTT Skill

## Finding the broker

If the broker URL is not known, call `iot_devices { type: "mqtt-broker" }` to find MQTT brokers discovered on the network.
The broker URL format is: `mqtt://{ip}:{port}` — most commonly `mqtt://{ip}:1883`.

## Subscribing to sensor data

1. Call `iot_mqtt_subscribe` with the broker URL and topic:
   ```
   iot_mqtt_subscribe { brokerUrl: "mqtt://192.168.1.10:1883", topic: "sensors/#" }
   ```
   Common topic patterns:
   - `sensors/#` — all sensor readings
   - `tele/+/STATE` — Tasmota device status
   - `homeassistant/#` — Home Assistant autodiscovery
   - `zigbee2mqtt/#` — Zigbee devices via Zigbee2MQTT
   - `temperature/room1` — specific sensor topic

2. Wait a moment (2–5 seconds for live data), then call `iot_mqtt_read`:
   ```
   iot_mqtt_read { brokerUrl: "mqtt://192.168.1.10:1883", topic: "sensors/#", limit: 20 }
   ```

3. Parse the messages and present the data to the user cleanly (not raw JSON).

## Publishing control commands

Call `iot_mqtt_publish` to send a command:
```
iot_mqtt_publish { brokerUrl: "mqtt://192.168.1.10:1883", topic: "cmnd/device/POWER", payload: "ON" }
```

Common command patterns:
- **Tasmota devices**: topic `cmnd/{device}/POWER`, payload `ON` / `OFF` / `TOGGLE`
- **Home Assistant**: topic `home/{room}/{device}/set`, payload `ON` / `OFF` / JSON
- **Digital price tags**: topic `esl/update/{tag-id}`, payload JSON with price/text
- **Custom sensors**: consult device documentation

## Monitoring active connections

Call `iot_mqtt_connections { action: "list" }` to see which brokers are connected.
Call `iot_mqtt_connections { action: "disconnect", brokerUrl: "mqtt://..." }` to close a connection.

## Guidelines

- Always confirm the broker URL before publishing a command — publishing to the wrong topic can affect devices unexpectedly.
- Use wildcard `#` for discovery (see what topics exist), then narrow to specific topics for ongoing monitoring.
- For temperature/humidity sensors, expect JSON payloads like `{"temperature": 24.5, "humidity": 62}`.
- Do NOT show raw JSON payloads to the user — parse and present the values clearly.
