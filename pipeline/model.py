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
FEATURES = ["r0", "r1", "r3", "r7", "r14", "d1", "d7", "max30", "doy_s", "doy_c", "nb_r0", "nb_d7", "rain30", "rain7",
            "w0", "wmax7", "warn_over_watch", "severe_over_warn"]
THRESHOLD_GRID = np.arange(0.05, 0.95, 0.025)
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
    p50, p90, p98 = max(th["p50"], 1e-3), max(th["p90"], 1e-3), max(th["p98"], 1e-3)
    r = q / p90
    w = q / p98          # flow relative to this river's own Warning level
    n = len(q)
    doy = np.array([(start + timedelta(days=i)).timetuple().tm_yday for i in range(n)])
    max30 = np.array([np.nanmax(r[max(0, i - 29):i + 1]) if np.isfinite(r[max(0, i - 29):i + 1]).any() else np.nan for i in range(n)])
    wmax7 = np.array([np.nanmax(w[max(0, i - 6):i + 1]) if np.isfinite(w[max(0, i - 6):i + 1]).any() else np.nan for i in range(n)])
    X = np.column_stack([
        r, _shift(r, 1), _shift(r, 3), _shift(r, 7), _shift(r, 14),
        (q - _shift(q, 1)) / p50, (q - _shift(q, 7)) / p50, max30,
        np.sin(2 * np.pi * doy / 365.25), np.cos(2 * np.pi * doy / 365.25),
        nb_r0, nb_d7, rain30, rain7,
        w, wmax7, np.full(n, p98 / p90), np.full(n, max(th["p997"], 1e-3) / p98),
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
    from sklearn.metrics import brier_score_loss, roc_auc_score
    import joblib

    blocks = build_dataset(points, flood, th_by_id, rain_by_point, start, end)
    years = np.array([(start + timedelta(days=i)).year for i in range((end - start).days + 1)])
    have = sorted(set(int(y) for _pid, X, _q in blocks for y in np.unique(years[np.isfinite(X[:, 0])])))
    split = split_year(have)
    calib = split - 1     # last training year: used only to choose the alert threshold
    metrics = {"trained": datetime.now(timezone.utc).isoformat(timespec="minutes"),
               "train_years": f"{have[0] if have else start.year}-{split - 1}", "test_years": f"{split}-{end.year}",
               "points": len(blocks), "history_avg": history_avg, "features": FEATURES, "calibration_year": calib, "leads": {}}
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    evals = {}     # (target, lead) -> (model trained only on pre-test years, threshold)
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
            thr = 0.5
            fit, cal = yr < calib, yr == calib
            if y[fit].sum() >= 50 and y[cal].sum() >= 10:
                c0 = _clf().fit(X[fit], y[fit])
                pc = c0.predict_proba(X[cal])[:, 1]
                thr = float(max(THRESHOLD_GRID, key=lambda t: _scores(y[cal], pc >= t, pc, roc_auc_score, brier_score_loss)["csi"]))
            clf = _clf().fit(X[tr], y[tr])
            prob = clf.predict_proba(X[te])[:, 1]
            pred = prob >= thr
            m = _scores(y[te], pred, prob, roc_auc_score, brier_score_loss)
            m["baseline"] = _scores(y[te], per[te].astype(bool), per[te].astype(float), roc_auc_score, brier_score_loss)
            m["events_test"] = int(y[te].sum()); m["samples_test"] = int(te.sum()); m["threshold"] = round(thr, 3)
            metrics["leads"][str(lead)][tname] = m
            evals[(tname, lead)] = (clf, thr)
            # Refit on all years for live use.
            final = _clf().fit(X, y)
            joblib.dump(final, MODEL_DIR / f"{tname}_{lead}.joblib")
    (MODEL_DIR / "metrics.json").write_text(json.dumps(metrics, indent=1))
    try:
        hc = hindcast(blocks, th_by_id, evals, start, years, split, points)
        (MODEL_DIR / "hindcast.json").write_text(json.dumps(hc, separators=(",", ":")))
    except Exception as e:      # the proof page must never break training
        (MODEL_DIR / "hindcast.json").write_text(json.dumps({"error": repr(e)[:200]}))
    return metrics


def hindcast(blocks, th_by_id, evals, start, years, split, points, target="warning"):
    """How many days ahead would the model have warned of each flood it never saw?

    For every river point and every held-out year, an *event* is the first day in the
    flood season (Jul-Nov) on which the river rose above its own Warning level after at
    least 14 days below it. Using only models trained on earlier years, the lead time is
    the number of days between the first day any 3/7/14-day forecast flagged that rise
    (probability above its tuned threshold, with the event inside its forecast window)
    and the event itself. The persistence baseline has a lead time of zero by definition.
    """
    names = {p["id"]: p for p in points}
    leads = sorted(l for (t, l) in evals if t == target)
    events = []
    for pid, X, q in blocks:
        t = th_by_id[pid]["p98" if target == "warning" else "p90"]
        above = q >= t
        probs = {L: evals[(target, L)][0].predict_proba(X)[:, 1] for L in leads}
        for i in range(14, len(q)):
            d = start + timedelta(days=i)
            if years[i] < split or not (7 <= d.month <= 11) or not above[i]:
                continue
            prev = q[i - 14:i]
            if not np.isfinite(prev).all() or (prev >= t).any():
                continue
            lead = 0
            for L in leads:
                thr = evals[(target, L)][1]
                for k in range(L, 0, -1):          # earliest day whose window still covers day i
                    j = i - k
                    if j >= 0 and np.isfinite(X[j, 0]) and probs[L][j] >= thr:
                        lead = max(lead, k)
                        break
            meta = names.get(pid, {})
            events.append({"id": pid, "river": meta.get("river"), "name": meta.get("name"), "state": meta.get("state"),
                           "date": d.isoformat(), "lead": int(lead), "peak_ratio": round(float(np.nanmax(q[i:i + 30]) / t), 2)})
    n = len(events)
    ld = np.array([e["lead"] for e in events]) if n else np.array([])
    by_year = {}
    for e in events:
        y = by_year.setdefault(e["date"][:4], {"events": 0, "warned": 0, "warned3": 0})
        y["events"] += 1; y["warned"] += e["lead"] >= 1; y["warned3"] += e["lead"] >= 3
    return {
        "target": target, "test_years": f"{split}-{int(years[-1])}", "events": n,
        "warned_pct": round(100 * float((ld >= 1).mean()), 1) if n else None,
        "warned3_pct": round(100 * float((ld >= 3).mean()), 1) if n else None,
        "warned7_pct": round(100 * float((ld >= 7).mean()), 1) if n else None,
        "median_lead": float(np.median(ld)) if n else None,
        "by_year": by_year,
        "top": sorted(events, key=lambda e: (-e["peak_ratio"], e["date"]))[:25],
    }


def _clf():
    from sklearn.ensemble import HistGradientBoostingClassifier
    return HistGradientBoostingClassifier(max_iter=250, learning_rate=0.06, max_leaf_nodes=31, l2_regularization=1.0, random_state=0)


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
    m = metrics()
    if not m or m.get("features") != FEATURES:      # trained with an older feature set: retrain first
        return models
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
    if not m or m.get("features") != FEATURES or not (MODEL_DIR / "hindcast.json").exists():
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
