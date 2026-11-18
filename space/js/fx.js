// Exhaust smoke, steam and condensation as camera-facing instanced quads.
// Particles age in wall-clock time so trails survive time-warp; colour is lit
// by the real sun, including the high-altitude "twilight plume" case where the
// trail is in sunlight while the ground is dark.
import * as THREE from 'three';

const VS = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec3 iPos; attribute vec4 iData;
  uniform vec3 uFlamePos; uniform float uFlameI;
  varying vec2 vUv; varying float vA, vHeat, vY, vFlame;
  void main(){
    vUv = uv; vA = iData.y; vHeat = iData.z; vY = iPos.y;
    float d = distance(iPos, uFlamePos);
    vFlame = uFlameI / (1. + d*d/(140.*140.));
    vec4 mv = viewMatrix * vec4(iPos, 1.);
    float c = cos(iData.w), s = sin(iData.w);
    mv.xy += mat2(c, -s, s, c) * position.xy * iData.x;
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
  }`;
const FS = `
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D map; uniform float uSunAlt, uPadElev; uniform vec3 uLit, uShade, uHeatCol;
  varying vec2 vUv; varying float vA, vHeat, vY, vFlame;
  void main(){
    #include <logdepthbuf_fragment>
    vec4 t = texture2D(map, vUv);
    float hKm = max(vY + uPadElev, 0.) / 1000.;
    float dip = -degrees(sqrt(2. * hKm / 6371.));
    float lit = smoothstep(dip - 1.2, dip + 2.5, uSunAlt);
    vec3 col = mix(uShade, uLit, lit) * (.72 + .28 * t.r);
    col += uHeatCol * (vHeat * 2.2 + vFlame * 1.4);
    float a = t.a * vA;
    gl_FragColor = vec4(col * a, a);
  }`;

function smokeTexture() {
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d');
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * S * .22;
    const x = S / 2 + Math.cos(a) * r, y = S / 2 + Math.sin(a) * r, rad = S * (.16 + Math.random() * .2);
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    const b = 200 + Math.random() * 55 | 0;
    gr.addColorStop(0, `rgba(${b},${b},${b},.22)`); gr.addColorStop(1, `rgba(${b},${b},${b},0)`);
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
  }
  // round mask
  g.globalCompositeOperation = 'destination-in';
  const m = g.createRadialGradient(S / 2, S / 2, S * .1, S / 2, S / 2, S / 2);
  m.addColorStop(0, 'rgba(0,0,0,1)'); m.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = m; g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export class Smoke {
  constructor(max = 5200) {
    this.max = max; this.n = 0;
    this.p = new Float32Array(max * 3); this.v = new Float32Array(max * 3);
    this.age = new Float32Array(max); this.life = new Float32Array(max);
    this.s0 = new Float32Array(max); this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max); this.heat = new Float32Array(max); this.rot = new Float32Array(max); this.drag = new Float32Array(max);
    this.order = new Uint32Array(max); this.depth = new Float32Array(max);
    this.wind = new THREE.Vector3();
    const q = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = q.index; geo.attributes.position = q.attributes.position; geo.attributes.uv = q.attributes.uv;
    this.iPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.iData = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.iPos); geo.setAttribute('iData', this.iData);
    geo.instanceCount = 0;
    this.uniforms = {
      map: { value: smokeTexture() }, uSunAlt: { value: 30 }, uPadElev: { value: 0 },
      uLit: { value: new THREE.Color(1, 1, 1) }, uShade: { value: new THREE.Color(.3, .32, .36) }, uHeatCol: { value: new THREE.Color(1, .45, .15) },
      uFlamePos: { value: new THREE.Vector3() }, uFlameI: { value: 0 },
    };
    this.mesh = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      vertexShader: VS, fragmentShader: FS, uniforms: this.uniforms, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 6;
    this.geo = geo;
  }
  clear() { this.n = 0; this.geo.instanceCount = 0; }
  emit(px, py, pz, vx, vy, vz, { life = 10, s0 = 5, s1 = 30, alpha = .6, heat = 0, drag = .5 } = {}) {
    if (this.n >= this.max) { // recycle the oldest-looking slot
      const i = Math.random() * this.max | 0; this._kill(i);
    }
    const i = this.n++, j = i * 3;
    this.p[j] = px; this.p[j + 1] = py; this.p[j + 2] = pz;
    this.v[j] = vx; this.v[j + 1] = vy; this.v[j + 2] = vz;
    this.age[i] = 0; this.life[i] = life * (.75 + Math.random() * .5);
    this.s0[i] = s0; this.s1[i] = s1; this.a0[i] = alpha; this.heat[i] = heat; this.rot[i] = Math.random() * 6.28; this.drag[i] = drag;
  }
  _kill(i) {
    const last = --this.n;
    if (i === last) return;
    const j = i * 3, k = last * 3;
    for (let c = 0; c < 3; c++) { this.p[j + c] = this.p[k + c]; this.v[j + c] = this.v[k + c]; }
    for (const arr of [this.age, this.life, this.s0, this.s1, this.a0, this.heat, this.rot, this.drag]) arr[i] = arr[last];
  }
  update(dt, camera, groundY = 0) {
    const w = this.wind;
    for (let i = this.n - 1; i >= 0; i--) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) { this._kill(i); continue; }
      const j = i * 3, dr = Math.exp(-this.drag[i] * dt), wr = 1 - Math.exp(-dt * .35);
      const low = this.p[j + 1] < 30000 ? 1 : 0;
      this.v[j] = this.v[j] * dr + (w.x - this.v[j]) * wr * low;
      this.v[j + 2] = this.v[j + 2] * dr + (w.z - this.v[j + 2]) * wr * low;
      this.v[j + 1] = this.v[j + 1] * dr + .6 * dt * low;
      this.p[j] += this.v[j] * dt; this.p[j + 1] += this.v[j + 1] * dt; this.p[j + 2] += this.v[j + 2] * dt;
      if (this.p[j + 1] < groundY + this.s0[i] * .3) { this.p[j + 1] = groundY + this.s0[i] * .3; this.v[j + 1] = Math.abs(this.v[j + 1]) * .2; }
      this.rot[i] += dt * .05;
    }
    // back-to-front
    const cp = camera.position, cd = new THREE.Vector3(); camera.getWorldDirection(cd);
    for (let i = 0; i < this.n; i++) {
      const j = i * 3;
      this.depth[i] = (this.p[j] - cp.x) * cd.x + (this.p[j + 1] - cp.y) * cd.y + (this.p[j + 2] - cp.z) * cd.z;
      this.order[i] = i;
    }
    const ord = this.order.subarray(0, this.n), dep = this.depth;
    ord.sort((a, b) => dep[b] - dep[a]);
    const P = this.iPos.array, D = this.iData.array;
    for (let k = 0; k < this.n; k++) {
      const i = ord[k], j = i * 3, f = this.age[i] / this.life[i];
      P[k * 3] = this.p[j]; P[k * 3 + 1] = this.p[j + 1]; P[k * 3 + 2] = this.p[j + 2];
      D[k * 4] = this.s0[i] + (this.s1[i] - this.s0[i]) * (1 - Math.exp(-f * 3.2));
      D[k * 4 + 1] = this.a0[i] * Math.min(1, this.age[i] * 6) * Math.pow(1 - f, 1.6);
      D[k * 4 + 2] = this.heat[i] * Math.exp(-this.age[i] * 2.5);
      D[k * 4 + 3] = this.rot[i];
    }
    this.geo.instanceCount = this.n;
    this.iPos.needsUpdate = this.iData.needsUpdate = true;
    this.iPos.addUpdateRange?.(0, this.n * 3); this.iData.addUpdateRange?.(0, this.n * 4);
  }
}
