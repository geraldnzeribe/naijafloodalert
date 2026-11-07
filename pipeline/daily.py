"""Daily update: fetch the latest forecasts, score every river point, state and LGA,
run the ML model and write the JSON files the website reads."""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone

import numpy as np

from . import config, history, model, season, store
from .om import BudgetExhausted, Client

BATCH = 10


def _levels(q, th):
    if th is None or q is None:
        return 0
    if q >= th["p997"]:
        return 3
    if q >= th["p98"]:
        return 2
    if q >= th["p90"]:
        return 1
    return 0


def _states():
    g = json.loads((config.DATA / "geo" / "states.geojson").read_text())["features"]
    return [{"id": f["properties"]["id"], "name": f["properties"]["name"], "lat": f["properties"]["lat"], "lon": f["properties"]["lon"]} for f in g]


def fetch_point_forecasts(client: Client, points):
    """Forecast (30 d) plus the last 31 days; past days are merged into the history cache."""
    today = date.today().isoformat()
    out = {}
    for i in range(0, len(points), BATCH):
        b = points[i:i + BATCH]
        res = client.flood([p["lat"] for p in b], [p["lon"] for p in b], daily="river_discharge,river_discharge_max,river_discharge_min", past_days=31, forecast_days=30)
        for p, item in zip(b, res):
            d = item.get("daily", {})
            t = d.get("time", [])
            q, qx, qn = d.get("river_discharge", []), d.get("river_discharge_max", []), d.get("river_discharge_min", [])
            past = {t[k]: [q[k]] for k in range(len(t)) if t[k] < today and q[k] is not None}
            store.merge(history.FLOOD_DIR / f"{p['id']}.csv", ["q"], past)
            out[p["id"]] = {"time": t, "q": q, "qmax": qx, "qmin": qn}
    return out


def fetch_state_weather(client: Client, states):
    today = date.today().isoformat()
    out = {}
    for i in range(0, len(states), BATCH):
        b = states[i:i + BATCH]
        res = client.forecast([s["lat"] for s in b], [s["lon"] for s in b], daily="precipitation_sum,temperature_2m_max", past_days=92, forecast_days=7)
        for s, item in zip(b, res):
            d = item.get("daily", {})
            t, pr, tx = d.get("time", []), d.get("precipitation_sum", []), d.get("temperature_2m_max", [])
            past = {t[k]: [pr[k], tx[k]] for k in range(len(t)) if t[k] < today}
            store.merge(history.WX_DIR / f"{s['id']}.csv", ["rain", "tmax"], past)
            fut = [pr[k] or 0 for k in range(len(t)) if t[k] >= today][:7]
            out[s["id"]] = {"rain_next7": float(sum(fut)), "tmax_next7": max([tx[k] for k in range(len(t)) if t[k] >= today and tx[k] is not None] or [None]) if t else None}
    return out


def point_state(points, states_geo):
    from shapely.geometry import Point, shape
    shp = [(f["properties"]["id"], shape(f["geometry"])) for f in states_geo]
    out = {}
    for p in points:
        pt = Point(p["lon"], p["lat"])
        sid = next((sid for sid, g in shp if g.contains(pt)), None)
        out[p["id"]] = sid or min(shp, key=lambda t: t[1].distance(pt))[0]
    return out


def lga_links(points):
    """Which river points affect each LGA: points inside it or within ~10 km of its boundary."""
    from shapely.geometry import Point, shape
    lgas = json.loads((config.DATA / "geo" / "lgas.geojson").read_text())["features"]
    out = {}
    for f in lgas:
        g = shape(f["geometry"])
        near = [p["id"] for p in points if g.distance(Point(p["lon"], p["lat"])) <= 0.09]
        out[f["properties"]["id"]] = {"state": f["properties"]["state"], "points": near}
    return out


def run(client: Client, points):
    today = date.today()
    states = _states()
    states_geo = json.loads((config.DATA / "geo" / "states.geojson").read_text())["features"]
    fc, wx = {}, {}
    try:
        fc = fetch_point_forecasts(client, points)
        wx = fetch_state_weather(client, states)
    except BudgetExhausted:
        pass

    # Thresholds from each point's own record.
    flood = {p["id"]: history.load_flood(p["id"]) for p in points}
    th = {pid: model.thresholds([v[0] for v in rows.values()]) for pid, rows in flood.items()}

    # Season monitor per state.
    state_status = {}
    for s in states:
        rows = history.load_wx(s["id"])
        st = season.assess_state(rows, s["lat"], today, wx.get(s["id"], {}).get("rain_next7"))
        if st:
            st["name"] = s["name"]
            state_status[s["id"]] = st

    # ML probabilities.
    probs = {}
    models = model.load_models()
    p2s = point_state(points, states_geo)
    if models:
        start = date(config.HISTORY_START_YEAR, 1, 1)
        end = today - timedelta(days=1)
        rain_feats = {}
        anom_cache = {}
        for p in points:
            sid = p2s[p["id"]]
            if sid not in anom_cache:
                anom_cache[sid] = season.anomaly_series(history.load_wx(sid), start, end)
            rain_feats[p["id"]] = anom_cache[sid]
        valid = [p for p in points if th.get(p["id"])]
        blocks = model.build_dataset(valid, flood, th, rain_feats, start, end)
        probs = model.predict_latest(models, blocks)

    # Point results.
    pts_out = []
    for p in points:
        f = fc.get(p["id"])
        t = th.get(p["id"])
        rec = {"id": p["id"], "th": {k: round(v, 1) for k, v in t.items() if k != "n"} if t else None}
        if f:
            fut = [(d, q) for d, q in zip(f["time"], f["q"]) if d >= today.isoformat() and q is not None]
            lvl, first, peak = 0, None, (None, None)
            for d, q in fut:
                l = _levels(q, t)
                if l > lvl:
                    lvl = l
                if l >= 1 and not first:
                    first = d
                if peak[0] is None or q > peak[0]:
                    peak = (q, d)
            now_q = next((q for d, q in zip(f["time"], f["q"]) if d >= today.isoformat() and q is not None), None)
            rec.update({
                "level": lvl, "now": _levels(now_q, t), "q_now": _r(now_q), "peak": _r(peak[0]), "peak_date": peak[1], "first": first,
                "t0": f["time"][0] if f["time"] else None,
                "q": [_r(x) for x in f["q"]], "qmax": [_r(x) for x in f["qmax"]], "qmin": [_r(x) for x in f["qmin"]],
            })
        if p["id"] in probs:
            rec["ml"] = probs[p["id"]]
        pts_out.append(rec)

    # Community (LGA) level: worst nearby river point, raised by heavy rain forecast in the state.
    links_file = config.DATA / "lga_links.json"
    if not links_file.exists():
        links_file.write_text(json.dumps(lga_links(points), separators=(",", ":")))
    links = json.loads(links_file.read_text())
    by_id = {r["id"]: r for r in pts_out}
    name2sid = {s["name"]: s["id"] for s in states}
    lga_out = {}
    for lid, info in links.items():
        lv = max([by_id[pid].get("level", 0) for pid in info["points"] if pid in by_id] or [0])
        sid = name2sid.get(info["state"])
        rain7 = wx.get(sid, {}).get("rain_next7") if sid else None
        if rain7 is not None and rain7 >= 100:
            lv = max(lv, 1)
        ml = max([by_id[pid].get("ml", {}).get("7", {}).get("watch", 0) for pid in info["points"] if pid in by_id] or [0])
        lga_out[lid] = [lv, round(ml, 2)]

    generated = datetime.now(timezone.utc).isoformat(timespec="minutes")
    latest = {"generated": generated, "date": today.isoformat(), "points": pts_out, "states": state_status, "lgas": lga_out,
              "model": model.metrics()}
    (config.DATA / "latest.json").write_text(json.dumps(latest, separators=(",", ":")))
    return latest


def build_history_files(points):
    """One file per year: daily alert level per river point (for replay and animation)."""
    hist_dir = config.DATA / "history"
    hist_dir.mkdir(parents=True, exist_ok=True)
    flood = {p["id"]: history.load_flood(p["id"]) for p in points}
    th = {pid: model.thresholds([v[0] for v in rows.values()]) for pid, rows in flood.items()}
    index = []
    for y in range(config.HISTORY_START_YEAR, date.today().year + 1):
        start, end = date(y, 1, 1), min(date(y, 12, 31), date.today() - timedelta(days=1))
        n = (end - start).days + 1
        levels, flows, have = {}, {}, 0
        for p in points:
            t = th.get(p["id"])
            rows = flood[p["id"]]
            arr = model.to_frame(rows, start, end)
            if not np.isfinite(arr).any() or t is None:
                continue
            have += 1
            levels[p["id"]] = "".join(str(_levels(v, t)) if np.isfinite(v) else "." for v in arr)
            flows[p["id"]] = [None if not np.isfinite(v) else int(round(v)) for v in arr[::3]]   # every 3rd day for sparklines
        if not have:
            continue
        counts = [sum(1 for s in levels.values() if i < len(s) and s[i] in "123") for i in range(n)]
        peak_i = int(np.argmax(counts)) if counts else 0
        doc = {"year": y, "start": start.isoformat(), "days": n, "levels": levels, "flows3": flows,
               "above_normal_by_day": counts, "worst_day": (start + timedelta(days=peak_i)).isoformat(), "worst_count": counts[peak_i] if counts else 0}
        (hist_dir / f"{y}.json").write_text(json.dumps(doc, separators=(",", ":")))
        index.append({"year": y, "points": have, "worst_day": doc["worst_day"], "worst_count": doc["worst_count"],
                      "flood_point_days": int(sum(counts))})
    (hist_dir / "index.json").write_text(json.dumps(index, separators=(",", ":")))
    return index


def _r(x):
    if x is None:
        return None
    try:
        return round(float(x), 1)
    except (TypeError, ValueError):
        return None
