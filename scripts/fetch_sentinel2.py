import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
from PIL import Image

from pystac_client import Client
import rasterio
from rasterio.windows import from_bounds
from rasterio.warp import transform_bounds


ROOT = Path(__file__).resolve().parents[1]
INPUTS = ROOT / "inputs"
DATA_LATEST = ROOT / "data" / "latest"


def save_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2), encoding="utf-8")


def parse_bbox(s: str):
    # "minLon,minLat,maxLon,maxLat"
    parts = [float(x.strip()) for x in s.split(",")]
    if len(parts) != 4:
        raise ValueError("S2_BBOX must be 'minLon,minLat,maxLon,maxLat'")
    minlon, minlat, maxlon, maxlat = parts
    if not (minlon < maxlon and minlat < maxlat):
        raise ValueError("Invalid bbox ordering.")
    return minlon, minlat, maxlon, maxlat


def pick_best_item(items):
    # Choose lowest cloud cover (if present)
    scored = []
    for it in items:
        cc = it.properties.get("eo:cloud_cover", None)
        score = 1e9 if cc is None else float(cc)
        scored.append((score, it))
    scored.sort(key=lambda x: x[0])
    return scored[0][1] if scored else None


def get_asset_href(item, key_candidates):
    for k in key_candidates:
        if k in item.assets:
            return item.assets[k].href
    # try case-insensitive fallback
    lower_map = {k.lower(): k for k in item.assets.keys()}
    for k in key_candidates:
        lk = k.lower()
        if lk in lower_map:
            return item.assets[lower_map[lk]].href
    return None


def scale_to_uint8(arr, p2=2, p98=98):
    arr = arr.astype(np.float32)
    lo = np.nanpercentile(arr, p2)
    hi = np.nanpercentile(arr, p98)
    if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
        lo, hi = np.nanmin(arr), np.nanmax(arr)
        if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
            return np.zeros_like(arr, dtype=np.uint8)
    x = (arr - lo) / (hi - lo)
    x = np.clip(x, 0, 1)
    return (x * 255).astype(np.uint8)


def main():
    INPUTS.mkdir(parents=True, exist_ok=True)
    DATA_LATEST.mkdir(parents=True, exist_ok=True)

    # Default AOI: small box in S. Sudan-ish (override with S2_BBOX secret/env)
    bbox_str = os.environ.get("S2_BBOX", "30.0,6.0,31.0,7.0")
    minlon, minlat, maxlon, maxlat = parse_bbox(bbox_str)

    days_back = int(os.environ.get("S2_DAYS_BACK", "20"))
    max_cloud = float(os.environ.get("S2_MAX_CLOUD", "30"))

    end = datetime.now(timezone.utc)
    start = end - timedelta(days=days_back)
    dt_range = f"{start.isoformat()}/{end.isoformat()}"

    # Earth Search (Element84) STAC endpoint + Sentinel-2 L2A COG collection
    stac = Client.open("https://earth-search.aws.element84.com/v0")

    search = stac.search(
        collections=["sentinel-s2-l2a-cogs"],
        bbox=[minlon, minlat, maxlon, maxlat],
        datetime=dt_range,
        query={"eo:cloud_cover": {"lt": max_cloud}},
        max_items=50,
    )
    items = list(search.items())
    item = pick_best_item(items)

    if item is None:
        meta = {
            "status": "no_scene_found",
            "message": "No Sentinel-2 scene found for bbox/time/cloud constraints. Try raising S2_DAYS_BACK or S2_MAX_CLOUD.",
            "bbox_wgs84": [minlon, minlat, maxlon, maxlat],
            "time_range": dt_range,
            "max_cloud": max_cloud,
            "updated_utc": end.isoformat(),
        }
        save_json(DATA_LATEST / "ingest_meta.json", meta)
        print("No Sentinel-2 item found.")
        return

    # Assets (common keys in sentinel-s2-l2a-cogs)
    href_r = get_asset_href(item, ["B04", "b04"])
    href_g = get_asset_href(item, ["B03", "b03"])
    href_b = get_asset_href(item, ["B02", "b02"])
    href_nir = get_asset_href(item, ["B08", "b08"])

    if not (href_r and href_g and href_b and href_nir):
        meta = {
            "status": "missing_assets",
            "message": "Could not find required band assets (B02/B03/B04/B08) on STAC item.",
            "item_id": item.id,
            "assets_present": list(item.assets.keys()),
            "updated_utc": end.isoformat(),
        }
        save_json(DATA_LATEST / "ingest_meta.json", meta)
        print("Missing assets on item.")
        return

    # Read bbox window from the COGs and downsample to a fixed size (keeps CI fast)
    out_w = int(os.environ.get("S2_OUT_W", "640"))
    out_h = int(os.environ.get("S2_OUT_H", "640"))

    def read_window(href):
        with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
            with rasterio.open(href) as ds:
                # transform WGS84 bbox into dataset CRS
                b = transform_bounds("EPSG:4326", ds.crs, minlon, minlat, maxlon, maxlat, densify_pts=21)
                win = from_bounds(*b, transform=ds.transform)
                arr = ds.read(
                    1,
                    window=win,
                    out_shape=(out_h, out_w),
                    resampling=rasterio.enums.Resampling.bilinear,
                )
                return arr, ds.crs.to_string()

    R, crs_str = read_window(href_r)
    G, _ = read_window(href_g)
    B, _ = read_window(href_b)
    NIR, _ = read_window(href_nir)

    rgb = np.dstack([
        scale_to_uint8(R),
        scale_to_uint8(G),
        scale_to_uint8(B),
    ])

    # Save RGB image for Roboflow inference
    img_path = INPUTS / "test.jpg"
    Image.fromarray(rgb, mode="RGB").save(img_path, quality=92)

    # NDVI + histogram
    Rf = R.astype(np.float32)
    Nf = NIR.astype(np.float32)
    ndvi = (Nf - Rf) / (Nf + Rf + 1e-6)
    ndvi = np.clip(ndvi, -1, 1)

    bins = np.linspace(-1, 1, 41)  # 40 bins
    counts, edges = np.histogram(ndvi[np.isfinite(ndvi)], bins=bins)

    hist = {
        "date": item.properties.get("datetime", None),
        "bins": [float(x) for x in edges.tolist()],
        "counts": [int(x) for x in counts.tolist()],
        "mean": float(np.nanmean(ndvi)),
        "p10": float(np.nanpercentile(ndvi, 10)),
        "p90": float(np.nanpercentile(ndvi, 90)),
    }
    save_json(DATA_LATEST / "ndvi_hist.json", hist)

    ingest_meta = {
        "status": "ok",
        "source": "sentinel-2-l2a (earth-search STAC)",
        "item_id": item.id,
        "scene_datetime": item.properties.get("datetime"),
        "bbox_wgs84": [minlon, minlat, maxlon, maxlat],
        "image_px": {"width": out_w, "height": out_h},
        "crs_asset": crs_str,
        "updated_utc": end.isoformat(),
        "note": "inputs/test.jpg generated from Sentinel-2 bands B04/B03/B02 (RGB). NDVI histogram saved to data/latest/ndvi_hist.json.",
    }
    save_json(DATA_LATEST / "ingest_meta.json", ingest_meta)

    print(f"Wrote {img_path} and data/latest/ingest_meta.json + ndvi_hist.json")


if __name__ == "__main__":
    main()
