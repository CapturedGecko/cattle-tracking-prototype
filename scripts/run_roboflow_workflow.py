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
    # The Sentinel fetch script should create inputs/test.jpg
    for name in ["test.jpg", "test.jpeg", "test.png"]:
        p = INPUT_DIR / name
        if p.exists():
            return p
    return None


def save_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2), encoding="utf-8")


def empty_geojson():
    return {"type": "FeatureCollection", "features": []}


def main():
    ensure_dirs()

    # Read secrets from environment (GitHub Actions)
    api_key = (os.environ.get("ROBOFLOW_API_KEY") or "").strip()
    workspace = (os.environ.get("ROBOFLOW_WORKSPACE") or "").strip()
    workflow_id = (os.environ.get("ROBOFLOW_WORKFLOW_ID") or "").strip()

    # Always keep a detections file present so the site never crashes
    save_json(DATA_LATEST / "detections.geojson", empty_geojson())

    if not api_key or not workspace or not workflow_id:
        meta = {
            "status": "missing_env",
            "message": "Missing env vars. Need ROBOFLOW_API_KEY, ROBOFLOW_WORKSPACE, ROBOFLOW_WORKFLOW_ID",
            "have_api_key": bool(api_key),
            "have_workspace": bool(workspace),
            "have_workflow_id": bool(workflow_id),
            "updated_utc": datetime.now(timezone.utc).isoformat(),
        }
        save_json(DATA_LATEST / "meta.json", meta)
        raise SystemExit("Missing required env vars (secrets).")

    img_path = find_image()
    if not img_path:
        meta = {
            "status": "no_input_image",
            "message": "No input image found at inputs/test.jpg/png. (Did fetch_sentinel2_thumbnail.py run?)",
            "updated_utc": datetime.now(timezone.utc).isoformat(),
        }
        save_json(DATA_LATEST / "meta.json", meta)
        print("No input image. Wrote meta.json + empty detections.geojson")
        return

    # Connect to Roboflow serverless inference
    client = InferenceHTTPClient(
        api_url="https://serverless.roboflow.com",
        api_key=api_key,
    )

    try:
        result = client.run_workflow(
            workspace_name=workspace,
            workflow_id=workflow_id,
            images={"image": str(img_path)},
            use_cache=True,
        )

        # Save raw output (best debugging artifact)
        save_json(DATA_LATEST / "raw_inference.json", result)

        meta = {
            "status": "ok",
            "input_image": str(img_path.relative_to(ROOT)),
            "workspace": workspace,
            "workflow_id": workflow_id,
            "updated_utc": datetime.now(timezone.utc).isoformat(),
            "note": "raw_inference.json saved. detections.geojson stays empty until we add georeferencing (lat/lon).",
        }
        save_json(DATA_LATEST / "meta.json", meta)

        print("Saved data/latest/raw_inference.json + meta.json (+ empty detections.geojson)")

    except Exception as e:
        # Common failure: 401 Unauthorized (bad key / wrong workspace+workflow / secrets not wired)
        msg = str(e)
        status = "roboflow_error"
        if "401" in msg or "Unauthorized" in msg:
            status = "roboflow_unauthorized"

        meta = {
            "status": status,
            "input_image": str(img_path.relative_to(ROOT)),
            "workspace": workspace,
            "workflow_id": workflow_id,
            "error": msg,
            "updated_utc": datetime.now(timezone.utc).isoformat(),
        }
        save_json(DATA_LATEST / "meta.json", meta)
        raise


if __name__ == "__main__":
    main()
