(function () {
  const R = window.NFA_RISK;
  const SITES = window.NFA_SITES.slice();
  const FLOOD_API = "https://flood-api.open-meteo.com/v1/flood";
  const WX_API = "https://api.open-meteo.com/v1/forecast";
  const HIST_START = "2010-01-01";
  const COLORS = ["#2e7d32", "#f2b705", "#ef6c00", "#c62828"];
  const state = { results: {}, selected: null, lang: "en", chart: null, markers: {} };

  // ---------- storage helpers (never let storage break the page) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } }
  };
  state.lang = store.get("nfa_lang", "en");

  const today = () => new Date().toISOString().slice(0, 10);
  const yesterday = () => new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function getJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    if (j.error) throw new Error(j.reason || "API error");
    return j;
  }

  // History thresholds are cached for 7 days per point; they barely change.
  async function getThresholds(lat, lon) {
    const key = `nfa_th_${lat.toFixed(3)}_${lon.toFixed(3)}`;
    const c = store.get(key, null);
    if (c && Date.now() - c.t < 7 * 86400000) return c.th;
    const j = await getJSON(`${FLOOD_API}?latitude=${lat}&longitude=${lon}&daily=river_discharge&start_date=${HIST_START}&end_date=${yesterday()}`);
    const th = R.thresholds(j.daily.river_discharge);
    store.set(key, { t: Date.now(), th });
    return th;
  }

  async function analyse(site) {
    const [th, fc, wx] = await Promise.all([
      getThresholds(site.lat, site.lon),
      getJSON(`${FLOOD_API}?latitude=${site.lat}&longitude=${site.lon}&daily=river_discharge,river_discharge_max,river_discharge_min&past_days=14&forecast_days=30`),
      getJSON(`${WX_API}?latitude=${site.lat}&longitude=${site.lon}&daily=precipitation_sum&forecast_days=7&timezone=Africa%2FLagos`).catch(() => null)
    ]);
    const t = fc.daily.time;
    const all = t.map((d, i) => ({ date: d, q: fc.daily.river_discharge[i], qmax: fc.daily.river_discharge_max[i], qmin: fc.daily.river_discharge_min[i] }));
    const forecast = all.filter((d) => d.date >= today());
    const rain = wx ? wx.daily.time.map((d, i) => ({ date: d, mm: wx.daily.precipitation_sum[i] || 0 })) : [];
    const a = R.assess(forecast, th, rain, site.type);
    return { site, th, all, forecast, rain, a };
  }

  // ---------- UI: list ----------
  function renderList() {
    const ul = $("sites");
    const sorted = SITES.slice().sort((x, y) => {
      const lx = state.results[x.id] ? state.results[x.id].a.level : -1;
      const ly = state.results[y.id] ? state.results[y.id].a.level : -1;
      return ly - lx || x.name.localeCompare(y.name);
    });
    ul.innerHTML = sorted.map((s) => {
      const r = state.results[s.id];
      const lvl = r ? (r.error ? -1 : r.a.level) : null;
      const badge = lvl == null ? '<span class="pill loading">…</span>'
        : lvl < 0 ? '<span class="pill err">No data</span>'
        : `<span class="pill lvl-${lvl}">${R.LEVELS[lvl].en}</span>`;
      const sub = r && !r.error ? (r.a.peakQ != null ? `Peak ${Math.round(r.a.peakQ).toLocaleString()} m³/s · ${R.fmtDate(r.a.peakDate)}` : "") : esc(s.river);
      return `<li><button class="site ${state.selected === s.id ? "active" : ""}" data-id="${s.id}">
        <span class="sname">${esc(s.name)} <small>${esc(s.state)}</small></span>${badge}
        <span class="ssub">${sub}</span></button></li>`;
    }).join("");
    ul.querySelectorAll("button.site").forEach((b) => b.addEventListener("click", () => select(b.dataset.id, true)));
    const sel = $("subsite");
    const cur = sel.value;
    sel.innerHTML = SITES.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
    if (cur) sel.value = cur;
  }

  // ---------- UI: map ----------
  let map, floodLayer;
  function initMap() {
    map = L.map("map", { zoomControl: true }).setView([9.1, 8.2], 6);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18, attribution: "© OpenStreetMap contributors" }).addTo(map);
    floodLayer = L.tileLayer(
      `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Combined_Flood_2-Day/default/${yesterday()}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.png`,
      { maxNativeZoom: 9, maxZoom: 18, opacity: 0.85, attribution: "NASA GIBS / LANCE MODIS flood product" }
    );
    $("satflood").addEventListener("change", (e) => e.target.checked ? floodLayer.addTo(map) : map.removeLayer(floodLayer));
    map.on("click", (e) => { $("clat").value = e.latlng.lat.toFixed(4); $("clon").value = e.latlng.lng.toFixed(4); });
    SITES.forEach(addMarker);
  }
  function addMarker(s) {
    const m = L.circleMarker([s.lat, s.lon], { radius: 9, weight: 2, color: "#fff", fillColor: "#90a4ae", fillOpacity: 1 })
      .addTo(map).bindTooltip(s.name);
    m.on("click", () => select(s.id, false));
    state.markers[s.id] = m;
  }
  function paintMarker(id) {
    const r = state.results[id], m = state.markers[id];
    if (!m) return;
    const c = r && !r.error ? COLORS[r.a.level] : "#90a4ae";
    m.setStyle({ fillColor: c, radius: r && !r.error && r.a.level >= 2 ? 12 : 9 });
  }

  // ---------- UI: detail ----------
  function select(id, pan) {
    state.selected = id;
    renderList();
    const r = state.results[id];
    const s = SITES.find((x) => x.id === id);
    if (pan && s) map.setView([s.lat, s.lon], 8);
    if (!r) { $("detail").innerHTML = `<div class="empty"><h2>${esc(s.name)}</h2><p>Loading…</p></div>`; return; }
    if (r.error) { $("detail").innerHTML = `<div class="empty"><h2>${esc(s.name)}</h2><p>Could not load data (${esc(r.error)}). Check your connection and press Refresh.</p></div>`; return; }
    renderDetail(r);
  }

  function renderDetail(r) {
    const { site, a, th } = r;
    const msg = R.message(site, a, state.lang);
    const lvl = R.LEVELS[a.level];
    const pct = a.ratioToNormal ? Math.round(a.ratioToNormal * 100) : null;
    $("detail").innerHTML = `
      <div class="d-head">
        <div><h2>${esc(site.name)}, ${esc(site.state)}</h2><p class="muted">${esc(site.river)} · ${site.lat.toFixed(3)}, ${site.lon.toFixed(3)}</p></div>
        <span class="pill big lvl-${a.level}">${lvl.en}</span>
      </div>
      <div class="stats">
        <div><b>${a.peakQ != null ? Math.round(a.peakQ).toLocaleString() : "–"}</b><span>peak m³/s (30 days)</span></div>
        <div><b>${a.peakDate ? R.fmtDate(a.peakDate) : "–"}</b><span>expected peak</span></div>
        <div><b>${pct != null ? pct + "%" : "–"}</b><span>of typical flow</span></div>
        <div><b>${a.rain7} mm</b><span>rain next 7 days</span></div>
      </div>
      <div class="chart-wrap"><canvas id="chart" aria-label="River discharge forecast chart"></canvas></div>
      <p class="muted small">Dashed lines: this river's own Watch (90th), Warning (98th) and Severe (99.7th percentile) levels from ${th.n.toLocaleString()} days of record since 2010. Shaded band: forecast spread.</p>
      <div class="alert-box lvl-border-${a.level}">
        <h3>Ready-to-send alert</h3>
        <p id="msg">${esc(msg)}</p>
        <div class="row wrap">
          <a class="btn wa" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}">Share on WhatsApp</a>
          <a class="btn ghost" href="sms:?&body=${encodeURIComponent(msg)}">Send as SMS</a>
          <button class="btn ghost" id="copy">Copy</button>
        </div>
      </div>`;
    $("copy").addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(msg); $("copy").textContent = "Copied"; } catch (e) { $("copy").textContent = "Copy failed"; }
    });
    drawChart(r);
  }

  function drawChart(r) {
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    const ctx = $("chart");
    if (!ctx || !window.Chart) return;
    const labels = r.all.map((d) => d.date.slice(5));
    const todayIdx = r.all.findIndex((d) => d.date >= today());
    const line = (v, c) => ({ type: "line", data: labels.map(() => v), borderColor: c, borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0, fill: false });
    state.chart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          { label: "Forecast max", data: r.all.map((d) => d.qmax), borderWidth: 0, pointRadius: 0, backgroundColor: "rgba(21,101,192,0.15)", fill: "+1" },
          { label: "Forecast min", data: r.all.map((d) => d.qmin), borderWidth: 0, pointRadius: 0, fill: false },
          { label: "River discharge (m³/s)", data: r.all.map((d) => d.q), borderColor: "#1565c0", borderWidth: 2.5, pointRadius: 0, tension: 0.25,
            segment: { borderDash: (c) => (c.p0DataIndex < todayIdx ? [3, 3] : undefined) } },
          Object.assign(line(r.th.p90, COLORS[1]), { label: "Watch" }),
          Object.assign(line(r.th.p98, COLORS[2]), { label: "Warning" }),
          Object.assign(line(r.th.p997, COLORS[3]), { label: "Severe" })
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { labels: { filter: (i) => !/Forecast (max|min)/.test(i.text), boxWidth: 12 } } },
        scales: { x: { ticks: { maxTicksLimit: 8 } }, y: { title: { display: true, text: "m³/s" }, beginAtZero: false } }
      }
    });
  }

  // ---------- data loading ----------
  async function loadAll() {
    $("updated").textContent = "Loading forecasts…";
    let done = 0;
    await Promise.all(SITES.map(async (s) => {
      try { state.results[s.id] = await analyse(s); }
      catch (e) { state.results[s.id] = { error: e.message }; }
      done++;
      paintMarker(s.id);
      if (done % 3 === 0 || done === SITES.length) renderList();
    }));
    const n = SITES.filter((s) => state.results[s.id] && !state.results[s.id].error && state.results[s.id].a.level > 0).length;
    $("updated").textContent = `Updated ${new Date().toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })} · ${n} of ${SITES.length} communities above normal`;
    renderList();
    if (!state.selected) {
      const top = SITES.slice().sort((x, y) => ((state.results[y.id] && state.results[y.id].a ? state.results[y.id].a.level : -1) - (state.results[x.id] && state.results[x.id].a ? state.results[x.id].a.level : -1)))[0];
      if (top) select(top.id, false);
    } else select(state.selected, false);
  }

  // ---------- custom location ----------
  $("custom").addEventListener("submit", async (e) => {
    e.preventDefault();
    const lat = parseFloat($("clat").value), lon = parseFloat($("clon").value);
    if (!isFinite(lat) || !isFinite(lon) || lat < 3 || lat > 14.5 || lon < 2.5 || lon > 15) { alert("Please enter a location inside Nigeria."); return; }
    const id = "c_" + lat.toFixed(3) + "_" + lon.toFixed(3);
    let s = SITES.find((x) => x.id === id);
    if (!s) {
      s = { id, name: $("cname").value.trim() || `Custom point`, state: "", river: "Nearest river cell", lat, lon, type: "urban" };
      SITES.push(s); addMarker(s);
    }
    state.results[id] = undefined; select(id, true);
    try { state.results[id] = await analyse(s); } catch (err) { state.results[id] = { error: err.message }; }
    paintMarker(id); select(id, false);
  });

  // ---------- subscriptions (prototype: local only) ----------
  function renderSubs() {
    const subs = store.get("nfa_subs", []);
    $("sublist").innerHTML = subs.map((x, i) => `<li>${esc(x.name)} · ${esc(x.phone)} · ${esc((SITES.find((s) => s.id === x.site) || {}).name || x.site)} <button data-i="${i}" class="link">remove</button></li>`).join("");
    $("sublist").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => { const s = store.get("nfa_subs", []); s.splice(+b.dataset.i, 1); store.set("nfa_subs", s); renderSubs(); }));
  }
  $("subform").addEventListener("submit", (e) => {
    e.preventDefault();
    const phone = $("subphone").value.replace(/\s+/g, "");
    if (!/^(\+?234|0)[789][01]\d{8}$/.test(phone)) { alert("Enter a valid Nigerian mobile number, e.g. 08031234567"); return; }
    const s = store.get("nfa_subs", []);
    s.push({ name: $("subname").value.trim(), phone, site: $("subsite").value, lang: state.lang, at: new Date().toISOString() });
    store.set("nfa_subs", s); e.target.reset(); renderSubs();
  });

  // ---------- misc ----------
  $("lang").value = state.lang;
  $("lang").addEventListener("change", (e) => { state.lang = e.target.value; store.set("nfa_lang", state.lang); if (state.selected) select(state.selected, false); });
  $("refresh").addEventListener("click", loadAll);
  if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));

  initMap();
  renderList();
  renderSubs();
  loadAll();
})();
