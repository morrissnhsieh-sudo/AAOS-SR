---
name: shelf-restock-monitor
description: Monitor supermarket shelf camera footage to identify items requiring restocking and generate prioritized restock reports with multi-agent task dispatch.
allowed-tools: bash_exec file_write file_read file_list think
version: 1.0.0
---

# Shelf Restock Monitor

Monitor shelf camera footage and produce structured restock intelligence through vision analysis and multi-agent coordination.

## Step 1: Frame Extraction

1. Call `think` with reasoning: "Planning frame extraction from shelf camera videos. Need to sample at 0.5fps, limit to 4 frames per video to balance detail vs API budget."

2. Call `bash_exec` with:
```bash
mkdir -p /home/claude/shelf_frames && for VIDEO in /mnt/user-data/uploads/*.mp4; do NAME=$(basename "$VIDEO" .mp4); ffmpeg -i "$VIDEO" -vf "fps=0.5,scale=640:-1" -frames:v 4 /home/claude/shelf_frames/${NAME}_%03d.jpg -y 2>/dev/null; done && ls -lah /home/claude/shelf_frames/

3. If no frames extracted, report failure and exit.

## Step 2: Frame Quality Triage

1. Call `bash_exec` with:
```bash
python3 << 'TRIAGE_EOF'
import subprocess, os, json

frame_dir = "/home/claude/shelf_frames"
sharp_frames = {}

for fname in sorted(os.listdir(frame_dir)):
    if not fname.endswith(".jpg"):
        continue
    fpath = os.path.join(frame_dir, fname)
    result = subprocess.run(
        ["convert", fpath, "-colorspace", "gray",
         "-define", "convolve:scale=1",
         "-morphology", "Convolve", "Laplacian:0",
         "-format", "%[fx:u.standard_deviation]", "info:"],
        capture_output=True, text=True
    )
    try:
        score = float(result.stdout.strip())
    except:
        score = 0.0
    
    prefix = "_".join(fname.split("_")[:-1])
    if prefix not in sharp_frames or score > sharp_frames[prefix][1]:
        sharp_frames[prefix] = (fpath, score)

result = {k: {"path": v[0], "sharpness": v[1]} for k, v in sharp_frames.items()}
print(json.dumps(result))
TRIAGE_EOF
2. Parse the JSON output to identify best frames per camera.

## Step 3: Vision Analysis

1. Call `think` with reasoning: "Preparing vision analysis prompt. Must extract structured JSON with shelf row assessments, stock levels, and restock urgency ratings."

2. For each selected frame from Step 2, call `bash_exec` with:
```bash
python3 << 'VISION_EOF'
import anthropic, base64, json, sys, os

SYSTEM_PROMPT = """You are a supermarket shelf monitoring agent. Analyze the shelf image and return ONLY a JSON object. No prose. No markdown fences.

For each visible shelf ROW (top to bottom), assess stock levels and identify items that need restocking.

JSON schema:
{
  "camera_id": "<filename>",
  "shelf_section": "<brief description of product category>",
  "shelf_rows": [
    {
      "row_index": 1,
      "row_description": "<what products are on this row>",
      "stock_status": "CRITICAL|LOW|ADEQUATE|FULL",
      "estimated_fill_pct": 0-100,
      "empty_slots_visible": true|false,
      "facings_remaining": "<estimated count or range>",
      "price_tag_visible": true|false,
      "price_tag_value": "<price if readable, else null>",
      "restock_urgency": "IMMEDIATE|SOON|MONITOR|NONE",
      "notes": "<any anomalies: misplaced items, fallen products, blocked tags>"
    }
  ],
  "overall_section_status": "CRITICAL|LOW|ADEQUATE|FULL",
  "recommended_action": "<one-line action for associate>",
  "confidence": "HIGH|MEDIUM|LOW"
}

Stock status thresholds:
- CRITICAL: < 20% filled or visible empty shelf backing
- LOW: 20-50% filled
- ADEQUATE: 50-80% filled
- FULL: > 80% filled"""

image_path = sys.argv[1]
camera_id = sys.argv[2]

client = anthropic.Anthropic()

with open(image_path, "rb") as f:
    image_data = base64.b64encode(f.read()).decode("utf-8")

response = client.messages.create(
    model="claude-sonnet-4-20250514",
    max_tokens=1500,
    system=SYSTEM_PROMPT,
    messages=[{
        "role": "user",
        "content": [
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/jpeg",
                    "data": image_data
                }
            },
            {
                "type": "text",
                "text": f"Camera ID: {camera_id}. Analyze this shelf."
            }
        ]
    }]
)

raw = response.content[0].text.strip()
raw = raw.replace("```json", "").replace("```", "").strip()
print(raw)
VISION_EOF
```

3. Collect all vision analysis results.

## Step 4: Restock Report Assembly

1. Call `bash_exec` with:
```bash
python3 << 'REPORT_EOF'
import json, sys
from datetime import datetime

frame_results = json.loads(sys.stdin.read())

critical_items = []
soon_items = []
monitor_items = []

for result in frame_results:
    cam = result.get("camera_id", "unknown")
    section = result.get("shelf_section", "")
    for row in result.get("shelf_rows", []):
        entry = {
            "camera_id": cam,
            "section": section,
            "row_index": row["row_index"],
            "description": row["row_description"],
            "status": row["stock_status"],
            "fill_pct": row["estimated_fill_pct"],
            "action": result["recommended_action"],
            "urgency": row["restock_urgency"],
        }
        u = row.get("restock_urgency", "NONE")
        if u == "IMMEDIATE":
            critical_items.append(entry)
        elif u == "SOON":
            soon_items.append(entry)
        elif u == "MONITOR":
            monitor_items.append(entry)

report = {
    "report_timestamp": datetime.utcnow().isoformat(),
    "total_rows_analyzed": sum(len(r.get("shelf_rows", [])) for r in frame_results),
    "IMMEDIATE": critical_items,
    "SOON": soon_items,
    "MONITOR": monitor_items,
    "summary": {
        "critical_count": len(critical_items),
        "soon_count": len(soon_items),
        "monitor_count": len(monitor_items),
    }
}

print(json.dumps(report, indent=2))
REPORT_EOF
```

2. Parse the aggregated report JSON.

## Step 5: Save Report and Dispatch Tasks

1. Call `file_write` with path `/mnt/user-data/outputs/restock_report.json` and content set to the report JSON from Step 4.

2. For each IMMEDIATE and SOON item in the report, call `bash_exec` with:
```bash
python3 << 'DISPATCH_EOF'
import json, sys
from datetime import datetime

item = json.loads(sys.stdin.read())

# Associate task
associate_task = {
    "task_type": "RESTOCK",
    "priority": item["urgency"],
    "location": {
        "camera_id": item["camera_id"],
        "shelf_row": item["row_index"],
        "section": item["section"]
    },
    "product_hint": item["description"],
    "action": item["action"],
    "estimated_fill": item["fill_pct"]
}

# Inventory update
inventory_update = {
    "event": "LOW_STOCK_DETECTED",
    "source": "shelf_camera_vision",
    "location_ref": item["camera_id"],
    "shelf_row": item["row_index"],
    "product_description": item["description"],
    "fill_pct": item["fill_pct"],
    "requires_reorder": item["fill_pct"] < 30
}

# Store twin event
twin_event = {
    "topic": f"store/shelf/{item['camera_id']}/row/{item['row_index']}/stock",
    "payload": {
        "status": item["status"],
        "fill_pct": item["fill_pct"],
        "urgency": item["urgency"],
        "ts": datetime.utcnow().isoformat()
    }
}

print(json.dumps({
    "associate_task": associate_task,
    "inventory_update": inventory_update,
    "twin_event": twin_event
}))
DISPATCH_EOF
```

3. Log each dispatch payload.

## Step 6: Emit Completion Event

1. Call `bash_exec` with:
```bash
python3 << 'EVENT_EOF'
import json, sys

report_summary = json.loads(sys.stdin.read())

event = {
    "skill": "shelf-restock-monitor",
    "status": "COMPLETE",
    "report_path": "/mnt/user-data/outputs/restock_report.json",
    "critical_count": report_summary["summary"]["critical_count"],
    "requires_immediate_action": report_summary["summary"]["critical_count"] > 0
}

print(json.dumps(event))
EVENT_EOF
```

2. Present the completion event to the user with a human-readable summary: "Shelf restock analysis complete. Found X critical items requiring immediate attention. Full report saved to /mnt/user-data/outputs/restock_report.json"

## Error Handling

If any step fails:
- Step 1 failure (no frames): Report "No video files found or ffmpeg extraction failed"
- Step 2 failure (triage): Use all extracted frames without quality filtering
- Step 3 failure (vision API): Retry once; if still fails, mark that camera as "ANALYSIS_FAILED" in report
- Step 4 failure (report assembly): Log error and save partial results
- API rate limit: Wait 60 seconds and retry once

Always ensure report file is written even with partial data.
