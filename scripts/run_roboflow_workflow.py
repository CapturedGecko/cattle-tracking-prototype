import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from inference_sdk import InferenceHTTPClient

ROOT = Path(__file__).resolve().parents[1]
DATA_LATEST = ROOT / "data" / "latest"
INPUT_DIR = ROOT / "inputs"
TILE_META_PATH = INPUT_DIR / "tile_meta.json"


def ensure_dirs():
    DATA_LATEST.mkdir(parents=True, exist_ok=True)
    INPUT_DIR.mkdir(parents=True, exist_ok=True)


def find_image() -> Optional[Path]:
    for name in ["test.jpg", "test.jpeg", "test.png"]:
        p = INPUT_DIR / name
        if p.exists():
            return p
    return None


def save_json(path: Path, obj: Any):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2), encoding="utf-8")


def load_json(path: Path) -> Optional[Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


# ---- minimal image size reader (no extra deps) ----
def get_image_size(path: Path) -> Optional[Tuple[int, int]]:
    data = path.read_bytes()

    # PNG: width/height in IHDR chunk
    if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) >= 24:
        w = int.from_bytes(data[16:20], "big")
        h = int.from_bytes(data[20:24], "big")
        return w, h

    # JPEG: parse markers for SOF0/SOF2
    if data[:2] == b"\xff\xd8":
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker = data[i + 1]
            i += 2
            # skip padding
            while marker == 0xFF and i < len(data):
                marker = data[i]
                i += 1
            if i + 1 >= len(data):
                break
            seg_len = int.from_bytes(data[i:i+2], "big")
            if seg_len < 2:
                break
            # SOF0 (0xC0) / SOF2 (0xC2)
            if marker in (0xC0, 0xC2) and i + 7 < len(data):
                # i points to length; layout: len(2) precision(1) height(2) width(2)
                h = int.from_bytes(data[i+3:i+5], "big")
                w = int.from_bytes(data[i+5:i+7], "big")
                return w, h
            i += seg_len
    return None


def load_bbox() -> Optional[Dict[str, float]]:
    meta = load_json(TILE_META_PATH)
    if not isinstance(meta, dict):
        return None
    bbox = meta.get("bbox_wgs84")
    if not isinstance(bbox, dict):
        return None
    try:
        west = float(bbox["west"])
        south = float(bbox["south"])
        east = float(bbox["east"])
        north = float(bbox["north"])
        if not (west < east and south < north):
            return None
        return {"west": west, "south": south, "east": east, "north": north}
    except Exception:
        return None


# ---- robust-ish extraction of detection dicts from unknown workflow shapes ----
def _collect_candidate_lists(obj: Any, out: List[List[Dict[str, Any]]]):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ("predictions", "detections", "objects") and isinstance(v, list):
                # keep only dict items
                dict_items = [x for x in v if isinstance(x, dict)]
                if dict_items:
                    out.append(dict_items)
            _collect_candidate_lists(v, out)
    elif isinstance(obj, list):
        for it in obj:
            _collect_candidate_lists(it, out)


def extract_detections(result: Any) -> List[Dict[str, Any]]:
    candidates: List[List[Dict[str, Any]]] = []
    _collect_candidate_lists(result, candidates)
    if not candidates:
        return []

    # pick the "best" candidate list = most items that look like have x,y
    def score(lst: List[Dict[str, Any]]) -> int:
        s = 0
        for d in lst:
            if ("x" in d and "y" in d) or ("bbox" in d) or ("bounding_box" in d):
                s += 1
        return s

    best = max(candidates, key=score)
    # filter to only those with usable coordinates
    usable = []
    for d in best:
        if ("x" in d and "y" in d) or ("bbox" in d) or ("bounding_box" in d):
            usable.append(d)
    return usable


def det_center_xy(det: Dict[str, Any]) -> Optional[Tuple[float, float]]:
    # Most common: x,y are centers in pixels
    if "x" in det and "y" in det:
        try:
            return float(det["x"]), float(det["y"])
        except Exception:
            pass

    # Sometimes bbox-style
    bb = det.get("bbox") or det.get("bounding_box")
    if isinstance(bb, dict):
        # try common keys
        for keys in [("x", "y"), ("center_x", "center_y")]:
            if keys[0] in bb and keys[1] in bb:
                try:
                    return float(bb[keys[0]]), float(bb[keys[1]])
                except Exception:
                    pass
        # or left/top/width/height
        if all(k in bb for k in ("x", "y", "width", "height")):
            try:
                return float(bb["x"]) + float(bb["width"]) / 2.0, float(bb["y"]) + float(bb["height"]) / 2.0
            except Exception:
                pass
    return None


def det_conf(det: Dict[str, Any]) -> Optional[float]:
    for k in ("confidence", "conf", "score", "probability"):
        if k in det:
            try:
                return float(det[k])
            except Exception:
                return None
    return None


def pixel_to_lonlat(x: float, y: float, w: int, h: int, bbox: Dict[str, float]) -> Tuple[float, float]:
    """
    Assumes:
    - x increases to the right
    - y increases downward
    - bbox is WGS84 edges of the image
    """
    west, south, east, north = bbox["west"], bbox["south"], bbox["east"], bbox["north"]
    lon = west + (x / max(1, w)) * (east - west)
    lat = north - (y / max(1, h)) * (north - south)
    return lon, lat


def main():
    ensure_dirs()

    api_key = os.environ.get("ROBOFLOW_API_KEY")
    workspace = os.environ.get("ROBOFLOW_WORKSPACE")
    workflow_id = os.environ.get("ROBOFLOW_WORKFLOW_ID")

    if not api_key or not workspace or not workflow_id:
        raise RuntimeError("Missing env vars. Need ROBOFLOW_API_KEY, ROBOFLOW_WORKSPACE, ROBOFLOW_WORKFLOW_ID")

    img_path = find_image()
    now = datetime.now(timezone.utc).isoformat()

    if not img_path:
        meta = {
            "status": "no_input_image",
            "message": "Add an image at inputs/test.jpg (or .png) to run inference.",
            "updated_utc": now
        }
        save_json(DATA_LATEST / "meta.json", meta)
        save_json(DATA_LATEST / "detections.geojson", {"type": "FeatureCollection", "features": []})
        save_json(DATA_LATEST / "raw_inference.json", {})
        save_json(DATA_LATEST / "ingest_meta.json", {"status": "no_input_image", "updated_utc": now})
        print("No input image found.")
        return

    bbox = load_bbox()
    img_size = get_image_size(img_path)

    # Run Roboflow
    client = InferenceHTTPClient(api_url="https://serverless.roboflow.com", api_key=api_key)
    result = client.run_workflow(
        workspace_name=workspace,
        workflow_id=workflow_id,
        images={"image": str(img_path)},
        use_cache=True
    )

    # Always save reminder truth
    save_json(DATA_LATEST / "raw_inference.json", result)

    ingest_meta = {
        "status": "ok",
        "input_image": str(img_path.relative_to(ROOT)),
        "updated_utc": now,
        "tile_meta_found": TILE_META_PATH.exists(),
        "bbox_wgs84": bbox,
        "image_size_px": {"width": img_size[0], "height": img_size[1]} if img_size else None,
        "note": "detections.geojson requires bbox_wgs84 + image size to convert pixels -> lat/lon."
    }
    save_json(DATA_LATEST / "ingest_meta.json", ingest_meta)

    # If we can’t georeference, keep empty but explain why
    if not bbox or not img_size:
        meta = {
            "status": "needs_georeference",
            "updated_utc": now,
            "message": "Cannot convert detections to lat/lon yet. Add inputs/tile_meta.json with bbox_wgs84 and ensure image size is readable.",
            "tile_meta_exists": TILE_META_PATH.exists(),
            "bbox_ok": bool(bbox),
            "image_size_ok": bool(img_size)
        }
        save_json(DATA_LATEST / "meta.json", meta)
        save_json(DATA_LATEST / "detections.geojson", {"type": "FeatureCollection", "features": []})
        print("Missing bbox or image size; wrote empty detections.geojson.")
        return

    w, h = img_size
    dets = extract_detections(result)

    features = []
    for d in dets:
        xy = det_center_xy(d)
        if not xy:
            continue
        x, y = xy
        lon, lat = pixel_to_lonlat(x, y, w, h, bbox)

        conf = det_conf(d)
        cls = d.get("class") or d.get("label") or d.get("name")

        features.append({
            "type": "Feature",
            "properties": {
                "conf": conf,
                "class": cls,
                "source": "roboflow_workflow"
            },
            "geometry": {"type": "Point", "coordinates": [lon, lat]}
        })

    detections_geojson = {"type": "FeatureCollection", "features": features}
    save_json(DATA_LATEST / "detections.geojson", detections_geojson)

    meta = {
        "status": "ok",
        "updated_utc": now,
        "input_image": str(img_path.relative_to(ROOT)),
        "detections_written": len(features),
        "note": "Converted pixel centers to lat/lon using bbox_wgs84 in inputs/tile_meta.json."
    }
    save_json(DATA_LATEST / "meta.json", meta)

    print(f"Wrote {len(features)} detections to data/latest/detections.geojson")


if __name__ == "__main__":
    main()
