#!/usr/bin/env python3
"""Build data/lines.json: the track path of every subway line, for the map.

Source: MTA New York City Transit static GTFS (regular subway schedule)
https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip
(listed at https://www.mta.info/developers)

Usage:
    python3 scripts/prepare_lines.py --download        # fetch the GTFS zip, then convert
    python3 scripts/prepare_lines.py --zip path.zip    # convert a zip you already have

Only weekday daytime trips (first departure 06:00-21:00) count, so lines show
their assigned daytime routes, matching "Daytime Routes" in the station data.
Express variants (6X, 7X, FX) are merged into their line. Each line keeps only
the parts of its track shapes not already drawn, then the paths are simplified.

Uses only the Python standard library.
"""

import argparse
import csv
import datetime as dt
import io
import json
import math
import sys
import urllib.request
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

GTFS_URL = "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip"
SOURCE_URL = "https://www.mta.info/developers"

ROOT = Path(__file__).resolve().parent.parent
OUT_JSON = ROOT / "data" / "lines.json"
DEFAULT_ZIP = ROOT / "data" / "raw" / "gtfs_subway.zip"

LAT_MIN, LAT_MAX = 40.45, 40.95
LON_MIN, LON_MAX = -74.30, -73.68

MERGE = {"6X": "6", "7X": "7", "FX": "F"}
DAY_START, DAY_END = 6 * 3600, 21 * 3600
MIN_SHARE = 0.03  # drop shapes used by under 3% of a line's daytime trips
COVERED_M = 40  # a point this close to an already-drawn path is a duplicate
SIMPLIFY_M = 6

M_PER_DEG_LAT = 111_320
M_PER_DEG_LON = M_PER_DEG_LAT * math.cos(math.radians(40.73))


def read_csv(zf: zipfile.ZipFile, name: str):
    with zf.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def seconds(hms: str) -> int:
    h, m, s = (int(x) for x in hms.split(":"))
    return h * 3600 + m * 60 + s


def xy(p):  # local planar meters, fine at city scale
    return p[1] * M_PER_DEG_LON, p[0] * M_PER_DEG_LAT


def seg_dist(p, a, b) -> float:
    (px, py), (ax, ay), (bx, by) = xy(p), xy(a), xy(b)
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


class SegmentIndex:
    """Grid of drawn segments, to test whether a point is already covered."""

    CELL = 0.002  # degrees, about 200 m

    def __init__(self):
        self.grid = defaultdict(list)

    def _cell(self, p):
        return int(p[0] // self.CELL), int(p[1] // self.CELL)

    def add(self, path):
        for a, b in zip(path, path[1:]):
            (r0, c0), (r1, c1) = self._cell(a), self._cell(b)
            for r in range(min(r0, r1), max(r0, r1) + 1):
                for c in range(min(c0, c1), max(c0, c1) + 1):
                    self.grid[r, c].append((a, b))

    def covered(self, p) -> bool:
        r, c = self._cell(p)
        return any(
            seg_dist(p, a, b) <= COVERED_M
            for dr in (-1, 0, 1) for dc in (-1, 0, 1)
            for a, b in self.grid.get((r + dr, c + dc), ())
        )


def simplify(path, tol=SIMPLIFY_M):
    """Douglas-Peucker."""
    if len(path) < 3:
        return path
    keep = [False] * len(path)
    keep[0] = keep[-1] = True
    stack = [(0, len(path) - 1)]
    while stack:
        i, j = stack.pop()
        best, k = 0.0, None
        for m in range(i + 1, j):
            d = seg_dist(path[m], path[i], path[j])
            if d > best:
                best, k = d, m
        if k is not None and best > tol:
            keep[k] = True
            stack += [(i, k), (k, j)]
    return [p for p, kept in zip(path, keep) if kept]


def new_parts(path, index):
    """Runs of the path not yet drawn, each extended one point to join up."""
    flags = [not index.covered(p) for p in path]
    parts, i = [], 0
    while i < len(path):
        if not flags[i]:
            i += 1
            continue
        j = i
        while j < len(path) and flags[j]:
            j += 1
        part = path[max(i - 1, 0):min(j + 1, len(path))]
        if len(part) >= 2:
            parts.append(part)
        i = j
    return parts


def convert(zip_path: Path) -> dict:
    with zipfile.ZipFile(zip_path) as zf:
        weekday = {r["service_id"] for r in read_csv(zf, "calendar.txt")
                   if all(r[d] == "1" for d in ("monday", "tuesday", "wednesday", "thursday", "friday"))}
        trips = {r["trip_id"]: r for r in read_csv(zf, "trips.txt") if r["service_id"] in weekday}
        first = {}  # trip_id -> (stop_sequence, departure seconds)
        for r in read_csv(zf, "stop_times.txt"):
            tid = r["trip_id"]
            if tid in trips:
                seq = int(r["stop_sequence"])
                if tid not in first or seq < first[tid][0]:
                    first[tid] = (seq, seconds(r["departure_time"]))
        shapes = defaultdict(list)
        for r in read_csv(zf, "shapes.txt"):
            shapes[r["shape_id"]].append((int(r["shape_pt_sequence"]), float(r["shape_pt_lat"]), float(r["shape_pt_lon"])))
        feed = next(read_csv(zf, "feed_info.txt"), {})

    usage = defaultdict(Counter)  # route -> shape -> daytime trips
    for tid, trip in trips.items():
        if tid in first and DAY_START <= first[tid][1] < DAY_END and trip["shape_id"]:
            route = MERGE.get(trip["route_id"], trip["route_id"])
            usage[route][trip["shape_id"]] += 1

    routes = {}
    for route in sorted(usage):
        counts = usage[route]
        total = sum(counts.values())
        index, parts = SegmentIndex(), []
        for shape_id, n in counts.most_common():
            if n < total * MIN_SHARE or shape_id not in shapes:
                continue
            path = [(lat, lon) for _, lat, lon in sorted(shapes[shape_id])]
            if not all(LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX for lat, lon in path):
                sys.exit(f"{route}: shape {shape_id} has points outside NYC")
            for part in new_parts(path, index):
                index.add(part)
                parts.append(part)
        # Flat [lat, lon, lat, lon, ...] arrays keep the file small.
        routes[route] = [[round(v, 5) for p in simplify(part) for v in p] for part in parts]
        if not routes[route]:
            sys.exit(f"{route}: no daytime track shapes")

    downloaded = dt.datetime.fromtimestamp(zip_path.stat().st_mtime, dt.timezone.utc)
    return {
        "source": "MTA New York City Transit static GTFS (subway)",
        "sourceUrl": SOURCE_URL,
        "feedVersion": feed.get("feed_version", ""),
        "sourceDownloaded": downloaded.date().isoformat(),
        "generated": dt.datetime.now(dt.timezone.utc).date().isoformat(),
        "service": "weekday daytime (first departure 06:00-21:00)",
        "routes": routes,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--download", action="store_true", help="fetch a fresh GTFS zip first")
    parser.add_argument("--zip", type=Path, default=DEFAULT_ZIP, help="GTFS zip path")
    parser.add_argument("--out", type=Path, default=OUT_JSON, help="output JSON path")
    args = parser.parse_args()

    if args.download:
        args.zip.parent.mkdir(parents=True, exist_ok=True)
        print(f"Downloading {GTFS_URL}")
        with urllib.request.urlopen(GTFS_URL, timeout=120) as resp:
            args.zip.write_bytes(resp.read())
    if not args.zip.exists():
        sys.exit(f"{args.zip} not found; run with --download")

    data = convert(args.zip)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(data, separators=(",", ":")) + "\n", encoding="utf-8")
    points = sum(len(p) // 2 for parts in data["routes"].values() for p in parts)
    print(f"Wrote {len(data['routes'])} lines ({points} points) to {args.out}")


if __name__ == "__main__":
    main()
