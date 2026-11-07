(function () {
  "use strict";
  const I = window.NFA_I18N;
  const LV_COL = ["#2e9e5b", "#f2b705", "#ef6c00", "#d32f2f"];
  const SEASON_COL = { drought: "#8d4a1f", dry: "#d9a441", normal: "#7cb342", wet: "#29a3e0", very_wet: "#1452a8", dry_season: "#bfb39a", unknown: "#b0bec5" };
  const PLANT_COL = { dry_season: "#bfb39a", waiting: "#d9a441", wait_confirm: "#f2b705", plant: "#2e9e5b", harvest: "#8d6e63" };
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
  let map, bases, lgaLayer, stateLayer, pointLayer, satLayer, spotMarker;
  function initMap() {
    map = L.map("map", { zoomControl: true, minZoom: 6, maxZoom: 18, maxBounds: NG_BOUNDS.pad(0.15), maxBoundsViscosity: 0.8, preferCanvas: true });
    map.fitBounds(NG_BOUNDS, { paddingBottomRight: window.innerWidth > 860 ? [430, 0] : [0, 0] });
    bases = {
      streets: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap contributors" }),
      topo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", { maxZoom: 17, attribution: "© OpenStreetMap contributors, SRTM · © OpenTopoMap (CC-BY-SA)" }),
      sat: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" }),
    };
    bases.streets.addTo(map);
    map.createPane("lgas"); map.getPane("lgas").style.zIndex = 410;
    map.createPane("states"); map.getPane("states").style.zIndex = 420;
    map.createPane("rivers"); map.getPane("rivers").style.zIndex = 450;
    document.querySelectorAll("#bases button").forEach((b) => b.addEventListener("click", () => {
      document.querySelectorAll("#bases button").forEach((x) => x.classList.toggle("on", x === b));
      Object.values(bases).forEach((l) => map.removeLayer(l));
      bases[b.dataset.base].addTo(map);
    }));
    map.on("click", (e) => { if (!e.originalEvent._handled) selectLocation(e.latlng.lat, e.latlng.lng); });
  }

  function lgaStyle(f) {
    const p = f.properties;
    const zoomed = map.getZoom() >= 9;
    if (S.mode === "flood") {
      const lv = replayLgaLevel(p.id) ?? ((S.data.latest && S.data.latest.lgas && S.data.latest.lgas[p.id]) || [0])[0];
      return { pane: "lgas", color: lv ? LV_COL[lv] : "#5b7083", weight: lv ? 1.2 : 0.5, opacity: lv ? 0.9 : (zoomed ? 0.5 : 0.25), fillColor: LV_COL[lv], fillOpacity: lv ? 0.32 : 0.02 };
    }
    return { pane: "lgas", color: "#5b7083", weight: 0.4, opacity: zoomed ? 0.5 : 0.2, fillOpacity: 0 };
  }
  function stateStyle(f) {
    const st = S.data.latest && S.data.latest.states ? S.data.latest.states[f.properties.id] : null;
    const base = { pane: "states", color: "#0a2540", weight: 1.3, opacity: 0.55, fillOpacity: 0 };
    if (!st || S.mode === "flood") return base;
    if (S.mode === "season") return { ...base, fillColor: SEASON_COL[st.status] || SEASON_COL.unknown, fillOpacity: 0.45 };
    if (S.mode === "plant") return { ...base, fillColor: PLANT_COL[st.plant] || "#b0bec5", fillOpacity: 0.45 };
    if (S.mode === "heat") {
      const a = st.tmax_anom ?? 0;
      const c = a >= 3 ? "#b71c1c" : a >= 2 ? "#e53935" : a >= 1 ? "#fb8c00" : a > -1 ? "#ffe0b2" : "#64b5f6";
      return { ...base, fillColor: c, fillOpacity: 0.45 };
    }
    return base;
  }

  function drawLayers() {
    if (lgaLayer) map.removeLayer(lgaLayer);
    if (stateLayer) map.removeLayer(stateLayer);
    lgaLayer = L.geoJSON({ type: "FeatureCollection", features: S.data.lgas || [] }, {
      style: lgaStyle,
      onEachFeature: (f, layer) => {
        layer.bindTooltip(() => `${esc(f.properties.name)}, ${esc(f.properties.state)}`, { sticky: true, className: "nfa" });
        layer.on("click", (e) => { e.originalEvent._handled = true; selectLocation(e.latlng.lat, e.latlng.lng, f.properties); });
      },
    }).addTo(map);
    stateLayer = L.geoJSON({ type: "FeatureCollection", features: S.data.states || [] }, { style: stateStyle, interactive: false }).addTo(map);
    drawPoints();
    map.on("zoomend", () => lgaLayer && lgaLayer.setStyle(lgaStyle));
  }

  function pointLevel(p) {
    if (S.replay && S.replay.doc) {
      const s = S.replay.doc.levels[p.id];
      const c = s ? s[S.replay.day] : ".";
      return c && c !== "." ? +c : null;
    }
    const r = latestPoint(p.id);
    return r ? (r.level ?? 0) : null;
  }
  function drawPoints() {
    if (pointLayer) map.removeLayer(pointLayer);
    pointLayer = L.layerGroup().addTo(map);
    (S.data.points || []).forEach((p) => {
      const lv = pointLevel(p);
      const m = L.circleMarker([p.lat, p.lon], {
        pane: "rivers", radius: lv >= 2 ? 8 : 6, weight: 2, color: "#fff",
        fillColor: lv == null ? "#90a4ae" : LV_COL[lv], fillOpacity: 1,
      });
      m.bindTooltip(`${esc(p.river)} · ${esc(p.name)}`, { className: "nfa" });
      m.on("click", (e) => { L.DomEvent.stopPropagation(e); selectLocation(p.lat, p.lon, null, p.id); });
      m.addTo(pointLayer);
      p._m = m;
    });
  }
  function recolorPoints() {
    (S.data.points || []).forEach((p) => {
      if (!p._m) return;
      const lv = pointLevel(p);
      p._m.setStyle({ fillColor: lv == null ? "#90a4ae" : LV_COL[lv], radius: lv >= 2 ? 8 : 6 });
    });
  }
  const latestPoint = (id) => (S.data.latestById || {})[id];

  // ---------- legend ----------
  function renderLegend() {
    const t = T();
    let html = "";
    if (S.mode === "flood") html = `<b>${esc(t.mode_flood)}</b>` + t.lvl.map((n, i) => `<div class="row"><span class="sw" style="background:${LV_COL[i]}"></span>${esc(n)}</div>`).join("") + `<div class="row muted small">● river gauge point · shaded = community (LGA)</div>`;
    if (S.mode === "season") html = `<b>${esc(t.mode_season)}</b>` + Object.keys(SEASON_COL).filter((k) => k !== "unknown").map((k) => `<div class="row"><span class="sw" style="background:${SEASON_COL[k]}"></span>${esc(t.season[k])}</div>`).join("");
    if (S.mode === "plant") html = `<b>${esc(t.mode_plant)}</b>` + Object.keys(PLANT_COL).map((k) => `<div class="row"><span class="sw" style="background:${PLANT_COL[k]}"></span>${esc(t.plant[k])}</div>`).join("");
    if (S.mode === "heat") html = `<b>${esc(t.mode_heat)}</b>` + [["#b71c1c", "+3 °C or more"], ["#e53935", "+2 to +3 °C"], ["#fb8c00", "+1 to +2 °C"], ["#ffe0b2", "near normal"], ["#64b5f6", "cooler than normal"]].map(([c, n]) => `<div class="row"><span class="sw" style="background:${c}"></span>${n}</div>`).join("") + `<div class="row muted small">7-day max temperature vs normal</div>`;
    $("legend").innerHTML = html;
  }

  // ---------- data ----------
  async function loadData() {
    const [latest, points, lgas, states, status, hindex] = await Promise.all([
      tryJSON("data/latest.json"), tryJSON("data/points.json"), tryJSON("data/geo/lgas.geojson"),
      tryJSON("data/geo/states.geojson"), tryJSON("data/status.json"), tryJSON("data/history/index.json"),
    ]);
    S.data = { latest, points: points || [], lgas: lgas ? lgas.features : [], states: states ? states.features : [], status, hindex: hindex || [] };
    S.data.latestById = {};
    ((latest && latest.points) || []).forEach((p) => { S.data.latestById[p.id] = p; });
    S.data.pointById = {};
    S.data.points.forEach((p) => { S.data.pointById[p.id] = p; });
    S.data.stateByName = {};
    S.data.states.forEach((f) => { S.data.stateByName[f.properties.name] = f.properties; });
    const links = await tryJSON("data/lga_links.json");
    S.data.links = links || {};
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
    S.mode = v === "farmer" ? "plant" : "flood"; syncModeButtons();
    lgaLayer && lgaLayer.setStyle(lgaStyle); stateLayer && stateLayer.setStyle(stateStyle); renderLegend();
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
    if (!lt || !lt.points || !lt.points.some((p) => p.level != null)) {
      const prog = st && st.backfill ? Math.round(100 * (st.backfill.complete_years_flood || 0) / (new Date().getFullYear() - 2011)) : 0;
      html += `<div class="warmup"><b>Warming up.</b> The automatic pipeline is building the national river network and downloading history (${prog}% done). The map fills in by itself over the first runs — no action needed.</div>`;
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
        Object.entries(lt.states).sort((a, b) => a[1].name.localeCompare(b[1].name)).map(([sid, s]) => `<li data-state="${sid}"><span class="nm">${esc(s.name)}<small>${esc(t.plant[s.plant] || "")}</small></span><span class="chip" style="background:${SEASON_COL[s.status] || "#b0bec5"}">${esc(t.season[s.status] || s.status)}</span></li>`).join("") + `</ul>`;
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
    html += `<div class="cards">${["plant", "wait_confirm", "waiting", "dry_season", "harvest"].filter((k) => counts[k]).map((k) => `<div class="card"><b class="big" style="color:${PLANT_COL[k]}">${counts[k]}</b><span>${esc(t.plant[k])}</span></div>`).join("")}</div>`;
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
      const pts = ids.map((id) => latestPoint(id)).filter(Boolean).sort((a, b) => (b.level || 0) - (a.level || 0));
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
      <div class="cards"><div class="card"><b class="big" style="color:${LV_COL[3]}">${byLevel[3]}</b><span>${esc(t.lvl[3])}</span></div><div class="card"><b class="big" style="color:${LV_COL[2]}">${byLevel[2]}</b><span>${esc(t.lvl[2])}</span></div>
      <div class="card"><b class="big" style="color:${LV_COL[1]}">${byLevel[1]}</b><span>${esc(t.lvl[1])}</span></div><div class="card"><b class="big">${Object.keys(byState).length}</b><span>states affected</span></div></div>
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
    spotMarker = L.circleMarker([lat, lon], { radius: 7, color: "#0a2540", weight: 3, fillColor: "#fff", fillOpacity: 1 }).addTo(map);
    switchTab("today");
    renderPlace(S.sel);
    if (window.innerWidth <= 860) $("panel").classList.add("full");
  }

  function placeAssessment(sel) {
    const lt = S.data.latest || {};
    const lv = ((lt.lgas || {})[sel.lga.id] || [0, 0]);
    const ids = ((S.data.links || {})[sel.lga.id] || {}).points || [];
    let main = sel.pointId ? latestPoint(sel.pointId) : null;
    const cands = ids.map((id) => latestPoint(id)).filter(Boolean);
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
      html += `<h3>Farm outlook · ${esc(sel.lga.state)}</h3><p><span class="chip" style="background:${PLANT_COL[s.plant] || "#b0bec5"}">${esc(t.plant[s.plant] || "")}</span></p>
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
          <dt>Status</dt><dd><span class="chip" style="background:${SEASON_COL[s.status]}">${esc(t.season[s.status] || s.status)}</span></dd>
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
      { label: "max", data: r.qmax, borderWidth: 0, pointRadius: 0, backgroundColor: "rgba(11,116,222,.14)", fill: "+1" },
      { label: "min", data: r.qmin, borderWidth: 0, pointRadius: 0, fill: false },
      { label: "Flow (m³/s)", data: r.q, borderColor: "#0b74de", borderWidth: 2.4, pointRadius: 0, tension: 0.25, segment: { borderDash: (ctx) => (ctx.p0DataIndex < ti ? [3, 3] : undefined) } },
    ];
    if (r.th) ds.push(line(r.th.p90, LV_COL[1], T().lvl[1]), line(r.th.p98, LV_COL[2], T().lvl[2]), line(r.th.p997, LV_COL[3], T().lvl[3]));
    S.charts[canvasId] = new Chart(c, {
      type: "line", data: { labels, datasets: ds },
      options: { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: "index", intersect: false },
        plugins: { legend: { labels: { boxWidth: 10, filter: (i) => !/^(max|min)$/.test(i.text) } } },
        scales: { x: { ticks: { maxTicksLimit: 7 } }, y: { title: { display: true, text: "m³/s" } } } },
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
      L.circleMarker([blat, blon], { radius: 5, color: "#0b74de", weight: 2, fillOpacity: 0.6 }).addTo(map).bindTooltip("Analysed river cell");
    } catch (e) {
      out.innerHTML = `<p class="muted small">Could not reach the forecast service (${esc(e.message)}). Try again in a moment.</p>`;
    }
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
    S.lapse = { kind, dates: lapseDates(kind), i: 0, layer: null, timer: null };
    map.flyTo([lat, lon], Math.min(Math.max(map.getZoom(), 8), 9), { duration: 0.8 });
    $("replaybar").hidden = false; document.body.classList.add("replaying", "lapsing");
    $("panel").classList.remove("full");
    $("rbSlider").max = S.lapse.dates.length - 1; $("rbSat").parentElement.style.display = "none";
    $("legend").innerHTML = kind === "ndvi"
      ? `<b>Vegetation (NDVI)</b><div class="row"><span class="sw" style="background:linear-gradient(90deg,#a0522d,#e8d48a,#9acd32,#006400);width:120px"></span></div><div class="row small muted">brown = dry · green = growing</div><button class="btn ghost" id="lapseStop" style="margin-top:6px">Close time-lapse</button>`
      : `<b>Flood water (MODIS)</b><div class="row small muted">Shaded pixels = surface water detected beyond normal</div><button class="btn ghost" id="lapseStop" style="margin-top:6px">Close time-lapse</button>`;
    $("lapseStop").addEventListener("click", stopLapse);
    lapseFrame(S.lapse.dates.length - 1);
  }
  function lapseFrame(i) {
    const L2 = S.lapse; if (!L2) return;
    L2.i = Math.max(0, Math.min(L2.dates.length - 1, i));
    const date = L2.dates[L2.i];
    $("rbSlider").value = L2.i;
    $("rbDate").textContent = fmtDate(date, { day: "numeric", month: "long", year: "numeric" });
    $("rbCount").textContent = L2.kind === "ndvi" ? "8-day vegetation composite" : "2-day flood composite";
    const next = L.tileLayer(lapseUrl(L2.kind, date), { maxNativeZoom: 9, maxZoom: 18, opacity: 0, attribution: "NASA GIBS / MODIS" }).addTo(map);
    next.once("load", () => { next.setOpacity(L2.kind === "ndvi" ? 0.85 : 1); if (L2.layer && L2.layer !== next) map.removeLayer(L2.layer); L2.layer = next; });
    setTimeout(() => { if (S.lapse === L2 && next.options.opacity === 0) { next.setOpacity(L2.kind === "ndvi" ? 0.85 : 1); if (L2.layer && L2.layer !== next) map.removeLayer(L2.layer); L2.layer = next; } }, 2500);
  }
  function stopLapse() {
    if (!S.lapse) return;
    clearTimeout(S.lapse.timer);
    map.eachLayer((l) => { if (l._url && l._url.includes("gibs.earthdata") && l !== satLayer) map.removeLayer(l); });
    S.lapse = null; $("replaybar").hidden = true; document.body.classList.remove("replaying", "lapsing");
    $("rbSat").parentElement.style.display = ""; $("play").textContent = "▶"; renderLegend();
  }

  // ---------- Replay tab ----------
  function renderReplayTab() {
    const el = $("tab-replay");
    const idx = S.data.hindex || [];
    if (!idx.length) { el.innerHTML = `<h2>Replay past floods</h2><p class="muted">History is still being downloaded by the automatic pipeline. Recent years appear first, then older ones back to 2012.</p>`; return; }
    const maxDays = Math.max(...idx.map((y) => y.flood_point_days || 0), 1);
    el.innerHTML = `<h2>Replay past floods</h2>
      <p class="muted small">Pick a year and press play to watch river levels across Nigeria day by day. Colours show each river against its own normal. Turn on satellite view to see the real ground for that date (NASA MODIS, cloud permitting).</p>
      <div class="years">${idx.slice().reverse().map((y) => `<button data-y="${y.year}">${y.year}<span class="dot" style="background:${y.flood_point_days / maxDays > 0.6 ? LV_COL[3] : y.flood_point_days / maxDays > 0.3 ? LV_COL[2] : LV_COL[1]}"></span></button>`).join("")}</div>
      <div id="yearInfo"></div>`;
    el.querySelectorAll("[data-y]").forEach((b) => b.addEventListener("click", () => loadYear(+b.dataset.y)));
  }

  async function loadYear(y) {
    stopLapse();
    stopPlay();
    document.querySelectorAll("#tab-replay [data-y]").forEach((b) => b.classList.toggle("on", +b.dataset.y === y));
    const doc = await tryJSON(`data/history/${y}.json`);
    if (!doc) return;
    S.replay = { doc, day: 0, timer: null };
    S.mode = "flood"; syncModeButtons();
    const worst = Math.round((Date.parse(doc.worst_day) - Date.parse(doc.start)) / 864e5);
    $("yearInfo").innerHTML = `<div class="cards"><div class="card"><b class="big">${fmtDate(doc.worst_day)}</b><span>worst day of ${y}</span></div>
      <div class="card"><b class="big">${doc.worst_count}</b><span>river points above normal that day</span></div></div>
      <div class="chart"><canvas id="ychart"></canvas></div>
      <div class="btns"><button class="btn" id="jump">Jump to worst day</button><button class="btn ghost" id="exitReplay">Back to today</button></div>`;
    $("jump").addEventListener("click", () => setDay(worst));
    $("exitReplay").addEventListener("click", exitReplay);
    if (S.charts.y) S.charts.y.destroy();
    S.charts.y = new Chart($("ychart"), {
      type: "bar", data: { labels: doc.above_normal_by_day.map((_, i) => fmtDate(addDays(doc.start, i))), datasets: [{ data: doc.above_normal_by_day, backgroundColor: "#ef6c00", borderWidth: 0, barPercentage: 1, categoryPercentage: 1 }] },
      options: { responsive: true, maintainAspectRatio: false, animation: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { maxTicksLimit: 6 } }, y: { title: { display: true, text: "points above normal" } } },
        onClick: (_, els) => { if (els.length) setDay(els[0].index); } },
    });
    $("replaybar").hidden = false;
    document.body.classList.add("replaying");
    $("rbSlider").max = doc.days - 1;
    setDay(Math.max(0, worst - 30));
  }

  function setDay(i) {
    if (!S.replay) return;
    const doc = S.replay.doc;
    S.replay.day = Math.max(0, Math.min(doc.days - 1, i));
    const date = addDays(doc.start, S.replay.day);
    $("rbSlider").value = S.replay.day;
    $("rbDate").textContent = fmtDate(date, { weekday: "short", day: "numeric", month: "long", year: "numeric" });
    $("rbCount").textContent = `${doc.above_normal_by_day[S.replay.day] || 0} river points above normal`;
    recolorPoints();
    if (lgaLayer) lgaLayer.setStyle(lgaStyle);
    if ($("rbSat").checked) showSat(date);
  }
  function replayLgaLevel(lid) {
    if (!S.replay) return null;
    const ids = ((S.data.links || {})[lid] || {}).points || [];
    let m = 0;
    ids.forEach((id) => { const s = S.replay.doc.levels[id]; const c = s ? s[S.replay.day] : "."; if (c && c !== ".") m = Math.max(m, +c); });
    return m;
  }
  function showSat(date) {
    if (satLayer) map.removeLayer(satLayer);
    satLayer = L.tileLayer(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
      { maxNativeZoom: 9, maxZoom: 18, opacity: 0.9, attribution: "NASA GIBS / MODIS Terra" }).addTo(map);
    satLayer.bringToBack(); Object.values(bases).forEach((b) => b.bringToBack());
  }
  function togglePlay() {
    if (S.lapse) {
      if (S.lapse.timer) { clearTimeout(S.lapse.timer); S.lapse.timer = null; $("play").textContent = "▶"; return; }
      $("play").textContent = "❚❚";
      if (S.lapse.i >= S.lapse.dates.length - 1) S.lapse.i = -1;
      const stepL = () => { if (!S.lapse) return; if (S.lapse.i >= S.lapse.dates.length - 1) { $("play").textContent = "▶"; S.lapse.timer = null; return; } lapseFrame(S.lapse.i + 1); S.lapse.timer = setTimeout(stepL, Math.max(450, +$("rbSpeed").value * 6)); };
      stepL(); return;
    }
    if (!S.replay) return;
    if (S.replay.timer) return stopPlay();
    $("play").textContent = "❚❚";
    const step = () => {
      if (S.replay.day >= S.replay.doc.days - 1) return stopPlay();
      setDay(S.replay.day + 1);
      S.replay.timer = setTimeout(step, +$("rbSpeed").value);
    };
    step();
  }
  function stopPlay() { if (S.replay && S.replay.timer) { clearTimeout(S.replay.timer); S.replay.timer = null; } $("play").textContent = "▶"; }
  function exitReplay() {
    stopPlay(); S.replay = null; $("replaybar").hidden = true; document.body.classList.remove("replaying");
    if (satLayer) { map.removeLayer(satLayer); satLayer = null; } $("rbSat").checked = false;
    document.querySelectorAll("#tab-replay [data-y]").forEach((b) => b.classList.remove("on"));
    recolorPoints(); lgaLayer && lgaLayer.setStyle(lgaStyle);
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
        <li>Maps: © OpenStreetMap contributors, OpenTopoMap; boundaries: geoBoundaries (CC BY 4.0)</li></ul>
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
  function syncModeButtons() { document.querySelectorAll("#modes button").forEach((b) => b.classList.toggle("on", b.dataset.mode === S.mode)); }
  function applyLang() {
    const t = T();
    document.documentElement.lang = S.lang === "pcm" ? "en" : S.lang;
    $("tagline").textContent = t.tagline;
    $("q").placeholder = t.search;
    ["flood", "season", "plant", "heat"].forEach((m) => { $("m_" + m).textContent = t["mode_" + m]; });
    ["today", "replay", "model", "about"].forEach((m) => { $("t_" + m).textContent = t["tab_" + m]; });
    liveBadge(); renderLegend();
    const active = document.querySelector(".tabs button.on").dataset.tab;
    if (active === "today") renderToday(); else switchTab(active);
  }

  async function init() {
    S.lang = store.get("nfa_lang", "en");
    S.view = store.get("nfa_view", "public");
    if (S.view === "farmer") S.mode = "plant";
    const shortLang = window.innerWidth <= 860;
    $("lang").innerHTML = I.langs.map((k) => `<option value="${k}" title="${I.L[k]._name}">${shortLang ? k.toUpperCase() : I.L[k]._name}</option>`).join("");
    $("lang").value = S.lang;
    $("lang").addEventListener("change", (e) => { S.lang = e.target.value; store.set("nfa_lang", S.lang); applyLang(); });
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { switchTab(b.dataset.tab); if (b.dataset.tab === "today") renderToday(); }));
    document.querySelectorAll("#modes button").forEach((b) => b.addEventListener("click", () => {
      S.mode = b.dataset.mode; syncModeButtons();
      lgaLayer && lgaLayer.setStyle(lgaStyle); stateLayer && stateLayer.setStyle(stateStyle); renderLegend();
    }));
    $("grip").addEventListener("click", () => $("panel").classList.toggle("full"));
    $("play").addEventListener("click", togglePlay);
    $("rbClose").addEventListener("click", () => { if (S.lapse) stopLapse(); else if (S.replay) exitReplay(); });
    $("rbSlider").addEventListener("input", (e) => { if (S.lapse) { clearTimeout(S.lapse.timer); S.lapse.timer = null; $("play").textContent = "▶"; return lapseFrame(+e.target.value); } stopPlay(); setDay(+e.target.value); });
    $("rbSat").addEventListener("change", (e) => { if (e.target.checked && S.replay) showSat(addDays(S.replay.doc.start, S.replay.day)); else if (satLayer) { map.removeLayer(satLayer); satLayer = null; } });
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
