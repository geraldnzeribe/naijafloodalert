// USSD menu logic, written in the Africa's Talking request/response format:
// input  = the "text" field the gateway sends (choices joined by "*", e.g. "1*12*3*1")
// output = "CON <menu>" (session continues) or "END <message>" (session ends).
// The same function runs in the on-site simulator (ussd.html) and can run unchanged in a
// serverless USSD callback (e.g. a free Cloudflare Worker) once a gateway is connected.
(function (root) {
  "use strict";
  const PAGE = 7;            // items per screen; 8 = more, 0 = back
  const MAX = 182;           // USSD screens hold ~182 characters

  function clip(s) { return s.length > MAX ? s.slice(0, MAX - 1) + "…" : s; }
  function fmt(iso) { return iso ? new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : null; }

  // Walk a paged list: returns {index} when an item is chosen, or {menu, used} while paging.
  function pick(list, steps, label) {
    let page = 0, used = 0;
    for (const s of steps) {
      used++;
      if (s === "8" && (page + 1) * PAGE < list.length) { page++; continue; }
      if (s === "0" && page > 0) { page--; continue; }
      const k = parseInt(s, 10);
      if (k >= 1 && k <= PAGE && page * PAGE + k - 1 < list.length) return { index: page * PAGE + k - 1, used };
      return { invalid: true, used };
    }
    const items = list.slice(page * PAGE, page * PAGE + PAGE).map((x, i) => `${i + 1} ${x}`);
    const nav = [(page + 1) * PAGE < list.length ? "8 More" : "", page > 0 ? "0 Back" : ""].filter(Boolean).join("  ");
    return { menu: `${label}\n${items.join("\n")}${nav ? "\n" + nav : ""}`, used };
  }

  function handle(text, data, I) {
    const steps = (text || "").split("*").filter((x) => x !== "");
    const langs = I.langs;
    if (!steps.length) return "CON NaijaFloodAlert\n" + langs.map((k, i) => `${i + 1} ${I.L[k]._name}`).join("\n");
    const lang = langs[parseInt(steps[0], 10) - 1];
    if (!lang) return "END Invalid choice. Dial again.";
    const t = I.t(lang);
    let rest = steps.slice(1);

    const st = pick(data.states.map((s) => s.name), rest, "State:");
    if (st.invalid) return "END Invalid choice. Dial again.";
    if (st.menu) return "CON " + st.menu;
    const state = data.states[st.index];
    rest = rest.slice(st.used);

    const inState = data.lgas.filter((l) => l.s === state.id);
    const lg = pick(inState.map((l) => l.n), rest, `${state.name} – LGA:`);
    if (lg.invalid) return "END Invalid choice. Dial again.";
    if (lg.menu) return "CON " + lg.menu;
    const lga = inState[lg.index];
    rest = rest.slice(lg.used);

    if (!rest.length) return `CON ${lga.n}\n1 ${t.mode_flood}\n2 ${t.mode_plant}\n3 ${t.mode_season} & ${t.mode_heat}\n4 SMS`;
    const place = `${lga.n}, ${state.name}`;
    const flood = I.message(lang, place, lga.r || "", {
      level: lga.lv, river: lga.lv > 0 && !!lga.r, first: fmt(lga.f), peak: fmt(lga.pk),
      rain7: state.rain7,
    });
    const farm = [t.plant[state.plant] || "", state.rain7 != null ? `${t.next7 || "Rain 7d"}: ${state.rain7}mm` : "",
      state.dry_run ? (t.dry_run ? t.dry_run(state.dry_run) : `${state.dry_run} dry days`) : ""].filter(Boolean).join(". ");
    const weather = [t.season[state.season] || "", state.heat ? (t.mode_heat + "!") : "", state.rain7 != null ? `${state.rain7}mm/7d` : ""].filter(Boolean).join(" · ");
    switch (rest[0]) {
      case "1": return "END " + clip(flood);
      case "2": return "END " + clip(`${place}: ${farm}`);
      case "3": return "END " + clip(`${place}: ${weather}`);
      case "4": return "END " + clip(`SMS sent: ${t.lvl[lga.lv]} – ${place}. ${farm}`);
      default: return "END Invalid choice. Dial again.";
    }
  }

  const api = { handle, PAGE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NFA_USSD = api;
})(typeof window !== "undefined" ? window : globalThis);
