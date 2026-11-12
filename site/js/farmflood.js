// "Harvest before the flood" advisory for riverside farms.
// Turns a river forecast (and the ML flood chance) for the rivers near a community into
// plain farm advice: how many days remain, which crops are usually ready in this zone at
// that time of year, and what to move. Shared by the map (app.js), the 2G text pages
// (tools/build_lite.js) and the basic-phone demo (ussd.js), so the advice is identical.
(function (root) {
  "use strict";

  // Typical harvest months (1-12) by zone. A general guide, not a local crop calendar.
  const ZONES = {
    north:  { name: "Northern savanna", crops: { rice: [9, 10, 11, 12], maize: [8, 9, 10], sorghum: [10, 11, 12], millet: [8, 9, 10], cowpea: [9, 10, 11], groundnut: [8, 9, 10] } },
    middle: { name: "Middle Belt", crops: { rice: [9, 10, 11, 12], maize: [7, 8, 9, 10], sorghum: [10, 11, 12], yam: [8, 9, 10, 11, 12], cowpea: [9, 10, 11], soybean: [10, 11], cassava: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] } },
    south:  { name: "Southern forest and delta", crops: { rice: [8, 9, 10, 11], maize: [6, 7, 8, 10, 11], yam: [8, 9, 10, 11, 12], cassava: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] } },
  };
  const zoneOf = (lat) => (lat >= 10 ? "north" : lat >= 7.5 ? "middle" : "south");

  const TXT = {
    en: {
      title: "Harvest before the flood",
      calm: "No flood threat to riverside farms here in the next 30 days.",
      head: (river, days, date) => days <= 0 ? `The ${river} is already above its normal flood level here.` : `The ${river} is forecast to rise above normal here in about ${days} day${days === 1 ? "" : "s"} (around ${date}).`,
      ml: (river, lead) => `Our model gives a high chance that the ${river} rises above its Warning level within ${lead} days.`,
      ready: (crops) => `Crops usually ready around then in this area: ${crops}.`,
      act: [
        "",
        "Check farms close to the river. Harvest mature crops early and dry them on high ground. Do not plant new crops on the riverbank.",
        "Harvest what you can now. Move stored grain, seed, fertiliser, animals and pumps to high ground. Do not sleep in farm huts by the river.",
        "Leave the riverbank. Move people and animals to high ground first; crops and equipment only if it is safe. Follow SEMA/NEMA instructions.",
      ],
      crop: { rice: "rice", maize: "maize", sorghum: "sorghum", millet: "millet", cowpea: "beans (cowpea)", groundnut: "groundnut", yam: "yam", soybean: "soybean", cassava: "cassava (can be harvested early)" },
      note: "Typical harvest months for the zone; check your own fields.",
      short_calm: "Riverside farms: no flood threat in next 30 days.",
      short: (river, when) => `FLOOD ${when} (${river}).`,
      short_when: (a) => a.source === "ml" ? `LIKELY IN ${a.lead} DAYS` : a.days ? `IN ~${a.days} DAYS` : "NOW",
      short_act: ["", "Harvest ripe crops early.", "Harvest now; move grain & animals high.", "Leave riverbank now."],
    },
    pcm: {
      title: "Harvest before flood come",
      calm: "Flood no dey threaten farm wey dey near river here for the next 30 days.",
      head: (river, days, date) => days <= 0 ? `${river} don already pass im normal flood level for here.` : `${river} fit rise pass normal for here in about ${days} day${days === 1 ? "" : "s"} (around ${date}).`,
      ml: (river, lead) => `Our model talk say chance high well well say ${river} go pass im Warning level inside ${lead} days.`,
      ready: (crops) => `Crops wey dey usually ready that time for this area: ${crops}.`,
      act: [
        "",
        "Check farm wey near river. Harvest crops wey don ripe early, dry dem for high ground. No plant new crops for riverbank.",
        "Harvest wetin you fit now. Carry grain, seed, fertiliser, animals and pump go high ground. No sleep for farm hut near river.",
        "Comot from riverbank. Carry people and animals go high ground first. Follow SEMA/NEMA instruction.",
      ],
      crop: { rice: "rice", maize: "corn (maize)", sorghum: "guinea corn", millet: "millet", cowpea: "beans", groundnut: "groundnut", yam: "yam", soybean: "soya beans", cassava: "cassava (you fit harvest am early)" },
      note: "Na normal harvest months for this zone; check your own farm.",
      short_calm: "Farm near river: no flood for next 30 days.",
      short: (river, when) => `FLOOD ${when} (${river}).`,
      short_when: (a) => a.source === "ml" ? `FIT COME IN ${a.lead} DAYS` : a.days ? `IN ~${a.days} DAYS` : "DON START",
      short_act: ["", "Harvest ripe crops early.", "Harvest now; carry grain & animals go high ground.", "Comot from riverbank now."],
    },
  };
  const tx = (lang) => TXT[lang] || TXT.en;

  const daysBetween = (a, b) => Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 864e5);
  const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const fmt = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

  // rivers: [{river, level, first, ml}] for the river points linked to this community.
  // thr: {7: p, 14: p} tuned ML thresholds for the Warning target (from latest.model).
  function assess(rivers, lat, today, thr) {
    const fc = [], ml = [];
    for (const r of rivers || []) {
      if (r.level >= 1 && r.first) fc.push({ level: r.level, days: Math.max(0, daysBetween(today, r.first)), date: r.first, river: r.river, source: "forecast" });
      for (const lead of [7, 14]) {
        const p = r.ml && r.ml[String(lead)] && r.ml[String(lead)].warning;
        if (p != null && thr && thr[lead] != null && p >= thr[lead]) { ml.push({ level: 2, days: lead, date: addDays(today, lead), river: r.river, source: "ml", lead, p }); break; }
      }
    }
    // A forecast date is more concrete than an ML chance, so it wins; then highest level, then soonest.
    fc.sort((x, y) => y.level - x.level || x.days - y.days);
    ml.sort((x, y) => x.days - y.days);
    const best = fc[0] || ml[0] || null;
    if (!best) return null;
    const month = new Date(best.date + "T12:00:00Z").getUTCMonth() + 1;
    const zone = zoneOf(lat);
    best.zone = zone;
    best.crops = Object.entries(ZONES[zone].crops).filter(([, m]) => m.includes(month)).map(([c]) => c);
    return best;
  }

  function text(a, lang) {
    const t = tx(lang);
    if (!a) return t.calm;
    const head = a.source === "ml" ? t.ml(a.river, a.lead) : t.head(a.river, a.days, fmt(a.date));
    const crops = a.crops.length ? " " + t.ready(a.crops.map((c) => t.crop[c] || c).join(", ")) : "";
    return `${head}${crops} ${t.act[Math.min(3, Math.max(1, a.level))]}`;
  }

  function short(a, lang) {
    const t = tx(lang);
    if (!a) return t.short_calm;
    return `${t.short(a.river, t.short_when(a))} ${t.short_act[Math.min(3, Math.max(1, a.level))]}`;
  }

  const api = { assess, text, short, title: (lang) => tx(lang).title, note: (lang) => tx(lang).note, zoneOf, ZONES };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NFA_FARMFLOOD = api;
})(typeof window !== "undefined" ? window : globalThis);
