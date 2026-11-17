/**
 * The poses of the landing's 3D scene, with no GSAP and no DOM: given the scroll progress `p`
 * and a clock, `drawScene` places the shuttle, racket and ball and draws them through the
 * wrapper in `shuttle3d-gl.ts`. The shuttle is served in the hero, hit by the racket, and then
 * dissolves into a basketball that eases into a volleyball as the page scrolls.
 */
import { RK, chain, persp, rx, ry, rz, sc, sc3, tr, type Shuttle3D } from "./shuttle3d-gl";

/**
 * Làm gì: Giới hạn (kẹp) giá trị số v nằm trong khoảng từ a đến b.
 * Được gọi ở: Nội bộ file src/client/components/landing/shuttle3d-scene.ts (các hàm easing eIn3, eOut3, eInOut3, eBack, smo, hàm castAt, zoomAt, drawScene).
 * @param v Giá trị số đầu vào cần giới hạn.
 * @param a Cận dưới (giá trị tối thiểu).
 * @param b Cận trên (giá trị tối đa).
 * @returns Giá trị v sau khi đã giới hạn trong khoảng [a, b].
 */
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
/**
 * Làm gì: Nội suy tuyến tính (Linear Interpolation) giữa hai giá trị số a và b theo tỉ lệ t.
 * Được gọi ở: Nội bộ file src/client/components/landing/shuttle3d-scene.ts (hàm swingPose, sampleLane, drawScene).
 * @param a Giá trị mốc ban đầu (khi t = 0).
 * @param b Giá trị mốc đích đến (khi t = 1).
 * @param t Hệ số tiến trình nội suy (thường trong khoảng 0 đến 1).
 * @returns Giá trị nội suy nằm giữa a và b tương ứng với t.
 */
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/**
 * Làm gì: Hàm gia tốc bậc 3 (Cubic Ease-In), bắt đầu chậm rồi tăng tốc nhanh dần về cuối.
 * Được gọi ở: Nội bộ file src/client/components/landing/shuttle3d-scene.ts (hàm swingPose, tính bán kính cầu lông shS trong drawScene).
 * @param x Tiến trình thời gian chuẩn hóa.
 * @returns Giá trị sau khi làm mịn theo đường cong x^3 trong đoạn [0, 1].
 */
const eIn3 = (x: number) => { x = clamp(x, 0, 1); return x * x * x; };
/**
 * Làm gì: Hàm giảm tốc bậc 3 (Cubic Ease-Out), bắt đầu nhanh rồi hãm phanh êm dịu về cuối.
 * Được gọi ở: Nội bộ file src/client/components/landing/shuttle3d-scene.ts (hàm swingPose, bounceAt).
 * @param x Tiến trình thời gian chuẩn hóa.
 * @returns Giá trị sau khi làm mịn theo đường cong 1 - (1 - x)^3 trong đoạn [0, 1].
 */
const eOut3 = (x: number) => { x = 1 - clamp(x, 0, 1); return 1 - x * x * x; };
/**
 * Làm gì: Hàm gia tốc và giảm tốc kết hợp bậc 3 (Cubic Ease-InOut), êm dịu ở cả điểm xuất phát lẫn điểm dừng.
 * Được gọi ở: Nội bộ file src/client/components/landing/shuttle3d-scene.ts (giai đoạn vung vợt ra sau T_PULL trong swingPose).
 * @param x Tiến trình thời gian chuẩn hóa (0 đến 1).
 * @returns Giá trị nội suy mượt mà trong đoạn [0, 1].
 */
const eInOut3 = (x: number) => { x = clamp(x, 0, 1); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(2 - 2 * x, 3) / 2; };
/**
 * Làm gì: Hàm chuyển động vượt ngưỡng rồi giật về (Back Ease-Out), tạo hiệu ứng quán tính vung quá đà sống động.
 * Được gọi ở: Nội bộ file src/client/components/landing/shuttle3d-scene.ts (hàm swingPose, hiệu ứng phồng to quả bóng trong drawScene).
 * @param x Tiến trình chuẩn hóa từ 0 đến 1.
 * @param s Hệ số biên độ văng quá đà (overshoot amount).
 * @returns Giá trị vị trí đã tính toán kèm quán tính văng quá đà.
 */
const eBack = (x: number, s: number) => { x = clamp(x, 0, 1); const y = x - 1; return 1 + (s + 1) * y * y * y + s * y * y; };
/**
 * Làm gì: Hàm làm mịn bậc 1 chuẩn (Smoothstep: 3t^2 - 2t^3), triệt tiêu độ dốc ở hai đầu giúp chuyển động không bị khựng giật.
 * Được gọi ở: Nội bộ file src/client/components/landing/shuttle3d-scene.ts (hàm castAt, sampleLane, tính độ mờ vợt và bóng đổ trong drawScene).
 * @param t Tiến trình chuẩn hóa từ 0 đến 1.
 * @returns Giá trị làm mịn mượt mà trong đoạn [0, 1].
 */
const smo = (t: number) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

const FOV = 0.5, D0 = 8, TANH = Math.tan(FOV / 2);

// Racket swing: enter, anticipation pull-back, accelerating strike, contact, follow-through, overshoot settle.
// Angles are rz around the grip. 0 points the head straight up; positive turns it to the left.
const SWING = {
  wide: { rest: -0.35, back: -1.25, hit: 0.5, follow: 0.95, settle: 0.25, size: 0.46, ring: 1.0 },
  narrow: { rest: 0.3, back: -0.2, hit: 1.25, follow: 1.5, settle: 1.05, size: 0.36, ring: 0.8 },
};
type Swing = typeof SWING.wide;
const T_IN = 0.45, T_PULL = 0.95, T_HIT = 1.13, T_FOLLOW = 1.5, T_SETTLE = 2.3, TILT = -0.28;

/**
 * Làm gì: Tính toán tư thế chuyển động (pose) của cây vợt theo các pha vung vợt: bay vào, lấy đà kéo lùi, đập cầu, vung theo quán tính, hãm phanh ổn định và nhấp nhô nhẹ.
 * Được gọi ở: Nội bộ file src/client/components/landing/shuttle3d-scene.ts (hàm racketAt và tính tốc độ vung vợt spd trong drawScene).
 * @param t Thời gian tương đối tính từ lúc kích hoạt vung vợt (giây).
 * @param K Bộ thông số góc và kích thước vợt (Swing) theo màn hình rộng hoặc hẹp.
 * @returns Đối tượng tư thế vợt gồm góc quay (a), độ phóng to (s), độ mờ (al), góc xoay mặt vợt (face) và độ dịch chuyển (px, py).
 */
function swingPose(t: number, K: Swing) {
  let a: number, s = 1, al = 1, face = 0.5, px = 0, py = 0, u: number;
  // Trước khi bắt đầu: vợt ẩn hoàn toàn (scale = 0, alpha = 0).
  if (t < 0) return { a: K.rest + 0.5, s: 0, al: 0, face: 0.5, px: 0, py: 0 };
  // Bước 1: Vợt bay vào màn hình, phóng to vượt ngưỡng (overshoot) và xoay dần về tư thế chờ (rest).
  if (t < T_IN) {
    u = t / T_IN; s = Math.max(0, eBack(u, 2)); al = eOut3(u); a = lerp(K.rest + 0.5, K.rest, eOut3(u));
  } else if (t < T_PULL) {
    // Bước 2: Vợt kéo lùi ra sau lấy đà (anticipation), ngửa mặt vợt đón cầu.
    u = eInOut3((t - T_IN) / (T_PULL - T_IN));
    a = lerp(K.rest, K.back, u); face = lerp(0.5, 0.9, u); px = 0.35 * u; py = 0.25 * u;
  } else if (t < T_HIT) {
    // Bước 3: Vung vợt tăng tốc tối đa (strike) tiến tới điểm tiếp xúc cầu.
    u = eIn3((t - T_PULL) / (T_HIT - T_PULL));
    a = lerp(K.back, K.hit, u); face = lerp(0.9, 0.75, u); px = lerp(0.35, 0, u); py = lerp(0.25, 0, u);
  } else if (t < T_FOLLOW) {
    // Bước 4: Đập trúng cầu và vung vợt theo đà quán tính (follow-through), úp dần mặt vợt.
    u = eOut3((t - T_HIT) / (T_FOLLOW - T_HIT));
    a = lerp(K.hit, K.follow, u); face = lerp(0.75, 0.35, u); px = lerp(0, -0.35, u); py = lerp(0, -0.15, u);
  } else if (t < T_SETTLE) {
    // Bước 5: Giảm tốc và bật nảy nhẹ về vị trí kết thúc ổn định (settle).
    u = eBack((t - T_FOLLOW) / (T_SETTLE - T_FOLLOW), 2.2);
    a = lerp(K.follow, K.settle, u); face = lerp(0.35, 0.5, u); px = lerp(-0.35, 0, u); py = lerp(-0.15, 0, u);
  } else {
    // Bước 6: Dao động sóng sin biên độ nhỏ để giữ cây vợt luôn chuyển động tự nhiên khi dừng.
    const w = t - T_SETTLE;
    a = K.settle + 0.035 * Math.sin(1.6 * w); face = 0.5 + 0.06 * Math.sin(1.1 * w);
  }
  return { a, s, al, face, px, py };
}

// Ball bounce: crouch, lift, fall, four decaying contacts with squash-and-stretch, then a small settle wobble.
const B_TL = 0.32, B_T0 = 0.34, B_E = 0.5, B_C = 0.075;
const B_IMP: { t: number; a: number }[] = [];
let B_END = 0;
// Tính toán trước mốc thời gian và biên độ suy giảm cho 4 lần nảy chạm sàn của quả bóng.
{
  let t = 0.1 + B_TL + B_T0, amp = 1;
  for (let n = 0; n < 4; n++) {
    B_IMP.push({ t, a: amp });
    t += B_C; amp *= B_E;
    if (n < 3) t += 2 * B_T0 * amp;
  }
  B_END = t;
}
/**
 * Làm gì: Mô phỏng vật lý nảy của quả bóng với hiệu ứng biến dạng co ép và kéo giãn (squash-and-stretch): nhún đà, phóng lên, rơi tự do, 4 lần nảy chạm sàn tắt dần và rung lắc ổn định.
 * Được gọi ở: Nội bộ file src/client/components/landing/shuttle3d-scene.ts (hàm drawScene khi bóng xuất hiện).
 * @param age Thời gian tính từ khi bắt đầu kích hoạt hiệu ứng nảy bóng (giây).
 * @param H0 Chiều cao nảy cực đại ban đầu (tùy thuộc kích thước màn hình).
 * @returns Đối tượng gồm độ cao hiện tại (h), hệ số bẹp co ép (sq) và hệ số kéo giãn dài (st).
 */
function bounceAt(age: number, H0: number) {
  const r = { h: 0, sq: 0, st: 0 };
  let u: number, t = age;
  // Chưa đến thời điểm kích hoạt: giữ nguyên vị trí bóng trên mặt sàn.
  if (age < 0) return r;
  // Bước 1 (age < 0.1s): Khối cầu nhún nhẹ (crouch) co bẹp xuống để tích lũy thế năng bật nảy.
  if (t < 0.1) { r.sq = 0.14 * Math.sin((t / 0.1) * Math.PI); return r; }
  // Bước 2: Bật phóng lên không trung (lift), đạt độ cao đỉnh H0 kèm hiệu ứng dãn dài cơ học.
  t -= 0.1;
  if (t < B_TL) { u = t / B_TL; r.h = H0 * eOut3(u); r.st = 0.6 * u * (1 - u) * (1 - u); return r; }
  // Bước 3: Rơi tự do xuống sàn dưới tác dụng của gia tốc trọng trường.
  t -= B_TL;
  if (t < B_T0) { u = t / B_T0; r.h = H0 * (1 - u * u); r.st = 0.2 * u * u; return r; }
  // Bước 4: Chuỗi 4 lần bóng va đập sàn với biên độ nảy suy giảm dần theo hệ số phục hồi đàn hồi.
  for (let n = 0; n < B_IMP.length; n++) {
    const c = B_IMP[n], ce = c.t + B_C, nx = n < 3 ? c.a * B_E : 0;
    // Thời điểm tiếp đất: bóng co bẹp chiều dọc (squash) và dãn ngang do phản lực va chạm sàn.
    if (age < ce) {
      u = (age - c.t) / B_C;
      r.sq = Math.sin(u * Math.PI) * 0.36 * c.a;
      r.st = Math.max(0, 1 - 2 * u) * 0.2 * c.a + Math.max(0, 2 * u - 1) * 0.2 * nx;
      return r;
    }
    // Quỹ đạo hình parabol bay lên rồi rơi xuống giữa hai lần nảy liên tiếp.
    if (n < 3) {
      const Tn = 2 * B_T0 * nx;
      if (age < ce + Tn) {
        const w = (2 * (age - ce)) / Tn - 1;
        r.h = H0 * nx * nx * (1 - w * w); r.st = 0.2 * nx * w * w;
        return r;
      }
    }
  }
  // Bước 5: Sau 4 lần nảy, rung lắc nhỏ tắt dần (damped wobble) trước khi bóng đứng yên hoàn toàn.
  const wr = age - B_END;
  r.sq = -0.05 * Math.sin(wr * 24) * Math.exp(-wr * 8);
  return r;
}

// Shuttle through the hero. It settles, dissolves into the basketball, then the ball eases into the volleyball.
/**
 * Làm gì: Tính toán tỷ lệ chuyển giao hình thái (morphing) giữa quả cầu lông, bóng rổ và bóng chuyền theo tiến trình cuộn trang p.
 * Được gọi ở: Nội bộ file src/client/components/landing/shuttle3d-scene.ts (hàm drawScene).
 * @param p Tiến trình cuộn trang chuẩn hóa từ 0 (đầu trang) đến 1 (cuối trang).
 * @returns Đối tượng chứa trọng số hiển thị của cầu lông (shuttle), bóng rổ (ball) và tỷ lệ biến đổi sang bóng chuyền (sport).
 */
function castAt(p: number) {
  // p = 0.30 -> 0.48: cầu lông chuyển hóa thành bóng rổ; p = 0.64 -> 0.84: bóng rổ chuyển hóa thành bóng chuyền.
  const rawBall = smo(clamp((p - 0.3) / 0.18, 0, 1));
  const rawVolley = smo(clamp((p - 0.64) / 0.2, 0, 1));
  return { rawBall, rawVolley, shuttle: 1 - rawBall, ball: rawBall, sport: rawVolley };
}
/**
 * Làm gì: Tính toán hệ số phóng to camera (zoom scale) dạng hình chuông tại các mốc cuộn trang quan trọng, nhấn mạnh khoảnh khắc biến hình giữa các môn thể thao.
 * Được gọi ở: Nội bộ file src/client/components/landing/shuttle3d-scene.ts (hàm drawScene).
 * @param p Tiến trình cuộn trang chuẩn hóa (0 đến 1).
 * @param narrow Cờ màn hình hẹp (<= 1024px) để giảm biên độ zoom tránh tràn khung nhìn.
 * @returns Hệ số phóng to camera (giá trị >= 1).
 */
function zoomAt(p: number, narrow: boolean) {
  // Hàm tạo đường cong hình chuông cosin cục bộ quanh mốc trung tâm c với bề rộng w.
  const bell = (c: number, w: number, amp: number) => {
    const x = (p - c) / w;
    return x <= -1 || x >= 1 ? 0 : amp * 0.5 * (1 + Math.cos(x * Math.PI));
  };
  // Phóng to camera tại hai thời điểm chuyển giao: sang bóng rổ (p ≈ 0.39) và sang bóng chuyền (p ≈ 0.74).
  let z = 1 + bell(0.39, 0.14, 0.07) + bell(0.74, 0.14, 0.05);
  // Trên màn hình hẹp (narrow), giảm 65% biên độ phóng to để tránh vật thể tràn mép màn hình.
  if (narrow) z = 1 + (z - 1) * 0.35;
  return z;
}
type Key = { p: number; x: number; y: number; s: number };
const LANE_WIDE: Key[] = [
  { p: 0, x: 0.66, y: 0.46, s: 0.86 },
  { p: 0.05, x: 0.62, y: 0.48, s: 0.82 },
  { p: 0.11, x: 0.06, y: 0.58, s: 0.48 },
  { p: 0.18, x: 0.055, y: 0.34, s: 0.56 },
  { p: 0.28, x: 0.05, y: 0.4, s: 0.6 },
  { p: 0.34, x: 0.05, y: 0.46, s: 0.62 },
  { p: 0.5, x: 0.05, y: 0.47, s: 0.62 },
  { p: 0.56, x: 0.06, y: 0.16, s: 0.4 },
  { p: 0.63, x: 0.94, y: 0.26, s: 0.42 },
  { p: 0.7, x: 0.95, y: 0.34, s: 0.5 },
  { p: 0.86, x: 0.95, y: 0.4, s: 0.52 },
  { p: 1, x: 0.94, y: 0.32, s: 0.52 },
];
const LANE_NARROW: Key[] = [
  { p: 0, x: 0.7, y: 0.66, s: 0.9 },
  { p: 0.14, x: 0.84, y: 0.3, s: 0.32 },
  { p: 0.28, x: 0.86, y: 0.74, s: 0.26 },
  { p: 0.4, x: 0.74, y: 0.7, s: 0.28 },
  { p: 0.5, x: 0.76, y: 0.7, s: 0.3 },
  { p: 0.64, x: 0.84, y: 0.46, s: 0.26 },
  { p: 0.82, x: 0.84, y: 0.48, s: 0.26 },
  { p: 1, x: 0.84, y: 0.4, s: 0.26 },
];
/**
 * Làm gì: Lấy mẫu tọa độ (x, y) và tỷ lệ kích thước (s) trên đường ray di chuyển (keyframes lane) theo tiến trình cuộn trang p.
 * Được gọi ở: Nội bộ file src/client/components/landing/shuttle3d-scene.ts (hàm drawScene để định vị vật thể và vẽ vệt bóng trail).
 * @param p Tiến trình cuộn trang chuẩn hóa (0 đến 1).
 * @param narrow Cờ màn hình hẹp (<= 1024px) để áp dụng bộ mốc vị trí riêng (LANE_NARROW thay vì LANE_WIDE).
 * @returns Đối tượng chứa tọa độ màn hình chuẩn hóa (x, y) và hệ số tỉ lệ kích thước (s).
 */
function sampleLane(p: number, narrow: boolean) {
  const keys = narrow ? LANE_NARROW : LANE_WIDE;
  // Bước 1: Tìm khoảng keyframe [a, b] chứa tiến trình cuộn p hiện tại.
  let a = keys[0], b = keys[keys.length - 1];
  for (let i = 0; i < keys.length - 1; i++) {
    if (p >= keys[i].p && p <= keys[i + 1].p) { a = keys[i]; b = keys[i + 1]; break; }
  }
  // Bước 2: Chuẩn hóa tỉ lệ vị trí cục bộ t trong đoạn [a.p, b.p].
  let t = (p - a.p) / Math.max(0.001, b.p - a.p);
  // Ở màn hình rộng trong pha đập cầu đầu tiên (p ~ 0.05), dùng ease-out bậc 2 để tạo cảm giác cầu bay vọt nhanh.
  if (!narrow && a.p > 0.04 && a.p < 0.06) t = 1 - Math.pow(1 - t, 2);
  else t = t * t * (3 - 2 * t);
  // Bước 3: Nội suy tuyến tính tọa độ màn hình (x, y) và tỷ lệ kích thước (s).
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), s: lerp(a.s, b.s, t) };
}

/** Mutable state the scene keeps between frames. */
export type SceneState = {
  /** Smoothed scroll progress 0..1. */
  p: number;
  /** Pointer parallax and slow yaw. */
  yaw: number; rx: number; ry: number;
  /** Swing and bounce clocks. */
  swT0: number; swArmed: boolean;
  bzT0: number; bzA1: boolean; bzA2: boolean;
};
/**
 * Làm gì: Khởi tạo đối tượng trạng thái ban đầu (SceneState) cho cảnh 3D giữa các khung hình (tiến trình cuộn trang, góc xoay parallax chuột, đồng hồ vung vợt và đập nảy bóng).
 * Được gọi ở: src/client/components/landing/shuttle3d.tsx (trong hook useScene của component ShuttleScene).
 * @returns Đối tượng SceneState chứa các giá trị khởi tạo mặc định.
 */
export const newSceneState = (): SceneState => ({
  p: 0, yaw: 0.6, rx: 0, ry: 0, swT0: -1, swArmed: false, bzT0: -1, bzA1: true, bzA2: true,
});

export type SceneOpts = {
  time: number;
  /** false under reduced motion: a single still pose, no bob, swing or bounce. */
  motion: boolean;
  /** 0..1 lime heat from how many court hours are free. */
  glow: number;
  /** Bounds of the reserved hero area in viewport pixels. */
  anchor?: { x: number; y: number; width: number; height: number };
  /** 0 holds the scene in the hero stage, 1 lets it fly down the page margins. */
  hand?: number;
};

/**
 * Làm gì: Dựng và vẽ toàn bộ cảnh thể thao 3D (cầu lông, cây vợt, bóng rổ, bóng chuyền, bóng đổ và các hiệu ứng va chạm) lên canvas WebGL2 dựa trên tiến trình cuộn trang và thời gian thực.
 * Được gọi ở: src/client/components/landing/shuttle3d.tsx (hàm frame trong vòng lặp animation hoặc hàm still khi bật chế độ giảm chuyển động).
 * @param L Đối tượng quản lý WebGL2 context và tài nguyên hình học/shader (Shuttle3D).
 * @param S Trạng thái cảnh biến đổi giữa các frame (SceneState) lưu tiến trình cuộn và góc nghiêng chuột.
 * @param o Tùy chọn cấu hình vẽ (SceneOpts) gồm thời gian thực, cờ giảm chuyển động, hiệu ứng phát sáng, vùng neo hero và tỉ lệ hòa trộn chuyển giao.
 * @returns true nếu vẽ thành công lên canvas WebGL2, ngược lại false nếu context bị lỗi hoặc không khả dụng.
 */
export function drawScene(L: Shuttle3D, S: SceneState, o: SceneOpts): boolean {
  const { time, motion: MOTION } = o;
  return L.draw((gl, Lx, cssW, cssH) => {
    // Bước 1: Tính toán không gian bố cục, ma trận chiếu phối cảnh, vị trí vật thể trên đường ray và tỷ lệ bàn giao giữa hero stage với lề trang.
    const narrow = cssW <= 1024;
    const p = S.p;
    // Out of the hero the scene keeps to the page margins and runs smaller, so it rides beside
    // the copy instead of over it. `hand` blends from the hero stage into that lane.
    const hand = o.anchor ? clamp(o.hand ?? 0, 0, 1) : 1;
    const free = sampleLane(p, narrow);
    // Hòa trộn vị trí neo trong hero stage sang đường ray lề trang (margin lane) để không đè lên chữ.
    const lane = o.anchor
      ? {
          x: lerp((o.anchor.x + o.anchor.width * 0.56) / cssW, free.x, hand),
          y: lerp((o.anchor.y + o.anchor.height * 0.53) / cssH, free.y, hand),
          s: lerp(0.74, free.s, hand),
        }
      : free;
    const cx = lane.x * cssW, cy = lane.y * cssH;
    const laneBase = narrow ? Math.max(cssH * 0.3, 240) * 0.92 : Math.max(Math.min(cssW * 0.3, cssH * 0.62), 300) * 0.6;
    const base = o.anchor ? lerp(Math.min(o.anchor.width * 0.95, o.anchor.height * 1.2), laneBase, hand) : laneBase;
    const cast = castAt(p);
    const sport = cast.sport, rawBall = cast.rawBall;
    const zoom = zoomAt(p, narrow);
    const size = base * lane.s;
    // Tính khoảng cách camera Dz (kèm hiệu ứng zoomAt) và kích thước vật thể chuẩn hóa sW trong không gian 3D.
    const Dz = (D0 * (1 - (narrow ? 0.08 : 0.12) * Math.sin(p * Math.PI))) / zoom;
    const sW = (size * 2 * D0 * TANH) / (cssH * 3.2);
    // bob: Hiệu ứng nhấp nhô lơ lửng dạng sóng sin; shift: Dịch chuyển tâm hình chiếu phối cảnh theo chuột.
    const bobN = MOTION ? Math.sin(time * 1.25) : 0, bob = bobN * sW * 0.08;
    const shift = [(cx / cssW) * 2 - 1 + S.ry * 0.03, 1 - (cy / cssH) * 2];
    const P = persp(FOV, cssW / cssH, 0.1, 60), pitch = rx(0.2);
    const leave = rawBall;
    const contactP = narrow ? 0.028 : 0.046;
    const morph = rawBall * (1 - rawBall);

    // Swing clock. Reduced motion freezes on the contact pose.
    // Bước 2: Cập nhật đồng hồ vung vợt (swing clock) và lực va chạm đập cầu (hit & knock impulse).
    const K = narrow ? SWING.narrow : SWING.wide;
    let st: number;
    if (MOTION) {
      if (S.swT0 < 0) S.swT0 = time + 0.7;
      // Khi cuộn xuống rồi quay lại đầu trang (p < 0.015), nạp lại (re-arm) để vợt thực hiện lại cú đập chào đón.
      if (p > 0.1) S.swArmed = true;
      else if (S.swArmed && p < 0.015) { S.swArmed = false; S.swT0 = time + 0.15; }
      st = time - S.swT0;
    } else st = T_HIT;
    const age = st - T_HIT;
    // hit: Xung va chạm phân phối chuẩn tại thời điểm tiếp xúc T_HIT; knock: Lực đẩy văng quả cầu đi sau cú đập.
    const hit = MOTION ? Math.exp(-(age * age) / (0.06 * 0.06)) : 0;
    const knock = MOTION && age > 0 ? (Math.exp(-4.5 * age) * Math.sin(9 * age)) / 0.51 : 0;
    const kvx = -Math.cos(K.hit), kvy = -Math.sin(K.hit);

    // Shuttle: shrinks and twists as it hands over to the ball, squashes on the hit and gets knocked away.
    // Bước 3: Thiết lập ma trận biến đổi (model matrix) cho quả cầu lông, tích hợp lực đập văng, co ép va chạm và xoay hướng.
    const shSpinAt = (h: number, kn: number) =>
      chain(pitch,
        rx(S.rx + Math.sin(p * Math.PI) * 0.35 + leave * 0.22), ry(S.ry + p * 1.4 + leave * 0.32 + morph * 2),
        rz(-0.48 + p * 0.7 + leave * 0.22 - h * 0.55 - kn * 0.35), rx(0.22),
        ry(S.yaw), tr(0, -0.78, 0));
    // Quả cầu thu nhỏ dần và biến dạng co bẹp (squash: giảm X, Z, tăng Y) tại thời điểm bị vợt đập trúng.
    const shS = sW * (1 - 0.5 * eIn3(rawBall)) * (narrow ? 1 : 1 + leave * 0.04);
    const shRest = shSpinAt(0, 0);
    const cX = 0, cY = bob, cZ = -Dz;
    const shModel = chain(tr(kvx * knock * 0.3 * shS, bob + kvy * knock * 0.3 * shS, -Dz), sc(shS),
      sc3(1 - 0.2 * hit, 1 + 0.16 * hit, 1 - 0.2 * hit), shSpinAt(hit, knock));
    const shReflect = chain(tr(0, -shS * 1.72, -Dz), sc3(shS, -shS * 0.28, shS), shRest);
    const shuttleA = cast.shuttle;

    // Racket: anchored so the string bed meets the shuttle at the hit angle.
    // In the hero stage the racket serves once and then leaves, so the shuttle rests on its own;
    // the still pose under reduced motion shows the shuttle alone.
    // Bước 4: Thiết lập mô hình và tư thế cây vợt, căn chỉnh mặt lưới vợt đón trúng quả cầu tại góc vung đập.
    const stageFade = o.anchor ? (MOTION ? 1 - smo((st - T_SETTLE - 0.4) / 0.7) : 0) : 1;
    const rVis = (1 - smo((p - (narrow ? 0.024 : 0.03)) / (narrow ? 0.02 : 0.03))) * cast.shuttle * stageFade;
    const rS = shS * K.size, Hp = RK.headY * Math.cos(TILT) * rS;
    const hX = cX + Math.cos(K.hit) * 0.5 * shS, hY = cY + Math.sin(K.hit) * 0.5 * shS;
    const pbX = hX + Math.sin(K.hit) * Hp + 0.15 * rS, pbY = hY - Math.cos(K.hit) * Hp;
    // Hàm tính ma trận Model-View của cây vợt tại thời điểm t, căn theo điểm tựa cán vợt (pbX, pbY).
    const racketAt = (t: number) => {
      const q = swingPose(t, K);
      return {
        q,
        mv: chain(tr(pbX + q.px * rS, pbY + q.py * rS, cZ + 0.25 * shS),
          sc(rS * Math.max(0.001, q.s * (0.55 + 0.45 * rVis))), rz(q.a), rx(TILT), ry(q.face)),
      };
    };
    const rk = racketAt(st);
    // spd và ghostK: Vận tốc góc tức thời của vợt giữa 2 khung hình để kích hoạt bóng mờ chuyển động khi vung nhanh.
    const spd = Math.abs(rk.q.a - swingPose(st - 0.016, K).a) / 0.016;
    const ghostK = MOTION ? clamp((spd - 2) / 10, 0, 1) : 0;

    // Ball: grows in with a slight overshoot, counter-twists out of the shuttle, then bounces.
    // Bước 5: Thiết lập trạng thái quả bóng (bóng rổ / bóng chuyền), kích hoạt các đợt nảy chạm sàn khi cuộn đến mốc tương ứng.
    const H0 = narrow ? 1.1 : 1.45;
    if (MOTION) {
      if (cast.ball < 0.05) S.bzT0 = -1;
      if (p < 0.42) S.bzA1 = true;
      if (p < 0.78) S.bzA2 = true;
      if (S.bzA1 && p >= 0.47 && cast.ball > 0.9) { S.bzA1 = false; S.bzT0 = time; }
      if (S.bzA2 && p >= 0.86) { S.bzA2 = false; S.bzT0 = time; }
    }
    const bAge = MOTION && S.bzT0 >= 0 ? time - S.bzT0 : -1;
    const bo = bounceAt(bAge, H0), hn = bo.h / H0;
    // ballSpin và ballModel: Tích hợp góc tự quay của bóng, hiệu ứng nhún nảy biến dạng đàn hồi (bsy, bsx) và phản chiếu mặt sàn.
    const ballSpin = chain(pitch,
      rx(0.25 + sport * 0.35 + S.rx * 0.4 + bo.sq * 0.4),
      ry((MOTION ? S.yaw : 0.6) * (1.15 + sport * 0.2) + p * (2.1 + sport * 0.25) + (cast.rawVolley * 0.45) - morph * 2.4),
      rz(-0.25 + sport * 0.28));
    const sportDip = 1 - (narrow ? 0.03 : 0.06) * Math.sin(cast.rawVolley * Math.PI);
    const ballS = sW * (0.3 + 0.7 * Math.max(0, eBack(rawBall, 1.6))) * sportDip * (0.9 + sport * 0.16);
    const bsy = 1 - bo.sq + bo.st, bsx = 1 + bo.sq * 0.5 - bo.st * 0.45;
    const yG = -1.08 * ballS, ballY = 1.08 * ballS * (bsy - 1 + bo.h);
    const ballModel = chain(tr(0, ballY, -Dz), sc3(ballS * bsx, ballS * bsy, ballS * bsx), ballSpin);
    const ballReflect = chain(tr(0, -ballS * 1.15 - ballY * 0.22, -Dz), sc3(ballS * bsx, -ballS * 0.22 * bsy, ballS * bsx), ballSpin);
    const ballA = cast.ball;
    const ex = lane.x > 0.5 ? (cast.ball > 0.5 ? -0.04 : -0.1) : -0.02;

    /**
     * Làm gì: Thiết lập shader, nạp uniform và thực hiện lệnh vẽ đối tượng hình học 3D (cầu lông, vợt, bóng).
     * Được gọi ở: Nội bộ hàm drawScene để vẽ từng thành phần vật thể 3D.
     * @param vao Đối tượng đỉnh Vertex Array Object của vật thể cần vẽ.
     * @param count Số lượng đỉnh (vertex indices) cần vẽ.
     * @param mv Ma trận Model-View 4x4 xác định vị trí, góc xoay và tỉ lệ của vật thể.
     * @param alpha Độ mờ đục tổng thể (0 đến 1).
     * @param pass Lượt vẽ trong shader (0: phần đục, 1: lông vũ/xuyên thấu, 2: bóng đổ/vợt, 3: phản chiếu sàn).
     * @param test Có bật kiểm tra độ sâu depth test hay không.
     * @param write Có ghi đè lên bộ đệm độ sâu depth buffer hay không.
     * @param extraX Độ lệch phụ thêm theo trục X.
     * @param sportU Hệ số pha trộn giữa bóng rổ và bóng chuyền (0: rổ, 1: chuyền).
     * @param shiftOv Tùy chọn ghi đè tọa độ dịch chuyển tâm hình chiếu 2D.
     */
    const mesh = (vao: WebGLVertexArrayObject, count: number, mv: Float32Array, alpha: number, pass: number,
      test: boolean, write: boolean, extraX: number, sportU: number, shiftOv?: number[]) => {
      if (alpha < 0.02) return;
      if (test) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
      gl.depthMask(write);
      gl.useProgram(Lx.pm); gl.bindVertexArray(vao);
      gl.uniformMatrix4fv(Lx.um.uP, false, P); gl.uniformMatrix4fv(Lx.um.uMV, false, mv);
      const sh = shiftOv || shift;
      gl.uniform2f(Lx.um.uShift, sh[0] + extraX, sh[1]);
      gl.uniform1f(Lx.um.uGlow, o.glow);
      gl.uniform1f(Lx.um.uAlpha, Math.min(1, alpha));
      gl.uniform1f(Lx.um.uTime, time);
      gl.uniform1f(Lx.um.uSport, sportU);
      gl.uniform1i(Lx.um.uPass, pass);
      gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, 0);
    };
    // Flat quads: contact shadows (shadow program) and the impact ring / dust (fx program).
    /**
     * Làm gì: Vẽ mặt phẳng 2D (quad) dẹt cho bóng đổ sàn (contact shadow) hoặc hiệu ứng vòng sóng bụi/lóe sáng va chạm (fx dust/flash).
     * Được gọi ở: Nội bộ hàm drawScene để vẽ bóng tiếp xúc sàn và hiệu ứng tia chớp đập cầu.
     * @param mv Ma trận Model-View 4x4 xác định vị trí và kích thước mặt phẳng.
     * @param a Độ trong suốt alpha của hiệu ứng.
     * @param fx true nếu dùng shader hiệu ứng lóe sáng/bụi (fx), false nếu dùng shader bóng đổ sàn (shadow).
     * @param k Tiến trình hiệu ứng từ 0 đến 1 (độ giãn nở vòng sóng).
     * @param mode Chế độ hiệu ứng (0: tia chớp lóe sáng điểm chạm vợt, 1: vòng bụi bay khi bóng chạm đất).
     */
    const quad = (mv: Float32Array, a: number, fx: boolean, k: number, mode: number) => {
      if (a < 0.01) return;
      gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
      const pr = fx ? Lx.pf : Lx.ps, un = fx ? Lx.uf : Lx.us;
      gl.useProgram(pr); gl.bindVertexArray(Lx.vq);
      gl.uniformMatrix4fv(un.uP, false, P); gl.uniformMatrix4fv(un.uMV, false, mv);
      gl.uniform2f(un.uShift, shift[0], shift[1]);
      gl.uniform1f(un.uA, Math.min(1, a));
      if (fx) { gl.uniform1f(un.uK, k); gl.uniform1i(un.uMode, mode); }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    // Bước 6: Khởi tạo chế độ pha trộn màu alpha (premultiplied blending) và thực hiện quy trình vẽ (render pipeline).
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST); gl.depthMask(false);
    // Contact shadows. The ball's shadow tightens and darkens as it nears the floor.
    // The hero stage has no floor under the shuttle, so it gets no shadow, reflection or trail.
    // The shuttle is only ever airborne here, so its floor shadow and reflection stay off; the ball
    // gets its floor once it lands in the margin lane.
    const floor = 0;
    quad(chain(tr(0, -shS * 1.35, -Dz), pitch, sc(shS * 1.15)), Math.min(0.9, (0.55 - bobN * 0.08) * shuttleA) * floor, false, 0, 0);
    quad(chain(tr(0, yG * 1.06, -Dz), pitch, sc(ballS * 1.15 * (1 - 0.45 * hn) * (1 + 0.4 * bo.sq))),
      Math.min(0.9, (0.6 * (1 - 0.55 * hn) + 0.3 * bo.sq) * ballA), false, 0, 0);
    // Dust ring on the first three floor contacts.
    if (bAge >= 0) {
      for (let di = 0; di < 3; di++) {
        const da = bAge - B_IMP[di].t;
        if (da >= 0 && da < 0.5) quad(chain(tr(0, yG, -Dz), rx(0.42), sc(ballS * 1.9)), ballA * B_IMP[di].a, true, da / 0.5, 1);
      }
    }
    mesh(Lx.vm, Lx.count, shReflect, 0.26 * shuttleA * floor, 3, false, false, ex, 0);
    // Vẽ vệt mờ chuyển động (motion trail) nối từ vị trí khung hình trước của quả cầu lông.
    const trail = floor * smo(clamp((p - contactP) / 0.02, 0, 1)) * (1 - smo(clamp((p - 0.09) / 0.03, 0, 1)));
    if (trail > 0.05 && cast.shuttle > 0.2) {
      const prev = sampleLane(Math.max(0, p - (narrow ? 0.012 : 0.018)), narrow);
      mesh(Lx.vm, Lx.count, shModel, trail * 0.32 * shuttleA, 1, false, false, 0, 0,
        [prev.x * 2 - 1, 1 - prev.y * 2]);
    }
    // Vẽ quả cầu lông: pass 0 vẽ khối đặc ghi depth buffer, pass 1 vẽ lông vũ bán trong suốt.
    mesh(Lx.vm, Lx.count, shModel, shuttleA, 0, true, true, 0, 0);
    mesh(Lx.vm, Lx.count, shModel, shuttleA, 1, true, false, 0, 0);
    // Motion-blur ghosts trail the racket along its arc while it moves fast.
    const GA = [0.42, 0.26, 0.14];
    if (ghostK > 0.01 && rVis > 0.02) {
      for (let gi = 3; gi >= 1; gi--) {
        const gr = racketAt(st - gi * 0.028);
        mesh(Lx.rm, Lx.rcount, gr.mv, GA[gi - 1] * ghostK * rVis * gr.q.al, 4, false, false, 0, 0);
      }
    }
    // Vẽ thân và lưới cây vợt chính (pass 2).
    mesh(Lx.rm, Lx.rcount, rk.mv, rVis * rk.q.al, 2, true, true, 0, 0);
    // Lime flash and ring at the contact point.
    if (MOTION && age >= 0 && age < 0.5) {
      quad(chain(tr(hX, hY, cZ + 0.6 * shS), sc(shS * K.ring), rx(Math.PI / 2)), rVis, true, age / 0.5, 0);
    }
    // Xóa bộ đệm độ sâu trước khi vẽ quả bóng để tránh bị các vật thể vẽ trước che khuất sai.
    if (ballA > 0.02) gl.clear(gl.DEPTH_BUFFER_BIT);
    // Vẽ bóng phản chiếu trên sàn và mô hình quả bóng 3D (bóng rổ / bóng chuyền qua uniform uSport).
    mesh(Lx.bm, Lx.bcount, ballReflect, 0.22 * ballA * (1 - 0.7 * hn), 3, false, false, ex, sport);
    mesh(Lx.bm, Lx.bcount, ballModel, ballA, 2, true, true, 0, sport);
    gl.depthMask(true);
    gl.bindVertexArray(null);
  });
}
