const statusEl = document.getElementById("status");
const ndviToggle = document.getElementById("ndviToggle");
const ndviOpacity = document.getElementById("ndviOpacity");
const ndviOpacityLabel = document.getElementById("ndviOpacityLabel");
const reloadBtn = document.getElementById("reloadBtn");

const reloadNdviBtn = document.getElementById("reloadNdviBtn");
const ndviStatsEl = document.getElementById("ndviStats");
const ndviChartCanvas = document.getElementById("ndviChart");

const layerChecks = document.querySelectorAll('input[type="checkbox"][data-layer]');

function setStatus(msg){ statusEl.textContent = msg; }
function clamp01(x){
  const n = Number(x);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// ---------- Map ----------
const map = L.map("map", {
  zoomControl: true,
  maxZoom: 20,  // user can zoom further
  minZoom: 2
}).setView([7.5, 30.5], 6);

// Base maps
const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 20,
  maxNativeZoom: 19
});

const satellite = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    attribution: "Tiles &copy; Esri",
    maxZoom: 20,         // allow zooming
    maxNativeZoom: 18,   // BUT never request tiles beyond 18
    errorTileUrl: "data:image/gif;base64,R0lGODlhAQABAAAAACw=" // transparent 1x1 so you don't see ugly errors
  }
);

street.addTo(map);

// Layer control
L.control.layers(
  { Street: street, Satellite: satellite },
  {},
  { position: "topright" }
).addTo(map);

// ---- Optional: if Satellite is active and user zooms past native zoom, auto-switch to Street ----
const SAT_MAX_NATIVE = 18;

function isLayerOn(layer) {
  return map.hasLayer(layer);
}

map.on("zoomend", () => {
  if (isLayerOn(satellite) && map.getZoom() > SAT_MAX_NATIVE) {
    // either clamp zoom:
    map.setZoom(SAT_MAX_NATIVE);

    // OR instead of clamping, auto-switch basemap:
    // map.removeLayer(satellite);
    // street.addTo(map);
  }
});


const satellite = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    attribution: "Tiles &copy; Esri",
    maxZoom: 20,        // allow over-zoom
    maxNativeZoom: 18   // Esri often tops out at 18 (prevents missing tiles)
  }
);

street.addTo(map);

// Layer control (base layers only)
L.control.layers(
  { Street: street, Satellite: satellite },
  {},
  { position: "topright" }
).addTo(map);

setTimeout(() => map.invalidateSize(), 200);

// ---------- NDVI overlay (temporary: NASA GIBS MODIS NDVI) ----------
// This is NOT Sentinel-2 yet. It’s a “works now” NDVI overlay.
// Sentinel-2 will come from Sentinel Hub / Earth Engine (next section).
const ndviLayer = L.tileLayer.wms(
  "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi",
  {
    layers: "MODIS_Terra_NDVI_8Day",
    format: "image/png",
    transparent: true,
    pane: "ndviPane"
  }
);

// NDVI controls (pane opacity = reliable)
function applyNdviOpacity(){
  const v = Number(ndviOpacity.value);
  const op = clamp01(v / 100);
  ndviOpacityLabel.textContent = `${v}%`;

  // Pane opacity is a guaranteed visual change
  map.getPane("ndviPane").style.opacity = String(op);

  // Also set layer opacity (fine if it works)
  if (ndviLayer.setOpacity) ndviLayer.setOpacity(op);

  // Force redraw to avoid “opacity doesn’t update until movement” issues
  if (ndviLayer.redraw) ndviLayer.redraw();
}

ndviToggle.addEventListener("change", () => {
  if (ndviToggle.checked) {
    ndviLayer.addTo(map);
    applyNdviOpacity();
  } else {
    map.removeLayer(ndviLayer);
  }
});

ndviOpacity.addEventListener("input", applyNdviOpacity);
applyNdviOpacity();

// ---------- Optional GeoJSON overlays ----------
const DATA_ROOT = "data/latest";
const layersOnMap = {};

// Color helpers
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
    return { weight: 2 + 6*w, opacity: 0.9, color: "#c7d2fe" };
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

layerChecks.forEach((cb) => cb.addEventListener("change", refreshDataLayers));
reloadBtn.addEventListener("click", refreshDataLayers);

// ---------- NDVI histogram ----------
let ndviChart = null;

function renderNdviChart(hist){
  // Expected JSON (example):
  // {
  //   "date":"2026-02-11",
  //   "bins":[-0.2,-0.1,0,0.1,...,1.0],   // edges
  //   "counts":[12,55,90,...],           // length = bins-1
  //   "mean":0.31, "p10":0.12, "p90":0.58
  // }

  const bins = hist?.bins;
  const counts = hist?.counts;

  if (!Array.isArray(bins) || !Array.isArray(counts) || bins.length !== counts.length + 1){
    ndviStatsEl.textContent = "ndvi_hist.json exists but format is wrong (bins must be edges, counts must be bins-1).";
    return;
  }

  const labels = [];
  for (let i = 0; i < counts.length; i++){
    const mid = (Number(bins[i]) + Number(bins[i+1])) / 2;
    labels.push(mid.toFixed(2));
  }

  const stats = [];
  if (hist.date) stats.push(`Date: ${hist.date}`);
  if (typeof hist.mean === "number") stats.push(`Mean NDVI: ${hist.mean.toFixed(3)}`);
  if (typeof hist.p10 === "number") stats.push(`P10: ${hist.p10.toFixed(3)}`);
  if (typeof hist.p90 === "number") stats.push(`P90: ${hist.p90.toFixed(3)}`);
  ndviStatsEl.textContent = stats.length ? stats.join(" • ") : "Histogram loaded.";

  if (ndviChart) ndviChart.destroy();

  ndviChart = new Chart(ndviChartCanvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "NDVI distribution",
        data: counts
      }]
    },
    options: {
      responsive: true,
      animation: false,
      scales: {
        x: { title: { display: true, text: "NDVI bin midpoint" } },
        y: { title: { display: true, text: "Pixel count" } }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });
}

async function loadNdviHistogram(){
  const url = `${DATA_ROOT}/ndvi_hist.json`;
  const hist = await fetchJSON(url);
  if (!hist){
    ndviStatsEl.textContent = `No NDVI histogram found at ${url} (this is expected until you generate it).`;
    if (ndviChart) { ndviChart.destroy(); ndviChart = null; }
    return;
  }
  renderNdviChart(hist);
}

reloadNdviBtn.addEventListener("click", loadNdviHistogram);

// Start
setStatus("Ready. NDVI overlay + GeoJSON optional layers.");
refreshDataLayers();
loadNdviHistogram();
