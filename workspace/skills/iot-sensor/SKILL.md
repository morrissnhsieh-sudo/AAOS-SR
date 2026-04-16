---
name: iot-sensor
description: Read live data from IoT sensors — temperature, humidity, RFID card scans, digital price tags, and Modbus devices. Use when the user asks for sensor readings, tag updates, or RFID events.
allowed-tools: iot_devices iot_scan iot_mqtt_subscribe iot_mqtt_read iot_mqtt_publish iot_tcp_send think
version: 1.0.0
---

# IoT Sensor Skill

## Step 1 — Find the device

Call `iot_devices {}` to list known devices. If empty, call `iot_scan` first.
Identify the device type and IP.

---

## Temperature & Humidity Sensors

Most WiFi sensors (Zigbee2MQTT, Tasmota, ESPHome, Mi sensor) report via MQTT.

1. Find the MQTT broker: `iot_devices { type: "mqtt-broker" }`
2. Subscribe to sensor topics:
   ```
   iot_mqtt_subscribe { brokerUrl: "mqtt://{ip}:1883", topic: "zigbee2mqtt/#" }
   iot_mqtt_subscribe { brokerUrl: "mqtt://{ip}:1883", topic: "tele/+/SENSOR" }
   ```
3. Wait 3 seconds, then read:
   ```
   iot_mqtt_read { brokerUrl: "mqtt://{ip}:1883", topic: "tele/+/SENSOR", limit: 10 }
   ```
4. Parse JSON payload — common formats:
   - Zigbee2MQTT: `{"temperature": 24.5, "humidity": 62, "battery": 85}`
   - Tasmota: `{"SI7021": {"Temperature": 24.5, "Humidity": 62}}`
   - ESPHome: `{"id": "sensor1", "value": 24.5, "unit": "°C"}`
5. Present clearly: "Temperature: **24.5°C**, Humidity: **62%**"

---

## RFID Readers

RFID readers typically expose a TCP server that sends card ID on each scan.

1. Find reader: `iot_devices { type: "rfid-reader" }`
2. Connect and listen for a card scan:
   ```
   iot_tcp_send { ip: "{ip}", port: 10001, command: "", timeoutMs: 15000 }
   ```
   The reader will respond with the card UID when a card is presented.
3. Parse the response — common formats:
   - Hex string: `A1B2C3D4`
   - CSV: `A1B2C3D4,timestamp,reader_id`
4. Report: "Card scanned: UID **A1B2C3D4**"

To send a command to the reader (e.g. beep, LED):
```
iot_tcp_send { ip: "{ip}", port: 10001, command: "BEEP:1" }
```

---

## Digital Price Tags (ESL)

ESL gateways use HTTP REST or MQTT to push price updates to e-ink tags.

**Via MQTT** (Zkong / common ESL gateways):
```
iot_mqtt_publish {
  brokerUrl: "mqtt://{ip}:1883",
  topic: "esl/update/{tag-id}",
  payload: "{\"price\": \"12.99\", \"name\": \"Product Name\", \"barcode\": \"1234567890\"}"
}
```

**Via HTTP REST** (SES-imagotag / Hanshow):
```bash
bash_exec: curl -X POST http://{ip}:8080/api/tags/{tag-id}/update \
  -H "Content-Type: application/json" \
  -d '{"price": "12.99", "name": "Product Name"}'
```

---

## Modbus Devices (Industrial Sensors)

Modbus TCP devices communicate on port 502. Use TCP to send read-register commands.

Read holding registers (function code 03):
```
iot_tcp_send { ip: "{ip}", port: 502, command: "0001 0000 0006 01 03 006B 0003" }
```
The response contains the register values — parse according to the device's Modbus map.

For convenience, call `bash_exec` with a Python Modbus client if available:
```bash
python3 -c "from pymodbus.client import ModbusTcpClient; c=ModbusTcpClient('{ip}'); c.connect(); r=c.read_holding_registers(0,10); print(r.registers)"
```

---

## Guidelines

- Always `think` first: identify device type, protocol (MQTT/TCP/HTTP), and what data format to expect.
- For MQTT sensors, subscribe before asking for data — messages only buffer after subscription.
- Present sensor values with units and context, never raw bytes or JSON.
- For RFID, confirm with the user what action to take on a card scan (lookup, log, trigger).
- For price tags, **always confirm** the new price with the user before publishing the update.
