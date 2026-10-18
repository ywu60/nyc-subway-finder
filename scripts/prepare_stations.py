#!/usr/bin/env python3
"""Convert the official MTA Subway Stations CSV into data/stations.json.

Source: New York State Open Data, "MTA Subway Stations" (dataset 39hk-dx4f)
https://data.ny.gov/Transportation/MTA-Subway-Stations/39hk-dx4f

Usage:
    python3 scripts/prepare_stations.py --download   # fetch fresh CSV, then convert
    python3 scripts/prepare_stations.py              # convert data/raw/MTA_Subway_Stations.csv

Upstream schema (verified 2026-10-18), relevant columns:
    GTFS Stop ID     - unique per station/platform record, e.g. "R43"
    Complex ID       - groups records that form one transfer complex
    Line             - line name, used to tell the three "S" shuttles apart
    Stop Name        - display name
    Borough          - Bx, Bk, M, Q, SI
    Daytime Routes   - space-separated route IDs, e.g. "N Q R W"
    GTFS Latitude / GTFS Longitude
    ADA              - 0 = not accessible, 1 = accessible, 2 = partially accessible

Uses only the Python standard library.
"""

import argparse
import csv
import datetime as dt
import json
import sys
import urllib.request
from pathlib import Path

SOURCE_URL = "https://data.ny.gov/Transportation/MTA-Subway-Stations/39hk-dx4f"
CSV_URL = "https://data.ny.gov/api/views/39hk-dx4f/rows.csv?accessType=DOWNLOAD"

ROOT = Path(__file__).resolve().parent.parent
RAW_CSV = ROOT / "data" / "raw" / "MTA_Subway_Stations.csv"
OUT_JSON = ROOT / "data" / "stations.json"

# Generous bounding box around the five boroughs.
LAT_MIN, LAT_MAX = 40.45, 40.95
LON_MIN, LON_MAX = -74.30, -73.68

KNOWN_ROUTES = {
    "1", "2", "3", "4", "5", "6", "7",
    "A", "B", "C", "D", "E", "F", "G", "J", "L", "M", "N", "Q", "R", "W", "Z",
    "GS", "FS", "H", "SI",
}

# The upstream file labels all three shuttles "S". Disambiguate them using the
# "Line" column so that selecting one shuttle never returns another.
SHUTTLE_BY_LINE = {
    "Lexington - Shuttle": "GS",  # 42 St Shuttle (Times Sq - Grand Central)
    "Franklin Shuttle": "FS",     # Franklin Av Shuttle
    "Rockaway": "H",              # Rockaway Park Shuttle
    "Broadway - Brighton": "FS",  # Prospect Park, southern end of the Franklin Shuttle
}

ROUTE_ALIASES = {"SIR": "SI"}

REQUIRED_COLUMNS = [
    "GTFS Stop ID", "Complex ID", "Line", "Stop Name", "Borough",
    "Daytime Routes", "GTFS Latitude", "GTFS Longitude", "ADA",
]


def download(dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {CSV_URL}")
    with urllib.request.urlopen(CSV_URL, timeout=60) as resp:
        dest.write_bytes(resp.read())
    print(f"Saved {dest}")


def normalize_routes(raw: str, line: str, stop_id: str) -> list[str]:
    routes = []
    for code in raw.split():
        code = code.strip().upper()
        if code == "S":
            if line not in SHUTTLE_BY_LINE:
                raise ValueError(f"{stop_id}: unknown shuttle line {line!r}")
            code = SHUTTLE_BY_LINE[line]
        code = ROUTE_ALIASES.get(code, code)
        if code not in KNOWN_ROUTES:
            raise ValueError(f"{stop_id}: unknown route code {code!r}")
        if code not in routes:
            routes.append(code)
    return routes


def convert(csv_path: Path) -> dict:
    with csv_path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        missing = [c for c in REQUIRED_COLUMNS if c not in (reader.fieldnames or [])]
        if missing:
            sys.exit(f"Upstream schema changed; missing columns: {missing}")
        rows = list(reader)

    stations, dropped, seen_ids = [], [], set()
    for row in rows:
        stop_id = row["GTFS Stop ID"].strip()
        try:
            lat = float(row["GTFS Latitude"])
            lon = float(row["GTFS Longitude"])
        except ValueError:
            dropped.append((stop_id, "non-numeric coordinates"))
            continue
        if not (LAT_MIN <= lat <= LAT_MAX and LON_MIN <= lon <= LON_MAX):
            dropped.append((stop_id, f"outside NYC bounds ({lat}, {lon})"))
            continue
        if not stop_id or not row["Complex ID"].strip() or not row["Stop Name"].strip():
            dropped.append((stop_id or "?", "missing id or name"))
            continue
        if stop_id in seen_ids:
            dropped.append((stop_id, "duplicate GTFS Stop ID"))
            continue
        services = normalize_routes(row["Daytime Routes"], row["Line"].strip(), stop_id)
        if not services:
            dropped.append((stop_id, "no daytime routes"))
            continue
        seen_ids.add(stop_id)
        stations.append({
            "id": stop_id,
            "complexId": row["Complex ID"].strip(),
            "name": row["Stop Name"].strip(),
            "borough": row["Borough"].strip(),
            "latitude": round(lat, 6),
            "longitude": round(lon, 6),
            "services": services,
            "ada": int(row["ADA"]) if row["ADA"].strip().isdigit() else 0,
        })

    stations.sort(key=lambda s: s["id"])
    for stop_id, reason in dropped:
        print(f"  dropped {stop_id}: {reason}", file=sys.stderr)

    downloaded = dt.datetime.fromtimestamp(csv_path.stat().st_mtime, dt.timezone.utc)
    return {
        "source": "MTA Subway Stations, New York State Open Data",
        "sourceUrl": SOURCE_URL,
        "sourceDownloaded": downloaded.date().isoformat(),
        "generated": dt.datetime.now(dt.timezone.utc).date().isoformat(),
        "routeField": "Daytime Routes",
        "count": len(stations),
        "complexCount": len({s["complexId"] for s in stations}),
        "stations": stations,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--download", action="store_true", help="fetch a fresh CSV first")
    parser.add_argument("--csv", type=Path, default=RAW_CSV, help="input CSV path")
    parser.add_argument("--out", type=Path, default=OUT_JSON, help="output JSON path")
    args = parser.parse_args()

    if args.download:
        download(args.csv)
    if not args.csv.exists():
        sys.exit(f"{args.csv} not found; run with --download")

    data = convert(args.csv)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(data, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {data['count']} stations ({data['complexCount']} complexes) to {args.out}")


if __name__ == "__main__":
    main()
