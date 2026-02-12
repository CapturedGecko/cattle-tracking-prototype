const statusEl = document.getElementById("status");
const weekSelect = document.getElementById("weekSelect");
const checkboxes = document.querySelectorAll('input[type="checkbox"][data-layer]');

function setStatus(msg){ statusEl.textContent = msg; }

// Map centered on South Sudan-ish region
const map = L.map("map", { zoomControl: true }).setView([7.5, 30.5], 6);

// Base map (online)
// ---- Base maps (Street + Satellite) ----
const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
});

const satellite = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  {
    maxZoom: 19,
    attribution: "Tiles &copy; Esri"
  }
);

// Start with street by default
street.addTo(map);

// Add a toggle button (top-right) to switch basemaps
L.control.layers(
  { "Street": street, "Satellite": satellite },
  null,
  { position: "topright" }
).addTo(map);


// Layer config (expects GeoJSON files you’ll add later)
const LAYER_CONFIG = {
  grazing:   { file: "grazing.geojson",   style: { weight: 1, fillOpacity: 0.25 } },
  water:     { file: "water.geojson",     style: { weight: 1, fillOpacity: 0.25 } },
  presence:  { file: "presence.geojson",  style: { weight: 1, fillOpacity: 0.25 } },
  corridors: { file: "corridors.geojson", style: { weight: 3, fillOpacity: 0.0 } },
  hotspots:  { file: "hotspots.geojson",  style: { weight: 1, fillOpacity: 0.35 } },
};

const layersOnMap = {}; // key -> Leaflet layer

async function loadGeoJSON(url, style){
  try{
    const res = await fetch(url, { cache: "no-store" });
    if(!res.ok) return null;
    const geo = await res.json();
    return L.geoJSON(geo, { style });
  } catch(e){
    return null;
  }
}

async function refreshLayers(){
  const week = weekSelect.value;

  setStatus(`Loading ${week} layers...`);

  // Remove existing layers
  Object.values(layersOnMap).forEach(layer => map.removeLayer(layer));
  for (const k of Object.keys(layersOnMap)) delete layersOnMap[k];

  // Add requested layers
  let loadedCount = 0;
  for (const cb of checkboxes){
    const key = cb.dataset.layer;
    if(!cb.checked) continue;

    const cfg = LAYER_CONFIG[key];
    const url = `data/${week}/${cfg.file}`;
    const layer = await loadGeoJSON(url, cfg.style);

    if(layer){
      layer.addTo(map);
      layersOnMap[key] = layer;
      loadedCount++;
    } else {
      console.log(`No data found at ${url}`);
    }
  }

  if(loadedCount === 0){
    setStatus(`No data found for ${week} yet. (That’s okay — add files into /data/${week}/ )`);
  } else {
    setStatus(`Loaded ${loadedCount} layer(s) for ${week}.`);
  }
}

// Wire up UI
weekSelect.addEventListener("change", refreshLayers);
checkboxes.forEach(cb => cb.addEventListener("change", refreshLayers));

// First load
refreshLayers();
