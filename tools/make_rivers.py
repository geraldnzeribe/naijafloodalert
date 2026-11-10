"""One-off helper: build site/data/geo/rivers.geojson for the animated river layer.

Not part of the daily pipeline. Source: Natural Earth 10m river centre-lines (public domain),
clipped to Nigeria plus the upper Benue in Cameroon, merged per river, ordered source -> mouth
and simplified. The Cross River, which Natural Earth does not carry, is sketched through its gauge points
and flagged "approx".

    python3 tools/make_rivers.py ne_10m_rivers_lake_centerlines.geojson
"""
import json, math, sys
from pathlib import Path
from shapely.geometry import LineString, MultiLineString, box, shape, Point
from shapely.ops import linemerge, unary_union

ROOT = Path(__file__).resolve().parents[1]
BOX = box(2.3, 3.9, 14.75, 14.1)
KEEP = {"Ogun": "Ogun", "Bénoué": "Benue", "Benue": "Benue", "Chari": "Chari", "Kaduna": "Kaduna", "Sokoto": "Sokoto", "Mariga": "Mariga",
        "Niger": "Niger", "Bunga": "Jama'are", "Gongola": "Gongola", "Komadugu Yobe": "Komadugu Yobe", "Hadejia": "Hadejia"}
SIZE = {"Niger": 3, "Benue": 3, "Kaduna": 2, "Sokoto": 2, "Gongola": 2, "Komadugu Yobe": 2, "Chari": 2, "Cross River": 2}
SEA = Point(6.1, 4.3)       # Niger delta
CHAD = Point(14.2, 13.2)    # Lake Chad
CHAD_BASIN = {"Komadugu Yobe", "Hadejia", "Jama'are", "Chari"}
TRUNK = {"Niger", "Benue", "Kaduna", "Komadugu Yobe", "Chari", "Ogun", "Cross River"}  # mouth = end nearest the outlet


def parts(g):
    return list(g.geoms) if g.geom_type.startswith("Multi") or g.geom_type == "GeometryCollection" else [g]


def main(src):
    doc = json.load(open(src, encoding="utf-8"))
    by = {}
    for f in doc["features"]:
        if not f["geometry"]:
            continue
        name = KEEP.get(f["properties"].get("name"))
        g = shape(f["geometry"])
        if not name or not g.intersects(BOX):
            continue
        by.setdefault(name, []).append(g.intersection(BOX))
    lines = []
    for name, gs in by.items():
        u = unary_union([p for g in gs for p in parts(g) if p.geom_type == "LineString"])
        merged = linemerge(u) if u.geom_type == "MultiLineString" else u
        for ln in parts(merged):
            if ln.length < 0.15:
                continue
            lines.append([name, ln])
    # gauge-point sketches for rivers missing from Natural Earth
    pts = json.load(open(ROOT / "site/data/points.json"))
    # Cross River: enters from Cameroon, bends west past Ikom towards Afikpo, then south to Calabar
    lines.append(["Cross River", LineString([(8.95, 5.85), (8.61, 5.96), (8.2, 5.98), (7.93, 5.79), (8.02, 5.4), (8.3, 4.95), (8.33, 4.62)])])
    # orient every line source -> mouth
    out = []
    for i, (name, ln) in enumerate(lines):
        a, b = Point(ln.coords[0]), Point(ln.coords[-1])
        others = unary_union([l for j, (_, l) in enumerate(lines) if j != i])
        outlet = CHAD if name in CHAD_BASIN else SEA
        if name in TRUNK:
            flip = a.distance(outlet) < b.distance(outlet)
        else:
            flip = a.distance(others) < b.distance(others)
        coords = list(ln.simplify(0.004).coords)
        if flip:
            coords.reverse()
        out.append({"type": "Feature", "properties": {"name": name, "size": SIZE.get(name, 1), **({"approx": True} if name == "Cross River" else {})},
                    "geometry": {"type": "LineString", "coordinates": [[round(x, 3), round(y, 3)] for x, y in coords]}})
    dst = ROOT / "site/data/geo/rivers.geojson"
    dst.write_text(json.dumps({"type": "FeatureCollection", "features": out}, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    print(dst, dst.stat().st_size, "bytes", len(out), "lines")
    for f in out:
        c = f["geometry"]["coordinates"]
        print(f"  {f['properties']['name']:<16} {len(c):>4} pts  {c[0]} -> {c[-1]}")


if __name__ == "__main__":
    main(sys.argv[1])
