"""Tiny CSV time-series store (one file per series), committed to the repo."""
from __future__ import annotations

import csv
from pathlib import Path


def read(path: Path) -> dict[str, list]:
    """Return {date: [values...]} for a CSV with header date,col1,col2..."""
    out = {}
    if not path.exists():
        return out
    with path.open() as f:
        r = csv.reader(f)
        next(r, None)
        for row in r:
            if row:
                out[row[0]] = [None if v == "" else float(v) for v in row[1:]]
    return out


def write(path: Path, cols: list[str], rows: dict[str, list]):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", *cols])
        for d in sorted(rows):
            w.writerow([d, *["" if v is None else (round(v, 2) if isinstance(v, float) else v) for v in rows[d]]])


def merge(path: Path, cols: list[str], new: dict[str, list]):
    rows = read(path)
    rows.update(new)
    write(path, cols, rows)
    return rows
