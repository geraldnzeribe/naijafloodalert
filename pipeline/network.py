"""Build the national river-monitoring network.

Candidate points are sampled every ~40 km along Nigeria's mapped rivers (Natural
Earth) plus hand-picked flood-prone communities on rivers the global dataset
misses. Each candidate is then "snapped" to the GloFAS grid cell with the
largest flow nearby, so the point sits on the real channel and not on a dry
cell next to it. Snapping is resumable: it continues across runs until done.
"""
from __future__ import annotations

import json

from shapely.geometry import Point, shape

from . import config
from .om import BudgetExhausted, Client

# Rivers / communities that the 1:10m global river layer does not include.
MANUAL = [
    ("Anambra River", 6.33, 6.85), ("Cross River", 5.96, 8.71), ("Cross River", 5.89, 7.93),
    ("Cross River", 5.05, 8.30), ("Katsina-Ala River", 7.17, 9.28), ("Imo River", 5.25, 7.40),
    ("Osun River", 7.77, 4.56), ("Ogun River", 6.65, 3.38), ("Ogun River", 7.15, 3.35),
    ("Kaduna River", 10.52, 7.43), ("Gurara River", 9.17, 7.10), ("Usuma River", 9.00, 7.30),
    ("Donga River", 7.72, 10.05), ("Taraba River", 8.43, 10.17), ("Forcados River", 5.23, 6.19),
    ("Warri River", 5.52, 5.75), ("Ikpoba River", 6.36, 5.65), ("Ebonyi River", 6.32, 8.12),
    ("Niger (Idah)", 7.11, 6.73), ("Niger (Ibaji)", 6.80, 6.70), ("Niger (Onitsha)", 6.15, 6.77),
    ("Niger (Patani)", 5.23, 6.19), ("Benue (Makurdi)", 7.74, 8.53), ("Nun River (Yenagoa)", 4.93, 6.26),
]

# Upstream of Nigeria on the Benue: releases from Lagdo Dam (Cameroon) drive many Benue floods.
# Appended last so existing candidate ids never change.
UPSTREAM = [
    ("River Benue", 9.10, 13.65, "Lagdo Dam outflow", "Cameroon"),
    ("River Benue", 9.30, 13.40, "Garoua", "Cameroon"),
    ("River Benue", 9.30, 12.90, "Benue entering Nigeria", "Cameroon/Adamawa border"),
]

SNAP_FILE = config.CACHE / "snap.json"
POINTS_FILE = config.DATA / "points.json"
SNAP_WINDOW = ("2022-09-20", "2022-10-20")   # peak of the 2022 flood


def candidates():
    ne = json.loads((config.PIPE / "geo" / "ne_river_points.json").read_text())
    out = [(n, lat, lon, None, None) for n, lat, lon in ne] + [(n, lat, lon, None, None) for n, lat, lon in MANUAL] + UPSTREAM
    return [{"cid": f"c{i:03d}", "river": n, "lat": lat, "lon": lon, "label": lab, "region": reg} for i, (n, lat, lon, lab, reg) in enumerate(out)]


def _load(path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def snap_all(client: Client) -> bool:
    """Snap as many candidates as the budget allows. Returns True when complete."""
    snaps = _load(SNAP_FILE, {})
    todo = [c for c in candidates() if c["cid"] not in snaps]
    r = config.SNAP_RADIUS_STEPS
    offs = [(i * config.SNAP_STEP, j * config.SNAP_STEP) for i in range(-r, r + 1) for j in range(-r, r + 1)]
    for c in todo:
        lats = [round(c["lat"] + a, 3) for a, _ in offs]
        lons = [round(c["lon"] + b, 3) for _, b in offs]
        try:
            res = client.flood(lats, lons, daily="river_discharge", start_date=SNAP_WINDOW[0], end_date=SNAP_WINDOW[1])
        except BudgetExhausted:
            break
        best = None
        for k, item in enumerate(res):
            vals = [v for v in (item.get("daily", {}).get("river_discharge") or []) if v is not None]
            peak = max(vals) if vals else 0.0
            if best is None or peak > best[0]:
                best = (peak, lats[k], lons[k])
        snaps[c["cid"]] = {"lat": best[1], "lon": best[2], "peak2022": round(best[0], 1)}
        SNAP_FILE.parent.mkdir(parents=True, exist_ok=True)
        SNAP_FILE.write_text(json.dumps(snaps, indent=0))
    done = all(c["cid"] in snaps for c in candidates())
    if done:
        build_points(snaps)
    return done


def build_points(snaps: dict):
    """Turn snapped candidates into the public monitoring network (deduplicated, named)."""
    lgas = json.loads((config.DATA / "geo" / "lgas.geojson").read_text())["features"]
    shapes = [(f["properties"], shape(f["geometry"])) for f in lgas]
    seen, pts = set(), []
    for c in candidates():
        s = snaps.get(c["cid"])
        if not s or s["peak2022"] < 30:      # no real river channel here
            continue
        key = (round(s["lat"], 2), round(s["lon"], 2))
        if key in seen:
            continue
        seen.add(key)
        p = Point(s["lon"], s["lat"])
        props = next((pr for pr, g in shapes if g.contains(p)), None)
        if props is None:
            props = min(shapes, key=lambda t: t[1].distance(p))[0]
        pts.append({
            "id": f"p{len(pts):03d}", "name": c.get("label") or props["name"], "state": c.get("region") or props["state"], "lga": props["id"],
            "river": c["river"], "lat": s["lat"], "lon": s["lon"], "peak2022": s["peak2022"],
            **({"upstream": True} if c.get("label") else {}),
        })
    config.DATA.mkdir(parents=True, exist_ok=True)
    new = json.dumps(pts, separators=(",", ":"))
    if not POINTS_FILE.exists() or POINTS_FILE.read_text() != new:
        (config.DATA / "lga_links.json").unlink(missing_ok=True)   # rebuilt for the new network
        POINTS_FILE.write_text(new)
    return pts


def points():
    return _load(POINTS_FILE, [])
