// Living-water layer: one canvas over the Leaflet map that draws the rivers as flowing lines
// and pulsing rings on gauge points that are above normal. Everything is drawn in a single
// requestAnimationFrame loop, batched by colour and width, with no shadows or blur, so it
// stays smooth on low-end Android phones. Honours prefers-reduced-motion (static drawing).
window.NFA_FX = function (map, opt) {
  "use strict";
  opt = opt || {};
  const pane = map.createPane("fx");
  pane.style.zIndex = 440; pane.style.pointerEvents = "none";
  const canvas = L.DomUtil.create("canvas", "nfa-fx leaflet-zoom-hide", pane);
  const ctx = canvas.getContext("2d");
  const coarse = window.matchMedia("(pointer: coarse)").matches || (navigator.hardwareConcurrency || 8) <= 4;
  const dpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2);
  const minFrame = coarse ? 30 : 15;       // ms between frames (about 30 fps on phones, 60 on desktop)
  const rm = window.matchMedia("(prefers-reduced-motion: reduce)");

  const st = { night: false, dim: false, paused: false, dirty: true, t: 0, last: 0, raf: 0 };
  let reaches = [], points = [], byGauge = {};
  let target = {};                          // gauge id -> { lv: 0..3 | null, w: px }
  let size = map.getSize();

  // ---- colours -------------------------------------------------------------------------
  const DAY = [[28, 136, 204], [242, 176, 36], [238, 110, 26], [214, 34, 62]];
  const NIGHT = [[86, 208, 255], [255, 205, 70], [255, 136, 48], [255, 64, 92]];
  function colour(lv, a) {
    const pal = st.night ? NIGHT : DAY;
    const x = Math.max(0, Math.min(3, lv)), i = Math.min(2, Math.floor(x)), f = x - i;
    const c0 = pal[i], c1 = pal[i + 1];
    return `rgba(${Math.round(c0[0] + (c1[0] - c0[0]) * f)},${Math.round(c0[1] + (c1[1] - c0[1]) * f)},${Math.round(c0[2] + (c1[2] - c0[2]) * f)},${a})`;
  }

  // ---- geometry ------------------------------------------------------------------------
  const norm = (s) => String(s || "").toLowerCase().replace(/river|\(.*?\)/g, "").trim();
  function densify(coords, step) {
    const out = [coords[0]];
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1], b = coords[i];
      const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step);
      for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
    }
    return out;
  }
  // Split every river line into reaches, each driven by its nearest gauge point.
  function setRivers(features, gauges) {
    reaches = []; byGauge = {};
    (features || []).forEach((f) => {
      if (!f.geometry || f.geometry.type !== "LineString") return;
      const name = norm(f.properties.name), sz = f.properties.size || 1;
      const pts = densify(f.geometry.coordinates, 0.05);
      const gid = pts.map((c) => {
        let best = null, bd = 0.45;
        for (const g of gauges) {
          let d = Math.hypot(g.lon - c[0], g.lat - c[1]);
          if (norm(g.river) !== name) d *= 2.4;
          if (d < bd) { bd = d; best = g.id; }
        }
        return best;
      });
      for (let i = 1; i < gid.length; i++) if (gid[i] == null) gid[i] = gid[i - 1];
      for (let i = gid.length - 2; i >= 0; i--) if (gid[i] == null) gid[i] = gid[i + 1];
      let s = 0;
      for (let i = 1; i <= pts.length; i++) {
        if (i === pts.length || gid[i] !== gid[s]) {
          const ll = pts.slice(s, Math.min(pts.length, i + 1));
          if (ll.length > 1) {
            const r = { gid: gid[s], size: sz, ll, xy: new Float32Array(ll.length * 2), box: [0, 0, 0, 0], lv: 0, w: 1 + sz * 0.7, init: false };
            reaches.push(r);
            if (r.gid != null) (byGauge[r.gid] = byGauge[r.gid] || []).push(r);
          }
          s = i;
        }
      }
    });
    project(); st.dirty = true;
  }
  function setPoints(list) { points = (list || []).map((p, i) => ({ id: p.id, lat: p.lat, lon: p.lon, x: 0, y: 0, ph: (i * 0.618) % 1 })); project(); st.dirty = true; }
  function project() {
    reaches.forEach((r) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < r.ll.length; i++) {
        const p = map.latLngToLayerPoint([r.ll[i][1], r.ll[i][0]]);
        r.xy[i * 2] = p.x; r.xy[i * 2 + 1] = p.y;
        if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
      }
      r.box = [x0, y0, x1, y1];
    });
    points.forEach((p) => { const q = map.latLngToLayerPoint([p.lat, p.lon]); p.x = q.x; p.y = q.y; });
    st.dirty = true;
  }
  function resize() {
    size = map.getSize();
    canvas.width = Math.round(size.x * dpr); canvas.height = Math.round(size.y * dpr);
    canvas.style.width = size.x + "px"; canvas.style.height = size.y + "px";
    st.dirty = true;
  }

  // ---- drawing -------------------------------------------------------------------------
  function draw(dt) {
    const still = rm.matches;
    const o = map.containerPointToLayerPoint([0, 0]);
    L.DomUtil.setPosition(canvas, o);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, -o.x * dpr, -o.y * dpr);
    const z = map.getZoom();
    const k = Math.max(0.62, Math.min(2.4, 0.72 + (z - 6) * 0.24));
    const ease = still ? 1 : 1 - Math.exp(-dt / 0.38);
    const vx0 = o.x - 40, vy0 = o.y - 40, vx1 = o.x + size.x + 40, vy1 = o.y + size.y + 40;
    const alpha = st.dim ? 0.3 : 1;

    // batch reaches by colour + width so each style is stroked once
    const batches = new Map();
    for (const r of reaches) {
      const tg = r.gid != null ? target[r.gid] : null;
      const tlv = tg && tg.lv != null ? tg.lv : 0, tw = tg && tg.w ? tg.w : 1 + r.size * 0.7;
      if (!r.init) { r.lv = tlv; r.w = tw; r.init = true; }
      else { r.lv += (tlv - r.lv) * ease; r.w += (tw - r.w) * ease; }
      if (r.box[2] < vx0 || r.box[0] > vx1 || r.box[3] < vy0 || r.box[1] > vy1) continue;
      const key = Math.round(r.lv * 4) * 100 + Math.round(r.w * 2);
      let b = batches.get(key);
      if (!b) batches.set(key, b = { lv: Math.round(r.lv * 4) / 4, w: Math.round(r.w * 2) / 2, list: [] });
      b.list.push(r);
    }
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    batches.forEach((b) => {
      ctx.beginPath();
      for (const r of b.list) {
        ctx.moveTo(r.xy[0], r.xy[1]);
        for (let i = 2; i < r.xy.length; i += 2) ctx.lineTo(r.xy[i], r.xy[i + 1]);
      }
      const w = b.w * k;
      ctx.setLineDash([]);
      ctx.strokeStyle = colour(b.lv, alpha * ((st.night ? 0.2 : 0.15) + 0.07 * b.lv));     // soft halo
      ctx.lineWidth = w * (2.6 + 0.5 * b.lv); ctx.stroke();
      ctx.strokeStyle = colour(b.lv, alpha * 0.95);                                       // water body
      ctx.lineWidth = w; ctx.stroke();
      if (!still) {                                                                         // light running downstream
        const dash = Math.max(2, w * 1.1), gap = 15 + w * 2.2, speed = (15 + 12 * b.lv) * k;
        ctx.setLineDash([dash, gap]);
        ctx.lineDashOffset = -((st.t * speed) % (dash + gap));
        ctx.strokeStyle = `rgba(255,255,255,${alpha * (st.night ? 0.85 : 0.8)})`;
        ctx.lineWidth = Math.max(1, w * 0.44); ctx.stroke();
      }
    });
    ctx.setLineDash([]);

    // rings on points that are above normal
    if (!st.dim) {
      for (const p of points) {
        const tg = target[p.id];
        if (!tg || !(tg.lv >= 1)) continue;
        if (p.x < vx0 || p.x > vx1 || p.y < vy0 || p.y > vy1) continue;
        const reach = (13 + 6 * tg.lv) * k;
        const rings = still ? [0.55] : [(st.t / 2.6 + p.ph) % 1, (st.t / 2.6 + p.ph + 0.5) % 1];
        for (const ph of rings) {
          ctx.beginPath(); ctx.arc(p.x, p.y, 5 * k + ph * reach, 0, 6.2832);
          ctx.strokeStyle = colour(tg.lv, (still ? 0.5 : Math.pow(1 - ph, 1.6) * 0.85));
          ctx.lineWidth = 1.2 + 1.4 * (1 - ph); ctx.stroke();
        }
      }
    }
  }

  function frame(ts) {
    st.raf = requestAnimationFrame(frame);
    if (st.paused || document.hidden) { st.last = ts; return; }
    const el = ts - st.last;
    if (el < minFrame) return;
    if (rm.matches && !st.dirty) { st.last = ts; return; }
    const dt = Math.min(0.1, el / 1000);
    st.last = ts; st.t += dt; st.dirty = false;
    draw(dt);
  }

  map.on("zoomend viewreset zoom", project);
  map.on("move", () => { st.dirty = true; });
  map.on("resize", () => { resize(); project(); });
  rm.addEventListener && rm.addEventListener("change", () => { st.dirty = true; });
  resize();
  st.raf = requestAnimationFrame(frame);

  return {
    setRivers, setPoints,
    // values: { gaugeId: { lv, w } }. Lines and rings ease towards them over ~0.4 s.
    update(values) { target = values || {}; st.dirty = true; },
    set(o) { Object.assign(st, o); st.dirty = true; },
    snap() { reaches.forEach((r) => { r.init = false; }); st.dirty = true; },
    stats() { return { reaches: reaches.length, points: points.length, t: st.t, moving: !rm.matches && !st.paused }; },
  };
};
