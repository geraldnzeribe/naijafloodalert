// Risk engine: pure functions, no DOM. Also runs under Node for tests.
(function (root) {
  const LEVELS = [
    { key: "normal",  en: "Normal",  pcm: "Normal" },
    { key: "watch",   en: "Watch",   pcm: "Make una watch" },
    { key: "warning", en: "Warning", pcm: "Warning" },
    { key: "severe",  en: "Severe",  pcm: "Serious danger" }
  ];

  function percentile(values, p) {
    const v = values.filter((x) => typeof x === "number" && isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const idx = (v.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return v[lo] + (v[hi] - v[lo]) * (idx - lo);
  }

  // Thresholds from the river's own daily record.
  function thresholds(history) {
    return {
      p50: percentile(history, 0.5),
      p90: percentile(history, 0.9),
      p98: percentile(history, 0.98),
      p997: percentile(history, 0.997),
      n: history.filter((x) => x != null).length
    };
  }

  function levelFor(q, th) {
    if (q == null || th.p90 == null) return 0;
    if (q >= th.p997) return 3;
    if (q >= th.p98) return 2;
    if (q >= th.p90) return 1;
    return 0;
  }

  // forecast: [{date:"YYYY-MM-DD", q:Number}], rain: [{date, mm}]
  function assess(forecast, th, rain, siteType) {
    let peak = { q: -Infinity, date: null };
    let first = { 1: null, 2: null, 3: null };
    let riverLevel = 0;
    for (const d of forecast) {
      if (d.q == null) continue;
      if (d.q > peak.q) peak = { q: d.q, date: d.date };
      const l = levelFor(d.q, th);
      if (l > riverLevel) riverLevel = l;
      for (let k = 1; k <= 3; k++) if (l >= k && !first[k]) first[k] = d.date;
    }
    const rain7 = (rain || []).slice(0, 7).reduce((s, r) => s + (r.mm || 0), 0);
    const maxDayRain = (rain || []).slice(0, 7).reduce((m, r) => Math.max(m, r.mm || 0), 0);
    let level = riverLevel;
    const reasons = [];
    if (riverLevel > 0) reasons.push("river");
    const heavyRain = rain7 >= 100 || maxDayRain >= 50;
    if (heavyRain && siteType === "urban") {
      level = Math.min(3, Math.max(level, 1) + (level >= 1 ? 1 : 0));
      reasons.push("rain");
    } else if (heavyRain) {
      level = Math.max(level, 1);
      reasons.push("rain");
    }
    return {
      level,
      riverLevel,
      peakQ: peak.q === -Infinity ? null : peak.q,
      peakDate: peak.date,
      // First day the river goes above normal (or, for rain-only alerts, the start of the rain window).
      firstDate: level > 0 ? (first[1] || (rain && rain[0] && rain[0].date)) : null,
      ratioToNormal: th.p50 ? (peak.q / th.p50) : null,
      rain7: Math.round(rain7),
      maxDayRain: Math.round(maxDayRain),
      reasons
    };
  }

  function fmtDate(iso, lang) {
    if (!iso) return "";
    const d = new Date(iso + "T12:00:00Z");
    return d.toLocaleDateString(lang === "pcm" ? "en-NG" : "en-GB", { weekday: "short", day: "numeric", month: "short" });
  }

  const ACTIONS = {
    en: {
      1: "Keep drains clear, move valuables off the floor and watch official updates.",
      2: "Prepare to move to higher ground. Pack documents, medicine and water. Do not walk or drive through flood water.",
      3: "Move to higher ground now if you live near the river or in a low area. Help children, the elderly and people with disabilities. Do not cross flood water."
    },
    pcm: {
      1: "Clear gutter, carry your things comot from ground, and dey follow government update.",
      2: "Prepare to comot go high ground. Pack your papers, medicine and water. No waka or drive inside flood water.",
      3: "If you dey near river or low area, comot go high ground now now. Help pikin, old people and people wey get disability. No cross flood water."
    }
  };

  function message(site, a, lang) {
    lang = lang === "pcm" ? "pcm" : "en";
    const lvl = LEVELS[a.level][lang];
    const where = site.name + (site.state ? ", " + site.state : "");
    if (a.level === 0) {
      return lang === "pcm"
        ? `NaijaFloodAlert – ${where}: No big flood risk for the next 30 days based on river forecast. Rain for next 7 days: about ${a.rain7} mm. Una still dey careful.`
        : `NaijaFloodAlert – ${where}: No significant flood risk expected in the next 30 days from the river forecast. 7-day rainfall outlook: about ${a.rain7} mm.`;
    }
    const when = a.firstDate ? fmtDate(a.firstDate, lang) : "";
    const peak = a.peakDate ? fmtDate(a.peakDate, lang) : "";
    const why = [];
    if (a.reasons.includes("river")) why.push(lang === "pcm" ? `${site.river} water go rise pass normal` : `${site.river} is forecast to rise above normal`);
    if (a.reasons.includes("rain")) why.push(lang === "pcm" ? `heavy rain (about ${a.rain7} mm for 7 days)` : `heavy rain is expected (about ${a.rain7} mm over 7 days)`);
    const head = lang === "pcm"
      ? `FLOOD ${lvl.toUpperCase()} – ${where}: ${why.join(" and ")}${when ? `, from ${when}` : ""}${peak && a.reasons.includes("river") ? `; e go reach top around ${peak}` : ""}.`
      : `FLOOD ${lvl.toUpperCase()} – ${where}: ${why.join(" and ")}${when ? ` from ${when}` : ""}${peak && a.reasons.includes("river") ? `, peaking around ${peak}` : ""}.`;
    const tail = lang === "pcm" ? "Follow NEMA/SEMA instruction. Emergency: 112." : "Follow NEMA/SEMA instructions. Emergency: 112.";
    return `${head} ${ACTIONS[lang][a.level]} ${tail}`;
  }

  const api = { LEVELS, percentile, thresholds, levelFor, assess, message, fmtDate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NFA_RISK = api;
})(typeof window !== "undefined" ? window : globalThis);
