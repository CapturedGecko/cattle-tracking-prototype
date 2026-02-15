import base64
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from inference_sdk import InferenceHTTPClient

ROOT = Path(__file__).resolve().parents[1]
DATA_LATEST = ROOT / "data" / "latest"
INPUT_DIR = ROOT / "inputs"


def ensure_dirs():
    DATA_LATEST.mkdir(parents=True, exist_ok=True)
    INPUT_DIR.mkdir(parents=True, exist_ok=True)


def save_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2), encoding="utf-8")


def load_json(path: Path) -> Optional[dict]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def find_image():
    for name in ["test.jpg", "test.jpeg", "test.png"]:
        p = INPUT_DIR / name
        if p.exists():
            return p
    return None


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def collect_predictions(obj: Any) -> List[dict]:
    """
    Roboflow workflow outputs vary by block. This finds any nested dict with key 'predictions'
    that is a list[dict].
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


def find_base64_jpeg(obj: Any) -> Optional[str]:
    """
    Your output contains a key with a base64 JPEG string (starts with /9j/).
    We'll find the first long-ish base64 string that looks like a jpg/png and save it.
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


def bbox_center(bbox: List[float]) -> Tuple[float, float]:
    minlon, minlat, maxlon, maxlat = bbox
    return (minlon + maxlon) / 2.0, (minlat + maxlat) / 2.0


def pixel_to_lonlat(x_px: float, y_px: float, w: int, h: int, bbox: List[float]) -> Tuple[float, float]:
    """
    Assumes the image represents bbox_wgs84 with (0,0) at top-left.
    Roboflow usually gives x,y as pixel centers in image coordinates.
    """
    minlon, minlat, maxlon, maxlat = bbox
    lon = minlon + (x_px / max(1, w)) * (maxlon - minlon)
    lat = maxlat - (y_px / max(1, h)) * (maxlat - minlat)
    return lon, lat


def make_geojson_points(preds: List[dict], ingest: Optional[dict]) -> Dict[str, Any]:
    """
    Convert predictions to GeoJSON points if we know bbox + image size.
    If we can't, returns empty FC.
    """
    fc = {"type": "FeatureCollection", "features": []}

    if not ingest:
        return fc

    bbox = ingest.get("bbox_wgs84")
    img_px = ingest.get("image_px", {})
    w = int(img_px.get("width", 0) or 0)
    h = int(img_px.get("height", 0) or 0)

    if not (isinstance(bbox, list) and len(bbox) == 4 and w > 0 and h > 0):
        return fc

    for p in preds:
        # common keys: x,y,width,height,confidence,class
        x = p.get("x", None)
        y = p.get("y", None)
        conf = p.get("confidence", p.get("conf", None))
        cls = p.get("class", p.get("label", None))

        if isinstance(x, (int, float)) and isinstance(y, (int, float)):
            lon, lat = pixel_to_lonlat(float(x), float(y), w, h, bbox)
            fc["features"].append(
                {
                    "type": "Feature",
                    "properties": {
                        "source": "roboflow",
                        "class": cls,
                        "conf": conf,
                        "x_px": x,
                        "y_px": y,
                    },
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                }
            )

    return fc


def main():
    ensure_dirs()

    api_key = os.environ.get("ROBOFLOW_API_KEY")
    workspace = os.environ.get("ROBOFLOW_WORKSPACE")
    workflow_id = os.environ.get("ROBOFLOW_WORKFLOW_ID")

    if not api_key or not workspace or not workflow_id:
        raise RuntimeError("Missing env vars. Need ROBOFLOW_API_KEY, ROBOFLOW_WORKSPACE, ROBOFLOW_WORKFLOW_ID")

    img_path = find_image()
    if not img_path:
        meta = {
            "status": "no_input_image",
            "message": "Add an image at inputs/test.jpg (or .png) to run inference.",
            "updated_utc": utc_now(),
        }
        save_json(DATA_LATEST / "meta.json", meta)
        save_json(DATA_LATEST / "detections.geojson", {"type": "FeatureCollection", "features": []})
        print("No input image found.")
        return

    ingest = load_json(DATA_LATEST / "ingest_meta.json")

    client = InferenceHTTPClient(api_url="https://serverless.roboflow.com", api_key=api_key)

    result = client.run_workflow(
        workspace_name=workspace,
        workflow_id=workflow_id,
        images={"image": str(img_path)},
        use_cache=True,
    )

    save_json(DATA_LATEST / "raw_inference.json", result)

    # Save any base64 image returned by workflow (yours has one)
    b64 = find_base64_jpeg(result)
    if b64:
        out_img = DATA_LATEST / "annotated.jpg"
        out_img.write_bytes(base64.b64decode(b64))
        print(f"Wrote {out_img}")

    preds = collect_predictions(result)

    # If predictions are empty, still drop a center marker with any count-like fields
    geo = make_geojson_points(preds, ingest)
    if len(geo["features"]) == 0 and isinstance(ingest, dict) and isinstance(ingest.get("bbox_wgs84"), list):
        lon, lat = bbox_center(ingest["bbox_wgs84"])

        # pull any top-level numeric outputs (like Cattle_Group)
        count_like = {}
        try:
            if isinstance(result, list) and result and isinstance(result[0], dict):
                for k, v in result[0].items():
                    if isinstance(v, (int, float)) and k.lower().endswith(("count", "group")):
                        count_like[k] = v
                    if k == "Cattle_Group" and isinstance(v, (int, float)):
                        count_like[k] = v
        except Exception:
            pass

        geo["features"].append(
            {
                "type": "Feature",
                "properties": {
                    "source": "roboflow_fallback",
                    "note": "No box predictions found; showing AOI center marker instead.",
                    **count_like,
                },
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
            }
        )

    save_json(DATA_LATEST / "detections.geojson", geo)

    meta = {
        "status": "ok",
        "input_image": str(img_path.relative_to(ROOT)),
        "updated_utc": utc_now(),
        "predictions_found": len(preds),
        "geojson_points": len(geo.get("features", [])),
        "note": "raw_inference.json saved. detections.geojson generated (or fallback center marker).",
    }
    save_json(DATA_LATEST / "meta.json", meta)

    print("Saved data/latest/raw_inference.json + meta.json + detections.geojson")


if __name__ == "__main__":
    main()
