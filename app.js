const statusEl = document.getElementById("status");
const ndviToggle = document.getElementById("ndviToggle");
const ndviOpacity = document.getElementById("ndviOpacity");
const ndviOpacityLabel = document.getElementById("ndviOpacityLabel");
const reloadBtn = document.getElementById("reloadBtn");
const layerChecks = document.querySelectorAll('input[type="checkbox"][data-layer]');

function setStatus(msg){ statusEl.textContent = msg; }
function clamp01(x){
  const n = Number(x);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// ---------- Map ----------
const map = L.map("map", { zoomControl: true }).setView([7.5, 30.5], 6);

// Base maps
const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
});

const satellite = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 19, attribution: "Tiles &copy; Esri" }
);

street.addTo(map);
setTimeout(() => map.invalidateSize(), 200);

// NDVI overlay (NASA GIBS WMS) — free, no key
// Layer: MODIS_Terra_NDVI_8Day (8-day composite NDVI)
const ndviLayer = L.tileLayer.wms(
  "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi",
  {
    layers: "MODIS_Terra_NDVI_8Day",
    format: "image/png",
    transparent: true,
    opacity: 0.55
    // If later you want a specific date: time: "YYYY-MM-DD"
  }
);

// Add Leaflet layer control (top-right)
L.control.layers(
  { Street: street, Satellite: satellite },
  { "NDVI (Vegetation)": ndviLayer },
  { position: "topright" }
).addTo(map);

// ---------- Optional GeoJSON overlays ----------
const DATA_ROOT = "data/latest"; // easiest “automatic” contract later
const layersOnMap = {};

// Color ramps
function presenceColor(p){
  p = clamp01(p);
  if (p >= 0.8) return "#08306b";
  if (p >= 0.6) return "#08519c";
  if (p >= 0.4) return "#2171b5";
  if (p >= 0.2) return "#6baed6";
  return "#c6dbef";
}
function riskColor(r){
  r = clamp01(r);
  if (r >= 0.8) return "#7f0000";
  if (r >= 0.6) return "#b30000";
  if (r >= 0.4) return "#d7301f";
  if (r >= 0.2) return "#fc8d59";
  return "#fee0d2";
}
function detColor(c){
  c = clamp01(c);
  if (c >= 0.8) return "#00d18f";
  if (c >= 0.6) return "#f1c40f";
  return "#ff6b6b";
}

const LAYER_CONFIG = {
  presence:   { file: "presence.geojson",   type: "poly",  valueProp: "p" },
  hotspots:   { file: "hotspots.geojson",   type: "poly",  valueProp: "risk" },
  corridors:  { file: "corridors.geojson",  type: "line",  valueProp: "w" },
  detections: { file: "detections.geojson", type: "point", valueProp: "conf" }
};

async function fetchJSON(url){
  try{
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  }catch{
    return null;
  }
}

function styleFor(key, feature){
  const cfg = LAYER_CONFIG[key];
  const props = feature?.properties || {};
  const v = props[cfg.valueProp];

  if (cfg.type === "line"){
    const w = clamp01(v ?? 0.5);
    return { weight: 2 + 6*w, opacity: 0.9 };
  }

  if (key === "hotspots"){
    const r = clamp01(v ?? 0.3);
    return { weight: 1, color: "#fff", opacity: 0.25, fillColor: riskColor(r), fillOpacity: 0.45 };
  }

  const p = clamp01(v ?? 0.3);
  return { weight: 1, color: "#fff", opacity: 0.18, fillColor: presenceColor(p), fillOpacity: 0.35 };
}

function popupFor(key, feature){
  const props = feature?.properties || {};
  if (key === "detections"){
    const conf = props.conf ?? null;
    const herd = props.herd_id ?? "n/a";
    const shown = (conf === null) ? "n/a" : Number(conf).toFixed(2);
    return `<b>Detection</b><br/>conf: ${shown}<br/>herd: ${herd}`;
  }
  const cfg = LAYER_CONFIG[key];
  const v = props[cfg.valueProp];
  const shown = (v === undefined || v === null) ? "n/a" : Number(v).toFixed(2);
  return `<b>${key}</b>: ${shown}`;
}

async function loadLayer(key){
  const cfg = LAYER_CONFIG[key];
  const url = `${DATA_ROOT}/${cfg.file}`;
  const geo = await fetchJSON(url);
  if (!geo) return { ok:false, url };

  if (cfg.type === "point"){
    const layer = L.geoJSON(geo, {
      pointToLayer: (feature, latlng) => {
        const c = clamp01(feature?.properties?.conf ?? 0.5);
        return L.circleMarker(latlng, {
          radius: 3 + 6*c,
          color: "#0b1220",
          weight: 1,
          fillColor: detColor(c),
          fillOpacity: 0.85,
          opacity: 0.55
        });
      },
      onEachFeature: (feature, layerObj) => layerObj.bindPopup(popupFor(key, feature))
    });
    return { ok:true, layer, url };
  }

  const layer = L.geoJSON(geo, {
    style: (feature) => styleFor(key, feature),
    onEachFeature: (feature, layerObj) => layerObj.bindPopup(popupFor(key, feature))
  });
  return { ok:true, layer, url };
}

async function refreshDataLayers(){
  setStatus("Loading data/latest…");

  // remove existing
  for (const k of Object.keys(layersOnMap)){
    map.removeLayer(layersOnMap[k]);
    delete layersOnMap[k];
  }

  let loaded = 0;
  const missing = [];
  const bounds = [];

  for (const cb of layerChecks){
    const key = cb.dataset.layer;
    if (!cb.checked) continue;

    const res = await loadLayer(key);
    if (!res.ok){
      missing.push(`${key} (missing: ${res.url})`);
      continue;
    }

    res.layer.addTo(map);
    layersOnMap[key] = res.layer;
    loaded++;

    try{
      const b = res.layer.getBounds?.();
      if (b && b.isValid()) bounds.push(b);
    }catch{}
  }

  if (bounds.length > 0){
    const combined = bounds.reduce((acc, b) => acc.extend(b), bounds[0]);
    map.fitBounds(combined.pad(0.15));
  }

  setTimeout(() => map.invalidateSize(), 150);

  if (loaded === 0){
    setStatus(
      missing.length
        ? `No GeoJSON layers loaded. Missing:\n- ${missing.join("\n- ")}`
        : "No GeoJSON layers loaded (none selected)."
    );
  } else {
    setStatus(
      missing.length
        ? `Loaded ${loaded} layer(s). Missing:\n- ${missing.join("\n- ")}`
        : `Loaded ${loaded} layer(s) from data/latest.`
    );
  }
}

// ---------- NDVI controls ----------
function setNdviOpacityFromUI(){
  const v = Number(ndviOpacity.value);
  const op = clamp01(v / 100);
  ndviLayer.setOpacity(op);
  ndviOpacityLabel.textContent = `${v}%`;
}

ndviToggle.addEventListener("change", () => {
  if (ndviToggle.checked) ndviLayer.addTo(map);
  else map.removeLayer(ndviLayer);
});

ndviOpacity.addEventListener("input", setNdviOpacityFromUI);
setNdviOpacityFromUI();

// ---------- Data controls ----------
layerChecks.forEach((cb) => cb.addEventListener("change", refreshDataLayers));
reloadBtn.addEventListener("click", refreshDataLayers);

// Start
setStatus("Ready. Toggle NDVI or reload data/latest.");
refreshDataLayers();
