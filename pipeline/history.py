"""Resumable back-fill of historical data.

* River discharge for every network point (Copernicus GloFAS reanalysis).
* Daily rainfall and maximum temperature for every state (ERA5 reanalysis).

Work is split into one-year chunks, newest years first, so recent floods
(2024, 2022) become available within the first runs. Progress is stored in
pipeline/cache/progress.json and continues on the next run.
"""
from __future__ import annotations

import json
from datetime import date, timedelta

from . import config, store
from .om import BudgetExhausted, Client

PROGRESS = config.CACHE / "progress.json"
FLOOD_DIR = config.CACHE / "flood"
WX_DIR = config.CACHE / "wx"
BATCH = 10   # locations per request


def _progress():
    try:
        return json.loads(PROGRESS.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {"flood": {}, "wx": {}}


def _save(p):
    PROGRESS.parent.mkdir(parents=True, exist_ok=True)
    PROGRESS.write_text(json.dumps(p, separators=(",", ":")))


def years():
    last = date.today().year
    return list(range(last, config.HISTORY_START_YEAR - 1, -1))


def _year_range(y, lag_days=1):
    # ERA5 (archive API) lags real time by about 5 days, so weather requests stop a week back;
    # the daily job fills the most recent weeks from the forecast API instead.
    end = min(date(y, 12, 31), date.today() - timedelta(days=lag_days))
    return date(y, 1, 1).isoformat(), end.isoformat()


def backfill(client: Client, points: list[dict], states: list[dict]) -> dict:
    prog = _progress()
    stats = {"flood_chunks": 0, "wx_chunks": 0}
    try:
        for y in years():
            # Each year is fetched once; the daily job keeps the latest weeks topped up.
            ys = str(y)
            todo = [p for p in points if ys not in prog["flood"].get(p["id"], [])]
            for i in range(0, len(todo), BATCH):
                batch = todo[i:i + BATCH]
                a, b = _year_range(y)
                res = client.flood([p["lat"] for p in batch], [p["lon"] for p in batch], daily="river_discharge", start_date=a, end_date=b)
                for p, item in zip(batch, res):
                    d = item.get("daily", {})
                    rows = {t: [q] for t, q in zip(d.get("time", []), d.get("river_discharge", []))}
                    store.merge(FLOOD_DIR / f"{p['id']}.csv", ["q"], rows)
                    prog["flood"].setdefault(p["id"], [])
                    if ys not in prog["flood"][p["id"]]:
                        prog["flood"][p["id"]].append(ys)
                stats["flood_chunks"] += 1
                _save(prog)
            todo = [s for s in states if ys not in prog["wx"].get(s["id"], [])]
            for i in range(0, len(todo), BATCH):
                batch = todo[i:i + BATCH]
                a, b = _year_range(y, lag_days=7)
                if b < a:      # first days of January: nothing archived yet this year
                    break
                res = client.archive([s["lat"] for s in batch], [s["lon"] for s in batch], daily="precipitation_sum,temperature_2m_max", start_date=a, end_date=b)
                for s, item in zip(batch, res):
                    d = item.get("daily", {})
                    rows = {t: [p, tx] for t, p, tx in zip(d.get("time", []), d.get("precipitation_sum", []), d.get("temperature_2m_max", []))}
                    store.merge(WX_DIR / f"{s['id']}.csv", ["rain", "tmax"], rows)
                    prog["wx"].setdefault(s["id"], [])
                    if ys not in prog["wx"][s["id"]]:
                        prog["wx"][s["id"]].append(ys)
                stats["wx_chunks"] += 1
                _save(prog)
    except BudgetExhausted:
        pass
    stats["complete_years_flood"] = completeness(prog["flood"], points)
    stats["complete_years_wx"] = completeness(prog["wx"], states)
    return stats


def completeness(done: dict, items: list[dict]) -> float:
    """Average number of finished years per item."""
    if not items:
        return 0.0
    return sum(len(done.get(i["id"], [])) for i in items) / len(items)


def load_flood(pid: str):
    return store.read(FLOOD_DIR / f"{pid}.csv")


def load_wx(sid: str):
    return store.read(WX_DIR / f"{sid}.csv")
