"""Lagdo Dam / upper Benue tracker.

Large releases from Lagdo Dam in northern Cameroon travel down the Benue into
Nigeria (Yola, Makurdi) and on to the Niger confluence at Lokoja. Watching the
river just below the dam gives downstream communities extra warning days.

Travel times are not guessed: they are estimated from the history itself by
finding the time lag that best lines up day-to-day changes in flow upstream with
those downstream during the rainy season (cross-correlation).
"""
from __future__ import annotations

import math
from datetime import date, timedelta

import numpy as np

from . import config, model

TARGETS = [("Yola", 9.21, 12.48), ("Makurdi", 7.74, 8.53), ("Lokoja", 7.80, 6.74)]
MAX_LAG = 25


def _km(a_lat, a_lon, b_lat, b_lon):
    dy = (a_lat - b_lat) * 111.0
    dx = (a_lon - b_lon) * 111.0 * math.cos(math.radians((a_lat + b_lat) / 2))
    return math.hypot(dx, dy)


def best_lag(up: np.ndarray, down: np.ndarray, months_mask: np.ndarray):
    """Lag (days) maximising correlation of 3-day flow changes; returns (lag, r) or (None, None)."""
    def change(x):
        lx = np.log(np.maximum(x, 1e-3))
        out = np.full_like(lx, np.nan)
        out[3:] = lx[3:] - lx[:-3]
        return out
    du, dd = change(up), change(down)
    best = (None, -1.0)
    for lag in range(0, MAX_LAG + 1):
        a = du[:len(du) - lag] if lag else du
        b = dd[lag:]
        m = months_mask[:len(a)] & np.isfinite(a) & np.isfinite(b)
        if m.sum() < 200:
            continue
        r = np.corrcoef(a[m], b[m])[0, 1]
        if np.isfinite(r) and r > best[1]:
            best = (lag, float(r))
    return best if best[0] is not None else (None, None)


def summary(points, flood, th, fc, today: date):
    ups = [p for p in points if p.get("upstream")]
    if not ups:
        return None
    src = max(ups, key=lambda p: p.get("peak2022", 0) if p["name"] != "Benue entering Nigeria" else -1)
    border = next((p for p in ups if p["name"] == "Benue entering Nigeria"), None)
    others = [p for p in points if not p.get("upstream")]
    start = date(config.HISTORY_START_YEAR, 1, 1)
    end = today - timedelta(days=1)
    n = (end - start).days + 1
    months = np.array([(start + timedelta(days=i)).month for i in range(n)])
    wet = (months >= 7) & (months <= 11)
    up_hist = model.to_frame(flood.get(src["id"], {}), start, end)
    out = {"source": {"id": src["id"], "name": src["name"], "lat": src["lat"], "lon": src["lon"]}, "targets": []}
    f = fc.get(src["id"])
    t = th.get(src["id"])
    if f and t:
        q = [x for d, x in zip(f["time"], f["q"]) if d >= today.isoformat() and x is not None]
        past = [x for d, x in zip(f["time"], f["q"]) if d < today.isoformat() and x is not None]
        now = q[0] if q else None
        out["source"].update({
            "q_now": _r(now), "pct_of_normal": _r(100 * now / t["p50"]) if now and t["p50"] else None,
            "trend7": _r(100 * (now - past[-7]) / past[-7]) if now and len(past) >= 7 and past[-7] else None,
            "peak30": _r(max(q)) if q else None, "watch": _r(t["p90"]), "warning": _r(t["p98"]),
            "level": 3 if now and now >= t["p997"] else 2 if now and now >= t["p98"] else 1 if now and now >= t["p90"] else 0,
        })
    if border:
        out["border"] = {"id": border["id"]}
    for name, lat, lon in TARGETS:
        if not others:
            break
        tgt = min(others, key=lambda p: _km(p["lat"], p["lon"], lat, lon))
        down = model.to_frame(flood.get(tgt["id"], {}), start, end)
        lag, r = best_lag(up_hist, down, wet) if np.isfinite(up_hist).sum() > 365 and np.isfinite(down).sum() > 365 else (None, None)
        out["targets"].append({"name": name, "point": tgt["id"], "lag_days": lag, "corr": _r(r, 2),
                               "eta": (today + timedelta(days=lag)).isoformat() if lag is not None else None})
    return out


def _r(x, nd=1):
    try:
        x = float(x)
        return round(x, nd) if np.isfinite(x) else None
    except (TypeError, ValueError):
        return None
