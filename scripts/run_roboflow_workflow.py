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


def empty_geojson():
    return {"type": "FeatureCollection", "features": []}


def find_image() -> Optional[Path]:
    for name in ["test.jpg", "test.jpeg", "test.png"]:
        p = INPUT_DIR / name
        if p.exists():
            return p
    return None


def find_base64_image(obj: Any) -> Optional[str]:
    """
    Finds a long base64 image string (jpg starts with /9j/, png starts with iVBORw0).
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


def strip_big_base64(obj: Any) -> Any:
    """
    Replace huge base64 strings with a placeholder so json stays small.
    """
    if isinstance(obj, dict):
        return {k: strip_big_base64(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [strip_big_base64(v) for v in obj]
    if isinstance(obj, str):
        s = obj.strip()
        if len(s) > 5000 and (s.startswith("/9j/") or s.startswith("iVBORw0")):
            return "<base64_image_removed>"
    return obj


def collect_predictions(obj: Any) -> List[dict]:
    """
    Collect all dict items inside any nested list named 'predictions'.
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


def main():
    ensure_dirs()

    api_key = (os.environ.get("ROBOFLOW_API_KEY") or "").strip()
    workspace = (os.environ.get("ROBOFLOW_WORKSPACE") or "").strip()
    workflow_id = (os.environ.get("ROBOFLOW_WORKFLOW_ID") or "").strip()

    # Always keep map-safe files present
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
            "message": "Upload an image to inputs/test.jpg (or test.png) then rerun.",
            "updated_utc": utc_now(),
        }
        save_json(DATA_LATEST / "meta.json", meta)
        print("No input image found.")
        return

    client = InferenceHTTPClient(api_url="https://serverless.roboflow.com", api_key=api_key)

    result = client.run_workflow(
        workspace_name=workspace,
        workflow_id=workflow_id,
        images={"image": str(img_path)},
        use_cache=True
    )

    # Save annotated image separately (if present)
    b64 = find_base64_image(result)
    if b64:
        try:
            (DATA_LATEST / "annotated.jpg").write_bytes(base64.b64decode(b64))
        except Exception:
            pass

    preds = collect_predictions(result)

    # Save a SMALL summary file (safe to commit)
    summary = {
        "updated_utc": utc_now(),
        "input_image": str(img_path.relative_to(ROOT)),
        "workspace": workspace,
        "workflow_id": workflow_id,
        "predictions_found": len(preds),
        "top_level_keys": list(result[0].keys()) if isinstance(result, list) and result and isinstance(result[0], dict) else None,
    }

    # Also capture top-level numeric outputs (like Cattle_Group)
    if isinstance(result, list) and result and isinstance(result[0], dict):
        for k, v in result[0].items():
            if isinstance(v, (int, float)):
                summary[k] = v

    save_json(DATA_LATEST / "roboflow_summary.json", summary)

    meta = {
        "status": "ok",
        "updated_utc": utc_now(),
        "input_image": str(img_path.relative_to(ROOT)),
        "predictions_found": len(preds),
        "note": "roboflow_summary.json saved (small). annotated.jpg saved if present. detections.geojson empty until georeferencing is added.",
    }
    save_json(DATA_LATEST / "meta.json", meta)

    # Keep map safe
    save_json(DATA_LATEST / "detections.geojson", empty_geojson())

    print("Saved meta.json + roboflow_summary.json (+ annotated.jpg if present).")


if __name__ == "__main__":
    main()
