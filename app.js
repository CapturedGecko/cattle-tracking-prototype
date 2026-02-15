function $(id){ return document.getElementById(id); }

const statusEl = $("status");
const reloadBtn = $("reloadBtn");

const detectionsToggle = $("detectionsToggle");

const ndviToggle = $("ndviToggle");
const ndviOpacity = $("ndviOpacity");
const ndviOpacityLabel = $("ndviOpacityLabel");

const reloadNdviBtn = $("reloadNdviBtn");
const ndviStatsEl = $("ndviStats");
const ndviChartCanvas = $("ndviChart");

function setStatus(msg){
  if (statusEl) statusEl.textContent = msg;
}

function clamp01(x){
  const n = Number(x);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

async function fetchJSON(url){
  try{
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  }catch{
    return null;
  }
}

// ---------- Map ----------
if (typeof L === "undefined") {
  alert("Leaflet didn't load. Check index.html script order + paths.");
  throw new Error("Leaflet missing");
}

// IMPORTANT: we allow deep zoom overall, but cap SATELLITE when selected to avoid “map data not yet available”.
const map = L.map("map", {
  zoomControl: true,
  maxZoom: 17
}).setView([7.5, 30.5], 6);

// Base maps
const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 17,
  maxNativeZoom: 19,     // over-zoom beyond 19 (stretches)
  attribution: "&copy; OpenStreetMap contributors",
  errorTileUrl: "data:image/gif;base64,R0lGODlhAQABAAAAACw="
});

const satellite = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 17,          // CAP satellite to native to avoid the “map data not yet available” tiles
    maxNativeZoom: 17,
    attribution: "Tiles &copy; Esri",
    errorTileUrl: "data:image/gif;base64,R0lGODlhAQABAAAAACw="
  }
);

street.addTo(map);

L.control.layers(
  { Street: street, Satellite: satellite },
  {},
  { position: "topright" }
).addTo(map);

// When switching basemaps, adjust map maxZoom so satellite can’t zoom into missing tiles
map.on("baselayerchange", (e) => {
  if (e.name === "Satellite") map.setMaxZoom(18);
  else map.setMaxZoom(22);
});

// ---------- NDVI overlay (NASA GIBS WMS) ----------
map.createPane("ndviPane");
map.getPane("ndviPane").style.zIndex = 350;
map.getPane("ndviPane").style.pointerEvents = "none";

const ndviLayer = L.tileLayer.wms(
  "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi",
  {
    layers: "MODIS_Terra_NDVI_8Day",
    format: "image/png",
    transparent: true,
    pane: "ndviPane"
  }
);

function applyNdviOpacity(){
  const v = Number(ndviOpacity?.value ?? 65);
  const op = clamp01(v / 100);
  if (ndviOpacityLabel) ndviOpacityLabel.textContent = `${v}%`;

  map.getPane("ndviPane").style.opacity = String(op);
  if (ndviLayer.setOpacity) ndviLayer.setOpacity(op);
  if (ndviLayer.redraw) ndviLayer.redraw();
}

ndviToggle?.addEventListener("change", () => {
  if (ndviToggle.checked) {
    ndviLayer.addTo(map);
    applyNdviOpacity();
  } else {
    map.removeLayer(ndviLayer);
  }
});

ndviOpacity?.addEventListener("input", applyNdviOpacity);
applyNdviOpacity();

// ---------- Detections GeoJSON ----------
const DATA_ROOT = "data/latest";
let detectionsLayer = null;

function clearDetections(){
  if (detectionsLayer){
    map.removeLayer(detectionsLayer);
    detectionsLayer = null;
  }
}

async function loadDetections(){
  clearDetections();

  if (!detectionsToggle?.checked){
    setStatus("Detections off.");
    return;
  }

  setStatus("Loading detections…");

  const geo = await fetchJSON(`${DATA_ROOT}/detections.geojson`);

  if (!geo || !Array.isArray(geo.features)){
    setStatus("detections.geojson missing or invalid.");
    return;
  }

  const count = geo.features.length;

  detectionsLayer = L.geoJSON(geo, {
    pointToLayer: (feature, latlng) => {
      const conf = clamp01(feature?.properties?.conf ?? 0.6);
      return L.circleMarker(latlng, {
        radius: 3 + 6 * conf,
        color: "#0b1220",
        weight: 1,
        fillColor: "#22c55e",
        fillOpacity: 0.85,
        opacity: 0.9
      });
    },
    onEachFeature: (feature, layerObj) => {
      const p = feature?.properties || {};
      const conf = (p.conf == null) ? "n/a" : Number(p.conf).toFixed(2);
      const cls = p.class ?? p.label ?? "object";
      layerObj.bindPopup(`<b>${cls}</b><br/>conf: ${conf}`);
    }
  });

  detectionsLayer.addTo(map);

  // Fit if any points
  if (count > 0){
    try{
      const b = detectionsLayer.getBounds();
      if (b.isValid()) map.fitBounds(b.pad(0.2));
    }catch{}
    setStatus(`Detections loaded: ${count}`);
    return;
  }

  // If geojson is empty, check raw_inference.json so you can see whether the model predicted anything
  const raw = await fetchJSON(`${DATA_ROOT}/raw_inference.json`);
  const predCount = countPredictions(raw);

  if (predCount > 0){
    setStatus(
      `detections.geojson is empty, but raw_inference.json has ${predCount} prediction(s).\n` +
      `That means we still need to convert predictions -> lat/lon GeoJSON.`
    );
  } else {
    setStatus(
      `detections.geojson is empty and raw_inference.json shows 0 prediction(s).\n` +
      `Try a different test image OR lower the confidence threshold in Roboflow Workflow.`
    );
  }
}

function countPredictions(raw){
  // raw can be array or object. We search any nested "predictions" arrays.
  let total = 0;

  function walk(x){
    if (!x) return;
    if (Array.isArray(x)){
      for (const v of x) walk(v);
      return;
    }
    if (typeof x !== "object") return;

    if (Array.isArray(x.predictions)) total += x.predictions.length;

    for (const k of Object.keys(x)){
      walk(x[k]);
    }
  }

  walk(raw);
  return total;
}

detectionsToggle?.addEventListener("change", loadDetections);
reloadBtn?.addEventListener("click", loadDetections);

// ---------- NDVI Histogram ----------
let ndviChart = null;

function renderNdviChart(hist){
  const bins = hist?.bins;
  const counts = hist?.counts;

  if (!Array.isArray(bins) || !Array.isArray(counts) || bins.length !== counts.length + 1){
    if (ndviStatsEl) ndviStatsEl.textContent = "ndvi_hist.json format invalid.";
    if (ndviChart) { ndviChart.destroy(); ndviChart = null; }
    return;
  }

  const labels = [];
  for (let i = 0; i < counts.length; i++){
    const mid = (Number(bins[i]) + Number(bins[i+1])) / 2;
    labels.push(mid.toFixed(2));
  }

  const stats = [];
  if (hist.date) stats.push(`Date: ${hist.date}`);
  if (typeof hist.mean === "number") stats.push(`Mean: ${hist.mean.toFixed(3)}`);
  if (typeof hist.p10 === "number") stats.push(`P10: ${hist.p10.toFixed(3)}`);
  if (typeof hist.p90 === "number") stats.push(`P90: ${hist.p90.toFixed(3)}`);
  if (ndviStatsEl) ndviStatsEl.textContent = stats.length ? stats.join(" • ") : "Histogram loaded.";

  if (ndviChart) ndviChart.destroy();

  ndviChart = new Chart(ndviChartCanvas, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "NDVI",
        data: counts
      }]
    },
    options: {
      responsive: true,
      animation: false,
      scales: {
        x: { title: { display: true, text: "NDVI" } },
        y: { title: { display: true, text: "Count" } }
      },
      plugins: { legend: { display: false } }
    }
  });
}

async function loadNdviHistogram(){
  const hist = await fetchJSON(`${DATA_ROOT}/ndvi_hist.json`);
  if (!hist){
    if (ndviStatsEl) ndviStatsEl.textContent = "No ndvi_hist.json found.";
    if (ndviChart) { ndviChart.destroy(); ndviChart = null; }
    return;
  }
  renderNdviChart(hist);
}

reloadNdviBtn?.addEventListener("click", loadNdviHistogram);

// Start
setTimeout(() => map.invalidateSize(), 300);
setStatus("Ready.");
loadDetections();
loadNdviHistogram();
