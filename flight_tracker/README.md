# Flight Tracker Home Assistant App

A lightweight live aircraft tracker using OpenSky for live aircraft positions and ADSBDB for aircraft metadata and flight routes.

## Key changes

- Puppeteer and Chromium removed.
- FlightAware scraping removed.
- `aircraftDatabase.csv` removed.
- ADSBDB supplies aircraft registration, aircraft type, airline and route information.
- OpenSky remains the live position source.
- Tracker location and OpenSky credentials are managed from the Admin page and stored in persistent app data.
- Bundled airport backgrounds are copied into persistent storage on first start, so uploaded artwork survives app updates.

## Home Assistant

This is packaged as a Home Assistant app (formerly called an add-on). The Node.js runtime runs inside the app container, not on the Home Assistant host. Home Assistant supports containerised apps and aarch64 builds.

After installation, open the web interface on port 3000 and use **Admin** to set the tracker location and OpenSky credentials.

ADSBDB's public GET API does not require an API key.

## Persistent data

The app stores its runtime state under `/data`, including `settings.json`, `flight_log.csv`, `airports.txt`, `unknown_airlines.txt`, and uploaded airport backgrounds.
