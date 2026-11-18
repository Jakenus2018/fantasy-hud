// Procedural launch vehicles, engine plumes and pad structures.
// Every vehicle is built base-up in metres: root origin = bottom of the engine bells.
import * as THREE from 'three';

const mat = (color, roughness = .5, metalness = .05, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra });
export const MATS = () => ({
  white: mat(0xeeeeec, .42, .02),
  offwhite: mat(0xdcdcd6, .5, .02),
  black: mat(0x101113, .55, .1),
  carbon: mat(0x161719, .48, .25),
  steel: mat(0xb9bdc2, .3, .92),
  steelDark: mat(0x6e7277, .38, .85),
  tile: mat(0x0d0d0f, .85, .05),
  tan: mat(0xbf6a28, .75, .02),
  bronze: mat(0x9c5a35, .55, .2),
  engine: mat(0x2b2c30, .32, .85, { side: THREE.DoubleSide }),
  copper: mat(0x6b4630, .4, .7, { side: THREE.DoubleSide }),
  silver: mat(0xc9cbce, .35, .7),
  blue: mat(0x1d3a6b, .5, .1),
  glass: mat(0x0b0e14, .2, .6),
});

// ---------- geometry helpers ----------
const lathe = (pts, m, seg = 48, phiStart = 0, phiLen = Math.PI * 2) => {
  const g = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0001), y)), seg, phiStart, phiLen);
  const mesh = new THREE.Mesh(g, m); mesh.castShadow = mesh.receiveShadow = true; return mesh;
};
const cyl = (r, y0, y1, m, seg = 48, rTop = r) => {
  const g = new THREE.CylinderGeometry(rTop, r, y1 - y0, seg, 1, false);
  const mesh = new THREE.Mesh(g, m); mesh.position.y = (y0 + y1) / 2; mesh.castShadow = mesh.receiveShadow = true; return mesh;
};
const box = (w, h, d, m) => { const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); mesh.castShadow = true; return mesh; };

// Tangent ogive from radius r over length L (base at y0).
function ogive(r, L, y0, n = 20, tip = 0.02) {
  const rho = (r * r + L * L) / (2 * r), pts = [];
  for (let i = 0; i <= n; i++) {
    const y = L * i / n, rr = Math.sqrt(Math.max(0, rho * rho - (y) ** 2)) + r - rho;
    pts.push([Math.max(tip * r, rr), y0 + y]);
  }
  return pts;
}
function bell(r, len) {
  return [[r * .32, 0], [r * .36, -len * .08], [r * .5, -len * .28], [r * .72, -len * .58], [r * .9, -len * .84], [r, -len]];
}
function engines(group, M, layout, y, bellR, bellLen, m = M.engine) {
  for (const [ringR, n, off = 0] of layout) {
    for (let i = 0; i < n; i++) {
      const a = off + i / n * Math.PI * 2;
      const b = lathe(bell(bellR, bellLen), m, 20);
      b.position.set(Math.cos(a) * ringR, y, Math.sin(a) * ringR);
      group.add(b);
    }
  }
}
function fins(group, M, n, y, r, w, h, t = .12, m = M.black, off = Math.PI / 4) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = off + i / n * Math.PI * 2, f = box(w, h, t, m);
    const pivot = new THREE.Group();
    pivot.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    pivot.rotation.y = -a;
    f.position.x = w / 2;
    pivot.add(f); group.add(pivot); out.push(pivot);
  }
  return out;
}
// Fairing: two lathe halves that can separate. Profile is local (base y=0).
function fairing(M, rBase, rF, cylLen, noseLen, m = M.white) {
  const prof = [[rBase, 0], [rF, Math.min(1.2, cylLen * .12)], [rF, cylLen], ...ogive(rF, noseLen, cylLen, 18).slice(1)];
  const fm = m.clone(); fm.side = THREE.DoubleSide;
  const halves = [0, 1].map(i => lathe(prof, fm, 40, i * Math.PI, Math.PI));
  return { halves, height: cylLen + noseLen };
}

// ---------- vehicles ----------
// Returns { root, booster, upper, fairing[], strapons[], gridFins[], legs[], height, radius, sepY, plume:{booster, upper}, exhaust, pad }
export function buildVehicle(kind, info = {}) {
  const M = MATS();
  const root = new THREE.Group(), booster = new THREE.Group(), upper = new THREE.Group();
  root.add(booster, upper);
  const v = { root, booster, upper, fairing: [], strapons: [], gridFins: [], legs: [], M, kind };
  const name = `${info.rocket || ''} ${info.variant || ''}`;
  const mission = (info.mission || '').toLowerCase();
  const capsule = /starliner|cft|boe-/.test(mission) || /starliner/i.test(info.spacecraft || '') ? 'starliner'
    : /dragon|crew-|crs-|axiom|ax-\d|fram|polaris|vast|haven/.test(mission) || /dragon/i.test(info.spacecraft || '') ? 'dragon' : null;

  const addPayload = (y, rBody, rF, cyl, nose, fm) => {
    if (capsule === 'dragon') {
      upper.add(cyl_(1.85, y, y + 2.9, M.white));
      const band = cyl_(1.86, y + .3, y + 2.6, M.black, 48); band.geometry = new THREE.CylinderGeometry(1.86, 1.86, 2.3, 48, 1, true, 0, Math.PI); upper.add(band);
      upper.add(lathe([[1.85, y + 2.9], [1.8, y + 3.3], [1.15, y + 6.4], [.9, y + 6.9], ...ogive(.9, 1.1, y + 6.9, 8).slice(1)], M.white, 40));
      const win = box(.4, .5, .1, M.glass); win.position.set(0, y + 5.2, 1.42); win.rotation.x = -.26; upper.add(win);
      return y + 8.0;
    }
    if (capsule === 'starliner') {
      upper.add(lathe([[rBody, y], [2.35, y + 1.6], [2.35, y + 3.2]], M.white, 40));
      upper.add(cyl_(2.3, y + 3.2, y + 4.6, M.silver));
      upper.add(lathe([[2.3, y + 4.6], [1.05, y + 7.4], [.9, y + 7.6], [.2, y + 7.8]], M.white, 40));
      const band = cyl_(2.04, y + 5.5, y + 5.9, M.blue, 40, 1.86); upper.add(band);
      return y + 7.8;
    }
    const f = fairing(M, rBody, rF, cyl, nose, fm || M.white);
    for (const h of f.halves) { h.position.y = y; upper.add(h); v.fairing.push(h); }
    return y + f.height;
  };
  const cyl_ = (r, y0, y1, m, seg, rTop) => cyl(r, y0, y1, m, seg, rTop);

  const k = kind;
  if (k === 'falcon9' || k === 'falconheavy') {
    const r = 1.83, base = 1.5;
    // Octaweb + Merlins
    engines(booster, M, [[0, 1], [1.22, 8]], base, .46, 1.4);
    booster.add(cyl(r, base, base + .8, M.black));
    booster.add(cyl(r, base + .8, base + 41, M.white));
    booster.add(cyl(r + .005, base + 40.8, base + 47.5, M.black)); // interstage
    // landing legs (folded) + grid fins
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + i * Math.PI / 2, leg = new THREE.Group();
      const l = box(.5, 9.5, .2, M.black); l.position.y = 4.75; leg.add(l);
      leg.position.set(Math.cos(a) * (r + .1), base + .4, Math.sin(a) * (r + .1));
      leg.rotation.y = -a + Math.PI / 2; booster.add(leg); v.legs.push(leg);
    }
    v.gridFins = fins(booster, M, 4, base + 46, r, 1.3, 1.5, .18, M.steelDark);
    v.gridFins.forEach(g => (g.userData.fold = true));
    // Second stage
    engines(upper, M, [[0, 1]], base + 47.5, 1.15, 3.0, M.copper);
    upper.add(cyl(r, base + 47.5, base + 59.4, M.white));
    upper.add(cyl(r + .005, base + 58.6, base + 59.4, M.black));
    v.height = addPayload(base + 59.4, r, 2.6, 7.6, 5.6);
    v.sepY = base + 47.5; v.radius = r; v.exhaust = 'kerolox';
    v.plume = { booster: { y: base - 1.4, r: r * 1.05, count: 1 }, upper: { y: base + 44.5, r: 1.15 } };
    if (k === 'falconheavy') {
      v.radius = r * 3.2;
      for (const s of [-1, 1]) {
        const sb = new THREE.Group();
        engines(sb, M, [[0, 1], [1.22, 8]], base, .46, 1.4);
        sb.add(cyl(r, base, base + 41, M.white));
        sb.add(cyl(r, base + 40.8, base + 45, M.black));
        sb.add(lathe(ogive(r, 6.5, base + 45, 16), M.white));
        const gf = fins(sb, M, 4, base + 43, r, 1.3, 1.5, .18, M.steelDark); gf.forEach(g => (g.scale.x = .15));
        sb.position.x = s * (2 * r + .3);
        booster.add(sb); v.strapons.push(sb);
      }
      v.plume.side = { r: r * 1.05 };
    }
  } else if (k === 'starship') {
    const r = 4.5, base = 1.4;
    engines(booster, M, [[0, 3], [2.1, 10, .3], [3.75, 20]], base, .62, 1.35, M.steelDark);
    booster.add(cyl(r, base, base + 69, M.steel, 64));
    booster.add(cyl(r + .02, base + 2, base + 4, M.steelDark, 64));
    v.gridFins = fins(booster, M, 4, base + 64.5, r, 2.6, 3.2, .4, M.steelDark, 0);
    booster.add(cyl(r, base + 69, base + 72.5, M.steelDark, 64)); // hot-staging ring
    for (let i = 0; i < 24; i++) { const s = box(.5, 2.5, .25, M.black); const a = i / 24 * Math.PI * 2; s.position.set(Math.cos(a) * (r + .02), base + 70.7, Math.sin(a) * (r + .02)); s.rotation.y = -a; booster.add(s); }
    // Ship
    const y0 = base + 72.5;
    engines(upper, M, [[2.5, 3, .5]], y0 + .2, 1.15, 2.3, M.steelDark);
    engines(upper, M, [[.95, 3]], y0 + .2, .6, 1.3, M.steelDark);
    upper.add(cyl(r, y0, y0 + 32, M.steel, 64));
    const tiles = new THREE.Mesh(new THREE.CylinderGeometry(r + .04, r + .04, 32, 64, 1, true, Math.PI / 2, Math.PI), M.tile);
    tiles.position.y = y0 + 16; upper.add(tiles);
    const nose = lathe(ogive(r, 18, y0 + 32, 22), M.steel, 64); upper.add(nose);
    const noseT = lathe(ogive(r + .04, 17.6, y0 + 32, 22), M.tile, 64, Math.PI / 2, Math.PI); upper.add(noseT);
    for (const s of [-1, 1]) {
      const af = box(5.2, 9, .35, M.tile); af.position.set(0, y0 + 5.5, s * (r + 2.4)); af.rotation.y = Math.PI / 2; af.position.x = 0; af.rotation.set(0, 0, 0); af.scale.set(1, 1, 1);
      af.geometry = new THREE.BoxGeometry(.35, 9, 4.6); af.position.set(-1.2, y0 + 5.5, s * (r + 2.1)); upper.add(af);
      const ff = new THREE.Mesh(new THREE.BoxGeometry(.3, 5.5, 2.6), M.tile); ff.position.set(-1.6, y0 + 39.5, s * (r - .3)); ff.rotation.x = s * .25; upper.add(ff);
    }
    v.height = y0 + 50; v.sepY = y0; v.radius = r; v.exhaust = 'methalox';
    v.plume = { booster: { y: base - 1.35, r: r * 1.1 }, upper: { y: y0 - 2.1, r: 3.2 } };
  } else if (k === 'newglenn') {
    const r = 3.5, base = 1.7;
    engines(booster, M, [[0, 1], [2.25, 6]], base, .8, 1.7, M.steelDark);
    booster.add(cyl(r, base, base + 3.5, M.black, 56));
    booster.add(cyl(r, base + 3.5, base + 57.5, M.offwhite, 56));
    booster.add(cyl(r + .01, base + 50, base + 57.5, M.black, 56));
    for (let i = 0; i < 2; i++) { const s = box(.25, 9, 1.4, M.black); s.position.set((i ? 1 : -1) * (r + .7), base + 7, 0); booster.add(s); }
    v.gridFins = fins(booster, M, 4, base + 55, r, 1.8, 2.2, .2, M.steelDark);
    v.gridFins.forEach(g => (g.userData.fold = true));
    engines(upper, M, [[1.3, 2]], base + 57.5, .9, 2.2, M.steelDark);
    upper.add(cyl(r, base + 57.5, base + 76.5, M.offwhite, 56));
    v.height = addPayload(base + 76.5, r, 3.5, 13.5, 8.4, M.offwhite);
    v.sepY = base + 57.5; v.radius = r; v.exhaust = 'methalox';
    v.plume = { booster: { y: base - 1.7, r: r * 1.05 }, upper: { y: base + 55.3, r: 1.6 } };
  } else if (k === 'vulcan' || k === 'atlas') {
    const vulcan = k === 'vulcan';
    const r = vulcan ? 2.7 : 1.905, base = 1.6;
    const s1 = vulcan ? 33.3 : 32.5;
    if (vulcan) engines(booster, M, [[1.15, 2]], base, .75, 1.6, M.steelDark);
    else engines(booster, M, [[.5, 2]], base, .55, 1.6, M.steelDark);
    booster.add(cyl(r, base, base + s1, vulcan ? M.tan : M.bronze, 56));
    booster.add(cyl(r + .01, base, base + 1.4, M.black, 56));
    // Solids
    const m = /\b(VC|N)?(\d)(\d)(\d)?/i.exec(info.variant || info.rocketFull || name);
    let srb = 0;
    if (vulcan) srb = +((/VC(\d)/i.exec(info.variant || info.rocketFull || name) || [])[1] || 4);
    else if (m) srb = +(m[3] || 0);
    if (/N22/i.test(info.rocketFull || name)) srb = 2;
    const srbR = vulcan ? .81 : .8, srbL = vulcan ? 21.9 : 20;
    for (let i = 0; i < srb; i++) {
      const g = new THREE.Group(), a = (i / srb) * Math.PI * 2 + Math.PI / 2 + (srb % 2 ? 0 : Math.PI / srb);
      g.add(lathe(bell(.55, 1.2), M.engine, 16).translateY(base + 1.2));
      g.add(cyl(srbR, base + 1.2, base + srbL, M.white, 24));
      g.add(lathe(ogive(srbR, 2.8, base + srbL, 10), M.white, 24));
      g.add(cyl(srbR + .01, base + 1.2, base + 2.2, M.black, 24));
      g.position.set(Math.cos(a) * (r + srbR + .05), 0, Math.sin(a) * (r + srbR + .05));
      g.userData.dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      booster.add(g); v.strapons.push(g);
    }
    const iy = base + s1;
    booster.add(cyl(r, iy, iy + (vulcan ? 3 : 3.2), M.white, 56, vulcan ? r : 1.53));
    const cr = vulcan ? 2.7 : 1.53, cy = iy + (vulcan ? 3 : 3.2);
    engines(upper, M, [[cr * .45, 2]], cy, .55, 1.8, M.copper);
    const crew = capsule === 'starliner';
    const big = vulcan || /5\d\d/.test(info.variant || info.rocketFull || '');
    if (big && !crew) {
      // 5 m class fairing encloses Centaur
      v.height = addPayload(cy, r, vulcan ? 2.7 : 2.72, vulcan ? 21 : 18.5, vulcan ? 7.5 : 7);
      upper.add(cyl(cr - .05, cy, cy + 12, M.silver, 40));
    } else {
      upper.add(cyl(cr, cy, cy + 12.7, M.silver, 40));
      v.height = addPayload(cy + 12.7, cr, crew ? 2.3 : 2.1, 7.5, 4.6);
    }
    v.sepY = iy + (vulcan ? 3 : 3.2) - 0.01; v.radius = r + (srb ? srbR * 2 : 0); v.exhaust = vulcan ? 'methalox' : 'kerolox';
    v.plume = { booster: { y: base - 1.6, r: r }, upper: { y: cy - 1.8, r: .9 }, srb: { y: base, r: srbR }, upperType: 'hydrolox' };
  } else if (k === 'electron' || k === 'small') {
    const elec = k === 'electron';
    const r = elec ? .6 : (info.config?.diameter ? info.config.diameter / 2 : .9), base = .5;
    const L = elec ? 18 : (info.config?.length || 26);
    const s1 = L * .66, s2 = L * .16;
    engines(booster, M, [[0, 1], [r * .62, 8]], base, r * .19, .5);
    booster.add(cyl(r, base, base + s1, elec ? M.carbon : M.white, 32));
    booster.add(cyl(r + .005, base + s1 - .5, base + s1, elec ? M.white : M.black, 32));
    engines(upper, M, [[0, 1]], base + s1, r * .45, r * 1.1, M.copper);
    upper.add(cyl(r, base + s1, base + s1 + s2, elec ? M.carbon : M.white, 32));
    v.height = addPayload(base + s1 + s2, r, r * (elec ? 1 : 1.2), L * .1, L * .08, elec ? M.carbon : M.white);
    v.sepY = base + s1; v.radius = r; v.exhaust = 'kerolox';
    v.plume = { booster: { y: base - .5, r: r * 1.1 }, upper: { y: base + s1 - r * 1.1, r: r * .45 } };
  } else if (k === 'neutron') {
    const base = 1.2;
    engines(booster, M, [[0, 1], [2.3, 8]], base, .7, 1.4, M.steelDark);
    booster.add(lathe([[3.5, base], [3.5, base + 6], [2.6, base + 28], [2.5, base + 30]], M.carbon, 56));
    v.gridFins = fins(booster, M, 4, base + 3, 3.5, 1.2, 4, .25, M.carbon);
    engines(upper, M, [[0, 1]], base + 30, .9, 2.2, M.copper);
    upper.add(cyl(2.4, base + 30, base + 36, M.white, 40));
    upper.add(lathe([[2.5, base + 36], ...ogive(2.5, 7, base + 36, 14).slice(1)], M.carbon, 56));
    v.height = base + 43; v.sepY = base + 30; v.radius = 3.5; v.exhaust = 'kerolox';
    v.plume = { booster: { y: base - 1.4, r: 3.2 }, upper: { y: base + 27.8, r: .9 } };
  } else if (k === 'newshepard') {
    const r = 1.85, base = 1.0;
    engines(booster, M, [[0, 1]], base, 1.0, 1.2, M.steelDark);
    booster.add(cyl(r, base, base + 15, M.white, 48));
    booster.add(cyl(r + .01, base, base + 2.2, M.black, 48));
    fins(booster, M, 4, base + 1.4, r, 1.3, 3.2, .22, M.white);
    booster.add(lathe([[r + .02, base + 14.2], [r + .5, base + 14.5], [r + .5, base + 15], [r + .02, base + 15.1]], M.offwhite, 48));
    upper.add(lathe([[r, base + 15.1], [r, base + 15.8], [1.6, base + 17.2], [1.1, base + 18.2], [.3, base + 18.6]], M.white, 48));
    const w = box(.7, .9, .1, M.glass); w.position.set(0, base + 16.6, 1.75); w.rotation.x = -.18; upper.add(w);
    v.height = base + 18.6; v.sepY = base + 15.1; v.radius = r; v.exhaust = 'hydrolox';
    v.plume = { booster: { y: base - 1.2, r: 1.0 }, upper: null };
  } else { // generic, sized from Launch Library config
    const L = info.config?.length || 40, r = (info.config?.diameter || 3) / 2, base = 1;
    const s1 = L * .64, s2 = L * .18;
    engines(booster, M, [[0, 1], [r * .55, 4]], base, r * .26, r * .7);
    booster.add(cyl(r, base, base + s1, M.white, 40));
    booster.add(cyl(r + .005, base + s1 - r * .6, base + s1, M.black, 40));
    engines(upper, M, [[0, 1]], base + s1, r * .4, r * .9, M.copper);
    upper.add(cyl(r, base + s1, base + s1 + s2, M.white, 40));
    v.height = addPayload(base + s1 + s2, r, r * 1.15, L * .1, L * .08);
    v.sepY = base + s1; v.radius = r; v.exhaust = 'kerolox';
    v.plume = { booster: { y: base - r * .7, r: r * 1.05 }, upper: { y: base + s1 - r * .9, r: r * .4 } };
  }
  v.gridFins.forEach(g => { if (g.userData.fold) g.scale.x = .15; });
  v.upperType = v.plume.upperType || v.exhaust;
  return v;
}

export function vehicleKind(launch) {
  const n = `${launch.rocket} ${launch.rocketFull} ${launch.family}`.toLowerCase();
  if (/starship|super heavy/.test(n)) return 'starship';
  if (/falcon heavy/.test(n)) return 'falconheavy';
  if (/falcon 9|falcon9/.test(n)) return 'falcon9';
  if (/new glenn/.test(n)) return 'newglenn';
  if (/new shepard/.test(n)) return 'newshepard';
  if (/vulcan/.test(n)) return 'vulcan';
  if (/atlas/.test(n)) return 'atlas';
  if (/electron|haste/.test(n)) return 'electron';
  if (/neutron/.test(n)) return 'neutron';
  if (/alpha|minotaur|pegasus|antares|eris|terran|rs1|zephyr/.test(n)) return 'small';
  return 'generic';
}
export function profileFor(kind) {
  return { falcon9: 'f9', falconheavy: 'heavy', starship: 'starship', newglenn: 'newglenn', vulcan: 'centaur', atlas: 'centaur', newshepard: 'suborbital', electron: 'small', small: 'small', neutron: 'f9' }[kind] || 'f9';
}

// ---------- plume ----------
const PLUME_COLORS = {
  kerolox: { core: [1, .93, .75], mid: [1, .55, .18], edge: [.9, .28, .06], diamonds: 1 },
  methalox: { core: [1, .9, .85], mid: [.95, .55, .45], edge: [.55, .3, .65], diamonds: .6 },
  hydrolox: { core: [.85, .9, 1], mid: [.55, .65, 1], edge: [.35, .4, .9], diamonds: .3 },
  solid: { core: [1, .97, .85], mid: [1, .72, .35], edge: [1, .5, .2], diamonds: 0 },
};
const plumeVS = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  void main(){ vUv = uv; vec4 mv = modelViewMatrix * vec4(position,1.); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;
const plumeFS = `
  #include <logdepthbuf_pars_fragment>
  uniform float uTime, uI, uExpand, uDiamonds, uSeed; uniform vec3 uCore, uMid, uEdge; uniform float uInner;
  varying vec2 vUv; varying vec3 vN; varying vec3 vV;
  float h(float x){ return fract(sin(x*91.7+uSeed)*43758.5); }
  void main(){
    #include <logdepthbuf_fragment>
    float a = 1. - vUv.y;                       // 0 at nozzle → 1 at tail
    float facing = pow(abs(dot(vN, vV)), 1.6);
    float flick = .85 + .15*sin(uTime*53. + a*21. + uSeed) + .1*sin(uTime*97. - a*9.);
    float body = smoothstep(1., .05, a) * smoothstep(0., .05, a);
    float diam = mix(1., .55 + .45*smoothstep(.45,1.,sin(a*38. - uTime*2.)), uDiamonds*(1.-uExpand)*smoothstep(.6,.1,a));
    vec3 col = mix(uCore, uMid, smoothstep(0., .35 + uInner, a));
    col = mix(col, uEdge, smoothstep(.3, 1., a));
    float alpha = body * facing * flick * diam * uI * mix(1., .35, uExpand);
    gl_FragColor = vec4(col * alpha * 1.6, alpha);
  }`;

export class Plume {
  constructor(radius, type = 'kerolox', { len = 7, inner = 0 } = {}) {
    this.r = radius; this.type = type; this.len = len;
    this.group = new THREE.Group();
    const c = PLUME_COLORS[type] || PLUME_COLORS.kerolox;
    const mk = (rTop, rBot, L, core) => {
      const g = new THREE.CylinderGeometry(rTop, rBot, L, 32, 12, true);
      g.translate(0, -L / 2, 0);
      const m = new THREE.ShaderMaterial({
        vertexShader: plumeVS, fragmentShader: plumeFS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        uniforms: {
          uTime: { value: 0 }, uI: { value: 0 }, uExpand: { value: 0 }, uDiamonds: { value: c.diamonds }, uSeed: { value: Math.random() * 10 }, uInner: { value: inner },
          uCore: { value: new THREE.Vector3(...(core ? [1, 1, .95] : c.core)) }, uMid: { value: new THREE.Vector3(...c.mid) }, uEdge: { value: new THREE.Vector3(...c.edge) },
        },
      });
      const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = 10; return mesh;
    };
    this.outer = mk(radius * .9, radius * 1.6, 1, false);
    this.inner = mk(radius * .7, radius * .9, 1, true);
    this.group.add(this.outer, this.inner);
    // Nozzle glow + ground light
    const tex = glowTexture();
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: new THREE.Color(...c.mid), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.glow.scale.setScalar(radius * 8); this.glow.position.y = -radius * 1.2; this.glow.renderOrder = 11;
    this.group.add(this.glow);
    this.light = new THREE.PointLight(new THREE.Color(1, .6, .3), 0, 0, 0);
    this.light.position.y = -radius * 3;
    this.group.add(this.light);
    this.group.visible = false;
  }
  // altKm drives vacuum expansion; throttle 0..1
  update(time, throttle, altKm, { lightScale = 1 } = {}) {
    const on = throttle > .01;
    this.group.visible = on;
    if (!on) { this.light.intensity = 0; return; }
    const ex = THREE.MathUtils.smoothstep(altKm, 12, 70);
    const L = this.r * (this.len + ex * 22) * (0.9 + .1 * throttle);
    const W = 1 + ex * 9;
    this.outer.scale.set(W, L, W);
    this.inner.scale.set(1 + ex * 1.5, L * (.35 - ex * .15), 1 + ex * 1.5);
    for (const m of [this.outer, this.inner]) {
      m.material.uniforms.uTime.value = time;
      m.material.uniforms.uI.value = throttle * (m === this.inner ? 1.2 : .9);
      m.material.uniforms.uExpand.value = ex;
    }
    this.glow.material.opacity = throttle * (.5 - ex * .3);
    this.glow.scale.setScalar(this.r * (5 + ex * 9));
    this.light.intensity = throttle * 900 * lightScale * this.r * (1 - THREE.MathUtils.smoothstep(altKm, 0.2, 4));
  }
}

let _glow;
export function glowTexture() {
  if (_glow) return _glow;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(.18, 'rgba(255,240,220,.85)'); gr.addColorStop(.45, 'rgba(255,170,90,.25)'); gr.addColorStop(1, 'rgba(255,120,40,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  _glow = new THREE.CanvasTexture(c); _glow.colorSpace = THREE.SRGBColorSpace;
  return _glow;
}

// ---------- pad structures ----------
function lattice(h, w, m, { levels, braces = true } = {}) {
  const g = new THREE.Group();
  const n = levels || Math.max(4, Math.round(h / 6));
  const parts = [];
  const col = new THREE.BoxGeometry(.5, h, .5);
  for (const [x, z] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) parts.push([col, x * w / 2, h / 2, z * w / 2, 0, 0, 0]);
  const beam = new THREE.BoxGeometry(w, .35, .35);
  const diagL = Math.hypot(w, h / n), diag = new THREE.BoxGeometry(diagL, .22, .22), ang = Math.atan2(h / n, w);
  for (let i = 0; i <= n; i++) {
    const y = i * h / n;
    parts.push([beam, 0, y, -w / 2, 0, 0, 0], [beam, 0, y, w / 2, 0, 0, 0], [beam, -w / 2, y, 0, 0, Math.PI / 2, 0], [beam, w / 2, y, 0, 0, Math.PI / 2, 0]);
    if (braces && i < n) {
      const yc = y + h / n / 2, s = i % 2 ? 1 : -1;
      parts.push([diag, 0, yc, -w / 2, 0, 0, s * ang], [diag, 0, yc, w / 2, 0, 0, -s * ang], [diag, -w / 2, yc, 0, 0, Math.PI / 2, s * ang], [diag, w / 2, yc, 0, 0, Math.PI / 2, -s * ang]);
    }
  }
  const byGeo = new Map();
  for (const p of parts) { if (!byGeo.has(p[0])) byGeo.set(p[0], []); byGeo.get(p[0]).push(p); }
  const o = new THREE.Object3D();
  for (const [geo, list] of byGeo) {
    const im = new THREE.InstancedMesh(geo, m, list.length);
    list.forEach((p, i) => { o.position.set(p[1], p[2], p[3]); o.rotation.set(p[4], p[5], p[6], 'YXZ'); o.updateMatrix(); im.setMatrixAt(i, o.matrix); });
    im.castShadow = true; im.receiveShadow = true;
    g.add(im);
  }
  return g;
}

export function buildPad(kind, veh) {
  const g = new THREE.Group();
  const metal = mat(0x3a3d42, .55, .6), concrete = mat(0x6d6c68, .95, 0), dark = mat(0x1b1c1f, .7, .3);
  const lights = [];
  const H = veh.height, R = veh.radius;
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(R * 4 + 14, R * 4 + 16, 1.2, 48), concrete);
  deck.position.y = -.4; deck.receiveShadow = true; g.add(deck);
  const addLight = (x, y, z) => { lights.push(new THREE.Vector3(x, y, z)); };

  if (kind === 'starship') {
    // Orbital launch mount + catch tower with arms
    const olm = lattice(20, 15, metal, { levels: 3 }); g.add(olm);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(5.2, .7, 12, 48), metal); ring.rotation.x = Math.PI / 2; ring.position.y = 20; g.add(ring);
    const tower = lattice(146, 9, dark, { levels: 22 }); tower.position.set(-17, 0, 0); g.add(tower);
    for (const s of [-1, 1]) {
      const arm = box(1.2, 2.5, 26, metal); arm.position.set(-11, 96, s * 4.8); arm.rotation.y = s * -.22; arm.geometry.translate(0, 0, s * 0); g.add(arm);
    }
    const qd = box(10, 3, 2.5, metal); qd.position.set(-11, 92, 0); g.add(qd);
    addLight(-17, 147, 0); addLight(-17, 100, 4.5);
    veh.root.position.y = 21.5;
  } else if (kind === 'newshepard') {
    veh.root.position.y = 1.2;
    const t = lattice(18, 3, metal, { levels: 4 }); t.position.set(-(R + 6), 0, 0); g.add(t);
    addLight(-(R + 6), 18.5, 0);
  } else if (kind === 'electron' || kind === 'small') {
    veh.root.position.y = 2.5;
    const sb = lattice(H * .95, 1.6, metal, { levels: 8 }); sb.position.set(-(R + 1.6), 0, 0); g.add(sb);
    const tm = box(4, 2.5, 4, metal); tm.position.y = 1.25; g.add(tm);
    addLight(-(R + 1.6), H * .96, 0);
  } else {
    const tall = Math.max(H * 1.12, 60);
    veh.root.position.y = kind === 'vulcan' || kind === 'atlas' ? 8 : 6;
    const base = new THREE.Mesh(new THREE.BoxGeometry(R * 2.6 + 8, veh.root.position.y, R * 2.6 + 8), dark);
    base.position.y = veh.root.position.y / 2; base.castShadow = base.receiveShadow = true; g.add(base);
    const tower = lattice(tall, 10, metal, { levels: Math.round(tall / 7) });
    tower.position.set(-(R + 12), 0, 0); g.add(tower);
    // crew / umbilical arms
    for (const y of [H * .62, H * .85]) { const a = box(R + 7, 1.6, 1.6, dark); a.position.set(-(R + 12) / 2 - .5, y + veh.root.position.y, 0); g.add(a); }
    // lightning mast on top
    const mast = cyl(.25, tall, tall + 25, metal, 8); mast.position.x = -(R + 12); g.add(mast);
    addLight(-(R + 12), tall + 25, 0);
  }
  // Lightning towers ring the pad
  const ringR = Math.max(65, H * 1.05);
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + i * Math.PI / 2;
    const t = lattice(Math.max(70, H * 1.3), 3.4, metal, { levels: 10, braces: true });
    t.position.set(Math.cos(a) * ringR, 0, Math.sin(a) * ringR); g.add(t);
    addLight(Math.cos(a) * ringR, Math.max(70, H * 1.3) + .5, Math.sin(a) * ringR);
  }
  // Water tower — a pad landmark
  const wt = new THREE.Group();
  wt.add(cyl(.5, 0, 70, metal, 8).translateX(-3), cyl(.5, 0, 70, metal, 8).translateX(3));
  const tank = new THREE.Mesh(new THREE.SphereGeometry(8, 24, 16), concrete); tank.position.y = 76; tank.castShadow = true; wt.add(tank);
  wt.position.set(-ringR * 2.1, 0, -ringR * 1.3); g.add(wt);

  // Red aviation lights (blink in shader-less way via sprite opacity)
  const tex = glowTexture();
  const beacons = lights.map(p => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xff2a1a, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    s.position.copy(p); s.scale.setScalar(6); g.add(s); return s;
  });
  g.userData.beacons = beacons;
  return g;
}
