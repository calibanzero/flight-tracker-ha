const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const Papa = require('papaparse');
const fetch = require('node-fetch');

if (typeof dns.setDefaultResultOrder === 'function') {
  dns.setDefaultResultOrder('ipv4first');
}

const PORT = 3002;

// Persistent data directory. Declare this before any paths that depend on it.
const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Persistent application settings.
// These live in DATA_DIR so they survive container restarts and Home Assistant updates.
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  // Public, non-personal default: Sydney Opera House.
  lat: -33.8568,
  lon: 151.2153,
  radius_km: 1.5,
  poll_interval_seconds: 15,
  display_timezone: 'Australia/Sydney',
  openSky: {
    primary: { clientId: '', clientSecret: '' },
    backup: { clientId: '', clientSecret: '' }
  }
};

let appSettings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

function normaliseSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const openSky = source.openSky && typeof source.openSky === 'object' ? source.openSky : {};
  const primary = openSky.primary && typeof openSky.primary === 'object' ? openSky.primary : {};
  const backup = openSky.backup && typeof openSky.backup === 'object' ? openSky.backup : {};

  return {
    lat: Number(source.lat ?? DEFAULT_SETTINGS.lat),
    lon: Number(source.lon ?? DEFAULT_SETTINGS.lon),
    radius_km: Number(source.radius_km ?? DEFAULT_SETTINGS.radius_km),
    poll_interval_seconds: Number(source.poll_interval_seconds ?? DEFAULT_SETTINGS.poll_interval_seconds),
    display_timezone: String(source.display_timezone || DEFAULT_SETTINGS.display_timezone).trim(),
    openSky: {
      primary: {
        clientId: String(primary.clientId || ''),
        clientSecret: String(primary.clientSecret || '')
      },
      backup: {
        clientId: String(backup.clientId || ''),
        clientSecret: String(backup.clientSecret || '')
      }
    }
  };
}

function isValidTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: value }).format(new Date());
    return true;
  } catch (_) {
    return false;
  }
}

function minutesSinceMidnightInTimeZone(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const hour = Number(parts.find(part => part.type === 'hour')?.value);
  const minute = Number(parts.find(part => part.type === 'minute')?.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
  return hour * 60 + minute;
}

function validateSettings(settings) {
  if (!Number.isFinite(settings.lat) || settings.lat < -90 || settings.lat > 90) {
    throw new Error('Latitude must be a number between -90 and 90');
  }
  if (!Number.isFinite(settings.lon) || settings.lon < -180 || settings.lon > 180) {
    throw new Error('Longitude must be a number between -180 and 180');
  }
  if (!Number.isFinite(settings.radius_km) || settings.radius_km <= 0 || settings.radius_km > 100) {
    throw new Error('Radius must be greater than 0 and no more than 100 km');
  }
  if (!Number.isFinite(settings.poll_interval_seconds) || settings.poll_interval_seconds < 5 || settings.poll_interval_seconds > 3600) {
    throw new Error('Polling interval must be between 5 and 3600 seconds');
  }
  if (!isValidTimeZone(settings.display_timezone)) {
    throw new Error('Local timezone must be a valid IANA timezone, such as Australia/Sydney');
  }
}

function loadAppSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      appSettings = normaliseSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
      validateSettings(appSettings);
    } else {
      saveAppSettings(DEFAULT_SETTINGS);
    }
  } catch (err) {
    console.error('[Settings] Failed to load settings:', err.message);
    appSettings = normaliseSettings(DEFAULT_SETTINGS);
  }
}

function saveAppSettings(nextSettings) {
  const merged = normaliseSettings(nextSettings);
  validateSettings(merged);
  appSettings = merged;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2) + '\n', 'utf8');
}

function publicSettings() {
  const mask = value => value ? '••••••••' : '';
  return {
    lat: appSettings.lat,
    lon: appSettings.lon,
    radius_km: appSettings.radius_km,
    poll_interval_seconds: appSettings.poll_interval_seconds,
    display_timezone: appSettings.display_timezone,
    openSky: {
      primary: {
        clientId: appSettings.openSky.primary.clientId,
        clientSecret: mask(appSettings.openSky.primary.clientSecret),
        hasClientSecret: Boolean(appSettings.openSky.primary.clientSecret)
      },
      backup: {
        clientId: appSettings.openSky.backup.clientId,
        clientSecret: mask(appSettings.openSky.backup.clientSecret),
        hasClientSecret: Boolean(appSettings.openSky.backup.clientSecret)
      }
    }
  };
}

loadAppSettings();
// const KEEP_ALIVE_MS = 120 * 60 * 1000; // 120 minutes
const KEEP_ALIVE_MS = 24 * 60 * 60 * 1000; // 24 hours

// -----------------------------
// Application log buffer for admin page
// -----------------------------
const MAX_APP_LOGS = 500;
const appLogs = [];
const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

function stringifyLogValue(value) {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  if (value == null) return String(value);
  try { return JSON.stringify(value); }
  catch (_) { return String(value); }
}

function captureAppLog(level, args) {
  appLogs.push({
    timestamp: new Date().toISOString(),
    level,
    message: args.map(stringifyLogValue).join(' ')
  });

  if (appLogs.length > MAX_APP_LOGS) {
    appLogs.splice(0, appLogs.length - MAX_APP_LOGS);
  }
}

['log', 'warn', 'error'].forEach(level => {
  console[level] = (...args) => {
    captureAppLog(level, args);
    originalConsole[level](...args);
  };
});

// -----------------------------
// Log files and in-memory sets
// -----------------------------
const AIRPORTS_FILE = path.join(DATA_DIR, 'airports.txt');
const UNKNOWN_AIRLINES_FILE = path.join(DATA_DIR, 'unknown_airlines.txt');
const FLIGHT_LOG_FILE = path.join(DATA_DIR, 'flight_log.csv');

const BGS_DIR = process.env.BGS_DIR || path.join(DATA_DIR, 'bgs');
if (!fs.existsSync(BGS_DIR)) fs.mkdirSync(BGS_DIR, { recursive: true });

function seedBundledBackgrounds() {
  const bundledDir = path.join(__dirname, 'bgs');
  if (!fs.existsSync(bundledDir) || bundledDir === BGS_DIR) return;
  try {
    fs.readdirSync(bundledDir).forEach(name => {
      const target = path.join(BGS_DIR, name);
      const source = path.join(bundledDir, name);
      if (!fs.existsSync(target)) fs.copyFileSync(source, target);
    });
  } catch (err) {
    console.warn('[Backgrounds] Failed to seed bundled backgrounds:', err.message);
  }
}


const BG_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.jfif'];
seedBundledBackgrounds();

const BG_CONTENT_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

function findBackground(code) {
  const safe = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{3,4}$/.test(safe)) return null;

  for (const ext of BG_EXTENSIONS) {
    const candidate = path.join(BGS_DIR, safe + ext);
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function getKnownAirports() {
  if (!fs.existsSync(AIRPORTS_FILE)) return [];

  return fs
    .readFileSync(AIRPORTS_FILE, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const splitAt = line.indexOf(' - ');

      return splitAt >= 0
        ? {
            code: line.slice(0, splitAt).trim().toUpperCase(),
            details: line.slice(splitAt + 3).trim()
          }
        : {
            code: line.trim().toUpperCase(),
            details: ''
          };
    })
    .filter(a => /^[A-Z0-9]{3,4}$/.test(a.code));
}

function readRequestBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', chunk => {
      size += chunk.length;

      if (size > maxBytes) {
        reject(new Error('Image is too large (maximum 10 MB)'));
        req.destroy();
        return;
      }

      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseMultipart(body, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');

  if (!boundaryMatch) {
    throw new Error('Invalid upload request');
  }

  const boundary = Buffer.from('--' + (boundaryMatch[1] || boundaryMatch[2]));
  const parts = [];

  let start = body.indexOf(boundary);

  while (start !== -1) {
    start += boundary.length;

    if (body.slice(start, start + 2).toString() === '--') break;

    if (body.slice(start, start + 2).toString() === '\r\n') {
      start += 2;
    }

    const next = body.indexOf(boundary, start);

    if (next === -1) break;

    let part = body.slice(start, next);

    if (part.slice(-2).toString() === '\r\n') {
      part = part.slice(0, -2);
    }

    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));

    if (headerEnd >= 0) {
      const headers = part.slice(0, headerEnd).toString('utf8');
      const data = part.slice(headerEnd + 4);

      const name = /name="([^"]+)"/i.exec(headers)?.[1];
      const filename = /filename="([^"]*)"/i.exec(headers)?.[1];
      const mime = /content-type:\s*([^\r\n]+)/i.exec(headers)?.[1]?.trim();

      if (name) {
        parts.push({
          name,
          filename,
          mime,
          data
        });
      }
    }

    start = next;
  }

  return parts;
}

const localDateFormatterCache = new Map();
const localTimeFormatterCache = new Map();

function getLocalDateFormatter(timeZone) {
  if (!localDateFormatterCache.has(timeZone)) {
    localDateFormatterCache.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }));
  }
  return localDateFormatterCache.get(timeZone);
}

function getLocalTimeFormatter(timeZone) {
  if (!localTimeFormatterCache.has(timeZone)) {
    localTimeFormatterCache.set(timeZone, new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }));
  }
  return localTimeFormatterCache.get(timeZone);
}


const loggedAirports = new Set();
const loggedUnknownAirlines = new Set();

// -----------------------------
// Load existing logged airports
// -----------------------------
try {
  if (fs.existsSync(AIRPORTS_FILE)) {
    const lines = fs
      .readFileSync(AIRPORTS_FILE, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean);

    lines.forEach(l => {
      const code = l.split(' - ')[0].trim();
      if (code) loggedAirports.add(code);
    });
  }
} catch (err) {
  console.warn(
    '[Airports] Failed to pre-load airports file:',
    err.message
  );
}

// -----------------------------
// Load existing unknown airlines
// -----------------------------
try {
  if (fs.existsSync(UNKNOWN_AIRLINES_FILE)) {
    const lines = fs
      .readFileSync(UNKNOWN_AIRLINES_FILE, 'utf8')
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean);

    lines.forEach(l => loggedUnknownAirlines.add(l));
  }
} catch (err) {
  console.warn(
    '[UnknownAirlines] Failed to pre-load unknown airlines file:',
    err.message
  );
}

// -----------------------------
// Flight log for analytics
// -----------------------------
function ensureFlightLogHeader() {
  try {
    if (!fs.existsSync(FLIGHT_LOG_FILE)) {
      fs.writeFileSync(
        FLIGHT_LOG_FILE,
        'timestamp,isoDateTime,icao24,callsign,flightNo,lat,lon,registration,type,airline,origin,destination\n',
        'utf8'
      );
    }
  } catch (err) {
    console.error(
      '[FlightLog] Failed to ensure header:',
      err.message
    );
  }
}

ensureFlightLogHeader();

function logFlightSnapshot(f) {
  try {
    if (!f || !f.icao24) return;

    const now = Date.now();
    const iso = new Date(now).toISOString();

    const clean = v =>
      (v == null ? '' : String(v))
        .replace(/[\r\n,]+/g, ' ')
        .trim();

    const airlineName =
      f.airline && f.airline.name
        ? f.airline.name
        : typeof f.airline === 'string'
          ? f.airline
          : '';

    const line = [
      now,
      iso,
      clean(f.icao24),
      clean(f.callsign),
      clean(f.flightNo),
      f.lat == null ? '' : f.lat,
      f.lon == null ? '' : f.lon,
      clean(f.registration),
      clean(f.type),
      clean(airlineName),
      clean(f.origin),
      clean(f.destination)
    ].join(',') + '\n';

    fs.appendFile(FLIGHT_LOG_FILE, line, err => {
      if (err) {
        console.error(
          '[FlightLog] Failed to write:',
          err.message
        );
      }
    });
  } catch (err) {
    console.error(
      '[FlightLog] Error preparing line:',
      err.message
    );
  }
}

// -----------------------------
// Small helper for airport logging
// -----------------------------
function makeAirportLine(value) {
  if (!value) return null;

  if (typeof value === 'object') {
    const code = (
      value.iata ||
      value.icao ||
      value.code ||
      ''
    )
      .toString()
      .trim()
      .toUpperCase();

    if (!code) return null;

    const details = (
      value.name ||
      [value.city, value.country]
        .filter(Boolean)
        .join(', ') ||
      'Unknown location'
    ).trim();

    return {
      code,
      line: `${code} - ${details}`
    };
  }

  if (typeof value === 'string') {
    const clean = value
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/\r/g, '')
      .trim();

    const parts = clean
      .split('\n')
      .map(p => p.trim())
      .filter(Boolean);

    let code = '';
    let details = '';

    if (
      parts.length >= 2 &&
      /^[A-Za-z0-9]{3,4}$/.test(parts[0])
    ) {
      code = parts[0].toUpperCase();
      details = parts.slice(1).join(', ');
    } else if (parts.length === 1) {
      const found =
        (parts[0].match(/\b[A-Za-z0-9]{3,4}\b/) || [])[0];

      if (found) {
        code = found.toUpperCase();
        details =
          parts[0].replace(found, '').trim() ||
          parts[0];
      } else {
        code = parts[0]
          .substring(0, 3)
          .toUpperCase();

        details = parts[0];
      }
    } else {
      const found = parts.find(
        p => /^[A-Za-z0-9]{3,4}$/.test(p)
      );

      if (found) {
        code = found.toUpperCase();

        details = parts
          .filter(p => p !== found)
          .join(', ');
      } else {
        code = parts[0]
          .substring(0, 3)
          .toUpperCase();

        details =
          parts.slice(1).join(', ') ||
          parts[0];
      }
    }

    if (!code) return null;

    return {
      code,
      line: `${code} - ${details || 'Unknown location'}`
    };
  }

  return null;
}



// -----------------------------
// Load Aircraft Database
// Supports both tar1090/readsb semicolon format and the legacy OpenSky CSV.
// -----------------------------
const AIRCRAFT_DB_FILE = path.join(__dirname, 'aircraftDatabase.csv');
const aircraftDb = {};

function loadAircraftDatabase() {
  let csvRaw;

  try {
    csvRaw = fs
      .readFileSync(AIRCRAFT_DB_FILE, 'utf-8')
      .replace(/^\uFEFF/, '');
  } catch (err) {
    console.error(
      '[AircraftDB] Failed to read aircraftDatabase.csv:',
      err.message
    );
    return;
  }

  const firstDataLine =
    csvRaw
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(
        line =>
          line &&
          !line.startsWith('#')
      ) || '';

  // tar1090/readsb:
  // ICAO;Registration;Type;Flags;Description;Year;Owner/Operator
  if (firstDataLine.includes(';')) {
    const parsed =
      Papa.parse(
        csvRaw,
        {
          delimiter: ';',
          header: false,
          skipEmptyLines: true,
          comments: '#'
        }
      );

    let loaded = 0;

    parsed.data.forEach(row => {
      if (
        !Array.isArray(row) ||
        row.length < 3
      ) {
        return;
      }

      const icao24 =
        String(row[0] || '')
          .trim()
          .toLowerCase();

      if (!/^[0-9a-f]{6}$/.test(icao24)) {
        return;
      }

      aircraftDb[icao24] = {
        registration:
          String(row[1] || '').trim() ||
          null,
        typecode:
          String(row[2] || '').trim() ||
          null,
        description:
          String(row[4] || '').trim() ||
          null,
        year:
          String(row[5] || '').trim() ||
          null,
        owner:
          String(row[6] || '').trim() ||
          null,
        source: 'tar1090'
      };

      loaded += 1;
    });

    console.log(
      `[AircraftDB] Loaded ${loaded.toLocaleString()} aircraft from tar1090/readsb database`
    );

    return;
  }

  // Legacy OpenSky CSV fallback.
  const cleaned =
    csvRaw
      .split('\n')
      .filter(
        line =>
          !line.startsWith('#')
      )
      .join('\n');

  const parsed =
    Papa.parse(
      cleaned,
      {
        header: true,
        skipEmptyLines: true,
        quoteChar: `'`,
        transformHeader:
          h =>
            h
              .replace(/'/g, '')
              .trim()
      }
    );

  let loaded = 0;

  parsed.data.forEach(row => {
    if (!row.icao24) return;

    aircraftDb[
      String(row.icao24)
        .trim()
        .toLowerCase()
    ] = {
      ...row,
      source: 'opensky'
    };

    loaded += 1;
  });

  console.log(
    `[AircraftDB] Loaded ${loaded.toLocaleString()} aircraft from legacy OpenSky database`
  );
}

loadAircraftDatabase();


// -----------------------------
// Load friendly aircraft type names from planes.dat
// -----------------------------
const planeTypes = {};

try {
  const datRaw =
    fs.readFileSync(
      path.join(__dirname, 'planes.dat'),
      'utf-8'
    );

  datRaw
    .split(/\r?\n/)
    .forEach(line => {
      line = line.trim();

      if (
        !line ||
        line.startsWith('#')
      ) {
        return;
      }

      const parts =
        line
          .split(',')
          .map(
            p =>
              p
                .replace(/^"|"$/g, '')
                .trim()
          );

      if (
        parts.length >= 3 &&
        parts[2]
      ) {
        planeTypes[
          parts[2].toUpperCase()
        ] = parts[0];
      }
    });

  console.log(
    `[PlaneTypes] Loaded ${Object.keys(planeTypes).length.toLocaleString()} friendly aircraft type mappings`
  );
} catch (err) {
  console.warn(
    '[PlaneTypes] planes.dat not found or failed to load:',
    err.message
  );
}

function friendlyAircraftType({
  adsbType,
  adsbIcaoType,
  localMeta
}) {
  const localTypeCode =
    String(
      localMeta?.typecode ||
      localMeta?.icao_type ||
      ''
    )
      .trim()
      .toUpperCase();

  const adsbTypeCode =
    String(
      adsbIcaoType ||
      ''
    )
      .trim()
      .toUpperCase();

  return (
    planeTypes[adsbTypeCode] ||
    planeTypes[localTypeCode] ||
    adsbType ||
    localMeta?.description ||
    localMeta?.model ||
    localMeta?.type ||
    localTypeCode ||
    adsbTypeCode ||
    null
  );
}

// -----------------------------
// Load Airline Map
// -----------------------------
let airlineMap = {};

function loadAirlineMap() {
  try {
    const raw = fs.readFileSync(
      path.join(__dirname, 'airlineMap.json'),
      'utf-8'
    );

    airlineMap = JSON.parse(raw);

    console.log(
      `[Airlines] Loaded ${Object.keys(airlineMap).length.toLocaleString()} airline mappings`
    );
  } catch (err) {
    airlineMap = {};
    console.error(
      '[Airlines] Failed to load airlineMap.json:',
      err.message
    );
  }
}

loadAirlineMap();

// -----------------------------
// Load OpenSky credentials from persistent Admin settings
// -----------------------------
let credentialSets = [];
let currentCredIndex = 0;
let authToken = null;
let tokenExpiry = 0;

function refreshCredentialSets() {
  const configured = [
    appSettings.openSky.primary,
    appSettings.openSky.backup
  ].filter(c => c.clientId && c.clientSecret);

  credentialSets = configured;
  currentCredIndex = 0;
  authToken = null;
  tokenExpiry = 0;
}

refreshCredentialSets();

// -----------------------------
// Auth token management
// -----------------------------
async function getAuthToken() {
  const now = Date.now();

  if (
    authToken &&
    now < tokenExpiry - 60 * 1000
  ) {
    return authToken;
  }

  const creds = credentialSets[currentCredIndex];

  const tokenUrl =
    'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: creds.clientId,
    client_secret: creds.clientSecret
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type':
        'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });

  if (!res.ok) {
    throw new Error(
      `Token request failed: ${res.status} ${res.statusText}`
    );
  }

  const data = await res.json();

  authToken = data.access_token;
  tokenExpiry = now + data.expires_in * 1000;

  return authToken;
}

async function authHeaders() {
  if (!credentialSets.length) return {};
  const token = await getAuthToken();
  return { Authorization: `Bearer ${token}` };
}

// -----------------------------
// ADSBDB route and aircraft lookup
// -----------------------------
const ADSBDB_BASE_URL = 'https://api.adsbdb.com/v0';

const ADSBDB_HTTPS_AGENT =
  new https.Agent({
    family: 4,
    keepAlive: true
  });
const ADSBDB_CACHE_MS = 30 * 60 * 1000;
const adsbdbCache = new Map();
const adsbdbFailureCache = new Map();

function normaliseCallsign(value) {
  return String(value || '').replace(/\s+/g, '').trim().toUpperCase();
}

async function fetchAdsbdbJson(url, label) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(),
    10000
  );

  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'fernpath-flight-tracker/1.0'
      },
      agent: ADSBDB_HTTPS_AGENT,
      signal: controller.signal
    });

    if (res.status === 429) {
      console.warn(
        `[ADSBDB] Rate limit reached for ${label}. Backing off.`
      );
      return { status: 429, data: null };
    }

    if (res.status === 404) {
      return { status: 404, data: null };
    }

    if (!res.ok) {
      console.warn(
        `[ADSBDB] ${label} lookup returned HTTP ${res.status} ${res.statusText}`
      );
      return { status: res.status, data: null };
    }

    const data = await res.json();
    return { status: res.status, data };
  } catch (err) {
    const details = [
      err?.name,
      err?.type,
      err?.code,
      err?.errno,
      err?.message,
      err?.cause?.code,
      err?.cause?.message
    ]
      .filter(Boolean)
      .join(' | ');

    console.error(
      `[ADSBDB] ${label} request failed: ${details || String(err)}`
    );

    return { status: 0, data: null };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function lookupAdsbdb(icao24, callsign) {
  const modeS = String(icao24 || '').trim().toUpperCase();
  const cleanCallsign = normaliseCallsign(callsign);

  if (
    !modeS ||
    !/^[0-9A-F]{6}$/.test(modeS) ||
    !cleanCallsign
  ) {
    return null;
  }

  const cacheKey = `${modeS}:${cleanCallsign}`;
  const now = Date.now();

  const cached = adsbdbCache.get(cacheKey);
  if (
    cached &&
    now - cached.timestamp < ADSBDB_CACHE_MS
  ) {
    return cached.data;
  }

  const failed = adsbdbFailureCache.get(cacheKey);
  if (
    failed &&
    now - failed < 5 * 60 * 1000
  ) {
    return null;
  }

  const aircraftUrl =
    `${ADSBDB_BASE_URL}/aircraft/${encodeURIComponent(modeS)}`;

  const routeUrl =
    `${ADSBDB_BASE_URL}/callsign/${encodeURIComponent(cleanCallsign)}`;

  // Keep these sequential rather than Promise.all so a burst of nearby aircraft
  // does not double the instantaneous request rate to ADSBDB.
  const aircraftResult =
    await fetchAdsbdbJson(
      aircraftUrl,
      `aircraft ${modeS}`
    );

  const routeResult =
    await fetchAdsbdbJson(
      routeUrl,
      `callsign ${cleanCallsign}`
    );

  if (aircraftResult.status === 404) {
    console.warn(
      `[ADSBDB] No aircraft record for ${modeS}`
    );
  }

  if (routeResult.status === 404) {
    console.warn(
      `[ADSBDB] No route record for ${cleanCallsign}`
    );
  }

  const aircraft =
    aircraftResult.data?.response?.aircraft ||
    {};

  const route =
    routeResult.data?.response?.flightroute ||
    {};

  const origin = route.origin || null;
  const destination = route.destination || null;
  const routeAirline = route.airline || null;

  const hasUsefulData =
    Boolean(
      aircraft.registration ||
      aircraft.type ||
      aircraft.icao_type ||
      origin ||
      destination ||
      routeAirline
    );

  if (!hasUsefulData) {
    // Only cache genuine failures. A simple 404 is also cached briefly so we
    // do not hammer ADSBDB repeatedly for an unknown aircraft/callsign.
    adsbdbFailureCache.set(cacheKey, now);
    return null;
  }

  const data = {
    registration:
      aircraft.registration ||
      null,

    type:
      aircraft.type ||
      aircraft.icao_type ||
      null,

    icaoType:
      aircraft.icao_type ||
      null,

    airline:
      routeAirline
        ? {
            name:
              routeAirline.name ||
              null,
            icao:
              routeAirline.icao ||
              null,
            iata:
              routeAirline.iata ||
              null
          }
        : null,

    origin:
      origin
        ? {
            iata:
              origin.iata_code ||
              null,
            icao:
              origin.icao_code ||
              null,
            name:
              origin.name ||
              null,
            municipality:
              origin.municipality ||
              null,
            country:
              origin.country_name ||
              null
          }
        : null,

    destination:
      destination
        ? {
            iata:
              destination.iata_code ||
              null,
            icao:
              destination.icao_code ||
              null,
            name:
              destination.name ||
              null,
            municipality:
              destination.municipality ||
              null,
            country:
              destination.country_name ||
              null
          }
        : null
  };

  adsbdbCache.set(
    cacheKey,
    {
      timestamp: now,
      data
    }
  );

  return data;
}

function formatAdsbAirport(airport) {
  if (!airport) return 'Unknown';

  const code = airport.iata || airport.icao || '';
  const location = [airport.municipality, airport.country]
    .filter(Boolean)
    .join(', ');
  const details = location || airport.name || 'Unknown location';

  if (!code) return details;
  return `${code}<br>${details}`;
}

// -----------------------------
// Helpers
// -----------------------------
function bboxAround(
  lat,
  lon,
  radiusKm
) {
  const dLat =
    radiusKm / 111.0;

  const dLon =
    radiusKm /
    (
      111.320 *
      Math.cos(
        lat *
        Math.PI /
        180
      )
    );

  return {
    lamin: lat - dLat,
    lamax: lat + dLat,
    lomin: lon - dLon,
    lomax: lon + dLon
  };
}

function haversineKm(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const toRad =
    d =>
      d *
      Math.PI /
      180;

  const R = 6371;

  const dLat =
    toRad(lat2 - lat1);

  const dLon =
    toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;

  const c =
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return R * c;
}

function openSkyCacheMs() {
  return Math.max(5, Number(appSettings.poll_interval_seconds) || 15) * 1000;
}

const OPENSKY_MIN_BACKOFF_MS = 60 * 1000;

let openSkyCache = {
  key: null,
  timestamp: 0,
  states: []
};

let openSkyFetchPromise = null;
let openSkyFetchKey = null;
let openSkyBackoffUntil = 0;

function openSkyBoxKey({ lamin, lamax, lomin, lomax }) {
  return [lamin, lamax, lomin, lomax]
    .map(value => Number(value).toFixed(6))
    .join(':');
}

async function fetchStatesBBox({
  lamin,
  lamax,
  lomin,
  lomax
}, retryCount = 0) {
  const qs =
    new URLSearchParams({
      lamin,
      lamax,
      lomin,
      lomax
    }).toString();

  const url =
    `https://opensky-network.org/api/states/all?${qs}`;

  const headers =
    await authHeaders();

  const res =
    await fetch(url, {
      headers
    });

  if (res.status === 429) {
    // The initial request already used one credential, so only retry for
    // credentials we have not tried yet. This prevents wrapping around and
    // hitting the first account a second time during the same refresh.
    const maxRetries =
      Math.max(
        0,
        credentialSets.length - 1
      );

    if (retryCount >= maxRetries) {
      const retryAfterSeconds = Number.parseInt(
        res.headers.get('x-rate-limit-retry-after-seconds') ||
        res.headers.get('retry-after') ||
        '0',
        10
      );

      const err = new Error(
        'OpenSky rate limit reached after trying available credentials'
      );

      err.retryAfterMs =
        Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
          ? retryAfterSeconds * 1000
          : OPENSKY_MIN_BACKOFF_MS;

      throw err;
    }

    if (credentialSets.length > 1) {
      currentCredIndex =
        (
          currentCredIndex + 1
        ) %
        credentialSets.length;

      console.warn(
        `[OpenSky] 429 Too Many Requests. Switching to credential set #${currentCredIndex + 1}...`
      );
    } else {
      console.warn(
        '[OpenSky] 429 Too Many Requests. Retrying once before backing off.'
      );
    }

    authToken = null;

    return fetchStatesBBox(
      {
        lamin,
        lamax,
        lomin,
        lomax
      },
      retryCount + 1
    );
  }

  if (!res.ok) {
    throw new Error(
      `OpenSky error: ${res.status}`
    );
  }

  const json =
    await res.json();

  return json.states || [];
}

async function getOpenSkyStates(box) {
  const now = Date.now();
  const key = openSkyBoxKey(box);

  if (
    openSkyCache.key === key &&
    now - openSkyCache.timestamp < openSkyCacheMs()
  ) {
    return openSkyCache.states;
  }

  // If another browser has already kicked off the refresh for this exact
  // tracking area, share that request rather than making another API call.
  if (
    openSkyFetchPromise &&
    openSkyFetchKey === key
  ) {
    return openSkyFetchPromise;
  }

  // While OpenSky has asked us to back off, keep serving the most recent
  // states rather than repeatedly hammering a rate-limited endpoint.
  if (now < openSkyBackoffUntil) {
    if (openSkyCache.key === key) {
      return openSkyCache.states;
    }
    return [];
  }

  openSkyFetchKey = key;
  openSkyFetchPromise = (async () => {
    try {
      const states = await fetchStatesBBox(box);

      openSkyCache = {
        key,
        timestamp: Date.now(),
        states
      };

      openSkyBackoffUntil = 0;
      return states;
    } catch (err) {
      if (err?.retryAfterMs) {
        openSkyBackoffUntil =
          Date.now() +
          Math.max(
            OPENSKY_MIN_BACKOFF_MS,
            err.retryAfterMs
          );

        console.warn(
          `[OpenSky] Backing off API calls for ${Math.ceil((openSkyBackoffUntil - Date.now()) / 1000)} seconds.`
        );
      }

      // A slightly stale aircraft picture is more useful than an empty one,
      // and lastSeenMap will continue ageing entries normally.
      if (openSkyCache.key === key) {
        return openSkyCache.states;
      }

      throw err;
    } finally {
      openSkyFetchPromise = null;
      openSkyFetchKey = null;
    }
  })();

  return openSkyFetchPromise;
}

// -----------------------------
// Last seen aircraft
// -----------------------------
const lastSeenMap =
  new Map();

// -----------------------------
// HTTP Server
// -----------------------------
const server =
  http.createServer(
    async (req, res) => {
      try {
        if (
          req.url.startsWith(
            '/api/logs'
          )
        ) {
          const urlObj =
            new URL(
              req.url,
              'http://localhost'
            );

          const requested =
            Number.parseInt(
              urlObj.searchParams.get(
                'limit'
              ) || '200',
              10
            );

          const limit =
            Number.isFinite(
              requested
            )
              ? Math.max(
                  1,
                  Math.min(
                    requested,
                    MAX_APP_LOGS
                  )
                )
              : 200;

          res.writeHead(200, {
            'content-type':
              'application/json',
            'cache-control':
              'no-store'
          });

          res.end(
            JSON.stringify({
              logs:
                appLogs.slice(
                  -limit
                ),
              max:
                MAX_APP_LOGS
            })
          );

          return;
        }

        if (
          req.url === '/' ||
          req.url ===
            '/index.html'
        ) {
          res.writeHead(200, {
            'content-type':
              'text/html'
          });

          fs
            .createReadStream(
              path.join(
                __dirname,
                'index.html'
              )
            )
            .pipe(res);

          return;
        }

        if (
          req.url ===
          '/client.js'
        ) {
          res.writeHead(200, {
            'content-type':
              'application/javascript'
          });

          fs
            .createReadStream(
              path.join(
                __dirname,
                'client.js'
              )
            )
            .pipe(res);

          return;
        }

        if (
          req.url ===
          '/screen.html'
        ) {
          res.writeHead(200, {
            'content-type':
              'text/html'
          });

          fs
            .createReadStream(
              path.join(
                __dirname,
                'screen.html'
              )
            )
            .pipe(res);

          return;
        }

        if (
          req.url ===
          '/screen.js'
        ) {
          res.writeHead(200, {
            'content-type':
              'application/javascript'
          });

          fs
            .createReadStream(
              path.join(
                __dirname,
                'screen.js'
              )
            )
            .pipe(res);

          return;
        }

        if (
          req.url.startsWith(
            '/logo/'
          )
        ) {
          const logoPath =
            path.join(
              __dirname,
              req.url
            );

          if (
            fs.existsSync(
              logoPath
            )
          ) {
            const ext =
              path
                .extname(
                  logoPath
                )
                .toLowerCase();

            let contentType =
              'application/octet-stream';

            if (
              ext === '.png'
            ) {
              contentType =
                'image/png';
            } else if (
              ext === '.jpg' ||
              ext === '.jpeg'
            ) {
              contentType =
                'image/jpeg';
            } else if (
              ext === '.svg'
            ) {
              contentType =
                'image/svg+xml';
            } else if (
              ext === '.gif'
            ) {
              contentType =
                'image/gif';
            }

            res.writeHead(200, {
              'content-type':
                contentType
            });

            fs
              .createReadStream(
                logoPath
              )
              .pipe(res);

            return;
          } else {
            res.writeHead(404);
            res.end(
              'Logo not found'
            );
            return;
          }
        }

        if (
          req.url.startsWith(
            '/bgs/'
          )
        ) {
          const bgPath =
            path.join(
              __dirname,
              req.url
            );

          if (
            fs.existsSync(
              bgPath
            )
          ) {
            const ext =
              path
                .extname(
                  bgPath
                )
                .toLowerCase();

            let contentType =
              'application/octet-stream';

            if (
              ext === '.png'
            ) {
              contentType =
                'image/png';
            } else if (
              ext === '.jpg' ||
              ext === '.jpeg'
            ) {
              contentType =
                'image/jpeg';
            } else if (
              ext === '.svg'
            ) {
              contentType =
                'image/svg+xml';
            } else if (
              ext === '.gif'
            ) {
              contentType =
                'image/gif';
            }

            res.writeHead(200, {
              'content-type':
                contentType
            });

            fs
              .createReadStream(
                bgPath
              )
              .pipe(res);

            return;
          } else {
            res.writeHead(404);
            res.end(
              'Background not found'
            );
            return;
          }
        }

        if (
          req.url ===
            '/admin' ||
          req.url ===
            '/admin.html'
        ) {
          res.writeHead(200, {
            'content-type':
              'text/html; charset=utf-8'
          });

          fs
            .createReadStream(
              path.join(
                __dirname,
                'admin.html'
              )
            )
            .pipe(res);

          return;
        }

        if (
          req.url ===
            '/api/admin/settings' &&
          req.method ===
            'GET'
        ) {
          res.writeHead(200, {
            'content-type': 'application/json',
            'cache-control': 'no-store'
          });
          res.end(JSON.stringify({ settings: publicSettings() }));
          return;
        }

        if (
          req.url ===
            '/api/admin/settings' &&
          req.method ===
            'POST'
        ) {
          try {
            const body = await readRequestBody(req, 1024 * 1024);
            let data;
            try {
              data = JSON.parse(body.toString('utf8'));
            } catch (_) {
              throw new Error('Invalid JSON request');
            }

            const current = appSettings;
            const incoming = data || {};
            const openSkyIncoming = incoming.openSky || {};

            const secretValue = (entry, currentSecret) => {
              if (!entry || typeof entry !== 'object') return currentSecret;
              if (entry.clientSecret == null) return currentSecret;

              const submittedSecret = String(entry.clientSecret);

              // A blank or masked field means "leave the existing secret alone".
              // This prevents unrelated Admin changes (such as location/radius)
              // from accidentally wiping stored OpenSky credentials.
              if (
                !submittedSecret.trim() ||
                submittedSecret === '••••••••'
              ) {
                return currentSecret;
              }

              return submittedSecret;
            };

            const next = {
              lat: incoming.lat,
              lon: incoming.lon,
              radius_km: incoming.radius_km,
              poll_interval_seconds: incoming.poll_interval_seconds,
              display_timezone: incoming.display_timezone,
              openSky: {
                primary: {
                  clientId: String(openSkyIncoming.primary?.clientId || ''),
                  clientSecret: secretValue(openSkyIncoming.primary, current.openSky.primary.clientSecret)
                },
                backup: {
                  clientId: String(openSkyIncoming.backup?.clientId || ''),
                  clientSecret: secretValue(openSkyIncoming.backup, current.openSky.backup.clientSecret)
                }
              }
            };

            saveAppSettings(next);
            refreshCredentialSets();

            console.log(`[Settings] Updated tracker location to ${appSettings.lat}, ${appSettings.lon} (${appSettings.radius_km} km radius), OpenSky polling every ${appSettings.poll_interval_seconds}s, local timezone ${appSettings.display_timezone}`);

            res.writeHead(200, {
              'content-type': 'application/json',
              'cache-control': 'no-store'
            });
            res.end(JSON.stringify({ status: 'ok', settings: publicSettings() }));
          } catch (err) {
            res.writeHead(400, {
              'content-type': 'application/json',
              'cache-control': 'no-store'
            });
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        if (req.url === '/api/health' && req.method === 'GET') {
          res.writeHead(200, {
            'content-type': 'application/json',
            'cache-control': 'no-store'
          });
          res.end(JSON.stringify({ status: 'ok' }));
          return;
        }

        if (
          req.url ===
            '/api/admin/backgrounds' &&
          req.method ===
            'GET'
        ) {
          const airports =
            getKnownAirports();

          const missing =
            airports.filter(
              a =>
                !findBackground(
                  a.code
                )
            );

          res.writeHead(200, {
            'content-type':
              'application/json'
          });

          res.end(
            JSON.stringify({
              airports,
              missing
            })
          );

          return;
        }

        if (
          req.url ===
            '/api/admin/backgrounds/upload' &&
          req.method ===
            'POST'
        ) {
          try {
            const body =
              await readRequestBody(
                req
              );

            const parts =
              parseMultipart(
                body,
                req.headers[
                  'content-type'
                ]
              );

            const codePart =
              parts.find(
                p =>
                  p.name ===
                  'airportCode'
              );

            const filePart =
              parts.find(
                p =>
                  p.name ===
                    'image' &&
                  p.filename
              );

            const code =
              codePart
                ? codePart.data
                    .toString(
                      'utf8'
                    )
                    .trim()
                    .toUpperCase()
                : '';

            if (
              !/^[A-Z0-9]{3,4}$/.test(
                code
              )
            ) {
              throw new Error(
                'Airport code must be 3 or 4 letters/numbers'
              );
            }

            if (
              !filePart ||
              !filePart.data.length
            ) {
              throw new Error(
                'Choose an image to upload'
              );
            }

            const mimeToExt = {
              'image/jpeg':
                '.jpg',
              'image/png':
                '.png',
              'image/webp':
                '.webp',
              'image/gif':
                '.gif'
            };

            const ext =
              mimeToExt[
                filePart.mime
              ];

            if (!ext) {
              throw new Error(
                'Only JPG, PNG, WebP and GIF images are supported'
              );
            }

            for (
              const oldExt
              of BG_EXTENSIONS
            ) {
              const oldPath =
                path.join(
                  BGS_DIR,
                  code + oldExt
                );

              if (
                fs.existsSync(
                  oldPath
                )
              ) {
                fs.unlinkSync(
                  oldPath
                );
              }
            }

            const filename =
              code + ext;

            fs.writeFileSync(
              path.join(
                BGS_DIR,
                filename
              ),
              filePart.data
            );

            console.log(
              `[Backgrounds] Saved ${filename}`
            );

            res.writeHead(200, {
              'content-type':
                'application/json'
            });

            res.end(
              JSON.stringify({
                status: 'ok',
                code,
                filename
              })
            );
          } catch (err) {
            res.writeHead(400, {
              'content-type':
                'application/json'
            });

            res.end(
              JSON.stringify({
                error:
                  err.message
              })
            );
          }

          return;
        }

        if (
          req.url.startsWith(
            '/api/background/'
          )
        ) {
          const code =
            decodeURIComponent(
              req.url
                .slice(
                  '/api/background/'
                    .length
                )
                .split('?')[0]
            ).toUpperCase();

          const bgPath =
            findBackground(code);

          if (!bgPath) {
            res.writeHead(404);
            res.end(
              'Background not found'
            );
            return;
          }

          const ext =
            path
              .extname(
                bgPath
              )
              .toLowerCase();

          res.writeHead(200, {
            'content-type':
              BG_CONTENT_TYPES[
                ext
              ] ||
              'application/octet-stream',
            'cache-control':
              'no-cache'
          });

          fs
            .createReadStream(
              bgPath
            )
            .pipe(res);

          return;
        }

        if (
          req.url ===
          '/api/reload-airlines'
        ) {
          loadAirlineMap();

          res.writeHead(200, {
            'content-type':
              'application/json'
          });

          res.end(
            JSON.stringify({
              status: 'ok',
              message:
                'airlineMap.json reloaded'
            })
          );

          return;
        }

        if (
          req.url.startsWith(
            '/api/traffic'
          )
        ) {
          const now =
            Date.now();

          const box =
            bboxAround(
              appSettings.lat,
              appSettings.lon,
              appSettings.radius_km
            );

          let states = [];

          try {
            states =
              await getOpenSkyStates(
                box
              );
          } catch (err) {
            console.error(
              'OpenSky fetch failed:',
              err.message
            );
          }

          const newAirportLines =
            [];

          const newUnknownFlights =
            [];

          await Promise.all(
            states.map(
              async s => {
                if (
                  s[5] == null ||
                  s[6] == null
                ) {
                  return;
                }

                if (
                  haversineKm(
                    appSettings.lat,
                    appSettings.lon,
                    s[6],
                    s[5]
                  ) >
                  appSettings.radius_km
                ) {
                  return;
                }

                const icao24 =
                  s[0]
                    ?.toLowerCase() ||
                  '';

                const callsign =
                  (
                    s[1] || ''
                  ).trim();

                const lat =
                  s[6];

                const lon =
                  s[5];

                const prev =
                  lastSeenMap.get(
                    icao24
                  );

                const flightNo =
                  callsign.length > 2
                    ? callsign.replace(/\s+/g, '')
                    : null;

                const acMeta =
                  aircraftDb[icao24] ||
                  {};

                let airline = null;
                let origin = 'Unknown';
                let destination = 'Unknown';

                let registration =
                  acMeta.registration ||
                  acMeta.Registration ||
                  null;

                let type =
                  friendlyAircraftType({
                    adsbType: null,
                    adsbIcaoType: null,
                    localMeta: acMeta
                  });

                if (flightNo && (!prev || prev.data.origin === 'Unknown' || prev.data.destination === 'Unknown')) {
                  const adsbData = await lookupAdsbdb(icao24, flightNo);

                  if (adsbData) {
                    registration =
                      adsbData.registration ||
                      registration;

                    type =
                      friendlyAircraftType({
                        adsbType:
                          adsbData.type,
                        adsbIcaoType:
                          adsbData.icaoType,
                        localMeta:
                          acMeta
                      }) ||
                      type;

                    origin = formatAdsbAirport(adsbData.origin);
                    destination = formatAdsbAirport(adsbData.destination);

                    if (adsbData.airline?.name) {
                      airline = {
                        name: adsbData.airline.name,
                        logo: airlineMap[adsbData.airline.icao]?.logo || null
                      };
                    }
                  }
                }

                if (prev) {
                  origin = prev.data.origin || origin;
                  destination = prev.data.destination || destination;
                  registration = prev.data.registration || registration;
                  type = prev.data.type || type;
                  airline = prev.data.airline || airline;
                }

                if (!airline && callsign.length >= 3) {
                  const code = callsign.slice(0, 3).toUpperCase();
                  if (airlineMap[code]) {
                    airline = {
                      name: airlineMap[code].name,
                      logo: airlineMap[code].logo
                    };
                  }
                }

                const oa =
                  makeAirportLine(
                    origin
                  );

                if (
                  oa &&
                  oa.code &&
                  oa.code !==
                    'UNK' &&
                  !loggedAirports.has(
                    oa.code
                  )
                ) {
                  loggedAirports.add(
                    oa.code
                  );

                  newAirportLines.push(
                    oa.line
                  );
                }

                const da =
                  makeAirportLine(
                    destination
                  );

                if (
                  da &&
                  da.code &&
                  da.code !==
                    'UNK' &&
                  !loggedAirports.has(
                    da.code
                  )
                ) {
                  loggedAirports.add(
                    da.code
                  );

                  newAirportLines.push(
                    da.line
                  );
                }

                if (
                  !airline ||
                  !airline.name
                ) {
                  if (
                    flightNo &&
                    !loggedUnknownAirlines.has(
                      flightNo
                    )
                  ) {
                    loggedUnknownAirlines.add(
                      flightNo
                    );

                    newUnknownFlights.push(
                      flightNo
                    );
                  }
                }

                const aircraftData = {
                  icao24,
                  callsign,
                  flightNo,
                  lat,
                  lon,
                  registration,
                  type,
                  airline,
                  origin,
                  destination,
                  firstSeen:
                    prev?.data.firstSeen ||
                    now
                };

                lastSeenMap.set(
                  icao24,
                  {
                    timestamp:
                      now,
                    data:
                      aircraftData
                  }
                );

                if (!prev) {
                  logFlightSnapshot(
                    aircraftData
                  );
                }
              }
            )
          );

          try {
            if (
              newAirportLines.length
            ) {
              fs.appendFileSync(
                AIRPORTS_FILE,
                newAirportLines
                  .join('\n') +
                  '\n',
                'utf8'
              );

              console.log(
                `[Airports] Logged ${newAirportLines.length} new airports`
              );
            }
          } catch (err) {
            console.error(
              '[Airports] Failed to write airports file:',
              err.message
            );
          }

          try {
            if (
              newUnknownFlights.length
            ) {
              fs.appendFileSync(
                UNKNOWN_AIRLINES_FILE,
                newUnknownFlights
                  .join('\n') +
                  '\n',
                'utf8'
              );

              console.log(
                `[UnknownAirlines] Logged ${newUnknownFlights.length} unknown flights`
              );
            }
          } catch (err) {
            console.error(
              '[UnknownAirlines] Failed to write unknown airlines file:',
              err.message
            );
          }

          const result = [];

          for (
            const [
              icao,
              info
            ]
            of lastSeenMap.entries()
          ) {
            if (
              now -
                info.timestamp <=
              KEEP_ALIVE_MS
            ) {
              result.push(
                info.data
              );
            } else {
              lastSeenMap.delete(
                icao
              );
            }
          }

          res.writeHead(200, {
            'content-type':
              'application/json'
          });

          res.end(
            JSON.stringify({
              centre: {
                lat: appSettings.lat,
                lon: appSettings.lon
              },
              radius_km:
                appSettings.radius_km,
              poll_interval_seconds:
                appSettings.poll_interval_seconds,
              display_timezone:
                appSettings.display_timezone,
              server_time: {
                epoch_ms: Date.now(),
                timezone: appSettings.display_timezone,
                minutes_since_midnight:
                  minutesSinceMidnightInTimeZone(appSettings.display_timezone)
              },
              count:
                result.length,
              aircraft:
                result
            })
          );

          return;
        }

        if (
          req.url.startsWith(
            '/api/stats'
          )
        ) {
          try {
            const urlObj = new URL(req.url, 'http://localhost');
            const fromParam = urlObj.searchParams.get('from');
            const toParam = urlObj.searchParams.get('to');
            const validDateParam = value => !value || /^\d{4}-\d{2}-\d{2}$/.test(value);

            if (!validDateParam(fromParam) || !validDateParam(toParam)) {
              throw new Error('Date filters must use YYYY-MM-DD');
            }

            const timeZone = appSettings.display_timezone;
            const dateFormatter = getLocalDateFormatter(timeZone);
            const timeFormatter = getLocalTimeFormatter(timeZone);
            const localToday = dateFormatter.format(new Date());

            const emptyStats = () => ({
              timezone: timeZone,
              localToday,
              byHour: Array.from({ length: 24 }, () => 0),
              byQuarterHour: Array.from({ length: 96 }, () => 0),
              flightsByAircraft: {},
              flightsByAirline: {},
              flightsPerDay: {}
            });

            if (!fs.existsSync(FLIGHT_LOG_FILE)) {
              res.writeHead(200, { 'content-type': 'application/json' });
              res.end(JSON.stringify(emptyStats()));
              return;
            }

            const csvText = fs.readFileSync(FLIGHT_LOG_FILE, 'utf8');
            const parsedLog = Papa.parse(csvText, {
              header: true,
              skipEmptyLines: true
            });
            const rows = parsedLog.data || [];
            const stats = emptyStats();

            rows.forEach(r => {
              const ts = Number(r.timestamp);
              if (Number.isNaN(ts)) return;

              const d = new Date(ts);
              const dayKey = dateFormatter.format(d);

              // Compare calendar dates after converting each flight to the
              // configured local timezone. This remains correct across DST.
              if (fromParam && dayKey < fromParam) return;
              if (toParam && dayKey > toParam) return;

              const timeParts = timeFormatter.formatToParts(d);
              const h = Number(timeParts.find(p => p.type === 'hour')?.value);
              const minute = Number(timeParts.find(p => p.type === 'minute')?.value);

              if (Number.isFinite(h) && h >= 0 && h < 24) {
                stats.byHour[h] += 1;
              }

              if (Number.isFinite(h) && Number.isFinite(minute)) {
                const qIdx = Math.floor((h * 60 + minute) / 15);
                if (qIdx >= 0 && qIdx < 96) {
                  stats.byQuarterHour[qIdx] += 1;
                }
              }

              const type = (r.type || 'Unknown').trim() || 'Unknown';
              stats.flightsByAircraft[type] = (stats.flightsByAircraft[type] || 0) + 1;

              const airline = (r.airline || 'Unknown').trim() || 'Unknown';
              stats.flightsByAirline[airline] = (stats.flightsByAirline[airline] || 0) + 1;

              stats.flightsPerDay[dayKey] = (stats.flightsPerDay[dayKey] || 0) + 1;
            });

            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(stats));
          } catch (err) {
            console.error('[Stats] Error:', err.message);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to compute stats' }));
          }
          return;
        }

        if (
          req.url ===
            '/dashboard' ||
          req.url ===
            '/dashboard.html'
        ) {
          res.writeHead(200, {
            'content-type':
              'text/html'
          });

          fs
            .createReadStream(
              path.join(
                __dirname,
                'dashboard.html'
              )
            )
            .pipe(res);

          return;
        }

        if (
          req.url ===
          '/favicon.ico'
        ) {
          const favPath =
            path.join(
              __dirname,
              'favicon.ico'
            );

          if (
            fs.existsSync(
              favPath
            )
          ) {
            res.writeHead(200, {
              'content-type':
                'image/x-icon'
            });

            fs
              .createReadStream(
                favPath
              )
              .pipe(res);
          } else {
            res.writeHead(404);
            res.end();
          }

          return;
        }

        res.writeHead(404);
        res.end('Not found');
      } catch (err) {
        console.error(err);

        res.writeHead(500, {
          'content-type':
            'application/json'
        });

        res.end(
          JSON.stringify({
            error:
              String(
                err.message
              )
          })
        );
      }
    }
  );

server.listen(
  PORT,
  () =>
    console.log(
      `Server running at http://localhost:${PORT}`
    )
);

// -----------------------------
// Graceful shutdown
// -----------------------------
function shutdown(signal) {
  console.log(`[Shutdown] ${signal} received`);

  server.close(err => {
    if (err) {
      console.error(
        '[Shutdown] Error closing server:',
        err.message
      );
      process.exit(1);
      return;
    }

    process.exit(0);
  });

  setTimeout(
    () => process.exit(1),
    5000
  ).unref();
}

process.once(
  'SIGINT',
  () => shutdown('SIGINT')
);

process.once(
  'SIGTERM',
  () => shutdown('SIGTERM')
);
