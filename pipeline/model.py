"""Machine-learning flood-probability model.

For every river point we know the daily discharge since 2012. From that we
learn, across all points at once, how likely a river is to rise above its own
"Watch" (90th percentile) or "Warning" (98th percentile) level within the next
3, 7 or 14 days, given what it and the rivers around it are doing today.

Inputs are scale-free (flows divided by each point's own percentiles), so one
model works for small tributaries and for the Niger alike.

Model: gradient-boosted trees (scikit-learn HistGradientBoostingClassifier).
Validation: trained on years before VALID_FROM, tested on VALID_FROM onwards
(this includes the 2022 and 2024 floods), and compared with a persistence
baseline ("tomorrow looks like today").
"""
from __future__ import annotations

import json
import math
from datetime import date, datetime, timedelta, timezone

import numpy as np

from . import config

MODEL_DIR = config.CACHE / "model"
VALID_FROM = 2021
NEIGHBOUR_KM = 150
FEATURES = ["r0", "r1", "r3", "r7", "r14", "d1", "d7", "max30", "doy_s", "doy_c", "nb_r0", "nb_d7", "rain30", "rain7"]
TARGETS = {"watch": "p90", "warning": "p98"}


def thresholds(values):
    v = np.array([x for x in values if x is not None and np.isfinite(x)], dtype=float)
    if len(v) < 365 * 3:
        return None
    return {
        "p50": float(np.percentile(v, 50)), "p90": float(np.percentile(v, 100 * config.PCTL_WATCH)),
        "p98": float(np.percentile(v, 100 * config.PCTL_WARNING)), "p997": float(np.percentile(v, 100 * config.PCTL_SEVERE)),
        "n": int(len(v)),
    }


def _km(a, b):
    dy = (a["lat"] - b["lat"]) * 111.0
    dx = (a["lon"] - b["lon"]) * 111.0 * math.cos(math.radians((a["lat"] + b["lat"]) / 2))
    return math.hypot(dx, dy)


def neighbours(points):
    return {p["id"]: [q["id"] for q in points if q["id"] != p["id"] and _km(p, q) <= NEIGHBOUR_KM] for p in points}


def to_frame(series: dict, start: date, end: date):
    """dict{date: [q]} -> numpy array aligned on the full day index (NaN gaps)."""
    n = (end - start).days + 1
    arr = np.full(n, np.nan)
    for d, v in series.items():
        i = (date.fromisoformat(d) - start).days
        if 0 <= i < n and v and v[0] is not None:
            arr[i] = v[0]
    return arr


def _shift(a, k):
    out = np.full_like(a, np.nan)
    if k > 0:
        out[k:] = a[:-k]
    return out


def point_features(q, th, start, nb_r0, nb_d7, rain30, rain7):
    p50, p90 = max(th["p50"], 1e-3), max(th["p90"], 1e-3)
    r = q / p90
    n = len(q)
    doy = np.array([(start + timedelta(days=i)).timetuple().tm_yday for i in range(n)])
    max30 = np.array([np.nanmax(r[max(0, i - 29):i + 1]) if np.isfinite(r[max(0, i - 29):i + 1]).any() else np.nan for i in range(n)])
    X = np.column_stack([
        r, _shift(r, 1), _shift(r, 3), _shift(r, 7), _shift(r, 14),
        (q - _shift(q, 1)) / p50, (q - _shift(q, 7)) / p50, max30,
        np.sin(2 * np.pi * doy / 365.25), np.cos(2 * np.pi * doy / 365.25),
        nb_r0, nb_d7, rain30, rain7,
    ])
    return X


def future_max(q, lead):
    n = len(q)
    out = np.full(n, np.nan)
    for i in range(n - lead):
        w = q[i + 1:i + 1 + lead]
        if np.isfinite(w).all():
            out[i] = w.max()
    return out


def build_dataset(points, flood, th_by_id, rain_by_point, start, end):
    """Assemble features/targets for all points. rain_by_point: id -> (rain30, rain7) arrays (anomaly-normalised)."""
    nbs = neighbours(points)
    qs = {p["id"]: to_frame(flood[p["id"]], start, end) for p in points if p["id"] in flood}
    rs = {pid: q / max(th_by_id[pid]["p90"], 1e-3) for pid, q in qs.items() if th_by_id.get(pid)}
    d7s = {pid: (q - _shift(q, 7)) / max(th_by_id[pid]["p50"], 1e-3) for pid, q in qs.items() if th_by_id.get(pid)}
    n = (end - start).days + 1
    blocks = []
    for p in points:
        pid = p["id"]
        if pid not in rs:
            continue
        nb = [x for x in nbs[pid] if x in rs]
        nb_r0 = np.nanmean(np.vstack([rs[x] for x in nb]), axis=0) if nb else np.full(n, np.nan)
        nb_d7 = np.nanmean(np.vstack([d7s[x] for x in nb]), axis=0) if nb else np.full(n, np.nan)
        r30, r7 = rain_by_point.get(pid, (np.full(n, np.nan), np.full(n, np.nan)))
        X = point_features(qs[pid], th_by_id[pid], start, nb_r0, nb_d7, r30, r7)
        blocks.append((pid, X, qs[pid]))
    return blocks


def split_year(data_years):
    """First test year. History is back-filled newest year first, so early on the fixed
    VALID_FROM split would leave nothing to train on: hold out the newest ~30% of years instead."""
    ys = sorted(set(int(y) for y in data_years))
    if not ys:
        return VALID_FROM
    if ys[0] <= VALID_FROM - 4:
        return VALID_FROM
    n_test = max(2, -(-len(ys) * 3 // 10))
    return ys[-n_test] if len(ys) > n_test else ys[-1]


def train(points, flood, th_by_id, rain_by_point, start, end, history_avg=None):
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.metrics import brier_score_loss, roc_auc_score
    import joblib

    blocks = build_dataset(points, flood, th_by_id, rain_by_point, start, end)
    years = np.array([(start + timedelta(days=i)).year for i in range((end - start).days + 1)])
    have = sorted(set(int(y) for _pid, X, _q in blocks for y in np.unique(years[np.isfinite(X[:, 0])])))
    split = split_year(have)
    metrics = {"trained": datetime.now(timezone.utc).isoformat(timespec="minutes"),
               "train_years": f"{have[0] if have else start.year}-{split - 1}", "test_years": f"{split}-{end.year}",
               "points": len(blocks), "history_avg": history_avg, "leads": {}}
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    for lead in config.LEADS:
        metrics["leads"][str(lead)] = {}
        for tname, tkey in TARGETS.items():
            Xs, ys, yrs, pers = [], [], [], []
            for pid, X, q in blocks:
                fm = future_max(q, lead)
                y = fm >= th_by_id[pid][tkey]
                ok = np.isfinite(fm) & np.isfinite(X[:, 0])
                Xs.append(X[ok]); ys.append(y[ok]); yrs.append(years[ok])
                pers.append(q[ok] >= th_by_id[pid][tkey])
            X = np.vstack(Xs); y = np.concatenate(ys).astype(int); yr = np.concatenate(yrs); per = np.concatenate(pers).astype(int)
            tr, te = yr < split, yr >= split
            if y[tr].sum() < 50 or y[te].sum() < 10:
                continue
            clf = HistGradientBoostingClassifier(max_iter=250, learning_rate=0.06, max_leaf_nodes=31, l2_regularization=1.0, random_state=0)
            clf.fit(X[tr], y[tr])
            prob = clf.predict_proba(X[te])[:, 1]
            pred = prob >= 0.5
            m = _scores(y[te], pred, prob, roc_auc_score, brier_score_loss)
            m["baseline"] = _scores(y[te], per[te].astype(bool), per[te].astype(float), roc_auc_score, brier_score_loss)
            m["events_test"] = int(y[te].sum()); m["samples_test"] = int(te.sum())
            metrics["leads"][str(lead)][tname] = m
            # Refit on all years for live use.
            final = HistGradientBoostingClassifier(max_iter=250, learning_rate=0.06, max_leaf_nodes=31, l2_regularization=1.0, random_state=0)
            final.fit(X, y)
            joblib.dump(final, MODEL_DIR / f"{tname}_{lead}.joblib")
    (MODEL_DIR / "metrics.json").write_text(json.dumps(metrics, indent=1))
    return metrics


def _scores(y, pred, prob, auc, brier):
    tp = int((pred & (y == 1)).sum()); fp = int((pred & (y == 0)).sum()); fn = int((~pred & (y == 1)).sum())
    out = {
        "hit_rate": round(tp / max(tp + fn, 1), 3),
        "false_alarm_ratio": round(fp / max(tp + fp, 1), 3),
        "csi": round(tp / max(tp + fp + fn, 1), 3),
    }
    try:
        out["auc"] = round(float(auc(y, prob)), 3)
    except ValueError:
        out["auc"] = None
    out["brier"] = round(float(brier(y, prob)), 4)
    return out


def load_models():
    import joblib
    models = {}
    for lead in config.LEADS:
        for tname in TARGETS:
            f = MODEL_DIR / f"{tname}_{lead}.joblib"
            if f.exists():
                models[(tname, lead)] = joblib.load(f)
    return models


def metrics():
    try:
        return json.loads((MODEL_DIR / "metrics.json").read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def needs_training(min_years_avg: float) -> bool:
    m = metrics()
    if min_years_avg < config.MIN_YEARS_TO_TRAIN:
        return False
    if not m:
        return True
    # While history is still downloading, retrain whenever two more years have arrived
    # (or one, if the last attempt produced no usable model).
    grew = min_years_avg - (m.get("history_avg") or 0)
    empty = not any(m.get("leads", {}).values())
    if grew >= (1 if empty else 2):
        return True
    trained = datetime.fromisoformat(m["trained"])
    return datetime.now(timezone.utc) - trained > timedelta(days=30)


def predict_latest(models, blocks):
    """Return {pid: {lead: {watch: p, warning: p}}} using the last row with data."""
    out = {}
    for pid, X, _q in blocks:
        rows = np.where(np.isfinite(X[:, 0]))[0]
        if not len(rows):
            continue
        x = X[rows[-1]:rows[-1] + 1]
        res = {}
        for (tname, lead), clf in models.items():
            res.setdefault(str(lead), {})[tname] = round(float(clf.predict_proba(x)[0, 1]), 3)
        out[pid] = res
    return out
