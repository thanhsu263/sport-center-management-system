/**
 * Quản lý các quy tắc nghiệp vụ cốt lõi không phụ thuộc cơ sở dữ liệu (in-memory business rules).
 * File hoàn toàn không import thư viện ngoài để test runner có thể nạp trực tiếp qua `node --experimental-strip-types`.
 * Định nghĩa các logic xác thực: giá sân, chiết khấu gói tập, bảng giá price_rules,
 * bóc tách tiền tố ticket hỗ trợ khách hàng, thời hạn điểm danh lớp học (BR-35), cảnh báo chuỗi vắng mặt (BR-36),
 * chỉ số tập luyện (FR-TRN-05), bài tập về nhà và tính toán giảm giá mã khuyến mãi (FR-PAY-03, BR-42).
 */
/**
 * Business-rule checks that need no database.
 *
 * Kept free of imports so `arena3.test.ts` can load this file directly under
 * `node --experimental-strip-types`, the same way it loads `time.ts`.
 */

/**
 * Ceiling for one 60-minute slot, in VND.
 *
 * The dearest real rule is basketball peak at 500,000đ. The ceiling sits ten
 * times above that so a genuine price rise never trips it, and far enough
 * below 99,999,999đ that a typo — or somebody leaning on the demo manager
 * login — cannot quote an 80-million-dong badminton court again.
 */
/**
 * Làm gì: Mức giá trần tối đa cho một ca thuê sân 60 phút (5.000.000đ), ngăn chặn nhập sai giá hoặc gian lận giá quá cao.
 * Được gọi ở: Nội bộ src/server/services/rules.ts (các hàm slotPriceOk, validatePriceRules).
 */
export const MAX_SLOT_PRICE_VND = 5_000_000;

/**
 * Làm gì: Danh sách các loại ngày áp dụng cho quy tắc giá sân: ngày thường (weekday), cuối tuần (weekend) và ngày lễ (holiday).
 * Được gọi ở: src/server/services/rules.ts (hàm validatePriceRules).
 */
export const DAY_KINDS = ["weekday", "weekend", "holiday"] as const;

/** A slot price the centre could actually charge: whole đồng, above 0, at most the ceiling. */
/**
 * Làm gì: Kiểm tra giá thuê sân hợp lệ: phải là số nguyên, lớn hơn 0đ và không vượt quá mức trần MAX_SLOT_PRICE_VND (5.000.000đ).
 * Được gọi ở: src/server/services/pricing.ts (hàm lookupPrice kiểm tra BR-37), src/server/services/rules.ts (validatePriceRules), src/server/services/arena3.test.ts.
 * @param price Giá tiền ca thuê sân cần kiểm tra (kiểu unknown).
 * @returns Type predicate (price is number) là true nếu giá hợp lệ, ngược lại false.
 */
export function slotPriceOk(price: unknown): price is number {
  return typeof price === "number" && Number.isInteger(price) && price > 0 && price <= MAX_SLOT_PRICE_VND;
}

/** BR-17 — a plan discount is a whole percentage in [0, 100]. */
/**
 * Làm gì: Kiểm tra tỷ lệ phần trăm giảm giá của gói tập có hợp lệ theo quy tắc BR-17: phải là số nguyên trong đoạn [0, 100].
 * Được gọi ở: src/server/services/arena3.test.ts (test runner: node --test).
 * @param pct Giá trị phần trăm giảm giá cần kiểm tra.
 * @returns Type predicate (pct is number) là true nếu là số nguyên từ 0 đến 100, ngược lại false.
 */
export function discountPctOk(pct: unknown): pct is number {
  return typeof pct === "number" && Number.isInteger(pct) && pct >= 0 && pct <= 100;
}

/** BR-12 — a plan grants benefits only while start_on ≤ today ≤ end_on (all YYYY-MM-DD). */
/**
 * Làm gì: Kiểm tra gói tập có đang trong thời hạn hiệu lực tại một ngày cụ thể theo quy tắc BR-12 (start_on <= today <= end_on).
 * Được gọi ở: src/server/services/arena3.test.ts (test runner: node --test).
 * @param startOn Ngày bắt đầu gói tập (chuỗi ISO YYYY-MM-DD).
 * @param endOn Ngày kết thúc gói tập (chuỗi ISO YYYY-MM-DD).
 * @param today Ngày hiện tại cần đối soát (chuỗi ISO YYYY-MM-DD).
 * @returns true nếu today nằm trong khoảng từ startOn đến endOn, ngược lại false.
 */
export function planActiveOn(startOn: string, endOn: string, today: string): boolean {
  return startOn <= today && today <= endOn;
}

export type PriceRuleInput = {
  sport: string;
  court_id: string | null;
  day_kind: string;
  start_local: string;
  end_local: string;
  price_vnd: number;
  is_peak: boolean;
};

// Regex kiểm tra định dạng giờ phút hợp lệ trong ngày: HH:MM hoặc HH:MM:00 (từ 00:00 đến 23:59).
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)(:00)?$/;

/**
 * Làm gì: Quy đổi chuỗi giờ phút dạng HH:MM thành số phút tính từ 00:00 trong ngày để dễ dàng so sánh thời gian.
 * Được gọi ở: Nội bộ src/server/services/rules.ts (hàm validatePriceRules).
 * @param hm Chuỗi thời gian cục bộ dạng HH:MM hoặc HH:MM:SS.
 * @returns Số phút tính từ 00:00 (ví dụ "01:30" trả về 90).
 */
function minutesOf(hm: string): number {
  return Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
}

/**
 * Làm gì: Làm sạch chuỗi đầu vào bằng cách cắt tỉa khoảng trắng thừa; trả về null nếu giá trị rỗng hoặc không phải string.
 * Được gọi ở: Nội bộ src/server/services/rules.ts (hàm validatePriceRules).
 * @param v Giá trị cần kiểm tra và chuẩn hóa (kiểu unknown).
 * @returns Chuỗi ký tự đã trim, hoặc null nếu không có nội dung hợp lệ.
 */
function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/**
 * Check a full price table before it replaces the old one.
 *
 * `PUT /v1/price-rules` deletes every rule and inserts the new set, so a bad
 * row must be caught before the delete, not by a constraint halfway through.
 * Two rules covering the same minute for the same sport, court and day kind are
 * refused too: `lookupPrice` would pick one of them silently.
 */
/**
 * Làm gì: Xác thực toàn bộ bảng quy tắc giá sân trước khi xóa cũ chèn mới (PUT /v1/price-rules). Kiểm tra hợp lệ môn thể thao, loại ngày, định dạng giờ HH:MM, thời gian bắt đầu < kết thúc, đơn giá hợp lệ, và không bị chồng chéo khung giờ.
 * Được gọi ở: src/server/controllers/handlers/desk.ts (hàm priceRulesPut, route PUT /v1/price-rules), src/server/services/arena3.test.ts.
 * @param items Danh sách các quy tắc giá thô gửi từ client lên.
 * @param validSports Danh sách mã môn thể thao hợp lệ đang hoạt động (tùy chọn).
 * @returns Đối tượng kết quả: { ok: true, rules } nếu toàn bộ hợp lệ; hoặc { ok: false, index, message } nếu có dòng lỗi.
 * @throws Không ném lỗi (trả về kết quả ok: false kèm thông báo lỗi).
 */
export function validatePriceRules(
  items: unknown[],
  validSports?: readonly string[],
): { ok: true; rules: PriceRuleInput[] } | { ok: false; index: number; message: string } {
  // Bước 1: Kiểm tra mảng quy tắc giá không được rỗng (bắt buộc có ít nhất một quy tắc giá).
  if (!items.length) return { ok: false, index: -1, message: "At least one price rule is required." };
  // Khởi tạo mảng chứa các quy tắc giá đã được làm sạch và chuẩn hóa.
  const rules: PriceRuleInput[] = [];
  // Bước 2: Duyệt qua từng dòng quy tắc để kiểm tra kiểu dữ liệu, định dạng giờ và giới hạn giá tiền.
  for (let i = 0; i < items.length; i += 1) {
    const it = (items[i] ?? {}) as Record<string, unknown>;
    const sport = text(it.sport);
    const day_kind = text(it.day_kind);
    const start_local = text(it.start_local);
    const end_local = text(it.end_local);
    const price = typeof it.price_vnd === "string" ? Number(it.price_vnd) : it.price_vnd;
    // Kiểm tra mã môn thể thao: phải thuộc danh sách môn hợp lệ hoặc khớp định dạng [a-z0-9_-].
    if (!sport || (validSports ? !validSports.includes(sport) : !/^[a-z0-9_-]+$/.test(sport))) {
      return { ok: false, index: i, message: `Row ${i + 1}: unknown sport.` };
    }
    // Loại ngày bắt buộc phải là một trong 3 loại: weekday, weekend hoặc holiday.
    if (!day_kind || !(DAY_KINDS as readonly string[]).includes(day_kind)) {
      return { ok: false, index: i, message: `Row ${i + 1}: day kind must be weekday, weekend or holiday.` };
    }
    // Thời gian bắt đầu và kết thúc phải đúng định dạng giờ phút HH:MM.
    if (!start_local || !end_local || !HHMM.test(start_local) || !HHMM.test(end_local)) {
      return { ok: false, index: i, message: `Row ${i + 1}: times must be HH:MM.` };
    }
    // Giờ kết thúc ca thuê bắt buộc phải sau giờ bắt đầu.
    if (minutesOf(end_local) <= minutesOf(start_local)) {
      return { ok: false, index: i, message: `Row ${i + 1}: the end time must be after the start time.` };
    }
    // Đơn giá ca sân phải là số nguyên dương và không vượt quá mức trần 5.000.000đ (MAX_SLOT_PRICE_VND).
    if (!slotPriceOk(price)) {
      return {
        ok: false,
        index: i,
        message: `Row ${i + 1}: price must be a whole amount above 0đ and at most ${MAX_SLOT_PRICE_VND.toLocaleString("en-US")}đ per slot.`,
      };
    }
    // Thêm quy tắc đã kiểm tra hợp lệ vào danh sách chuẩn hóa.
    rules.push({
      sport,
      court_id: text(it.court_id),
      day_kind,
      start_local: start_local.slice(0, 5),
      end_local: end_local.slice(0, 5),
      price_vnd: price,
      is_peak: it.is_peak === true || it.is_peak === "true",
    });
  }
  // Bước 3: So sánh từng cặp quy tắc O(N^2) để phát hiện khung giờ bị chồng chéo (overlap) cùng môn, sân và loại ngày.
  for (let i = 0; i < rules.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      const a = rules[i];
      const b = rules[j];
      // Chỉ kiểm tra chồng lấn nếu cùng môn, cùng loại ngày và cùng sân (hoặc cùng áp dụng chung cho môn).
      if (a.sport !== b.sport || a.day_kind !== b.day_kind || a.court_id !== b.court_id) continue;
      // Hai khoảng thời gian [startA, endA) và [startB, endB) chồng nhau khi startA < endB và startB < endA.
      if (minutesOf(a.start_local) < minutesOf(b.end_local) && minutesOf(b.start_local) < minutesOf(a.end_local)) {
        return { ok: false, index: i, message: `Row ${i + 1} overlaps row ${j + 1} for the same sport and day.` };
      }
    }
  }
  // Bước 4: Toàn bộ bảng giá hợp lệ, trả về danh sách các quy tắc đã chuẩn hóa.
  return { ok: true, rules };
}

/**
 * A `ticket:` marker at the very start of what is left of the message. The
 * colon may be the full-width one a Vietnamese IME produces, and zero-width
 * characters pasted from chat apps count as blank.
 */
// Regex nhận diện tiền tố "ticket:" ở đầu tin nhắn: hỗ trợ dấu hai chấm kiểu Việt (\uFF1A) và bỏ qua ký tự khoảng trắng không độ rộng.
const TICKET_PREFIX = /^[\s\u200B-\u200D\uFEFF]*ticket[\s\u200B-\u200D\uFEFF]*[:\uFF1A][\s\u200B-\u200D\uFEFF]*/i;

/**
 * The note a `ticket:` message actually leaves at the desk.
 *
 * People type "ticket: ticket: the lights in BC2 are out" — the second prefix is
 * what you write when the first one did not look like it was heard. The desk was
 * then reading the word "ticket" back to itself before getting to the lights.
 *
 * The first prefix is the instruction: it is the thing that routed this message
 * to the desk at all, so it is consumed rather than stored. Every repeat of it is
 * the same instruction given again, so it goes too. Only leading repeats are
 * removed — a "ticket:" in the middle of a sentence is the member writing prose
 * about a ticket, and cutting it there would edit their complaint.
 *
 * What is left may be empty ("ticket:", "ticket:ticket:"). Callers refuse that
 * (FR-S03) rather than open a blank request. A message with no marker at all
 * comes back as it was, trimmed — that is the support form's path through here.
 */
/**
 * Làm gì: Lấy nội dung thực tế của yêu cầu hỗ trợ sau khi đã loại bỏ tiền tố ticket: (và các tiền tố lặp lại hoặc dấu ngoặc bọc ngoài). Trả về chuỗi gốc đã trim nếu không có tiền tố.
 * Được gọi ở: src/server/controllers/handlers/ops.ts (hàm assistantChat và ticketsCreate), src/server/services/arena3.test.ts.
 * @param message Chuỗi tin nhắn ban đầu do người dùng nhập.
 * @returns Nội dung yêu cầu hỗ trợ đã được loại bỏ tiền tố và làm sạch khoảng trắng.
 */
export function ticketBody(message: string): string {
  return stripTicketMarker(message) ?? trimBlank(message);
}

/**
 * Whether this message is addressed to the front desk (FR-S01).
 *
 * Only a marker at the very start counts. "L\u00E0m sao g\u00F3p \u00FD v\u1EC1 HLV?" and "Is there
 * a feedback form?" are questions the assistant can answer from the data block,
 * and routing them to reception meant nobody answered them at all.
 */
/**
 * Làm gì: Kiểm tra tin nhắn có phải là yêu cầu gửi đến quầy lễ tân (chứa tiền tố ticket: ở đầu) theo quy tắc FR-S01 hay không.
 * Được gọi ở: src/server/controllers/handlers/ops.ts (hàm assistantChat để chuyển tiếp tin nhắn đến lễ tân), src/server/services/arena3.test.ts.
 * @param message Chuỗi tin nhắn cần kiểm tra.
 * @returns true nếu tin nhắn bắt đầu bằng tiền tố ticket:, ngược lại false.
 */
export function isTicketMessage(message: string): boolean {
  return stripTicketMarker(message) !== null;
}

// Regex nhận diện các ký tự khoảng trắng thông thường và khoảng trắng vô hình (zero-width) ở đầu hoặc cuối chuỗi.
const BLANK_EDGES = /^[\s\u200B-\u200D\uFEFF]+|[\s\u200B-\u200D\uFEFF]+$/g;

/**
 * Quote pairs a member may put around the whole marker.
 *
 * The assistant's greeting used to show the syntax wrapped in guillemets, so
 * people typed those too, and the ASCII pair is what you write when your
 * keyboard has none. The desk then read the brackets back to itself.
 */
// Danh sách các cặp dấu ngoặc bao quanh (guillemets, ngoặc cong, nháy đơn, nháy kép) mà người dùng có thể bọc quanh tin nhắn.
const WRAPPERS: ReadonlyArray<readonly [string, string]> = [
  ["\u00AB", "\u00BB"],
  ["<<", ">>"],
  ["\u201C", "\u201D"],
  ["\u2018", "\u2019"],
  ['"', '"'],
  ["'", "'"],
];

/**
 * Làm gì: Cắt tỉa các ký tự khoảng trắng thông thường và ký tự vô hình (zero-width) ở đầu và cuối chuỗi.
 * Được gọi ở: Nội bộ src/server/services/rules.ts (các hàm ticketBody, unwrap, stripTicketMarker).
 * @param s Chuỗi ký tự cần cắt tỉa khoảng trắng.
 * @returns Chuỗi ký tự sau khi loại bỏ khoảng trắng hai đầu.
 */
function trimBlank(s: string): string {
  return s.replace(BLANK_EDGES, "");
}

/**
 * The inside of `body` when one quote pair wraps all of it, else `null`.
 *
 * "Starts with a quote and ends with a quote" is not the same as "is wrapped in
 * quotes": `"ticket: a" and "b"` satisfies the first and would come out as
 * `a" and "b`, with the member's own punctuation eaten. So for a symmetric pair
 * the inside has to be free of that character — an unbalanced one means the
 * outer two were never a pair. Distinct pairs like «» and <<>> cannot be
 * confused this way and only need the ends to match.
 */
/**
 * Làm gì: Bóc tách nội dung bên trong cặp dấu ngoặc bao quanh toàn bộ chuỗi (nếu khớp cặp trong WRAPPERS). Với dấu đối xứng như "...", đảm bảo bên trong không chứa ký tự dấu đó.
 * Được gọi ở: Nội bộ src/server/services/rules.ts (hàm stripTicketMarker).
 * @param body Chuỗi ký tự cần kiểm tra và bóc tách dấu bọc.
 * @returns Nội dung bên trong cặp dấu sau khi trim, hoặc null nếu không được bọc hợp lệ.
 */
function unwrap(body: string): string | null {
  // Duyệt qua từng cặp dấu ngoặc đóng mở trong danh sách WRAPPERS để thử bóc tách.
  for (const [open, close] of WRAPPERS) {
    if (body.length <= open.length + close.length) continue;
    if (!body.startsWith(open) || !body.endsWith(close)) continue;
    const inside = body.slice(open.length, body.length - close.length);
    // Đối với dấu ngoặc giống nhau (như " hoặc '): nếu bên trong vẫn còn ký tự đó thì đây không phải cặp bọc ngoài duy nhất.
    if (open === close && inside.includes(open)) continue;
    return trimBlank(inside);
  }
  return null;
}

/**
 * The note behind a `ticket:` marker, or `null` when there is no marker.
 *
 * One pass answers both questions this module is asked \u2014 "is this for the
 * desk?" and "what does the desk read?" \u2014 because answering them with two
 * separate tests is how routing came to accept messages that storing then
 * mangled.
 *
 * A wrapping quote pair is stripped only when a marker sits directly inside it.
 * The support form runs every message through `ticketBody`, so "The lights are
 * out" \u2014 quotes and all \u2014 has to survive untouched: those quotes are the
 * member's own.
 */
/**
 * Làm gì: Bóc tách tiền tố ticket: ở đầu tin nhắn (xử lý cả trường hợp lặp lại nhiều lần tiền tố hoặc được bọc trong cặp dấu ngoặc). Trả về null nếu không có tiền tố.
 * Được gọi ở: Nội bộ src/server/services/rules.ts (các hàm ticketBody và isTicketMessage).
 * @param message Chuỗi tin nhắn cần bóc tách tiền tố.
 * @returns Phần nội dung sau khi bỏ tiền tố ticket:, hoặc null nếu không có tiền tố.
 */
function stripTicketMarker(message: string): string | null {
  // Bước 1: Cắt tỉa khoảng trắng ở hai đầu chuỗi và khởi tạo cờ đánh dấu đã tìm thấy tiền tố ticket:.
  let body = trimBlank(message);
  let found = false;
  // Bước 2: Vòng lặp liên tục bóc tách các lớp ngoặc bọc ngoài và loại bỏ các tiền tố "ticket:" lặp lại ở đầu tin nhắn.
  for (;;) {
    // Bóc tách lớp ngoặc bên ngoài nếu bên trong chứa tiền tố ticket:.
    const inside = unwrap(body);
    if (inside !== null && TICKET_PREFIX.test(inside)) {
      body = inside;
      continue;
    }
    // Xóa tiền tố "ticket:" ở đầu và tiếp tục vòng lặp để xử lý các tiền tố bị người dùng nhập lặp lại.
    if (TICKET_PREFIX.test(body)) {
      body = trimBlank(body.replace(TICKET_PREFIX, ""));
      found = true;
      continue;
    }
    // Bước 3: Trả về nội dung sau khi dọn sạch tiền tố nếu tìm thấy ít nhất một tiền tố; ngược lại trả về null.
    return found ? body : null;
  }
}

// F4 training (Phase 4C)

/**
 * Làm gì: Danh sách 4 trạng thái điểm danh hợp lệ của học viên trong buổi tập: có mặt (present), đi muộn (late), vắng không phép (absent) và vắng có phép (excused).
 * Được gọi ở: src/server/services/rules.ts (hàm isAttResult).
 */
export const ATT_RESULTS = ["present", "late", "absent", "excused"] as const;
export type AttResult = (typeof ATT_RESULTS)[number];

/**
 * Làm gì: Kiểm tra một giá trị có phải là trạng thái điểm danh hợp lệ (present, late, absent, excused) hay không.
 * Được gọi ở: src/server/controllers/handlers/ops.ts (hàm sessionAttendancePost, route POST /v1/sessions/:id/attendance), src/server/services/arena3.test.ts.
 * @param v Giá trị cần kiểm tra (kiểu unknown).
 * @returns Type predicate (v is AttResult) là true nếu thuộc ATT_RESULTS, ngược lại false.
 */
export function isAttResult(v: unknown): v is AttResult {
  return typeof v === "string" && (ATT_RESULTS as readonly string[]).includes(v);
}

/** BR-35: a coach may correct a session's register for this long after it ends. */
/**
 * Làm gì: Giới hạn thời gian (2 giờ) sau khi ca học kết thúc cho phép huấn luyện viên chỉnh sửa sổ điểm danh theo quy tắc BR-35.
 * Được gọi ở: src/server/services/rules.ts (hàm attendanceLocked), src/server/controllers/handlers/ops.ts (tính lock_at trong sessionAttendanceGet).
 */
export const ATTENDANCE_LOCK_HOURS = 2;

/**
 * Whether the register for a session is closed to the coach.
 *
 * The job flips a session to `done` once the window is over, but it runs on a
 * timer: between the end of the window and the next tick the status still says
 * `scheduled`. Going by the clock as well means the lock does not depend on a
 * job having woken up.
 */
/**
 * Làm gì: Kiểm tra sổ điểm danh của buổi học đã bị khóa đối với huấn luyện viên theo BR-35 hay chưa: khóa khi trạng thái là done hoặc sau khi kết thúc 2 giờ.
 * Được gọi ở: src/server/controllers/handlers/ops.ts (các hàm sessionAttendanceGet và sessionAttendancePost), src/server/services/arena3.test.ts.
 * @param endAtMs Mốc thời gian kết thúc buổi học (milliseconds).
 * @param nowMs Mốc thời gian hiện tại (milliseconds).
 * @param status Trạng thái của buổi học ("scheduled", "done", v.v.).
 * @returns true nếu sổ điểm danh đã bị khóa, ngược lại false.
 */
export function attendanceLocked(endAtMs: number, nowMs: number, status: string): boolean {
  if (status === "done") return true;
  return nowMs > endAtMs + ATTENDANCE_LOCK_HOURS * 3_600_000;
}

/** BR-36: this many absences in a row raises an alert (it never drops the student). */
/**
 * Làm gì: Số buổi vắng liên tiếp tối đa (3 buổi) kích hoạt cảnh báo nguy cơ bỏ học theo quy tắc BR-36 để trung tâm liên hệ chăm sóc học viên.
 * Được gọi ở: src/server/controllers/handlers/attendance.ts (tính danh sách at-risk), src/server/controllers/handlers/training.ts (hàm checkAbsentStreaks).
 */
export const ABSENT_STREAK_LIMIT = 3;

/**
 * How many `absent` marks end the list, counted from the most recent.
 *
 * `results` is oldest to newest and holds only sessions that were actually
 * marked. Anything other than `absent` ends the run \u2014 an excused absence is one
 * the member told the centre about, so it is not the pattern BR-36 looks for.
 */
/**
 * Làm gì: Đếm số buổi vắng mặt không phép liên tiếp gần nhất tính từ cuối danh sách (từ buổi học mới nhất ngược về trước) theo quy tắc BR-36.
 * Được gọi ở: src/server/controllers/handlers/attendance.ts (computeAtRiskAbsenceSummary), src/server/controllers/handlers/training.ts (checkAbsentStreaks), src/server/services/arena3.test.ts.
 * @param results Mảng chuỗi trạng thái điểm danh của các buổi học theo thứ tự từ cũ đến mới.
 * @returns Số buổi vắng mặt không phép liên tiếp gần đây nhất (0 nếu buổi gần nhất có mặt hoặc xin phép).
 */
export function absentStreak(results: readonly string[]): number {
  let n = 0;
  // Duyệt ngược từ buổi học gần nhất về trước; dừng đếm ngay khi gặp kết quả khác "absent" (có mặt, đi muộn hoặc vắng có phép).
  for (let i = results.length - 1; i >= 0 && results[i] === "absent"; i -= 1) n += 1;
  return n;
}

/**
 * Làm gì: Danh sách các mục tiêu tập luyện của học viên: giảm cân (weight), rèn kỹ thuật (technique), thi đấu (compete), giải trí (fun).
 * Được gọi ở: src/server/controllers/handlers/training.ts.
 */
export const TRAINING_GOALS = ["weight", "technique", "compete", "fun"] as const;
/**
 * Làm gì: Danh sách các cấp độ kỹ năng của lớp học hoặc học viên: mới bắt đầu (beginner), trung cấp (intermediate), nâng cao (advanced).
 * Được gọi ở: src/routes/app.train.tsx, src/routes/coach.student.$id.tsx, src/server/controllers/handlers/sports.ts, src/server/controllers/handlers/training.ts.
 */
export const LEVELS = ["beginner", "intermediate", "advanced"] as const;
/**
 * Làm gì: Danh sách các mức cường độ bài tập trong giáo án huấn luyện: nhẹ (light), vừa (medium), nặng (hard).
 * Được gọi ở: src/client/components/coach-training.tsx, src/server/controllers/handlers/ops.ts, src/server/controllers/handlers/training.ts.
 */
export const INTENSITIES = ["light", "medium", "hard"] as const;
/**
 * Làm gì: Danh sách các giai đoạn trong một buổi huấn luyện: khởi động (warm-up), kỹ thuật (technique), thể lực (fitness), đấu tập (match), thả lỏng (cool-down).
 * Được gọi ở: src/server/controllers/handlers/ops.ts, src/server/controllers/handlers/training.ts.
 */
export const PLAN_PHASES = ["warm-up", "technique", "fitness", "match", "cool-down"] as const;

/** The numbers a coach can log for a student in one session (FR-TRN-05). */
/**
 * Làm gì: Danh sách tên các chỉ số kỹ thuật huấn luyện viên có thể ghi nhận cho học viên theo FR-TRN-05: smash_count, freethrow_pct, serve_pct.
 * Được gọi ở: src/server/services/rules.ts (hàm validateMetrics).
 */
export const METRIC_KEYS = ["smash_count", "freethrow_pct", "serve_pct"] as const;

export type MetricsCheck =
  | { ok: true; metrics: Record<string, number> }
  | { ok: false; field: string; message: string };

/**
 * Làm gì: Kiểm tra và chuẩn hóa các chỉ số kỹ thuật buổi tập do HLV ghi nhận (FR-TRN-05): giới hạn smash_count <= 1000 và các tỷ lệ % <= 100.
 * Được gọi ở: src/server/controllers/handlers/training.ts (hàm sessionStudentNotePost, route POST /v1/sessions/:id/students/:userId/notes), src/server/services/arena3.test.ts.
 * @param raw Dữ liệu chỉ số kỹ thuật thô gửi từ client (kiểu unknown).
 * @returns { ok: true, metrics } nếu hợp lệ; hoặc { ok: false, field, message } nếu có lỗi xác thực.
 */
export function validateMetrics(raw: unknown): MetricsCheck {
  // Bước 1: Trả về object rỗng nếu không truyền dữ liệu metrics.
  if (raw === undefined || raw === null) return { ok: true, metrics: {} };
  // Bước 2: Kiểm tra dữ liệu metrics bắt buộc phải là một đối tượng (object) và không phải mảng.
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, field: "metrics", message: "Metrics must be an object." };
  }
  // Bước 3: Duyệt qua từng cặp khóa - giá trị chỉ số để xác thực tên và ngưỡng giá trị cho phép.
  const metrics: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // Bỏ qua các trường rỗng hoặc null không cập nhật.
    if (value === null || value === "") continue;
    // Từ chối nếu gặp chỉ số không nằm trong danh sách METRIC_KEYS hỗ trợ.
    if (!(METRIC_KEYS as readonly string[]).includes(key)) {
      return { ok: false, field: "metrics", message: `"${key}" is not a metric we record.` };
    }
    // Giá trị chỉ số kỹ thuật phải là số nguyên hữu hạn.
    const n = typeof value === "string" ? Number(value) : value;
    if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) {
      return { ok: false, field: key, message: "Use a whole number." };
    }
    // Giới hạn giá trị: smash_count tối đa 1000 lượt, các chỉ số tỷ lệ % (freethrow_pct, serve_pct) tối đa 100%.
    const max = key === "smash_count" ? 1000 : 100;
    if (n < 0 || n > max) return { ok: false, field: key, message: `Must be between 0 and ${max}.` };
    metrics[key] = n;
  }
  // Bước 4: Toàn bộ chỉ số hợp lệ, trả về đối tượng metrics đã chuẩn hóa.
  return { ok: true, metrics };
}

/**
 * Làm gì: Giới hạn số lượng đầu việc tối đa (20 mục) trong danh sách bài tập về nhà (checklist) của một buổi học.
 * Được gọi ở: src/server/services/rules.ts (hàm normalizeChecklist).
 */
export const MAX_CHECKLIST_ITEMS = 20;

/** Homework checklist items: trimmed, non-empty, bounded. `null` when the shape is wrong. */
/**
 * Làm gì: Chuẩn hóa danh sách bài tập về nhà do HLV giao: cắt khoảng trắng, bỏ mục rỗng, giới hạn mỗi mục <= 120 ký tự và tối đa 20 mục.
 * Được gọi ở: src/server/controllers/handlers/training.ts (hàm sessionHomeworkPut, route PUT /v1/sessions/:id/homework), src/server/services/arena3.test.ts.
 * @param raw Danh sách bài tập về nhà thô từ request.
 * @returns Mảng chuỗi các bài tập đã làm sạch, mảng rỗng nếu không có bài tập, hoặc null nếu dữ liệu sai định dạng.
 */
export function normalizeChecklist(raw: unknown): string[] | null {
  // Bước 1: Trả về mảng rỗng nếu dữ liệu là null hoặc undefined.
  if (raw === undefined || raw === null) return [];
  // Kiểm tra dữ liệu bắt buộc phải là mảng, nếu không trả về null.
  if (!Array.isArray(raw)) return null;
  // Bước 2: Duyệt từng mục, cắt khoảng trắng và kiểm tra độ dài tối đa 120 ký tự mỗi mục.
  const out: string[] = [];
  for (const it of raw) {
    if (typeof it !== "string") return null;
    const t = it.trim();
    if (!t) continue;
    if (t.length > 120) return null;
    out.push(t);
  }
  // Bước 3: Đảm bảo tổng số lượng mục không vượt quá giới hạn 20 (MAX_CHECKLIST_ITEMS).
  return out.length > MAX_CHECKLIST_ITEMS ? null : out;
}

/** Done-items are stored as the indexes of ticked checklist rows; anything out of range is dropped. */
/**
 * Làm gì: Chuẩn hóa danh sách chỉ số (index) các bài tập về nhà đã hoàn thành: chỉ giữ số nguyên trong phạm vi [0, total - 1], lọc trùng và sắp xếp tăng dần.
 * Được gọi ở: src/server/controllers/handlers/training.ts (hàm meSessionHomeworkPatch, route PATCH /v1/me/sessions/:id/homework), src/server/services/arena3.test.ts.
 * @param total Tổng số lượng mục bài tập trong checklist.
 * @param raw Danh sách index bài tập đã hoàn thành do học viên gửi lên.
 * @returns Mảng số nguyên chứa các index hợp lệ đã hoàn thành, không trùng lặp và sắp xếp tăng dần.
 */
export function normalizeDone(total: number, raw: unknown): number[] {
  // Bước 1: Trả về mảng rỗng nếu dữ liệu truyền vào không phải là mảng.
  if (!Array.isArray(raw)) return [];
  // Bước 2: Dùng Set để lọc bỏ trùng lặp và chỉ chấp nhận các index số nguyên hợp lệ trong phạm vi [0, total - 1].
  const set = new Set<number>();
  for (const v of raw) {
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < total) set.add(v);
  }
  // Bước 3: Chuyển Set thành mảng và sắp xếp tăng dần theo chỉ số thứ tự.
  return [...set].sort((a, b) => a - b);
}

/** A checklist is finished when every row is ticked; one with no rows is finished by an explicit "done". */
/**
 * Làm gì: Xác định bài tập về nhà đã hoàn thành hay chưa: nếu có checklist thì cần tick đủ tất cả mục; nếu không có checklist thì dựa vào cờ explicitDone.
 * Được gọi ở: src/server/controllers/handlers/training.ts (hàm meSessionHomeworkPatch), src/server/services/arena3.test.ts.
 * @param total Tổng số đầu mục bài tập trong checklist.
 * @param done Danh sách index các mục bài tập đã đánh dấu hoàn thành.
 * @param explicitDone Cờ đánh dấu hoàn thành trực tiếp khi buổi học không có checklist chi tiết.
 * @returns true nếu toàn bộ bài tập đã hoàn thành, ngược lại false.
 */
export function homeworkComplete(total: number, done: readonly number[], explicitDone: boolean): boolean {
  return total === 0 ? explicitDone : done.length >= total;
}

// ---- promotions (FR-PAY-03, BR-42) ---------------------------------------------

/** What a code takes off an order, never leaving less than this to pay. */
/**
 * Làm gì: Số tiền tối thiểu phải thanh toán cho một đơn hàng sau khi trừ khuyến mãi (1.000đ), tránh đơn hàng giảm về 0đ.
 * Được gọi ở: src/server/services/rules.ts (hàm computeDiscount), src/server/services/promos.ts.
 */
export const MIN_PAYABLE_VND = 1000;

/**
 * Làm gì: Chuẩn hóa chuỗi mã khuyến mãi: cắt khoảng trắng hai đầu, chuyển thành chữ in hoa và xóa mọi khoảng trắng ở giữa.
 * Được gọi ở: src/server/controllers/handlers/promos.ts (hàm promoQuote, route POST /v1/promotions/quote), src/server/services/promos.ts (các hàm quotePromo, applyPromo), src/server/services/arena3.test.ts.
 * @param raw Giá trị mã khuyến mãi đầu vào (kiểu unknown).
 * @returns Chuỗi mã khuyến mãi viết hoa, không khoảng trắng; trả về chuỗi rỗng nếu đầu vào không phải string.
 */
export function normalizeCode(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toUpperCase().replace(/\s+/g, "") : "";
}

/**
 * The discount in whole đồng. A percentage is worked out once on the order total
 * and rounded once to the nearest 1,000đ (BR-42); a fixed amount is already a
 * multiple of 1,000. Capped by `max_discount_vnd`, and never so large that the
 * order drops under {@link MIN_PAYABLE_VND}.
 */
/**
 * Làm gì: Tính số tiền chiết khấu (VNĐ) của mã khuyến mãi theo BR-42: làm tròn đến 1.000đ, áp dụng mức giảm tối đa và giữ lại ít nhất 1.000đ phải thanh toán.
 * Được gọi ở: src/server/services/promos.ts (hàm quotePromo khi tính tiền chiết khấu đơn hàng), src/server/services/arena3.test.ts.
 * @param promo Thông tin cấu hình khuyến mãi gồm loại giảm giá (percent hoặc amount), giá trị giảm (value) và mức giảm tối đa (max_discount_vnd).
 * @param orderVnd Tổng giá trị đơn hàng trước khi giảm giá (VNĐ).
 * @param round Đơn vị làm tròn tiền (mặc định 1.000đ theo quy tắc BR-42).
 * @returns Số tiền được giảm giá bằng VNĐ, là bội số của đơn vị làm tròn (round) và không âm.
 */
export function computeDiscount(
  promo: { kind: "percent" | "amount"; value: number; max_discount_vnd: number | null },
  orderVnd: number,
  round = 1000,
): number {
  // Bước 1: Tính số tiền giảm thô: nếu là phần trăm thì tính trên giá trị đơn và làm tròn đến 1.000đ gần nhất; nếu là số tiền cố định thì lấy giá trị cấu hình.
  let d =
    promo.kind === "percent" ? Math.round((orderVnd * promo.value) / 100 / round) * round : promo.value;
  // Bước 2: Giới hạn số tiền giảm không vượt quá mức chiết khấu trần (max_discount_vnd) nếu được cấu hình.
  if (promo.max_discount_vnd != null) d = Math.min(d, promo.max_discount_vnd);
  // Bước 3: Đảm bảo số tiền khách phải trả sau giảm giá tối thiểu là 1.000đ (MIN_PAYABLE_VND).
  d = Math.min(d, Math.max(0, orderVnd - MIN_PAYABLE_VND));
  // Stay on the 1,000đ grid whichever cap bit (BR-42: rounded once).
  // Bước 4: Làm tròn xuống theo bội số 1.000đ và đảm bảo số tiền giảm không âm.
  return Math.max(0, Math.floor(d / round) * round);
}
