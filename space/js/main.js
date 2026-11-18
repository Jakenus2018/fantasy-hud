import { LaunchScene, Turntable } from './scene.js';
import * as D from './data.js';
import { SITES, LANDING_ZONES, kmBetween, enuKm } from './sites.js';
import { buildTrajectory, azimuthFor } from './flight.js';
import { vehicleKind, profileFor } from './rocket.js';
import { sunPosition, moonPhase, twilightOutlook, nextSunCrossing } from './astro.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const p2 = n => String(Math.floor(n)).padStart(2, '0');
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

const S = {
  sites: SITES.map(s => ({ ...s, launches: [] })),
  launches: [], site: null, launch: null, user: null,
  units: D.prefs.get('units', 'imp'), style: D.prefs.get('style', 'sat'), sound: false,
  wx: null, iss: null, flying: false, source: '',
};

// ---------- units ----------
const U = {
  imp: () => S.units === 'imp',
  temp: c => (c == null ? '—' : U.imp() ? `${Math.round(c * 9 / 5 + 32)}°` : `${Math.round(c)}°`),
  tempU: () => (U.imp() ? 'F' : 'C'),
  speed: k => (k == null ? '—' : U.imp() ? Math.round(k * .621371) : Math.round(k)),
  speedU: () => (U.imp() ? 'mph' : 'km/h'),
  dist: km => (km == null ? '—' : U.imp() ? Math.round(km * .621371).toLocaleString() : Math.round(km).toLocaleString()),
  distU: () => (U.imp() ? 'mi' : 'km'),
  vis: m => (m == null ? '—' : U.imp() ? (m / 1609.34).toFixed(m > 16000 ? 0 : 1) : (m / 1000).toFixed(m > 10000 ? 0 : 1)),
  alt: km => (U.imp() ? (km * .621371) : km),
  press: h => (h == null ? '—' : U.imp() ? (h * .02953).toFixed(2) : Math.round(h)),
  pressU: () => (U.imp() ? 'inHg' : 'hPa'),
};
const compass = d => (d == null ? '' : ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(d / 22.5) % 16]);
const WMO = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Showers', 81: 'Showers', 82: 'Violent showers', 85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, hail' };

const tzOf = () => S.launch?.location.tz || S.site?.tz || 'UTC';
const fmtTime = (ts, tz, opts = {}) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz, timeZoneName: 'short', ...opts }).format(ts);
const fmtDate = (ts, tz, opts = {}) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: tz, ...opts }).format(ts);
const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const coarse = L => /day|week|month|quarter|half|year|^m$|^q|^y|^hy|^d$|^w$/i.test(L?.precision || '');
function dur(ms) {
  const s = Math.abs(ms) / 1000, d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${Math.floor(s % 60)}s`;
}
function isoDur(s) {
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(s || '');
  if (!m) return '—';
  const [, d, h, mi] = m.map(x => +x || 0);
  return d ? `${d}d ${h}h` : `${h}h ${mi}m`;
}

// ---------- scene ----------
let scene;
try {
scene = new LaunchScene($('#stage'), {
  telemetry: onTelemetry, event: onEvent, finished: onFinished, inset: onInset, shot: () => {},
  sideTrajectory: tr => buildTrajectory('f9', { azimuth: tr.azimuth, recovery: 'rtls', lz: lzFor(S.launch, tr.azimuth, 'rtls') }),
});
} catch (e) {
  $('#ldStatus').textContent = 'This experience needs WebGL — try a current desktop or mobile browser';
  throw e;
}
let turntable = null;
try { turntable = new Turntable($('#turntable')); } catch { $('#turntable').hidden = true; }
scene.setStyle(S.style === 'mono');

// ---------- loader ----------
const loader = {
  set(p, msg) {
    const v = Math.round(clamp(p, 0, 1) * 100);
    $('#ldPct').textContent = p2(Math.min(v, 99)).padStart(2, '0');
    $('#ldBar').style.width = v + '%';
    if (msg) $('#ldStatus').textContent = msg;
  },
  done() { $('#ldPct').textContent = '100'; $('#ldBar').style.width = '100%'; setTimeout(() => { $('#loader').classList.add('gone'); document.body.classList.add('ready'); }, 350); },
};

function toast(msg, ms = 3600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), ms);
}

// ---------- data → sites ----------
function assignLaunches(list) {
  for (const s of S.sites) s.launches = [];
  for (const L of list) {
    const lat = L.location.lat ?? L.pad.lat, lon = L.location.lon ?? L.pad.lon;
    let site = S.sites.find(s => s.ll2.includes(L.location.id))
      || S.sites.find(s => s.match && s.match.test(L.location.name))
      || S.sites.find(s => kmBetween(s.lat, s.lon, L.pad.lat, L.pad.lon) < 25);
    if (!site) {
      const parts = L.location.name.split(',').map(x => x.trim());
      site = { key: 'loc' + (L.location.id ?? S.sites.length), ll2: [L.location.id], name: parts[0] || 'Launch site', short: (parts[0] || '').split(' ')[0].toUpperCase(), region: parts[1] || '', lat, lon, tz: L.location.tz || 'UTC', launches: [] };
      S.sites.push(site);
    }
    if (L.location.tz) site.tz = L.location.tz;
    site.launches.push(L);
  }
  for (const s of S.sites) s.launches.sort((a, b) => a.net - b.net);
}
const isDone = L => /success|failure|partial/i.test(L.status.name) || /success|fail/i.test(L.status.abbrev);
const nextOf = site => site.launches.find(L => !isDone(L) && L.net > Date.now() - 20 * 6e4) || site.launches.find(L => !isDone(L)) || site.launches[0] || null;

function nearestSite() {
  const u = S.user; if (!u) return S.sites[0];
  const ranked = S.sites.map(s => ({ s, d: kmBetween(u.lat, u.lon, s.lat, s.lon) })).sort((a, b) => a.d - b.d);
  return (ranked.find(r => r.s.launches.length) || ranked[0]).s;
}

// ---------- trajectory ----------
function lzFor(L, az, recovery) {
  const code = L?.booster?.landing?.loc;
  let ll = code && LANDING_ZONES[code];
  if (!ll && recovery === 'rtls') {
    const k = S.site?.key;
    ll = k === 'vandenberg' ? LANDING_ZONES['LZ-4'] : k === 'ksc' ? LANDING_ZONES['LZ-39A'] : k === 'ccsfs' ? LANDING_ZONES['LZ-40'] : null;
  }
  if (!ll || !L) return null;
  const { e, n } = enuKm(L.pad.lat, L.pad.lon, ll[0], ll[1]);
  const a = az * Math.PI / 180;
  return { along: e * Math.sin(a) + n * Math.cos(a), cross: e * Math.cos(a) - n * Math.sin(a) };
}
function trajectoryFor(L) {
  const kind = vehicleKind(L), prof = profileFor(kind);
  const mis = `${L.mission} ${L.name}`.toLowerCase();
  let recovery = null;
  const land = L.booster?.landing;
  if (land) {
    const t = `${land.type} ${land.typeName} ${land.desc}`.toLowerCase();
    if (land.attempt === false || /expend/.test(t)) recovery = 'expend';
    else if (/asds|drone|ship|barge/.test(t)) recovery = 'asds';
    else if (/rtls|landing zone|return to launch/.test(t)) recovery = 'rtls';
    else if (/catch|tower|chopstick/.test(t)) recovery = 'catch';
    else if (/ocean|splash/.test(t)) recovery = 'expend';
  }
  if (!recovery) {
    if (kind === 'falcon9') recovery = /transporter|bandwagon|nrol|sda|tranche/.test(mis) && S.site?.key === 'vandenberg' ? 'rtls' : 'asds';
    else if (kind === 'starship') recovery = 'catch';
    else if (kind === 'newshepard') recovery = 'vertical';
    else if (kind === 'newglenn') recovery = 'asds';
    else if (kind === 'falconheavy') recovery = 'expend';
  }
  const azimuth = azimuthFor({ lat: L.pad.lat, siteKey: S.site?.key, orbit: L.orbit, missionName: mis });
  return buildTrajectory(prof, { azimuth, recovery, lz: lzFor(L, azimuth, recovery) });
}

// ---------- site / launch selection ----------
const curtain = {
  on(title, eyebrow = 'Repositioning') { $('#curTitle').textContent = title; $('#curEyebrow').textContent = eyebrow; $('#curBar').style.width = '0'; $('#curtain').classList.add('on'); return new Promise(r => setTimeout(r, 650)); },
  set(p) { $('#curBar').style.width = Math.round(p * 100) + '%'; },
  off() { $('#curtain').classList.remove('on'); },
};

let centerKey = '';
async function selectSite(site, { launch = null, first = false } = {}) {
  closeOverlays();
  if (S.flying) endSim(true);
  S.site = site;
  const L = launch || nextOf(site);
  S.launch = L;
  history.replaceState(null, '', '#' + site.key);
  const lat = L?.pad.lat ?? site.lat, lon = L?.pad.lon ?? site.lon;
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (key !== centerKey) {
    if (!first) await curtain.on(site.name, site.region ? `${site.region} · ${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}` : 'Repositioning');
    if (first) loader.set(.25, 'Acquiring satellite imagery');
    const ok = await scene.loadSite(lat, lon, p => (first ? loader.set(.25 + p * .7, p < .3 ? 'Sampling terrain' : 'Acquiring satellite imagery') : curtain.set(p)));
    if (!ok) return;
    centerKey = key;
    if (!scene.imageryOK) toast('Satellite imagery unavailable — showing topographic view');
  }
  scene.setTime(new Date());
  showLaunch(L, { fly: !first });
  if (first) { loader.done(); scene.intro(); } else curtain.off();
  refreshWeather();
}

function showLaunch(L, { fly = true } = {}) {
  S.launch = L;
  if (L) {
    const kind = vehicleKind(L);
    scene.setVehicle(kind, L);
    turntable?.set(kind, L);
    $('#turntable').hidden = false;
    if (fly) scene.idleView();
    if (!L.detailed) D.launchDetail(L.id).then(full => {
      if (S.launch?.id !== L.id) return;
      Object.assign(L, full);
      if (!S.flying) { scene.setVehicle(kind, L); turntable?.set(kind, L); if (fly) scene.idleView(true); }
      renderPanel();
    }).catch(() => {});
  } else {
    scene.setVehicle('falcon9', { rocket: '' });
    scene.vehicle.root.visible = false;
    $('#turntable').hidden = true;
    if (fly) scene.idleView();
  }
  renderHero(); renderPanel(); renderUpcoming();
  maybeLive();
}

async function feature(L) {
  const site = S.sites.find(s => s.launches.includes(L)) || S.site;
  if (site !== S.site || kmBetween(L.pad.lat, L.pad.lon, scene.center.lat, scene.center.lon) > .3) return selectSite(site, { launch: L });
  closeOverlays();
  if (S.flying) endSim(true);
  showLaunch(L);
  refreshWeather();
}

// ---------- hero ----------
function renderHero() {
  const L = S.launch, s = S.site;
  $('#hEyebrow').textContent = L ? `Next launch · ${s.name}` : s.name;
  $('#hPad').textContent = L ? L.pad.name : s.region;
  const title = L ? L.mission : 'No launches scheduled';
  const h1 = $('#hTitle');
  h1.innerHTML = `<span class="ln"><span>${esc(title)}</span></span>`;
  h1.querySelector('.ln > span').animate([{ transform: 'translateY(105%)' }, { transform: 'none' }], { duration: 1100, easing: 'cubic-bezier(.16,1,.3,1)' });
  $('#hSub').innerHTML = L ? `<b>${esc(L.rocketFull || L.rocket)}</b> &nbsp;—&nbsp; ${esc(L.provider)}` : `${esc(s.region)} · check back soon`;
  $('#simBtn').disabled = !L;
  const w = $('#watchBtn');
  if (L?.video) { w.href = L.video; w.hidden = false; } else w.hidden = true;
  $('#upBtn').textContent = `All upcoming (${s.launches.length})`;
  renderChips(); buildCount();
}
function renderChips() {
  const L = S.launch; if (!L) { $('#chips').innerHTML = ''; return; }
  const st = L.status.abbrev, cls = /go|success/i.test(st) ? 'go' : /hold|fail/i.test(st) ? 'bad' : /flight/i.test(st) ? 'live' : 'warn';
  const chips = [`<span class="chip ${cls}" title="${esc(L.status.desc)}"><i></i>${esc(L.status.name || st)}</span>`];
  if (L.probability != null) chips.push(`<span class="chip ${L.probability >= 70 ? 'go' : L.probability >= 40 ? 'warn' : 'bad'}"><i></i>${L.probability}% weather go</span>`);
  if (L.orbit) chips.push(`<span class="chip">${esc(L.orbit)}</span>`);
  if (L.booster?.landing?.loc) chips.push(`<span class="chip">Landing · ${esc(L.booster.landing.loc)}</span>`);
  if (L.webcastLive) chips.push('<span class="chip live"><i></i>Webcast live</span>');
  $('#chips').innerHTML = chips.join('');
}

let countMode = '';
function buildCount() {
  const L = S.launch, c = $('#count');
  countMode = !L ? 'none' : coarse(L) ? 'coarse' : 'live';
  c.classList.toggle('soft', countMode === 'coarse');
  if (countMode === 'none') { c.innerHTML = '<div class="unit"><div class="v" style="font-size:24px;letter-spacing:.2em;width:auto">AWAITING MANIFEST</div></div>'; return; }
  const u = (k, l) => `<div class="unit"><div class="v" data-k="${k}"></div><div class="l">${l}</div></div>`;
  c.innerHTML = `<div class="tm" id="tm">T-</div>${u('d', 'Days')}<span class="colon">:</span>${u('h', 'Hours')}<span class="colon">:</span>${u('m', 'Min')}<span class="colon">:</span>${u('s', 'Sec')}`;
  tickCount();
}
const setDigits = (node, str) => {
  if (node.dataset.v === str) return;
  node.dataset.v = str;
  node.innerHTML = [...str].map(ch => `<span>${ch}</span>`).join('');
};
function tickCount() {
  const L = S.launch; if (!L || countMode === 'none') return;
  const diff = L.net - Date.now(), a = Math.abs(diff) / 1000;
  const tm = $('#tm'); if (!tm) return;
  tm.textContent = countMode === 'coarse' ? 'NET' : diff >= 0 ? 'T-' : 'T+';
  const d = Math.floor(a / 86400), h = Math.floor(a % 86400 / 3600), m = Math.floor(a % 3600 / 60), s = Math.floor(a % 60);
  const set = (k, v) => { const n = $(`#count [data-k="${k}"]`); if (n) setDigits(n, v); };
  if (countMode === 'coarse') {
    const dt = new Date(L.net);
    set('d', p2(d)); set('h', p2(h)); set('m', '--'); set('s', '--');
    $('#count .unit:nth-of-type(1) .l').textContent = 'Days ~';
    tm.title = `No earlier than ${fmtDate(dt, tzOf(), { year: 'numeric' })}`;
  } else { set('d', p2(d)); set('h', p2(h)); set('m', p2(m)); set('s', p2(s)); }
}

// ---------- panel ----------
const stat = (label, val, unit = '', note = '', cls = '') => `<div class="stat ${cls}"><span class="label">${label}</span><div class="val">${val}${unit ? `<small>${unit}</small>` : ''}</div>${note ? `<div class="note">${note}</div>` : ''}</div>`;
const row = (k, v) => `<div class="row"><span>${k}</span><span>${v}</span></div>`;

function renderPanel() {
  renderMission(); renderVehicle(); renderWeather(); renderSky(); renderLive();
  $('#srcNote').textContent = S.source === 'mirror' ? 'Launch Library rate limit reached — showing the development mirror, which can lag the live feed.' : S.source === 'stale' ? 'Showing cached launch data — the live feed is unreachable.' : '';
}
function renderMission() {
  const L = S.launch;
  if (!L) { $('#mDesc').textContent = `No launches are currently scheduled from ${S.site.name}. Pick another site from Locations.`; $('#mRows').innerHTML = ''; $('#mOrbit').textContent = ''; return; }
  $('#mOrbit').textContent = L.orbitName || L.orbit || '';
  $('#mDesc').textContent = L.missionDesc || 'Mission details have not been published yet.';
  const tz = tzOf(), net = new Date(L.net);
  const win = L.windowStart && L.windowEnd ? (L.windowEnd - L.windowStart < 6e4 ? 'Instantaneous' : `${fmtTime(L.windowStart, tz, { timeZoneName: undefined })} – ${fmtTime(L.windowEnd, tz)} · ${dur(L.windowEnd - L.windowStart)}`) : '—';
  $('#mRows').innerHTML = [
    row('Provider', esc(L.provider)),
    row('NET · pad', coarse(L) ? fmtDate(net, tz, { year: 'numeric' }) : `${fmtDate(net, tz, { weekday: 'short' })} · ${fmtTime(net, tz)}`),
    userTz !== tz && !coarse(L) ? row('NET · you', `${fmtDate(net, userTz)} · ${fmtTime(net, userTz)}`) : '',
    row('Window', win),
    row('Pad', esc(L.pad.name)),
    L.missionType ? row('Type', esc(L.missionType)) : '',
    L.status.desc ? row('Status', esc(L.status.desc)) : '',
    L.holdReason ? row('Hold', esc(L.holdReason)) : '',
  ].join('');
}
function renderVehicle() {
  const L = S.launch;
  if (!L) { $('#vName').textContent = ''; $('#vStats').innerHTML = ''; $('#vRows').innerHTML = ''; return; }
  const c = L.config;
  $('#vName').textContent = L.rocket;
  const len = c.length, dia = c.diameter;
  const ft = m => (U.imp() ? Math.round(m * 3.28084) : Math.round(m * 10) / 10);
  const lu = U.imp() ? 'ft' : 'm';
  const rate = c.launches ? Math.round(100 * (c.successes || 0) / c.launches) : null;
  $('#vStats').innerHTML = [
    stat('Height', len ? ft(len) : '—', len ? lu : ''),
    stat('Diameter', dia ? ft(dia) : '—', dia ? lu : ''),
    stat('Liftoff mass', c.mass ? Math.round(c.mass).toLocaleString() : '—', c.mass ? 't' : ''),
    stat('To LEO', c.leo ? (c.leo / 1000).toFixed(1) : '—', c.leo ? 't' : ''),
    stat('Flights', c.launches ?? '—', '', rate != null ? `${rate}% success` : ''),
    stat('Streak', c.streak ?? '—', '', c.landings ? `${c.landings.toLocaleString()} landings` : ''),
  ].join('');
  const b = L.booster;
  $('#vRows').innerHTML = [
    L.rocketFull ? row('Configuration', esc(L.rocketFull)) : '',
    b?.serial ? row('Booster', `${esc(b.serial)}${b.flightNo ? ` · flight ${b.flightNo}` : ''}`) : '',
    b?.landing ? row('Recovery', b.landing.attempt === false ? 'Expended' : esc([b.landing.locName || b.landing.loc, b.landing.typeName].filter(Boolean).join(' · '))) : '',
    L.spacecraft ? row('Spacecraft', esc(L.spacecraft)) : '',
    !L.detailed ? row('Details', '<span style="color:var(--ink-3)">Loading…</span>') : '',
  ].join('');
}

async function refreshWeather() {
  const L = S.launch, lat = L?.pad.lat ?? S.site.lat, lon = L?.pad.lon ?? S.site.lon;
  try {
    S.wx = await D.weather(lat, lon);
    const c = S.wx.current;
    scene.setWind(c.wind_speed_10m, c.wind_direction_10m);
  } catch { S.wx = null; }
  renderWeather(); renderSky();
}
function renderWeather() {
  const wx = S.wx, L = S.launch;
  if (!wx) { $('#wNow').innerHTML = '<div class="stat wide"><div class="note">Weather unavailable right now.</div></div>'; $('#wChecks').innerHTML = ''; return; }
  const c = wx.current;
  $('#wWhen').textContent = WMO[c.weather_code] || 'Now';
  $('#wNow').innerHTML = [
    stat('Temp', U.temp(c.temperature_2m), U.tempU(), `Feels ${U.temp(c.apparent_temperature)}`),
    stat('Wind', U.speed(c.wind_speed_10m), U.speedU(), `from ${compass(c.wind_direction_10m)}`),
    stat('Gusts', U.speed(c.wind_gusts_10m), U.speedU()),
    stat('Clouds', c.cloud_cover ?? '—', '%'),
    stat('Visibility', U.vis(c.visibility), U.imp() ? 'mi' : 'km'),
    stat('Humidity', c.relative_humidity_2m ?? '—', '%', `Dew ${U.temp(c.dew_point_2m)}`),
    stat('Pressure', U.press(c.pressure_msl), U.pressU()),
    stat('Rain', c.precipitation ?? 0, 'mm'),
    stat('Local', fmtTime(Date.now(), tzOf(), { timeZoneName: undefined }), '', S.site.short),
  ].join('');
  // T-0 forecast checks
  const fc = L ? D.forecastAt(wx, L.net) : null;
  const src = fc || {
    wind_gusts_10m: c.wind_gusts_10m, wind_speed_250hPa: wx.hourly?.wind_speed_250hPa?.[0], precipitation_probability: wx.hourly?.precipitation_probability?.[0],
    cape: wx.hourly?.cape?.[0], cloud_cover_low: wx.hourly?.cloud_cover_low?.[0], visibility: c.visibility, weather_code: c.weather_code,
  };
  $('#wFcLabel').textContent = fc ? `Launch weather at T-0 · ${fmtDate(L.net, tzOf())}` : L && L.net - Date.now() > 15 * 864e5 ? 'Launch weather · current (T-0 beyond forecast range)' : 'Launch weather · current';
  const chk = (ok, warn, label, val) => `<div class="check ${ok ? '' : warn ? 'warn' : 'bad'}"><i></i><span>${label}</span><em>${val}</em></div>`;
  const g = src.wind_gusts_10m, up = src.wind_speed_250hPa, pp = src.precipitation_probability, cape = src.cape, low = src.cloud_cover_low, vis = src.visibility, code = src.weather_code;
  const kt = k => (k == null ? '—' : `${Math.round(k / 1.852)} kt`);
  $('#wChecks').innerHTML = [
    chk(g == null || g < 46, g < 56, 'Ground winds', kt(g)),
    chk(up == null || up < 160, up < 220, 'Upper-level winds · 250 hPa', kt(up)),
    chk(pp == null || pp < 25, pp < 55, 'Precipitation chance', pp == null ? '—' : `${pp}%`),
    chk((cape == null || cape < 500) && !(code >= 95), cape < 1500 && !(code >= 95), 'Lightning potential (CAPE)', cape == null ? '—' : `${Math.round(cape)} J/kg`),
    chk(low == null || low < 60, low < 90, 'Low cloud cover', low == null ? '—' : `${low}%`),
    chk(vis == null || vis > 8000, vis > 3000, 'Visibility', vis == null ? '—' : `${U.vis(vis)} ${U.imp() ? 'mi' : 'km'}`),
  ].join('');
  $('#wFine').textContent = `Estimate from the Open-Meteo model, scored against common launch-commit thresholds — not an official forecast.${L?.probability != null ? ` Official outlook: ${L.probability}% probability of acceptable weather.` : ''}${L?.weatherConcerns ? ` Concerns: ${L.weatherConcerns}.` : ''}`;
}
function renderSky() {
  const L = S.launch, lat = L?.pad.lat ?? S.site.lat, lon = L?.pad.lon ?? S.site.lon, tz = tzOf();
  const now = new Date(), sun = sunPosition(now, lat, lon), moon = moonPhase(now);
  const rise = nextSunCrossing(now, lat, lon, -.833, true), set = nextSunCrossing(now, lat, lon, -.833, false);
  const items = [
    stat('Sun now', `${sun.alt.toFixed(1)}°`, '', sun.alt > 0 ? `Daylight · az ${Math.round(sun.az)}°` : sun.alt > -6 ? 'Civil twilight' : sun.alt > -12 ? 'Nautical twilight' : 'Night'),
    stat('Moon', `${Math.round(moon.fraction * 100)}`, '%', moon.name),
    stat('Sunrise', rise ? fmtTime(rise, tz, { timeZoneName: undefined }) : '—', '', 'next'),
    stat('Sunset', set ? fmtTime(set, tz, { timeZoneName: undefined }) : '—', '', 'next'),
  ];
  if (L && !coarse(L)) {
    const s0 = sunPosition(new Date(L.net), lat, lon), tw = twilightOutlook(s0.alt);
    items.push(stat('Sun at T-0', `${s0.alt.toFixed(1)}°`, '', s0.alt > 0 ? 'Daylight launch' : 'Launch in darkness'));
    items.push(stat('Twilight plume', tw.level, '', tw.score >= 2 ? 'Sunlit exhaust over a dark sky — look up' : tw.score === 1 ? 'Faint glow possible' : 'Unlikely'));
  }
  if (S.user) {
    const d = kmBetween(S.user.lat, S.user.lon, lat, lon);
    const tw = L && !coarse(L) ? twilightOutlook(sunPosition(new Date(L.net), lat, lon).alt).score : 0;
    const vis = d < 80 ? 'Visible — head outside' : d < 400 ? 'Likely visible on the horizon' : d < 1100 && tw >= 2 ? 'Twilight plume may be visible' : 'Too far to see';
    items.push(stat('From you', U.dist(d), U.distU(), vis, 'wide'));
  }
  $('#sky').innerHTML = items.join('');
  $('#skyWhen').textContent = fmtTime(now, tz);
}
function renderLive() {
  const L = S.launch, i = S.iss, lat = L?.pad.lat ?? S.site.lat, lon = L?.pad.lon ?? S.site.lon;
  const items = [];
  if (i) {
    items.push(stat('ISS speed', U.speed(i.velocity).toLocaleString(), U.speedU(), `${Math.abs(i.latitude).toFixed(1)}°${i.latitude >= 0 ? 'N' : 'S'} ${Math.abs(i.longitude).toFixed(1)}°${i.longitude >= 0 ? 'E' : 'W'}`));
    items.push(stat('ISS altitude', U.dist(i.altitude), U.distU(), i.visibility === 'daylight' ? 'In sunlight' : 'In Earth’s shadow'));
    items.push(stat('ISS range', U.dist(kmBetween(lat, lon, i.latitude, i.longitude)), U.distU(), `from ${S.site.short}`, 'wide'));
  } else items.push(stat('ISS', '—', '', 'Acquiring…', 'wide'));
  $('#live').innerHTML = items.join('');
  const now = Date.now(), soon = S.launches.filter(x => x.net > now && x.net < now + 30 * 864e5).length;
  const c = L?.counts || {};
  $('#liveRows').innerHTML = [
    row('Upcoming here', `${S.site.launches.length}`),
    row('US launches · 30 days', `${soon}`),
    c.orbitalYear != null ? row('Orbital attempts this year', `${c.orbitalYear}${c.orbital != null ? ` · #${c.orbital.toLocaleString()} all-time` : ''}`) : '',
    c.locationYear != null ? row(`${S.site.short} this year`, `${c.locationYear}`) : '',
    c.agencyYear != null ? row(`${esc(L.providerAbbrev || L.provider)} this year`, `${c.agencyYear}`) : '',
    L?.padTurnaround ? row('Pad turnaround', isoDur(L.padTurnaround)) : '',
    L?.pad.launches != null ? row('Pad launches', `${L.pad.launches.toLocaleString()}`) : '',
  ].join('');
}

// ---------- overlays ----------
function openOverlay(id) {
  closeOverlays();
  if (id === 'locations') renderSites();
  if (id === 'upcoming') renderUpcoming();
  $('#' + id).classList.add('open');
  $$(`.navbtn[data-open="${id}"]`).forEach(b => b.setAttribute('aria-pressed', 'true'));
  $('#' + id).querySelector('.close')?.focus({ preventScroll: true });
}
function closeOverlays() {
  $$('.overlay.open').forEach(o => o.classList.remove('open'));
  $$('.navbtn[data-open]').forEach(b => b.setAttribute('aria-pressed', 'false'));
}
const tileUrl = (lat, lon, z = 13) => {
  const n = 2 ** z, r = lat * Math.PI / 180;
  const x = Math.floor((lon + 180) / 360 * n), y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
};
function renderSites() {
  const u = S.user;
  const list = S.sites.map(s => ({ s, d: u ? kmBetween(u.lat, u.lon, s.lat, s.lon) : null })).sort((a, b) => (a.d ?? 0) - (b.d ?? 0));
  const near = nearestSite();
  $('#locSub').textContent = u ? `Sorted by distance from ${u.label || 'you'}` : 'US launch sites';
  $('#siteList').innerHTML = list.map(({ s, d }, i) => {
    const n = nextOf(s);
    return `<button class="site ${s === S.site ? 'cur' : ''}" data-site="${esc(s.key)}">
      <span class="ix">${p2(i + 1)}</span>
      <span class="nm">${esc(s.name)}${s === near ? '<span class="near">Nearest</span>' : ''}<small>${esc(s.region)}${d != null ? ` · ${U.dist(d)} ${U.distU()} away` : ''}</small></span>
      <span class="meta"><b>${s.launches.length}</b>${s.launches.length === 1 ? 'launch' : 'launches'} scheduled</span>
      <span class="meta">${n ? `<b>${esc(n.mission)}</b>${esc(n.rocket)} · <span class="mono" data-cd="${n.net}"></span>` : '<b>—</b>Nothing on the manifest'}</span>
      <img class="thumb" alt="" loading="lazy" crossorigin="anonymous" src="${tileUrl(s.lat, s.lon)}">
    </button>`;
  }).join('');
  tickLists();
}
let upScope = 'site';
function renderUpcoming() {
  const list = upScope === 'site' ? S.site?.launches || [] : S.launches;
  $('#upTitle').textContent = upScope === 'site' ? `${S.site?.name || ''}` : 'All US launches';
  $('#upSub').innerHTML = `<span class="seg" style="display:inline-flex"><button data-scope="site" aria-pressed="${upScope === 'site'}">This site</button><button data-scope="all" aria-pressed="${upScope === 'all'}">All US</button></span>`;
  $('#upList').innerHTML = list.length ? list.map(L => {
    const tz = L.location.tz || S.site.tz, cs = /go|success/i.test(L.status.abbrev) ? 'go' : /hold/i.test(L.status.abbrev) ? 'bad' : 'warn';
    return `<button class="item ${L === S.launch ? 'cur' : ''}" data-launch="${esc(L.id)}">
      <span class="date">${coarse(L) ? new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: tz }).format(L.net) : fmtDate(L.net, tz)}<small>${coarse(L) ? 'NET · TBD' : fmtTime(L.net, tz)}</small></span>
      <span class="mis">${esc(L.mission)}<small>${esc(L.rocket)} · ${esc(L.provider)}</small></span>
      <span class="meta">${esc(L.pad.name)}${upScope === 'all' ? `<br><span style="color:var(--ink-3)">${esc(L.location.name)}</span>` : ''}</span>
      <span class="chip ${cs}"><i></i>${esc(L.status.abbrev)}</span>
      <span class="cd" data-cd="${L.net}"></span>
    </button>`;
  }).join('') : '<div class="empty">No launches on the manifest for this site.</div>';
  tickLists();
}
function tickLists() {
  const now = Date.now();
  $$('[data-cd]').forEach(n => {
    const t = +n.dataset.cd, d = t - now;
    n.textContent = d > 0 ? `T-${Math.floor(d / 864e5) ? Math.floor(d / 864e5) + 'd ' : ''}${p2(d % 864e5 / 36e5)}:${p2(d % 36e5 / 6e4)}:${p2(d % 6e4 / 1e3)}` : 'Launched';
  });
}
function renderTicker() {
  const items = S.launches.filter(L => L.net > Date.now() - 36e5).slice(0, 14);
  const html = items.map(L => `<button data-launch="${esc(L.id)}"><b data-cd="${L.net}"></b>${esc(L.rocket)} · ${esc(L.mission)} · ${esc((L.location.name || '').split(',')[0])}</button>`).join('');
  $('#marq').innerHTML = html + html;
}

// ---------- simulation ----------
let simTr = null;
const gauge = id => {
  const host = $(id), R = 52, C = 2 * Math.PI * R, A = C * .75;
  host.innerHTML = `<svg viewBox="0 0 118 118"><circle cx="59" cy="59" r="${R}" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="2" stroke-dasharray="${A} ${C}"/><circle class="arcV" cx="59" cy="59" r="${R}" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="0 ${C}"/><circle cx="59" cy="59" r="${R - 7}" fill="none" stroke="rgba(255,255,255,.1)" stroke-width="1.2" stroke-dasharray="${A * (R - 7) / R} ${C}"/><circle class="arcH" cx="59" cy="59" r="${R - 7}" fill="none" stroke="rgba(255,255,255,.6)" stroke-width="1.2" stroke-dasharray="0 ${C}"/></svg>
    <div class="gv"><small>Speed</small><b class="gvs">0</b><small class="gvsu">${U.speedU()}</small><b class="gva" style="font-size:15px;margin-top:6px">0</b><small>Alt ${U.distU()}</small></div>`;
  return {
    set(v, h) {
      const kmh = v * 3.6, sp = U.imp() ? kmh * .621371 : kmh;
      host.querySelector('.arcV').setAttribute('stroke-dasharray', `${A * clamp(kmh / 30000, 0, 1)} ${C}`);
      host.querySelector('.arcH').setAttribute('stroke-dasharray', `${A * (R - 7) / R * clamp(h / 220, 0, 1)} ${C}`);
      host.querySelector('.gvs').textContent = Math.round(sp).toLocaleString();
      host.querySelector('.gva').textContent = U.alt(h).toFixed(h < 10 ? 2 : 1);
    },
  };
};
let G1, G2;
function startSim({ live = false } = {}) {
  const L = S.launch; if (!L) return;
  closeOverlays();
  simTr = trajectoryFor(L);
  const elapsed = (Date.now() - L.net) / 1000;
  if (!live) scene.setTime(new Date(L.net));
  scene.setCamMode('auto'); segPress('#camSeg', 'auto'); segPress('#warpSeg', 'auto');
  scene.startFlight(simTr, { startT: live ? clamp(elapsed, -12, simTr.end) : -12, warp: live ? 1 : 'auto' });
  if (live) segPress('#warpSeg', '1');
  S.flying = true;
  document.body.classList.add('flying');
  $('#hud').classList.add('on'); $('#teleCard').hidden = false; $('#panelScroll').scrollTo({ top: 0, behavior: 'smooth' });
  $('#endcard').classList.remove('on');
  $('#mname').textContent = `${L.rocket} · ${L.mission}${live ? ' · live model' : ''}`;
  G1 = gauge('#g1'); G2 = gauge('#g2');
  // timeline
  const tl = $('#timeline'), span = simTr.end + 12;
  tl.querySelectorAll('.ev').forEach(n => n.remove());
  const lastAt = [-1, -1];
  simTr.events.forEach(([t, label], i) => {
    const x = (t + 12) / span, row = i % 2;
    const d = document.createElement('div'); d.className = 'ev' + (row ? ' alt' : ''); d.style.left = `${x * 100}%`;
    d.dataset.label = label;
    if (x - lastAt[row] > .11) { d.innerHTML = `<span>${label}</span>`; lastAt[row] = x; }
    d.title = label; tl.appendChild(d);
  });
  audio.start();
}
function endSim(silent) {
  if (!S.flying) return;
  S.flying = false;
  scene.endFlight(!!silent);
  scene.setTime(new Date());
  document.body.classList.remove('flying');
  $('#hud').classList.remove('on'); $('#teleCard').hidden = true; $('#inset').classList.remove('on'); $('#endcard').classList.remove('on');
  audio.stop();
}
const phaseName = (t, tr) => {
  if (t < -3) return 'Terminal count'; if (t < 0) return 'Engine ignition'; if (t < 10) return 'Liftoff';
  const ev = tr.events.filter(([et]) => et <= t).pop();
  return ev ? `${ev[1]}` : 'Ascent';
};
function onTelemetry(d) {
  const tr = simTr; if (!tr) return;
  const sign = d.t < 0 ? '-' : '+', a = Math.abs(d.t);
  $('#mclock').textContent = `T${sign}${p2(a / 3600)}:${p2(a % 3600 / 60)}:${p2(a % 60)}`;
  G1?.set(d.s1.v, d.s1.h); G2?.set(d.s2.v, d.s2.h);
  $('#tprog').style.width = `${clamp((d.t + 12) / (tr.end + 12), 0, 1) * 100}%`;
  const sp = v => (U.imp() ? v * 3.6 * .621371 : v * 3.6);
  $('#tele').innerHTML = [
    stat(d.sep ? 'Stage 2 speed' : 'Speed', `<span class="big">${Math.round(sp(d.s2.v)).toLocaleString()}</span>`, U.speedU()),
    stat('Altitude', `<span class="big">${U.alt(d.s2.h).toFixed(1)}</span>`, U.distU()),
    stat('Downrange', U.dist(d.s2.along), U.distU()),
    stat('Acceleration', d.accel.toFixed(2), 'g'),
    stat('Mach', d.s2.h < 60 ? d.mach.toFixed(2) : '—'),
    stat('Dyn. pressure', d.q.toFixed(1), 'kPa'),
    d.sep && d.recovery !== 'expend' ? stat('Booster', `${Math.round(sp(d.s1.v)).toLocaleString()}`, U.speedU(), d.s1.landed ? 'Landed' : `${U.alt(d.s1.h).toFixed(1)} ${U.distU()} up`) : stat('Stage', d.sep ? '2' : '1', '', d.sep ? 'Upper stage' : 'First stage'),
    stat('Time warp', `${d.warp.toFixed(d.warp % 1 ? 1 : 0)}×`, '', scene.camMode),
  ].join('');
  $('#tPhase').textContent = phaseName(d.t, tr);
  audio.set(d);
}
function onEvent(label) {
  $$('#timeline .ev').forEach(n => { if (n.dataset.label === label) n.classList.add('done'); });
  const f = $('#flashText'); f.textContent = label; f.classList.remove('show'); void f.offsetWidth; f.classList.add('show');
}
function onFinished() {
  const tr = simTr;
  $('#endTitle').textContent = tr.profile.vertical ? 'Touchdown' : 'Orbit achieved';
  $('#endSub').textContent = `${S.launch?.rocket || ''} · ${S.launch?.mission || ''} · modelled flight complete`;
  $('#endcard').classList.add('on');
}
function onInset(name) {
  const el = $('#inset');
  el.classList.toggle('on', !!name);
  $('#insetLabel').textContent = name === 'landing' ? (simTr?.recovery === 'asds' ? 'Drone ship cam' : simTr?.recovery === 'catch' ? 'Tower cam' : 'Landing zone cam') : 'Booster cam';
  updateInsetRect();
}
function updateInsetRect() {
  const r = $('#inset').getBoundingClientRect();
  scene.insetRect = { x: Math.round(r.left + 1), y: Math.round(r.top + 1), w: Math.round(r.width - 2), h: Math.round(r.height - 2) };
}
addEventListener('resize', updateInsetRect);

// procedural engine roar
const audio = {
  ctx: null, gain: null,
  init() {
    if (this.ctx) return;
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    const len = ctx.sampleRate * 3, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; last = (last + .02 * w) / 1.02; d[i] = last * 3.5; }
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const lp = this.lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 220;
    const crackle = ctx.createBufferSource(); const cb = ctx.createBuffer(1, len, ctx.sampleRate), cd = cb.getChannelData(0);
    for (let i = 0; i < len; i++) cd[i] = (Math.random() < .002 ? (Math.random() * 2 - 1) : 0) + (Math.random() * 2 - 1) * .04;
    crackle.buffer = cb; crackle.loop = true;
    const hp = ctx.createBiquadFilter(); hp.type = 'bandpass'; hp.frequency.value = 900; hp.Q.value = .6;
    this.cg = ctx.createGain(); this.cg.gain.value = 0;
    this.gain = ctx.createGain(); this.gain.gain.value = 0;
    src.connect(lp).connect(this.gain).connect(ctx.destination);
    crackle.connect(hp).connect(this.cg).connect(ctx.destination);
    src.start(); crackle.start();
  },
  start() { if (S.sound) { this.init(); this.ctx.resume(); } },
  stop() { if (this.gain) { this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, .4); this.cg.gain.setTargetAtTime(0, this.ctx.currentTime, .4); } },
  set(d) {
    if (!S.sound || !this.gain) return;
    const near = d.t < 0 ? clamp((d.t + 3.5) / 3.5, 0, 1) : Math.exp(-d.s2.h / 6) * (simTr.stackBurning(Math.max(0, d.t)) ? 1 : .1);
    const t = this.ctx.currentTime;
    this.gain.gain.setTargetAtTime(.9 * near, t, .15);
    this.cg.gain.setTargetAtTime(1.4 * near, t, .15);
    this.lp.frequency.setTargetAtTime(140 + 260 * near, t, .2);
  },
};

// live / in-progress launches play the model in real time
let liveArmed = true;
function maybeLive() {
  const L = S.launch; if (!L || S.flying || coarse(L)) return;
  const el = (Date.now() - L.net) / 1000;
  if (el > -1 && el < 480 && /go|flight|success/i.test(L.status.abbrev + L.status.name) && liveArmed) {
    liveArmed = false;
    startSim({ live: true });
    toast(el < 2 ? 'Liftoff — following the modelled trajectory in real time' : 'Launch in progress — following the modelled trajectory');
  }
}

// ---------- chrome ----------
function segPress(sel, val) { $$(`${sel} button[data-cam],${sel} button[data-warp]`).forEach(b => b.setAttribute('aria-pressed', String((b.dataset.cam || b.dataset.warp) === val))); }
function clock() {
  const now = new Date();
  const utc = now.toISOString().slice(11, 19);
  const tz = tzOf();
  $('#clock').innerHTML = `<b>${utc}</b> UTC<br>${fmtTime(now, tz, { second: '2-digit' })} ${esc(S.site?.short || '')}`;
  $('#ldClock').textContent = `${utc} UTC`;
}
function tick() {
  clock(); tickCount(); tickLists();
  if (S.launch && !S.flying) {
    const d = S.launch.net - Date.now();
    if (d < 0 && d > -1500) liveArmed = true;
    maybeLive();
  }
}
setInterval(tick, 250);

document.addEventListener('click', e => {
  const t = e.target.closest('button,a'); if (!t) return;
  if (t.dataset.open) return openOverlay(t.dataset.open);
  if (t.hasAttribute('data-close')) return closeOverlays();
  if (t.dataset.site) { const s = S.sites.find(x => x.key === t.dataset.site); if (s) selectSite(s); return; }
  if (t.dataset.launch) { const L = S.launches.find(x => String(x.id) === t.dataset.launch); if (L) feature(L); return; }
  if (t.dataset.scope) { upScope = t.dataset.scope; renderUpcoming(); return; }
  if (t.dataset.units) { S.units = t.dataset.units; D.prefs.set('units', S.units); $$('[data-units]').forEach(b => b.setAttribute('aria-pressed', String(b === t))); renderPanel(); if (S.flying) { G1 = gauge('#g1'); G2 = gauge('#g2'); } return; }
  if (t.dataset.style) { S.style = t.dataset.style; D.prefs.set('style', S.style); $$('[data-style]').forEach(b => b.setAttribute('aria-pressed', String(b === t))); scene.setStyle(S.style === 'mono'); return; }
  if (t.dataset.cam) { scene.setCamMode(t.dataset.cam); segPress('#camSeg', t.dataset.cam); return; }
  if (t.dataset.warp) { if (scene.flight) scene.flight.warp = t.dataset.warp === 'auto' ? 'auto' : +t.dataset.warp; segPress('#warpSeg', t.dataset.warp); return; }
});
$('#simBtn').onclick = () => startSim();
$('#navSim').onclick = () => (S.flying ? endSim() : startSim());
$('#exitSim').onclick = () => endSim();
$('#replayBtn').onclick = () => { endSim(true); startSim(); };
$('#backBtn').onclick = () => endSim();
$('#soundBtn').onclick = e => {
  S.sound = !S.sound; e.currentTarget.setAttribute('aria-pressed', String(S.sound));
  e.currentTarget.querySelector('.x').style.display = S.sound ? 'none' : '';
  e.currentTarget.querySelector('.w').style.opacity = S.sound ? 1 : .35;
  if (S.sound && S.flying) audio.start(); if (!S.sound) audio.stop();
};
addEventListener('keydown', e => {
  if (e.target.closest('input,textarea')) return;
  if (e.key === 'Escape') { if ($('.overlay.open')) closeOverlays(); else if (S.flying) endSim(); }
  if (e.key === 'l' || e.key === 'L') openOverlay('locations');
  if (e.key === 'u' || e.key === 'U') openOverlay('upcoming');
  if (e.key === 'Enter' && !S.flying && !$('.overlay.open') && document.activeElement === document.body) startSim();
});
$$('[data-units]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.units === S.units)));
$$('[data-style]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.style === S.style)));

// ISS + weather refresh
async function pollISS() {
  try { S.iss = await D.iss(); if (!S.flying || Math.random() < .3) renderLive(); } catch {}
}
setInterval(pollISS, 5000);
setInterval(() => { if (S.site) refreshWeather(); }, 10 * 6e4);
setInterval(async () => { // manifest refresh (cached; costs at most ~5 calls/hour)
  try { const r = await D.upcomingLaunches(); mergeManifest(r); } catch {}
}, 12 * 6e4);
function mergeManifest(r) {
  const curId = S.launch?.id;
  const prev = new Map(S.launches.map(L => [L.id, L]));
  S.launches = r.launches.map(L => (prev.get(L.id)?.detailed ? Object.assign(prev.get(L.id), { ...L, ...pickDetail(prev.get(L.id)) }) : L));
  S.launches.sort((a, b) => a.net - b.net);
  S.source = r.source;
  assignLaunches(S.launches);
  const L = S.launches.find(x => x.id === curId);
  if (L) S.launch = L;
  renderTicker(); if (!S.flying) { renderHero(); renderPanel(); }
}
const pickDetail = L => ({ booster: L.booster, config: L.config, video: L.video, spacecraft: L.spacecraft, detailed: true, counts: L.counts, padTurnaround: L.padTurnaround });


// ---------- boot ----------
(async function boot() {
  loader.set(.04, 'Locating you');
  const hashKey = location.hash.slice(1);
  const [man, me] = await Promise.allSettled([D.upcomingLaunches(), D.whereAmI()]);
  S.user = me.status === 'fulfilled' ? me.value : D.byTimeZone();
  loader.set(.18, 'Reading the launch manifest');
  if (man.status === 'fulfilled') { S.launches = man.value.launches.sort((a, b) => a.net - b.net); S.source = man.value.source; }
  else { S.launches = []; toast('Launch manifest unavailable — showing launch sites only', 6000); }
  assignLaunches(S.launches);
  renderTicker();
  const site = S.sites.find(s => s.key === hashKey) || nearestSite();
  pollISS();
  await selectSite(site, { first: true });
  if (S.user?.how !== 'gps' && !hashKey) setTimeout(() => toast(`Nearest active site to ${S.user.label || 'you'} · ${site.name}`), 2600);
})().catch(err => {
  console.error(err);
  $('#ldStatus').textContent = 'Something went wrong — ' + (err.message || err);
});
