let map, markers = {};
let lastCentreKey = null;
let pollTimer = null;
let pollMs = 15000;
let localTimeZone = 'Australia/Sydney';


function formatLocalTime(value, options = {}) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-AU', { timeZone: localTimeZone, ...options });
}

const SYD_AIRPORT = {
  iata: 'SYD',
  name: 'Sydney Kingsford Smith International Airport',
  city: 'Sydney',
  country: 'Australia'
};

document.addEventListener('DOMContentLoaded', () => {
  // Initialize map
  // Start somewhere public before the saved tracking location arrives.
  map = L.map('map').setView([-33.8568, 151.2153], 13);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  const table = document.getElementById('aircraftTable');
  const status = document.getElementById('status');
  const debugBlock = document.getElementById('debug');
  const trackingSummary = document.getElementById('trackingSummary');

  function formatAirport(ap) {
    if (!ap) return 'Unknown';
    if (typeof ap === 'string') return ap;

    const code = ap.iata || ap.icao || ap.code || '';
    const name = ap.name || '';
    const city = ap.city || '';
    const country = ap.country || '';

    const details = [name, city, country].filter(Boolean).join(', ');
    if (code && details) return `${code} - ${details}`;
    if (code) return code;
    if (details) return details;
    return 'Unknown';
  }

  async function fetchData() {
    const t0 = performance.now();
    try {
      const res = await fetch('/api/traffic');
      const json = await res.json();
      const configuredPoll = Number(json.poll_interval_seconds);
      if (json.display_timezone) localTimeZone = json.display_timezone;
      if (Number.isFinite(configuredPoll)) {
        pollMs = Math.max(5000, configuredPoll * 1000);
      }
      const t1 = performance.now();

      // Keep the map centred on the tracking location from Admin.
      const centreLat = Number(json.centre?.lat);
      const centreLon = Number(json.centre?.lon);
      const radiusKm = Number(json.radius_km);

      if (Number.isFinite(centreLat) && Number.isFinite(centreLon)) {
        const centreKey = `${centreLat}:${centreLon}:${Number.isFinite(radiusKm) ? radiusKm : ''}`;
        if (centreKey !== lastCentreKey) {
          map.setView([centreLat, centreLon], map.getZoom());
          lastCentreKey = centreKey;
        }
      }

      if (trackingSummary && Number.isFinite(radiusKm)) {
        trackingSummary.textContent = `Aircraft passing through the ${radiusKm} km tracking area`;
      }

      // Update status
      status.textContent = `Last updated: ${formatLocalTime(new Date())} • ${json.count} aircraft • ${Math.round(t1 - t0)} ms`;

      // Update debug info
      if (debugBlock && json.debug) {
        debugBlock.textContent = `API running: ${json.debug.running} | Fetched: ${json.debug.fetched} | Timestamp: ${json.debug.timestamp}`;
      } else if (debugBlock) {
        debugBlock.textContent = '';
      }

      // Update table, newest aircraft first.
      const tbody = table.querySelector('tbody');
      tbody.innerHTML = '';
      const recentAircraft = [...json.aircraft].sort(
        (a, b) => Number(b.firstSeen || 0) - Number(a.firstSeen || 0)
      );
      recentAircraft.forEach(ac => {
        // SYD fallback: if destination unknown and origin is not SYD, set destination to SYD
        const originCode = ac.origin?.iata || ac.origin?.code || '';
        const destName = ac.destination?.name || '';
        // if (!destName && originCode !== 'SYD') {
        //   ac.destination = SYD_AIRPORT;
        // }

        // Handle airline safely
        const airlineName = (ac.airline && typeof ac.airline === 'object'
          ? ac.airline.name
          : ac.airline) || 'Unknown';

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${ac.flightNo || 'Unknown'}</td>
          <td>${ac.type || 'Unknown'}</td>
          <td>${ac.registration || 'Unknown'}</td>
          <td>${airlineName}</td>
          <td>${formatAirport(ac.origin)}</td>
          <td>${formatAirport(ac.destination)}</td>
          <td>${ac.firstSeen ? formatLocalTime(ac.firstSeen) : ''}</td>
        `;
        tbody.appendChild(tr);
      });

      // Update map markers
      Object.keys(markers).forEach(icao => {
        if (!json.aircraft.some(a => a.icao24 === icao)) {
          map.removeLayer(markers[icao]);
          delete markers[icao];
        }
      });

      json.aircraft.forEach(ac => {
        if (!ac.lat || !ac.lon) return;
        const pos = [ac.lat, ac.lon];

        // Ensure SYD fallback applies to popups too
        const originCode = ac.origin?.iata || ac.origin?.code || '';
        const destName = ac.destination?.name || '';
        let destForPopup = ac.destination;
        // if (!destName && originCode !== 'SYD') {
        //   destForPopup = SYD_AIRPORT;
        // }

        const airlineName = (ac.airline && typeof ac.airline === 'object'
          ? ac.airline.name
          : ac.airline) || 'Unknown';

        const popupText = `${ac.flightNo || 'Unknown'} (${ac.type || 'Unknown'})\n${airlineName}\n${formatAirport(ac.origin)} → ${formatAirport(destForPopup)}`;

        if (markers[ac.icao24]) {
          markers[ac.icao24].setLatLng(pos).getPopup().setContent(popupText);
        } else {
          const marker = L.marker(pos)
            .addTo(map)
            .bindPopup(popupText);
          markers[ac.icao24] = marker;
        }
      });

    } catch (err) {
      console.error(err);
      status.textContent = `Error fetching data: ${err.message}`;
    } finally {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(fetchData, pollMs);
    }
  }

  fetchData();
});
