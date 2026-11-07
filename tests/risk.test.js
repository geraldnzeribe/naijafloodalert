// Run: node tests/risk.test.js
const assert = require("assert");
const R = require("../risk.js");
const hist = Array.from({ length: 1000 }, (_, i) => i + 1); // 1..1000
const th = R.thresholds(hist);
assert(Math.abs(th.p90 - 900.1) < 1 && Math.abs(th.p98 - 980.02) < 1, "percentiles");
const days = (qs) => qs.map((q, i) => ({ date: `2026-11-${String(8 + i).padStart(2, "0")}`, q }));
const dry = [{ date: "2026-11-08", mm: 2 }];
assert.strictEqual(R.assess(days([100, 200, 300]), th, dry, "river").level, 0);
assert.strictEqual(R.assess(days([100, 950, 300]), th, dry, "river").level, 1);
let a = R.assess(days([100, 990, 1000]), th, dry, "river");
assert.strictEqual(a.level, 3); assert.strictEqual(a.peakDate, "2026-11-10"); assert.strictEqual(a.firstDate, "2026-11-09");
const wet = Array.from({ length: 7 }, (_, i) => ({ date: "2026-11-0" + (i + 1), mm: 20 }));
assert.strictEqual(R.assess(days([100]), th, wet, "urban").level, 1, "rain alone urban -> watch");
assert.strictEqual(R.assess(days([950]), th, wet, "urban").level, 2, "rain bumps urban");
assert.strictEqual(R.assess(days([950]), th, wet, "river").level, 1, "rain does not bump river beyond watch");
assert.strictEqual(R.assess(days([null, null]), { p90: null }, dry, "urban").level, 0, "no river data");
const site = { name: "Lokoja", state: "Kogi", river: "Niger–Benue confluence" };
console.log(R.message(site, a, "en")); console.log(R.message(site, a, "pcm"));
console.log(R.message(site, R.assess(days([100]), th, dry, "river"), "en"));
console.log("all tests passed");
