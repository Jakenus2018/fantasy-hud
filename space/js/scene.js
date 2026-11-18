// The 3D stage: satellite-draped terrain around the pad, real-sun lighting,
// the vehicle, and a broadcast-style camera director for launch replays.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { buildVehicle, buildPad, Plume } from './rocket.js';
import { Smoke } from './fx.js';
import { sunPosition } from './astro.js';
import { density, soundSpeed } from './flight.js';

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V3(0, 1, 0);
const ss = THREE.MathUtils.smoothstep;
const lerp = THREE.MathUtils.lerp;
const ease = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// ---------- tiles ----------
const IMG = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
const DEM = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const tileXY = (lat, lon, z) => {
  const n = 2 ** z, r = lat * Math.PI / 180;
  return { x: (lon + 180) / 360 * n, y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n };
};
const mpp = (lat, z) => 40075016.686 * Math.cos(lat * Math.PI / 180) / (256 * 2 ** z);

// Small fetch queue so ~250 tile requests don't stampede.
class Queue {
  constructor(n) { this.n = n; this.active = 0; this.q = []; }
  push(fn) { return new Promise((res) => { this.q.push([fn, res]); this.pump(); }); }
  pump() {
    while (this.active < this.n && this.q.length) {
      const [fn, res] = this.q.shift(); this.active++;
      fn().then(res, () => res(null)).finally(() => { this.active--; this.pump(); });
    }
  }
  clear() { this.q.length = 0; }
}
const queue = new Queue(14);
const loadImg = url => queue.push(() => new Promise((res) => {
  const im = new Image(); im.crossOrigin = 'anonymous'; im.decoding = 'async';
  const t = setTimeout(() => res(null), 20000);
  im.onload = () => { clearTimeout(t); res(im); }; im.onerror = () => { clearTimeout(t); res(null); };
  im.src = url;
}));

async function mosaic(lat, lon, z, n, url, tick, token) {
  const c = tileXY(lat, lon, z), x0 = Math.round(c.x - n / 2), y0 = Math.round(c.y - n / 2);
  const cv = document.createElement('canvas'); cv.width = cv.height = n * 256;
  const g = cv.getContext('2d', { willReadFrequently: url === DEM });
  let ok = 0;
  const jobs = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    jobs.push(loadImg(url(z, x0 + i, y0 + j)).then(im => {
      if (token.dead) return;
      if (im) { g.drawImage(im, i * 256, j * 256); ok++; }
      tick();
    }));
  }
  await Promise.all(jobs);
  const m = mpp(lat, z);
  return { canvas: cv, ok, total: n * n, m, px: (c.x - x0) * 256, py: (c.y - y0) * 256, size: n * 256 };
}

function demSampler(mo) {
  if (!mo || !mo.ok) return () => 0;
  const { size, m, px, py } = mo;
  const data = mo.canvas.getContext('2d').getImageData(0, 0, size, size).data;
  const at = (i, j) => {
    i = Math.max(0, Math.min(size - 1, i)); j = Math.max(0, Math.min(size - 1, j));
    const k = (j * size + i) * 4;
    if (data[k + 3] === 0) return 0;
    return data[k] * 256 + data[k + 1] + data[k + 2] / 256 - 32768;
  };
  return (x, z) => {
    const u = x / m + px, v = z / m + py, i = Math.floor(u), j = Math.floor(v), fu = u - i, fv = v - j;
    return lerp(lerp(at(i, j), at(i + 1, j), fu), lerp(at(i, j + 1), at(i + 1, j + 1), fu), fv);
  };
}

// Terrain material. Up to three imagery mosaics (fine → coarse) are blended by
// world position on ONE mesh, so there's no layer overlap to z-fight. Optional
// monochrome contour style; soft square outer edge; optional hole for the far ring.
const rectOf = mo => new THREE.Vector4(-mo.px * mo.m, -mo.py * mo.m, mo.size * mo.m, 0);
function texOf(mo) {
  const t = new THREE.CanvasTexture(mo.canvas);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.generateMipmaps = true;
  return t;
}
function terrainMaterial(texs, rects, { fade = .1, hole = null, uniforms }) {
  const m = new THREE.MeshStandardMaterial({ roughness: .96, metalness: 0, transparent: true });
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, {
      uMono: uniforms.uMono, uPadElev: uniforms.uPadElev, uFade: { value: fade },
      tA: { value: texs[0] }, tB: { value: texs[1] }, tC: { value: texs[2] },
      rA: { value: rects[0] }, rB: { value: rects[1] }, rC: { value: rects[2] },
      rHole: { value: hole || new THREE.Vector4(0, 0, 0, 0) },
    });
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWp;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWp = (modelMatrix * vec4(transformed,1.)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', `#include <common>
        varying vec3 vWp; uniform float uMono, uFade, uPadElev;
        uniform sampler2D tA, tB, tC; uniform vec4 rA, rB, rC, rHole;
        vec2 uvOf(vec4 r){ vec2 q = (vWp.xz - r.xy) / r.z; return vec2(q.x, 1. - q.y); }
        float edgeW(vec2 uv, float f){ vec2 e = min(uv, 1. - uv); return smoothstep(0., f, min(e.x, e.y)); }`)
      .replace('#include <map_fragment>', `
        if (rHole.z > 0.) { vec2 hq = (vWp.xz - rHole.xy) / rHole.z; if (min(min(hq.x, hq.y), min(1.-hq.x, 1.-hq.y)) > rHole.w) discard; }
        vec2 uA = uvOf(rA), uB = uvOf(rB), uC = uvOf(rC);
        vec3 col = texture2D(tC, uC).rgb;
        col = mix(col, texture2D(tB, uB).rgb, edgeW(uB, .12));
        col = mix(col, texture2D(tA, uA).rgb, edgeW(uA, .14));
        diffuseColor.rgb *= col;
        if (uMono > .001) {
          float lum = dot(diffuseColor.rgb, vec3(.299,.587,.114));
          vec3 mono = vec3(pow(max(lum, 0.), 1.1)) * .55 + .015;
          float h = vWp.y + uPadElev;
          float c1 = abs(fract(h / 10. - .5) - .5) / max(fwidth(h / 10.), 1e-4);
          float c2 = abs(fract(h / 50. - .5) - .5) / max(fwidth(h / 50.), 1e-4);
          vec2 gp = vWp.xz / 1000.;
          vec2 gg = abs(fract(gp - .5) - .5) / max(fwidth(gp), vec2(1e-4));
          float grid = 1. - min(min(gg.x, gg.y), 1.);
          float lines = (1. - min(c1, 1.)) * .25 + (1. - min(c2, 1.)) * .55;
          mono += vec3(.9) * lines * .4 + vec3(.6, .65, .7) * grid * .16;
          diffuseColor.rgb = mix(diffuseColor.rgb, mono, uMono);
        }
        diffuseColor.a *= edgeW(uC, uFade);`);
  };
  return m;
}

// Grid that is dense at the pad and coarse at the rim: x = sign(u)·|u|^2.2 · extent.
function terrainGeometry(x0, z0, W, sampler, padElev, N, yOff = 0, pw = 2.2) {
  const left = -x0, right = x0 + W, top = -z0, bottom = z0 + W;
  const pos = new Float32Array((N + 1) * (N + 1) * 3);
  const warp = (u, a, b) => { const s = Math.sign(u) * Math.pow(Math.abs(u), pw); return s < 0 ? s * a : s * b; };
  let k = 0;
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const x = warp(i / N * 2 - 1, left, right), z = warp(j / N * 2 - 1, top, bottom);
    let h = sampler(x, z);
    if (h < .5) h = -1.5; // sea / bathymetry → flat water surface
    pos[k++] = x; pos[k++] = h - padElev + yOff; pos[k++] = z;
  }
  const idx = new Uint32Array(N * N * 6); k = 0;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
    idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

// ---------- sky ----------
const SKY_VS = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vDir;
  void main(){ vDir = position; vec4 mv = modelViewMatrix * vec4(position,1.); gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;
const SKY_FS = `
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uSun; uniform float uAlt;
  varying vec3 vDir;
  void main(){
    #include <logdepthbuf_fragment>
    vec3 d = normalize(vDir);
    float h = d.y, sh = uSun.y;
    float day = smoothstep(-.16, .14, sh);
    float twi = smoothstep(-.32, -.02, sh) * (1. - smoothstep(.04, .3, sh));
    vec3 zen = mix(vec3(.004,.007,.016), vec3(.09,.24,.5), day);
    vec3 hor = mix(vec3(.018,.03,.055), vec3(.58,.7,.84), day);
    float hv = max(h, 0.);
    vec3 col = mix(hor, zen, pow(hv, .45));
    vec2 dh = normalize(d.xz + 1e-5), sdh = normalize(uSun.xz + 1e-5);
    float toward = max(dot(dh, sdh), 0.);
    col += vec3(1., .42, .14) * twi * pow(1. - hv, 7.) * (.18 + .82 * pow(toward, 2.5));
    col += vec3(.95, .55, .3) * twi * .12 * pow(1. - hv, 3.);
    float sd = max(dot(d, uSun), 0.);
    col += vec3(1., .92, .8) * (pow(sd, 1800.) * 30. + pow(sd, 14.) * .22 * day + pow(sd, 4.) * .06 * twi);
    float space = smoothstep(18., 95., uAlt);
    col = mix(col, vec3(0.), space * (.35 + .65 * smoothstep(-.05, .35, h)));
    if (h < 0.) col = mix(col, hor * .35, smoothstep(0., -.04, h) * (1. - space * .5));
    gl_FragColor = vec4(col, 1.);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;
const STAR_VS = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float aMag; uniform float uVis, uPx; varying float vA;
  void main(){ vA = uVis * aMag; vec4 mv = modelViewMatrix * vec4(position,1.); gl_Position = projectionMatrix * mv; gl_PointSize = (1. + aMag * 1.6) * uPx;
    #include <logdepthbuf_vertex>
  }`;
const STAR_FS = `
  #include <logdepthbuf_pars_fragment>
  varying float vA;
  void main(){
    #include <logdepthbuf_fragment>
    float d = length(gl_PointCoord - .5); gl_FragColor = vec4(vec3(.9,.94,1.), vA * smoothstep(.5, .1, d)); }`;

// ---------- main class ----------
export class LaunchScene {
  constructor(canvas, hooks = {}) {
    this.hooks = hooks;
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.autoClear = false;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, .5, 7e6);
    this.inset = new THREE.PerspectiveCamera(30, 16 / 9, .5, 7e6);
    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: .06, maxPolarAngle: Math.PI * .495, rotateSpeed: .55, zoomSpeed: .9, autoRotateSpeed: .35 });
    this.controls.addEventListener('start', () => { this.lastInteract = performance.now(); this.controls.autoRotate = false; });

    const pm = new THREE.PMREMGenerator(r);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), .04).texture;
    this.scene.environmentIntensity = .45;

    this.uniforms = { uMono: { value: 0 }, uPadElev: { value: 0 } };
    this.fog = new THREE.FogExp2(0x8fa6bf, 1 / 40000);
    this.scene.fog = this.fog;

    // Lights
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -.0004; this.sun.shadow.normalBias = .4;
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbcd4ff, 0x40372c, 1);
    this.scene.add(this.hemi);
    this.floods = [0, 1, 2].map(i => {
      const s = new THREE.SpotLight(0xfff1dc, 0, 0, .32, .55, 0);
      const a = i * 2.1 + .4; s.position.set(Math.cos(a) * 170, 26, Math.sin(a) * 170);
      this.scene.add(s, s.target); return s;
    });

    // Sky + stars
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(5e6, 48, 24), new THREE.ShaderMaterial({
      vertexShader: SKY_VS, fragmentShader: SKY_FS, side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uSun: { value: V3(0, 1, 0) }, uAlt: { value: 0 } },
    }));
    this.sky.renderOrder = -10; this.sky.frustumCulled = false;
    this.scene.add(this.sky);
    const N = 5000, sp = new Float32Array(N * 3), mag = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, R = 4.6e6, s = Math.sqrt(1 - u * u);
      sp[i * 3] = R * s * Math.cos(t); sp[i * 3 + 1] = R * u; sp[i * 3 + 2] = R * s * Math.sin(t);
      mag[i] = Math.pow(Math.random(), 6);
    }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3)); sg.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    this.stars = new THREE.Points(sg, new THREE.ShaderMaterial({ vertexShader: STAR_VS, fragmentShader: STAR_FS, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, uniforms: { uVis: { value: 0 }, uPx: { value: r.getPixelRatio() } } }));
    this.stars.frustumCulled = false; this.stars.renderOrder = -9;
    this.scene.add(this.stars);

    this.world = new THREE.Group(); this.scene.add(this.world);
    this.terrain = new THREE.Group(); this.world.add(this.terrain);
    this.ocean = new THREE.Mesh(new THREE.PlaneGeometry(2.4e7, 2.4e7).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x041222, roughness: .55, metalness: 0 }));
    this.ocean.renderOrder = -6; this.world.add(this.ocean);

    this.smoke = new Smoke();
    this.scene.add(this.smoke.mesh);

    this.time = new Date();
    this.timeTarget = null;
    this.clock = new THREE.Clock();
    this.mode = 'idle';
    this.lastInteract = 0;
    this.insetRect = null;
    this.camMode = 'auto';
    this.shotState = { name: null, prev: null, t0: 0 };
    this._tmp = { q: new THREE.Quaternion(), v: V3(), v2: V3() };
    this.resize();
    addEventListener('resize', () => this.resize());
    this.renderer.setAnimationLoop(() => this.frame());
  }

  resize() {
    const c = this.renderer.domElement, w = c.clientWidth || innerWidth, h = c.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  setStyle(mono) { this.uniforms.uMono.value = mono ? 1 : 0; }

  // ---------- site ----------
  async loadSite(lat, lon, onProgress) {
    if (this.token) this.token.dead = true;
    queue.clear();
    const token = this.token = { dead: false };
    this.center = { lat, lon };
    let done = 0; const total = 36 + 36 + 36 + 36 + 36 + 36;
    const tick = () => { done++; onProgress?.(Math.min(1, done / total)); };

    const [demNear, demFar] = await Promise.all([mosaic(lat, lon, 12, 6, DEM, tick, token), mosaic(lat, lon, 9, 6, DEM, tick, token)]);
    if (token.dead) return false;
    const hNear = demSampler(demNear), hFar = demSampler(demFar);
    let padElev = Math.max(0, hNear(0, 0));
    if (!isFinite(padElev)) padElev = 0;
    this.padElev = padElev;
    this.heightAt = (x, z) => { const h = hNear(x, z); return (h < .5 ? -1.5 : h) - padElev; };
    this.uniforms.uPadElev.value = padElev;
    this.smoke.uniforms.uPadElev.value = padElev;

    const [pad, mid, near, far] = await Promise.all([
      mosaic(lat, lon, 16, 6, IMG, tick, token), mosaic(lat, lon, 14, 6, IMG, tick, token),
      mosaic(lat, lon, 12, 6, IMG, tick, token), mosaic(lat, lon, 9, 6, IMG, tick, token),
    ]);
    if (token.dead) return false;
    this.imageryOK = pad.ok + mid.ok + near.ok + far.ok > 10;
    if (!this.imageryOK) this.setStyle(true);

    for (const m of [...this.terrain.children]) {
      this.terrain.remove(m); m.geometry.dispose();
      const sh = m.material.userData.texs || []; sh.forEach(t => t.dispose()); m.material.dispose();
    }
    for (const mo of [pad, mid, near, far]) if (!mo.ok) { const g = mo.canvas.getContext('2d'); g.fillStyle = '#16191d'; g.fillRect(0, 0, mo.size, mo.size); }
    // near: one mesh, three imagery resolutions
    const rN = rectOf(near), nt = [texOf(pad), texOf(mid), texOf(near)];
    const nearMat = terrainMaterial(nt, [rectOf(pad), rectOf(mid), rN], { fade: .1, uniforms: this.uniforms });
    nearMat.userData.texs = nt;
    const nearMesh = new THREE.Mesh(terrainGeometry(rN.x, rN.y, rN.z, hNear, padElev, 300), nearMat);
    nearMesh.receiveShadow = true; nearMesh.renderOrder = -4;
    // far ring: coarse, lowered, with a hole where the near mesh is opaque
    const rF = rectOf(far), ft = texOf(far);
    const hole = new THREE.Vector4(rN.x, rN.y, rN.z, .1);
    const farMat = terrainMaterial([ft, ft, ft], [rF, rF, rF], { fade: .14, hole, uniforms: this.uniforms });
    farMat.userData.texs = [ft];
    const farMesh = new THREE.Mesh(terrainGeometry(rF.x, rF.y, rF.z, hFar, padElev, 160, -30, 1.6), farMat);
    farMesh.renderOrder = -5;
    this.terrain.add(farMesh, nearMesh);
    this.ocean.position.y = -padElev - 60;
    return true;
  }

  // ---------- vehicle ----------
  setVehicle(kind, info) {
    this.endFlight(true);
    if (this.vehicle) { this.world.remove(this.vehicle.root); this.world.remove(this.padGroup); }
    const v = this.vehicle = buildVehicle(kind, info);
    this.padGroup = buildPad(kind, v);
    this.world.add(this.padGroup, v.root);
    this.kind = kind;
    // plumes
    const ex = v.exhaust;
    this.plumes = {
      booster: new Plume(v.plume.booster.r, ex, { len: kind === 'starship' ? 9 : 7 }),
      upper: v.plume.upper ? new Plume(v.plume.upper.r, v.upperType, { len: 5, inner: .2 }) : null,
      srb: v.plume.srb ? v.strapons.map(() => new Plume(v.plume.srb.r, 'solid', { len: 9 })) : [],
      side: v.plume.side ? v.strapons.map(() => new Plume(v.plume.side.r, 'kerolox', { len: 7 })) : [],
    };
    this.plumes.booster.group.position.y = v.plume.booster.y; v.booster.add(this.plumes.booster.group);
    if (this.plumes.upper) { this.plumes.upper.group.position.y = v.plume.upper.y; v.upper.add(this.plumes.upper.group); }
    this.plumes.srb.forEach((p, i) => { p.group.position.y = v.plume.srb.y; v.strapons[i].add(p.group); });
    this.plumes.side.forEach((p, i) => { p.group.position.y = v.plume.booster.y; v.strapons[i].add(p.group); });
    for (const l of v.legs) l.rotation.order = 'YXZ';
    this.mountY = v.root.position.y;
    this.restPose();
    // floodlights aim at the vehicle
    for (const f of this.floods) { f.target.position.set(0, this.mountY + v.height * .5, 0); }
    // shadow frustum hugs the pad
    const s = this.sun.shadow.camera, ext = Math.max(90, v.height * 1.6);
    s.left = -ext; s.right = ext; s.top = ext; s.bottom = -ext; s.near = 1; s.far = 6000; s.updateProjectionMatrix();
  }

  restPose() {
    const v = this.vehicle; if (!v) return;
    v.root.position.set(0, this.mountY, 0); v.root.quaternion.identity();
    if (v.booster.parent !== v.root) { v.root.add(v.booster); }
    v.booster.position.set(0, 0, 0); v.booster.quaternion.identity();
    v.strapons.forEach(s => { if (s.parent !== v.booster) v.booster.add(s); s.visible = true; });
    v.strapons.forEach((s, i) => { s.position.copy(s.userData.home || (s.userData.home = s.position.clone())); s.quaternion.identity(); });
    v.fairing.forEach(f => { if (f.parent !== v.upper) v.upper.add(f); f.position.copy(f.userData.home || (f.userData.home = f.position.clone())); f.quaternion.identity(); f.visible = true; });
    v.gridFins.forEach(g => (g.scale.x = g.userData.fold ? .15 : 1));
    v.legs.forEach(l => (l.rotation.x = 0));
    v.booster.visible = true; v.upper.visible = true;
    Object.values(this.plumes || {}).flat().forEach(p => p && p.update(0, 0, 0));
    if (this.barge) { this.world.remove(this.barge); this.barge = null; }
  }

  idleView(instant = false) {
    const v = this.vehicle, H = v ? v.height : 70;
    const target = V3(0, this.mountY + H * .42, 0);
    // service structures sit on the west (-x) side, so view from the east-south-east
    const a = 97 * Math.PI / 180, d = H * 2.6 + 70;
    const pos = V3(Math.sin(a) * d, target.y + H * .35 + 12, -Math.cos(a) * d);
    this.controls.minDistance = Math.max(18, H * .35);
    this.controls.maxDistance = 320000;
    if (instant) { this.camera.position.copy(pos); this.controls.target.copy(target); this.camera.fov = 40; this.camera.updateProjectionMatrix(); return; }
    this.flyTo(pos, target, 2.2);
  }

  intro() {
    const v = this.vehicle, H = v ? v.height : 70;
    this.camera.position.set(-18000, 42000, 52000);
    this.controls.target.set(0, this.mountY + H * .42, 0);
    this.idleView();
    this.fly.dur = 6.5;
  }

  flyTo(pos, target, dur = 2) {
    this.fly = { p0: this.camera.position.clone(), t0: this.controls.target.clone(), p1: pos.clone(), t1: target.clone(), s: 0, dur };
    this.controls.enabled = false;
  }

  // ---------- time & light ----------
  setTime(date, smooth = false) {
    if (smooth) { this.timeTarget = date.valueOf(); return; }
    this.time = new Date(date.valueOf()); this.timeTarget = null; this.updateLight();
  }
  updateLight() {
    if (!this.center) return;
    const { alt, az } = sunPosition(this.time, this.center.lat, this.center.lon);
    this.sunAlt = alt; this.sunAz = az;
    const a = alt * Math.PI / 180, z = az * Math.PI / 180;
    const dir = V3(Math.cos(a) * Math.sin(z), Math.sin(a), -Math.cos(a) * Math.cos(z));
    this.sunDir = dir;
    this.sky.material.uniforms.uSun.value.copy(dir);
    const day = ss(alt, -7, 10), lowSun = ss(alt, -1, 22);
    this.sun.position.copy(dir).multiplyScalar(2000);
    this.sun.intensity = 3.3 * ss(alt, -1.5, 8);
    this.sun.color.setRGB(1, lerp(.62, .97, lowSun), lerp(.38, .92, lowSun));
    this.sun.castShadow = alt > 0;
    this.hemi.intensity = lerp(.55, 1.15, day);
    this.hemi.color.setRGB(lerp(.32, .74, day), lerp(.4, .83, day), lerp(.62, 1, day));
    this.hemi.groundColor.setRGB(lerp(.04, .3, day), lerp(.05, .27, day), lerp(.08, .22, day));
    this.renderer.toneMappingExposure = lerp(1.35, .95, day);
    this.scene.environmentIntensity = lerp(.12, .45, day);
    for (const f of this.floods) f.intensity = (1 - day) * 5;
    const fogCol = new THREE.Color().setRGB(lerp(.02, .56, day), lerp(.035, .66, day), lerp(.06, .78, day));
    fogCol.lerp(new THREE.Color(.75, .42, .25), (1 - lowSun) * day * .35);
    this.fog.color.copy(fogCol);
    this.stars.material.uniforms.uVis.value = 1 - ss(alt, -10, -2);
    // smoke lighting
    const U = this.smoke.uniforms;
    U.uSunAlt.value = alt;
    U.uLit.value.setRGB(lerp(1, .98, lowSun), lerp(.62, .95, lowSun), lerp(.42, .9, lowSun)).multiplyScalar(lerp(.9, 1.05, day));
    U.uShade.value.setRGB(lerp(.05, .52, day), lerp(.06, .55, day), lerp(.09, .6, day));
    this.isNight = day < .3;
  }
  setWind(speedKmh, fromDeg) {
    const s = (speedKmh || 0) / 3.6, a = ((fromDeg || 0) + 180) * Math.PI / 180;
    this.smoke.wind.set(Math.sin(a) * s, 0, -Math.cos(a) * s);
  }

  // ---------- flight ----------
  startFlight(tr, { startT = -12, warp = 'auto' } = {}) {
    this.restPose();
    this.smoke.clear();
    this.flight = { tr, t: startT, warp, sepDone: false, strapDone: false, fairDone: false, landed: false, sideTr: null, telemetryAt: 0, events: new Set(), touched: false };
    if (tr.recovery === 'asds') {
      const g = new THREE.Group(), deck = new THREE.Mesh(new THREE.BoxGeometry(52, 4, 91), new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: .8 }));
      deck.position.y = -2; g.add(deck);
      const ring = new THREE.Mesh(new THREE.RingGeometry(10, 12, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xf2f2f2 }));
      ring.position.y = .05; g.add(ring);
      const p = tr.booster(tr.landT).pos;
      g.position.set(p[0], -this.padElev - 1.5 + 2, p[2]);
      this.barge = g; this.world.add(g);
    }
    this.mode = 'flight';
    this.controls.enabled = this.camMode === 'free';
    this.controls.autoRotate = false;
    this.shotState = { name: null, prev: null, t0: 0 };
    this.prevRoot = this.vehicle.root.position.clone();
    this.prevB = null;
  }
  endFlight(silent) {
    if (!this.flight) return;
    this.flight = null; this.mode = 'idle';
    this.controls.enabled = true;
    if (!silent) { this.restPose(); this.smoke.clear(); this.idleView(); }
  }
  warpAt(t) {
    const f = this.flight, tr = f.tr;
    if (f.warp !== 'auto') return f.warp;
    if (t < 0) return 1;
    if (tr.profile.vertical) {
      if (t < 14) return 1; if (t < tr.profile.meco - 8) return 4; if (t < tr.landT - 30) return 9; if (t < tr.landT + 6) return 2.5; return 10;
    }
    const sep = tr.sepT;
    if (t < 14) return 1;
    if (t < 40) return lerp(1.5, 6, ss(t, 14, 40));
    if (t < sep - 14) return 9;
    if (t < sep + 16) return 2.2;
    if (tr.landT && t > tr.landT - 34 && t < tr.landT + 5) return 2.6;
    return 13;
  }

  stepFlight(dtReal) {
    const f = this.flight, tr = f.tr, v = this.vehicle, p = tr.profile;
    const warp = this.warpAt(f.t);
    const dt = dtReal * warp;
    f.t += dt;
    const t = f.t;
    const M = this.mountY;

    // ---- upper stack
    const s = tr.stack(Math.max(0, t));
    const pos = V3(s.pos[0], s.pos[1] + M, s.pos[2]);
    let dir;
    if (t < 6) dir = UP.clone();
    else {
      const s2 = tr.stack(t + 1);
      dir = V3(s2.pos[0] - s.pos[0], s2.pos[1] - s.pos[1], s2.pos[2] - s.pos[2]).normalize();
      dir.lerp(UP, 1 - ss(t, 6, 18)).normalize();
    }
    // tiny pad sway at ignition
    if (t < 0 && t > -3) pos.x += (Math.random() - .5) * .04;
    v.root.position.copy(pos);
    v.root.quaternion.setFromUnitVectors(UP, dir);

    const ignite = ss(t, -3.2, -1.2);
    const stackBurn = tr.stackBurning(Math.max(0, t)) ? 1 : 0;
    const altKm = Math.max(0, s.h);
    const time = performance.now() / 1000;

    // ---- strap-ons
    if (p.strapons && t >= p.strapons.t && !f.strapDone) {
      f.strapDone = true;
      v.strapons.forEach(sb => {
        this.world.attach(sb);
        sb.userData.vel = dir.clone().multiplyScalar(s.v * .97);
        const out = sb.position.clone().sub(pos); out.y = 0; out.normalize();
        sb.userData.vel.addScaledVector(out, 9);
        sb.userData.spin = V3(Math.random() - .5, 0, Math.random() - .5).multiplyScalar(.3);
        sb.userData.t0 = t;
      });
      if (p.strapons.mode === 'rtls') f.sideTr = this.hooks.sideTrajectory?.(tr);
      this.flash(pos, 'Separation');
    }
    if (f.strapDone) {
      v.strapons.forEach((sb, i) => {
        if (f.sideTr) {
          const st = f.sideTr.booster(t + (f.sideTr.sepT - p.strapons.t));
          const k = ss(t, p.strapons.t, p.strapons.t + 25);
          const tgt = V3(st.pos[0], st.pos[1] + M, st.pos[2]).addScaledVector(V3(...f.sideTr.cross), (i ? 1 : -1) * (180 + 260 * (1 - ss(t, f.sideTr.landT - 120, f.sideTr.landT))));
          sb.position.lerp(tgt, k < 1 ? .08 + k * .5 : 1);
          if (k < 1) sb.position.addScaledVector(sb.userData.vel, dt * (1 - k));
          const vv = V3(...st.vel); if (vv.lengthSq() > 1) sb.quaternion.slerp(this._tmp.q.setFromUnitVectors(UP, vv.normalize().negate()), Math.min(1, dt * .25));
          const burn = f.sideTr.boosterBurning(t + (f.sideTr.sepT - p.strapons.t)) ? 1 : 0;
          this.plumes.side[i]?.update(time, burn, st.h);
          if (st.landed && sb.userData.legs !== 1) sb.userData.legs = 1;
        } else {
          sb.userData.vel.y -= 9.8 * dt;
          sb.position.addScaledVector(sb.userData.vel, dt);
          sb.rotateX(sb.userData.spin.x * dt); sb.rotateZ(sb.userData.spin.z * dt);
          const age = t - sb.userData.t0;
          this.plumes.srb[i]?.update(time, age < 1.5 ? 1 - age / 1.5 : 0, altKm);
          sb.visible = age < 40;
        }
      });
    } else {
      this.plumes.srb.forEach(pl => pl.update(time, Math.max(ignite * (t > -.3 ? 1 : 0), 0) * (t >= -0.2 ? 1 : 0), altKm));
      this.plumes.side.forEach(pl => pl.update(time, Math.max(ignite, stackBurn), altKm));
    }

    // ---- staging
    if (t >= tr.sepT && !f.sepDone) {
      f.sepDone = true;
      this.world.attach(v.booster);
      f.sepDir = dir.clone(); f.sepPos = v.booster.position.clone();
      this.flash(pos, 'Stage separation');
      for (let i = 0; i < 24; i++) this.smoke.emit(pos.x + dir.x * v.sepY, pos.y + dir.y * v.sepY, pos.z + dir.z * v.sepY, (Math.random() - .5) * 30, (Math.random() - .5) * 30, (Math.random() - .5) * 30, { life: 2.5, s0: 4, s1: 30, alpha: .35, drag: 1.5 });
    }
    let bState = null;
    if (f.sepDone) {
      bState = tr.booster(t);
      const bp = V3(bState.pos[0], bState.pos[1] + M, bState.pos[2]);
      const tau = t - tr.sepT;
      // early separation: guarantee the booster falls cleanly behind the upper stage
      const early = f.sepPos.clone().addScaledVector(f.sepDir, s.v * tau * .985 - 2.5 * tau - 1.2 * tau * tau);
      early.y -= 4.9 * tau * tau * .2;
      bp.lerpVectors(early, bp, ss(tau, 0, 24));
      v.booster.position.copy(bp);
      const vel = V3(...bState.vel);
      if (tr.recovery === 'expend') {
        v.booster.rotateX(dt * .05); v.booster.rotateZ(dt * .03);
        v.booster.visible = tau < 160;
      } else if (vel.lengthSq() > 4) {
        const want = this._tmp.q.setFromUnitVectors(UP, vel.clone().normalize().negate());
        v.booster.quaternion.slerp(want, Math.min(1, dt * (tau < 30 ? .12 : .6)));
      } else if (bState.landed) {
        v.booster.quaternion.slerp(this._tmp.q.identity(), Math.min(1, dt * 2));
      }
      v.gridFins.forEach(g => { if (g.userData.fold) g.scale.x = lerp(.15, 1, ss(tau, 1, 4)); });
      if (tr.landT) v.legs.forEach(l => (l.rotation.x = 2.25 * ss(t, tr.landT - 9, tr.landT - 3)));
      const bb = tr.boosterBurning(t) ? 1 : 0;
      this.plumes.booster.update(time, bb * (bState.landed ? 0 : 1), bState.h, { lightScale: 1 });
      if (bState.landed && !f.landed) {
        f.landed = true;
        this.flash(bp, tr.recovery === 'catch' ? 'Caught' : 'Touchdown');
        for (let i = 0; i < 70; i++) { const a = Math.random() * 6.28, sp = 10 + Math.random() * 25; this.smoke.emit(bp.x, bp.y + 2, bp.z, Math.cos(a) * sp, 2 + Math.random() * 4, Math.sin(a) * sp, { life: 9, s0: 6, s1: 40, alpha: .5, drag: .9 }); }
      }
      // booster smoke trail on landing burn near ground
      if (bb && bState.h < 3) this.emitTrail(bp, vel.clone().normalize().negate(), v.radius, bState.h, dtReal, .5, 'b');
      f.bVel = vel; f.bPos = bp;
    } else {
      const thr = Math.max(ignite, stackBurn);
      this.plumes.booster.update(time, t < 0 ? ignite : stackBurn, altKm);
      void thr;
    }

    // upper plume
    if (this.plumes.upper) {
      const lit = f.sepDone && tr.stackBurning(t) ? 1 : 0;
      this.plumes.upper.update(time, lit, altKm);
    }

    // fairings
    if (p.fairing && t >= p.fairing && !f.fairDone && v.fairing.length) {
      f.fairDone = true;
      v.fairing.forEach((h, i) => {
        this.world.attach(h);
        h.userData.vel = dir.clone().multiplyScalar(s.v * .995);
        const side = V3(1, 0, 0).applyQuaternion(v.root.quaternion).multiplyScalar(i ? -6 : 6);
        h.userData.vel.add(side); h.userData.spin = (i ? 1 : -1) * .35; h.userData.t0 = t;
      });
      this.flash(pos, 'Fairing separation');
    }
    if (f.fairDone) v.fairing.forEach(h => {
      h.position.addScaledVector(h.userData.vel, dt);
      h.rotateZ(h.userData.spin * dt);
      h.visible = t - h.userData.t0 < 60;
    });

    // ---- exhaust trail from the stack
    const nozzle = pos.clone().addScaledVector(dir, f.sepDone ? v.sepY - 3 : -2);
    if ((t < 0 && ignite > .3) || (!f.sepDone && stackBurn)) {
      this.emitTrail(nozzle, dir.clone().negate(), v.radius, altKm, dtReal, t < 0 ? ignite : 1, 's');
      if (altKm < .5) this.emitGround(nozzle, altKm, dtReal, t < 0 ? ignite : 1);
    }
    if (f.strapDone === false && v.strapons.length && p.strapons?.mode === 'fall' && t > 0) {
      // solid boosters thicken the trail
      this.emitTrail(nozzle, dir.clone().negate(), v.radius * 1.4, altKm, dtReal, .7, 'srb');
    }
    // max-q vapour collar
    this.vapour(pos, dir, t, p.maxq);

    // light the smoke from the flame near the ground
    this.smoke.uniforms.uFlamePos.value.copy(nozzle);
    this.smoke.uniforms.uFlameI.value = (t < 0 ? ignite : stackBurn) * (1 - ss(altKm, .3, 3)) * (this.isNight ? 1.4 : .5);

    f.state = { t, s, pos, dir, bState, warp, altKm };

    // telemetry callback ~12 Hz
    if (time - f.telemetryAt > .08) {
      f.telemetryAt = time;
      const tt = Math.max(0, t);
      this.hooks.telemetry?.({
        t, warp,
        s1: f.sepDone ? { v: bState.v, h: Math.max(0, bState.h), landed: bState.landed } : { v: s.v, h: altKm },
        s2: { v: s.v, h: altKm, along: s.along },
        accel: tr.accel(tt), mach: s.v / soundSpeed(altKm), q: .5 * density(altKm) * s.v * s.v / 1000,
        sep: f.sepDone, recovery: tr.recovery, landT: tr.landT, end: tr.end,
      });
    }
    // events
    for (const [et, label] of tr.events) if (t >= et && !f.events.has(label)) { f.events.add(label); this.hooks.event?.(label, et); }
    if (t > tr.end && !f.finished) { f.finished = true; this.hooks.finished?.(); }
  }

  emitTrail(nozzle, back, R, altKm, dtReal, k, tag) {
    if (altKm > 46) return;
    const prev = this['_last' + tag];
    const cur = nozzle.clone();
    this['_last' + tag] = cur;
    if (!prev || prev.distanceTo(cur) > 20000) return;
    const seg = cur.distanceTo(prev);
    const size = R * 2.4 + altKm * 26;
    const n = Math.min(26, Math.max(1, Math.ceil(seg / (size * .35)) || 1)) * (altKm < .05 ? 2 : 1);
    const thin = 1 - ss(altKm, 25, 46);
    for (let i = 0; i < n; i++) {
      const f = Math.random();
      const x = lerp(prev.x, cur.x, f), y = lerp(prev.y, cur.y, f), z = lerp(prev.z, cur.z, f);
      const sp = 18 + Math.random() * 30;
      this.smoke.emit(
        x + back.x * R * 2, y + back.y * R * 2, z + back.z * R * 2,
        back.x * sp + (Math.random() - .5) * 8, back.y * sp + (Math.random() - .5) * 8, back.z * sp + (Math.random() - .5) * 8,
        { life: lerp(14, 40, ss(altKm, 0, 15)), s0: R * 2.2 + altKm * 3, s1: size * (2.6 + altKm * .05), alpha: (.38 + .2 * (1 - ss(altKm, 0, 6))) * thin * k, heat: .9 * (1 - ss(altKm, 2, 12)), drag: .7 });
    }
  }
  emitGround(nozzle, altKm, dtReal, k) {
    const n = Math.ceil(dtReal * 140 * k * (1 - altKm * 2));
    const trench = this.kind === 'starship' ? null : V3(1, 0, 0);
    for (let i = 0; i < n; i++) {
      let a = Math.random() * Math.PI * 2;
      if (trench && Math.random() < .6) a = (Math.random() < .5 ? 0 : Math.PI) + (Math.random() - .5) * .5;
      const sp = 30 + Math.random() * 70;
      this.smoke.emit(nozzle.x * .2, Math.max(2, nozzle.y * .1), nozzle.z * .2, Math.cos(a) * sp, 4 + Math.random() * 10, Math.sin(a) * sp,
        { life: 22, s0: 14, s1: 70 + Math.random() * 50, alpha: .5 * k, heat: .6, drag: .55 });
    }
  }
  vapour(pos, dir, t, maxq) {
    if (!this.cone) {
      const g = new THREE.ConeGeometry(1, 1, 40, 1, true); g.translate(0, -.5, 0);
      this.cone = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, fog: false }));
      this.scene.add(this.cone);
    }
    const k = ss(t, maxq - 22, maxq - 6) * (1 - ss(t, maxq + 4, maxq + 16));
    this.cone.visible = k > .01 && !!this.vehicle;
    if (!this.cone.visible) return;
    const v = this.vehicle, y = v.sepY + 2;
    this.cone.position.copy(pos).addScaledVector(dir, y);
    this.cone.quaternion.setFromUnitVectors(UP, dir);
    this.cone.scale.set(v.radius * 3.4, v.radius * 6, v.radius * 3.4);
    this.cone.material.opacity = k * (.16 + .05 * Math.sin(performance.now() / 40));
  }
  flash(pos, label) { this.hooks.flash?.(label); }

  // ---------- camera director ----------
  shot(name, st) {
    const f = this.flight, tr = f.tr, v = this.vehicle, H = v.height;
    const az = tr.azimuth * Math.PI / 180;
    const side = V3(Math.cos(az), 0, Math.sin(az)), fwd = V3(Math.sin(az), 0, -Math.cos(az));
    const P = st.pos, D = st.dir, mid = P.clone().addScaledVector(D, H * .5);
    const o = { pos: V3(), look: V3(), fov: 40 };
    if (name === 'pad') {
      o.pos.set(0, 4, 0).addScaledVector(side, -(H * 2.2 + 110)).addScaledVector(fwd, -H * .9);
      o.look.copy(mid); o.look.y = Math.max(mid.y, this.mountY + H * .55);
      o.fov = 44;
    } else if (name === 'track') {
      o.pos.set(0, 25, 0).addScaledVector(side, -4200).addScaledVector(fwd, -2600);
      o.look.copy(P).addScaledVector(D, H * .2);
      const dist = o.pos.distanceTo(o.look), frame = H * 2.4 + Math.min(2500, st.altKm * 200);
      o.fov = THREE.MathUtils.clamp(2 * Math.atan(frame / dist) * 180 / Math.PI, 1.2, 38);
    } else if (name === 'chase') {
      // side-on, slightly ahead: the plume and trail stream away from the lens
      const k = H * 2.6 + 40;
      o.pos.copy(mid).addScaledVector(side, -k).addScaledVector(D, k * .18).add(V3(0, -k * .1, 0));
      o.look.copy(mid).addScaledVector(D, -H * .15);
      o.fov = 40;
    } else if (name === 'staging') {
      const S = P.clone().addScaledVector(D, v.sepY);
      o.pos.copy(S).addScaledVector(side, -v.radius * 6 - 10).addScaledVector(D, v.radius * 2 + 6);
      o.look.copy(S).addScaledVector(D, -60);
      o.fov = 58;
    } else if (name === 'upper') {
      const S = P.clone().addScaledVector(D, v.sepY + (H - v.sepY) * .5), k = (H - v.sepY) * 2.4 + 30;
      o.pos.copy(S).addScaledVector(D, -k).addScaledVector(side, -k * .55).add(V3(0, k * .45, 0));
      o.look.copy(S).addScaledVector(D, k * .4).add(V3(0, -k * .5, 0));
      o.fov = 50;
    } else if (name === 'booster') {
      const B = f.bPos || P, vel = (f.bVel || V3(0, -1, 0)).clone();
      const u = vel.lengthSq() > 1 ? vel.normalize() : V3(0, -1, 0);
      o.pos.copy(B).addScaledVector(u, -H * 1.1).addScaledVector(side, -H * .8).add(V3(0, H * .3, 0));
      o.look.copy(B).addScaledVector(UP, H * .3);
      o.fov = 42;
    } else if (name === 'landing') {
      const B = f.bPos || P, L = tr.booster(tr.landT).pos, lz = V3(L[0], L[1] + this.mountY, L[2]);
      o.pos.copy(lz).addScaledVector(side, -900).addScaledVector(fwd, 400).add(V3(0, 18, 0));
      o.look.copy(B).addScaledVector(UP, H * .35);
      const dist = o.pos.distanceTo(o.look);
      o.fov = THREE.MathUtils.clamp(2 * Math.atan(H * 2.2 / dist) * 180 / Math.PI, .6, 40);
    }
    return o;
  }
  autoShot(t) {
    const tr = this.flight.tr, sep = tr.sepT;
    if (tr.profile.vertical) return t < 9 ? 'pad' : t < 45 ? 'track' : 'chase';
    if (t < 8) return 'pad';
    if (t < 58) return 'track';
    if (t < sep - 7) return 'chase';
    if (t < sep + 15) return 'staging';
    return 'upper';
  }
  insetShot(t) {
    const tr = this.flight.tr;
    if (!this.flight.sepDone && !tr.profile.vertical) return null;
    if (!tr.landT) return t < tr.sepT + 60 && !tr.profile.vertical ? 'booster' : null;
    if (tr.profile.vertical) return t > tr.landT - 70 && t < tr.landT + 12 ? 'landing' : null;
    if (t < tr.sepT + 18) return null;
    if (t < tr.landT - 45) return 'booster';
    if (t < tr.landT + 14) return 'landing';
    return null;
  }

  applyShot(cam, name, st, blendFrom, dtReal) {
    const o = this.shot(name, st);
    if (name === 'pad' || name === 'track') {
      const shake = (1 - ss(st.altKm, .3, 6)) * (st.t > -2 ? 1 : 0) * (name === 'pad' ? .5 : .12);
      o.look.x += (Math.random() - .5) * shake * 4; o.look.y += (Math.random() - .5) * shake * 4;
    }
    let pos = o.pos, fov = o.fov, look = o.look;
    if (blendFrom) {
      const b = this.shot(blendFrom.name, st), k = ease(Math.min(1, (performance.now() / 1000 - blendFrom.t0) / 1.4));
      if (k < 1) { pos = b.pos.lerp(o.pos, k); look = b.look.lerp(o.look, k); fov = lerp(b.fov, o.fov, k); }
    }
    cam.position.copy(pos);
    cam.up.copy(UP);
    cam.lookAt(look);
    cam.fov = fov; cam.updateProjectionMatrix();
  }

  setCamMode(m) {
    this.camMode = m;
    if (this.flight) {
      this.controls.enabled = m === 'free';
      if (m === 'free') { const st = this.flight.state; if (st) this.controls.target.copy(st.pos); }
    }
  }

  // ---------- frame ----------
  frame() {
    const dt = Math.min(.05, this.clock.getDelta());
    const now = performance.now() / 1000;
    if (this.timeTarget != null) {
      const cur = this.time.valueOf(), d = this.timeTarget - cur;
      if (Math.abs(d) < 6e4) { this.time = new Date(this.timeTarget); this.timeTarget = null; }
      else this.time = new Date(cur + d * Math.min(1, dt * 2.2));
      this.updateLight();
    } else if (!this.flight) {
      this.time = new Date(Date.now()); if (!this._lt || now - this._lt > 5) { this._lt = now; this.updateLight(); }
    }

    if (this.fly) {
      const F = this.fly; F.s = F.start == null ? (F.start = now, 0) : (now - F.start) / F.dur;
      const k = ease(Math.min(1, F.s));
      // arc the path up a little so fly-ins feel like a descent
      this.camera.position.lerpVectors(F.p0, F.p1, k);
      this.controls.target.lerpVectors(F.t0, F.t1, Math.min(1, k * 1.15));
      this.camera.lookAt(this.controls.target);
      if (F.s >= 1) { this.fly = null; this.controls.enabled = !this.flight || this.camMode === 'free'; this.lastInteract = performance.now(); }
    }

    let insetName = null;
    if (this.flight && this.vehicle) {
      this.stepFlight(dt);
      const st = this.flight.state;
      if (this.camMode === 'free') {
        const delta = st.pos.clone().sub(this.prevRoot || st.pos);
        this.camera.position.add(delta); this.controls.target.add(delta);
        this.controls.update();
      } else if (!this.fly) {
        const name = this.camMode === 'auto' ? this.autoShot(st.t) : this.camMode === 'track' ? 'track' : (this.flight.sepDone ? 'upper' : 'chase');
        const S = this.shotState;
        if (S.name !== name) { S.prev = S.name ? { name: S.name, t0: now } : null; S.name = name; S.t0 = now; this.hooks.shot?.(name); }
        this.applyShot(this.camera, name, st, S.prev, dt);
      }
      this.prevRoot = st.pos.clone();
      insetName = this.insetShot(st.t);
    } else if (!this.fly) {
      if (performance.now() - this.lastInteract > 9000 && this.mode === 'idle') this.controls.autoRotate = true;
      this.controls.update();
    }

    // altitude-dependent atmosphere
    const camAlt = Math.max(0, (this.camera.position.y + (this.padElev || 0)) / 1000);
    this.sky.material.uniforms.uAlt.value = camAlt;
    this.fog.density = 1 / (42000 + camAlt * camAlt * 900 + camAlt * 9000) * (this.isNight ? .7 : 1);
    this.stars.material.uniforms.uVis.value = Math.max(1 - ss(this.sunAlt ?? 30, -10, -2), ss(camAlt, 30, 90));

    // shadows follow the vehicle while it is near the pad
    const focus = this.flight?.state?.pos || V3(0, 0, 0);
    if (focus.y < 2000) { this.sun.target.position.set(0, 0, 0); this.sun.position.copy(this.sunDir || UP).multiplyScalar(2000); }

    // beacons blink
    const bl = this.padGroup?.userData.beacons;
    if (bl) { const on = (now % 1.6) < .7 ? 1 : .12; bl.forEach(b => (b.material.opacity = on * (this.isNight ? 1 : .55))); }

    this.smoke.update(dt, this.camera, 0);

    const r = this.renderer;
    r.setScissorTest(false);
    r.clear();
    this.sky.position.copy(this.camera.position); this.stars.position.copy(this.camera.position);
    r.render(this.scene, this.camera);

    if (insetName && this.insetRect && this.flight) {
      const st = this.flight.state;
      this.applyShot(this.inset, insetName, st, null, dt);
      const R = this.insetRect, H = r.domElement.clientHeight;
      this.inset.aspect = R.w / R.h; this.inset.updateProjectionMatrix();
      this.sky.position.copy(this.inset.position); this.stars.position.copy(this.inset.position);
      r.setScissorTest(true);
      r.setScissor(R.x, H - R.y - R.h, R.w, R.h); r.setViewport(R.x, H - R.y - R.h, R.w, R.h);
      r.clear();
      r.render(this.scene, this.inset);
      r.setScissorTest(false);
      r.setViewport(0, 0, r.domElement.clientWidth, H);
    }
    if ((!!insetName) !== this._insetOn) { this._insetOn = !!insetName; this.hooks.inset?.(this._insetOn ? insetName : null); }
  }
}

// Small turntable render of the vehicle for the side panel.
export class Turntable {
  constructor(canvas) {
    this.r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.r.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.r.outputColorSpace = THREE.SRGBColorSpace; this.r.toneMapping = THREE.ACESFilmicToneMapping; this.r.toneMappingExposure = 1.05;
    this.scene = new THREE.Scene();
    this.scene.environment = new THREE.PMREMGenerator(this.r).fromScene(new RoomEnvironment(), .04).texture;
    this.scene.environmentIntensity = .7;
    const key = new THREE.DirectionalLight(0xffffff, 2.6); key.position.set(4, 6, 8);
    const rim = new THREE.DirectionalLight(0x9fb8ff, 2.2); rim.position.set(-6, 3, -6);
    this.scene.add(key, rim, new THREE.AmbientLight(0xffffff, .25));
    this.cam = new THREE.PerspectiveCamera(22, 1, .1, 2000);
    this.angle = 0; this.visible = true;
    new IntersectionObserver(([e]) => (this.visible = e.isIntersecting)).observe(canvas);
    this.loop = this.loop.bind(this); requestAnimationFrame(this.loop);
  }
  set(kind, info) {
    if (this.v) this.scene.remove(this.v.root);
    this.v = buildVehicle(kind, info);
    this.scene.add(this.v.root);
    const H = this.v.height;
    this.v.root.position.y = -H / 2;
    this.dist = H / (2 * Math.tan(11 * Math.PI / 180)) * 1.08;
  }
  loop() {
    requestAnimationFrame(this.loop);
    if (!this.v || !this.visible) return;
    const c = this.r.domElement, w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * this.r.getPixelRatio())) this.r.setSize(w, h, false);
    this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
    this.angle += .004;
    this.v.root.rotation.y = this.angle;
    this.cam.position.set(Math.sin(.5) * this.dist, this.v.height * .04, Math.cos(.5) * this.dist);
    this.cam.lookAt(0, 0, 0);
    this.r.render(this.scene, this.cam);
  }
}
