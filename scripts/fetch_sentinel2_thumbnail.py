import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
INPUTS_DIR = ROOT / "inputs"
LATEST_DIR = ROOT / "data" / "latest"

# Rough bbox for South Sudan: [minLon, minLat, maxLon, maxLat]
# You can tighten later to regions like Jonglei if you want faster/more relevant pulls.
SOUTH_SUDAN_BBOX = [24.0, 3.0, 36.0, 13.0]

EARTH_SEARCH = "https://earth-search.aws.element84.com/v1/search"

def ensure_dirs():
    INPUTS_DIR.mkdir(parents=True, exist_ok=True)
    LATEST_DIR.mkdir(parents=True, exist_ok=True)

def stac_search(bbox, days_back=10, cloud_lt=30, limit=25):
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days_back)
    body = {
        "collections": ["sentinel-2-l2a"],
        "bbox": bbox,
        "datetime": f"{start.isoformat().replace('+00:00','Z')}/{end.isoformat().replace('+00:00','Z')}",
        "limit": limit,
        "query": {
            "eo:cloud_cover": {"lt": cloud_lt}
        }
    }
    r = requests.post(EARTH_SEARCH, json=body, timeout=60)
    r.raise_for_status()
    return r.json()

def pick_best_feature(fc):
    feats = fc.get("features", [])
    if not feats:
        return None
    # sort by cloud cover ascending if available
    def cloud(f):
        return f.get("properties", {}).get("eo:cloud_cover", 9999)
    feats.sort(key=cloud)
    return feats[0]

def pick_preview_asset(feature):
    assets = feature.get("assets", {}) or {}
    # common preview keys
    for k in ["thumbnail", "rendered_preview", "preview", "overview", "visual"]:
        if k in assets and "href" in assets[k]:
            return k, assets[k]["href"]

    # fallback: first jpg/png asset
    for k, v in assets.items():
        href = (v or {}).get("href", "")
        if isinstance(href, str) and (href.lower().endswith(".jpg") or href.lower().endswith(".jpeg") or href.lower().endswith(".png")):
            return k, href

    return None, None

def download_image(url, out_path: Path):
    with requests.get(url, stream=True, timeout=120) as r:
        r.raise_for_status()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "wb") as f:
            for chunk in r.iter_content(chunk_size=1024 * 128):
                if chunk:
                    f.write(chunk)

def main():
    ensure_dirs()

    # 1) Search Sentinel-2 L2A on the free Earth Search STAC API (AWS open data index)
    fc = stac_search(SOUTH_SUDAN_BBOX, days_back=14, cloud_lt=40)

    feat = pick_best_feature(fc)
    if not feat:
        # If no results, save a marker so you can see it ran
        meta = {
            "status": "no_sentinel2_found",
            "bbox": SOUTH_SUDAN_BBOX,
            "updated_utc": datetime.now(timezone.utc).isoformat()
        }
        (LATEST_DIR / "ingest_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        print("No Sentinel-2 scenes found for bbox/date range.")
        return

    asset_key, href = pick_preview_asset(feat)
    if not href:
        meta = {
            "status": "no_preview_asset",
            "item_id": feat.get("id"),
            "note": "Scene found, but no thumbnail/preview asset available to download.",
            "updated_utc": datetime.now(timezone.utc).isoformat()
        }
        (LATEST_DIR / "ingest_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        print("Found a scene but no preview asset to download.")
        return

    # 2) Download preview image to inputs/test.jpg so your Roboflow script can use it
    out_img = INPUTS_DIR / "test.jpg"
    download_image(href, out_img)

    # 3) Save metadata for debugging + later georeferencing work
    meta = {
        "status": "ok",
        "source": "earth-search (STAC) sentinel-2-l2a",
        "item_id": feat.get("id"),
        "datetime": feat.get("properties", {}).get("datetime"),
        "cloud_cover": feat.get("properties", {}).get("eo:cloud_cover"),
        "asset_key": asset_key,
        "asset_href": href,
        "bbox_used": SOUTH_SUDAN_BBOX,
        "saved_image": "inputs/test.jpg",
        "updated_utc": datetime.now(timezone.utc).isoformat()
    }
    (LATEST_DIR / "ingest_meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    print("Downloaded Sentinel-2 preview to inputs/test.jpg")

if __name__ == "__main__":
    main()
