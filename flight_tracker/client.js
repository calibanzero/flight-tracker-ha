let map, markers = {};

const SYD_AIRPORT = {
  iata: 'SYD',
  name: 'Sydney Kingsford Smith International Airport',
  city: 'Sydney',
  country: 'Australia'
};

document.addEventListener('DOMContentLoaded', () => {
  // Initialize map
  map = L.map('map').setView([-33.90617646981154, 151.1702608737488], 13);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  const table = document.getElementById('aircraftTable');
  const status = document.getElementById('status');
  const debugBlock = document.getElementById('debug');

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
      const t1 = performance.now();

      // Update status
      status.textContent = `Last updated: ${new Date().toLocaleTimeString()} • ${json.count} aircraft • ${Math.round(t1 - t0)} ms`;

      // Update debug info
      if (debugBlock && json.debug) {
        debugBlock.textContent = `API running: ${json.debug.running} | Fetched: ${json.debug.fetched} | Timestamp: ${json.debug.timestamp}`;
      } else if (debugBlock) {
        debugBlock.textContent = '';
      }

      // Update table
      const tbody = table.querySelector('tbody');
      tbody.innerHTML = '';
      json.aircraft.forEach(ac => {
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
          <td>${ac.firstSeen ? new Date(ac.firstSeen).toLocaleTimeString() : ''}</td>
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
    }
  }

  fetchData();
  setInterval(fetchData, 15000);
});
