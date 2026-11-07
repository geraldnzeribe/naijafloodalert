"""Season monitor: is it dry season, rainy season, drought, very wet, or a heat spell?
And for farmers: have the rains properly started (planting signal)?

Everything is judged against the same state's own record for the same time of year,
so "dry" in Kano and "dry" in Bayelsa mean the same thing relative to normal.
"""
from __future__ import annotations

from datetime import date, timedelta

import numpy as np

DRY_DAY_MM = 1.0


def rolling_sum(a, w):
    out = np.full(len(a), np.nan)
    c = np.nancumsum(np.nan_to_num(a))
    valid = np.isfinite(a).astype(int)
    cv = np.cumsum(valid)
    for i in range(w - 1, len(a)):
        n_ok = cv[i] - (cv[i - w] if i >= w else 0)
        if n_ok >= int(0.9 * w):
            out[i] = c[i] - (c[i - w] if i >= w else 0)
    return out


def rolling_mean(a, w):
    s = rolling_sum(a, w)
    return s / w


def doy_index(start: date, n: int):
    return np.array([min((start + timedelta(days=i)).timetuple().tm_yday, 365) for i in range(n)])


def climatology(values, doys, years, exclude_year=None):
    """Mean and sorted sample per day-of-year (with +-7 day smoothing window)."""
    clim_mean = np.full(366, np.nan)
    samples = {}
    ok = np.isfinite(values) & (years != exclude_year if exclude_year else True)
    for d in range(1, 366):
        dist = np.minimum(np.abs(doys - d), 365 - np.abs(doys - d))
        sel = ok & (dist <= 7)
        if sel.sum() >= 30:
            v = values[sel]
            clim_mean[d] = float(np.mean(v))
            samples[d] = np.sort(v)
    return clim_mean, samples


def pct_rank(sample, x):
    if sample is None or not len(sample) or not np.isfinite(x):
        return None
    return float(np.searchsorted(sample, x) / len(sample))


def classify(rank90, rank30, normal30, in_rainy):
    if not in_rainy:
        return "dry_season"
    r = rank90 if rank90 is not None else rank30
    if r is None:
        return "unknown"
    if r <= 0.10:
        return "drought"
    if r <= 0.25:
        return "dry"
    if r >= 0.90:
        return "very_wet"
    if r >= 0.75:
        return "wet"
    return "normal"


def onset(dates, rain, lat, today: date):
    """Agronomic onset of the rains for the current year.

    Onset = first day after the earliest plausible start (1 March in the south,
    1 May north of 9 degN) when 3 days bring >= 20 mm and no 7-day dry spell
    follows within the next 21 days. Returns (status, onset_date or None).
    """
    start = date(today.year, 3, 1) if lat < 9 else date(today.year, 5, 1)
    idx = {d: i for i, d in enumerate(dates)}
    if today < start:
        return "not_started", None
    d = start
    while d <= today - timedelta(days=2):
        i = idx.get(d.isoformat())
        if i is None or i + 2 >= len(rain):
            d += timedelta(days=1)
            continue
        three = np.nansum(rain[i:i + 3])
        if three >= 20:
            after = rain[i + 3:i + 24]
            observed = len(after)
            dry_run = 0
            false_start = False
            for v in after:
                dry_run = dry_run + 1 if (not np.isfinite(v) or v < DRY_DAY_MM) else 0
                if dry_run >= 7:
                    false_start = True
                    break
            if false_start:
                d += timedelta(days=1)
                continue
            if observed >= 21:
                return "established", d
            return "starting", d
        d += timedelta(days=1)
    return "waiting", None


def assess_state(rows: dict, lat: float, today: date, forecast7: float | None):
    """rows: {date: [rain, tmax]} -> status dict for the website."""
    if not rows:
        return None
    dates = sorted(rows)
    start = date.fromisoformat(dates[0])
    n = (date.fromisoformat(dates[-1]) - start).days + 1
    rain = np.full(n, np.nan); tmax = np.full(n, np.nan)
    for d, v in rows.items():
        i = (date.fromisoformat(d) - start).days
        rain[i] = np.nan if v[0] is None else v[0]
        tmax[i] = np.nan if len(v) < 2 or v[1] is None else v[1]
    full_dates = [(start + timedelta(days=i)).isoformat() for i in range(n)]
    doys = doy_index(start, n)
    years = np.array([(start + timedelta(days=i)).year for i in range(n)])
    r30, r90, t7 = rolling_sum(rain, 30), rolling_sum(rain, 90), rolling_mean(tmax, 7)
    c30, s30 = climatology(r30, doys, years, today.year)
    c90, s90 = climatology(r90, doys, years, today.year)
    ct7, _ = climatology(t7, doys, years, today.year)
    last = int(np.where(np.isfinite(r30))[0][-1]) if np.isfinite(r30).any() else n - 1
    d = int(doys[last])
    normal30 = c30[d]
    in_rainy = bool(np.isfinite(normal30) and normal30 >= 40)
    rank30, rank90 = pct_rank(s30.get(d), r30[last]), pct_rank(s90.get(d), r90[last])
    t_anom = float(t7[last] - ct7[d]) if np.isfinite(t7[last]) and np.isfinite(ct7[d]) else None
    heat = bool((t_anom is not None and t_anom >= 2.0) or (np.isfinite(t7[last]) and t7[last] >= 40))
    o_status, o_date = onset(full_dates, rain, lat, today)
    if not in_rainy and o_status in ("waiting", "not_started"):
        plant = "dry_season"
    elif o_status == "established" and in_rainy:
        plant = "plant"
    elif o_status == "starting":
        plant = "wait_confirm"
    elif in_rainy:
        plant = "waiting"
    else:
        plant = "harvest"     # rains came earlier this year and are now ending
    return {
        "as_of": full_dates[last],
        "rain30": _r(r30[last]), "normal30": _r(normal30), "pct_normal30": _r(100 * r30[last] / normal30) if normal30 and np.isfinite(normal30) and normal30 > 0 else None,
        "rank30": _r(rank30, 2), "rank90": _r(rank90, 2),
        "tmax7": _r(t7[last]), "tmax_anom": _r(t_anom), "heat": heat,
        "status": classify(rank90, rank30, normal30, in_rainy),
        "rain_next7": _r(forecast7),
        "onset": o_date.isoformat() if o_date else None, "plant": plant,
    }


def anomaly_series(rows: dict, start: date, end: date):
    """Rain30 and rain7 relative to normal for every day (ML features)."""
    n = (end - start).days + 1
    rain = np.full(n, np.nan)
    for d, v in rows.items():
        i = (date.fromisoformat(d) - start).days
        if 0 <= i < n and v and v[0] is not None:
            rain[i] = v[0]
    doys = doy_index(start, n)
    years = np.array([(start + timedelta(days=i)).year for i in range(n)])
    out = []
    for w in (30, 7):
        rs = rolling_sum(rain, w)
        clim, _ = climatology(rs, doys, years)
        out.append(rs / np.maximum(clim[doys], 1.0))
    return out[0], out[1]


def _r(x, nd=1):
    if x is None:
        return None
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return round(x, nd) if np.isfinite(x) else None
