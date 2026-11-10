(function () {
  "use strict";
  const I = window.NFA_I18N;
  const LV_COL = ["#19a897", "#f2b632", "#ee7421", "#d2263f"];
  // Brown -> blue for dry -> wet and a yellow -> red heat ramp: readable with colour-blindness and on small screens.
  const SEASON_COL = { drought: "#7f3b08", dry: "#e0a23c", normal: "#b9dc8f", wet: "#4fb3d9", very_wet: "#1f4fa3", dry_season: "#d9c9a8", unknown: "#c3ccd4" };
  const PLANT_COL = { dry_season: "#d9c9a8", waiting: "#e9a23b", wait_confirm: "#f3d34a", plant: "#1a9850", growing: "#8fd18b", harvest: "#8e5ea8" };
  const HEAT_STEPS = [[3, "#a50026", "+3 °C or more"], [2, "#e34a33", "+2 to +3 °C"], [1, "#fdae61", "+1 to +2 °C"], [-1, "#fde8c2", "near normal"], [-99, "#6baed6", "cooler than normal"]];
  const heatCol = (a) => (HEAT_STEPS.find(([t]) => a >= t) || HEAT_STEPS[4])[1];
  const MOBILE = () => window.innerWidth <= 860;
  const SHEET_MIN = 84, PEEK = 0.38;   // keep in step with --sheet-min / --sheet-peek in app.css
  const darkMq = window.matchMedia("(prefers-color-scheme: dark)");
  const reduceMq = window.matchMedia("(prefers-reduced-motion: reduce)");
  // Pick dark or white text for a coloured chip so every palette colour stays readable.
  const inkOn = (hex) => { const n = parseInt(hex.slice(1), 16), l = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; return l > 0.58 ? "#10222c" : "#fff"; };
  const chipCol = (col, text) => `<span class="chip" style="background:${col};color:${inkOn(col)}">${esc(text)}</span>`;
  const FLOOD_API = "https://flood-api.open-meteo.com/v1/flood";
  const NG_BOUNDS = L.latLngBounds([3.9, 2.4], [14.1, 15.0]);
  const S = { lang: "en", mode: "flood", view: "public", data: {}, sel: null, replay: null, lapse: null, charts: {} };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  const T = () => I.t(S.lang);
  const fmtDate = (iso, opts) => iso ? new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", opts || { day: "numeric", month: "short" }) : "";
  const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const today = () => new Date().toISOString().slice(0, 10);
  async function getJSON(url) { const r = await fetch(url, { cache: "no-cache" }); if (!r.ok) throw new Error(r.status); return r.json(); }
  const tryJSON = (url) => getJSON(url).catch(() => null);

  // ---------- geometry helpers ----------
  function inRing(pt, ring) {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) c = !c;
    }
    return c;
  }
  function inGeom(pt, g) {
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    return polys.some((p) => inRing(pt, p[0]) && !p.slice(1).some((h) => inRing(pt, h)));
  }
  function lgaAt(lat, lon) {
    const f = (S.data.lgas || []).find((x) => inGeom([lon, lat], x.geometry));
    return f ? f.properties : null;
  }

  // ---------- map ----------
  let map, bases, lgaLayer, stateLayer, pointLayer, satLayer, spotMarker, maskLayer, veilLayer, fx, pointRenderer, modeTimer;
  const lgaLayers = {};
  function initMap() {
    const mob = MOBILE();
    map = L.map("map", { zoomControl: false, attributionControl: false, minZoom: mob ? 5 : 6, zoomSnap: mob ? 0.25 : 1, maxZoom: 18, maxBounds: NG_BOUNDS.pad(mob ? 2.5 : 0.15), maxBoundsViscosity: 0.8, preferCanvas: true });
    map.fitBounds(NG_BOUNDS, mob
      ? { paddingTopLeft: [2, 104], paddingBottomRight: [2, Math.round(window.innerHeight * PEEK) + 56] }
      : { paddingTopLeft: [10, 60], paddingBottomRight: [440, 10] });
    L.control.zoom({ position: mob ? "topright" : "topleft" }).addTo(map);
    const attr = L.control.attribution({ position: "bottomright", prefix: false }).addTo(map);
    if (mob) {   // compact "i" button that opens the credits, so they never crowd a small screen
      const c = attr.getContainer(); c.classList.add("compact"); c.setAttribute("role", "button"); c.setAttribute("aria-label", "Map credits");
      L.DomEvent.on(c, "click", (e) => { L.DomEvent.stop(e); c.classList.toggle("open"); });
    }
    bases = {
      streets: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }),
      topo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 17, attribution: "© OpenStreetMap contributors, SRTM · © OpenTopoMap (CC-BY-SA)" }),
      sat: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" }),
    };
    bases.streets.addTo(map);
    [["mask", 402], ["veil", 404], ["lgas", 410], ["states", 420], ["rivers", 450]].forEach(([n, z]) => { map.createPane(n).style.zIndex = z; });
    ["mask", "veil", "states"].forEach((n) => { map.getPane(n).style.pointerEvents = "none"; });
    pointRenderer = L.canvas({ pane: "rivers", tolerance: mob ? 12 : 4 });
    fx = window.NFA_FX ? window.NFA_FX(map) : null;
    document.querySelectorAll("#bases button").forEach((b) => b.addEventListener("click", () => {
      document.querySelectorAll("#bases button").forEach((x) => x.classList.toggle("on", x === b));
      Object.values(bases).forEach((l) => map.removeLayer(l));
      bases[b.dataset.base].addTo(map).bringToBack();
      document.body.classList.toggle("base-sat", b.dataset.base === "sat");
    }));
    map.on("click", (e) => { if (!e.originalEvent._handled) selectLocation(e.latlng.lat, e.latlng.lng); });
  }

  function lgaStyle(f) {
    const p = f.properties, zoomed = map.getZoom() >= 9, night = !!S.replay;
    const line = night ? "#ffffff" : darkMq.matches ? "#a9bfca" : "#3c5261";
    if (S.mode === "flood") {
      const lv = night ? (S.replay.lgaLv[p.id] || 0) : ((S.data.latest && S.data.latest.lgas && S.data.latest.lgas[p.id]) || [0])[0];
      if (lv) return { pane: "lgas", color: LV_COL[lv], weight: 1.1, opacity: 0.95, fillColor: LV_COL[lv], fillOpacity: night ? 0.42 : 0.4 };
      return { pane: "lgas", color: line, weight: 0.5, opacity: night ? (zoomed ? 0.3 : 0.08) : (zoomed ? 0.5 : 0.16), fillColor: LV_COL[0], fillOpacity: 0 };
    }
    return { pane: "lgas", color: line, weight: 0.4, opacity: zoomed ? 0.45 : 0.06, fillColor: LV_COL[0], fillOpacity: 0 };
  }
  function stateStyle(f) {
    const st = S.data.latest && S.data.latest.states ? S.data.latest.states[f.properties.id] : null;
    const night = !!S.replay, dark = darkMq.matches;
    const base = { pane: "states", color: night || dark ? "#d5e6ec" : "#0c2230", weight: night ? 0.8 : 1.1, opacity: night ? 0.3 : 0.45, fillColor: "#fff", fillOpacity: 0 };
    if (!st || S.mode === "flood") return base;
    const fill = S.mode === "season" ? (SEASON_COL[st.status] || SEASON_COL.unknown) : S.mode === "plant" ? (PLANT_COL[st.plant] || SEASON_COL.unknown) : heatCol(st.tmax_anom ?? 0);
    return { ...base, color: dark ? "#0c1e29" : "#ffffff", weight: 1.4, opacity: 0.95, fillColor: fill, fillOpacity: 0.84 };
  }
  function maskStyle() {
    return darkMq.matches ? { fillColor: "#06131b", fillOpacity: 0.74 } : { fillColor: "#dde6e6", fillOpacity: 0.72 };
  }
  // Everything outside Nigeria is washed out so the country reads as one shape; the "veil" darkens
  // the base map for the night-time look of the replay (and a little in dark mode).
  function drawMask() {
    if (maskLayer) map.removeLayer(maskLayer);
    if (veilLayer) map.removeLayer(veilLayer);
    const holes = [];
    (S.data.states || []).forEach((f) => {
      const g = f.geometry;
      (g.type === "Polygon" ? [g.coordinates] : g.coordinates).forEach((poly) => holes.push(poly[0].map((c) => [c[1], c[0]])));
    });
    const world = [[-25, -45], [-25, 65], [42, 65], [42, -45]];
    if (holes.length) maskLayer = L.polygon([world].concat(holes), { pane: "mask", stroke: false, interactive: false, ...maskStyle() }).addTo(map);
    veilLayer = L.polygon(world, { pane: "veil", stroke: false, interactive: false, fillColor: "#04121b", fillOpacity: 1 }).addTo(map);
  }

  function drawLayers() {
    if (lgaLayer) map.removeLayer(lgaLayer);
    if (stateLayer) map.removeLayer(stateLayer);
    drawMask();
    lgaLayer = L.geoJSON({ type: "FeatureCollection", features: S.data.lgas || [] }, {
      style: lgaStyle,
      onEachFeature: (f, layer) => {
        lgaLayers[f.properties.id] = layer;
        layer.bindTooltip(() => `${esc(f.properties.name)}, ${esc(f.properties.state)}`, { sticky: true, className: "nfa" });
        layer.on("click", (e) => { e.originalEvent._handled = true; selectLocation(e.latlng.lat, e.latlng.lng, f.properties); });
      },
    }).addTo(map);
    stateLayer = L.geoJSON({ type: "FeatureCollection", features: S.data.states || [] }, { style: stateStyle, interactive: false }).addTo(map);
    drawPoints();
    if (fx) { fx.setRivers(S.data.rivers || [], S.data.allPoints || []); fx.setPoints(S.data.points || []); fxSync(); }
    let wasZoomed = map.getZoom() >= 9;   // restyle 774 polygons only when the outline threshold is crossed
    map.on("zoomend", () => { const z = map.getZoom() >= 9; if (z !== wasZoomed && lgaLayer) { wasZoomed = z; lgaLayer.setStyle(lgaStyle); } });
  }

  function pointLevel(p) {
    if (S.replay && S.replay.doc) {
      const s = S.replay.doc.levels[p.id];
      const c = s ? s[S.replay.day] : ".";
      return c && c !== "." ? +c : null;
    }
    const r = latestPoint(p.id);
    return r && r.th && r.q && r.q.length ? (r.level ?? 0) : null;
  }
  function pointStyle(lv) {
    const night = !!S.replay;
    // Outside the flood layer the gauges step back so the state colours can be read.
    if (S.mode !== "flood") return { radius: 2, weight: 0, opacity: 0, fillColor: darkMq.matches ? "#e6f0f3" : "#0c2230", fillOpacity: 0.3 };
    // In the replay the rivers carry the story, so the gauges shrink to small beads on the line.
    if (night) return { radius: lv == null ? 2.2 : 2.6 + 0.9 * lv, weight: 1, opacity: 0.9, color: "#04121b", fillColor: lv == null ? "#7d8f99" : lv ? "#fff" : LV_COL[0], fillOpacity: lv === 0 ? 0.75 : 1 };
    return { radius: lv >= 2 ? 7 : lv === 1 ? 6 : MOBILE() ? 3.6 : 4.4, weight: lv >= 1 ? 2 : MOBILE() ? 1 : 1.3, opacity: 1, color: darkMq.matches ? "#0c1e29" : "#ffffff",
      fillColor: lv == null ? "#9aa9b3" : LV_COL[lv], fillOpacity: 1 };
  }
  function drawPoints() {
    if (pointLayer) map.removeLayer(pointLayer);
    pointLayer = L.layerGroup().addTo(map);
    (S.data.points || []).forEach((p) => {
      const lv = pointLevel(p);
      const m = L.circleMarker([p.lat, p.lon], { pane: "rivers", renderer: pointRenderer, ...pointStyle(lv) });
      m.bindTooltip(`${esc(p.river)} · ${esc(p.name)}`, { className: "nfa" });
      m.on("click", (e) => { L.DomEvent.stopPropagation(e); selectLocation(p.lat, p.lon, null, p.id); });
      m.addTo(pointLayer);
      p._m = m; p._k = lv;
    });
  }
  // Only markers whose level changed are restyled, so a replay day costs a handful of updates.
  function recolorPoints(all) {
    (S.data.points || []).forEach((p) => {
      if (!p._m) return;
      const lv = pointLevel(p);
      if (!all && p._k === lv) return;
      p._k = lv; p._m.setStyle(pointStyle(lv));
    });
  }
  const sizeW = (q) => 1.1 + 0.95 * Math.log10(1 + Math.max(0, q || 0));
  // Feed the water layer: each gauge's level sets the colour, its flow sets the width of the river near it.
  function fxSync() {
    if (!fx) return;
    const vals = {}, R = S.replay;
    (S.data.allPoints || []).forEach((p) => {
      if (R && R.doc) {
        const s = R.doc.levels[p.id], c = s ? s[R.day] : ".";
        const fl = R.doc.flows3 && R.doc.flows3[p.id];
        let w = 1.6;
        if (fl && fl.length) {
          const x = Math.min(fl.length - 1, R.t / 3), i = Math.floor(x), a = fl[i] || 0, b = fl[Math.min(fl.length - 1, i + 1)] || 0;
          const qm = R.qmax[p.id] || 1;
          w = Math.max(1.5, 1.25 * sizeW(qm) * (0.32 + 0.68 * Math.sqrt(Math.max(0, a + (b - a) * (x - i)) / qm)));
        }
        vals[p.id] = { lv: c && c !== "." ? +c : null, w };
      } else {
        const r = latestPoint(p.id);
        vals[p.id] = { lv: r && r.th && r.q && r.q.length ? (r.level || 0) : null, w: Math.max(1.8, sizeW(r ? r.q_now : 0)) };
      }
    });
    fx.update(vals);
    fx.set({ night: !!R, dim: S.mode !== "flood" });
  }
  function restyle() {
    lgaLayer && lgaLayer.setStyle(lgaStyle); stateLayer && stateLayer.setStyle(stateStyle);
    recolorPoints(true); renderLegend(); fxSync();
  }
  // Cross-fade the vector layers when the map layer changes instead of snapping.
  function applyMode(animated) {
    syncModeButtons();
    document.body.dataset.mode = S.mode;
    if (!animated || reduceMq.matches || !map) return restyle();
    const panes = ["lgas", "states", "rivers", "fx"].map((n) => map.getPane(n)).filter(Boolean);
    panes.forEach((p) => p.classList.add("fading"));
    clearTimeout(modeTimer);
    modeTimer = setTimeout(() => { restyle(); panes.forEach((p) => p.classList.remove("fading")); }, 190);
  }
  const shown = (id) => !(S.data.pointById[id] || {}).hide;
  const latestPoint = (id) => (S.data.latestById || {})[id];

  // ---------- legend ----------
  function dataReady(mode) {
    const lt = S.data.latest || {};
    if (mode === "flood") return (lt.points || []).some((p) => p.th && p.q && p.q.length);
    const st = Object.values(lt.states || {});
    if (mode === "season") return st.some((s) => s.status && s.status !== "unknown");
    if (mode === "heat") return st.some((s) => s.tmax_anom != null);
    return st.length > 0;
  }
  function notReadyText(mode) {
    const b = (S.data.status && S.data.status.last && S.data.status.last.backfill) || {};
    const yrs = mode === "flood" ? b.complete_years_flood : b.complete_years_wx;
    const need = mode === "plant" ? 1 : mode === "flood" ? 3 : 2;
    return `Still downloading the history this map is compared against (${(yrs || 0).toFixed(1)} of ${need} years needed). It fills in automatically, usually within ${mode === "flood" ? "two days" : "a day"}.`;
  }
  let toastTimer = null;
  function toast(html) {
    const el = $("toast"); if (!el) return;
    el.innerHTML = html; el.hidden = false; el.classList.add("on");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.classList.remove("on"); setTimeout(() => { el.hidden = true; }, 250); }, 3800);
  }
  function setMode(m) {
    if (S.replay && m !== "flood") exitReplay();
    S.mode = m; applyMode(true);
    const t = T();
    const name = t["mode_" + m] || m;
    toast(dataReady(m) ? `<b>${esc(name)}</b> · ${esc(modeHint(m))}` : `<b>${esc(name)}</b> · ${esc(notReadyText(m))}`);
  }
  function modeHint(m) {
    return { flood: "coloured areas are communities at risk in the next 30 days", season: "each state compared with its normal rain for this time of year", plant: "has the rainy season properly started in each state?", heat: "this week's top temperatures compared with normal" }[m];
  }

  // One legend for both layouts: full labels on desktop, a compact strip of short labels on phones.
  function renderLegend() {
    if (S.lapse) return;
    const t = T();
    const row = (col, long, short) => `<div class="row"><span class="sw" style="background:${col}"></span><span class="lg-long">${esc(long)}</span><span class="lg-short">${esc(short || long)}</span></div>`;
    let title = t["mode_" + S.mode], rows = "", note = "";
    if (S.mode === "flood") {
      rows = t.lvl.map((n, i) => row(LV_COL[i], n)).join("");
      note = S.replay ? t.lg_replay : t.lg_flood;
    }
    if (S.mode === "season") rows = Object.keys(SEASON_COL).filter((k) => k !== "unknown").map((k) => row(SEASON_COL[k], t.season[k], (t.season_short || {})[k])).join("");
    if (S.mode === "plant") rows = Object.keys(PLANT_COL).map((k) => row(PLANT_COL[k], t.plant[k], (t.plant_short || {})[k])).join("");
    if (S.mode === "heat") { rows = HEAT_STEPS.map(([, c, n]) => row(c, n, n.replace(" °C", "°").replace(" or more", "+").replace(" than normal", ""))).join(""); note = t.lg_heat; }
    let html = `<b>${esc(title)}</b><div class="rows">${rows}</div>${note ? `<div class="lg-note">${esc(note)}</div>` : ""}`;
    if (!dataReady(S.mode)) html += `<div class="nodata">${esc(notReadyText(S.mode))}</div>`;
    const el = $("legend"); el.innerHTML = html;
    document.documentElement.style.setProperty("--legend-h", el.offsetHeight + "px");
  }

  // ---------- data ----------
  async function loadData() {
    const [latest, points, lgas, states, status, hindex, rivers] = await Promise.all([
      tryJSON("data/latest.json"), tryJSON("data/points.json"), tryJSON("data/geo/lgas.geojson"),
      tryJSON("data/geo/states.geojson"), tryJSON("data/status.json"), tryJSON("data/history/index.json"), tryJSON("data/geo/rivers.geojson"),
    ]);
    const allPts = points || [];
    S.data = { latest, allPoints: allPts, points: allPts.filter((p) => !p.hide), lgas: lgas ? lgas.features : [], states: states ? states.features : [], status, hindex: hindex || [], rivers: rivers ? rivers.features : [] };
    S.data.latestById = {};
    ((latest && latest.points) || []).forEach((p) => { S.data.latestById[p.id] = p; });
    S.data.pointById = {};
    S.data.allPoints.forEach((p) => { S.data.pointById[p.id] = p; });
    S.data.stateByName = {};
    S.data.states.forEach((f) => { S.data.stateByName[f.properties.name] = f.properties; });
    const links = await tryJSON("data/lga_links.json");
    S.data.links = links || {};
    S.data.lgaPts = {};
    Object.entries(S.data.links).forEach(([lid, v]) => { if (v.points && v.points.length) S.data.lgaPts[lid] = v.points; });
    liveBadge();
  }

  function liveBadge() {
    const st = S.data.status && S.data.status.last;
    const el = $("live");
    if (!st || !st.finished) { el.className = "live"; $("liveText").textContent = "Starting up"; return; }
    const hrs = (Date.now() - Date.parse(st.finished)) / 3.6e6;
    el.className = "live " + (hrs < 36 ? "ok" : "stale");
    $("liveText").textContent = `${T().live} · ${T().updated} ${fmtDate(st.finished.slice(0, 10))}`;
  }

  // ---------- Today tab ----------
  function viewSwitch() {
    const t = T();
    return `<div class="seg views" id="views">${["public", "farmer", "nema"].map((v) => `<button data-view="${v}" class="${S.view === v ? "on" : ""}">${esc(t["view_" + v])}</button>`).join("")}</div>`;
  }
  function bindViewSwitch() {
    document.querySelectorAll("#views button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
  }
  function setView(v) {
    S.view = v; store.set("nfa_view", v);
    if (S.replay) exitReplay();
    S.mode = v === "farmer" ? "plant" : "flood"; applyMode(true);
    renderToday();
  }

  function renderToday() {
    const t = T();
    const el = $("tab-today");
    if (S.sel) return renderPlace(S.sel);
    if (S.view === "farmer") return renderFarmer();
    if (S.view === "nema") return renderNema();
    const lt = S.data.latest;
    let html = "";
    const st = S.data.status && S.data.status.last;
    if (!dataReady("flood") || !dataReady("season")) {
      const b = (st && st.backfill) || {};
      const fy = b.complete_years_flood || 0, wy = b.complete_years_wx || 0;
      const meter = (label, have, need) => `<div class="wu-row"><span>${label}</span><div class="track"><div class="fill" style="width:${Math.min(100, Math.round(100 * have / need))}%"></div></div><b>${have.toFixed(1)} / ${need} yr</b></div>`;
      html += `<div class="warmup"><b>Warming up.</b> NaijaFloodAlert downloads 14 years of river and weather records by itself, a little every few hours.
        ${meter("River history", fy, 3)}${meter("Weather history", wy, 2)}
        <span class="small">River history: ${fy.toFixed(1)} years · weather history: ${wy.toFixed(1)} years. Flood levels switch on at 3 years, the season and heat maps at 2 years. Grey points have no verdict yet.</span></div>`;
    }
    const lgaVals = Object.values((lt && lt.lgas) || {});
    const atRisk = lgaVals.filter((v) => v[0] >= 1).length;
    const states = Object.values((lt && lt.states) || {});
    const drought = states.filter((s) => s.status === "drought" || s.status === "dry").length;
    const plant = states.filter((s) => s.plant === "plant").length;
    html = viewSwitch() + html + `<p class="muted">${esc(t.tagline)}.</p>
      <div class="cards">
        <div class="card"><b class="big">${atRisk}</b><span>communities (LGAs) at Watch or above, next 30 days</span></div>
        <div class="card"><b class="big">${(S.data.points || []).length}</b><span>river points monitored daily</span></div>
        <div class="card"><b class="big">${drought}</b><span>states drier than normal</span></div>
        <div class="card"><b class="big">${plant}</b><span>states where rains are established</span></div>
      </div>
      <p class="small muted">Tap any community on the map, search for a town, or zoom in to see local streams.</p>` + lagdoCard(false);
    const top = Object.entries((lt && lt.lgas) || {}).filter(([, v]) => v[0] > 0 || v[1] >= 0.3).sort((a, b) => b[1][0] - a[1][0] || b[1][1] - a[1][1]).slice(0, 12);
    html += `<h3>Highest flood risk</h3>`;
    if (!top.length) html += `<p class="muted small">No community is above normal right now${lt ? "" : " (waiting for first forecast)"}.</p>`;
    else html += `<ul class="list">${top.map(([id, v]) => { const f = lgaById(id); return f ? `<li data-lga="${id}"><span class="nm">${esc(f.name)}<small>${esc(f.state)} · ML 7-day chance ${Math.round(v[1] * 100)}%</small></span><span class="chip l${v[0]}">${esc(t.lvl[v[0]])}</span></li>` : ""; }).join("")}</ul>`;
    if (states.length) {
      html += `<h3>${esc(t.mode_season)} &amp; ${esc(t.mode_plant).toLowerCase()} by state</h3><ul class="list">` +
        Object.entries(lt.states).sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([sid, s]) => `<li data-state="${sid}"><span class="nm">${esc(s.name)}<small>${esc(t.plant[s.plant] || "")}</small></span>${chipCol(SEASON_COL[s.status] || SEASON_COL.unknown, t.season[s.status] || s.status)}</li>`).join("") + `</ul>`;
    }
    el.innerHTML = html;
    bindViewSwitch(); bindLagdo();
    el.querySelectorAll("[data-lga]").forEach((li) => li.addEventListener("click", () => { const f = lgaById(li.dataset.lga); selectLocation(f.lat, f.lon, f, null, true); }));
    el.querySelectorAll("[data-state]").forEach((li) => li.addEventListener("click", () => { const s = S.data.states.find((x) => x.properties.id === li.dataset.state); if (s) map.fitBounds(L.geoJSON(s).getBounds()); }));
  }
  function rainBars(days) {
    if (!days || !days.length) return "";
    const max = Math.max(20, ...days);
    const t0 = today();
    return `<div class="rainbars">${days.map((mm, i) => `<div class="rb"><span style="height:${Math.round(100 * mm / max)}%"></span><b>${Math.round(mm)}</b><small>${esc(fmtDate(addDays(t0, i), { weekday: "short" }))}</small></div>`).join("")}</div>`;
  }

  function renderFarmer() {
    const t = T();
    const lt = S.data.latest || {};
    const states = Object.entries(lt.states || {}).sort((a, b) => a[1].name.localeCompare(b[1].name));
    let html = viewSwitch() + `<h2>Farm outlook</h2><p class="muted small">Planting signal, rain and heat for every state, compared with the same time of year since 2012. Tap a state to zoom in, or tap your community on the map.</p>`;
    if (!states.length) html += `<div class="warmup">Season data appears after the first full daily update.</div>`;
    const counts = {}; states.forEach(([, s]) => { counts[s.plant] = (counts[s.plant] || 0) + 1; });
    html += `<div class="cards">${["plant", "growing", "wait_confirm", "waiting", "dry_season", "harvest"].filter((k) => counts[k]).map((k) => `<div class="card"><b class="big"><i class="dot" style="background:${PLANT_COL[k]}"></i>${counts[k]}</b><span>${esc(t.plant[k])}</span></div>`).join("")}</div>`;
    html += `<ul class="list farm">` + states.map(([sid, s]) => `<li data-state="${sid}"><span class="nm">${esc(s.name)}<small>${esc(t.plant[s.plant] || "")}${s.dry_run ? " · " + esc(t.dry_run(s.dry_run)) : ""}${s.heat ? " · 🔥" : ""}</small></span>
        <span class="mini">${(s.rain_days || []).map((mm) => `<i style="height:${Math.min(100, Math.round(mm * 3))}%" title="${mm} mm"></i>`).join("")}</span></li>`).join("") + `</ul>
      <p class="small muted">Small bars: rain forecast for the next 7 days.</p>`;
    const el = $("tab-today"); el.innerHTML = html; bindViewSwitch();
    el.querySelectorAll("[data-state]").forEach((li) => li.addEventListener("click", () => { const f = S.data.states.find((x) => x.properties.id === li.dataset.state); if (f) map.fitBounds(L.geoJSON(f).getBounds()); }));
  }

  function nemaRows() {
    const lt = S.data.latest || {};
    const out = [];
    Object.entries(lt.lgas || {}).forEach(([lid, v]) => {
      if (v[0] < 1 && v[1] < 0.3) return;
      const f = lgaById(lid); if (!f) return;
      const ids = ((S.data.links || {})[lid] || {}).points || [];
      const pts = ids.filter(shown).map((id) => latestPoint(id)).filter(Boolean).sort((a, b) => (b.level || 0) - (a.level || 0));
      const p = pts[0]; const meta = p ? S.data.pointById[p.id] : null;
      out.push({ lid, name: f.name, state: f.state, level: v[0], ml7: v[1], river: meta ? meta.river : "rainfall", first: p && p.first, peak: p && p.peak_date });
    });
    return out.sort((a, b) => b.level - a.level || b.ml7 - a.ml7);
  }

  function renderNema() {
    const t = T();
    const rows = nemaRows();
    const byLevel = [0, 0, 0, 0]; rows.forEach((r) => byLevel[r.level]++);
    const byState = {}; rows.filter((r) => r.level >= 1).forEach((r) => { byState[r.state] = (byState[r.state] || 0) + 1; });
    let html = viewSwitch() + `<h2>Emergency operations view</h2><p class="muted small">Communities (LGAs) ranked by forecast flood level over the next 30 days, then by the machine-learning chance of rising above normal within 7 days.</p>
      <div class="cards"><div class="card"><b class="big"><i class="dot" style="background:${LV_COL[3]}"></i>${byLevel[3]}</b><span>${esc(t.lvl[3])}</span></div><div class="card"><b class="big"><i class="dot" style="background:${LV_COL[2]}"></i>${byLevel[2]}</b><span>${esc(t.lvl[2])}</span></div>
      <div class="card"><b class="big"><i class="dot" style="background:${LV_COL[1]}"></i>${byLevel[1]}</b><span>${esc(t.lvl[1])}</span></div><div class="card"><b class="big">${Object.keys(byState).length}</b><span>states affected</span></div></div>
      <div class="btns"><button class="btn" id="csv">Download CSV</button><button class="btn ghost" id="print">Print bulletin</button></div>` + lagdoCard(true);
    html += `<h3>At-risk communities</h3>`;
    if (!rows.length) html += `<p class="muted small">No community is above normal right now.</p>`;
    else html += `<table class="metrics nema"><tr><th>LGA</th><th>State</th><th>Level</th><th>7-day ML</th><th>From</th></tr>` + rows.slice(0, 80).map((r) => `<tr data-lga="${r.lid}"><td>${esc(r.name)}</td><td>${esc(r.state)}</td><td><span class="chip l${r.level}">${esc(t.lvl[r.level])}</span></td><td>${Math.round(100 * r.ml7)}%</td><td>${r.first ? fmtDate(r.first) : "–"}</td></tr>`).join("") + `</table>`;
    const el = $("tab-today"); el.innerHTML = html; bindViewSwitch(); bindLagdo();
    el.querySelectorAll("tr[data-lga]").forEach((tr) => tr.addEventListener("click", () => { const f = lgaById(tr.dataset.lga); selectLocation(f.lat, f.lon, f, null, true); }));
    $("csv").addEventListener("click", () => {
      const lines = [["lga", "state", "level", "level_name", "ml_7day_chance", "river", "first_day_above_normal", "peak_date"].join(",")]
        .concat(rows.map((r) => [r.name, r.state, r.level, t.lvl[r.level], r.ml7, r.river, r.first || "", r.peak || ""].map((x) => `"${String(x).replace(/"/g, '""')}"`).join(",")));
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
      a.download = `naijafloodalert_at_risk_${today()}.csv`; a.click();
    });
    $("print").addEventListener("click", () => printBulletin(rows));
  }

  function printBulletin(rows) {
    const t = T(); const lt = S.data.latest || {};
    const w = window.open("", "_blank"); if (!w) return;
    const states = Object.values(lt.states || {}).sort((a, b) => a.name.localeCompare(b.name));
    w.document.write(`<!doctype html><title>NaijaFloodAlert bulletin ${today()}</title><style>body{font:12px/1.4 Arial,sans-serif;margin:24px;color:#111}h1{font-size:20px;margin:0}table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border:1px solid #ccc;padding:4px 6px;text-align:left}th{background:#f0f3f6}.l1{background:#f2b705}.l2{background:#ef6c00;color:#fff}.l3{background:#d32f2f;color:#fff}small{color:#555}</style>
      <h1>NaijaFloodAlert — flood &amp; season bulletin</h1><small>Generated ${new Date().toLocaleString("en-GB")} · data updated ${esc((lt.generated || "").replace("T", " "))} UTC · geraldnzeribe.github.io/naijafloodalert</small>
      <h2>Communities at Watch or above (next 30 days)</h2><table><tr><th>LGA</th><th>State</th><th>Level</th><th>7-day ML chance</th><th>River</th><th>From</th><th>Peak</th></tr>
      ${rows.filter((r) => r.level >= 1).map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.state)}</td><td class="l${r.level}">${esc(t.lvl[r.level])}</td><td>${Math.round(100 * r.ml7)}%</td><td>${esc(r.river)}</td><td>${r.first || ""}</td><td>${r.peak || ""}</td></tr>`).join("") || `<tr><td colspan="7">None</td></tr>`}</table>
      <h2>Season by state</h2><table><tr><th>State</th><th>Status</th><th>Rain 30 d (% normal)</th><th>Rain next 7 d</th><th>Planting</th><th>Heat</th></tr>
      ${states.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(t.season[s.status] || s.status)}</td><td>${s.rain30 ?? ""} mm (${s.pct_normal30 != null ? Math.round(s.pct_normal30) + "%" : "–"})</td><td>${s.rain_next7 != null ? Math.round(s.rain_next7) + " mm" : ""}</td><td>${esc(t.plant[s.plant] || "")}</td><td>${s.heat ? "Yes" : ""}</td></tr>`).join("")}</table>
      <p><small>Research and public-information tool; does not replace official warnings from NIHSA, NiMet, NEMA or SEMAs. Emergency: 112.</small></p>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 400);
  }

  function lagdoCard(always) {
    const t = T();
    const lg = S.data.latest && S.data.latest.lagdo;
    if (!lg || !lg.source || lg.source.q_now == null) return "";
    const s = lg.source;
    if (!always && !s.level && !(s.trend7 > 25)) return "";
    const arr = (lg.targets || []).filter((x) => x.lag_days > 0 && x.corr >= 0.3);
    return `<div class="lagdo card"><b>${esc(t.lagdo_title)}</b> <span class="chip l${s.level || 0}">${esc(t.lvl[s.level || 0])}</span>
      <p class="small">River Benue at ${esc(s.name)} (Cameroon): <b>${fmtQ(s.q_now)} m³/s</b>, ${s.pct_of_normal != null ? Math.round(s.pct_of_normal) + "% of typical" : ""}${s.trend7 != null ? `, ${s.trend7 > 0 ? "up" : "down"} ${Math.abs(Math.round(s.trend7))}% in 7 days` : ""}. Watch level ${fmtQ(s.watch)} m³/s.</p>
      ${arr.length ? `<p class="small">Typical travel time of a rise from here (learned from history): ${arr.map((x) => `${esc(x.name)} ~${x.lag_days} d`).join(" · ")}.</p>` : `<p class="small muted">Travel times appear once enough history is downloaded.</p>`}
      <button class="btn ghost" id="lagdoGo">Show on map</button></div>`;
  }
  function bindLagdo() {
    const b = $("lagdoGo"); if (!b) return;
    b.addEventListener("click", () => { const s = S.data.latest.lagdo.source; map.flyTo([s.lat, s.lon], 8); });
  }

  const lgaById = (id) => { const f = (S.data.lgas || []).find((x) => x.properties.id === id); return f ? f.properties : null; };

  // ---------- place selection ----------
  function selectLocation(lat, lon, lgaProps, pointId, fly) {
    const lga = lgaProps || lgaAt(lat, lon);
    if (!lga) return;
    S.sel = { lat, lon, lga, pointId };
    if (fly) map.flyTo([lat, lon], Math.max(map.getZoom(), 11), { duration: 0.8 });
    if (spotMarker) map.removeLayer(spotMarker);
    spotMarker = L.circleMarker([lat, lon], { pane: "rivers", renderer: pointRenderer, interactive: false, radius: 8, color: "#0c2230", weight: 3.5, fillColor: "#fff", fillOpacity: 1 }).addTo(map);
    switchTab("today");
    renderPlace(S.sel);
    if (MOBILE()) { if (S.replay && S.replay.playing) stopPlay(); sheetState("full"); }
  }

  function placeAssessment(sel) {
    const lt = S.data.latest || {};
    const lv = ((lt.lgas || {})[sel.lga.id] || [0, 0]);
    const ids = ((S.data.links || {})[sel.lga.id] || {}).points || [];
    let main = sel.pointId ? latestPoint(sel.pointId) : null;
    const cands = ids.filter(shown).map((id) => latestPoint(id)).filter(Boolean);
    if (!main && cands.length) main = cands.sort((a, b) => (b.level || 0) - (a.level || 0) || (b.peak || 0) - (a.peak || 0))[0];
    const sProps = S.data.stateByName[sel.lga.state];
    const season = sProps && lt.states ? lt.states[sProps.id] : null;
    return { lv: lv[0], ml7: lv[1], main, cands, season };
  }

  function renderPlace(sel) {
    const t = T();
    const a = placeAssessment(sel);
    const mp = a.main ? S.data.pointById[a.main.id] : null;
    const place = `${sel.lga.name}, ${sel.lga.state}`;
    const msg = I.message(S.lang, place, mp ? mp.river : "", {
      level: a.lv, river: a.main && a.main.level > 0, first: a.main && a.main.first ? fmtDate(a.main.first) : null,
      peak: a.main && a.main.level > 0 && a.main.peak_date ? fmtDate(a.main.peak_date) : null,
      rain7: a.season ? a.season.rain_next7 : null,
    });
    let html = `<button class="back" id="back">← Nigeria overview</button>
      <div class="place-head"><div><h2>${esc(sel.lga.name)}</h2><div class="muted">${esc(sel.lga.state)} State · ${sel.lat.toFixed(4)}, ${sel.lon.toFixed(4)}</div></div>
      <span class="chip l${a.lv}">${esc(t.lvl[a.lv])}</span></div>
      <div class="alert l${a.lv}"><p id="msg">${esc(msg)}</p>${t.draft ? `<p class="small muted">⚠ ${esc(t.draft)}</p>` : ""}
        <div class="btns"><a class="btn wa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}">${esc(t.share_wa)}</a><button class="btn ghost" id="copy">${esc(t.copy)}</button></div></div>`;
    if (S.view === "farmer" && a.season) {
      const s = a.season;
      html += `<h3>Farm outlook · ${esc(sel.lga.state)}</h3><p>${chipCol(PLANT_COL[s.plant] || SEASON_COL.unknown, t.plant[s.plant] || "")}</p>
        <p class="small">${esc((t.farm_tip || {})[s.plant] || "")}</p>${s.heat ? `<p class="small">🔥 ${esc(t.heat_tip)}</p>` : ""}
        <h4>${esc(t.next7)}</h4>${rainBars(s.rain_days)}${s.dry_run ? `<p class="small muted">${esc(t.dry_run(s.dry_run))}</p>` : ""}`;
    }
    if (a.main && mp) {
      html += `<h3>${esc(mp.river)} near ${esc(mp.name)}</h3>
        <dl class="kv"><dt>Flow today</dt><dd>${fmtQ(a.main.q_now)} m³/s</dd><dt>Highest in next 30 days</dt><dd>${fmtQ(a.main.peak)} m³/s · ${fmtDate(a.main.peak_date)}</dd>
        ${a.main.th ? `<dt>This river's Watch level</dt><dd>${fmtQ(a.main.th.p90)} m³/s</dd>` : ""}</dl>
        <div class="chart"><canvas id="pchart"></canvas></div>`;
      if (a.main.ml) {
        html += `<h4>${esc(t.chance)} (machine-learning model)</h4><div class="bars">` + Object.entries(a.main.ml).map(([lead, v]) =>
          `<div class="bar-row"><span>${esc(t.in_days(lead))}</span><div class="track"><div class="fill" style="width:${Math.round(100 * v.watch)}%"></div></div><b>${Math.round(100 * v.watch)}%</b></div>`).join("") + `</div>`;
      }
      if (a.cands.length > 1) html += `<p class="small muted">${a.cands.length} river points affect this community; showing the most at-risk one.</p>`;
    } else {
      html += `<p class="muted small">No large river channel runs through this LGA in the national network, so the alert uses the rainfall forecast. Tap below to analyse the exact spot you selected, including small rivers.</p>`;
    }
    html += `<div class="btns" style="margin:10px 0"><button class="btn ghost" id="spot">Analyse this exact spot</button></div><div id="spotout"></div>
      <h3>Climate time-lapse</h3><p class="small muted">Satellite pictures of this area played as an animation (NASA MODIS). Cloud and image gaps can leave blank frames.</p>
      <div class="btns"><button class="btn ghost" id="lapseGreen">${esc(t.lapse_green)}</button><button class="btn ghost" id="lapseFlood">${esc(t.lapse_flood)}</button></div>`;
    if (a.season) {
      const s = a.season;
      html += `<h3>${esc(t.mode_season)} · ${esc(sel.lga.state)}</h3>
        <dl class="kv">
          <dt>Status</dt><dd>${chipCol(SEASON_COL[s.status] || SEASON_COL.unknown, t.season[s.status] || s.status)}</dd>
          <dt>Rain, last 30 days</dt><dd>${s.rain30 ?? "–"} mm ${s.pct_normal30 != null ? `(${Math.round(s.pct_normal30)}% of normal)` : ""}</dd>
          <dt>Rain expected, next 7 days</dt><dd>${s.rain_next7 != null ? Math.round(s.rain_next7) + " mm" : "–"}</dd>
          <dt>Max temperature (7-day)</dt><dd>${s.tmax7 ?? "–"} °C ${s.tmax_anom != null ? `(${s.tmax_anom > 0 ? "+" : ""}${s.tmax_anom} °C)` : ""}</dd>
          <dt>Heat</dt><dd>${s.heat ? "🔥 " + esc(t.heat) : esc(t.no_heat)}</dd>
          <dt>${esc(t.mode_plant)}</dt><dd>${esc(t.plant[s.plant] || "–")}</dd>
          ${s.onset ? `<dt>Rains started</dt><dd>${fmtDate(s.onset, { day: "numeric", month: "short", year: "numeric" })}</dd>` : ""}
        </dl>
        <p class="note">Season figures compare this state's recent rain and temperature with the same time of year since 2012 (ERA5 reanalysis). Planting signal: 20 mm in 3 days with no 7-day dry spell in the following 3 weeks.</p>`;
    }
    $("tab-today").innerHTML = html;
    $("back").addEventListener("click", () => { S.sel = null; if (spotMarker) map.removeLayer(spotMarker); renderToday(); });
    $("copy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(msg); $("copy").textContent = t.copied; } catch (e) { /* ignore */ } });
    $("spot").addEventListener("click", () => analyseSpot(sel.lat, sel.lon));
    $("lapseGreen").addEventListener("click", () => startLapse("ndvi", sel.lat, sel.lon));
    $("lapseFlood").addEventListener("click", () => startLapse("flood", sel.lat, sel.lon));
    if (a.main && mp) pointChart("pchart", a.main);
  }
  const fmtQ = (q) => q == null ? "–" : Math.round(q).toLocaleString();

  function pointChart(canvasId, r) {
    if (S.charts[canvasId]) S.charts[canvasId].destroy();
    const c = $(canvasId); if (!c || !window.Chart || !r.q) return;
    const labels = r.q.map((_, i) => fmtDate(addDays(r.t0, i)));
    const ti = r.q.findIndex((_, i) => addDays(r.t0, i) >= today());
    const line = (v, col, label) => ({ label, data: labels.map(() => v), borderColor: col, borderDash: [6, 4], borderWidth: 1.4, pointRadius: 0, fill: false });
    const ds = [
      { label: "max", data: r.qmax, borderWidth: 0, pointRadius: 0, backgroundColor: "rgba(28,136,204,.16)", fill: "+1" },
      { label: "min", data: r.qmin, borderWidth: 0, pointRadius: 0, fill: false },
      { label: "Flow (m³/s)", data: r.q, borderColor: "#1c88cc", borderWidth: 2.6, pointRadius: 0, tension: 0.25, segment: { borderDash: (ctx) => (ctx.p0DataIndex < ti ? [3, 3] : undefined) } },
    ];
    if (r.th) ds.push(line(r.th.p90, LV_COL[1], T().lvl[1]), line(r.th.p98, LV_COL[2], T().lvl[2]), line(r.th.p997, LV_COL[3], T().lvl[3]));
    S.charts[canvasId] = new Chart(c, {
      type: "line", data: { labels, datasets: ds },
      options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
        plugins: { legend: { labels: { boxWidth: 10, boxHeight: 2, filter: (i) => !/^(max|min)$/.test(i.text) } } },
        scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 7, maxRotation: 0 } }, y: { title: { display: true, text: "m³/s" } } } },
    });
  }

  // ---------- exact-spot analysis (runs in the browser) ----------
  async function analyseSpot(lat, lon) {
    const out = $("spotout");
    out.innerHTML = `<p class="muted small">Finding the nearest river channel and its 14-year record…</p>`;
    try {
      const offs = []; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) offs.push([lat + i * 0.05, lon + j * 0.05]);
      const near = await getJSON(`${FLOOD_API}?latitude=${offs.map((o) => o[0].toFixed(3)).join(",")}&longitude=${offs.map((o) => o[1].toFixed(3)).join(",")}&daily=river_discharge&past_days=31&forecast_days=30`);
      const arr = Array.isArray(near) ? near : [near];
      let best = null;
      arr.forEach((x, k) => { const v = (x.daily.river_discharge || []).filter((q) => q != null); const m = v.length ? v.reduce((s, q) => s + q, 0) / v.length : 0; if (!best || m > best.m) best = { m, k }; });
      const [blat, blon] = offs[best.k];
      const yest = addDays(today(), -1);
      const [hist, fc] = await Promise.all([
        getJSON(`${FLOOD_API}?latitude=${blat.toFixed(3)}&longitude=${blon.toFixed(3)}&daily=river_discharge&start_date=2012-01-01&end_date=${yest}`),
        getJSON(`${FLOOD_API}?latitude=${blat.toFixed(3)}&longitude=${blon.toFixed(3)}&daily=river_discharge,river_discharge_max,river_discharge_min&past_days=31&forecast_days=30`),
      ]);
      const v = hist.daily.river_discharge.filter((q) => q != null).sort((a, b) => a - b);
      const pc = (p) => v[Math.floor(p * (v.length - 1))];
      const th = { p50: pc(0.5), p90: pc(0.9), p98: pc(0.98), p997: pc(0.997) };
      const q = fc.daily.river_discharge;
      let lvl = 0, peak = [null, null];
      fc.daily.time.forEach((d, i) => { if (d < today() || q[i] == null) return; const l = q[i] >= th.p997 ? 3 : q[i] >= th.p98 ? 2 : q[i] >= th.p90 ? 1 : 0; lvl = Math.max(lvl, l); if (peak[0] == null || q[i] > peak[0]) peak = [q[i], d]; });
      const small = th.p90 < 5;
      out.innerHTML = `<div class="card"><b>Nearest river cell</b> (${blat.toFixed(3)}, ${blon.toFixed(3)}) · ${small ? "small stream — model flows are unreliable this small; rely on rainfall alerts" : `<span class="chip l${lvl}">${esc(T().lvl[lvl])}</span>`}
        <dl class="kv" style="margin-top:6px"><dt>Typical flow</dt><dd>${fmtQ(th.p50)} m³/s</dd><dt>Watch level</dt><dd>${fmtQ(th.p90)} m³/s</dd><dt>30-day peak</dt><dd>${fmtQ(peak[0])} m³/s · ${fmtDate(peak[1])}</dd></dl>
        <div class="chart"><canvas id="schart"></canvas></div></div>`;
      pointChart("schart", { t0: fc.daily.time[0], q, qmax: fc.daily.river_discharge_max, qmin: fc.daily.river_discharge_min, th });
      L.circleMarker([blat, blon], { pane: "rivers", renderer: pointRenderer, radius: 5, color: theme().accent, weight: 2, fillOpacity: 0.6 }).addTo(map).bindTooltip("Analysed river cell");
    } catch (e) {
      out.innerHTML = `<p class="muted small">Could not reach the forecast service (${esc(e.message)}). Try again in a moment.</p>`;
    }
  }

  // ---------- mobile bottom sheet (drag or tap the handle; transform-only animation) ----------
  function sheetState(st) {
    const p = $("panel");
    p.classList.remove("full", "min");
    if (st !== "half") p.classList.add(st);
    p.style.transform = "";
    document.body.dataset.sheet = st;
    if (fx) fx.set({ paused: MOBILE() && st === "full" });   // map is covered: stop drawing, save battery
  }
  function initSheet() {
    const p = $("panel"), grip = $("grip"), tabs = p.querySelector(".tabs");
    document.body.dataset.sheet = "half";
    grip.addEventListener("click", (e) => { if (p._dragged) return; sheetState(p.classList.contains("full") ? "half" : "full"); });
    let y0 = 0, base = 0, t0 = 0, active = false;
    const offset = () => { const m = new DOMMatrixReadOnly(getComputedStyle(p).transform); return m.m42; };
    const start = (e) => {
      if (!MOBILE()) return;
      active = true; p._dragged = false; y0 = e.clientY; t0 = performance.now(); base = offset();
      p.classList.add("dragging");
    };
    const move = (e) => {
      if (!active) return;
      const dy = e.clientY - y0;
      if (Math.abs(dy) > 4) p._dragged = true;
      const max = p.offsetHeight - SHEET_MIN;
      p.style.transform = `translateY(${Math.max(0, Math.min(max, base + dy))}px)`;
    };
    const end = (e) => {
      if (!active) return;
      active = false; p.classList.remove("dragging");
      if (!p._dragged) { p.style.transform = ""; return; }
      const y = offset(), h = p.offsetHeight, v = (e.clientY - y0) / Math.max(1, performance.now() - t0);
      const snaps = { full: 0, half: h - window.innerHeight * PEEK, min: h - SHEET_MIN };
      let best = Object.entries(snaps).sort((a, b) => Math.abs(a[1] - y) - Math.abs(b[1] - y))[0][0];
      if (v > 0.6) best = y < snaps.half ? "half" : "min";
      if (v < -0.6) best = y > snaps.half ? "half" : "full";
      sheetState(best);
      setTimeout(() => { p._dragged = false; }, 50);
    };
    [grip, tabs].forEach((el) => el.addEventListener("pointerdown", start));
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  // ---------- playback bar shared by the flood replay and the climate time-lapse ----------
  // "year" = seconds to play a whole year of the replay; "frame" = milliseconds per time-lapse picture.
  const SPEEDS = [{ label: "½×", year: 150, frame: 2400 }, { label: "1×", year: 75, frame: 1200 }, { label: "2×", year: 38, frame: 650 }, { label: "4×", year: 19, frame: 380 }];
  let speedIx = 1;
  const speed = () => SPEEDS[speedIx];
  function setPlayIcon(on) { const b = $("play"); b.classList.toggle("on", on); b.setAttribute("aria-label", on ? T().pause : T().play); }
  function showBar(kind) {
    const t = T();
    $("replaybar").hidden = false;
    document.body.classList.add("replaying"); document.body.classList.toggle("lapsing", kind === "lapse");
    $("rbWorst").hidden = kind !== "replay"; $("rbWorst").textContent = t.worst_btn;
    $("rbSatWrap").style.display = kind === "replay" ? "" : "none"; $("rbSatText").textContent = t.satellite;
    $("rbSpeed").textContent = speed().label; $("rbSpeed").setAttribute("aria-label", `${t.speed} ${speed().label}`);
    setPlayIcon(false);
    if (MOBILE()) sheetState("min");   // get the sheet out of the way: map and controls stay visible
    sizeRibbon();
  }
  function hideBar() {
    $("replaybar").hidden = true; document.body.classList.remove("replaying", "lapsing", "sat-on");
    if (MOBILE() && document.body.dataset.sheet === "min") sheetState("half");
  }
  let themeCache = null;
  function theme() {
    if (themeCache) return themeCache;
    const cs = getComputedStyle(document.documentElement), v = (n) => cs.getPropertyValue(n).trim();
    return (themeCache = { ink: v("--ink"), muted: v("--muted"), line: v("--line"), accent: v("--accent"), surface2: v("--surface2") });
  }
  function sizeRibbon() {
    const c = $("rbRibbon"), r = c.parentElement.getBoundingClientRect(), d = Math.min(window.devicePixelRatio || 1, 2);
    if (!r.width) return;
    c.width = Math.round(r.width * d); c.height = Math.round(r.height * d); c._d = d;
    drawRibbon();
  }
  // The time ribbon: the year's hydrograph (river points above normal each day), month marks and a playhead.
  function drawRibbon() {
    const c = $("rbRibbon"); if (!c || !c.width) return;
    const g = c.getContext("2d"), d = c._d || 1, W = c.width / d, H = c.height / d, th = theme();
    g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, W, H);
    const base = H - 17, top = 5, padX = 9, X = (f) => padX + f * (W - 2 * padX);
    g.font = `600 10.5px ${getComputedStyle(document.body).fontFamily}`; g.textBaseline = "alphabetic";
    let pos = 0;
    if (S.replay) {
      const doc = S.replay.doc, n = doc.days, arr = doc.above_normal_by_day, mx = Math.max(4, ...arr);
      const year = +doc.start.slice(0, 4), t0 = Date.parse(doc.start + "T00:00:00Z");
      for (let m = 0; m < 12; m++) {
        const x = X(((Date.UTC(year, m, 1) - t0) / 864e5) / (n - 1));
        g.fillStyle = th.line; g.fillRect(x, top, 1, base - top + 5);
        const name = new Date(Date.UTC(year, m, 1)).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
        g.fillStyle = th.muted; g.fillText(W < 430 ? name[0] : name, x + 3, H - 3);
      }
      const path = new Path2D(); path.moveTo(X(0), base);
      for (let i = 0; i < n; i++) path.lineTo(X(i / (n - 1)), base - ((arr[i] || 0) / mx) * (base - top));
      path.lineTo(X(1), base); path.closePath();
      const grad = g.createLinearGradient(0, base, 0, top);
      grad.addColorStop(0, LV_COL[1]); grad.addColorStop(0.55, LV_COL[2]); grad.addColorStop(1, LV_COL[3]);
      pos = X(S.replay.t / (n - 1));
      g.fillStyle = grad; g.globalAlpha = 0.26; g.fill(path);
      g.save(); g.beginPath(); g.rect(0, 0, pos, H); g.clip(); g.globalAlpha = 1; g.fill(path); g.restore();
      g.globalAlpha = 1; g.fillStyle = th.muted; g.fillRect(X(0), base, W - 2 * padX, 1);
      const wx = X(S.replay.worst / (n - 1));                       // worst-day flag
      g.fillStyle = LV_COL[3]; g.beginPath(); g.moveTo(wx - 4.5, 0); g.lineTo(wx + 4.5, 0); g.lineTo(wx, 7); g.closePath(); g.fill();
    } else if (S.lapse) {
      const ds = S.lapse.dates, n = ds.length;
      let lastM = "";
      ds.forEach((dt, i) => {
        const x = X(n > 1 ? i / (n - 1) : 0), done = i <= S.lapse.i;
        g.fillStyle = done ? th.accent : th.muted; g.globalAlpha = done ? 1 : 0.4;
        g.fillRect(x - 1.5, base - (done ? 22 : 14), 3, done ? 22 : 14);
        const m = dt.slice(0, 7);
        if (m !== lastM && (i === 0 || +dt.slice(5, 7) % (W < 430 ? 3 : 2) === 1)) { g.globalAlpha = 1; g.fillStyle = th.muted; g.fillText(fmtDate(dt, { month: "short" }), Math.min(x, W - 26), H - 3); }
        lastM = m;
      });
      g.globalAlpha = 1; pos = X(n > 1 ? S.lapse.i / (n - 1) : 0);
    } else return;
    g.fillStyle = th.ink; g.fillRect(pos - 1, 0, 2, base + 4);         // playhead
    g.beginPath(); g.arc(pos, base + 4, 5.5, 0, 6.2832); g.fill();
    g.fillStyle = th.surface2; g.beginPath(); g.arc(pos, base + 4, 2.2, 0, 6.2832); g.fill();
  }

  // ---------- climate time-lapse (NASA GIBS imagery for one place) ----------
  function lapseDates(kind) {
    const out = [];
    const end = new Date(); end.setUTCDate(end.getUTCDate() - (kind === "ndvi" ? 10 : 2));
    if (kind === "flood") {
      for (let i = 59; i >= 0; i -= 2) { const d = new Date(end); d.setUTCDate(d.getUTCDate() - i); out.push(d.toISOString().slice(0, 10)); }
      return out;
    }
    // MODIS 8-day composites start on day-of-year 1, 9, 17, ... of each year.
    for (let y = end.getUTCFullYear() - 1; y <= end.getUTCFullYear(); y++) {
      for (let doy = 1; doy <= 361; doy += 8) {
        const d = new Date(Date.UTC(y, 0, doy));
        if (d <= end && (end - d) / 864e5 <= 372) out.push(d.toISOString().slice(0, 10));
      }
    }
    return out;
  }
  function lapseUrl(kind, date) {
    return kind === "ndvi"
      ? `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_NDVI_8Day/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png`
      : `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Combined_Flood_2-Day/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png`;
  }
  function startLapse(kind, lat, lon) {
    if (S.replay) exitReplay();
    stopLapse();
    const t = T();
    S.lapse = { kind, dates: lapseDates(kind), i: 0, stack: [], timer: null };
    map.flyTo([lat, lon], Math.min(Math.max(map.getZoom(), 8), 9), { duration: 0.8 });
    showBar("lapse");
    $("rbSlider").max = S.lapse.dates.length - 1;
    $("legend").innerHTML = (kind === "ndvi"
      ? `<b>${esc(t.lg_ndvi)}</b><div class="ramp"></div><div class="lg-note">${esc(t.lg_ndvi_note)}</div>`
      : `<b>${esc(t.lg_water)}</b><div class="lg-note">${esc(t.lg_water_note)}</div>`) + `<button class="btn ghost" id="lapseStop">${esc(t.close_lapse)}</button>`;
    $("lapseStop").addEventListener("click", stopLapse);
    lapseFrame(S.lapse.dates.length - 1);
  }
  // Each picture fades in over the previous one once its tiles have arrived (cross-fade, no flicker).
  function lapseFrame(i) {
    const L2 = S.lapse; if (!L2) return;
    L2.i = Math.max(0, Math.min(L2.dates.length - 1, i));
    const date = L2.dates[L2.i], op = L2.kind === "ndvi" ? 0.88 : 1;
    $("rbSlider").value = L2.i;
    $("rbDate").textContent = fmtDate(date, { day: "numeric", month: "long", year: "numeric" });
    $("rbCount").textContent = L2.kind === "ndvi" ? T().lapse_ndvi_sub : T().lapse_flood_sub;
    drawRibbon();
    const next = L.tileLayer(lapseUrl(L2.kind, date), { maxNativeZoom: 9, maxZoom: 18, opacity: 0, className: "lapse-tiles", attribution: "NASA GIBS / MODIS" }).addTo(map);
    L2.stack.push(next);
    const show = () => {
      if (next._shown) return; next._shown = true;
      if (S.lapse !== L2 || !L2.stack.includes(next)) return;
      next.setOpacity(op);
      const older = L2.stack.slice(0, L2.stack.indexOf(next));
      L2.stack = L2.stack.slice(L2.stack.indexOf(next));
      older.forEach((l) => { if (L2.kind === "flood") l.setOpacity(0); setTimeout(() => map.removeLayer(l), 700); });
    };
    next.once("load", () => requestAnimationFrame(show));
    setTimeout(show, 2500);
  }
  function toggleLapse() {
    const L2 = S.lapse;
    if (L2.timer) { clearTimeout(L2.timer); L2.timer = null; setPlayIcon(false); return; }
    setPlayIcon(true);
    if (L2.i >= L2.dates.length - 1) lapseFrame(0); 
    const step = () => {
      if (S.lapse !== L2) return;
      if (L2.i >= L2.dates.length - 1) { L2.timer = null; setPlayIcon(false); return; }
      lapseFrame(L2.i + 1);
      L2.timer = setTimeout(step, speed().frame);
    };
    L2.timer = setTimeout(step, L2.i === 0 ? speed().frame : 250);
  }
  function stopLapse() {
    if (!S.lapse) return;
    clearTimeout(S.lapse.timer);
    map.eachLayer((l) => { if (l._url && l._url.includes("gibs.earthdata") && l !== satLayer) map.removeLayer(l); });
    S.lapse = null; hideBar(); setPlayIcon(false); renderLegend();
  }

  // ---------- Replay tab ----------
  function renderReplayTab() {
    const el = $("tab-replay"), t = T();
    const idx = S.data.hindex || [];
    if (!idx.length) { el.innerHTML = `<h2>${esc(t.replay_title)}</h2><div class="empty"><b>${esc(t.replay_empty_t)}</b><p>${esc(t.replay_empty)}</p></div>`; return; }
    const maxDays = Math.max(...idx.map((y) => y.flood_point_days || 0), 1);
    const cur = S.replay ? S.replay.doc.year : null;
    el.innerHTML = `<h2>${esc(t.replay_title)}</h2>
      <p class="muted small">${esc(t.replay_intro)}</p>
      <div class="years">${idx.slice().reverse().map((y) => { const f = (y.flood_point_days || 0) / maxDays; return `<button data-y="${y.year}" class="${cur === y.year ? "on" : ""}"><b>${y.year}</b><span class="meter"><i style="width:${Math.max(6, Math.round(f * 100))}%;background:${f > 0.6 ? LV_COL[3] : f > 0.3 ? LV_COL[2] : LV_COL[1]}"></i></span></button>`; }).join("")}</div>
      <p class="small muted">${esc(t.replay_meter)}</p>
      <div id="yearInfo"></div>`;
    el.querySelectorAll("[data-y]").forEach((b) => b.addEventListener("click", () => loadYear(+b.dataset.y)));
    if (S.replay) renderYearInfo();
  }
  function renderYearInfo() {
    const R = S.replay, el = $("yearInfo"); if (!R || !el) return;
    const doc = R.doc, t = T();
    el.innerHTML = `<div class="cards"><div class="card"><b class="big">${fmtDate(doc.worst_day)}</b><span>worst day of ${doc.year}</span></div>
      <div class="card"><b class="big">${doc.worst_count}</b><span>river points above normal that day</span></div></div>
      <div class="chart"><canvas id="ychart"></canvas></div>
      <div class="btns"><button class="btn" id="jump">${esc(t.worst_jump)}</button><button class="btn ghost" id="exitReplay">${esc(t.back_today)}</button></div>`;
    $("jump").addEventListener("click", () => { stopPlay(); setDay(R.worst); });
    $("exitReplay").addEventListener("click", exitReplay);
    if (S.charts.y) S.charts.y.destroy();
    if (!window.Chart) return;
    S.charts.y = new Chart($("ychart"), {
      type: "bar", data: { labels: doc.above_normal_by_day.map((_, i) => fmtDate(addDays(doc.start, i))), datasets: [{ data: doc.above_normal_by_day, backgroundColor: LV_COL[2], borderWidth: 0, barPercentage: 1, categoryPercentage: 1 }] },
      options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0 } }, y: { title: { display: true, text: "points above normal" } } },
        onClick: (_, els) => { if (els.length) { stopPlay(); setDay(els[0].index); } } },
      plugins: [{ id: "playhead", afterDraw(ch) {
        if (!S.replay) return;
        const x = ch.scales.x.getPixelForValue(S.replay.day), a = ch.chartArea, g = ch.ctx;
        g.save(); g.fillStyle = theme().ink; g.fillRect(x - 1, a.top, 2, a.bottom - a.top); g.restore();
      } }],
    });
  }

  async function loadYear(y) {
    stopLapse();
    stopPlay();
    document.querySelectorAll("#tab-replay [data-y]").forEach((b) => b.classList.toggle("on", +b.dataset.y === y));
    const doc = await tryJSON(`data/history/${y}.json`);
    if (!doc) { toast(esc(T().replay_fail)); return; }
    const qmax = {};
    Object.entries(doc.flows3 || {}).forEach(([id, a]) => { let m = 1; for (const v of a) if (v > m) m = v; qmax[id] = m; });
    const worst = Math.max(0, Math.min(doc.days - 1, Math.round((Date.parse(doc.worst_day) - Date.parse(doc.start)) / 864e5)));
    S.replay = { doc, day: 0, t: 0, playing: false, raf: 0, last: 0, qmax, lgaLv: {}, worst, satDay: -9 };
    S.mode = "flood"; syncModeButtons(); document.body.dataset.mode = "flood";
    renderYearInfo();
    showBar("replay");
    $("rbSlider").max = doc.days - 1;
    setDay(Math.max(0, worst - 45), true);
    stateLayer && stateLayer.setStyle(stateStyle); recolorPoints(true); renderLegend();
    if (fx) fx.snap();
  }

  // LGAs fade in and out as the flood reaches or leaves them. Only the few that change are touched.
  const lgaAnim = new Map(); let lgaAnimTimer = null;
  function fadeLga(lid, from, to) {
    const layer = lgaLayers[lid]; if (!layer) return;
    const cur = lgaAnim.get(lid);
    lgaAnim.set(lid, { layer, op: cur ? cur.op : (from ? 0.42 : 0), to, col: LV_COL[to || from || 1] });
    if (!lgaAnimTimer) lgaAnimTimer = setInterval(stepLgaAnim, 85);
  }
  function stepLgaAnim() {
    lgaAnim.forEach((a, lid) => {
      const tgt = a.to ? 0.42 : 0;
      a.op += (tgt - a.op) * 0.42;
      if (Math.abs(tgt - a.op) < 0.035 || !S.replay) { a.layer.setStyle(lgaStyle(a.layer.feature)); lgaAnim.delete(lid); }
      else a.layer.setStyle({ color: a.col, weight: 1.1, opacity: Math.min(0.95, a.op * 2), fillColor: a.col, fillOpacity: a.op });
    });
    if (!lgaAnim.size) { clearInterval(lgaAnimTimer); lgaAnimTimer = null; }
  }

  function setDay(i, hard) {
    const R = S.replay; if (!R) return;
    const doc = R.doc;
    R.day = Math.max(0, Math.min(doc.days - 1, Math.round(i)));
    if (!R.playing) R.t = R.day;
    const date = addDays(doc.start, R.day);
    $("rbSlider").value = R.day;
    $("rbDate").textContent = fmtDate(date, { day: "numeric", month: "long", year: "numeric" });
    // community (LGA) levels for this day: the highest level among the river points linked to each LGA
    const changed = []; let affected = 0;
    const links = S.data.lgaPts || {};
    for (const lid in links) {
      let m = 0;
      for (const id of links[lid]) { const s = doc.levels[id]; const c = s ? s.charCodeAt(R.day) - 48 : -1; if (c > m && c <= 3) m = c; }
      if (m) affected++;
      const was = R.lgaLv[lid] || 0;
      if (was !== m) { R.lgaLv[lid] = m; changed.push([lid, was, m]); }
    }
    $("rbCount").innerHTML = T().replay_count(doc.above_normal_by_day[R.day] || 0, affected);
    recolorPoints();
    if (hard) { lgaAnim.clear(); lgaLayer && lgaLayer.setStyle(lgaStyle); }
    else if (changed.length > 140 || reduceMq.matches) changed.forEach(([lid]) => { lgaAnim.delete(lid); lgaLayers[lid] && lgaLayers[lid].setStyle(lgaStyle(lgaLayers[lid].feature)); });
    else changed.forEach(([lid, was, m]) => fadeLga(lid, was, m));
    // satellite underlay: every day when scrubbing, every 4th day while playing (tiles need time to arrive)
    if ($("rbSat").checked && (!R.playing || Math.abs(R.day - R.satDay) >= 4)) showSat(date);
    fxSync(); drawRibbon();
    if (S.charts.y && document.body.dataset.sheet !== "min" && $("tab-replay").classList.contains("on")) S.charts.y.draw();
  }
  function showSat(date) {
    const old = satLayer;
    if (S.replay) S.replay.satDay = S.replay.day;
    satLayer = L.tileLayer(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
      { maxNativeZoom: 9, maxZoom: 18, opacity: 0.95, attribution: "NASA GIBS / MODIS Terra" }).addTo(map);
    if (old) setTimeout(() => map.removeLayer(old), 600);   // keep the previous picture until the new one has drawn
    document.body.classList.add("sat-on");
  }
  function hideSat() {
    map.eachLayer((l) => { if (l._url && l._url.includes("CorrectedReflectance")) map.removeLayer(l); });
    satLayer = null; document.body.classList.remove("sat-on");
  }
  // Playback runs on requestAnimationFrame with a fractional day, so rivers swell and the playhead
  // glides between days instead of jumping.
  function togglePlay() {
    if (S.lapse) return toggleLapse();
    const R = S.replay; if (!R) return;
    if (R.playing) return stopPlay();
    if (R.day >= R.doc.days - 1) setDay(0, true);
    R.playing = true; R.t = R.day; R.last = 0; setPlayIcon(true);
    const loop = (ts) => {
      if (S.replay !== R || !R.playing) return;
      if (!R.last) R.last = ts;
      const dt = Math.min(250, ts - R.last) / 1000; R.last = ts;
      R.t = Math.min(R.doc.days - 1, R.t + dt * R.doc.days / speed().year);
      const d = Math.floor(R.t);
      if (d !== R.day) setDay(d); else { fxSync(); drawRibbon(); }
      if (R.t >= R.doc.days - 1) return stopPlay();
      R.raf = requestAnimationFrame(loop);
    };
    R.raf = requestAnimationFrame(loop);
  }
  function stopPlay() {
    const R = S.replay;
    if (R && R.playing) { R.playing = false; cancelAnimationFrame(R.raf); R.t = R.day; drawRibbon(); }
    if (!S.lapse) setPlayIcon(false);
  }
  function exitReplay() {
    if (!S.replay) return;
    stopPlay(); S.replay = null; lgaAnim.clear(); hideBar();
    hideSat(); $("rbSat").checked = false;
    document.querySelectorAll("#tab-replay [data-y]").forEach((b) => b.classList.remove("on"));
    restyle(); if (fx) fx.snap();
    $("yearInfo") && ($("yearInfo").innerHTML = "");
  }

  // ---------- Model tab ----------
  function renderModelTab() {
    const m = S.data.latest && S.data.latest.model;
    const st = S.data.status;
    let html = `<h2>How the model works</h2>
      <p>Every day, without anyone pressing a button, a GitHub Actions job downloads fresh river and weather data, runs the model and republishes this site.</p>
      <ol class="small">
        <li><b>Physics forecast.</b> 30-day river-flow forecasts from the Copernicus GloFAS hydrological model for ${(S.data.points || []).length} points along Nigeria's rivers.</li>
        <li><b>Local danger levels.</b> Each point is compared with its own daily record since 2012: above the 90th percentile is <i>Watch</i>, 98th <i>Warning</i>, 99.7th <i>Severe</i>.</li>
        <li><b>Machine learning.</b> A gradient-boosted tree model, trained on every day of river flow since 2012 plus rainfall anomalies, learns how rivers behave before they flood and gives the chance of each river rising above its Watch or Warning level within 3, 7 and 14 days. It is retrained every month as new data arrives.</li>
        <li><b>Season monitor.</b> Rain and temperature for every state against the same time of year: drought, wet spells, heat stress and the onset of the rains for planting.</li>
      </ol>`;
    if (m && m.leads) {
      html += `<h3>Tested on years it never saw (${esc(m.test_years)})</h3>
        <p class="small muted">Trained on ${esc(m.train_years)}, then scored on later years that include the 2022 and 2024 floods. "Baseline" assumes the river stays as it is today. AUC: 1.0 is perfect, 0.5 is guessing.</p>
        <table class="metrics"><tr><th>Lead</th><th>Target</th><th>AUC</th><th>Baseline</th><th>Hit rate</th><th>False alarms</th></tr>` +
        Object.entries(m.leads).flatMap(([lead, d]) => Object.entries(d).map(([tg, v]) => `<tr><td>${lead} days</td><td>${esc(tg)}</td><td><b>${v.auc ?? "–"}</b></td><td>${v.baseline.auc ?? "–"}</td><td>${Math.round(100 * v.hit_rate)}%</td><td>${Math.round(100 * v.false_alarm_ratio)}%</td></tr>`)).join("") +
        `</table><p class="small muted">Last trained ${esc((m.trained || "").slice(0, 10))} on ${m.points} river points.</p>`;
    } else {
      html += `<div class="warmup">The model trains automatically once at least six years of history are downloaded for the river network. Until then, alerts use the physics forecast and local danger levels only.</div>`;
    }
    if (st && st.last) {
      const l = st.last;
      html += `<h3>Pipeline status</h3><dl class="kv"><dt>Last run</dt><dd>${esc((l.finished || "").replace("T", " "))} UTC</dd><dt>River points</dt><dd>${l.points}</dd>
        <dt>History downloaded</dt><dd>${l.backfill ? (l.backfill.complete_years_flood || 0).toFixed(1) : 0} of ${new Date().getFullYear() - 2011} years</dd>
        <dt>Runs logged</dt><dd>${(st.runs || []).length}</dd></dl>
        <p class="small"><a href="https://github.com/geraldnzeribe/naijafloodalert/actions" target="_blank" rel="noopener">See every automated run on GitHub →</a></p>`;
    }
    $("tab-model").innerHTML = html;
  }

  function renderAbout() {
    const t = T();
    $("tab-about").innerHTML = `<h2>About NaijaFloodAlert</h2>
      <p>An open-source, automated flood, rain and season monitor for Nigeria, built so that any community — not just big cities — can see what its rivers and rains are doing, in its own language.</p>
      <h3>Data</h3><ul class="small">
        <li>River flow: Copernicus GloFAS (via Open-Meteo), CC BY 4.0</li>
        <li>Rain &amp; temperature: ERA5 reanalysis and weather forecasts (via Open-Meteo), CC BY 4.0</li>
        <li>Satellite imagery: NASA GIBS / MODIS; Esri World Imagery</li>
        <li>Maps: © OpenStreetMap contributors, OpenTopoMap; boundaries: geoBoundaries (CC BY 4.0); river lines: Natural Earth (public domain), simplified — they show the main channels only</li></ul>
      <h3>Languages</h3><p class="small">English, Nigerian Pidgin, Hausa, Yorùbá and Igbo. Hausa, Yorùbá and Igbo texts are first drafts awaiting review by native speakers — corrections are welcome on GitHub.</p>
      <h3>Important</h3><p class="small">This is a research and public-information tool. It does not replace official warnings from NIHSA, NiMet, NEMA or State Emergency Management Agencies. In an emergency call <b>112</b>.</p>
      <p class="small">Built by Nzeribe Gerald Ifeanyichukwu · <a href="https://github.com/geraldnzeribe/naijafloodalert" target="_blank" rel="noopener">Source code (MIT)</a></p>`;
  }

  // ---------- search ----------
  let searchTimer;
  function initSearch() {
    const q = $("q"), res = $("qres");
    q.addEventListener("input", () => {
      clearTimeout(searchTimer);
      const s = q.value.trim();
      if (s.length < 2) { res.hidden = true; return; }
      const local = (S.data.lgas || []).map((f) => f.properties).filter((p) => p.name.toLowerCase().includes(s.toLowerCase()) || p.state.toLowerCase() === s.toLowerCase()).slice(0, 5)
        .map((p) => ({ name: p.name, sub: `LGA · ${p.state}`, lat: p.lat, lon: p.lon, lga: p }));
      showResults(local);
      searchTimer = setTimeout(async () => {
        try {
          const r = await getJSON(`https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=ng&limit=6&accept-language=en&q=${encodeURIComponent(s)}`);
          showResults(local.concat(r.map((x) => ({ name: x.name || x.display_name.split(",")[0], sub: x.display_name.split(",").slice(1, 4).join(","), lat: +x.lat, lon: +x.lon }))));
        } catch (e) { /* offline */ }
      }, 450);
    });
    q.addEventListener("keydown", (e) => { if (e.key === "Enter") { const f = res.querySelector("li"); if (f) f.click(); } if (e.key === "Escape") res.hidden = true; });
    document.addEventListener("click", (e) => { if (!e.target.closest(".search")) res.hidden = true; });
    function showResults(items) {
      res.innerHTML = items.map((it, i) => `<li data-i="${i}">${esc(it.name)}<small>${esc(it.sub)}</small></li>`).join("");
      res.hidden = !items.length;
      res.querySelectorAll("li").forEach((li) => li.addEventListener("click", () => {
        const it = items[+li.dataset.i];
        res.hidden = true; q.value = it.name;
        map.flyTo([it.lat, it.lon], it.lga ? 11 : 14, { duration: 0.9 });
        setTimeout(() => selectLocation(it.lat, it.lon, it.lga || null), 300);
      }));
    }
  }

  // ---------- chrome ----------
  function switchTab(name) {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
    document.querySelectorAll(".tab").forEach((s) => s.classList.toggle("on", s.id === "tab-" + name));
    if (name === "replay") renderReplayTab();
    if (name === "model") renderModelTab();
    if (name === "about") renderAbout();
  }
  function chartTheme() {
    if (!window.Chart) return;
    const th = theme();
    Chart.defaults.color = th.muted; Chart.defaults.borderColor = th.line;
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily; Chart.defaults.font.size = 11;
  }
  function syncModeButtons() { document.querySelectorAll("#modes button").forEach((b) => b.classList.toggle("on", b.dataset.mode === S.mode)); }
  function applyLang() {
    const t = T();
    document.documentElement.lang = S.lang === "pcm" ? "en" : S.lang;
    $("tagline").textContent = t.tagline;
    $("q").placeholder = t.search;
    ["flood", "season", "plant", "heat"].forEach((m) => { $("m_" + m).textContent = t["mode_" + m]; });
    ["today", "replay", "model", "about"].forEach((m) => { $("t_" + m).textContent = t["tab_" + m]; });
    liveBadge(); renderLegend();
    if (!$("replaybar").hidden) { $("rbWorst").textContent = t.worst_btn; $("rbSatText").textContent = t.satellite; if (S.replay) setDay(S.replay.day); }
    const active = document.querySelector(".tabs button.on").dataset.tab;
    if (active === "today") renderToday(); else switchTab(active);
  }

  async function init() {
    S.lang = store.get("nfa_lang", "en");
    S.view = store.get("nfa_view", "public");
    if (S.view === "farmer") S.mode = "plant";
    document.body.dataset.mode = S.mode;
    const shortLang = MOBILE();
    $("lang").innerHTML = I.langs.map((k) => `<option value="${k}" title="${I.L[k]._name}">${shortLang ? k.toUpperCase() : I.L[k]._name}</option>`).join("");
    $("lang").value = S.lang;
    $("lang").addEventListener("change", (e) => { S.lang = e.target.value; store.set("nfa_lang", S.lang); applyLang(); });
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
      switchTab(b.dataset.tab); if (b.dataset.tab === "today") renderToday();
      if (MOBILE() && !$("panel")._dragged && document.body.dataset.sheet === "min") sheetState("half");
    }));
    document.querySelectorAll("#modes button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
    initSheet();
    $("play").addEventListener("click", togglePlay);
    $("rbClose").addEventListener("click", () => { if (S.lapse) stopLapse(); else if (S.replay) exitReplay(); });
    $("rbSlider").addEventListener("input", (e) => { if (S.lapse) { clearTimeout(S.lapse.timer); S.lapse.timer = null; setPlayIcon(false); return lapseFrame(+e.target.value); } stopPlay(); setDay(+e.target.value); });
    $("rbSat").addEventListener("change", (e) => { if (e.target.checked && S.replay) showSat(addDays(S.replay.doc.start, S.replay.day)); else hideSat(); });
    $("rbSpeed").addEventListener("click", () => { speedIx = (speedIx + 1) % SPEEDS.length; $("rbSpeed").textContent = speed().label; $("rbSpeed").setAttribute("aria-label", `${T().speed} ${speed().label}`); });
    $("rbWorst").addEventListener("click", () => { if (S.replay) { stopPlay(); setDay(S.replay.worst); } });
    window.addEventListener("resize", () => { if (!$("replaybar").hidden) sizeRibbon(); });
    const onTheme = () => { themeCache = null; chartTheme(); if (maskLayer) maskLayer.setStyle(maskStyle()); restyle(); drawRibbon(); };
    darkMq.addEventListener && darkMq.addEventListener("change", onTheme);
    chartTheme();
    initMap();
    initSearch();
    await loadData();
    drawLayers();
    applyLang();
    const hash = new URLSearchParams(location.hash.slice(1));
    if (hash.get("lat")) selectLocation(+hash.get("lat"), +hash.get("lon"), null, null, true);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  init();
})();
