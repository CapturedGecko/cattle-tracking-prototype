function $(id){ return document.getElementById(id); }

const statusEl = $("status");
const reloadBtn = $("reloadBtn");

const detectionsToggle = $("detectionsToggle");

const ndviToggle = $("ndviToggle");
const ndviOpacity = $("ndviOpacity");
const ndviOpacityLabel = $("ndviOpacityLabel");

function setStatus(msg){
  if (statusEl) statusEl.textContent = msg;
}

function clamp01(x){
  const n = Number(x);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// --- Map ---
if (typeof L === "undefined") {
  alert("Leaflet didn't load. Check index.html script order + paths.");
  throw new Error("Leaflet missing");
}

const map = L.map("map", {
  zoomControl: true,
  maxZoom: 20
}).setView([7.5, 30.5], 6);

// Base maps
const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 20,
  maxNativeZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
  errorTileUrl: "data:image/gif;base64,R0lGODlhAQABAAAAACw="
});

const satellite = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 20,
    maxNativeZoom: 18,
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

// --- NDVI pane (so opacity always works) ---
map.createPane("ndviPane");
map.getPane("ndviPane").style.zIndex = 350;
map.getPane("ndviPane").style.pointerEvents = "none";

// NASA GIBS NDVI WMS (works without keys)
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

  // Pane opacity = guaranteed visible change
  map.getPane("ndviPane").style.opacity = String(op);

  // Also set layer opacity (nice-to-have)
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

// --- Detections GeoJSON ---
const DATA_ROOT = "data/latest";
let detectionsLayer = null;

async function fetchJSON(url){
  try{
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  }catch{
    return null;
  }
}

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

  setStatus("Loading detections from data/latest/detections.geojson …");
  const geo = await fetchJSON(`${DATA_ROOT}/detections.geojson`);

  if (!geo || !Array.isArray(geo.features)){
    setStatus("No detections.geojson found (or invalid).");
    return;
  }

  detectionsLayer = L.geoJSON(geo, {
    pointToLayer: (feature, latlng) => {
      const conf = clamp01(feature?.properties?.conf ?? 0.6);
      return L.circleMarker(latlng, {
        radius: 3 + 6 * conf,
        color: "#0b1220",
        weight: 1,
        fillColor: "#22c55e",
        fillOpacity: 0.85,
        opacity: 0.8
      });
    },
    onEachFeature: (feature, layerObj) => {
      const p = feature?.properties || {};
      const conf = (p.conf == null) ? "n/a" : Number(p.conf).toFixed(2);
      layerObj.bindPopup(`<b>Detection</b><br/>conf: ${conf}`);
    }
  });

  detectionsLayer.addTo(map);

  // Fit bounds if we have any points
  try{
    const b = detectionsLayer.getBounds();
    if (b.isValid() && geo.features.length > 0) map.fitBounds(b.pad(0.2));
  }catch{}

  setStatus(`Detections loaded: ${geo.features.length} feature(s).`);
}

detectionsToggle?.addEventListener("change", loadDetections);
reloadBtn?.addEventListener("click", loadDetections);

// Start
setTimeout(() => map.invalidateSize(), 300);
setStatus("Ready.");
loadDetections();
