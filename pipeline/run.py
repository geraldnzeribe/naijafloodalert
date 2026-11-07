"""Entry point used by the GitHub Actions workflow.

Each run, with no human involved:
1. builds / finishes the river network (first runs only),
2. spends spare API budget back-filling history (newest years first),
3. (re)trains the ML model monthly once enough history exists,
4. fetches today's forecasts and scores every river point, state and LGA,
5. rebuilds the yearly replay files,
6. writes site/data/status.json so anyone can see the system is alive.
"""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta, timezone

from . import config, daily, history, model, network, season
from .om import Client


def main():
    client = Client()
    log = {"started": datetime.now(timezone.utc).isoformat(timespec="minutes")}
    complete = network.snap_all(client)
    pts = network.points()
    log["network_complete"] = complete
    log["points"] = len(pts)
    states = daily._states()

    if pts:
        # Today's forecasts are fetched once per day; keep budget for them on the first run.
        try:
            already = json.loads((config.DATA / "latest.json").read_text()).get("date") == date.today().isoformat()
        except (FileNotFoundError, json.JSONDecodeError):
            already = False
        reserve = 0 if already else 1200
        client.budget -= reserve
        bf = history.backfill(client, pts, states)
        client.budget += reserve
        log["backfill"] = bf
        if model.needs_training(bf["complete_years_flood"]):
            start = date(config.HISTORY_START_YEAR, 1, 1)
            end = date.today() - timedelta(days=1)
            flood = {p["id"]: history.load_flood(p["id"]) for p in pts}
            th = {pid: model.thresholds([v[0] for v in rows.values()]) for pid, rows in flood.items()}
            p2s = daily.point_state(pts, json.loads((config.DATA / "geo" / "states.geojson").read_text())["features"])
            cache, rain = {}, {}
            for p in pts:
                sid = p2s[p["id"]]
                if sid not in cache:
                    cache[sid] = season.anomaly_series(history.load_wx(sid), start, end)
                rain[p["id"]] = cache[sid]
            valid = [p for p in pts if th.get(p["id"])]
            m = model.train(valid, flood, th, rain, start, end)
            log["trained"] = {k: v for k, v in m.items() if k != "leads"}
        trained_now = "trained" in log
        if already and not trained_now:
            latest = json.loads((config.DATA / "latest.json").read_text())
        else:
            latest = daily.run(client, pts)
        log["levels"] = {str(k): sum(1 for p in latest["points"] if p.get("level") == k) for k in range(4)}
        idx = daily.build_history_files(pts)
        log["history_years"] = [i["year"] for i in idx]
    log["api_calls_used"] = round(client.used)
    log["finished"] = datetime.now(timezone.utc).isoformat(timespec="minutes")
    status_file = config.DATA / "status.json"
    try:
        prev = json.loads(status_file.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        prev = {"runs": []}
    prev["last"] = log
    prev["runs"] = ([{"t": log["finished"], "calls": log["api_calls_used"], "points": log["points"]}] + prev.get("runs", []))[:60]
    prev["badge"] = {"schemaVersion": 1, "label": "data updated", "message": log["finished"][:10], "color": "1565c0"}
    status_file.write_text(json.dumps(prev, indent=1))
    print(json.dumps(log, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
