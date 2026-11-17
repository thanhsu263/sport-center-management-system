/**
 * Tệp này chứa các hiệu ứng nền WebGL động (live shader backdrops) sử dụng thư viện OGL.
 * Vai trò trong ứng dụng:
 * - Cung cấp các hiệu ứng nền canvas (Aurora, Silk, Threads, Court...) làm phông nền nghệ thuật cho Landing Page và các trang quản trị.
 * - Được nạp động (lazy import) qua component GLBackground trong src/client/components/fx.tsx nhằm tách OGL ra khỏi bundle chính, tối ưu tốc độ tải trang ban đầu.
 * - Đảm bảo hiệu năng trên thiết bị di động: giới hạn DPR tối đa 1.5, tự ngắt vòng lặp render khi ẩn tab và dọn dẹp WebGL context khi unmount.
 */
import { Color, Flowmap, Mesh, Program, Renderer, Texture, Triangle, Vec2 } from "ogl";
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

// Vertex shader toàn màn hình: nhận toạ độ uv và vị trí đỉnh chuẩn hoá từ Triangle, truyền toạ độ uv sang fragment shader.
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

// Kiểu dữ liệu danh sách uniforms truyền vào OGL shader, chứa tên biến và giá trị tương ứng.
type Uniforms = Record<string, { value: unknown }>;

/**
 * Shared plumbing: create a renderer on a full-bleed triangle, keep it sized to
 * the parent, drive `uTime`, and tear the WebGL context down on unmount.
 */
/**
 * Làm gì: Hook dùng chung khởi tạo WebGL renderer (OGL) trên một Triangle phủ toàn màn hình, điều khiển vòng lặp uTime, tự co giãn theo container và giải phóng GPU context khi unmount.
 * Được gọi ở: Nội bộ src/client/components/gl.tsx (các component Aurora, Silk, Threads, DotGrid, HallFlow).
 * @param fragment Chuỗi mã nguồn GLSL fragment shader để vẽ hiệu ứng.
 * @param makeUniforms Hàm khởi tạo các giá trị uniforms tùy biến cho shader.
 * @param deps Mảng dependencies kích hoạt khởi tạo lại shader khi props thay đổi.
 * @returns Ref trỏ tới phần tử HTMLDivElement chứa canvas WebGL.
 */
function useShader(fragment: string, makeUniforms: () => Uniforms, deps: unknown[]) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Bước 1: Kiểm tra container DOM (host); nếu chưa sẵn sàng thì dừng lại.
    const host = ref.current;
    if (!host) return;

    // Bước 2: Tạo thẻ canvas và khởi tạo WebGL context (ưu tiên WebGL2, fallback WebGL1).
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    // Nếu thiết bị không hỗ trợ WebGL hoặc đã cạn context, giữ nguyên fallback tĩnh mà không gây crash ứng dụng.
    if (!context) return; // Keep the media fallback when GPU rendering is unavailable.
    // Cấu hình Renderer: bật alpha để hòa trộn nền, tắt antialias để tiết kiệm GPU, giới hạn DPR tối đa 1.5 để tránh giật lag trên màn hình Retina.
    const renderer = new Renderer({
      canvas,
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      dpr: Math.min(window.devicePixelRatio || 1, MAX_DPR),
    });
    // Thiết lập canvas trong suốt để hòa trộn mượt mà với nền bên dưới và gắn vào DOM container.
    const gl = renderer.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.canvas.style.width = "100%";
    gl.canvas.style.height = "100%";
    gl.canvas.style.display = "block";
    host.appendChild(gl.canvas);

    // Bước 3: Chuẩn bị uniforms: uTime đếm thời gian, uResolution lưu kích thước khung nhìn và các uniform riêng của shader.
    const uniforms: Uniforms = {
      uTime: { value: 0 },
      uResolution: { value: [1, 1] },
      ...makeUniforms(),
    };

    // Bước 4: Biên dịch chương trình shader (Program) và dựng lưới Mesh từ một Triangle lớn phủ kín màn hình.
    const program = new Program(gl, { vertex: VERT, fragment, uniforms, transparent: true });
    const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });

    // Bước 5: Cấu hình hàm resize để cập nhật kích thước canvas và uniform uResolution khi container thay đổi.
    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h);
      (uniforms.uResolution!.value as number[])[0] = w;
      (uniforms.uResolution!.value as number[])[1] = h;
    };
    resize();
    // Đăng ký ResizeObserver để tự động kích hoạt hàm resize mỗi khi phần tử host đổi kích thước.
    const ro = new ResizeObserver(resize);
    ro.observe(host);

    // Bước 6: Khởi chạy vòng lặp render với requestAnimationFrame; tính delta time (dt) để thời gian trôi mượt mà.
    let raf = 0;
    let last = performance.now();
    // Clock advances by elapsed time rather than absolute `t`, so pausing for a
    // hidden tab resumes where it stopped instead of jumping.
    let clock = 0;
    // Hàm render loop chạy theo từng frame; dừng cập nhật khi tab bị ẩn để tiết kiệm pin và GPU.
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      // Giới hạn dt tối đa 50ms để ngăn hiệu ứng giật vọt khi người dùng quay lại tab sau khi bị nghẽn luồng JavaScript.
      const dt = Math.min(now - last, 50) / 1000;
      last = now;
      // Tạm dừng vẽ khi tab bị ẩn để tiết kiệm pin và tài nguyên GPU cho thiết bị.
      if (document.hidden) return;
      clock += dt;
      uniforms.uTime!.value = clock;
      renderer.render({ scene: mesh });
    };
    // Kích hoạt frame đầu tiên của render loop.
    raf = requestAnimationFrame(loop);

    // Bước 7: Dọn dẹp tài nguyên khi unmount: hủy animation frame, ngắt ResizeObserver, xóa canvas và thu hồi WebGL context.
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      gl.canvas.remove();
      // Free the context immediately; browsers cap the number of live ones and
      // navigating around the app can otherwise strand several.
      // Kích hoạt WEBGL_lose_context để buộc GPU giải phóng bộ nhớ ngay, tránh vượt quá giới hạn số context WebGL tối đa của trình duyệt.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return ref;
}

// Lớp CSS tiện ích Tailwind phủ kín toàn bộ diện tích khung chứa cha cho các canvas shader.
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
/**
 * Làm gì: Component hiệu ứng rèm cực quang (Aurora) lượn sóng dọc theo mép trên của khung chứa, sử dụng OGL shader với 3 dải màu tùy chỉnh.
 * Được gọi ở: Component GLBackground trong src/client/components/fx.tsx (khi variant === "aurora"); dùng ở phần Hero của Landing Page (src/client/components/landing/hero.tsx).
 * @param colors Mảng 3 mã màu hex định hình các dải màu của cực quang (mặc định: xanh lá và vàng cát của Arena3).
 * @param amplitude Biên độ uốn lượn của dải rèm sáng (mặc định: 1).
 * @param speed Tốc độ trôi dạt của các luồng sáng (mặc định: 1).
 * @param opacity Độ mờ đục tổng thể của hiệu ứng (0 đến 1, mặc định: 0.7).
 * @returns Phần tử JSX div chứa canvas hiển thị hiệu ứng rèm cực quang WebGL.
 */
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
  // Bước 1: Nối danh sách mã màu thành chuỗi key để theo dõi sự thay đổi màu sắc trong dependencies của React hook.
  const key = colors.join(",");
  // Bước 2: Nạp shader AURORA_FRAG qua hook useShader với các uniforms: biên độ, tốc độ, độ mờ và 3 dải màu hòa trộn.
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
  // Bước 3: Trả về thẻ div định vị tuyệt đối phủ kín toàn bộ khung chứa cha để gắn canvas WebGL.
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
/**
 * Làm gì: Component hiệu ứng ánh sáng nếp vải lụa mềm mại (Silk sheen) chuyển động chậm, mang lại phông nền tĩnh lặng và sang trọng.
 * Được gọi ở: Component GLBackground trong src/client/components/fx.tsx (khi variant === "silk"); dùng làm nền sau các panel dài cần độ tập trung.
 * @param color Mã màu chủ đạo của mặt vải lụa (mặc định: xanh lục đậm #3f7d20).
 * @param speed Tốc độ gợn sóng nếp vải (mặc định: 1).
 * @param scale Tỉ lệ co giãn nếp gấp vải lụa (mặc định: 1.4).
 * @param opacity Độ mờ đục của lớp vải lụa (0 đến 1, mặc định: 0.32).
 * @returns Phần tử JSX div chứa canvas WebGL hiển thị hiệu ứng nền vải lụa.
 */
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
  // Bước 1: Khởi tạo shader SILK_FRAG qua hook useShader với các uniforms: tốc độ, tỉ lệ nếp vải, độ mờ và màu sắc OGL.
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
  // Bước 2: Trả về thẻ div container phủ kín diện tích khung chứa cha để hiển thị canvas WebGL.
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
/**
 * Làm gì: Component hiệu ứng các sợi tơ phát sáng thanh mảnh chuyển động ngang (Threads), tạo cảm giác động tinh tế mà không chiếm dụng sự chú ý.
 * Được gọi ở: Component GLBackground trong src/client/components/fx.tsx (khi variant === "threads"); sử dụng tại màn hình đăng nhập /login và đăng ký /register.
 * @param color Màu sắc của các sợi tơ (mặc định: trắng #ffffff).
 * @param amplitude Biên độ dao động hình sin của các sợi tơ (mặc định: 1).
 * @param speed Tốc độ lướt ngang của các luồng sợi (mặc định: 1).
 * @param opacity Độ mờ đục của toàn bộ trường sợi tơ (0 đến 1, mặc định: 0.5).
 * @returns Phần tử JSX div chứa canvas WebGL hiển thị hiệu ứng các sợi tơ chuyển động.
 */
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
  // Bước 1: Khởi tạo shader THREADS_FRAG qua hook useShader với các uniforms điều khiển biên độ, tốc độ, độ mờ và màu sợi tơ.
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
  // Bước 2: Trả về phần tử div phủ kín khung chứa cha đóng vai trò làm vật chủ gắn canvas WebGL.
  return <div ref={ref} className={shell} />;
}

/* ── Court ───────────────────────────────────────────────────────── */

/**
 * A badminton court in perspective, lit from above: lime lines on a dark glossy floor, the net
 * across the middle, ceiling lamps and their reflections, a shuttle crossing with a short trail.
 *
 * Both dials mean something. `glow` is how many hours are free today (a full day lights the lines
 * up, an empty one leaves them dim); `tilt` is how far the visitor has scrolled, which lifts the
 * camera as the hero leaves. The pointer drags a pool of light across the floor.
 */
const COURT_FRAG = /* glsl */ `
  precision highp float;
  uniform vec2 uResolution;
  uniform float uTime;
  uniform vec2 uMouse;
  uniform float uTilt;
  uniform float uGlow;
  varying vec2 vUv;

  const vec3 BG = vec3(0.106, 0.133, 0.125);
  const vec3 LIME = vec3(0.831, 0.961, 0.235);
  const vec3 CHALK = vec3(0.961, 0.973, 0.949);
  const float HL = 6.7;
  const float HW = 3.05;
  const float SW = 2.59;
  const float ZC = 12.0;

  float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float segV(vec2 c, float x, float a, float b) { return length(vec2(c.x - x, max(abs(c.y - 0.5 * (a + b)) - 0.5 * (b - a), 0.0))); }
  float segH(vec2 c, float z, float a, float b) { return length(vec2(max(abs(c.x - 0.5 * (a + b)) - 0.5 * (b - a), 0.0), c.y - z)); }

  float courtDist(vec2 c) {
    float d = segV(c, HW, -HL, HL);
    d = min(d, segV(c, -HW, -HL, HL));
    d = min(d, segV(c, SW, -HL, HL));
    d = min(d, segV(c, -SW, -HL, HL));
    d = min(d, segH(c, HL, -HW, HW));
    d = min(d, segH(c, -HL, -HW, HW));
    d = min(d, segH(c, HL - 0.76, -HW, HW));
    d = min(d, segH(c, -HL + 0.76, -HW, HW));
    d = min(d, segH(c, 1.98, -HW, HW));
    d = min(d, segH(c, -1.98, -HW, HW));
    d = min(d, segV(c, 0.0, 1.98, HL));
    d = min(d, segV(c, 0.0, -HL, -1.98));
    return d;
  }

  void main() {
    // CSS pixels, not device pixels, so the picture does not change with the pixel ratio.
    vec2 fc = vUv * uResolution;
    vec2 p = (fc - 0.5 * uResolution) / uResolution.y;
    float aspect = uResolution.x / uResolution.y;
    float sx = clamp((aspect - 1.0) * 0.32, 0.0, 0.34);
    float hy = 0.17 + uTilt * 0.12;
    float camH = 3.4 + uTilt * 1.4;
    float yaw = -0.2 + (uMouse.x - 0.5) * 0.06;
    float ca = cos(yaw);
    float sa = sin(yaw);
    mat2 R = mat2(ca, -sa, sa, ca);
    mat2 Ri = mat2(ca, sa, -sa, ca);
    vec2 q = p - vec2(sx, 0.0);
    vec2 m = (uMouse - 0.5) * vec2(aspect, 1.0) - vec2(sx, 0.0);
    m.y = min(m.y, hy - 0.04);
    float onFloor = step(p.y, hy);

    vec3 col = BG * (0.72 - max(p.y - hy, 0.0) * 0.6);
    col += LIME * exp(-abs(p.y - hy) * 26.0) * 0.05 * uGlow;

    float lamps = 0.0;
    float refl = 0.0;
    for (int i = 0; i < 3; i++) {
      for (int j = 0; j < 4; j++) {
        float lx = (float(i) - 1.0) * 5.5;
        float lz = 15.0 + float(j) * 6.5;
        float r = 0.55 / lz;
        vec2 d = q - vec2(lx / lz, hy + (7.5 - camH) / lz);
        d.x *= 0.6;
        lamps += exp(-dot(d, d) / (r * r));
        vec2 dr = q - vec2(lx / lz, hy - (7.5 + camH) / lz);
        dr.y *= 0.22;
        dr.x *= 0.9;
        refl += exp(-dot(dr, dr) / (r * r * 1.6));
      }
    }

    float z = camH / max(hy - q.y, 0.002);
    vec2 c = R * (vec2(q.x * z, z) - vec2(0.0, ZC));
    float zm = camH / (hy - m.y);
    vec2 mc = R * (vec2(m.x * zm, zm) - vec2(0.0, ZC));
    vec2 dv = c - mc;
    float r2 = dot(dv, dv);
    float light = exp(-r2 / 16.0);
    c += dv * 0.5 * exp(-r2 / 4.5);
    c.x += sin(c.y * 0.6 + uTime * 0.7) * 0.03;
    float d = courtDist(c);
    // Edge width of one pixel on the floor, worked out from the projection (the same job fwidth does,
    // which GLSL 1.00 shaders do not get in a WebGL2 context).
    float px = z / uResolution.y;
    float pz = z * z / (camH * uResolution.y);
    float aa = max(abs(courtDist(c + R * vec2(px, 0.0)) - d) + abs(courtDist(c + R * vec2(0.0, pz)) - d), 1e-4);
    float hw = 0.035;
    float core = (1.0 - smoothstep(hw - aa, hw + aa, d)) * min(1.0, hw * 2.0 / aa);
    float halo = exp(-d / 0.22) * 0.45 + exp(-d / 0.9) * 0.12;
    float fade = exp(-max(z - 6.0, 0.0) * 0.035) * smoothstep(0.0, 0.03, hy - p.y);
    vec3 floorC = vec3(0.075, 0.100, 0.090) * (0.8 + 0.4 * exp(-z * 0.05));
    floorC += (hash(vec2(floor(c.x * 1.2), 3.0)) - 0.5) * 0.012;
    floorC += mix(CHALK, LIME, 0.6) * light * 0.10 * (0.5 + uGlow);
    floorC += LIME * (core * 0.75 + halo) * fade * uGlow * (0.55 + light * 1.1);
    floorC += CHALK * core * light * 0.18 * fade;
    floorC += vec3(0.85, 0.92, 0.80) * refl * 0.10 * fade;
    col = mix(col + vec3(0.85, 0.92, 0.80) * lamps * 0.35, floorC, onFloor);

    // The net is a vertical plane across the middle of the court.
    float tn = ca * ZC / (ca - sa * q.x);
    float hN = camH + tn * (q.y - hy);
    float cxN = ca * tn * q.x + sa * (tn - ZC);
    float front = max(1.0 - onFloor, step(tn, z));
    float inNet = step(0.0, tn) * step(0.0, hN) * step(hN, 1.55) * step(abs(cxN), HW + 0.15) * front;
    float tape = 1.0 - smoothstep(0.0, 0.05, abs(hN - 1.5));
    float post = 1.0 - smoothstep(0.0, 0.06, abs(abs(cxN) - HW - 0.12));
    vec3 netC = col * 0.55 + CHALK * (tape * 0.55 + post * 0.4) + LIME * 0.05 * uGlow;
    col = mix(col, netC, inNet);

    // A shuttle crossing the court, every few seconds, alternating direction.
    float cyc = uTime * 0.16;
    float sgn = mod(floor(cyc), 2.0) < 0.5 ? 1.0 : -1.0;
    float sp = fract(cyc);
    float trail = 0.0;
    for (int i = 0; i < 14; i++) {
      float s = sp - float(i) * 0.012;
      if (s < 0.0) break;
      vec2 cc = vec2(mix(-1.3, 1.1, s), mix(-4.6, 4.8, s)) * sgn;
      float hh = 1.0 + 13.6 * s * (1.0 - s);
      vec2 ww = Ri * cc + vec2(0.0, ZC);
      vec2 dd = q - vec2(ww.x / ww.y, hy + (hh - camH) / ww.y);
      float rr = 0.14 / ww.y;
      float k = 1.0 - float(i) / 14.0;
      trail += exp(-dot(dd, dd) / (rr * rr)) * k * k;
    }
    col += mix(CHALK, LIME, 0.35) * trail * 0.9;

    float vig = smoothstep(1.15, 0.3, length((vUv - vec2(0.6, 0.45)) * vec2(1.05, 1.25)));
    col *= mix(0.45, 1.0, vig);
    col += (hash(fc + fract(uTime * 7.0) * 113.0) - 0.5) * 0.03;
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`;

/** What the page feeds the court. Mutate it; the shader reads it every frame, nothing re-renders. */
export type CourtDrive = { tilt: number; glow: number };

/**
 * Làm gì: Render sân cầu lông 3D phối cảnh (perspective) trên nền WebGL qua shader COURT_FRAG; phản hồi vệt sáng theo con trỏ chuột và cập nhật động góc nghiêng camera khi cuộn cùng độ sáng vạch sân theo số giờ trống.
 * Được gọi ở: src/client/components/fx.tsx (dynamic import trong GLBackground khi variant = "court"); hiển thị trực tiếp tại hero banner trang chủ (src/client/components/landing/hero.tsx).
 * @param drive Ref chứa trạng thái điều khiển động không gây re-render: tilt (góc nghiêng phối cảnh khi cuộn trang) và glow (độ phát sáng vạch sân tương ứng với số giờ sân còn trống trong ngày).
 * @returns JSX.Element chứa WebGL canvas render hiệu ứng sân cầu lông toàn màn hình.
 */
export function Court({ drive }: { drive?: { current: CourtDrive } }) {
  // Pointer target and its eased value, as mutable state the uniform getters read per frame.
  // Bước 1: Khởi tạo các ref lưu tọa độ chuột mục tiêu (x, y) và tọa độ đã làm mượt (ex, ey) để shader đọc trực tiếp mỗi frame mà không kích hoạt re-render React.
  const pointer = useRef({ x: 0.5, y: 0.5, ex: 0.5, ey: 0.5 });
  const mouse = useRef<[number, number]>([0.5, 0.5]);

  // Bước 2: Lắng nghe sự kiện di chuyển chuột (pointermove) trên window để chuẩn hóa tọa độ về dải [0, 1] theo chuẩn WebGL (trục Y hướng lên trên).
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointer.current.x = e.clientX / window.innerWidth;
      pointer.current.y = 1 - e.clientY / window.innerHeight;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  // Bước 3: Khởi tạo chương trình shader WebGL thông qua useShader, truyền getter để OGL tự động kéo dữ liệu uniform mỗi frame (lerp vị trí chuột, tilt, glow).
  const ref = useShader(
    COURT_FRAG,
    () => ({
      uMouse: {
        // ogl reads `.value` once per frame, which makes this the easing step for the pointer.
        get value() {
          const s = pointer.current;
          // Áp dụng công thức làm mượt (lerp với hệ số 0.08) giúp quầng sáng di chuyển uyển chuyển theo chuột thay vì nhảy tức thì.
          s.ex += (s.x - s.ex) * 0.08;
          s.ey += (s.y - s.ey) * 0.08;
          mouse.current[0] = s.ex;
          mouse.current[1] = s.ey;
          return mouse.current;
        },
      },
      uTilt: { get value() { return drive?.current.tilt ?? 0; } },
      uGlow: { get value() { return drive?.current.glow ?? 0.8; } },
    }),
    [],
  );
  return <div ref={ref} className={shell} />;
}

/* ── Hall flow ───────────────────────────────────────────────────── */

const FLOW_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D tMap;
  uniform sampler2D tFlow;
  uniform vec2 uCover;
  void main() {
    // Flow xy is the wake's direction, z how fresh it is.
    vec3 flow = texture2D(tFlow, vUv).rgb;
    vec2 uv = (vUv - 0.5) * uCover + 0.5;
    vec2 off = flow.xy * 0.08;
    // The three channels drift apart inside the wake, like air bending light.
    float r = texture2D(tMap, uv - off * 1.5).r;
    float g = texture2D(tMap, uv - off).g;
    float b = texture2D(tMap, uv - off * 0.5).b;
    vec3 col = vec3(r, g, b) + vec3(0.83, 0.96, 0.25) * min(length(flow.xy), 1.0) * 0.14;
    gl_FragColor = vec4(col, 1.0);
  }
`;

/**
 * Redraws the hero footage through an OGL flowmap: the pointer leaves a short wake through the
 * hall, the way air trails a shuttle. It finds the `<video>` already playing in its section
 * (`[data-media]`), so the plain footage stays underneath as the fallback for touch screens,
 * reduced motion, no WebGL, or a video from another origin that cannot be read into a texture.
 */
/**
 * Làm gì: Vẽ lại video nền hero qua OGL Flowmap tạo hiệu ứng dòng khí (wake) gợn sóng và khúc xạ ánh sáng theo đường di chuột như quả cầu bay qua không khí.
 * Được gọi ở: src/client/components/fx.tsx (dynamic import trong GLBackground khi variant = "flow"); sử dụng trong khối hero banner tại src/client/components/landing/hero.tsx.
 * @returns JSX.Element chứa canvas WebGL phủ lên trên thẻ video nền.
 */
export function HallFlow() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Bước 1: Tìm phần tử video nền trong khối cha gần nhất ([data-media]); kiểm tra thiết bị có chuột (pointer: fine) và trình duyệt hỗ trợ WebGL.
    const host = ref.current;
    const video = host?.closest("[data-media]")?.querySelector("video");
    if (!host || !video || !window.matchMedia("(pointer: fine)").matches) return;
    const probe = document.createElement("canvas");
    if (!(probe.getContext("webgl2") ?? probe.getContext("webgl"))) return;

    // Bước 2: Khởi tạo WebGL Renderer (giới hạn DPR qua MAX_DPR) và gán canvas trong suốt vào DOM với transition mờ dần (fade-in 0.6s).
    const renderer = new Renderer({ alpha: true, antialias: false, dpr: Math.min(window.devicePixelRatio || 1, MAX_DPR) });
    const gl = renderer.gl;
    gl.clearColor(0, 0, 0, 0);
    Object.assign(gl.canvas.style, { width: "100%", height: "100%", display: "block", opacity: "0", transition: "opacity .6s" });
    host.appendChild(gl.canvas);

    // Bước 3: Tạo Flowmap tính toán trường vận tốc chuột, Texture nhận luồng video làm nguồn ảnh, và Program áp dụng shader FLOW_FRAG.
    const flowmap = new Flowmap(gl, { falloff: 0.3, dissipation: 0.965 });
    const texture = new Texture(gl, { generateMipmaps: false });
    const cover = [1, 1];
    const program = new Program(gl, {
      vertex: VERT,
      fragment: FLOW_FRAG,
      uniforms: { tMap: { value: texture }, tFlow: flowmap.uniform, uCover: { value: cover } },
    });
    const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });

    // Bước 4: Thiết lập hàm resize mô phỏng quy tắc CSS object-cover, cắt bớt phần thừa video theo tỉ lệ khung hình (uCover).
    const resize = () => {
      const w = host.clientWidth || 1;
      const h = host.clientHeight || 1;
      renderer.setSize(w, h);
      flowmap.aspect = w / h;
      // object-cover: crop the footage on whichever axis overflows the frame.
      const va = (video.videoWidth || 16) / (video.videoHeight || 9);
      const ca = w / h;
      cover[0] = ca < va ? ca / va : 1;
      cover[1] = ca < va ? 1 : va / ca;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    video.addEventListener("loadedmetadata", resize);

    const last = { x: 0, y: 0, t: 0 };
    const vel = new Vec2();
    let moved = false;
    // Bước 5: Lắng nghe sự kiện di chuyển chuột để tính toán vận tốc tức thời (vel = dx / dt) và vị trí chuột cung cấp cho flowmap.
    const onMove = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      if (x < 0 || y < 0 || x > r.width || y > r.height) return;
      const now = performance.now();
      const dt = Math.max(14, now - last.t);
      if (last.t) vel.set((x - last.x) / dt, (y - last.y) / dt);
      last.x = x; last.y = y; last.t = now;
      flowmap.mouse.set(x / r.width, 1 - y / r.height);
      moved = true;
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    let raf = 0;
    let shown = false;
    // Bước 6: Vòng lặp animation frame cập nhật texture từ khung hình video hiện tại, làm mượt vận tốc chuột và render cảnh WebGL.
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (document.hidden || video.readyState < 2) return;
      if (!moved) { flowmap.mouse.set(-1, -1); vel.set(0, 0); }
      moved = false;
      // Nội suy vận tốc: tăng tốc nhanh (0.5) khi rê chuột, giảm dần chậm rãi (0.1) khi dừng chuột để giữ quán tính luồng khí.
      flowmap.velocity.lerp(vel, vel.len() ? 0.5 : 0.1);
      flowmap.update();
      texture.image = video;
      texture.needsUpdate = true;
      // Bọc render trong try-catch: nếu video bị dính lỗi CORS (tainted canvas) thì dừng loop và gỡ bỏ canvas để người dùng xem video gốc an toàn.
      try {
        renderer.render({ scene: mesh });
      } catch {
        // A cross-origin video taints the texture; leave the plain footage showing.
        cancelAnimationFrame(raf);
        gl.canvas.remove();
        return;
      }
      if (!shown) { shown = true; gl.canvas.style.opacity = "1"; }
    };
    raf = requestAnimationFrame(loop);

    // Bước 7: Dọn dẹp tài nguyên khi unmount: hủy requestAnimationFrame, ngắt ResizeObserver, gỡ bỏ event listeners và giải phóng WebGL context.
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      video.removeEventListener("loadedmetadata", resize);
      window.removeEventListener("pointermove", onMove);
      gl.canvas.remove();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

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
/**
 * Làm gì: Render mạng lưới các điểm chấm (dot grid) bằng Canvas 2D; các chấm sáng lên và phóng to khi con trỏ chuột lướt qua, tự động dừng animation loop khi chuột đứng yên để tiết kiệm CPU/GPU.
 * Được gọi ở: src/client/components/fx.tsx (dynamic import trong GLBackground khi variant = "dotgrid"); sử dụng tại src/client/components/landing/steps.tsx (khối các bước hướng dẫn).
 * @param color Màu sắc của các chấm dạng mã hex/CSS (mặc định "#3f7d20").
 * @param gap Khoảng cách giữa tâm các chấm liền kề tính bằng pixel (mặc định 26px).
 * @param dot Bán kính cơ bản của chấm ở trạng thái nghỉ tính bằng pixel (mặc định 1.8px).
 * @param radius Bán kính vùng tác động lan tỏa xung quanh con trỏ chuột (mặc định 150px).
 * @param opacity Độ mờ cơ bản của toàn bộ lưới điểm (mặc định 0.5).
 * @returns JSX.Element chứa thẻ canvas 2D phủ toàn bộ khung nền của khối chứa.
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
    // Bước 1: Kiểm tra phần tử host, canvas và context 2D; thoát sớm nếu chưa mount đầy đủ trên DOM.
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

    // Bước 2: Thiết lập hàm resize đồng bộ kích thước canvas theo độ phân giải màn hình (dpr tối đa 2x) và vẽ lại lưới điểm.
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

    // Bước 3: Hàm vẽ lưới điểm (draw): duyệt qua các hàng và cột, tính khoảng cách tới con trỏ chuột và áp dụng hiệu ứng phóng to/sáng dần theo hàm bình phương falloff.
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
          // Làm suy giảm mềm (f = near^2) tạo quầng sáng mượt mà, tránh tạo viền tròn sắc nhọn gắt mắt.
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

    // Bước 4: Vòng lặp animation frame (loop): nội suy tọa độ chuột mục tiêu (lerp 0.16); tự động dừng loop khi khoảng cách sai lệch < 0.4px để tiết kiệm tài nguyên.
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

    // Bước 5: Hàm đánh thức (kick): kích hoạt lại animation loop khi con trỏ chuột bắt đầu di chuyển.
    const kick = () => {
      idle = false;
      if (!raf) raf = requestAnimationFrame(loop);
    };

    // Bước 6: Đăng ký các sự kiện chuột (pointermove, pointerleave) trên window; chỉ xử lý chuột vật lý (pointerType === "mouse") để tối ưu cho thiết bị cảm ứng.
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

    // Bước 7: Khởi chạy lần vẽ đầu tiên, theo dõi thay đổi kích thước bằng ResizeObserver và lắng nghe sự kiện chuột.
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave);

    // Bước 8: Dọn dẹp tài nguyên khi unmount hoặc khi props thay đổi: hủy animation frame, ngắt ResizeObserver và gỡ bỏ event listeners.
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
