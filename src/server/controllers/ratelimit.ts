/**
 * File: src/server/controllers/ratelimit.ts
 * Vai trò: Cơ chế giới hạn tần suất gọi API (rate limiter) theo thuật toán sliding-window in-memory, lưu trực tiếp trong RAM.
 * Vị trí trong app: Chạy ở tầng server backend, được các API handler (auth, chat, plans, ops, avatar, assets, sports) và session.ts gọi để ngăn chặn spam, chống click đúp hoặc vòng lặp request bất thường mà không cần truy vấn cơ sở dữ liệu.
 */
import { err } from "./errors";

/**
 * A small in-process sliding-window limiter for endpoints that are cheap to
 * call and expensive to honour — plan requests, password changes, the
 * assistant.
 *
 * Deliberately in-memory: the limits here exist to stop one impatient member
 * double-tapping a button into twenty rows, not to defend against a botnet. A
 * shared store would mean a round trip to Postgres on the happy path of every
 * request, which is the opposite of what this codebase needs. On a serverless
 * platform each instance keeps its own counters, so a burst spread across
 * lambdas gets a slightly higher effective ceiling — still far below the
 * damage a tight client loop can do, which is the case we actually hit.
 */

// Đại diện cho mốc thời gian (epoch milliseconds) của một lượt gọi API được lưu trong cửa sổ trượt.
type Hit = { at: number };

// Bảng băm lưu trữ danh sách các lượt gọi (Hit[]) theo từng khóa định danh (key) trong bộ nhớ RAM.
const buckets = new Map<string, Hit[]>();
/** Housekeeping: drop keys we have not seen in a while so the map cannot grow forever. */
let lastSweep = 0;

/**
 * Làm gì: Quét và dọn dẹp các bucket rate limit đã không hoạt động quá 1 giờ khỏi bộ nhớ để chống tràn RAM.
 * Được gọi ở: src/server/controllers/ratelimit.ts (bên trong hàm take).
 * @param now Thời điểm hiện tại tính bằng epoch milliseconds (Date.now()).
 * @returns void
 */
function sweep(now: number) {
  // Bước 1: Giới hạn tần suất dọn dẹp, chỉ quét nếu đã qua ít nhất 60 giây (60_000 ms) kể từ lần dọn trước để tiết kiệm CPU.
  if (now - lastSweep < 60_000) return;
  // Bước 2: Cập nhật thời điểm dọn dẹp gần nhất bằng mốc thời gian hiện tại.
  lastSweep = now;
  // Bước 3: Duyệt qua tất cả các bucket trong Map để giải phóng bộ nhớ cho các khóa đã hết hạn.
  for (const [key, hits] of buckets) {
    // An hour past the longest window any caller uses.
    if (hits.length === 0 || now - hits[hits.length - 1]!.at > 3_600_000) buckets.delete(key);
  }
}

export type LimitRule = {
  /** How many calls are allowed inside the window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

/** The deployment proxy supplies the client IP; absent addresses share a bucket. */
/**
 * Làm gì: Trích xuất địa chỉ IP của client từ header x-forwarded-for do reverse proxy cung cấp, dùng làm định danh giới hạn tần suất.
 * Được gọi ở: src/server/controllers/handlers/auth.ts (trong sendOtpHandler và verifyOtpHandler).
 * @param request Đối tượng Request HTTP nhận từ trình duyệt client.
 * @returns Chuỗi địa chỉ IP gốc của client, hoặc "unknown" nếu không tìm thấy header.
 */
export function requestIp(request: Request): string {
  // Lấy địa chỉ IP đầu tiên trong chuỗi x-forwarded-for (IP nguyên bản của client trước khi qua proxy trung gian).
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/**
 * Làm gì: Định nghĩa bảng cấu hình hạn ngạch giới hạn tần suất (LimitRule) cho từng loại thao tác và endpoint trong hệ thống.
 * Được gọi ở: Khắp các API handler (auth.ts, chat.ts, plans.ts, ops.ts, assets.ts, avatar.ts, sports.ts), session.ts và ratelimit.test.ts.
 */
export const RULES = {
  // Gửi mã OTP theo địa chỉ IP: tối đa 20 lần trong 15 phút (900_000 ms) để chặn spam diện rộng từ một địa chỉ mạng.
  authSendIp: { limit: 20, windowMs: 900_000 },
  // Gửi mã OTP theo định danh (số điện thoại hoặc email): tối đa 5 lần trong 15 phút để bảo vệ người dùng và tiết kiệm chi phí dịch vụ gửi mã.
  authSendIdentity: { limit: 5, windowMs: 900_000 },
  // Thử nhập mã OTP theo địa chỉ IP: tối đa 30 lần trong 15 phút nhằm ngăn tấn công vét cạn (brute-force).
  authVerifyIp: { limit: 30, windowMs: 900_000 },
  // Thử nhập mã OTP theo số điện thoại: tối đa 10 lần trong 15 phút để khóa hành vi đoán mò mã xác thực.
  authVerifyIdentity: { limit: 10, windowMs: 900_000 },
  /** Buying or renewing a plan. One a minute is generous for a real purchase. */
  planRequest: { limit: 3, windowMs: 60_000 },
  /** Cumulative guard so a member cannot queue twenty pending requests over an hour. */
  planRequestHourly: { limit: 10, windowMs: 3_600_000 },
  /** Assistant turns — each one costs a model call (FR-A03). */
  assistant: { limit: 20, windowMs: 60_000 },
  /**
   * Opening a support request, from the form or from the assistant.
   *
   * Reception reads these by hand, so the real ceiling is how many a person can
   * be answered — not how many a browser can post. Matches `planRequest`: three
   * in a minute covers a double-tap and a correction, and no more.
   */
  ticketCreate: { limit: 3, windowMs: 60_000 },
  /** Cumulative guard so one member cannot bury the desk queue over an hour. */
  ticketCreateHourly: { limit: 10, windowMs: 3_600_000 },
  /** Chat messages — generous, because a real conversation is bursty. */
  chatMessage: { limit: 25, windowMs: 10_000 },
  /**
   * WebRTC signaling: polls, offers, answers and ICE candidates.
   *
   * Sized from the client's own loop, not from the small numbers above: while a
   * pair is still connecting `p2p.ts` polls every 400ms (~150/minute), and each
   * poll can be followed by signal posts. 400 a minute leaves room for a busy
   * negotiation and still stops a tight loop, which matters because every poll
   * writes a heartbeat row and runs two deletes.
   */
  rtcSignal: { limit: 400, windowMs: 60_000 },
  /**
   * The relay as a whole, per person rather than per room.
   *
   * `rtcSignal` is charged once the room is known, which means a request that
   * is rejected for a missing or malformed room never reaches it. This one is
   * charged first, before anything is parsed, so a loop posting junk still
   * costs its caller something. Wide on purpose: somebody with several
   * conversations open is legitimately doing several rooms' worth of polling,
   * and this is here to stop a loop, not to shape normal use.
   */
  rtcEndpoint: { limit: 2000, windowMs: 60_000 },
  /** Password changes. */
  passwordChange: { limit: 5, windowMs: 900_000 },
  /** Profile edits. */
  profileUpdate: { limit: 10, windowMs: 300_000 },
  /** Manager media asset uploads. */
  assetUpload: { limit: 60, windowMs: 60_000 },
  /** A member changing their own profile photo. */
  avatarUpload: { limit: 10, windowMs: 600_000 },
  /** Manager sport mutations. */
  sportMutation: { limit: 60, windowMs: 60_000 },
} satisfies Record<string, LimitRule>;

/**
 * Record a call against `key`. Returns the seconds the caller must wait when
 * the window is full, or `0` when the call is allowed.
 */
/**
 * Làm gì: Ghi nhận một lượt gọi theo khóa (key) theo quy tắc sliding window; trả về 0 nếu hợp lệ hoặc số giây cần chờ nếu đã vượt giới hạn.
 * Được gọi ở: Hàm limit trong file này, và bộ kiểm thử (src/server/controllers/ratelimit.test.ts, tx.test.ts).
 * @param key Khóa định danh phân biệt cần áp dụng giới hạn (ví dụ: `otp-send:ip:...`, `chat:...`, `ticket:...`).
 * @param rule Quy tắc giới hạn tần suất LimitRule gồm số lượt tối đa (limit) và khoảng thời gian (windowMs).
 * @param now Mốc thời gian hiện tại tính bằng milliseconds (mặc định là Date.now(), có thể truyền vào khi viết unit test).
 * @returns Số giây (làm tròn lên) người dùng phải chờ trước khi được thử lại; trả về 0 nếu yêu cầu được chấp nhận.
 */
export function take(key: string, rule: LimitRule, now = Date.now()): number {
  // Bước 1: Kích hoạt dọn dẹp các bucket cũ đã hết hạn nếu cần thiết.
  sweep(now);
  // Bước 2: Tính mốc thời gian biên và lọc bỏ các lượt gọi đã trôi ra ngoài cửa sổ trượt (sliding window).
  const cutoff = now - rule.windowMs;
  const hits = (buckets.get(key) ?? []).filter((h) => h.at > cutoff);
  // Bước 3: Nếu số lượt gọi đã chạm ngưỡng limit, lưu lại danh sách đã lọc và tính số giây người dùng cần chờ.
  if (hits.length >= rule.limit) {
    buckets.set(key, hits);
    // Tính thời gian chờ dựa trên lượt gọi cũ nhất còn hiệu lực trong cửa sổ, làm tròn lên giây nguyên (tối thiểu 1 giây).
    const oldest = hits[0]!.at;
    return Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000));
  }
  // Bước 4: Chưa vượt giới hạn, ghi nhận lượt gọi mới vào mảng hits và cập nhật lại Map.
  hits.push({ at: now });
  buckets.set(key, hits);
  // Trả về 0 báo hiệu yêu cầu được phép thông qua.
  return 0;
}

/** `take`, but throws the 429 for you. */
/**
 * Làm gì: Kiểm tra tần suất gọi và tự động ném ngoại lệ ApiError 429 (RATE_LIMITED) nếu yêu cầu vượt quá giới hạn cho phép.
 * Được gọi ở: Khắp các API handlers (auth.ts, chat.ts, plans.ts, ops.ts, assets.ts, avatar.ts, sports.ts) và session.ts.
 * @param key Khóa định danh áp dụng giới hạn (theo IP, userId hoặc hành động cụ thể).
 * @param rule Quy tắc giới hạn tần suất LimitRule áp dụng cho khóa này.
 * @param what Tên hành động để đưa vào câu thông báo lỗi thân thiện (mặc định là "requests", ví dụ: "chat messages", "questions").
 * @returns void
 * @throws ApiError (mã RATE_LIMITED, HTTP 429) kèm thông báo số giây hoặc phút cần chờ nếu vượt giới hạn.
 */
export function limit(key: string, rule: LimitRule, what = "requests"): void {
  // Bước 1: Ghi nhận yêu cầu qua hàm take để lấy thời gian chờ retry (tính bằng giây).
  const retry = take(key, rule);
  // Nếu retry === 0 tức là yêu cầu hợp lệ, cho phép tiếp tục mà không làm gì thêm.
  if (retry === 0) return;
  // Bước 2: Định dạng chuỗi thời gian chờ sang đơn vị phút (nếu >= 60 giây) hoặc giây để người dùng dễ hiểu.
  const wait = retry >= 60 ? `${Math.ceil(retry / 60)} minute${retry >= 120 ? "s" : ""}` : `${retry} seconds`;
  // Bước 3: Ném ngoại lệ lỗi 429 RATE_LIMITED dừng ngay luồng xử lý của request.
  throw err.rateLimited(`Too many ${what} — try again in ${wait}.`);
}

/** Forget a key, e.g. once the action it guarded succeeded in a way that should reset it. */
/**
 * Làm gì: Xóa bỏ dữ liệu của một khóa (key) khỏi bảng buckets, hoàn trả toàn bộ định mức ngay lập tức khi thao tác cần bảo vệ đã thành công.
 * Được gọi ở: Tiện ích controller khi cần xóa bỏ giới hạn tần suất sau khi người dùng hoàn thành hành động hợp lệ.
 * @param key Khóa định danh rate limit cần xóa.
 * @returns void
 */
export function reset(key: string): void {
  buckets.delete(key);
}

/** Test seam. */
/**
 * Làm gì: Xóa sạch toàn bộ dữ liệu rate limit và đặt lại mốc sweep về 0 để cô lập môi trường giữa các ca kiểm thử.
 * Được gọi ở: test runner (node --test) trong src/server/controllers/ratelimit.test.ts và src/server/controllers/tx.test.ts.
 * @returns void
 */
export function clearAll(): void {
  // Bước 1: Xóa sạch toàn bộ các bucket đang lưu trong Map.
  buckets.clear();
  // Bước 2: Đặt lại mốc thời gian dọn dẹp sweep về 0.
  lastSweep = 0;
}
