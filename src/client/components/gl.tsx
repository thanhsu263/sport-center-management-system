import { Color, Mesh, Program, Renderer, Triangle } from "ogl";
import { useEffect, useRef } from "react";

/**
 * Live shader backdrops.
 *
 * This module is imported lazily by `GLBackground` in `./fx` and must never be
 * pulled into the main bundle — `ogl` plus these programs is dead weight on a
 * page whose job is to show someone a court at 19:00.
 *
 * House rules for everything in here:
 *   • DPR is capped at 1.5. A retina phone rendering a full-screen fragment
 *     shader at dpr 3 is the fastest way to turn a nice background into a
 *     stutter.
 *   • The loop stops when the tab is hidden.
 *   • Colours come in from the caller so the shaders stay inside Arena3's
 *     green/sand palette instead of the usual shader-demo neon.
 */

/** Cap on device pixel ratio for every canvas here. */
const MAX_DPR = 1.5;

const VERT = /* glsl */ `
  attribute vec2 uv;
  attribute vec2 position;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

/** Ashima 2D simplex noise — shared by the shaders below. */
const SNOISE = /* glsl */ `
  vec3 permute(vec3 x) { return mod(((x * 34.0) + 1.0) * x, 289.0); }
  float snoise(vec2 v) {
    const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                        -0.577350269189626, 0.024390243902439);
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod(i, 289.0);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m; m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x  = a0.x * x0.x + h.x * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
  }
`;

type Uniforms = Record<string, { value: unknown }>;

/**
 * Shared plumbing: create a renderer on a full-bleed triangle, keep it sized to
 * the parent, drive `uTime`, and tear the WebGL context down on unmount.
 */
function useShader(fragment: string, makeUniforms: () => Uniforms, deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;

    const renderer = new Renderer({
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      dpr: Math.min(window.devicePixelRatio || 1, MAX_DPR),
    });
    const gl = renderer.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.canvas.style.width = "100%";
    gl.canvas.style.height = "100%";
    gl.canvas.style.display = "block";
    host.appendChild(gl.canvas);

    const uniforms: Uniforms = {
      uTime: { value: 0 },
      uResolution: { value: [1, 1] },
      ...makeUniforms(),
    };

    const program = new Program(gl, { vertex: VERT, fragment, uniforms, transparent: true });
    const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });

    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h);
      (uniforms.uResolution!.value as number[])[0] = w;
      (uniforms.uResolution!.value as number[])[1] = h;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    let raf = 0;
    let last = performance.now();
    // Clock advances by elapsed time rather than absolute `t`, so pausing for a
    // hidden tab resumes where it stopped instead of jumping.
    let clock = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(now - last, 50) / 1000;
      last = now;
      if (document.hidden) return;
      clock += dt;
      uniforms.uTime!.value = clock;
      renderer.render({ scene: mesh });
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      gl.canvas.remove();
      // Free the context immediately; browsers cap the number of live ones and
      // navigating around the app can otherwise strand several.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}

const shell = "absolute inset-0 size-full";

/* ── Aurora ──────────────────────────────────────────────────────── */

const AURORA_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uAmplitude;
  uniform float uSpeed;
  uniform float uOpacity;
  uniform vec3 uColor0;
  uniform vec3 uColor1;
  uniform vec3 uColor2;
  ${SNOISE}

  void main() {
    vec2 uv = vUv;
    float t = uTime * uSpeed;

    // Two noise octaves give the curtain a ragged edge; one alone reads as a
    // sine wave, which immediately looks like a screensaver.
    float n = snoise(vec2(uv.x * 2.1 + t * 0.10, t * 0.16)) * 0.55
            + snoise(vec2(uv.x * 5.3 - t * 0.07, t * 0.11)) * 0.25;

    float y = 1.0 - uv.y;                       // distance down from the top edge
    float height = 0.30 + uAmplitude * (n * 0.5 + 0.5) * 0.55;

    // Brightest partway down the curtain, fading to nothing at both edges.
    float curtain = smoothstep(height, height * 0.15, y) * smoothstep(0.0, height * 0.45, y);

    // Vertical striations travelling sideways.
    float streak = 0.72 + 0.28 * (snoise(vec2(uv.x * 14.0 - t * 0.5, uv.y * 2.0 + t * 0.2)) * 0.5 + 0.5);

    vec3 col = uv.x < 0.5
      ? mix(uColor0, uColor1, uv.x * 2.0)
      : mix(uColor1, uColor2, (uv.x - 0.5) * 2.0);

    float a = curtain * streak * uOpacity;
    // Premultiplied: the renderer is created with premultipliedAlpha so the
    // curtain adds light to whatever sits behind it instead of muddying it.
    gl_FragColor = vec4(col * a, a);
  }
`;

/** Hanging curtain of light along the top edge of its container. */
export function Aurora({
  colors = ["#3f7d20", "#8bc34a", "#b5e04a"],
  amplitude = 1,
  speed = 1,
  opacity = 0.7,
}: {
  colors?: string[];
  amplitude?: number;
  speed?: number;
  opacity?: number;
}) {
  const key = colors.join(",");
  const ref = useShader(
    AURORA_FRAG,
    () => ({
      uAmplitude: { value: amplitude },
      uSpeed: { value: speed },
      uOpacity: { value: opacity },
      uColor0: { value: new Color(colors[0] ?? "#3f7d20") },
      uColor1: { value: new Color(colors[1] ?? "#8bc34a") },
      uColor2: { value: new Color(colors[2] ?? "#b5e04a") },
    }),
    [key, amplitude, speed, opacity],
  );
  return <div ref={ref} className={shell} />;
}

/* ── Silk ────────────────────────────────────────────────────────── */

const SILK_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uSpeed;
  uniform float uScale;
  uniform float uOpacity;
  uniform vec3 uColor;

  float rand(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec2 uv = vUv * uScale;
    float t = uTime * uSpeed;

    // Interfering sine fields at slightly different frequencies — the moiré
    // between them is what makes the surface read as folded cloth.
    float a = sin(5.0 * (uv.x + uv.y + cos(3.0 * uv.x + 5.0 * uv.y) + 0.02 * t))
            + sin(20.0 * (uv.x + uv.y - 0.10 * t)) * 0.5;
    float pattern = 0.5 + 0.5 * sin(a + t * 0.25);

    // A little noise breaks up the banding that 8-bit output gives smooth ramps.
    pattern += (rand(vUv + fract(t)) - 0.5) * 0.035;
    pattern = clamp(pattern, 0.0, 1.0);

    float alpha = pattern * uOpacity;
    gl_FragColor = vec4(uColor * alpha, alpha);
  }
`;

/** Slow folded-cloth sheen. Calmer than Aurora; good behind long-form panels. */
export function Silk({
  color = "#3f7d20",
  speed = 1,
  scale = 1.4,
  opacity = 0.32,
}: {
  color?: string;
  speed?: number;
  scale?: number;
  opacity?: number;
}) {
  const ref = useShader(
    SILK_FRAG,
    () => ({
      uSpeed: { value: speed },
      uScale: { value: scale },
      uOpacity: { value: opacity },
      uColor: { value: new Color(color) },
    }),
    [color, speed, scale, opacity],
  );
  return <div ref={ref} className={shell} />;
}

/* ── Threads ─────────────────────────────────────────────────────── */

const THREADS_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uAmplitude;
  uniform float uSpeed;
  uniform float uOpacity;
  uniform vec2 uResolution;
  uniform vec3 uColor;

  const int LINES = 28;

  void main() {
    vec2 uv = vUv;
    // Correct for aspect so a thread is the same visual thickness on a wide
    // banner and a tall phone panel.
    float aspect = max(uResolution.x / max(uResolution.y, 1.0), 0.0001);
    float t = uTime * uSpeed;
    float total = 0.0;

    for (int i = 0; i < LINES; i++) {
      float fi = float(i) / float(LINES - 1);

      // Threads bunch toward the middle of the band and thin out at the edges.
      float y = 0.5 + (fi - 0.5) * 0.82;
      float phase = fi * 7.3;
      float wave = sin(uv.x * 6.2831 * 1.15 + t * 0.85 + phase) * 0.5
                 + sin(uv.x * 6.2831 * 2.30 - t * 0.55 + phase * 1.7) * 0.28;
      y += wave * uAmplitude * 0.06 * (0.35 + 0.65 * sin(fi * 3.14159));

      float d = abs(uv.y - y) * aspect;
      // 1/d falloff rather than smoothstep: threads stay hairline-thin at the
      // core while still casting a soft halo.
      total += 0.0022 / (d + 0.0022);

      // Fade each thread in and out along its length so none of them simply
      // stop at the edge of the frame.
      total *= 1.0;
    }

    float edge = smoothstep(0.0, 0.12, uv.x) * smoothstep(1.0, 0.88, uv.x);
    float a = clamp(total / float(LINES) * 2.2, 0.0, 1.0) * uOpacity * edge;
    gl_FragColor = vec4(uColor * a, a);
  }
`;

/** Field of thin travelling filaments. Reads as motion without asking for attention. */
export function Threads({
  color = "#ffffff",
  amplitude = 1,
  speed = 1,
  opacity = 0.5,
}: {
  color?: string;
  amplitude?: number;
  speed?: number;
  opacity?: number;
}) {
  const ref = useShader(
    THREADS_FRAG,
    () => ({
      uAmplitude: { value: amplitude },
      uSpeed: { value: speed },
      uOpacity: { value: opacity },
      uColor: { value: new Color(color) },
    }),
    [color, amplitude, speed, opacity],
  );
  return <div ref={ref} className={shell} />;
}

/* ── Dot grid ────────────────────────────────────────────────────── */

/**
 * Grid of dots that light up and swell around the pointer.
 *
 * Deliberately canvas 2D, not WebGL: it is cheap enough to sit behind the
 * signed-in app, and unlike a shader it costs nothing when the pointer is still
 * — the loop parks itself once the ripple has settled.
 */
export function DotGrid({
  color = "#3f7d20",
  gap = 26,
  dot = 1.8,
  radius = 150,
  opacity = 0.5,
}: {
  color?: string;
  /** px between dot centres. */
  gap?: number;
  /** Resting dot radius in px. */
  dot?: number;
  /** Pointer influence radius in px. */
  radius?: number;
  opacity?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!host || !canvas || !ctx) return;

    let w = 0;
    let h = 0;
    const pointer = { x: -9999, y: -9999 };
    // Eased pointer position; the loop runs until this catches up, then stops.
    const eased = { x: -9999, y: -9999 };
    let raf = 0;
    let idle = true;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = host.clientWidth;
      h = host.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      const cols = Math.ceil(w / gap) + 1;
      const rows = Math.ceil(h / gap) + 1;
      for (let cx = 0; cx < cols; cx++) {
        for (let cy = 0; cy < rows; cy++) {
          const px = cx * gap;
          const py = cy * gap;
          const d = Math.hypot(px - eased.x, py - eased.y);
          const near = d < radius ? 1 - d / radius : 0;
          // Ease the falloff so the lit area has a soft shoulder rather than a
          // visible circular boundary.
          const f = near * near;
          ctx.globalAlpha = opacity * (0.28 + 0.72 * f);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(px, py, dot * (1 + f * 1.5), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    };

    const loop = () => {
      const dx = pointer.x - eased.x;
      const dy = pointer.y - eased.y;
      eased.x += dx * 0.16;
      eased.y += dy * 0.16;
      draw();
      if (Math.abs(dx) < 0.4 && Math.abs(dy) < 0.4) {
        raf = 0;
        idle = true;
        return;
      }
      raf = requestAnimationFrame(loop);
    };

    const kick = () => {
      idle = false;
      if (!raf) raf = requestAnimationFrame(loop);
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const r = host.getBoundingClientRect();
      pointer.x = e.clientX - r.left;
      pointer.y = e.clientY - r.top;
      if (idle) kick();
      else if (!raf) raf = requestAnimationFrame(loop);
    };
    const onLeave = () => {
      pointer.x = -9999;
      pointer.y = -9999;
      kick();
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
    };
  }, [color, gap, dot, radius, opacity]);

  return (
    <div ref={hostRef} className={shell}>
      <canvas ref={canvasRef} className="block size-full" />
    </div>
  );
}
