---
name: ipcam
description: Discover and interact with IP cameras on the local network. Use for live stream URLs, snapshot capture, PTZ control, and camera status checks.
allowed-tools: iot_devices iot_scan bash_exec think
version: 1.0.0
---

# IP Camera Skill

## Finding cameras

1. Call `iot_devices { type: "ip-camera" }` to list cameras already discovered.
2. If none found, call `iot_scan` then retry `iot_devices { type: "ip-camera" }`.

## Getting the live stream URL

Most IP cameras expose an RTSP stream. Common URL patterns (try in order):

| Brand | RTSP URL |
|-------|----------|
| Hikvision | `rtsp://{user}:{pass}@{ip}:554/Streaming/Channels/101` |
| Dahua | `rtsp://{user}:{pass}@{ip}:554/cam/realmonitor?channel=1&subtype=0` |
| Reolink | `rtsp://{user}:{pass}@{ip}:554/h264Preview_01_main` |
| Amcrest | `rtsp://{user}:{pass}@{ip}:554/cam/realmonitor?channel=1&subtype=0` |
| Tapo/TP-Link | `rtsp://{user}:{pass}@{ip}:554/stream1` |
| Axis | `rtsp://{ip}/axis-media/media.amp` |
| Generic ONVIF | `rtsp://{user}:{pass}@{ip}:554/stream` |

Present the RTSP URL to the user so they can open it in VLC or a player.

## Capturing a snapshot

Call `bash_exec` to capture a JPEG frame using ffmpeg:
```bash
ffmpeg -rtsp_transport tcp -i "rtsp://{user}:{pass}@{ip}:554/stream" -frames:v 1 -q:v 2 C:\Temp\snapshot_{ip}.jpg -y 2>&1
```
Then tell the user the saved path.

## Checking HTTP web UI

If the camera has port 80 open, it likely has a web admin panel:
```bash
curl -s --max-time 5 http://{ip}/
```
Check the response for camera brand identifiers to confirm the model.

## PTZ control (pan/tilt/zoom)

Many cameras support PTZ via HTTP API. Examples:

- **Hikvision**: `bash_exec` with `curl "http://{ip}/cgi-bin/ptz.cgi?action=start&channel=0&code=Up&arg1=0&arg2=5&arg3=0"`
- **Dahua**: `bash_exec` with `curl "http://{user}:{pass}@{ip}/cgi-bin/ptz.cgi?action=start&channel=0&code=Up&arg1=0&arg2=5&arg3=0"`

## Guidelines

- Always ask for credentials (username/password) before attempting authenticated streams.
- Default credentials to try: `admin/admin`, `admin/12345`, `admin/` (blank).
- Never store credentials in memory unless the user explicitly asks.
- Confirm the camera IP and brand with the user before sending any control commands.
