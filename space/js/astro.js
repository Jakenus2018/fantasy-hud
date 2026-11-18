// Sun and moon positions (after Vladimir Agafonkin's SunCalc, BSD-2).
const rad = Math.PI / 180, dayMs = 864e5, J1970 = 2440588, J2000 = 2451545, e = rad * 23.4397;
const toDays = d => d.valueOf() / dayMs - 0.5 + J1970 - J2000;
const ra = (l, b) => Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
const dec = (l, b) => Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
const azm = (H, phi, d) => Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(d) * Math.cos(phi));
const alt = (H, phi, d) => Math.asin(Math.sin(phi) * Math.sin(d) + Math.cos(phi) * Math.cos(d) * Math.cos(H));
const sidereal = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;
function sunCoords(d) {
  const M = rad * (357.5291 + 0.98560028 * d);
  const L = M + rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + rad * 102.9372 + Math.PI;
  return { dec: dec(L, 0), ra: ra(L, 0) };
}
function moonCoords(d) {
  const L = rad * (218.316 + 13.176396 * d), M = rad * (134.963 + 13.064993 * d), F = rad * (93.272 + 13.22935 * d);
  const l = L + rad * 6.289 * Math.sin(M), b = rad * 5.128 * Math.sin(F);
  return { ra: ra(l, b), dec: dec(l, b), dist: 385001 - 20905 * Math.cos(M) };
}

// Altitude and compass azimuth (0 = north, clockwise), both in degrees.
export function sunPosition(date, lat, lon) {
  const lw = rad * -lon, phi = rad * lat, d = toDays(date), c = sunCoords(d), H = sidereal(d, lw) - c.ra;
  return { alt: alt(H, phi, c.dec) / rad, az: (azm(H, phi, c.dec) / rad + 180) % 360 };
}

export function moonPhase(date) {
  const d = toDays(date), s = sunCoords(d), m = moonCoords(d), sd = 149598000;
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sd * Math.sin(phi), m.dist - sd * Math.cos(phi));
  const angle = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
  const phase = 0.5 + 0.5 * inc * (angle < 0 ? -1 : 1) / Math.PI;
  const names = ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'];
  return { fraction: (1 + Math.cos(inc)) / 2, phase, name: names[Math.round(phase * 8) % 8] };
}

// Find the sun's next crossing of `target` degrees after `from` (coarse scan + bisection).
export function nextSunCrossing(from, lat, lon, target = -0.833, rising = true, hours = 30) {
  let t0 = from.valueOf(), a0 = sunPosition(new Date(t0), lat, lon).alt - target;
  for (let i = 1; i <= hours * 6; i++) {
    const t1 = from.valueOf() + i * 6e5, a1 = sunPosition(new Date(t1), lat, lon).alt - target;
    if ((rising && a0 < 0 && a1 >= 0) || (!rising && a0 > 0 && a1 <= 0)) {
      let lo = t0, hi = t1;
      for (let k = 0; k < 18; k++) {
        const mid = (lo + hi) / 2, am = sunPosition(new Date(mid), lat, lon).alt - target;
        if ((am < 0) === rising) lo = mid; else hi = mid;
      }
      return new Date((lo + hi) / 2);
    }
    t0 = t1; a0 = a1;
  }
  return null;
}

// "Jellyfish" potential: a launch between roughly civil and nautical twilight
// lights the high-altitude plume against a dark sky.
export function twilightOutlook(sunAlt) {
  if (sunAlt > 0) return { level: 'Daylight', score: 0 };
  if (sunAlt > -5) return { level: 'Good', score: 2 };
  if (sunAlt > -14) return { level: 'Excellent', score: 3 };
  if (sunAlt > -19) return { level: 'Possible', score: 1 };
  return { level: 'Night', score: 0 };
}
