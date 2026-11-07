"""Offline end-to-end test of the pipeline with a fake Open-Meteo.

Run:  python -m pytest -q tests/test_pipeline.py   (or: python tests/test_pipeline.py)
"""
import json
import math
import random
import shutil
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from pipeline import config  # noqa: E402


class FakeResp:
    def __init__(self, data, code=200):
        self._d, self.status_code = data, code

    def json(self):
        return self._d

    def raise_for_status(self):
        pass


def _flow(lat, lon, d: date):
    base = 50 + 400 * abs(math.sin(lat * 3 + lon))           # each cell has its own size
    if round(lat * 20) % 3 == 0 and round(lon * 20) % 2 == 0:  # make some cells "the river"
        base *= 8
    doy = d.timetuple().tm_yday
    season = 1 + 2.5 * math.exp(-((doy - 270) ** 2) / (2 * 30 ** 2))
    flood_year = 1.8 if d.year in (2018, 2022, 2024) else 1.0
    rnd = random.Random(f"{lat:.2f}{lon:.2f}{d.isoformat()}").random()
    return round(base * season * (flood_year if 240 < doy < 300 else 1) * (0.9 + 0.2 * rnd), 2)


def _rain(lat, d: date):
    doy = d.timetuple().tm_yday
    wet = math.exp(-((doy - 220) ** 2) / (2 * (60 if lat < 9 else 35) ** 2))
    r = random.Random(f"{lat:.2f}{d.isoformat()}r").random()
    return round(max(0.0, 25 * wet * (r - 0.35)), 1)


def _days(params):
    if "start_date" in params:
        a, b = date.fromisoformat(params["start_date"]), date.fromisoformat(params["end_date"])
    else:
        a = date.today() - timedelta(days=int(params.get("past_days", 0)))
        b = date.today() + timedelta(days=int(params.get("forecast_days", 7)) - 1)
    return [a + timedelta(days=i) for i in range((b - a).days + 1)]


class FakeSession:
    headers = {}

    def get(self, url, params, timeout=None):
        lats = [float(x) for x in params["latitude"].split(",")]
        lons = [float(x) for x in params["longitude"].split(",")]
        days = _days(params)
        out = []
        for la, lo in zip(lats, lons):
            if "flood" in url:
                q = [_flow(la, lo, d) for d in days]
                daily = {"time": [d.isoformat() for d in days], "river_discharge": q,
                         "river_discharge_max": [x * 1.1 for x in q], "river_discharge_min": [x * 0.9 for x in q]}
            else:
                daily = {"time": [d.isoformat() for d in days], "precipitation_sum": [_rain(la, d) for d in days],
                         "temperature_2m_max": [32 + 4 * math.sin(d.timetuple().tm_yday / 58) for d in days]}
            out.append({"daily": daily})
        return FakeResp(out if len(out) > 1 else out[0])


def run_test():
    tmp = Path(tempfile.mkdtemp())
    shutil.copytree(ROOT / "pipeline", tmp / "pipeline", ignore=shutil.ignore_patterns("cache", "__pycache__"))
    shutil.copytree(ROOT / "site" / "data" / "geo", tmp / "site" / "data" / "geo")
    config.PIPE, config.CACHE, config.SITE, config.DATA = tmp / "pipeline", tmp / "pipeline" / "cache", tmp / "site", tmp / "site" / "data"
    config.HISTORY_START_YEAR = date.today().year - 8
    config.MIN_YEARS_TO_TRAIN = 6
    config.RUN_BUDGET = 10 ** 9
    from pipeline import daily, history, model, network, run as runmod
    for mod in (network, history, model, daily):
        for name in ("SNAP_FILE", "POINTS_FILE", "PROGRESS", "FLOOD_DIR", "WX_DIR", "MODEL_DIR"):
            if hasattr(mod, name):
                old = getattr(mod, name)
                setattr(mod, name, Path(str(old).replace(str(ROOT), str(tmp))))
    # keep the test quick: only the first 25 candidates
    allc = network.candidates()
    cands = allc[:25] + allc[-3:]
    network.candidates = lambda: cands
    from pipeline import om
    real_client = om.Client
    runmod.Client = lambda: real_client(session=FakeSession(), sleep=lambda s: None)
    runmod.main()
    runmod.main()   # second run the same day must reuse today's forecast
    status = json.loads((config.DATA / "status.json").read_text())
    latest = json.loads((config.DATA / "latest.json").read_text())
    idx = json.loads((config.DATA / "history" / "index.json").read_text())
    pts = json.loads((config.DATA / "points.json").read_text())
    assert status["last"]["points"] == len(pts) > 5, status
    assert len(latest["points"]) == len(pts)
    assert all("level" in p for p in latest["points"]), "every point scored"
    assert len(latest["states"]) >= 30, len(latest["states"])
    assert len(latest["lgas"]) == 774
    assert (config.DATA / "lga_links.json").exists(), "lga links survive a second run"
    assert idx and idx[0]["year"] == config.HISTORY_START_YEAR
    m = latest["model"]
    assert m and m["leads"], "model trained"
    assert any("ml" in p for p in latest["points"]), "ml probabilities present"
    print("points", len(pts), "| levels", status["last"]["levels"], "| years", [i["year"] for i in idx])
    print("model leads:", {k: {t: (v["auc"], v["baseline"]["auc"]) for t, v in d.items()} for k, d in m["leads"].items()})
    print("sample state:", next(iter(latest["states"].values())))
    lg = latest.get("lagdo")
    assert lg and lg.get("targets"), lg
    print("lagdo:", lg["source"].get("name"), [(t["name"], t["lag_days"], t["corr"]) for t in lg["targets"]])
    st = next(iter(latest["states"].values()))
    assert "dry_run" in st and st.get("rain_days") is not None, st
    print("PIPELINE TEST PASSED")
    return tmp


if __name__ == "__main__":
    run_test()
