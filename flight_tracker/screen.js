const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
let pollMs = 15000;
let pollTimer = null;
let serverClock = null;

let currentFlight = null;
let currentBgCode = null;
let clearSkyMode = null;

function toMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n < 1e12 ? n * 1000 : n;
}

function toTitleCase(str) {
  return String(str || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function airportParts(ap) {
  if (!ap) return { code: 'UNK', location: 'Unknown' };
  if (typeof ap === 'string') {
    const cleaned = ap.replace(/\t+/g, '').replace(/<br\s*\/?>/gi, '\n').replace(/\n\s*\n+/g, '\n').trim();
    const parts = cleaned.split('\n').map(s => s.trim()).filter(Boolean);
    return {
      code: parts[0] ? parts[0].substring(0, 3).toUpperCase() : 'UNK',
      location: parts.length > 1 ? toTitleCase(parts[parts.length - 1]) : ''
    };
  }
  const code = String(ap.iata || ap.icao || ap.code || 'UNK').toUpperCase();
  const location = toTitleCase(
    [ap.city || ap.municipality, ap.country].filter(Boolean).join(', ') || ap.name || ''
  );
  return { code, location };
}

function formatAirport(ap) {
  const p = airportParts(ap);
  return `<div class="airport-code">${p.code}</div><div class="airport-location">${p.location}</div>`;
}

function normaliseType(type) {
  return String(type || 'Unknown').replace('De Havilland Canada ', '');
}

function airlineName(flight) {
  if (flight?.airline && typeof flight.airline === 'object') return flight.airline.name || 'Unknown';
  return flight?.airline || 'Unknown';
}

function airlineLogo(flight) {
  return flight?.airline && typeof flight.airline === 'object' ? (flight.airline.logo || '') : '';
}

function routeText(flight) {
  const o = airportParts(flight?.origin);
  const d = airportParts(flight?.destination);
  return `${o.code} → ${d.code}`;
}

function displayTime(ts) {
  const d = new Date(toMs(ts));
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { timeZone: serverClock?.timezone || undefined, hour: '2-digit', minute: '2-digit' });
}

function renderAirline(el, flight) {
  el.innerHTML = '';
  const logo = airlineLogo(flight);
  if (logo) {
    const img = document.createElement('img');
    img.src = logo;
    img.alt = '';
    el.appendChild(img);
  }
  const span = document.createElement('span');
  span.textContent = airlineName(flight);
  el.appendChild(span);
}

function updateServerClock(value) {
  const epochMs = Number(value?.epoch_ms);
  const minutesSinceMidnight = Number(value?.minutes_since_midnight);
  if (Number.isFinite(epochMs) && Number.isFinite(minutesSinceMidnight)) {
    serverClock = { epochMs, minutesSinceMidnight, timezone: value?.timezone || '' };
  }
}

function serverHour() {
  if (!serverClock) return new Date().getHours();
  const elapsedMinutes = Math.floor((Date.now() - serverClock.epochMs) / 60000);
  const minuteOfDay = ((serverClock.minutesSinceMidnight + elapsedMinutes) % 1440 + 1440) % 1440;
  return Math.floor(minuteOfDay / 60);
}

function setClearSkyBackground() {
  const overlay = document.getElementById('bg-overlay');
  const hour = serverHour();
  const mode = hour >= 7 && hour < 19 ? 'day' : 'night';

  currentBgCode = null;
  overlay.style.backgroundImage = '';
  overlay.style.opacity = '1';
  overlay.classList.remove('clear-day', 'clear-night');
  overlay.classList.add(mode === 'day' ? 'clear-day' : 'clear-night');
  clearSkyMode = mode;
}

function setBackground(flight, dimmed = false) {
  const o = airportParts(flight?.origin);
  const d = airportParts(flight?.destination);
  let code = 'SYD';
  if (o.code && o.code !== 'UNK' && o.code !== 'SYD') code = o.code;
  else if (d.code && d.code !== 'UNK' && d.code !== 'SYD') code = d.code;

  const overlay = document.getElementById('bg-overlay');
  overlay.classList.remove('clear-day', 'clear-night');
  clearSkyMode = null;
  overlay.style.opacity = dimmed ? '.28' : '.48';
  if (code === currentBgCode) return;
  currentBgCode = code;

  const imgUrl = `/api/background/${encodeURIComponent(code)}`;
  const img = new Image();
  img.onload = () => { overlay.style.backgroundImage = `url('${imgUrl}')`; };
  img.onerror = () => { overlay.style.backgroundImage = ''; };
  img.src = imgUrl;
}

function renderActive(flight) {
  currentFlight = flight;
  document.getElementById('activeCard').style.display = 'block';
  document.getElementById('clearState').style.display = 'none';
  document.getElementById('flightNo').textContent = flight.flightNo || flight.callsign || 'Unknown';
  document.getElementById('origin').innerHTML = formatAirport(flight.origin);
  document.getElementById('destination').innerHTML = formatAirport(flight.destination);
  renderAirline(document.getElementById('airline'), flight);
  document.getElementById('type').textContent = [normaliseType(flight.type), flight.registration].filter(Boolean).join(' · ');
  document.getElementById('seen').textContent = `First seen ${displayTime(flight.firstSeen)}`;
  setBackground(flight, false);
}

function renderClear(flight) {
  currentFlight = flight || currentFlight;
  document.getElementById('activeCard').style.display = 'none';
  document.getElementById('clearState').style.display = 'block';

  const last = currentFlight;
  if (!last) {
    document.getElementById('lastFlight').textContent = 'None yet';
    document.getElementById('lastRoute').textContent = '';
    document.getElementById('lastMeta').textContent = '';
    document.getElementById('lastTime').textContent = '';
    document.getElementById('lastLogo').innerHTML = '';
    setClearSkyBackground();
    return;
  }

  document.getElementById('lastFlight').textContent = last.flightNo || last.callsign || 'Unknown';
  document.getElementById('lastRoute').textContent = routeText(last);
  document.getElementById('lastMeta').textContent = [airlineName(last), normaliseType(last.type), last.registration].filter(Boolean).join(' · ');
  document.getElementById('lastTime').textContent = displayTime(last.firstSeen);
  const logo = airlineLogo(last);
  document.getElementById('lastLogo').innerHTML = logo ? `<img src="${logo}" alt="">` : '';
  setClearSkyBackground();
}

function applyState(flight) {
  if (!flight) {
    renderClear(currentFlight);
    return;
  }
  const age = Date.now() - toMs(flight.firstSeen);
  if (age <= ACTIVE_WINDOW_MS) renderActive(flight);
  else renderClear(flight);
}

async function fetchLatest() {
  try {
    const res = await fetch('/api/traffic', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    updateServerClock(json.server_time);
    const configuredPoll = Number(json.poll_interval_seconds);
    if (Number.isFinite(configuredPoll)) {
      pollMs = Math.max(5000, configuredPoll * 1000);
    }
    const aircraft = Array.isArray(json.aircraft) ? json.aircraft : [];
    if (!aircraft.length) {
      applyState(currentFlight);
      return;
    }
    const newest = [...aircraft].sort((a, b) => toMs(b.firstSeen) - toMs(a.firstSeen))[0];
    applyState(newest);
  } catch (err) {
    console.error('Error fetching latest flight', err);
    applyState(currentFlight);
  } finally {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(fetchLatest, pollMs);
  }
}

document.getElementById('homeHotspot').addEventListener('click', () => { window.location.href = '/'; });
fetchLatest();

setInterval(() => {
  if (document.getElementById('clearState').style.display !== 'none') {
    const nextMode = serverHour() >= 7 && serverHour() < 19 ? 'day' : 'night';
    if (nextMode !== clearSkyMode) setClearSkyBackground();
  }
}, 60000);
