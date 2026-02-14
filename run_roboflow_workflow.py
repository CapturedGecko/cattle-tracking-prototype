import json
import os
from datetime import datetime, timezone
from pathlib import Path

from inference_sdk import InferenceHTTPClient

ROOT = Path(__file__).resolve().parents[1]
DATA_LATEST = ROOT / "data" / "latest"
INPUT_DIR = ROOT / "inputs"

def ensure_dirs():
    DATA_LATEST.mkdir(parents=True, exist_ok=True)
    INPUT_DIR.mkdir(parents=True, exist_ok=True)

def find_image():
    # Put ONE test image here: inputs/test.jpg (or png)
    for name in ["test.jpg", "test.jpeg", "test.png"]:
        p = INPUT_DIR / name
        if p.exists():
            return p
    return None

def save_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2), encoding="utf-8")

def main():
    ensure_dirs()

    api_key = os.environ.get("ROBOFLOW_API_KEY")
    workspace = os.environ.get("ROBOFLOW_WORKSPACE")
    workflow_id = os.environ.get("ROBOFLOW_WORKFLOW_ID")

    if not api_key or not workspace or not workflow_id:
        raise RuntimeError("Missing env vars. Need ROBOFLOW_API_KEY, ROBOFLOW_WORKSPACE, ROBOFLOW_WORKFLOW_ID")

    img_path = find_image()
    if not img_path:
        # No image yet: write a marker file so you know the Action ran
        meta = {
            "status": "no_input_image",
            "message": "Add an image at inputs/test.jpg (or .png) to run inference.",
            "updated_utc": datetime.now(timezone.utc).isoformat()
        }
        save_json(DATA_LATEST / "meta.json", meta)

        # Create empty GeoJSON so the site doesn't error
        empty_geojson = {"type": "FeatureCollection", "features": []}
        save_json(DATA_LATEST / "detections.geojson", empty_geojson)
        print("No input image found. Wrote meta.json + empty detections.geojson")
        return

    client = InferenceHTTPClient(
        api_url="https://serverless.roboflow.com",
        api_key=api_key
    )

    result = client.run_workflow(
        workspace_name=workspace,
        workflow_id=workflow_id,
        images={"image": str(img_path)},
        use_cache=True
    )

    # Save raw output (this is the MOST important debugging artifact)
    save_json(DATA_LATEST / "raw_inference.json", result)

    # For now, we do NOT have georeferencing -> so we can’t place detections on the map as lat/lon yet.
    # We'll create an empty GeoJSON and keep the raw output for later conversion.
    empty_geojson = {"type": "FeatureCollection", "features": []}
    save_json(DATA_LATEST / "detections.geojson", empty_geojson)

    meta = {
        "status": "ok",
        "input_image": str(img_path.relative_to(ROOT)),
        "updated_utc": datetime.now(timezone.utc).isoformat(),
        "note": "raw_inference.json saved. detections.geojson empty until we add georeferencing."
    }
    save_json(DATA_LATEST / "meta.json", meta)

    print("Saved data/latest/raw_inference.json + meta.json (+ empty detections.geojson)")

if __name__ == "__main__":
    main()
