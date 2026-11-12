// Builds the low-bandwidth outputs from the latest pipeline data (no dependencies, Node 18+):
//   site/data/lite.json          compact per-LGA / per-state summary (used by the USSD demo)
//   site/lite/<lang>/index.html  text-only pages that load on 2G / Opera Mini / any browser:
//   site/lite/<lang>/<state>.html   one page per state listing every LGA with its status
//   site/lite/<lang>/l/<lga>.html   one page per LGA: flood alert + farm advice, SMS/WhatsApp share
// Messages reuse site/js/i18n.js, so the 5 languages stay identical to the main site.
// Run: node tools/build_lite.js   (the GitHub Actions workflow runs it after the pipeline)
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const SITE = path.join(ROOT, "site");
const DATA = path.join(SITE, "data");
const read = (p) => JSON.parse(fs.readFileSync(path.join(DATA, p), "utf8"));

const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(SITE, "js", "i18n.js"), "utf8"), ctx);
vm.runInNewContext(fs.readFileSync(path.join(SITE, "js", "farmflood.js"), "utf8"), ctx);
const I = ctx.window.NFA_I18N;
const FF = ctx.window.NFA_FARMFLOOD;

const latest = read("latest.json");
const points = read("points.json");
const links = read("lga_links.json");
const lgas = read("geo/lgas.geojson").features.map((f) => f.properties);
const states = read("geo/states.geojson").features.map((f) => f.properties);

const pById = Object.fromEntries(points.map((p) => [p.id, p]));
const lById = Object.fromEntries((latest.points || []).map((p) => [p.id, p]));
const stByName = Object.fromEntries(states.map((s) => [s.name, s]));
const slug = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (iso) => (iso ? new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : null);
const SITE_URL = "https://geraldnzeribe.github.io/naijafloodalert/";

const LEADS = (latest.model && latest.model.leads) || {};
const THR = { 7: LEADS["7"] && LEADS["7"].warning && LEADS["7"].warning.threshold, 14: LEADS["14"] && LEADS["14"].warning && LEADS["14"].warning.threshold };

// ---- one record per LGA (same logic as the main site's place view) ----
const recs = lgas.map((l) => {
  const lv = (latest.lgas || {})[l.id] || [0, 0];
  const ids = ((links[l.id] || {}).points || []).filter((id) => pById[id] && !pById[id].hide);
  const cands = ids.map((id) => lById[id]).filter(Boolean)
    .sort((a, b) => (b.level || 0) - (a.level || 0) || (b.peak || 0) - (a.peak || 0));
  const main = cands[0];
  const st = stByName[l.state];
  const season = st && latest.states ? latest.states[st.id] : null;
  const rivers = ids.map((id) => lById[id] && { river: pById[id].river, level: lById[id].level || 0, first: lById[id].first, ml: lById[id].ml }).filter(Boolean);
  const farm = rivers.length ? { a: FF.assess(rivers, l.lat, latest.date, THR) } : null;
  return { l, lv: lv[0], ml7: lv[1], main, meta: main ? pById[main.id] : null, season, sid: st && st.id, farm };
});

function alertText(lang, r) {
  const place = `${r.l.name}, ${r.l.state}`;
  return I.message(lang, place, r.meta ? r.meta.river : "", {
    level: r.lv, river: !!(r.main && r.main.level > 0),
    first: r.main && r.main.first ? fmt(r.main.first) : null,
    peak: r.main && r.main.level > 0 && r.main.peak_date ? fmt(r.main.peak_date) : null,
    rain7: r.season ? r.season.rain_next7 : null,
  });
}
function farmText(lang, s) {
  if (!s) return null;
  const t = I.t(lang);
  const bits = [t.plant[s.plant] || "", (t.farm_tip || {})[s.plant] || ""];
  if (s.rain_next7 != null) bits.push(`${t.next7 || "Rain, next 7 days"}: ${Math.round(s.rain_next7)} mm`);
  if (s.dry_run) bits.push(t.dry_run ? t.dry_run(s.dry_run) : `${s.dry_run} dry days`);
  if (s.heat) bits.push(t.heat_tip || "Heat stress: water crops and animals early or late in the day.");
  return bits.filter(Boolean).join(" · ");
}

// ---- compact JSON for the USSD / SMS demo ----
const lite = {
  generated: latest.generated, date: latest.date,
  states: states.map((s) => ({ id: s.id, name: s.name, ...(latest.states && latest.states[s.id] ? {
    season: latest.states[s.id].status, plant: latest.states[s.id].plant, heat: latest.states[s.id].heat ? 1 : 0,
    rain7: latest.states[s.id].rain_next7 != null ? Math.round(latest.states[s.id].rain_next7) : null,
    dry7: latest.states[s.id].dry_next7 ?? null, dry_run: latest.states[s.id].dry_run ?? 0 } : {}) }))
    .sort((a, b) => a.name.localeCompare(b.name)),
  lgas: recs.map((r) => ({ id: r.l.id, n: r.l.name, s: r.sid, lv: r.lv, ml: Math.round(100 * (r.ml7 || 0)),
    r: r.meta ? r.meta.river : null, f: r.main && r.main.first || null, pk: r.main && r.main.level > 0 ? r.main.peak_date : null,
    ...(r.farm ? { fa: r.farm.a || 0 } : {}) }))
    .sort((a, b) => a.n.localeCompare(b.n)),
};
fs.writeFileSync(path.join(DATA, "lite.json"), JSON.stringify(lite));

// ---- static text pages ----
const CSS = "body{font:16px/1.45 sans-serif;margin:0 auto;max-width:640px;padding:10px;color:#111;background:#fff}" +
  "a{color:#0645ad}h1{font-size:20px;margin:6px 0}h2{font-size:17px;margin:14px 0 4px}.l0{background:#2e7d32}.l1{background:#f2b705;color:#000}.l2{background:#ef6c00}.l3{background:#c62828}" +
  ".b{display:inline-block;padding:1px 6px;border-radius:4px;color:#fff;font-weight:bold;font-size:13px}ul{padding-left:18px}li{margin:3px 0}.m{color:#555;font-size:13px}.box{border:2px solid #ccc;padding:8px;border-radius:6px;margin:8px 0}";
const page = (lang, title, body) => `<!doctype html><html lang="${lang === "pcm" ? "en" : lang}"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · NaijaFloodAlert</title><style>${CSS}</style></head><body>${body}` +
  `<p class="m">NaijaFloodAlert lite · updated ${esc((latest.generated || "").replace("T", " ").slice(0, 16))} UTC · ` +
  `<a href="${SITE_URL}">full map</a> · Not an official warning: follow NIHSA, NiMet, NEMA/SEMA. Emergency: 112.</p></body></html>`;
const langBar = (rel) => `<p class="m">${I.langs.map((k) => `<a href="${rel}${k}/index.html">${esc(I.L[k]._name)}</a>`).join(" | ")}</p>`;
const badge = (lang, lv) => `<span class="b l${lv}">${esc(I.t(lang).lvl[lv])}</span>`;

const out = path.join(SITE, "lite");
fs.rmSync(out, { recursive: true, force: true });
let files = 0;
const write = (p, html) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, html); files++; };

for (const lang of I.langs) {
  const t = I.t(lang);
  const dir = path.join(out, lang);
  const byState = {};
  recs.forEach((r) => (byState[r.l.state] = byState[r.l.state] || []).push(r));
  const atRisk = recs.filter((r) => r.lv >= 1).sort((a, b) => b.lv - a.lv);

  // index: states + communities at risk
  let body = `<h1>NaijaFloodAlert</h1>${langBar("../")}<p>${esc(t.tagline)}.</p>`;
  body += `<h2>${esc(t.lvl[1])}+ (${atRisk.length})</h2>` + (atRisk.length
    ? `<ul>${atRisk.slice(0, 60).map((r) => `<li>${badge(lang, r.lv)} <a href="l/${r.l.id}.html">${esc(r.l.name)}</a>, ${esc(r.l.state)}</li>`).join("")}</ul>`
    : `<p>${esc(t.lvl[0])} ✓</p>`);
  body += `<h2>States</h2><ul>${Object.keys(byState).sort().map((s) => {
    const n = byState[s].filter((r) => r.lv >= 1).length;
    return `<li><a href="${slug(s)}.html">${esc(s)}</a>${n ? ` <span class="b l1">${n}</span>` : ""}</li>`;
  }).join("")}</ul>`;
  write(path.join(dir, "index.html"), page(lang, "NaijaFloodAlert", body));

  // one page per state
  for (const [s, list] of Object.entries(byState)) {
    const season = list[0].season;
    let b = `<p class="m"><a href="index.html">← ${esc(t.tab_today || "Home")}</a></p><h1>${esc(s)}</h1>`;
    if (season) b += `<div class="box">${esc(t.season[season.status] || "")} · ${esc(t.plant[season.plant] || "")}${season.heat ? " · 🔥" : ""}<br>` +
      `${esc(t.next7 || "Rain, next 7 days")}: ${season.rain_next7 != null ? Math.round(season.rain_next7) + " mm" : "–"}</div>`;
    b += `<ul>${list.sort((a, c) => c.lv - a.lv || a.l.name.localeCompare(c.l.name)).map((r) => `<li>${badge(lang, r.lv)} <a href="l/${r.l.id}.html">${esc(r.l.name)}</a></li>`).join("")}</ul>`;
    write(path.join(dir, `${slug(s)}.html`), page(lang, s, b));
  }

  // one page per LGA
  for (const r of recs) {
    const msg = alertText(lang, r);
    const farm = farmText(lang, r.season);
    const share = `${msg} ${SITE_URL}lite/${lang}/l/${r.l.id}.html`;
    let b = `<p class="m"><a href="../${slug(r.l.state)}.html">← ${esc(r.l.state)}</a> · <a href="../index.html">${esc(t.tab_today || "Home")}</a></p>` +
      `<h1>${esc(r.l.name)}</h1><p>${badge(lang, r.lv)}</p><div class="box">${esc(msg)}</div>`;
    if (r.ml7) b += `<p class="m">ML: ${Math.round(100 * r.ml7)}% / 7 d</p>`;
    if (r.farm) b += `<h2>🌾 ${esc(FF.title(lang))}</h2><div class="box">${esc(FF.text(r.farm.a, lang))}</div>`;
    if (farm) b += `<h2>${esc(t.mode_plant)}</h2><div class="box">${esc(farm)}</div>`;
    b += `<p><a href="sms:?body=${encodeURIComponent(share)}">SMS</a> · <a href="https://wa.me/?text=${encodeURIComponent(share)}">WhatsApp</a></p>`;
    b += `<p class="m">${I.langs.filter((k) => k !== lang).map((k) => `<a href="../../${k}/l/${r.l.id}.html">${esc(I.L[k]._name)}</a>`).join(" | ")}</p>`;
    write(path.join(dir, "l", `${r.l.id}.html`), page(lang, r.l.name, b));
  }
}
write(path.join(out, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=en/index.html"><a href="en/index.html">NaijaFloodAlert lite</a>`);
console.log(`lite: ${files} pages, lite.json ${fs.statSync(path.join(DATA, "lite.json")).size} bytes`);
