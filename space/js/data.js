// Public, key-less data sources:
//   The Space Devs — Launch Library 2   launches, pads, vehicles, boosters
//   Open-Meteo                          weather at the pad, now and at T-0
//   wheretheiss.at                      live ISS state vector
//   GeoJS                               coarse IP location for the default site
import { SITES } from './sites.js';

const LL2 = ['https://ll.thespacedevs.com/2.3.0', 'https://lldev.thespacedevs.com/2.3.0'];
const store = {
  get(k, maxAge) {
    try {
      const v = JSON.parse(localStorage.getItem(k));
      if (v && (maxAge == null || Date.now() - v.t < maxAge)) return v.d;
    } catch {}
    return null;
  },
  set(k, d) { try { localStorage.setItem(k, JSON.stringify({ t: Date.now(), d })); } catch {} },
};

async function getJSON(url, ms = 12000) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
    return await r.json();
  } finally { clearTimeout(timer); }
}

// Launch Library allows ~15 anonymous calls an hour, so every response is
// cached; on a 429 the dev mirror (same schema, not rate-limited) takes over.
async function ll2(path, cacheKey, maxAge) {
  const fresh = store.get(cacheKey, maxAge);
  if (fresh) return { data: fresh, source: 'cache' };
  let lastErr;
  for (const base of LL2) {
    try {
      const data = await getJSON(base + path);
      store.set(cacheKey, data);
      return { data, source: base.includes('lldev') ? 'mirror' : 'live' };
    } catch (e) { lastErr = e; }
  }
  const stale = store.get(cacheKey, null);
  if (stale) return { data: stale, source: 'stale' };
  throw lastErr;
}

const num = v => (v == null || v === '' ? null : +v);
const isUS = l => {
  const pad = l.pad || {}, loc = pad.location || {};
  const cc = pad.country?.alpha_3_code || loc.country?.alpha_3_code || pad.country_code || loc.country_code || '';
  return cc === 'USA' || /,\s*USA$/i.test(loc.name || '');
};

export function normalize(l) {
  const pad = l.pad || {}, loc = pad.location || {}, cfg = l.rocket?.configuration || {}, mis = l.mission || {};
  const stage = (l.rocket?.launcher_stage || [])[0];
  const landing = stage?.landing;
  const landLoc = landing?.landing_location || landing?.location || {};
  const parts = (l.name || '').split('|');
  return {
    id: l.id,
    name: l.name,
    mission: mis.name || (parts[1] || parts[0] || '').trim(),
    missionDesc: mis.description || '',
    missionType: mis.type || '',
    orbit: mis.orbit?.abbrev || '',
    orbitName: mis.orbit?.name || '',
    net: Date.parse(l.net),
    windowStart: l.window_start ? Date.parse(l.window_start) : null,
    windowEnd: l.window_end ? Date.parse(l.window_end) : null,
    precision: l.net_precision?.name || l.net_precision?.abbrev || '',
    status: { abbrev: l.status?.abbrev || 'TBD', name: l.status?.name || '', id: l.status?.id, desc: l.status?.description || '' },
    probability: num(l.probability),
    weatherConcerns: l.weather_concerns || '',
    holdReason: l.holdreason || '',
    provider: l.launch_service_provider?.name || '',
    providerAbbrev: l.launch_service_provider?.abbrev || '',
    rocket: cfg.name || parts[0]?.trim() || 'Rocket',
    rocketFull: cfg.full_name || cfg.name || '',
    variant: cfg.variant || '',
    family: (cfg.families && cfg.families[0]?.name) || cfg.family || '',
    config: {
      length: num(cfg.length), diameter: num(cfg.diameter), mass: num(cfg.launch_mass), leo: num(cfg.leo_capacity), gto: num(cfg.gto_capacity),
      thrust: num(cfg.to_thrust), stages: num(cfg.max_stage), reusable: cfg.reusable, maiden: cfg.maiden_flight,
      launches: num(cfg.total_launch_count), successes: num(cfg.successful_launches), streak: num(cfg.consecutive_successful_launches),
      failures: num(cfg.failed_launches), landings: num(cfg.successful_landings), landingAttempts: num(cfg.attempted_landings),
    },
    pad: {
      id: pad.id, name: pad.name || '', lat: num(pad.latitude), lon: num(pad.longitude), map: pad.map_url || '',
      launches: num(pad.total_launch_count), orbital: num(pad.orbital_launch_attempt_count),
    },
    location: { id: loc.id, name: loc.name || '', tz: loc.timezone_name || '', lat: num(loc.latitude), lon: num(loc.longitude) },
    image: typeof l.image === 'string' ? l.image : l.image?.image_url || '',
    webcastLive: !!l.webcast_live,
    video: (l.vid_urls || l.vidURLs || []).map(v => (typeof v === 'string' ? v : v.url)).filter(Boolean)[0] || '',
    counts: {
      orbitalYear: num(l.orbital_launch_attempt_count_year), locationYear: num(l.location_launch_attempt_count_year),
      padYear: num(l.pad_launch_attempt_count_year), agencyYear: num(l.agency_launch_attempt_count_year),
      orbital: num(l.orbital_launch_attempt_count), location: num(l.location_launch_attempt_count),
      pad: num(l.pad_launch_attempt_count), agency: num(l.agency_launch_attempt_count),
    },
    padTurnaround: l.pad_turnaround || '',
    booster: stage ? {
      serial: stage.launcher?.serial_number || '', flights: num(stage.launcher?.flights), flightNo: num(stage.launcher_flight_number),
      reused: stage.reused, landing: landing ? {
        attempt: landing.attempt, type: landing.type?.abbrev || '', typeName: landing.type?.name || '',
        loc: landLoc.abbrev || landLoc.abbreviation || '', locName: landLoc.name || '', desc: landing.description || '',
      } : null,
    } : null,
    spacecraft: l.rocket?.spacecraft_stage?.spacecraft?.spacecraft_config?.name || l.rocket?.spacecraft_stage?.spacecraft?.name || '',
    detailed: !!l.rocket?.launcher_stage || !!l.vid_urls,
  };
}

export async function upcomingLaunches() {
  const ids = SITES.flatMap(s => s.ll2).join(',');
  const fields = '&mode=normal&hide_recent_previous=true&ordering=net';
  let res = await ll2(`/launches/upcoming/?limit=100&location__ids=${ids}${fields}`, 'jl:upcoming', 12 * 6e4);
  let list = (res.data.results || []).filter(isUS);
  if (!list.length) { // filter unsupported or IDs drifted: take everything, filter here
    res = await ll2(`/launches/upcoming/?limit=100${fields}`, 'jl:upcoming-all', 12 * 6e4);
    list = (res.data.results || []).filter(isUS);
  }
  return { launches: list.map(normalize).filter(l => l.pad.lat != null), source: res.source };
}

export async function launchDetail(id) {
  const { data } = await ll2(`/launches/${id}/?mode=detailed`, `jl:launch:${id}`, 25 * 6e4);
  return normalize(data);
}

const wxCache = new Map();
export async function weather(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`, hit = wxCache.get(key);
  if (hit && Date.now() - hit.t < 6e5) return hit.d;
  const cur = 'temperature_2m,relative_humidity_2m,apparent_temperature,dew_point_2m,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,is_day';
  const hourly = 'temperature_2m,precipitation_probability,weather_code,cloud_cover,cloud_cover_low,visibility,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cape,wind_speed_250hPa,wind_direction_250hPa,wind_speed_200hPa';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=${cur}&hourly=${hourly}&daily=sunrise,sunset&wind_speed_unit=kmh&timezone=auto&forecast_days=16`;
  const d = await getJSON(url);
  wxCache.set(key, { t: Date.now(), d });
  return d;
}

// Hourly forecast row nearest a timestamp (null beyond the 16-day horizon).
export function forecastAt(wx, ts) {
  const h = wx?.hourly;
  if (!h?.time) return null;
  const off = (wx.utc_offset_seconds || 0) * 1000;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < h.time.length; i++) {
    const t = Date.parse(h.time[i] + 'Z') - off, dd = Math.abs(t - ts);
    if (dd < bestD) { bestD = dd; best = i; }
  }
  if (best < 0 || bestD > 2 * 36e5) return null;
  const row = {};
  for (const k in h) row[k] = h[k][best];
  return row;
}

export async function iss() {
  return getJSON('https://api.wheretheiss.at/v1/satellites/25544', 6000);
}

// Coarse location from IP (no permission prompt). Falls back to the time zone.
export async function whereAmI() {
  const cached = store.get('jl:geo', 864e5);
  if (cached) return cached;
  try {
    const g = await getJSON('https://get.geojs.io/v1/ip/geo.json', 5000);
    if (g.latitude) {
      const v = { lat: +g.latitude, lon: +g.longitude, label: [g.city, g.region].filter(Boolean).join(', '), how: 'ip' };
      store.set('jl:geo', v);
      return v;
    }
  } catch {}
  return byTimeZone();
}

export function byTimeZone() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  const map = {
    'America/Los_Angeles': [34.05, -118.24], 'America/Phoenix': [33.45, -112.07], 'America/Denver': [39.74, -104.99],
    'America/Chicago': [41.88, -87.63], 'America/New_York': [40.71, -74.0], 'America/Anchorage': [61.22, -149.9],
    'Pacific/Honolulu': [21.31, -157.86], 'America/Detroit': [42.33, -83.05], 'America/Boise': [43.62, -116.2],
  };
  const hit = map[tz] || (tz.startsWith('America/') ? [39.8, -98.6] : [39.8, -98.6]);
  return { lat: hit[0], lon: hit[1], label: tz.replace(/_/g, ' ').split('/').pop(), how: 'tz' };
}

export function precise() {
  return new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('unsupported'));
    navigator.geolocation.getCurrentPosition(
      p => { const v = { lat: p.coords.latitude, lon: p.coords.longitude, label: 'Your location', how: 'gps' }; store.set('jl:geo', v); res(v); },
      rej, { timeout: 10000, maximumAge: 6e5 });
  });
}

export const prefs = {
  get: (k, d) => { try { const v = localStorage.getItem('jl:pref:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('jl:pref:' + k, JSON.stringify(v)); } catch {} },
};
