const statusEl = document.getElementById("status");
const dateSelect = document.getElementById("dateSelect");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const leadTag = document.getElementById("leadTag");
const checkboxes = document.querySelectorAll('input[type="checkbox"][data-layer]');

function setStatus(msg) { statusEl.textContent = msg; }

// ---------- Date helpers (avoid timezone bugs) ----------
function parseISODate(d) { return new Date(d + "T00:00:00Z"); }
function diffDays(aISO, bISO) {
  const a = parseISODate(aISO);
  const b = parseISODate(bISO);
  return Math.round((a - b) / (1000 * 60 * 60 * 24));
}
function clamp01(x) {
  const n = Number(x);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// ---------- Map setup ----------
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

L.control.layers(
  { Street: street, Satellite: satellite },
  null,
  { position: "topright" }
).addTo(map);

// ---------- Color ramps ----------
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

// ---------- Layer config (expects GeoJSON at /data/<date>/<file>) ----------
const LAYER_CONFIG = {
  grazing:   { file: "grazing.geojson",   type: "poly", valueProp: "g" },     // optional 0..1
  water:     { file: "water.geojson",     type: "poly", valueProp: "w" },     // optional 0..1
  presence:  { file: "presence.geojson",  type: "poly", valueProp: "p" },     // recommended 0..1
  corridors: { file: "corridors.geojson", type: "line", valueProp: "w" },     // optional 0..1
  hotspots:  { file: "hotspots.geojson",  type: "poly", valueProp: "risk" }   // recommended 0..1
};

const layersOnMap = {};
let indexData = null;          // data/index.json
let availableDates = [];
let baseDate = null;           // Day 0 = latest available imagery date (index.latest)

// fetch helper
async function fetchJSON(url) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Decreasing-confidence fade as lead time increases (0..30 days)
function leadFade(leadDays) {
  const f = 1 - (leadDays / 46);   // 0->1.0, 30->~0.35
  return Math.max(0.35, Math.min(1.0, f));
}

function geojsonStyleFor(key, feature, leadDays) {
  const cfg = LAYER_CONFIG[key];
  const props = feature?.properties || {};
  const v = props[cfg.valueProp];

  const fade = leadFade(Math.max(0, leadDays));

  // Lines
  if (cfg.type === "line") {
    const w = clamp01(v ?? 0.5);
    return { weight: (2 + 6 * w), opacity: 0.9 * fade };
  }

  // Polygons
  if (key === "hotspots") {
    const r = clamp01(v ?? 0.3);
    return {
      weight: 1,
      color: "#ffffff",
      opacity: 0.25 * fade,
      fillColor: riskColor(r),
      fillOpacity: 0.45 * fade
    };
  }

  // presence/grazing/water default look
  const p = clamp01(v ?? 0.3);
  return {
    weight: 1,
    color: "#ffffff",
    opacity: 0.18 * fade,
    fillColor: presenceColor(p),
    fillOpacity: 0.35 * fade
  };
}

function popupTextFor(key, feature) {
  const props = feature?.properties || {};
  const cfg = LAYER_CONFIG[key];
  const v = props[cfg.valueProp];

  const label =
    key === "presence" ? "Presence (p)" :
    key === "hotspots" ? "Risk (r)" :
    key === "corridors" ? "Corridor weight (w)" :
    key;

  const shown = (v === undefined || v === null) ? "n/a" : Number(v).toFixed(2);
  return `<b>${label}</b>: ${shown}`;
}

async function loadGeoJSONLayer(key, url, leadDays) {
  const geo = await fetchJSON(url);
  if (!geo) return null;

  return L.geoJSON(geo, {
    style: (feature) => geojsonStyleFor(key, feature, leadDays),
    onEachFeature: (feature, layerObj) => layerObj.bindPopup(popupTextFor(key, feature))
  });
}

function setDateControls() {
  const current = dateSelect.value;
  const idx = availableDates.indexOf(current);
  prevBtn.disabled = idx <= 0;
  nextBtn.disabled = idx < 0 || idx >= availableDates.length - 1;

  const lead = baseDate ? diffDays(current, baseDate) : 0;
  leadTag.textContent = lead >= 0 ? `Day +${lead}` : `Day ${lead}`;
}

async function refreshLayers() {
  const dateStr = dateSelect.value;
  if (!dateStr) return;

  const lead = baseDate ? diffDays(dateStr, baseDate) : 0;
  setStatus(`Loading ${dateStr} (Day +${Math.max(0, lead)})…`);

  // Remove old layers
  Object.values(layersOnMap).forEach((layer) => map.removeLayer(layer));
  for (const k of Object.keys(layersOnMap)) delete layersOnMap[k];

  let loaded = 0;
  const bounds = [];

  for (const cb of checkboxes) {
    const key = cb.dataset.layer;
    if (!cb.checked) continue;

    const cfg = LAYER_CONFIG[key];
    const url = `data/${dateStr}/${cfg.file}`;
    const layer = await loadGeoJSONLayer(key, url, lead);

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

  // Fit view if something loaded
  if (bounds.length > 0) {
    const combined = bounds.reduce((acc, b) => acc.extend(b), bounds[0]);
    map.fitBounds(combined.pad(0.15));
  }

  // meta.json (optional but recommended)
  const meta = await fetchJSON(`data/${dateStr}/meta.json`);
  if (loaded === 0) {
    setStatus(`No layers found for ${dateStr}. Add files in /data/${dateStr}/`);
  } else if (meta?.updated) {
    const extra = meta?.notes ? ` • ${meta.notes}` : "";
    setStatus(`Loaded ${loaded} layer(s) for ${dateStr}. Updated: ${meta.updated}${extra}`);
  } else {
    setStatus(`Loaded ${loaded} layer(s) for ${dateStr}.`);
  }
}

async function initDates() {
  indexData = await fetchJSON("data/index.json");
  if (!indexData?.dates?.length) {
    setStatus("Missing data/index.json or no dates listed.");
    return;
  }

  availableDates = indexData.dates.slice().sort(); // ascending
  baseDate = indexData.latest || availableDates[availableDates.length - 1];

  // Populate dropdown
  dateSelect.innerHTML = "";
  for (const d of availableDates) {
    const opt = document.createElement("option");
    opt.value = d;
    opt.textContent = d;
    dateSelect.appendChild(opt);
  }

  // Default to latest
  dateSelect.value = baseDate;
  setDateControls();
  await refreshLayers();
}

// UI wiring
dateSelect.addEventListener("change", async () => {
  setDateControls();
  await refreshLayers();
});

prevBtn.addEventListener("click", async () => {
  const idx = availableDates.indexOf(dateSelect.value);
  if (idx > 0) dateSelect.value = availableDates[idx - 1];
  setDateControls();
  await refreshLayers();
});

nextBtn.addEventListener("click", async () => {
  const idx = availableDates.indexOf(dateSelect.value);
  if (idx >= 0 && idx < availableDates.length - 1) dateSelect.value = availableDates[idx + 1];
  setDateControls();
  await refreshLayers();
});

checkboxes.forEach((cb) => cb.addEventListener("change", refreshLayers));

// ---------- Legend ----------
const legend = L.control({ position: "bottomright" });
legend.onAdd = function () {
  const div = L.DomUtil.create("div", "legend");
  div.innerHTML = `
    <div class="legendTitle">Legend</div>

    <div class="legendBlock">
      <div class="legendLabel">Presence (p)</div>
      <div class="legendRow"><span class="swatch" style="background:${presenceColor(0.1)}"></span><span>0–0.2</span></div>
      <div class="legendRow"><span class="swatch" style="background:${presenceColor(0.3)}"></span><span>0.2–0.4</span></div>
      <div class="legendRow"><span class="swatch" style="background:${presenceColor(0.5)}"></span><span>0.4–0.6</span></div>
      <div class="legendRow"><span class="swatch" style="background:${presenceColor(0.7)}"></span><span>0.6–0.8</span></div>
      <div class="legendRow"><span class="swatch" style="background:${presenceColor(0.9)}"></span><span>0.8–1.0</span></div>
    </div>

    <div class="legendBlock">
      <div class="legendLabel">Risk (r)</div>
      <div class="legendRow"><span class="swatch" style="background:${riskColor(0.1)}"></span><span>0–0.2</span></div>
      <div class="legendRow"><span class="swatch" style="background:${riskColor(0.3)}"></span><span>0.2–0.4</span></div>
      <div class="legendRow"><span class="swatch" style="background:${riskColor(0.5)}"></span><span>0.4–0.6</span></div>
      <div class="legendRow"><span class="swatch" style="background:${riskColor(0.7)}"></span><span>0.6–0.8</span></div>
      <div class="legendRow"><span class="swatch" style="background:${riskColor(0.9)}"></span><span>0.8–1.0</span></div>
    </div>

    <div class="legendNote">UN INTERNAL • Aggregated surfaces only</div>
  `;
  return div;
};
legend.addTo(map);

// Start
initDates();
