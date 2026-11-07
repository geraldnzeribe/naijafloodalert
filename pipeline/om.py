"""Small Open-Meteo client with retries and a weighted-call budget.

Open-Meteo counts a request as several calls when it asks for many locations,
long date ranges or many variables. We estimate that weight up front so one run
never blows through the free daily quota, and stop gracefully if we get a 429.
"""
from __future__ import annotations

import time
from datetime import date

import requests

from . import config


class BudgetExhausted(Exception):
    pass


def weight(n_locations: int, n_days: int, n_vars: int) -> float:
    per_loc = max(1.0, n_days / 14.0) * max(1.0, n_vars / 10.0)
    return n_locations * per_loc


class Client:
    def __init__(self, budget: float = config.RUN_BUDGET, session: requests.Session | None = None, sleep=time.sleep):
        self.budget = budget
        self.used = 0.0
        self.session = session or requests.Session()
        self.session.headers["User-Agent"] = "NaijaFloodAlert/2.0 (+https://github.com/geraldnzeribe/naijafloodalert)"
        self._sleep = sleep
        self._minute_start = time.time()
        self._minute_used = 0.0
        self.blocked = False

    def remaining(self) -> float:
        return self.budget - self.used

    def can_afford(self, w: float) -> bool:
        return not self.blocked and self.used + w <= self.budget

    def _pace(self, w: float):
        now = time.time()
        if now - self._minute_start >= 60:
            self._minute_start, self._minute_used = now, 0.0
        if self._minute_used + w > config.PER_MINUTE:
            self._sleep(max(0.0, 61 - (now - self._minute_start)))
            self._minute_start, self._minute_used = time.time(), 0.0
        self._minute_used += w

    def get(self, url: str, params: dict, w: float):
        if not self.can_afford(w):
            raise BudgetExhausted(f"budget {self.budget} reached (used {self.used:.0f})")
        self._pace(w)
        for attempt in range(4):
            try:
                r = self.session.get(url, params=params, timeout=90)
            except requests.RequestException:
                self._sleep(5 * (attempt + 1))
                continue
            if r.status_code == 429:
                # Daily/hourly limit hit: stop spending for this run.
                self.blocked = True
                raise BudgetExhausted("Open-Meteo rate limit (429)")
            if r.status_code >= 500:
                self._sleep(10 * (attempt + 1))
                continue
            r.raise_for_status()
            self.used += w
            j = r.json()
            return j if isinstance(j, list) else [j]
        raise RuntimeError(f"failed after retries: {url}")

    # ---- convenience wrappers -------------------------------------------------
    def flood(self, lats, lons, **params):
        n_days = _span_days(params)
        w = weight(len(lats), n_days, len(params.get("daily", "").split(",")))
        p = {"latitude": ",".join(f"{x:.3f}" for x in lats), "longitude": ",".join(f"{x:.3f}" for x in lons), **params}
        return self.get(config.FLOOD_API, p, w)

    def forecast(self, lats, lons, **params):
        n_days = _span_days(params)
        w = weight(len(lats), n_days, len(params.get("daily", "").split(",")))
        p = {"latitude": ",".join(f"{x:.3f}" for x in lats), "longitude": ",".join(f"{x:.3f}" for x in lons), "timezone": "Africa/Lagos", **params}
        return self.get(config.FORECAST_API, p, w)

    def archive(self, lats, lons, **params):
        n_days = _span_days(params)
        w = weight(len(lats), n_days, len(params.get("daily", "").split(",")))
        p = {"latitude": ",".join(f"{x:.3f}" for x in lats), "longitude": ",".join(f"{x:.3f}" for x in lons), "timezone": "Africa/Lagos", **params}
        return self.get(config.ARCHIVE_API, p, w)


def _span_days(params: dict) -> int:
    if "start_date" in params and "end_date" in params:
        a = date.fromisoformat(params["start_date"])
        b = date.fromisoformat(params["end_date"])
        return (b - a).days + 1
    return int(params.get("past_days", 0)) + int(params.get("forecast_days", 7))
