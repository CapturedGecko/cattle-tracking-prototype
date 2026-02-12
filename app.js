const statusEl = document.getElementById("status");
const weekSelect = document.getElementById("weekSelect");
const checkboxes = document.querySelectorAll('input[type="checkbox"][data-layer]');

function setStatus(msg) {
  statusEl.textContent = msg;
}

// ---------------- Map setup ----------------
const map = L.map("map", { zoomControl: true }).setView([7.5, 30.5], 6);

// Base maps (Street + Satellite)
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

// Start with street
street.addTo(map);

// Toggle control
L.control.layers(
  { Street: street, Satellite: satellite },
  null,
  { position: "topright" }
).addTo(map);

// ---------------- Styling helpers ----------------
function clamp01(x) {
  const n = Number(x);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// Simple stepped color ramps
function presenceColor(p) {
  p = clamp01(p);
  if (p >= 0.8) return "#08306b";
  if (p >= 0.6) return "#08519c";
  if (p >= 0.4) return "#2171b5";
  if (p >= 0.2) return "#6baed6";
  return "#c6dbef";
}

function riskColor(r) {
  r = clamp01(r);
  if (r >= 0.8) return "#7f0000";
  if (r >= 0.6) return "#b30000";
  if (r >= 0.4) return "#d7301f";
  if (r >= 0.2) return "#fc8d59";
  return "#fee0d2";
}

// Layer config (expects GeoJSON at /data/<week>/<file>)
const LAYER_CONFIG = {
  grazing:   { file: "grazing.geojson",   type: "poly", valueProp: "g" },     // g = 0..1 (optional)
  water:     { file: "water.geojson",     type: "poly", valueProp: "w" },     // w = 0..1 (optional)
  presence:  { file: "presence.geojson",  type: "poly", valueProp: "p" },     // p = 0..1 (recommended)
  corridors: { file: "corridors.geojson", type: "line", valueProp: "w" },     // w = 0..1 (optional)
  hotspots:  { file: "hotspots.geojson",  type: "poly", valueProp: "risk" }   // risk = 0..1 (recommended)
};

const layersOnMap = {}; // key -> Leaflet layer

function geojsonStyleFor(key, feature) {
  const cfg = LAYER_CONFIG[key];
  const props = feature?.properties || {};
  const v = props[cfg.valueProp];

  if (cfg.type === "line") {
    const w = clamp01(v ?? 0.5);
    return {
      weight: 2 + 6 * w,
      opacity: 0.9
    };
  }

  // polygons
  if (key === "hotspots") {
    const r = clamp01(v ?? 0.3);
    return {
      weight: 1,
      color: "#ffffff",
      opacity: 0.25,
      fillColor: riskColor(r),
      fillOpacity: 0.45
    };
  }

  // default polygons (presence/grazing/water)
  const p = clamp01(v ?? 0.3);
  return {
    weight: 1,
    color: "#ffffff",
    opacity: 0.18,
    fillColor: presenceColor(p),
    fillOpacity: 0.35
  };
}

function popupTextFor(key, feature) {
  const props = feature?.properties || {};
  const cfg = LAYER_CONFIG[key];
  const v = props[cfg.valueProp];

  const label =
    key === "presence" ? "Presence" :
    key === "hotspots" ? "Risk" :
    key === "corridors" ? "Corridor weight" :
    key;

  const shown = (v === undefined || v === null) ? "n/a" : Number(v).toFixed(2);
  return `<b>${label}</b>: ${shown}`;
}

async function fetchJSON(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function loadGeoJSONLayer(key, url) {
  const geo = await fetchJSON(url);
  if (!geo) return null;

  const layer = L.geoJSON(geo, {
    style: (feature) => geojsonStyleFor(key, feature),
    onEachFeature: (feature, layerObj) => {
      layerObj.bindPopup(popupTextFor(key, feature));
    }
  });

  return layer;
}

async function refreshLayers() {
  const week = weekSelect.value;
  setStatus(`Loading ${week}…`);

  // remove old layers
  Object.values(layersOnMap).forEach((layer) => map.removeLayer(layer));
  for (const k of Object.keys(layersOnMap)) delete layersOnMap[k];

  let loaded = 0;
  const bounds = [];

  for (const cb of checkboxes) {
    const key = cb.dataset.layer;
    if (!cb.checked) continue;

    const cfg = LAYER_CONFIG[key];
    const url = `data/${week}/${cfg.file}`;
    const layer = await loadGeoJSONLayer(key, url);

    if (layer) {
      layer.addTo(map);
      layersOnMap[key] = layer;
      loaded++;

      try {
        const b = layer.getBounds?.();
        if (b && b.isValid()) bounds.push(b);
      } catch {}
    } else {
      console.log(`No data at ${url}`);
    }
  }

  // fit map to loaded layers (optional)
  if (bounds.length > 0) {
    const combined = bounds.reduce((acc, b) => acc.extend(b), bounds[0]);
    map.fitBounds(combined.pad(0.15));
  }

  // load meta.json if present
  const meta = await fetchJSON(`data/${week}/meta.json`);
  if (loaded === 0) {
    setStatus(`No data found for ${week} yet (add files in /data/${week}/).`);
  } else if (meta?.updated) {
    setStatus(`Loaded ${loaded} layer(s) for ${week}. Updated: ${meta.updated}`);
  } else {
    setStatus(`Loaded ${loaded} layer(s) for ${week}.`);
  }
}

// ---------------- Legend ----------------
const legend = L.control({ position: "bottomright" });
legend.onAdd = function () {
  const div = L.DomUtil.create("div", "legend");
  div.innerHTML = `
    <div class="legendTitle">Legend</div>

    <div class="legendBlock">
      <div class="legendLabel">Presence (p)</div>
      <div class="legendRow">
        <span class="swatch" style="background:${presenceColor(0.1)}"></span><span>0–0.2</span>
      </div>
      <div class="legendRow">
        <span class="swatch" style="background:${presenceColor(0.3)}"></span><span>0.2–0.4</span>
      </div>
      <div class="legendRow">
        <span class="swatch" style="background:${presenceColor(0.5)}"></span><span>0.4–0.6</span>
      </div>
      <div class="legendRow">
        <span class="swatch" style="background:${presenceColor(0.7)}"></span><span>0.6–0.8</span>
      </div>
      <div class="legendRow">
        <span class="swatch" style="background:${presenceColor(0.9)}"></span><span>0.8–1.0</span>
      </div>
    </div>

    <div class="legendBlock">
      <div class="legendLabel">Risk (r)</div>
      <div class="legendRow">
        <span class="swatch" style="background:${riskColor(0.1)}"></span><span>0–0.2</span>
      </div>
      <div class="legendRow">
        <span class="swatch" style="background:${riskColor(0.3)}"></span><span>0.2–0.4</span>
      </div>
      <div class="legendRow">
        <span class="swatch" style="background:${riskColor(0.5)}"></span><span>0.4–0.6</span>
      </div>
      <div class="legendRow">
        <span class="swatch" style="background:${riskColor(0.7)}"></span><span>0.6–0.8</span>
      </div>
      <div class="legendRow">
        <span class="swatch" style="background:${riskColor(0.9)}"></span><span>0.8–1.0</span>
      </div>
    </div>

    <div class="legendNote">UN INTERNAL • Aggregated surfaces only</div>
  `;
  return div;
};
legend.addTo(map);

// UI wiring
weekSelect.addEventListener("change", refreshLayers);
checkboxes.forEach((cb) => cb.addEventListener("change", refreshLayers));

// initial load
refreshLayers();
