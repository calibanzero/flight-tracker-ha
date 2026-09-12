✈️ Flight Tracker

A simple self-hosted flight tracker designed for use with Home Assistant. Tracks aircraft passing through a defined area and keeps a history of detected flights.

Installation
1. Clone the repository
git clone https://github.com/calibanzero/flight-tracker-ha-.git
cd flight-tracker-ha-
2. Configure

Edit the configuration in docker-compose.yml for your installation, including your location and any required API settings.

3. Start the container
docker compose up -d
4. Open Flight Tracker

Open:

http://YOUR-SERVER-IP:3002

Replace YOUR-SERVER-IP with the IP address or hostname of the machine running the container.

To configure:

http://YOUR-SERVER-IP:3002/admin

Updating
git pull
docker compose down
docker compose up -d --build
Home Assistant

Add the Flight Tracker page to a Home Assistant dashboard using a Webpage card:

type: iframe
url: http://YOUR-SERVER-IP:3002
aspect_ratio: 100%

The Flight Tracker server must be accessible from the device running your Home Assistant dashboard.
