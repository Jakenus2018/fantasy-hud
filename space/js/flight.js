// Flight model: per-vehicle ascent profiles built from typical webcast telemetry,
// integrated into a downrange / altitude trajectory, plus booster recovery paths.
// Pure math — no three.js — so it can be checked in Node.

const G = 9.80665;

// Fritsch–Carlson monotone cubic interpolation. Non-monotone data is fine:
// extrema land on knots, so curves never overshoot (no booster below ground).
export function monotone(xs, ys) {
  const n = xs.length;
  const dx = [], m = [], t = new Array(n);
  for (let i = 0; i < n - 1; i++) { dx[i] = xs[i + 1] - xs[i]; m[i] = (ys[i + 1] - ys[i]) / dx[i]; }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) t[i] = 0;
    else {
      const w1 = 2 * dx[i] + dx[i - 1], w2 = dx[i] + 2 * dx[i - 1];
      t[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i]);
    }
  }
  return x => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const h = dx[i], s = (x - xs[i]) / h, s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * ys[i] + (s3 - 2 * s2 + s) * h * t[i] + (-2 * s3 + 3 * s2) * ys[i + 1] + (s3 - s2) * h * t[i + 1];
  };
}

const smooth = (a, b, x) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };

/* ---------- Profiles ----------
   path:   [t s, altitude km, speed m/s] for the stack, continuing as the upper stage after staging.
   events: timeline markers shown on the HUD.
   burns:  intervals the upper stack's engines are lit (plume on).
   recovery: default booster fate when Launch Library has no landing data. */
export const PROFILES = {
  f9: {
    label: 'Kerolox medium-lift',
    path: [[0,0,0],[10,.25,30],[30,2.6,160],[60,9.5,380],[72,12.5,450],[100,24,900],[130,44,1600],[148,65,2300],[151,67,2290],[158,72,2280],[200,105,2700],[260,140,3500],[330,172,4600],[420,195,6100],[515,205,7600],[545,206,7610]],
    meco: 148, sep: 151, ses: 158, seco: 515, fairing: 195, maxq: 72,
    burns: [[0,148],[158,515]],
    recovery: 'asds', end: 560,
  },
  heavy: { // Falcon Heavy: side boosters peel off, centre core flies on
    label: 'Triple-core heavy-lift',
    path: [[0,0,0],[10,.22,26],[30,2.4,150],[60,9,360],[78,13.5,470],[100,22,780],[150,52,1800],[184,72,2600],[188,75,2590],[196,80,2580],[260,125,3400],[340,165,4600],[440,190,6200],[560,200,7900],[590,201,7910]],
    meco: 184, sep: 188, ses: 196, seco: 560, fairing: 230, maxq: 78,
    strapons: { t: 150, mode: 'rtls' },
    burns: [[0,184],[196,560]],
    recovery: 'expend', end: 600,
  },
  starship: {
    label: 'Methalox super heavy-lift',
    path: [[0,0,0],[10,.15,22],[30,1.8,130],[62,11,420],[90,23,700],[120,40,1050],[150,60,1450],[160,66,1580],[164,68,1585],[220,108,2300],[300,142,3600],[400,163,5400],[520,170,7350],[545,170,7360]],
    meco: 160, sep: 162, ses: 162, seco: 520, maxq: 62,
    burns: [[0,160],[161,520]],
    recovery: 'catch', land: 415, end: 560,
  },
  centaur: { // Vulcan / Atlas V: solids, long first stage, hydrolox upper
    label: 'Hydrolox upper, solid-assisted',
    path: [[0,0,0],[10,.2,25],[30,2,150],[60,8,380],[90,16,620],[120,30,950],[180,62,1800],[240,95,3200],[255,102,3500],[262,106,3490],[271,110,3480],[350,150,4300],[450,175,5500],[560,185,6700],[700,190,7900],[730,190,7905]],
    meco: 255, sep: 262, ses: 271, seco: 700, fairing: 225, maxq: 66,
    strapons: { t: 95, mode: 'fall' },
    burns: [[0,255],[271,700]],
    recovery: 'expend', end: 740,
  },
  newglenn: {
    label: 'Methalox heavy-lift',
    path: [[0,0,0],[12,.2,25],[35,2.6,140],[70,11,420],[100,22,750],[140,42,1300],[180,72,2050],[186,76,2240],[192,80,2235],[198,84,2230],[260,125,3000],[350,170,4300],[470,195,6000],[620,200,7700],[650,200,7705]],
    meco: 186, sep: 192, ses: 198, seco: 620, fairing: 240, maxq: 70,
    burns: [[0,186],[198,620]],
    recovery: 'asds', end: 660,
  },
  small: { // Electron, Alpha, Minotaur…
    label: 'Small-lift',
    path: [[0,0,0],[10,.2,25],[30,2.2,140],[60,9,380],[90,20,720],[120,38,1150],[150,62,1950],[158,70,2150],[162,73,2145],[165,75,2140],[240,120,3000],[320,160,4300],[400,185,5700],[520,200,7600],[545,200,7605]],
    meco: 158, sep: 162, ses: 165, seco: 520, fairing: 185, maxq: 60,
    burns: [[0,158],[165,520]],
    recovery: 'expend', end: 560,
  },
  suborbital: { // New Shepard: straight up, booster lands, capsule under parachutes
    label: 'Suborbital',
    vertical: true,
    path: [[0,0],[10,.15],[40,3],[80,15],[120,38],[141,57],[162,74],[200,96],[243,107.5],[290,96],[330,77],[370,50],[410,25],[450,9],[490,2.4],[560,.9],[612,0]],
    meco: 141, sep: 162, maxq: 58, seco: 141,
    burns: [[0,141]],
    recovery: 'vertical', land: 440, end: 620,
    chutes: 490,
  },
};

// Webcast-style event labels for a profile + recovery mode.
export function eventsFor(p, recovery, sepT, landT) {
  const ev = [[0, 'Liftoff'], [p.maxq, 'Max-Q']];
  if (p.strapons) ev.push([p.strapons.t, p.strapons.mode === 'rtls' ? 'Booster sep' : 'SRB sep']);
  if (p.vertical) {
    ev.push([p.meco, 'MECO'], [sepT, 'Capsule sep'], [243, 'Apogee'], [landT - 25, 'Landing burn'], [landT, 'Booster landing'], [p.chutes, 'Parachutes'], [612, 'Touchdown']);
    return ev.sort((a, b) => a[0] - b[0]);
  }
  ev.push([p.meco, 'MECO'], [p.sep, 'Stage sep']);
  if (p.ses > p.sep) ev.push([p.ses, 'SES-1']);
  if (p.fairing) ev.push([p.fairing, 'Fairing sep']);
  if (recovery === 'rtls' || recovery === 'catch') ev.push([sepT + 12, 'Boostback'], [landT - 85, 'Entry burn'], [landT, recovery === 'catch' ? 'Tower catch' : 'Landing']);
  if (recovery === 'asds') ev.push([landT - 117, 'Entry burn'], [landT, 'Landing']);
  ev.push([p.seco, 'SECO']);
  return ev.sort((a, b) => a[0] - b[0]);
}

// Atmosphere helpers for Mach and dynamic pressure.
export const density = hKm => 1.225 * Math.exp(-hKm * 1000 / 8500);
export function soundSpeed(hKm) {
  if (hKm < 11) return 340.3 - 4.0 * hKm;
  if (hKm < 20) return 295.1;
  if (hKm < 47) return 295.1 + (hKm - 20) * 1.2;
  return 328;
}

// Builds the trajectory for one launch.
//   profileId, azimuth (deg from north), recovery mode, lz {along, cross} km relative to pad
export function buildTrajectory(profileId, { azimuth = 90, recovery, lz } = {}) {
  const p = PROFILES[profileId] || PROFILES.f9;
  recovery = recovery || p.recovery;
  const ts = p.path.map(k => k[0]);
  const hf = monotone(ts, p.path.map(k => k[1]));
  const vKeys = p.path[0].length > 2 ? monotone(ts, p.path.map(k => k[2])) : null;
  const end = p.end;

  // Integrate downrange from speed and climb rate.
  const dt = 0.2, N = Math.ceil(end / dt) + 1;
  const T = new Float32Array(N), H = new Float32Array(N), D = new Float32Array(N), V = new Float32Array(N);
  let d = 0;
  for (let i = 0; i < N; i++) {
    const t = i * dt, h = hf(t);
    const hd = (hf(t + 0.1) - hf(t - 0.1)) / 0.2 * 1000; // m/s
    let v = vKeys ? vKeys(t) : Math.abs(hd);
    if (t < 0.01) v = 0;
    const vh = p.vertical ? 0 : Math.sqrt(Math.max(0, v * v - hd * hd));
    if (i > 0) d += vh * dt / 1000;
    T[i] = t; H[i] = h; D[i] = d; V[i] = v;
  }
  const sample = (arr, t) => {
    const x = Math.min(N - 1.001, Math.max(0, t / dt)), i = Math.floor(x), f = x - i;
    return arr[i] * (1 - f) + arr[i + 1] * f;
  };

  const sepT = p.sep, dSep = sample(D, sepT), hSep = sample(H, sepT);
  const vzSep = (sample(H, sepT + .5) - sample(H, sepT - .5)) * 1000;
  const vhSep = (sample(D, sepT + .5) - sample(D, sepT - .5)) * 1000;

  // ---- Booster path in (along km, alt km, crossBlend 0..1) keyed by time
  let bKeys, burnsB = [], landT = null, lzAlong = 0, lzCross = 0;
  const apex = Math.max(hSep + 42, hSep + (vzSep * vzSep) / (2 * G) / 1000);

  if (recovery === 'rtls' || recovery === 'catch') {
    landT = p.land || (sepT + 300);
    const L = landT - sepT;
    lzAlong = lz ? lz.along : (recovery === 'catch' ? 0 : -0.4);
    lzCross = lz ? lz.cross : (recovery === 'catch' ? 0.03 : 0);
    const peak = dSep + vhSep / 1000 * 25;
    const back = f => lzAlong + (peak - lzAlong) * f;
    const hEnd = recovery === 'catch' ? 0.02 : 0;
    bKeys = [
      [0, dSep, hSep], [.05, dSep + vhSep / 1000 * 13, hSep + (apex - hSep) * .3], [.167, peak, hSep + (apex - hSep) * .72],
      [.367, back(.72), apex], [.583, back(.42), hSep + (apex - hSep) * .66], [.717, back(.22), Math.min(62, apex * .55)],
      [.783, back(.13), Math.min(38, apex * .33)], [.9, back(.035), 12], [.96, lzAlong + .25 * Math.sign(peak - lzAlong), 2.2], [1, lzAlong, hEnd],
    ].map(([f, a, h]) => [sepT + f * L, a, h]);
    burnsB = [[sepT + .04 * L, sepT + .173 * L], [sepT + .717 * L, sepT + .783 * L], [sepT + .96 * L - 4, landT]];
  } else if (recovery === 'asds') {
    landT = sepT + 352;
    lzAlong = lz && lz.along > 50 ? lz.along : dSep + 520;
    lzCross = lz && lz.along > 50 ? lz.cross : 0;
    const span = lzAlong - dSep;
    bKeys = [
      [0, 0, hSep], [60, .21, hSep + (apex - hSep) * .72], [120, .41, apex], [180, .615, hSep + (apex - hSep) * .66],
      [235, .79, 62], [255, .846, 40], [300, .96, 12], [340, .9994, 2], [352, 1, 0],
    ].map(([dtk, f, h]) => [sepT + dtk, dSep + span * f, h]);
    burnsB = [[sepT + 235, sepT + 255], [sepT + 338, landT]];
  } else if (recovery === 'vertical') {
    landT = p.land;
    lzAlong = lz ? lz.along : 0; lzCross = lz ? lz.cross : 2.6;
    bKeys = [[sepT, 0, hSep], [200, 0, 95], [240, 0, 105], [290, 0, 92], [340, 0, 62], [380, 0, 33], [410, 0, 12], [428, 0, 3], [landT, 0, 0]];
    burnsB = [[landT - 25, landT]];
  } else { // expended: ballistic fall, drawn until it leaves the scene
    bKeys = [];
    for (let k = 0; k <= 12; k++) {
      const tau = k * 25;
      bKeys.push([sepT + tau, dSep + vhSep / 1000 * tau * (1 - tau / 900), Math.max(0, hSep + vzSep / 1000 * tau - G / 2000 * tau * tau)]);
    }
  }
  const bt = bKeys.map(k => k[0]);
  const bA = monotone(bt, bKeys.map(k => k[1]));
  const bH = monotone(bt, bKeys.map(k => k[2]));
  const bEnd = bt[bt.length - 1];

  const az = azimuth * Math.PI / 180;
  const dir = [Math.sin(az), 0, -Math.cos(az)];       // three.js: +x east, -z north
  const cross = [Math.cos(az), 0, Math.sin(az)];       // right of track
  const toWorld = (along, h, c) => [dir[0] * along * 1000 + cross[0] * c * 1000, h * 1000, dir[2] * along * 1000 + cross[2] * c * 1000];

  const crossNow = t => (landT ? lzCross * smooth(sepT + (landT - sepT) * .35, landT - 2, t) : 0);

  const stack = t => {
    const h = sample(H, t), a = sample(D, t), v = sample(V, t);
    const crossC = p.vertical ? 0 : 0;
    return { t, h, along: a, v, pos: toWorld(a, h, crossC) };
  };
  const booster = t => {
    const tt = Math.min(t, bEnd);
    const a = bA(tt), h = bH(tt), c = crossNow(tt);
    const pos = toWorld(a, h, c);
    const e = 0.25, a2 = bA(Math.min(tt + e, bEnd)), h2 = bH(Math.min(tt + e, bEnd)), c2 = crossNow(Math.min(tt + e, bEnd));
    const p2 = toWorld(a2, h2, c2);
    const vel = [(p2[0] - pos[0]) / e, (p2[1] - pos[1]) / e, (p2[2] - pos[2]) / e];
    const v = tt >= bEnd ? 0 : Math.hypot(...vel);
    return { t, h, along: a, v, pos, vel, landed: !!landT && t >= landT, done: t >= bEnd };
  };
  const burning = (list, t) => list.some(([a, b]) => t >= a && t <= b);

  return {
    profile: p, profileId, recovery, azimuth, dir, cross, sepT, landT, lzAlong, lzCross, end: Math.max(end, (landT || 0) + 20),
    events: eventsFor(p, recovery, sepT, landT || 0),
    stack, booster,
    stackBurning: t => burning(p.burns, t),
    boosterBurning: t => t < sepT ? burning([[0, p.meco]], t) : burning(burnsB, t),
    accel(t) {
      const v1 = sample(V, t - .5), v2 = sample(V, t + .5);
      const h1 = sample(H, t - .5), h2 = sample(H, t + .5);
      const v = Math.max(1, sample(V, t)), sinG = Math.min(1, ((h2 - h1) * 1000) / v);
      const burn = burning(p.burns, t);
      return burn ? Math.max(0, (v2 - v1) / G + sinG) : 0;
    },
  };
}

// Launch azimuth from site latitude and target inclination, constrained to
// the range-safety corridor of each coast.
export function azimuthFor({ lat, siteKey, orbit = '', missionName = '', inclination }) {
  const o = (orbit || '').toUpperCase(), m = (missionName || '').toLowerCase();
  const fromInc = (inc, south) => {
    const r = Math.cos(inc * Math.PI / 180) / Math.cos(lat * Math.PI / 180);
    if (Math.abs(r) > 1) return null;
    const a = Math.asin(r) * 180 / Math.PI;
    return south ? 180 - a : a;
  };
  if (siteKey === 'vandenberg') {
    if (/starlink/.test(m)) return 165;
    return 196; // polar / SSO, south over the Pacific
  }
  if (siteKey === 'kodiak') return 180;
  if (siteKey === 'wallops') return /iss|cygnus|crs/.test(m) || o === 'ISS' ? 128 : 110;
  if (siteKey === 'starbase') return 97;
  if (siteKey === 'westtexas' || siteKey === 'spaceportamerica') return 0;
  // Florida
  let inc = inclination;
  if (!inc) {
    if (/crew|dragon|crs|axiom|ax-|cygnus|starliner|iss|dream chaser|ng-\d/.test(m)) inc = 51.6;
    else if (/starlink/.test(m)) inc = 43;
    else if (o === 'SSO' || o === 'PO' || /polar|sun-sync/.test(o)) return 162;
  }
  if (inc) return fromInc(inc, false) ?? 45;
  if (/GTO|GEO|GSO|MEO|HEO|TLI|LO|HCO|SUN/.test(o)) return 92;
  return 88;
}
