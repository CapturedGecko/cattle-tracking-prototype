import base64
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from inference_sdk import InferenceHTTPClient

ROOT = Path(__file__).resolve().parents[1]
DATA_LATEST = ROOT / "data" / "latest"
INPUT_DIR = ROOT / "inputs"


def ensure_dirs():
    DATA_LATEST.mkdir(parents=True, exist_ok=True)
    INPUT_DIR.mkdir(parents=True, exist_ok=True)


def save_json(path: Path, obj: Any):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2), encoding="utf-8")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def find_image() -> Optional[Path]:
    # You must put a real test image here: inputs/test.jpg (or .png)
    for name in ["test.jpg", "test.jpeg", "test.png"]:
        p = INPUT_DIR / name
        if p.exists():
            return p
    return None


def empty_geojson():
    return {"type": "FeatureCollection", "features": []}


def collect_predictions(obj: Any) -> List[dict]:
    """
    Roboflow workflow outputs vary a lot. This walks the response and collects
    every dict inside any list called 'predictions'.
    """
    found: List[dict] = []

    def walk(x: Any):
        if isinstance(x, dict):
            if "predictions" in x and isinstance(x["predictions"], list):
                for p in x["predictions"]:
                    if isinstance(p, dict):
                        found.append(p)
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)

    walk(obj)
    return found


def find_base64_image(obj: Any) -> Optional[str]:
    """
    Your workflow returns a base64 JPEG string that starts with /9j/
    (or base64 PNG that starts with iVBORw0). We save it to annotated.jpg.
    """
    candidate = None

    def walk(x: Any):
        nonlocal candidate
        if candidate is not None:
            return
        if isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
        elif isinstance(x, str):
            s = x.strip()
            if len(s) > 5000 and (s.startswith("/9j/") or s.startswith("iVBORw0")):
                candidate = s

    walk(obj)
    return candidate


def main():
    ensure_dirs()

    api_key = (os.environ.get("ROBOFLOW_API_KEY") or "").strip()
    workspace = (os.environ.get("ROBOFLOW_WORKSPACE") or "").strip()
    workflow_id = (os.environ.get("ROBOFLOW_WORKFLOW_ID") or "").strip()

    # Always keep these files present so the site never crashes
    save_json(DATA_LATEST / "detections.geojson", empty_geojson())

    if not api_key or not workspace or not workflow_id:
        meta = {
            "status": "missing_env",
            "message": "Missing env vars: ROBOFLOW_API_KEY, ROBOFLOW_WORKSPACE, ROBOFLOW_WORKFLOW_ID",
            "have_api_key": bool(api_key),
            "have_workspace": bool(workspace),
            "have_workflow_id": bool(workflow_id),
            "updated_utc": utc_now(),
        }
        save_json(DATA_LATEST / "meta.json", meta)
        raise SystemExit("Missing required secrets.")

    img_path = find_image()
    if not img_path:
        meta = {
            "status": "no_input_image",
            "message": "Upload a test image to inputs/test.jpg (or test.png) then rerun.",
            "updated_utc": utc_now(),
        }
        save_json(DATA_LATEST / "meta.json", meta)
        print("No input image found.")
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

    # Save raw output for debugging
    save_json(DATA_LATEST / "raw_inference.json", result)

    # Save any base64 annotated image if present
    b64 = find_base64_image(result)
    if b64:
        try:
            (DATA_LATEST / "annotated.jpg").write_bytes(base64.b64decode(b64))
        except Exception:
            pass

    preds = collect_predictions(result)

    # For now: we are NOT converting to lat/lon. So we only record counts + prediction count.
    # (Map points come later once you have georeferencing.)
    meta = {
        "status": "ok",
        "updated_utc": utc_now(),
        "input_image": str(img_path.relative_to(ROOT)),
        "predictions_found": len(preds),
        "note": "raw_inference.json saved. detections.geojson stays empty until georeferencing is implemented."
    }
    save_json(DATA_LATEST / "meta.json", meta)

    # Keep empty GeoJSON (prevents breaking the map)
    save_json(DATA_LATEST / "detections.geojson", empty_geojson())

    print("Saved data/latest/raw_inference.json + meta.json (+ annotated.jpg if present).")


if __name__ == "__main__":
    main()
