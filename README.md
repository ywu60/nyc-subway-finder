# NYC Subway Finder

Find the nearest NYC subway station that serves the line you want. Allow location (or type a place / tap the map), pick a line, and see the closest station plus two alternatives, ranked by **real walking distance along streets**. Every other stop on the chosen line is shown on the map as a small dot. Tap any result to see its walking route on the map, or open Google Maps walking directions from your location. Turn on **Ridership heatmap** on the map to see which stations are busiest; hover or tap a hotspot for that station's average riders per day. The **Official subway maps** panel opens the MTA's high-resolution PDF maps (full weekday map, late night, accessible stations, large type and the subway diagram). They're linked from mta.info rather than copied, because the MTA doesn't allow redistribution and its links always serve the current edition.

**Live site:** https://ywu60.github.io/nyc-subway-finder/

- Plain HTML/CSS/JavaScript (ES modules). No build step, no backend, no API keys.
- Walking routes: public [OSRM foot router](https://routing.openstreetmap.de/) run by FOSSGIS on OpenStreetMap data.
- Map: [Leaflet](https://leafletjs.com/) 1.9.4 with OpenStreetMap tiles.
- Data: official [MTA Subway Stations](https://data.ny.gov/Transportation/MTA-Subway-Stations/39hk-dx4f) dataset (NY Open Data), downloaded 2026-10-18.
- Heatmap: [MTA Subway Hourly Ridership: Beginning 2025](https://data.ny.gov/Transportation/MTA-Subway-Hourly-Ridership-Beginning-2025/5wq4-mkjj) (NY Open Data), average daily entries for 2026-09-16 to 2026-10-13, drawn with [Leaflet.heat](https://github.com/Leaflet/Leaflet.heat) 0.2.0.
- Deployment: **GitHub Pages, branch publishing from `main` / `(root)`**.

## Repository tree

```
nyc-subway-finder/
├── index.html                  # page shell (relative asset paths)
├── .nojekyll                   # serve files as-is on GitHub Pages
├── src/
│   ├── app.js                  # UI: location, route picker, results, map
│   ├── geo.js                  # street-grid + Haversine distance, formatting, parsing
│   ├── stations.js             # exact-service filter, complex dedupe, ranking + re-ranking
│   ├── routing.js              # walking distances/routes from the OSRM foot router
│   ├── routes.js               # route list + MTA colors
│   └── styles.css
├── data/
│   ├── stations.json           # normalized station data used by the app
│   ├── ridership.json          # average daily entries per station complex (heatmap)
│   └── raw/MTA_Subway_Stations.csv   # upstream CSV the JSON was built from
├── scripts/
│   ├── prepare_stations.py     # reproducible CSV → JSON conversion
│   └── prepare_ridership.py    # ridership API → data/ridership.json
├── tests/search.test.js        # unit + data tests (Node built-in runner)
└── package.json                # npm scripts only; no dependencies
```

## Run locally

ES modules and `fetch` need an HTTP server (opening `index.html` as a file won't work).

```bash
python3 -m http.server 8000      # or: npm start
# open http://localhost:8000/
```

Browsers allow geolocation on `http://localhost`. On other HTTP origins (e.g. your LAN IP from a phone) location is blocked — use the manual entry or test on the HTTPS site.

## Test

Requires Node 18+. No packages to install.

```bash
npm test          # node --test tests/*.test.js
```

Tests cover re-ranking by routed walking distance (with fallback to estimates), street-grid (Manhattan) distance on north–south and rotated grids, check that it's never shorter than straight-line, check that ranking by it can differ from straight-line, and cover Haversine accuracy against an independent formula, exact-service filtering (e.g. `S` ≠ `SI`), ascending sort, the 3-result limit, complex de-duplication, invalid coordinates, unsupported routes, mile formatting, and checks on the real dataset (all coordinates within NYC, every route has stations, D→F changes results, shuttles stay separate).

## Rebuild station data

```bash
python3 scripts/prepare_stations.py --download   # fetch latest CSV and regenerate
python3 scripts/prepare_stations.py              # regenerate from data/raw/ CSV
npm test
```

The script uses only the Python standard library. It checks the required upstream columns exist, validates coordinates are numeric and inside an NYC bounding box, rejects unknown route codes, and logs anything dropped.

**Normalization notes** (from the upstream schema as of 2026-10-18):

- Services come from the `Daytime Routes` column (space-separated).
- Each record is one `GTFS Stop ID`. Records sharing a `Complex ID` are one station complex. Search keeps only the closest matching record per complex, so a complex never shows up twice, and the "Also" list shows every line in that complex.
- The upstream file labels all three shuttles `S`. The script uses the `Line` column to split them into `GS` (42 St), `FS` (Franklin Av; it also stops at Prospect Park) and `H` (Rockaway Park). `SIR` becomes `SI`.

## Rebuild ridership data

```bash
python3 scripts/prepare_ridership.py             # latest 4 full weeks
python3 scripts/prepare_ridership.py --days 56   # a longer window
npm test
```

The script asks the NY Open Data API to sum hourly ridership per station complex (one request per week, so each query stays fast), then divides by the number of days. Only subway and Staten Island Railway rows are used. Ridership counts **entries** (fare taps and swipes), not exits. Complex IDs match the `Complex ID` in the station data. The heatmap scales intensity by the square root of ridership, so mid-size stations still show next to Times Sq.

## Deploy to GitHub Pages

This repo uses **branch publishing**. There's no build step and no Actions workflow.

1. Create a **public** repository named `nyc-subway-finder` on GitHub (account `ywu60`).
2. Push this project to the `main` branch:
   ```bash
   git init -b main
   git add .
   git commit -m "NYC Subway Finder v1"
   git remote add origin https://github.com/ywu60/nyc-subway-finder.git
   git push -u origin main
   ```
   (Or, with the GitHub CLI: `gh repo create nyc-subway-finder --public --source=. --push`.)
3. On GitHub open **Settings → Pages**. Under **Build and deployment** pick **Source: Deploy from a branch**, then branch **`main`**, folder **`/ (root)`**, and click **Save**.
4. Wait for the "pages build and deployment" run under the **Actions** tab to turn green (about 1 minute).
5. Open `https://<username>.github.io/<repo-name>/`, which here is https://ywu60.github.io/nyc-subway-finder/.
6. On iPhone Safari and Android Chrome, tap **Use my location**, approve the prompt, pick a line, and check that a result and the map appear.
7. Later changes: bump the cache-busting version, then commit and `git push` to `main`. Pages redeploys automatically. You can check progress under **Actions** or **Settings → Pages**.
   ```bash
   # GitHub Pages lets browsers cache files for 10 minutes; a new ?v= forces fresh CSS/JS.
   sed -i '' "s/?v=[0-9]*/?v=$(date +%s)/g" index.html src/*.js   # macOS (on Linux: sed -i)
   ```

**Using a different repo name** works without code changes because every asset path is relative. The URL just becomes `https://<user>.github.io/<new-name>/`.

## Troubleshooting

| Problem | Fix |
|---|---|
| **404 at the Pages URL** | Confirm Pages is enabled for `main` / `(root)`, `index.html` is at the repo root, and the repo is public. The first deploy can take a few minutes. The URL is case-sensitive and needs the trailing repo name. |
| **Page loads but no styles / "Station data couldn't be loaded"** | An asset path is wrong. All paths must be relative (`src/app.js`, `data/stations.json`), never `/src/...`. Check the browser console's Network tab for 404s. |
| **Files with `_` prefixes or odd paths missing** | Make sure `.nojekyll` is committed at the root. |
| **"Location permission denied"** | iPhone: Settings → Privacy & Security → Location Services → Safari Websites → *While Using*, and in Safari tap **aA** → Website Settings → Location → Allow. Android Chrome: tap the lock icon in the address bar → Permissions → Location → Allow. Desktop: click the site-settings icon in the address bar. Or use **Enter a location instead**. |
| **Location is off by kilometers (e.g. ±3000 m)** | The device is sending an approximate position. iPhone: Settings → Privacy & Security → Location Services → Safari Websites → turn on **Precise Location**. Mac/PC: turn on Wi-Fi and allow Location Services for the browser (macOS: System Settings → Privacy & Security → Location Services). The app keeps refining for up to 20 s; you can also drag the blue dot to your exact spot. |
| **Location never resolves / times out** | Indoor or desktop positioning can be slow. Press **Refresh location**, or type a place or tap the map. |
| **Location doesn't work when testing from a phone on your LAN** | Geolocation requires HTTPS (or localhost). Test on the GitHub Pages URL. |
| **Map is blank but results show** | Tile servers are unreachable (offline/blocked). Results don't depend on the map. |
| **Changes not appearing** | Make sure you bumped the `?v=` version (step 7), wait for the Pages run to finish, then reload. A hard reload (Cmd/Ctrl+Shift+R) bypasses the 10-minute browser cache. |

## Privacy

- Coordinates stay in browser memory for the current tab. Nothing is stored (no cookies, no localStorage), and there's no app server or analytics.
- Third-party requests: OpenStreetMap tile servers (map images for the visible area), **routing.openstreetmap.de (receives your coordinates plus the nearby stations' coordinates, to calculate walking routes)**, unpkg.com (Leaflet and Leaflet.heat libraries), OpenStreetMap Nominatim (only when you type a place name; receives the text you typed), and Google Maps (only if you tap "Walking directions"; the link includes your location as the route origin), and mta.info (only if you open an official map PDF).

## Limitations

- **How distance works:**
  1. A quick **street-grid (Manhattan) estimate** picks the 8 closest candidate stations. It adds the uptown/downtown leg to the crosstown leg; for Manhattan stations the grid is rotated 29° to match the avenues, elsewhere a north–south/east–west grid is assumed.
  2. One request to the OSRM foot router gets the **real walking distance along streets** to each candidate. The results are re-ranked, and the top 3 are labelled "walking route".
  3. Selecting a station draws its actual street route on the map.
  4. If the router is unreachable, rate-limited or slow (15 s timeout, one retry on HTTP 429), the app keeps the estimates, labels them "estimate", and draws no route line.
- The routing service is a free community service with no uptime guarantee. Routes come from OpenStreetMap footpath data and may differ slightly from Google's.
- **Exact routes:** "Walking directions (Google Maps)" opens Google Maps with your app location as the origin and the station as the destination, in walking mode, so Google finds the actual shortest walking route.
- Station coordinates are station locations, not entrances or elevators.
- Services shown are the dataset's **assigned daytime routes**. Late nights, weekends, express/local patterns and planned work can differ, and stations may be temporarily closed or bypassed. There are no real-time arrivals or alerts.
- Place search depends on Nominatim's free service and is bounded to the NYC area.
- Not affiliated with or endorsed by the MTA.
