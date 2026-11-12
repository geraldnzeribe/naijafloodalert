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
    try:
        return _main()
    except Exception as e:   # never leave the site without a status; the error shows on GitHub Actions too
        _write_status({"started": datetime.now(timezone.utc).isoformat(timespec="minutes"), "error": repr(e)[:500],
                       "finished": datetime.now(timezone.utc).isoformat(timespec="minutes"), "points": len(network.points()), "api_calls_used": 0})
        raise


def _main():
    client = Client()
    log = {"started": datetime.now(timezone.utc).isoformat(timespec="minutes")}
    complete = network.snap_all(client)
    pts = network.points()
    log["network_complete"] = complete
    log["points"] = len(pts)
    states = daily._states()

    if pts:
        # 1) Today's forecast comes first, so the map is never empty because history used the quota.
        try:
            prev = json.loads((config.DATA / "latest.json").read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            prev = {}
        fresh = (prev.get("date") == date.today().isoformat()
                 and len(prev.get("points", [])) == len(pts)
                 and any(p.get("q") for p in prev.get("points", []))
                 and (config.DATA / "lga_links.json").exists())
        latest = prev if fresh else daily.run(client, pts)
        log["daily"] = "reused" if fresh else "fetched"
        # 2) History with whatever budget is left.
        bf = history.backfill(client, pts, states)
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
            m = model.train(valid, flood, th, rain, start, end, history_avg=round(bf["complete_years_flood"], 2))
            log["trained"] = {k: v for k, v in m.items() if k != "leads"}
        # 3) Re-score today's data with the new history (no extra API calls).
        if bf["flood_chunks"] or bf["wx_chunks"] or "trained" in log:
            latest = daily.rescore(pts)
        log["levels"] = {str(k): sum(1 for p in latest["points"] if p.get("level") == k) for k in range(4)}
        idx = daily.build_history_files(pts)
        log["history_years"] = [i["year"] for i in idx]
    log["api_calls_used"] = round(client.used)
    log["finished"] = datetime.now(timezone.utc).isoformat(timespec="minutes")
    _write_status(log)
    print(json.dumps(log, indent=1))
    return 0


def _write_status(log):
    status_file = config.DATA / "status.json"
    try:
        prev = json.loads(status_file.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        prev = {"runs": []}
    prev["last"] = log
    prev["runs"] = ([{"t": log["finished"], "calls": log["api_calls_used"], "points": log["points"]}] + prev.get("runs", []))[:60]
    prev["badge"] = {"schemaVersion": 1, "label": "data updated", "message": log["finished"][:10], "color": "1565c0"}
    status_file.parent.mkdir(parents=True, exist_ok=True)
    status_file.write_text(json.dumps(prev, indent=1))


if __name__ == "__main__":
    sys.exit(main())
