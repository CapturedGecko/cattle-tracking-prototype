const statusEl = document.getElementById("status");
const layerChecks = document.querySelectorAll('input[type="checkbox"][data-layer]');

function setStatus(msg){ statusEl.textContent = msg; }

// ---------- Map ----------
const map = L.map("map", {
  zoomControl: true,
  maxZoom: 20, // allow deeper zoom
  minZoom: 2
}).setView([7.5, 30.5], 6);

// Base maps with overzoom
const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: "&copy; OpenStreetMap contributors",
  maxZoom: 20,
  maxNativeZoom: 19
});

const satellite = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    attribution: "Tiles &copy; Esri",
    maxZoom: 20,
    maxNativeZoom: 18,
    // transparent tile instead of "map data not found"
    errorTileUrl: "data:image/gif;base64,R0lGODlhAQABAAAAACw="
  }
);

street.addTo(map);

L.control.layers(
  { Street: street, Satellite: satellite },
  {},
  { position: "topright" }
).addTo(map);

// Let layout settle
setTimeout(() => map.invalidateSize(), 200);

// ---------- Data layer: detections.geojson ----------
const DATA_ROOT = "data/latest";
let detectionsLayer = null;

async function fetchJSON(url){
  try{
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  }catch(e){
    return null;
  }
}

async function refreshDetections(){
  const cb = [...layerChecks].find(x => x.dataset.layer === "detections");
  const enabled = cb ? cb.checked : true;

  if (detectionsLayer) {
    map.removeLayer(detectionsLayer);
    detectionsLayer = null;
  }

  if (!enabled) {
    setStatus("Detections layer off.");
    return;
  }

  const url = `${DATA_ROOT}/detections.geojson`;
  const geo = await fetchJSON(url);

  if (!geo || !geo.features) {
    setStatus(`Could not load ${url}`);
    return;
  }

  detectionsLayer = L.geoJSON(geo, {
    pointToLayer: (feature, latlng) => {
      return L.circleMarker(latlng, {
        radius: 5,
        weight: 1,
        opacity: 0.9,
        fillOpacity: 0.7
      });
    }
  }).addTo(map);

  setStatus(`Loaded detections: ${geo.features.length}`);
}

layerChecks.forEach(cb => cb.addEventListener("change", refreshDetections));

setStatus("Map ready.");
refreshDetections();
