#!/usr/bin/env python3
"""Build data/ridership.json: average daily ridership per station complex.

Source: New York State Open Data, "MTA Subway Hourly Ridership: Beginning 2025"
(dataset 5wq4-mkjj), queried through the Socrata API with server-side grouping,
so only one row per station complex is downloaded.
https://data.ny.gov/Transportation/MTA-Subway-Hourly-Ridership-Beginning-2025/5wq4-mkjj

Usage:
    python3 scripts/prepare_ridership.py             # latest 4 full weeks of data
    python3 scripts/prepare_ridership.py --days 56   # a longer window

Upstream schema (verified 2026-10-25), relevant columns:
    transit_timestamp   - start of the hour, local time
    transit_mode        - subway, staten_island_railway, tram
    station_complex_id  - same IDs as "Complex ID" in MTA Subway Stations
    station_complex     - display name, e.g. "Hewes St (M,J)"
    ridership           - entries (fare taps/swipes) in that hour
    latitude / longitude

Ridership counts entries only, not exits. Uses only the Python standard library.
"""

import argparse
import datetime as dt
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

DATASET = "5wq4-mkjj"
SOURCE_URL = "https://data.ny.gov/Transportation/MTA-Subway-Hourly-Ridership-Beginning-2025/5wq4-mkjj"
API_URL = f"https://data.ny.gov/resource/{DATASET}.json"

ROOT = Path(__file__).resolve().parent.parent
OUT_JSON = ROOT / "data" / "ridership.json"

# Same bounding box as prepare_stations.py.
LAT_MIN, LAT_MAX = 40.45, 40.95
LON_MIN, LON_MAX = -74.30, -73.68

MODES = "('subway','staten_island_railway')"  # the tram isn't in the station data


def query(params: dict) -> list[dict]:
    url = f"{API_URL}?{urllib.parse.urlencode(params)}"
    with urllib.request.urlopen(url, timeout=120) as resp:
        return json.load(resp)


def latest_day() -> dt.date:
    [row] = query({"$select": "max(transit_timestamp) AS last"})
    return dt.datetime.fromisoformat(row["last"]).date()


def fetch_totals(start: dt.date, end: dt.date) -> list[dict]:
    # Group by id only (with max() for the rest): grouping by the name column
    # too makes the server time out on multi-week windows.
    return query({
        "$select": "station_complex_id, max(station_complex) AS name, max(latitude) AS lat, "
                   "max(longitude) AS lon, sum(ridership) AS total",
        "$where": f"transit_mode IN {MODES} AND transit_timestamp >= '{start}T00:00:00' "
                  f"AND transit_timestamp < '{end}T00:00:00'",
        "$group": "station_complex_id",
        "$limit": "5000",
    })


def build(days: int) -> dict:
    # Use whole days only; the last day may be partial, so stop the day before.
    end = latest_day()  # exclusive
    start = end - dt.timedelta(days=days)
    rows, chunk = [], start
    while chunk < end:  # one week per request keeps each query fast
        chunk_end = min(chunk + dt.timedelta(days=7), end)
        print(f"Fetching {chunk} to {chunk_end - dt.timedelta(days=1)}")
        rows += fetch_totals(chunk, chunk_end)
        chunk = chunk_end

    stations, dropped = {}, []
    for row in rows:
        cid = row.get("station_complex_id", "").strip()
        try:
            lat, lon, total = float(row["lat"]), float(row["lon"]), float(row["total"])
        except (KeyError, ValueError):
            dropped.append((cid or "?", "non-numeric values"))
            continue
        if not cid or not (LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX):
            dropped.append((cid or "?", f"missing id or outside NYC ({lat}, {lon})"))
            continue
        if cid in stations:  # same complex, another week
            stations[cid]["total"] += total
            continue
        stations[cid] = {"complexId": cid, "name": row["name"].strip(),
                         "latitude": round(lat, 6), "longitude": round(lon, 6), "total": total}

    for cid, reason in dropped:
        print(f"  dropped {cid}: {reason}", file=sys.stderr)
    if len(stations) < 300:
        sys.exit(f"Only {len(stations)} complexes returned; upstream data looks incomplete")

    out = []
    for s in stations.values():
        s["avgDaily"] = round(s.pop("total") / days)
        out.append(s)
    out.sort(key=lambda s: -s["avgDaily"])

    return {
        "source": "MTA Subway Hourly Ridership: Beginning 2025, New York State Open Data",
        "sourceUrl": SOURCE_URL,
        "periodStart": start.isoformat(),
        "periodEnd": (end - dt.timedelta(days=1)).isoformat(),  # inclusive
        "days": days,
        "generated": dt.datetime.now(dt.timezone.utc).date().isoformat(),
        "metric": "average daily entries",
        "count": len(out),
        "stations": out,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--days", type=int, default=28, help="window length (default: 4 weeks)")
    parser.add_argument("--out", type=Path, default=OUT_JSON, help="output JSON path")
    args = parser.parse_args()
    if args.days < 1:
        sys.exit("--days must be at least 1")

    data = build(args.days)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(data, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {data['count']} complexes ({data['periodStart']} to {data['periodEnd']}) to {args.out}")


if __name__ == "__main__":
    main()
