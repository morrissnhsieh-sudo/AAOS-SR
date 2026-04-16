#!/usr/bin/env python3
"""
AAOS Webcam Capture + Vision Analysis
Usage:
  python webcam_capture.py capture                     # save snapshot, print path
  python webcam_capture.py analyze "prompt"            # capture + describe with Gemini
  python webcam_capture.py analyze "prompt" --cam 1   # use camera index 1
"""
import sys, os, time, base64, json, argparse, tempfile
from pathlib import Path

CREDS  = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS',
         r'C:\Users\User\OneDrive\USI-Sync\AI Development\VertexKeys\d-sxd110x-ssd1-cdl-429bd22f2ba7.json')
PROJECT = os.environ.get('VERTEX_PROJECT_ID', 'd-sxd110x-ssd1-cdl')
LOCATION= os.environ.get('VERTEX_LOCATION',   'us-central1')
MODEL   = os.environ.get('VERTEX_MODEL',       'gemini-2.0-flash')

# Use the same directory that the AAOS web server serves from.
# The Node.js server passes AAOS_SNAPSHOTS_DIR explicitly when spawning this script.
_default_snap_dir = Path(tempfile.gettempdir()) / 'aaos_snapshots'
SNAP_DIR = Path(os.environ.get('AAOS_SNAPSHOTS_DIR', str(_default_snap_dir)))


def capture_frame(cam_index: int = 0) -> bytes:
    try:
        import cv2
    except ImportError:
        print(json.dumps({"error": "opencv-python not installed. Run: pip install opencv-python"}))
        sys.exit(1)

    SNAP_DIR.mkdir(parents=True, exist_ok=True)
    cap = cv2.VideoCapture(cam_index)
    if not cap.isOpened():
        print(json.dumps({"error": f"Cannot open camera index {cam_index}"}))
        sys.exit(1)

    time.sleep(0.8)   # let the sensor settle / auto-expose
    ret, frame = cap.read()
    cap.release()

    if not ret:
        print(json.dumps({"error": "Camera opened but failed to capture a frame"}))
        sys.exit(1)

    ts   = time.strftime('%Y%m%d_%H%M%S')
    path = SNAP_DIR / f'snap_{ts}.jpg'
    cv2.imwrite(str(path), frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
    return path, open(path, 'rb').read()


def analyze_image(img_bytes: bytes, prompt: str) -> str:
    os.environ['GOOGLE_APPLICATION_CREDENTIALS'] = CREDS  # already from env or fallback
    try:
        from google import genai
        from google.genai import types
    except ImportError:
        return "ERROR: google-genai not installed. Run: pip install google-genai"

    client   = genai.Client(vertexai=True, project=PROJECT, location=LOCATION)
    response = client.models.generate_content(
        model=MODEL,
        contents=[
            types.Part.from_bytes(data=img_bytes, mime_type='image/jpeg'),
            prompt
        ]
    )
    return response.text


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['capture', 'analyze'])
    parser.add_argument('prompt', nargs='?', default='Describe what you see in this photo in detail.')
    parser.add_argument('--cam', type=int, default=0)
    args = parser.parse_args()

    path, img_bytes = capture_frame(args.cam)

    if args.command == 'capture':
        print(json.dumps({
            "ok": True,
            "path": str(path),
            "bytes": len(img_bytes)
        }))
        return

    # analyze
    description = analyze_image(img_bytes, args.prompt)
    print(json.dumps({
        "ok": True,
        "path": str(path),
        "bytes": len(img_bytes),
        "description": description
    }))


if __name__ == '__main__':
    main()
