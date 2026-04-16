---
name: webcam
description: Capture a photo using the laptop's built-in webcam or any connected camera, then describe or analyze what is seen using AI vision. Use when the user asks to take a photo, use the camera, see what's in front of the laptop, or analyze a live scene.
allowed-tools: webcam_capture think
version: 2.0.0
---

# Webcam Capture & Vision Analysis

Use the **`webcam_capture` native tool** — do NOT use `bash_exec` to call the Python script manually.
The native tool handles Python path resolution automatically, regardless of whether the shell is Git Bash or WSL.

## Take a photo and describe it

Call `webcam_capture` with a `prompt`:
```
webcam_capture({ prompt: "Describe in detail what you see in this photo." })
```

The tool returns JSON:
```json
{"ok": true, "path": "C:\\Temp\\aaos_snapshots\\snap_20250412_103000.jpg", "webPath": "/snapshots/snap_20250412_103000.jpg", "bytes": 34000, "description": "..."}
```

**Always embed the image in your reply** using the `webPath` field so the user can see the photo:
```
![photo]({webPath})
```

Then on the next line describe what you see. Example response:
```
![photo](/snapshots/snap_20260412_192411.jpg)

Here is what I see in the photo: ...
```

Do NOT show the raw JSON.

## Capture only (save without analyzing)

```
webcam_capture({})
```

Returns `{"ok": true, "path": "...", "webPath": "/snapshots/...", "bytes": N}`.
Embed the image with `![photo]({webPath})` and tell the user where it was saved.

## Custom vision prompts

Pass any question as the `prompt`:
```
webcam_capture({ prompt: "How many people are in this photo and what are they doing?" })
```

```
webcam_capture({ prompt: "Is there anything unusual or notable in this scene?" })
```

## Use a different camera

If camera 0 fails, try camera index 1 (IR camera or secondary):
```
webcam_capture({ prompt: "Describe what you see.", cam: 1 })
```

## Error handling

- If `"ok": false` and error mentions `cv2` → call `bash_exec` with `where.exe python` to find Python, then run `<pythonExe> -m pip install opencv-python`
- If `Cannot open camera` → retry with `cam: 1`
- If tool returns non-JSON or crashes → check the HEARTBEAT for system status

## Guidelines

- Always use `webcam_capture` — never manually invoke the Python script via bash_exec
- Present `description` cleanly to the user
- Tell the user where the snapshot was saved
- Tailor the vision prompt to the user's specific question
