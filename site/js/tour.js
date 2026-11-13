// First-visit guide for people who are new to maps and dashboards.
// Shows a welcome card, then points at the main controls one by one.
// Runs once per browser (remembered in localStorage); the "?" button in the
// header opens it again at any time. Self-contained: injects its own CSS and button.
(function () {
  "use strict";
  const KEY = "nfa_tour_done";
  const $ = (s) => document.querySelector(s);
  const store = {
    get() { try { return localStorage.getItem(KEY); } catch (e) { return "1"; } },
    set() { try { localStorage.setItem(KEY, "1"); } catch (e) { /* private mode */ } },
  };
  const lang = () => { try { return JSON.parse(localStorage.getItem("nfa_lang")) || "en"; } catch (e) { return "en"; } };
  const mobile = () => matchMedia("(max-width: 760px)").matches;

  const TXT = {
    en: {
      hi: "Welcome to NaijaFloodAlert",
      intro: "A free flood and farming guide for every community in Nigeria. It checks the rivers and the rain every day and tells you, in plain words, if your area may flood and what to do.",
      lang: "Choose your language",
      go: "Show me how it works", skip: "Skip, I'll explore",
      next: "Next", back: "Back", done: "Got it", close: "Close guide",
      step: (i, n) => `Step ${i} of ${n}`,
      help: "How to use this site",
      steps: {
        search: ["Find your area", "Type the name of your town, village or local government here, then tap it in the list. You will see your flood risk, rain and farm advice for that place."],
        map: ["Read the colours", "The coloured dots and areas show flood risk. Green or grey means normal, yellow means watch, orange means warning, red means severe. Tap any place on the map to see more."],
        views: ["Pick what fits you", "Public: the overall picture. Farmer: when to plant, when to harvest, and riverside farms that should harvest before a flood. Emergency: a ranked list for NEMA, SEMA and NGOs."],
        modes: ["Change what the map shows", "Flood risk, this season's rain, planting time, or heat. Tap one and the map changes."],
        tabs: ["More to explore", "Replay: watch past floods, like 2022, day by day. Model: how accurate the forecasts are. About: where the data comes from."],
        lang: ["Your language", "Switch between English, Pidgin, Hausa, Yorùbá and Igbo at any time."],
        layers: ["Change what the map shows", "Tap here to switch the map between flood risk, this season's rain, planting time and heat, or to see satellite pictures."],
        nav: ["Move around", "Home: the flood picture and your area. Farm: planting, harvest and riverside farm advice. Replay: watch past floods like 2022. More: emergency list, accuracy, low-data pages and this guide."],
      },
      endT: "You're ready",
      endB: "Tap the ? button at the top (or More → How to use this site) any time to see this guide again.",
      lite: "Slow network or basic phone? Use the low-data pages",
      ussd: "See the basic-phone (USSD) menu",
      story: "See how much warning farmers had in 2022",
    },
    pcm: {
      hi: "Welcome to NaijaFloodAlert",
      intro: "Free flood and farm guide for every community for Naija. E dey check river and rain every day, come tell you for simple words if flood fit come your area and wetin you go do.",
      lang: "Choose your language",
      go: "Show me how e dey work", skip: "Skip, I go check am myself",
      next: "Next", back: "Back", done: "I don understand", close: "Close guide",
      step: (i, n) => `Step ${i} of ${n}`,
      help: "How to use this site",
      steps: {
        search: ["Find your area", "Type the name of your town, village or local government for here, then tap am for the list. You go see flood risk, rain and farm advice for that place."],
        map: ["Understand the colours", "The colour wey dey the map na flood risk. Green or grey na normal, yellow na watch, orange na warning, red na severe. Tap any place for the map to see more."],
        views: ["Pick wetin fit you", "Public: everything together. Farmer: when to plant, when to harvest, and farm near river wey suppose harvest before flood come. Emergency: list for NEMA, SEMA and NGO."],
        modes: ["Change wetin the map dey show", "Flood risk, this season rain, planting time, or heat. Tap one and the map go change."],
        tabs: ["More things", "Replay: watch old floods like 2022, day by day. Model: how correct the forecast be. About: where the data come from."],
        lang: ["Your language", "Change between English, Pidgin, Hausa, Yorùbá and Igbo anytime."],
        layers: ["Change wetin the map dey show", "Tap here to change the map between flood risk, this season rain, planting time and heat, or to see satellite picture."],
        nav: ["Move around", "Home: flood picture and your area. Farm: planting, harvest and farm near river advice. Replay: watch old floods like 2022. More: emergency list, how correct e be, low-data pages and this guide."],
      },
      endT: "You don ready",
      endB: "Tap the ? button for top anytime to see this guide again.",
      lite: "Network slow or na small phone? Use the low-data pages",
      ussd: "See the basic-phone (USSD) menu",
      story: "See how much warning farmers for get for 2022",
    },
  };
  const tx = () => TXT[lang()] || TXT.en;
  const LANGS = [["en", "English"], ["pcm", "Pidgin"], ["ha", "Hausa"], ["yo", "Yorùbá"], ["ig", "Igbo"]];

  const css = `
  .tour-help{display:inline-grid;place-items:center;width:34px;height:34px;border-radius:50%;border:1.5px solid rgba(255,255,255,.55);background:transparent;color:#fff;font:700 17px/1 var(--display,system-ui);cursor:pointer;flex:none}
  .tour-help:hover,.tour-help:focus-visible{background:rgba(255,255,255,.14);outline:none}
  .tour-dim{position:fixed;inset:0;z-index:4000;background:rgba(4,16,24,.62)}
  .tour-hole{position:fixed;z-index:4001;border-radius:12px;box-shadow:0 0 0 9999px rgba(4,16,24,.62),0 0 0 3px #ffc53d;pointer-events:none;transition:all .28s cubic-bezier(.2,.8,.2,1)}
  .tour-card{position:fixed;z-index:4002;width:min(380px,calc(100vw - 24px));background:var(--surface,#fff);color:var(--ink,#0c2230);border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.35);padding:18px 18px 14px;font:15px/1.5 "Instrument Sans",system-ui,sans-serif;transition:top .28s,left .28s}
  .tour-card h2{font:700 1.2rem/1.25 var(--display,system-ui);margin:0 0 6px}
  .tour-card p{margin:0 0 12px}
  .tour-card .st{font-size:.78rem;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--accent,#0a7890);margin-bottom:4px}
  .tour-card .row{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap}
  .tour-card .row .sp{flex:1}
  .tour-card button.b{min-height:42px;padding:0 16px;border-radius:999px;border:1.5px solid var(--line,#ccd);background:transparent;color:inherit;font:600 .95rem system-ui;cursor:pointer}
  .tour-card button.p{background:var(--accent,#0a7890);border-color:var(--accent,#0a7890);color:var(--on-accent,#fff)}
  .tour-card .x{position:absolute;top:8px;right:8px;width:36px;height:36px;border:0;background:transparent;color:var(--muted,#567);font-size:22px;cursor:pointer;border-radius:50%}
  .tour-card .langs{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
  .tour-card .langs button{min-height:38px;padding:0 12px;border-radius:999px;border:1.5px solid var(--line,#ccd);background:transparent;color:inherit;font:600 .9rem system-ui;cursor:pointer}
  .tour-card .langs button.on{background:var(--accent-soft,#d8eef2);border-color:var(--accent,#0a7890)}
  .tour-card .lbl{font-size:.82rem;font-weight:700;color:var(--muted,#567);margin:0 0 6px}
  .tour-card .links{display:grid;gap:6px;margin:0 0 12px}
  .tour-card .links a{display:block;padding:10px 12px;border-radius:10px;background:var(--surface2,#eef3f3);color:inherit;text-decoration:none;font-weight:600;font-size:.93rem}
  .tour-card .links a:hover{background:var(--accent-soft,#d8eef2)}
  .tour-card.center{left:50%!important;top:50%!important;transform:translate(-50%,-50%)}
  .tour-card .dots{display:flex;gap:5px}.tour-card .dots i{width:7px;height:7px;border-radius:50%;background:var(--line,#ccd)}.tour-card .dots i.on{background:var(--accent,#0a7890)}
  @media (prefers-reduced-motion: reduce){.tour-hole,.tour-card{transition:none}}`;

  let dim, hole, card, idx = 0, steps = [], onKey;

  // Each step points at an element. "prep" makes sure it is visible first.
  function buildSteps() {
    const today = () => { const b = $("#t_today"); if (b && !b.classList.contains("on")) b.click(); };
    const sheet = () => { if (mobile() && document.body.dataset.sheet !== "half") { const g = $("#grip"); if (g && document.body.dataset.sheet === "full") g.click(); } };
    return [
      { k: "search", el: () => $(".search") },
      { k: "map", el: () => $("#legend"), prep: () => { today(); } },
      { k: "views", el: () => $("#views"), prep: () => { today(); sheet(); const v = $("#views"); v && v.scrollIntoView({ block: "nearest" }); } },
      { k: "modes", el: () => $("#modes") },
      { k: "tabs", el: () => $(".tabs"), prep: sheet },
      { k: "layers", el: () => $("#layersBtn") },
      { k: "nav", el: () => $("#mnav") },
      { k: "lang", el: () => $("#lang") },
    ].filter((s) => { const e = s.el(); return e && e.getClientRects().length && getComputedStyle(e).display !== "none"; });
  }

  function ensure() {
    if (dim) return;
    dim = document.createElement("div"); dim.className = "tour-dim";
    hole = document.createElement("div"); hole.className = "tour-hole";
    card = document.createElement("div"); card.className = "tour-card"; card.setAttribute("role", "dialog"); card.setAttribute("aria-modal", "true"); card.setAttribute("aria-labelledby", "tourTitle");
    document.body.append(dim, hole, card);
    dim.addEventListener("click", () => {});   // swallow clicks on the page behind
    onKey = (e) => { if (e.key === "Escape") end(); else if (e.key === "ArrowRight" && idx >= 0) go(idx + 1); else if (e.key === "ArrowLeft" && idx > 0) go(idx - 1); };
    document.addEventListener("keydown", onKey);
  }
  function end() {
    store.set();
    [dim, hole, card].forEach((n) => n && n.remove()); dim = hole = card = null;
    document.removeEventListener("keydown", onKey);
    const h = $(".tour-help"); h && h.focus();
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function setLang(code) {
    const sel = $("#lang"); if (!sel) return;
    sel.value = code; sel.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function welcome() {
    ensure(); idx = -1;
    hole.style.cssText = "width:0;height:0;left:50%;top:50%;box-shadow:none";
    dim.style.display = "";
    const t = tx(), cur = lang();
    card.className = "tour-card center";
    card.innerHTML = `<button class="x" aria-label="${esc(t.close)}">×</button>
      <h2 id="tourTitle">${esc(t.hi)}</h2><p>${esc(t.intro)}</p>
      <div class="lbl">${esc(t.lang)}</div>
      <div class="langs">${LANGS.map(([c, n]) => `<button data-l="${c}" class="${c === cur ? "on" : ""}">${n}</button>`).join("")}</div>
      <div class="row"><button class="b sk">${esc(t.skip)}</button><button class="b p go">${esc(t.go)}</button></div>`;
    card.querySelector(".x").onclick = end; card.querySelector(".sk").onclick = end;
    card.querySelector(".go").onclick = () => { steps = buildSteps(); go(0); };
    card.querySelectorAll(".langs button").forEach((b) => b.onclick = () => { setLang(b.dataset.l); welcome(); });
    card.querySelector(".go").focus();
  }

  function finish() {
    idx = steps.length;
    const t = tx(), l = lang();
    hole.style.boxShadow = "none"; hole.style.width = hole.style.height = "0";
    dim.style.display = "";
    card.className = "tour-card center";
    card.innerHTML = `<button class="x" aria-label="${esc(t.close)}">×</button>
      <h2 id="tourTitle">${esc(t.endT)}</h2><p>${esc(t.endB)}</p>
      <div class="links"><a href="lite/${esc(l)}/index.html">📶 ${esc(t.lite)}</a><a href="ussd.html">📱 ${esc(t.ussd)}</a><a href="story-2022.html">🌾 ${esc(t.story)}</a></div>
      <div class="row"><button class="b bk">${esc(t.back)}</button><span class="sp"></span><button class="b p dn">${esc(t.done)}</button></div>`;
    card.querySelector(".x").onclick = end; card.querySelector(".dn").onclick = end;
    card.querySelector(".bk").onclick = () => go(steps.length - 1);
    card.querySelector(".dn").focus();
  }

  function go(i) {
    if (i >= steps.length) return finish();
    if (i < 0) return welcome();
    idx = i; const s = steps[i];
    s.prep && s.prep();
    dim.style.display = "none";            // the hole's shadow does the dimming now
    setTimeout(() => place(s), mobile() ? 320 : 60);
  }

  function place(s) {
    if (!card) return;
    const el = s.el(); if (!el) return go(idx + 1);
    const t = tx(), [title, body] = t.steps[s.k];
    const r = el.getBoundingClientRect(), pad = 6;
    hole.style.cssText = `left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;
    card.className = "tour-card";
    card.innerHTML = `<button class="x" aria-label="${esc(t.close)}">×</button>
      <div class="st">${esc(t.step(idx + 1, steps.length))}</div>
      <h2 id="tourTitle">${esc(title)}</h2><p>${esc(body)}</p>
      <div class="row"><div class="dots">${steps.map((_, j) => `<i class="${j === idx ? "on" : ""}"></i>`).join("")}</div><span class="sp"></span>
      <button class="b bk">${esc(t.back)}</button><button class="b p nx">${esc(t.next)}</button></div>`;
    card.querySelector(".x").onclick = end;
    card.querySelector(".bk").onclick = () => go(idx - 1);
    card.querySelector(".nx").onclick = () => go(idx + 1);
    // Put the card below the target if there is room, otherwise above; keep it on screen.
    const cw = card.offsetWidth, ch = card.offsetHeight, vw = innerWidth, vh = innerHeight, m = 12;
    let top = r.bottom + pad + 12;
    if (top + ch > vh - m) top = r.top - pad - 12 - ch;
    if (top < m) top = Math.max(m, Math.min(vh - ch - m, r.bottom + pad + 12));
    if (top < r.bottom && top + ch > r.top) top = vh - ch - m;   // would cover the target: park at the bottom
    let left = Math.min(Math.max(m, r.left + r.width / 2 - cw / 2), vw - cw - m);
    card.style.left = left + "px"; card.style.top = Math.max(m, top) + "px";
    card.querySelector(".nx").focus();
  }

  window.addEventListener("resize", () => { if (card && idx >= 0 && idx < steps.length) place(steps[idx]); });

  function addButton() {
    const right = $(".bar-right"); if (!right || $(".tour-help")) return;
    const b = document.createElement("button");
    b.className = "tour-help"; b.type = "button"; b.textContent = "?";
    b.title = b.ariaLabel = tx().help; b.setAttribute("aria-label", tx().help);
    b.addEventListener("click", welcome);
    right.prepend(b);
  }

  function start() {
    const st = document.createElement("style"); st.textContent = css; document.head.appendChild(st);
    addButton();
    if (store.get() || /[?&#]notour\b/.test(location.href)) return;
    // Wait until the page has drawn its panel, so the steps have something to point at.
    let n = 0;
    const wait = setInterval(() => {
      if ($("#views") || $("#tab-today .warmup") || ++n > 40) { clearInterval(wait); welcome(); }
    }, 250);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
  window.NFA_TOUR = { open: welcome };
})();
