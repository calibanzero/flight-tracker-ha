# Flight Tracker

A lightweight, self-hosted aircraft tracker for Docker.

Flight Tracker uses **OpenSky** for live aircraft positions and **ADSBDB** for aircraft, airline and route information. It includes a live map, a large-screen display, historical statistics, configurable airport backgrounds and a browser-based Admin page.

It runs as a standalone Docker container and can also be embedded in Home Assistant using an iframe.

## Features

* Live aircraft tracking around a configurable location
* Configurable search radius
* OpenSky OAuth credentials managed from the Admin page
* Optional secondary OpenSky credential set
* Shared server-side OpenSky cache so multiple browsers do not multiply API calls
* 15-second live refresh cadence by default
* ADSBDB route, airline, registration and aircraft metadata enrichment
* Friendly aircraft names using OpenFlights `planes.dat`
* Local aircraft reference data from tar1090-db
* Recently Seen list, newest first
* Large-screen display with airline logos and airport backgrounds
* Clear Skies day/night screen when no aircraft are present
* Historical flight dashboard
* Persistent settings, flight history and uploaded backgrounds
* Browser-based Admin page with application logs
* Automatic aircraft database updates during Docker builds

## Data sources

Flight Tracker combines:

* **OpenSky Network** for live aircraft positions
* **ADSBDB** for aircraft, airline and route metadata
* **tar1090-db** for local aircraft registration/type fallback data
* **OpenFlights `planes.dat`** for friendly aircraft type names

ADSBDB's public GET endpoints do not require an API key. You will need OpenSky API client credentials for authenticated OpenSky access.

## Requirements

* Docker
* Docker Compose v2 (`docker compose`)
* Internet access from the container
* OpenSky API client credentials

## Installation

Clone the repository:

```bash
git clone https://github.com/calibanzero/flight-tracker-ha.git
cd flight-tracker-ha/flight_tracker
```

Build and start the tracker:

```bash
docker compose -f compose.local.yaml up -d --build
```

The supplied Compose file exposes the tracker on port **3002**:

```text
http://<docker-host>:3002
```

Check the health endpoint:

```bash
curl http://localhost:3002/api/health
```

Expected response:

```json
{"status":"ok"}
```

## First-time setup

Open:

```text
http://<docker-host>:3002/admin
```

Configure:

1. Latitude
2. Longitude
3. Search radius in kilometres
4. OpenSky primary client ID and client secret
5. Optional secondary OpenSky credentials

Save the settings. The map will pick up location and radius changes on its next refresh.

OpenSky secrets are stored in the persistent data directory and masked when returned to the browser. Leaving an existing secret field blank does not erase the stored secret.

## Interfaces

| URL            | Purpose                                            |
| -------------- | -------------------------------------------------- |
| `/`            | Live map and Recently Seen aircraft                |
| `/screen.html` | Large-screen / Home Assistant display              |
| `/dashboard`   | Historical flight statistics                       |
| `/admin`       | Settings, airport backgrounds and application logs |
| `/api/health`  | Health check                                       |

## OpenSky polling and API usage

The web interfaces refresh every **15 seconds**.

The server also maintains a **15-second shared OpenSky cache**, so several open browsers still result in approximately one fresh OpenSky request per 15-second window rather than one request per browser.

While continuously viewed, a 15-second interval has a theoretical maximum of:

```text
5,760 fresh OpenSky requests per day
```

Check your current OpenSky allowance before running the tracker continuously.

If your allowance is around 4,000 requests/credits per day, increase the server cache interval. For example:

```text
22 seconds ≈ 3,927 requests/day
23 seconds ≈ 3,757 requests/day
25 seconds ≈ 3,456 requests/day
```

The interval is set in `server.js`:

```js
const OPENSKY_CACHE_MS = 15 * 1000;
```

The browser can still refresh every 15 seconds with a longer server cache. It will simply receive the most recent cached OpenSky result.

If OpenSky responds with HTTP `429`, the tracker backs off rather than repeatedly hitting the API. It also serves the most recent cached result during the backoff period.

Use multiple OpenSky credentials only in accordance with OpenSky's current terms and API rules.

## Persistent data

Runtime data is stored in:

```text
./data
```

The supplied Compose file maps this to `/data` inside the container:

```yaml
volumes:
  - ./data:/data
```

Persistent data includes:

```text
settings.json
flight_log.csv
airports.txt
unknown_airlines.txt
bgs/
```

Do not delete the `data` directory unless you intentionally want to reset the tracker.

To confirm that OpenSky secrets are stored without exposing them:

```bash
curl -s http://localhost:3002/api/admin/settings | jq '.settings.openSky'
```

A configured account should show:

```json
{
  "clientSecret": "••••••••",
  "hasClientSecret": true
}
```

## Aircraft reference data

Two reference files are refreshed automatically during uncached Docker builds.

### `aircraftDatabase.csv`

Downloaded from tar1090-db:

```text
https://raw.githubusercontent.com/wiedehopf/tar1090-db/csv/aircraft.csv.gz
```

### `planes.dat`

Downloaded from OpenFlights:

```text
https://raw.githubusercontent.com/jpatokal/openflights/master/data/planes.dat
```

`planes.dat` converts ICAO aircraft type codes such as `B738` into friendly names such as `Boeing 737-800`.

Downloads are forced over IPv4, validated before replacing the current files, and keep the bundled copy if an upstream download is temporarily unavailable.

To force a database-only refresh when Docker would otherwise use its build cache:

```bash
docker compose -f compose.local.yaml build --no-cache
docker compose -f compose.local.yaml up -d --force-recreate
```

## Airport backgrounds

The large-screen display supports airport-specific background images.

As routes are discovered, the Admin page builds a list of known airports and shows those without artwork. Upload images from:

```text
http://<docker-host>:3002/admin
```

Uploaded backgrounds are stored persistently in:

```text
./data/bgs
```

The application also seeds bundled backgrounds into persistent storage.

When there is no aircraft to display, `screen.html` uses bundled Clear Skies artwork:

```text
logo/screen/day-sky.jpg
logo/screen/night-sky.jpg
```

## Home Assistant

Home Assistant is not required to run Flight Tracker.

To embed the screen display in a Home Assistant dashboard:

```yaml
type: iframe
url: http://<docker-host>:3002/screen.html
aspect_ratio: 75%
```

Or embed the main tracker:

```yaml
type: iframe
url: http://<docker-host>:3002/
aspect_ratio: 100%
```

If Home Assistant is served over HTTPS, the browser may block an HTTP iframe as mixed content. Use HTTPS/reverse proxying if required for your network.

## Updating

Pull the latest code and rebuild:

```bash
cd ~/flight-tracker-ha
git pull
cd flight_tracker

docker compose -f compose.local.yaml up -d --build --force-recreate
```

Settings and flight history survive normal rebuilds because they live under `./data`.

## Logs

View container logs:

```bash
docker logs --tail 100 -f flight-tracker-adsbdb-test
```

Recent application logs are also available on the Admin page.

Useful startup messages include:

```text
[AircraftDB] Loaded ... aircraft from tar1090/readsb database
[PlaneTypes] Loaded ... friendly aircraft type mappings
```

## Troubleshooting

### OpenSky returns 429 Too Many Requests

Confirm authenticated credentials are stored:

```bash
curl -s http://localhost:3002/api/admin/settings | jq '.settings.openSky'
```

Look for `"hasClientSecret": true`. If credentials are present, check your OpenSky allowance and consider increasing `OPENSKY_CACHE_MS`.

### Settings disappear after rebuilding

Check that `compose.local.yaml` still contains:

```yaml
volumes:
  - ./data:/data
```

and confirm `data/settings.json` exists on the Docker host.

### Aircraft types are unfriendly

Check the startup logs for the `PlaneTypes` loader. A no-cache rebuild will refresh `planes.dat`.

### Origin or destination is Unknown

Route information comes from ADSBDB. Not every callsign has a route record, and temporary API/network failures can also leave a route unknown.

### ADSBDB requests time out

The application explicitly uses IPv4 for ADSBDB because some Docker hosts have working IPv6 DNS records without working IPv6 routing.

### Map is centred in the wrong place

Update latitude and longitude in `/admin`, save, and wait for the next refresh.

## Known limitations

* The application is currently optimised for the `Australia/Sydney` timezone.
* Historical dashboard date boundaries and Clear Skies day/night selection use Sydney time.
* Recently Seen state is held in memory and starts rebuilding after an application restart; historical flight data remains in `flight_log.csv`.
* Route data depends on ADSBDB coverage for the observed aircraft/callsign.
* The supplied standalone Compose configuration currently uses container name `flight-tracker-adsbdb-test` and host port `3002`.
* The repository contains Home Assistant add-on/app packaging from earlier development. The standalone Docker Compose deployment documented here is the currently tested installation path.

---

Built for people who look up when they hear something interesting overhead. ✈️
