/**
 * The raw WebGL2 half of the landing's 3D scene: procedural shuttlecock, ball and racket meshes,
 * their shaders, and a small context wrapper that survives context loss.
 *
 * This is deliberately not `ogl`. The scene needs a depth buffer, indexed meshes, derivatives
 * (`dFdx`, for the anisotropic feather sheen) and `#version 300 es`, none of which the full-screen
 * triangle helper in `gl.tsx` offers. No GSAP here: this file only knows how to draw. The poses and
 * the scroll story live in `shuttle3d-scene.ts` and `shuttle3d.tsx`.
 */

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

// ── Shaders ────────────────────────────────────────────────────────────────

const MESH_VS = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNor; layout(location=2) in vec2 aUv; layout(location=3) in float aMat;
uniform mat4 uP; uniform mat4 uMV; uniform vec2 uShift; uniform float uSport;
out vec3 vN; out vec3 vP; out vec2 vUv; flat out int vMat;
void main(){
  vec3 pos = aPos;
  if (aMat > 2.5 && aMat < 3.5) {
    float u = aUv.x, v = aUv.y, s = clamp(uSport, 0.0, 1.0);
    float band = abs(fract(v * 3.0) - 0.5);
    float bulge = smoothstep(0.05, 0.46, band);
    float mer = min(min(abs(u), abs(u - 1.0)), abs(u - 0.5));
    float groove = max(1.0 - smoothstep(0.0, 0.028, abs(v - 0.5)), 1.0 - smoothstep(0.0, 0.02, mer));
    vec3 round = aPos * (1.0 - groove * 0.045);
    round.y *= 0.96;
    vec3 panel = aPos * (1.0 + bulge * 0.08);
    pos = mix(round, panel, s);
  }
  vec4 p = uMV * vec4(pos, 1.0);
  vP = p.xyz; vN = mat3(uMV) * aNor; vUv = aUv; vMat = int(aMat + 0.5);
  vec4 c = uP * p; c.xy += uShift * c.w; gl_Position = c;
}`;

const MESH_FS = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vP; in vec2 vUv; flat in int vMat;
uniform float uGlow; uniform float uAlpha; uniform float uTime; uniform float uSport; uniform int uPass;
out vec4 o;
const vec3 LIME = vec3(0.831, 0.961, 0.235);
const vec3 CLAY = vec3(0.816, 0.408, 0.247);
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float grain(vec2 p){
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main(){
  if (uPass == 0 && vMat == 2) discard;
  if (uPass == 1 && vMat != 2) discard;
  vec3 V = normalize(-vP);
  vec3 N = normalize(vN); if (dot(N, V) < 0.0) N = -N;
  vec3 alb; float spk; float trans = 0.0; float alpha = 1.0;
  if (vMat == 0) {
    float g = grain(vUv * vec2(28.0, 16.0));
    float pores = smoothstep(0.72, 0.94, grain(vUv * vec2(74.0, 38.0)));
    alb = vec3(0.90, 0.81, 0.66) * (0.82 + 0.22 * g);
    alb = mix(alb, vec3(0.50, 0.36, 0.24), pores * 0.28);
    alb *= mix(0.78, 1.0, smoothstep(0.0, 0.22, vUv.y));
    spk = 0.55;
  } else if (vMat == 1) {
    alb = vec3(0.09, 0.12, 0.11); spk = 0.78;
  } else if (vMat == 3) {
    float u = vUv.x, v = vUv.y, s = clamp(uSport, 0.0, 1.0);
    float seamW = 0.007;
    float mer = min(min(abs(u), abs(u - 1.0)), abs(u - 0.5));
    float c1 = abs(fract(u + 0.16 * sin((v - 0.5) * 6.28318)) - 0.25);
    float c2 = abs(fract(u + 0.5 + 0.16 * sin((v - 0.5) * 6.28318)) - 0.25);
    float bSeam = max(max(1.0 - smoothstep(seamW, 0.02, abs(v - 0.5)), 1.0 - smoothstep(seamW, 0.018, mer)), max(1.0 - smoothstep(seamW, 0.02, c1), 1.0 - smoothstep(seamW, 0.02, c2)));
    float g = grain(vUv * vec2(36.0, 20.0));
    float peb = grain(vUv * vec2(110.0, 64.0));
    vec3 basket = CLAY * (0.62 + 0.34 * g) * (0.82 + 0.22 * smoothstep(0.3, 0.75, peb));
    basket = mix(basket, vec3(0.07, 0.06, 0.05), clamp(bSeam, 0.0, 1.0));
    float boundary = min(fract(v * 3.0 + 0.08 * sin(u * 6.28318)), 1.0 - fract(v * 3.0 + 0.08 * sin(u * 6.28318)));
    float vSeam = 1.0 - smoothstep(0.012, 0.04, boundary);
    float stripe = smoothstep(0.35, 0.65, fract(v * 1.5 + 0.04 * sin(u * 6.28318)));
    vec3 volley = mix(vec3(0.95, 0.96, 0.93), vec3(0.80, 0.86, 0.95), stripe * 0.55);
    float wedge = smoothstep(0.12, 0.0, abs(u - 0.18)) * smoothstep(0.22, 0.42, v) * smoothstep(0.78, 0.58, v);
    volley = mix(volley, LIME, wedge * 0.9 * (1.0 - vSeam));
    volley = mix(volley, vec3(0.09, 0.12, 0.11), clamp(vSeam, 0.0, 1.0));
    alb = mix(basket, volley, s);
    spk = mix(0.32, 0.7, s);
  } else if (vMat == 4) {
    alb = vec3(0.10, 0.13, 0.12);
    float lip = smoothstep(0.8, 0.98, vUv.x);
    alb = mix(alb, LIME, lip * 0.92);
    spk = mix(0.84, 0.32, lip);
  } else if (vMat == 5) {
    alb = vec3(0.94, 0.96, 0.91);
    spk = 0.62;
  } else if (vMat == 6) {
    float band = smoothstep(0.38, 0.62, fract(vUv.y * 16.0));
    alb = mix(CLAY * 0.92, vec3(0.12, 0.10, 0.09), band);
    spk = 0.16;
  } else if (vMat == 7) {
    float g = grain(vUv * vec2(20.0, 12.0));
    float pore = smoothstep(0.8, 0.97, grain(vUv * vec2(80.0, 46.0)));
    alb = mix(vec3(0.62, 0.38, 0.28), vec3(0.90, 0.66, 0.50), g);
    alb = mix(alb, alb * 0.62, pore * 0.45);
    float joint = smoothstep(0.1, 0.0, vUv.y);
    alb = mix(alb, alb * vec3(0.7, 0.55, 0.48), joint * 0.45);
    alb += vec3(0.1, 0.05, 0.03) * smoothstep(0.05, 0.75, N.z);
    alb += vec3(0.16, 0.08, 0.05) * pow(1.0 - max(dot(N, V), 0.0), 2.2) * 0.35;
    spk = 0.38;
  } else if (vMat == 8) {
    alb = vec3(0.96, 0.94, 0.88);
    spk = 0.74;
  } else {
    float barb = 0.5 + 0.5 * sin(vUv.y * 170.0 - abs(vUv.x) * 40.0);
    float shaft = 1.0 - smoothstep(0.0, 0.065, abs(vUv.x));
    float edge = smoothstep(0.2, 0.96, abs(vUv.x));
    float tip = smoothstep(0.7, 1.0, vUv.y);
    alb = vec3(0.97, 0.98, 0.95) * (0.84 + 0.18 * barb);
    alb = mix(alb, vec3(0.68, 0.73, 0.67), shaft * smoothstep(0.06, 0.32, vUv.y) * 0.75);
    alb *= mix(0.75, 1.0, smoothstep(0.0, 0.28, vUv.y));
    alb = mix(alb, vec3(0.99, 1.0, 0.97), tip * 0.4);
    spk = 0.4; trans = 0.72;
    alpha = max(mix(0.96, 0.34, edge) * mix(1.0, 0.55, tip), shaft * 0.9);
  }
  vec3 Lk = normalize(vec3(-0.32, 0.86, 0.58));
  vec3 Lf = normalize(vec3(-0.82, -0.2, 0.42));
  vec3 Lr = normalize(vec3(0.82, 0.12, -0.52));
  vec3 Lu = normalize(vec3(0.1, 0.96, 0.22));
  float dk = max(dot(N, Lk), 0.0);
  float df = max(dot(N, Lf), 0.0);
  float du = max(dot(N, Lu), 0.0);
  float back = max(dot(-N, Lk), 0.0);
  vec3 col = alb * (0.06 + dk * 0.74 + du * 0.28) + alb * CLAY * df * 0.5;
  col += vec3(1.0, 0.97, 0.88) * trans * back * 0.85;
  col += LIME * trans * back * (0.2 + 0.45 * uGlow);
  vec3 H = normalize(Lk + V);
  col += vec3(1.0, 0.98, 0.9) * pow(max(dot(N, H), 0.0), 16.0) * spk * 0.4;
  col += vec3(1.0) * pow(max(dot(N, H), 0.0), 80.0) * spk;
  if (vMat == 2) {
    vec3 dP = dFdx(vP) * dFdx(vUv.y) + dFdy(vP) * dFdy(vUv.y);
    float tl = length(dP);
    vec3 T = tl > 1e-4 ? dP / tl : vec3(0.0, 1.0, 0.0);
    float TdH = clamp(dot(T, H), -1.0, 1.0);
    float aniso = pow(max(1.0 - TdH * TdH, 0.0), 20.0);
    float sweep = 0.8 + 0.2 * sin(vUv.y * 11.0 - uTime * 0.65);
    col += vec3(1.0, 0.99, 0.94) * aniso * 0.7 * sweep;
    vec3 Bx = cross(N, T); float bl = length(Bx);
    vec3 B = bl > 1e-4 ? Bx / bl : vec3(1.0, 0.0, 0.0);
    float BdH = clamp(dot(B, H), -1.0, 1.0);
    col += LIME * pow(max(1.0 - BdH * BdH, 0.0), 46.0) * 0.28 * (0.4 + uGlow);
  }
  float fr = pow(1.0 - max(dot(N, V), 0.0), 2.0);
  col += LIME * fr * max(dot(N, Lr) + 0.45, 0.0) * (0.9 + 0.85 * uGlow);
  vec3 R = reflect(-V, N);
  float envUp = smoothstep(-0.2, 0.8, R.y);
  float envLime = smoothstep(0.1, 0.85, R.x) * smoothstep(0.5, -0.25, R.y);
  vec3 env = mix(vec3(0.04, 0.06, 0.05), vec3(0.62, 0.68, 0.58), envUp);
  env += LIME * envLime * 0.85;
  col += env * (0.06 + spk * 0.34) * (0.3 + fr);
  if (uPass == 3) col = mix(col, col * vec3(0.55, 0.78, 0.5) + LIME * 0.16, 0.62);
  if (uPass == 4) col = mix(col, vec3(0.86, 0.95, 0.55), 0.55);
  float a = alpha * uAlpha;
  col = clamp(col, 0.0, 1.0);
  o = vec4(col * a, a);
}`;

const SHADOW_VS = `#version 300 es
layout(location=0) in vec2 aQ;
uniform mat4 uP; uniform mat4 uMV; uniform vec2 uShift;
out vec2 vQ;
void main(){ vQ = aQ; vec4 c = uP * (uMV * vec4(aQ.x, 0.0, aQ.y, 1.0)); c.xy += uShift * c.w; gl_Position = c; }`;

const SHADOW_FS = `#version 300 es
precision mediump float;
in vec2 vQ; uniform float uA; out vec4 o;
void main(){ float r = length(vQ); float a = uA * exp(-r * r * 3.0) * (1.0 - smoothstep(0.7, 1.0, r)); o = vec4(0.0, 0.0, 0.0, a); }`;

// Impact ring and flash (mode 0) and floor dust ring (mode 1), premultiplied.
const FX_FS = `#version 300 es
precision mediump float;
in vec2 vQ; uniform float uA; uniform float uK; uniform int uMode; out vec4 o;
const vec3 LIME = vec3(0.831, 0.961, 0.235);
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  float r = length(vQ), k = clamp(uK, 0.0, 1.0), ang = atan(vQ.y, vQ.x), a; vec3 col;
  if (uMode == 0) {
    float e = 1.0 - (1.0 - k) * (1.0 - k) * (1.0 - k);
    float rr = mix(0.12, 0.92, e), w = mix(0.13, 0.025, k), d = (r - rr) / w;
    float ring = exp(-d * d) * (1.0 - k);
    float core = exp(-r * r * 22.0) * (1.0 - k) * (1.0 - k);
    float rays = pow(abs(cos(ang * 2.0)), 24.0) * exp(-r * 3.5) * (1.0 - k) * (1.0 - k) * 0.6;
    a = clamp(ring + core + rays, 0.0, 1.0) * uA * (1.0 - smoothstep(0.92, 1.0, r));
    col = mix(LIME, vec3(1.0), clamp(core * 1.4, 0.0, 1.0));
  } else {
    float e = 1.0 - (1.0 - k) * (1.0 - k);
    float rr = mix(0.3, 0.9, e), w = mix(0.1, 0.18, k), d = (r - rr) / w;
    vec2 cell = vec2(floor((ang + 3.1416) * 4.0), floor(r * 12.0));
    float puff = 0.55 + 0.45 * sin(ang * 9.0 + hash(cell) * 6.28) * hash(cell + 3.0);
    a = exp(-d * d) * puff * (1.0 - k) * (1.0 - smoothstep(0.85, 1.0, r)) * uA * 0.7;
    col = vec3(0.80, 0.74, 0.64);
  }
  o = vec4(col * a, a);
}`;

function glProgram(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      console.warn("Shuttle shader:", gl.getShaderInfoLog(s));
      throw new Error("shader");
    }
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
    console.warn("Shuttle program:", gl.getProgramInfoLog(p));
    throw new Error("link");
  }
  return p;
}

// ── Geometry ───────────────────────────────────────────────────────────────

type Geo = { v: Float32Array; i: Uint16Array };

/** Model units: cork centre at the origin, axis +Y, feather tips at y = 1.98. */
function shuttleGeometry(): Geo {
  const V: number[] = [];
  const I: number[] = [];
  const vert = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, m: number) => {
    V.push(x, y, z, nx, ny, nz, u, v, m);
    return V.length / 9 - 1;
  };
  const grid = (rows: number, cols: number, fn: (i: number, j: number) => number) => {
    const idx: number[][] = [];
    for (let i = 0; i < rows; i++) {
      idx.push([]);
      for (let j = 0; j < cols; j++) idx[i].push(fn(i, j));
    }
    for (let i = 0; i < rows - 1; i++)
      for (let j = 0; j < cols - 1; j++) {
        const a = idx[i][j], b = idx[i + 1][j], c = idx[i + 1][j + 1], d = idx[i][j + 1];
        I.push(a, b, c, a, c, d);
      }
  };
  const lathe = (prof: number[][], m: number, seg: number) => {
    grid(prof.length, seg + 1, (i, j) => {
      const a = (j / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a), p = prof[i];
      return vert(p[0] * c, p[1], p[0] * s, p[2] * c, p[3], p[2] * s, j / seg, i / (prof.length - 1), m);
    });
  };
  const torus = (R: number, y: number, r: number, m: number) => {
    grid(13, 65, (i, j) => {
      const a = (i / 12) * Math.PI * 2, b = (j / 64) * Math.PI * 2, nr = Math.cos(a), ny = Math.sin(a), rr = R + r * nr;
      return vert(rr * Math.cos(b), y + r * ny, rr * Math.sin(b), nr * Math.cos(b), ny, nr * Math.sin(b), j / 64, i / 12, m);
    });
  };
  const sstep = (a: number, b: number, x: number) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };

  // Cork head: sphere cap from the bottom pole up to the collar.
  const cork: number[][] = [];
  for (let i = 0; i <= 24; i++) {
    const f = -Math.PI / 2 + ((Math.PI / 2 + 0.25) * i) / 24;
    cork.push([0.42 * Math.cos(f), 0.42 * Math.sin(f), Math.cos(f), Math.sin(f)]);
  }
  lathe(cork, 0, 64);
  // Collar band: bottom lip, side, top cap.
  lathe([[0.405, 0.06, 0, -1], [0.43, 0.06, 0, -1]], 1, 64);
  lathe([[0.43, 0.06, 1, 0], [0.43, 0.30, 1, 0]], 1, 64);
  lathe([[0.43, 0.30, 0, 1], [0.0, 0.30, 0, 1]], 1, 64);

  // 16 feather blades on a cone, twisted so they shingle. Slight flare per blade.
  const R0 = 0.30, Y0 = 0.22, R1 = 1.08, Y1 = 2.08, ROWS = 32, COLS = 9, WM = 0.28, TW = 0.36;
  for (let k = 0; k < 16; k++) {
    const flare = 1 + 0.05 * Math.sin(k * 1.7);
    const R1k = R1 * flare, Y1k = Y1 * (1 + 0.028 * Math.cos(k * 2.2));
    const tw = TW + 0.05 * Math.sin(k * 0.9);
    const th = (k / 16) * Math.PI * 2, cr = Math.cos(th), sr = Math.sin(th);
    const tx = -sr * Math.cos(tw) + cr * Math.sin(tw), tz = cr * Math.cos(tw) + sr * Math.sin(tw);
    const sx = (R1k - R0) * cr, sy = Y1k - Y0, sz = (R1k - R0) * sr;
    let nx = -tz * sy, ny = tz * sx - tx * sz, nz = tx * sy;
    const nl = Math.hypot(nx, ny, nz);
    nx /= nl; ny /= nl; nz /= nl;
    if (nx * cr + nz * sr < 0) { nx = -nx; ny = -ny; nz = -nz; }
    grid(ROWS, COLS, (i, j) => {
      const t = i / (ROWS - 1), u = (j / (COLS - 1)) * 2 - 1;
      let hw = 0.012 + WM * sstep(0.12, 0.5, t);
      if (t > 0.84) { const q = (t - 0.84) / 0.16; hw *= Math.sqrt(Math.max(0, 1 - q * q)); }
      const r = R0 + (R1k - R0) * t, y = Y0 + (Y1k - Y0) * t, cup = (1 - u * u) * 0.034 * sstep(0.15, 0.55, t);
      const px = r * cr + tx * u * hw + nx * cup, py = y + ny * cup, pz = r * sr + tz * u * hw + nz * cup;
      const mx = nx + tx * u * 0.45, my = ny, mz = nz + tz * u * 0.45, ml = Math.hypot(mx, my, mz);
      return vert(px, py, pz, mx / ml, my / ml, mz / ml, u, t, 2);
    });
  }
  // Skirt rings (thread binding).
  torus(R0 + (R1 - R0) * 0.44 + 0.06, Y0 + (Y1 - Y0) * 0.44, 0.022, 1);
  torus(R0 + (R1 - R0) * 0.64 + 0.06, Y0 + (Y1 - Y0) * 0.64, 0.02, 1);
  return { v: new Float32Array(V), i: new Uint16Array(I) };
}

/** Unit ball. `uSport` bends it from a seamed basketball into a paneled volleyball. */
function ballGeometry(): Geo {
  const V: number[] = [];
  const I: number[] = [];
  const stacks = 28, slices = 40, R = 1.08;
  for (let i = 0; i <= stacks; i++) {
    const v = i / stacks, phi = v * Math.PI, sp = Math.sin(phi), cp = Math.cos(phi);
    for (let j = 0; j <= slices; j++) {
      const u = j / slices, th = u * Math.PI * 2;
      V.push(R * sp * Math.cos(th), R * cp, R * sp * Math.sin(th), sp * Math.cos(th), cp, sp * Math.sin(th), u, v, 3);
    }
  }
  const row = slices + 1;
  for (let i = 0; i < stacks; i++)
    for (let j = 0; j < slices; j++) {
      const a = i * row + j;
      I.push(a, a + row, a + row + 1, a, a + row + 1, a + 1);
    }
  return { v: new Float32Array(V), i: new Uint16Array(I) };
}

/** Where the racket's string bed sits, in racket model units (grip point at the origin). */
export const RK = { headY: 3.85, Rx: 0.8, Ry: 1.25, rad: 0.05 };

/** Badminton racket. Mats: 4 frame and shaft, 5 strings, 6 grip wrap, 1 dark fittings. */
function racketGeometry(): Geo {
  const V: number[] = [];
  const I: number[] = [];
  const vert = (x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number, m: number) => {
    const l = Math.hypot(nx, ny, nz) || 1;
    V.push(x, y, z, nx / l, ny / l, nz / l, u, v, m);
    return V.length / 9 - 1;
  };
  const quad = (a: number, b: number, c: number, d: number) => I.push(a, b, c, a, c, d);
  // Straight tube in the XY plane. rf(v, ang) gives the radius; vs scales the wrap bands of the grip shader.
  const tube = (x0: number, y0: number, x1: number, y1: number, rf: (v: number, ang: number) => number, m: number, rings: number, seg: number, vs = 1) => {
    const dx = x1 - x0, dy = y1 - y0, dl = Math.hypot(dx, dy) || 1, qx = -dy / dl, qy = dx / dl;
    const ids: number[][] = [];
    for (let i = 0; i <= rings; i++) {
      ids.push([]);
      const v = i / rings, ox = x0 + dx * v, oy = y0 + dy * v;
      for (let j = 0; j <= seg; j++) {
        const ang = (j / seg) * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang), r = rf(v, ang);
        ids[i].push(vert(ox + qx * c * r, oy + qy * c * r, s * r, qx * c, qy * c, s, c * 0.5 + 0.5, v * vs + j / seg / 16, m));
      }
    }
    for (let i = 0; i < rings; i++) for (let j = 0; j < seg; j++) quad(ids[i][j], ids[i + 1][j], ids[i + 1][j + 1], ids[i][j + 1]);
  };
  const cap = (y: number, r: number, ny: number, m: number) => {
    const c0 = vert(0, y, 0, 0, ny, 0, 0.5, 0, m), seg = 16;
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      vert(Math.cos(a) * r, y, Math.sin(a) * r, 0, ny, 0, 0.5, 0, m);
    }
    for (let j = 0; j < seg; j++) I.push(c0, c0 + 1 + j, c0 + 2 + j);
  };
  const fixed = (r: number) => () => r;
  // Butt cap, grip with a raised helical overgrip ridge, collar, tapered shaft, T-joint and the two throat arms.
  cap(-0.62, 0.086, -1, 1);
  tube(0, -0.62, 0, -0.5, fixed(0.086), 1, 1, 16);
  tube(0, -0.5, 0, 0.78, (v, ang) => {
    const ridge = Math.pow(0.5 + 0.5 * Math.cos((v * 9 + ang / (Math.PI * 2)) * Math.PI * 2), 6);
    return 0.077 - 0.008 * v + 0.007 * ridge;
  }, 6, 54, 16, 9 / 16);
  tube(0, 0.78, 0, 0.92, (v) => 0.07 - 0.036 * v, 1, 3, 16);
  tube(0, 0.92, 0, 2.32, (v) => 0.031 - 0.006 * v, 4, 6, 12);
  tube(0, 2.26, 0, 2.44, fixed(0.046), 1, 2, 12);
  const thY = RK.headY - RK.Ry * 0.904, thX = RK.Rx * Math.sqrt(1 - 0.904 * 0.904);
  tube(0, 2.36, -thX, thY, fixed(0.033), 4, 4, 12);
  tube(0, 2.36, thX, thY, fixed(0.033), 4, 4, 12);
  // Oval frame: a torus-like tube swept round the ellipse, slightly flattened front to back. Lime runs on the outer edge.
  const N = 84, S = 12, { Rx, Ry, rad, headY: hy } = RK;
  const ring: number[][] = [];
  for (let i = 0; i <= N; i++) {
    ring.push([]);
    const t = (i / N) * Math.PI * 2, ct = Math.cos(t), st = Math.sin(t);
    const px = Rx * ct, py = hy + Ry * st;
    const tx = -Rx * st, ty = Ry * ct, tl = Math.hypot(tx, ty) || 1;
    const ox = ty / tl, oy = -tx / tl;
    for (let j = 0; j <= S; j++) {
      const a = (j / S) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      ring[i].push(vert(px + ox * ca * rad, py + oy * ca * rad, sa * rad * 0.7, ox * ca, oy * ca, sa / 0.7, ca * 0.5 + 0.5, i / N, 4));
    }
  }
  for (let i = 0; i < N; i++) for (let j = 0; j < S; j++) quad(ring[i][j], ring[i + 1][j], ring[i + 1][j + 1], ring[i][j + 1]);
  // String bed: thin flat strings, crosses just in front of the mains.
  const string = (x0: number, y0: number, x1: number, y1: number, z: number) => {
    const dx = x1 - x0, dy = y1 - y0, dl = Math.hypot(dx, dy) || 1, w = 0.011, qx = (-dy / dl) * w, qy = (dx / dl) * w;
    quad(vert(x0 + qx, y0 + qy, z, 0, 0, 1, 0, 0, 5), vert(x1 + qx, y1 + qy, z, 0, 0, 1, 1, 0, 5),
      vert(x1 - qx, y1 - qy, z, 0, 0, 1, 1, 1, 5), vert(x0 - qx, y0 - qy, z, 0, 0, 1, 0, 1, 5));
  };
  const bx = Rx - rad * 0.9, by = Ry - rad * 0.9;
  for (let n = 1; n <= 13; n++) {
    const yy = hy - by + (2 * by * n) / 14, ey = (yy - hy) / by, hx = bx * Math.sqrt(Math.max(0, 1 - ey * ey));
    string(-hx, yy, hx, yy, 0.006);
  }
  for (let n = 1; n <= 11; n++) {
    const xx = -bx + (2 * bx * n) / 12, exx = xx / bx, hh = by * Math.sqrt(Math.max(0, 1 - exx * exx));
    string(xx, hy - hh, xx, hy + hh, -0.006);
  }
  return { v: new Float32Array(V), i: new Uint16Array(I) };
}

// ── Column-major 4x4 helpers ───────────────────────────────────────────────

export type M4 = Float32Array;
const m4 = (): M4 => {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
};
const mul = (a: M4, b: M4): M4 => {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
};
export const chain = (...ms: M4[]): M4 => ms.reduce((acc, m) => mul(acc, m));
export const rx = (t: number): M4 => { const m = m4(), c = Math.cos(t), s = Math.sin(t); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; };
export const ry = (t: number): M4 => { const m = m4(), c = Math.cos(t), s = Math.sin(t); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; };
export const rz = (t: number): M4 => { const m = m4(), c = Math.cos(t), s = Math.sin(t); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; };
export const tr = (x: number, y: number, z: number): M4 => { const m = m4(); m[12] = x; m[13] = y; m[14] = z; return m; };
export const sc = (s: number): M4 => { const m = m4(); m[0] = m[5] = m[10] = s; return m; };
export const sc3 = (x: number, y: number, z: number): M4 => { const m = m4(); m[0] = x; m[5] = y; m[10] = z; return m; };
export const persp = (f: number, a: number, n: number, fr: number): M4 => {
  const m = new Float32Array(16), t = 1 / Math.tan(f / 2);
  m[0] = t / a; m[5] = t; m[10] = (fr + n) / (n - fr); m[11] = -1; m[14] = (2 * fr * n) / (n - fr);
  return m;
};

// ── The context wrapper ────────────────────────────────────────────────────

type Uniforms = Record<string, WebGLUniformLocation | null>;

export type Shuttle3D = {
  ready: boolean;
  failed: boolean;
  onRestore: (() => void) | null;
  pm: WebGLProgram; um: Uniforms;
  ps: WebGLProgram; us: Uniforms;
  pf: WebGLProgram; uf: Uniforms;
  vm: WebGLVertexArrayObject; count: number;
  bm: WebGLVertexArrayObject; bcount: number;
  rm: WebGLVertexArrayObject; rcount: number;
  vq: WebGLVertexArrayObject;
  /** Clear and size the canvas, then call `fn`. Returns false while the context is lost. */
  draw: (fn: (gl: WebGL2RenderingContext, L: Shuttle3D, cssW: number, cssH: number) => void) => boolean;
  /** Free the GPU context. */
  dispose: () => void;
};

/** True when a WebGL2 context can be made at all. Probed once, in the browser. */
let probed: boolean | null = null;
export function canShuttle3D(): boolean {
  if (typeof document === "undefined") return false;
  if (probed != null) return probed;
  try {
    const c = document.createElement("canvas");
    const g = c.getContext("webgl2");
    probed = !!g;
    g?.getExtension("WEBGL_lose_context")?.loseContext();
  } catch {
    probed = false;
  }
  return probed;
}

export function createShuttle3D(canvas: HTMLCanvasElement): Shuttle3D | null {
  let gl: WebGL2RenderingContext | null = null;
  try {
    gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: true, depth: true, stencil: false });
  } catch {
    gl = null;
  }
  if (!gl) return null;
  const g = gl;
  const L = { ready: false, failed: false, onRestore: null } as unknown as Shuttle3D;
  const geo = shuttleGeometry(), ball = ballGeometry(), racket = racketGeometry();
  const U = (p: WebGLProgram, names: string[]) => {
    const o: Uniforms = {};
    names.forEach((n) => (o[n] = g.getUniformLocation(p, n)));
    return o;
  };
  const upload = (vao: WebGLVertexArrayObject, geom: Geo) => {
    g.bindVertexArray(vao);
    g.bindBuffer(g.ARRAY_BUFFER, g.createBuffer());
    g.bufferData(g.ARRAY_BUFFER, geom.v, g.STATIC_DRAW);
    g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, g.createBuffer());
    g.bufferData(g.ELEMENT_ARRAY_BUFFER, geom.i, g.STATIC_DRAW);
    g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 3, g.FLOAT, false, 36, 0);
    g.enableVertexAttribArray(1); g.vertexAttribPointer(1, 3, g.FLOAT, false, 36, 12);
    g.enableVertexAttribArray(2); g.vertexAttribPointer(2, 2, g.FLOAT, false, 36, 24);
    g.enableVertexAttribArray(3); g.vertexAttribPointer(3, 1, g.FLOAT, false, 36, 32);
  };
  const build = () => {
    try {
      L.pm = glProgram(g, MESH_VS, MESH_FS);
      L.um = U(L.pm, ["uP", "uMV", "uShift", "uGlow", "uAlpha", "uTime", "uSport", "uPass"]);
      L.ps = glProgram(g, SHADOW_VS, SHADOW_FS);
      L.us = U(L.ps, ["uP", "uMV", "uShift", "uA"]);
      L.pf = glProgram(g, SHADOW_VS, FX_FS);
      L.uf = U(L.pf, ["uP", "uMV", "uShift", "uA", "uK", "uMode"]);
      L.vm = g.createVertexArray()!; upload(L.vm, geo); L.count = geo.i.length;
      L.bm = g.createVertexArray()!; upload(L.bm, ball); L.bcount = ball.i.length;
      L.rm = g.createVertexArray()!; upload(L.rm, racket); L.rcount = racket.i.length;
      L.vq = g.createVertexArray()!;
      g.bindVertexArray(L.vq);
      g.bindBuffer(g.ARRAY_BUFFER, g.createBuffer());
      g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), g.STATIC_DRAW);
      g.enableVertexAttribArray(0); g.vertexAttribPointer(0, 2, g.FLOAT, false, 0, 0);
      g.bindVertexArray(null);
      L.ready = !g.isContextLost();
      L.failed = false;
    } catch {
      L.ready = false;
      L.failed = true;
    }
  };
  const onLost = (e: Event) => { e.preventDefault(); L.ready = false; };
  const onRestored = () => { build(); L.onRestore?.(); };
  canvas.addEventListener("webglcontextlost", onLost, false);
  canvas.addEventListener("webglcontextrestored", onRestored, false);
  build();
  if (L.failed) {
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
    return null;
  }
  L.draw = (fn) => {
    if (!L.ready || g.isContextLost()) return false;
    // Same cap as the shaders in gl.tsx: past 1.5 the cost is real and the gain is not.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5), cw = canvas.clientWidth, ch = canvas.clientHeight;
    const w = Math.max(1, Math.round(cw * dpr)), h = Math.max(1, Math.round(ch * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    g.viewport(0, 0, w, h);
    g.clearColor(0, 0, 0, 0); g.clearDepth(1); g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT);
    fn(g, L, Math.max(1, cw), Math.max(1, ch));
    return true;
  };
  L.dispose = () => {
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
    g.getExtension("WEBGL_lose_context")?.loseContext();
  };
  return L;
}
