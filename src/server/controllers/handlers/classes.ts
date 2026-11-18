/**
 * File: src/server/controllers/handlers/classes.ts
 * Module điều khiển (controller handler) xử lý toàn bộ nghiệp vụ liên quan đến lớp học (classes) tại Arena 3.
 * Bao gồm: tra cứu danh sách lớp học, tạo lớp mới, cấu hình lịch lặp (rrule), mở/đóng/hủy lớp,
 * quản lý học viên đăng ký (enrollments), danh sách chờ (waitlist), điểm danh và chuyển lớp.
 * Được gọi bởi router chính (src/server/controllers/router.ts) khi có request đến /v1/classes/*.
 */
import { reconcileLoyaltyRefund } from "../../services/loyalty";
import type { Sql } from "@/server/data/db";
import { err, isConflictSlot } from "../errors";
import { assertNoClassClash, assertUnderClassLimit, audit, enqueue, isUuid, getSettings, nextCode, num, readJson, str, type ClassPattern, classPatternsClash } from "../helpers";
import { classCode } from "../../../shared/arena3/labels";
import { expandWeekly } from "../../services/rrule";
import { avatarUrlSql, requireRole, withAvatarUrl, type PublicUser } from "../session";
import { addDays, classMinutes, ictDateString, ictDateTime, slotSpan } from "../../../shared/arena3/time";
import { quotePromo, redeemPromo } from "../../services/promos";
import { one } from "../tx";
import { compactWaitlist, inviteWaitlist } from "./ops";
import { lockEnrollmentLinks, withdrawLinks } from "../../integrations/payos";
import { assertClassStaff } from "./training";
import { assertSlotGrid } from "./bookings";
import { activeMembershipEnd, applyExtension, assertMembershipOutlastsClass, carryMembersToClassEnd, outlastsClass, planToOutlast, rollbackExtension } from "../../services/membership";

/**
 * Làm gì: Giới hạn số lượng học viên tối đa cho một lớp học (200 học viên) để đảm bảo chất lượng giảng dạy và an toàn phòng tập.
 * Được gọi ở: readClassCapacity (khi tạo lớp mới) và classesPatch (khi cập nhật sức chứa lớp học).
 */
export const MAX_CLASS_CAPACITY = 200;
/**
 * Làm gì: Giới hạn học phí tối đa của một lớp học là 100.000.000 VNĐ (100 triệu đồng) để ngăn ngừa lỗi nhập liệu số tiền quá lớn.
 * Được gọi ở: parsePrice (khi kiểm tra học phí trong form tạo hoặc cập nhật lớp học).
 */
export const MAX_CLASS_PRICE_VND = 100_000_000;

/** A class price from a request body: null/"" clears it, a whole number of dong from 0 to 100,000,000 sets it. */
/**
 * Làm gì: Đọc và chuẩn hóa giá tiền lớp học (VNĐ) từ request body. Nếu rỗng hoặc null thì xóa giá (trả về null), nếu là số hợp lệ từ 0 đến 100.000.000 thì trả về số nguyên.
 * Được gọi ở: readClassForm (bước 2 của classesCreate) và classesPatch (khi cập nhật giá tiền lớp học).
 * @param raw Giá trị thô của trường price_vnd từ request body (số, chuỗi số, hoặc null/rỗng).
 * @returns Số tiền nguyên theo VNĐ hoặc null nếu không đặt giá.
 * @throws Lỗi 400 (field price_vnd) nếu không phải số nguyên hoặc vượt quá 100.000.000 VNĐ.
 */
function parsePrice(raw: unknown): number | null {
  if (raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 0 || n > MAX_CLASS_PRICE_VND) {
    throw err.field("price_vnd", "Price must be a whole number of dong, or empty.");
  }
  return n;
}

// Giới hạn độ dài ký tự tối đa cho các trường văn bản mô tả lớp học (mô tả, giáo trình, đối tượng phù hợp, đồ cần mang)
const CLASS_TEXT_LIMITS = { description: 2000, syllabus: 2000, who_for: 300, bring: 300 } as const;
type ClassTextKey = keyof typeof CLASS_TEXT_LIMITS;

/** Free text about a class (description, syllabus, who it is for, what to bring): empty clears it. */
/**
 * Làm gì: Đọc và làm sạch văn bản mô tả lớp học (chuẩn hóa xuống dòng \r\n thành \n, cắt khoảng trắng đầu cuối). Nếu rỗng hoặc undefined/null thì trả về null; kiểm tra không vượt quá giới hạn ký tự tương ứng trong CLASS_TEXT_LIMITS.
 * Được gọi ở: readClassForm (khi tạo lớp mới) và classesPatch (khi sửa mô tả lớp).
 * @param key Tên trường mô tả ("description", "syllabus", "who_for", "bring").
 * @param raw Giá trị thô nhận từ request body (kỳ vọng là chuỗi ký tự hoặc null/undefined).
 * @returns Chuỗi văn bản đã chuẩn hóa hoặc null nếu để trống.
 * @throws Lỗi 400 gắn vào key nếu dữ liệu không phải chuỗi hoặc vượt quá giới hạn ký tự cho phép.
 */
function parseClassText(key: ClassTextKey, raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw err.field(key, "Text expected.");
  const v = raw.replace(/\r\n/g, "\n").trim();
  if (v.length > CLASS_TEXT_LIMITS[key]) throw err.field(key, `${CLASS_TEXT_LIMITS[key]} characters at most.`);
  return v === "" ? null : v;
}

/** The minimum to run a class: empty for none, otherwise a whole number from 1 up to the capacity. */
/**
 * Làm gì: Đọc và kiểm tra sĩ số tối thiểu để mở lớp (min_enrolled). Nếu để trống hoặc null thì trả về null (không yêu cầu số lượng tối thiểu); nếu nhập thì phải là số nguyên từ 1 đến sức chứa tối đa (capacity).
 * Được gọi ở: readClassForm (bước 2 của classesCreate) và classesPatch (khi cập nhật sĩ số tối thiểu).
 * @param raw Giá trị thô của trường min_enrolled từ request body.
 * @param capacity Sức chứa tối đa của lớp học dùng làm chặn trên cho sĩ số tối thiểu.
 * @returns Số nguyên sĩ số tối thiểu (1 đến capacity) hoặc null nếu không yêu cầu.
 * @throws Lỗi 400 (field min_enrolled) nếu không phải số nguyên hoặc nhỏ hơn 1 hoặc vượt quá capacity.
 */
function parseMinEnrolled(raw: unknown, capacity: number): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const n = num(raw);
  if (n === undefined || !Number.isInteger(n) || n < 1 || n > capacity) {
    throw err.field("min_enrolled", "The minimum must be a whole number from 1 up to the capacity.");
  }
  return n;
}

/**
 * Làm gì: Lấy danh sách lớp học theo bộ lọc môn thể thao (sport) và phân quyền người dùng. Quản lý (manager) xem được tất cả các lớp ở mọi trạng thái (open, closed, draft); hội viên hoặc khách vãng lai chỉ xem được các lớp đang mở ('open'). Đi kèm số học viên đã xác nhận, cờ cảnh báo lớp chạy dưới sĩ số tối thiểu (running_below_minimum), và thông tin ghi danh (my_enrollment) của chính hội viên.
 * Được gọi ở: src/server/controllers/router.ts:182 tại route GET /v1/classes (hoặc GET /classes).
 * @param sql Kết nối database PostgreSQL.
 * @param request HTTP Request chứa query parameter lọc môn thể thao (?sport=...).
 * @param user Thông tin tài khoản đang đăng nhập (PublicUser nếu đã xác thực, hoặc null nếu là khách vãng lai).
 * @returns Phản hồi HTTP 200 dạng { status: 200, body: { items: [...] } } chứa danh sách lớp học kèm mã hiển thị code.
 */
export async function classesList(sql: Sql, request: Request, user: PublicUser | null) {
  // Bước 1: Đọc tham số lọc môn thể thao (sport) từ query string và kiểm tra người gọi có phải vai trò quản lý (manager) hay không
  const sport = new URL(request.url).searchParams.get("sport");
  const manager = user?.role === "manager";
  // Bước 2: Truy vấn danh sách lớp học từ database:
  // - cross join lateral seats: Đếm số lượng học viên đã xác nhận ghi danh (status = 'confirmed').
  // - running_below_minimum: Cảnh báo lớp đã đến giờ bắt đầu buổi đầu tiên nhưng số học viên xác nhận vẫn dưới mức tối thiểu (min_enrolled).
  // - left join lateral me: Lấy thông tin đăng ký của chính hội viên đang đăng nhập ($3::uuid).
  // - left join lateral made: Lấy thời điểm tạo lớp từ audit_logs để phục vụ sắp xếp.
  // - Phân quyền: Manager ($1 = true) xem mọi trạng thái; người dùng khác chỉ xem lớp 'open'.
  const items = await sql.query(
    `select cl.id, cl.sport, cl.level, cl.capacity, cl.enrolled_count, cl.rrule, cl.duration_min,
            cl.start_on::text, cl.end_on::text, cl.status, cl.court_id, c.court_code,
            cl.coach_id, u.full_name as coach_name, made.at as created_at, cl.price_vnd, cl.min_enrolled,
            cl.description, cl.syllabus, cl.who_for, cl.bring,
            seats.confirmed_count,
            (cl.status = 'open' and cl.min_enrolled is not null
              and seats.confirmed_count < cl.min_enrolled
              and exists (select 1 from sessions s where s.class_id = cl.id
                           and s.status <> 'cancelled' and s.start_at <= now())) as running_below_minimum,
            case when me.id is null then null else jsonb_build_object(
              'id', me.id, 'status', me.status, 'hold_until', me.hold_until,
              'price_vnd', me.price_vnd, 'transfer_requested_at', me.transfer_requested_at) end as my_enrollment
       from classes cl
       join courts c on c.id = cl.court_id
       join users u on u.id = cl.coach_id
       cross join lateral (
         select count(*)::int as confirmed_count from enrollments e
          where e.class_id = cl.id and e.status = 'confirmed'
       ) seats
       left join lateral (
         select e.id, e.status, e.hold_until, e.price_vnd, e.transfer_requested_at
           from enrollments e
          where e.class_id = cl.id and e.user_id = $3::uuid and e.status <> 'cancelled'
          limit 1
       ) me on true
       left join lateral (
         select max(a.at) as at from audit_logs a
          where a.action = 'create_class' and a.entity_id = cl.id
       ) made on true
      where ($1 or cl.status = 'open')
        and ($2::text is null or cl.sport::text = $2)
      order by case cl.status when 'open' then 0 when 'closed' then 1 when 'draft' then 2 else 3 end,
               made.at desc nulls last, cl.start_on desc, cl.level`,
    [manager, sport, user && user.role === "member" ? user.id : null],
  );
  // Bước 3: Định dạng kết quả trả về HTTP 200, tạo mã lớp học thân thiện (classCode, ví dụ BAD-BEG-101) cho từng lớp
  return {
    status: 200,
    body: { items: items.map((c) => ({ ...c, code: classCode(String(c.sport), String(c.level), String(c.id)) })) },
  };
}

export type { ClassPattern };
// Tái xuất hàm classPatternsClash từ helpers để kiểm tra xem hai mẫu lịch lặp của lớp học có bị trùng giờ và ngày hay không
export { classPatternsClash };

// Cấu trúc dữ liệu chứa các trường nhập từ form tạo hoặc chỉnh sửa lớp học (trước khi kiểm tra bắt buộc)
type ClassForm = {
  sport: string | undefined;
  level: string | undefined;
  coach_id: string | undefined;
  court_id: string | undefined;
  rrule: string | undefined;
  start_on: string | undefined;
  end_on: string | undefined;
  capacity: number;
  duration_min: number;
  price_vnd: number | null;
  min_enrolled: number | null;
  description: string | null;
  syllabus: string | null;
  who_for: string | null;
  bring: string | null;
  assistantInput: unknown;
};

// Cấu trúc dữ liệu của form sau khi đã kiểm tra đầy đủ các trường bắt buộc (sport, level, coach_id, court_id, rrule, start_on, end_on)
type CompleteClassForm = ClassForm & ClassPattern & {
  sport: string;
  level: string;
  coach_id: string;
  court_id: string;
};

// Cấu hình lịch học và nhân sự của lớp dùng để kiểm tra xung đột thời gian (sân, HLV chính, trợ giảng và lịch lặp)
type ClassSchedule = ClassPattern & {
  court_id: string;
  coach_id: string;
  assistant_id: string | null;
};

// Bảng tra cứu các thành phần của quy tắc lặp RRULE (ánh xạ giữa tên khóa như FREQ, BYDAY, BYHOUR sang giá trị)
type ClassRecurrenceRule = Map<string, string>;

/**
 * Làm gì: đọc ô "Sức chứa" (số chỗ tối đa) từ form và trả về một số nguyên từ 1 đến 200.
 *   Bỏ trống thì lấy mặc định 12; gửi lên thứ không phải số (ví dụ "abc") thì báo lỗi, không tự đổi thành 12.
 * Được gọi ở: readClassForm (bước 2 của classesCreate).
 * @param rawCapacity Giá trị thô của ô capacity trong body JSON, chưa biết là số, chuỗi hay trống.
 * @returns Sức chứa hợp lệ.
 * @throws Lỗi 400 gắn vào ô capacity nếu vượt 200, không phải số nguyên hoặc nhỏ hơn 1.
 */
function readClassCapacity(rawCapacity: unknown): number {
  // Left out, the class gets the usual 12; sent but not a number (say "abc"), it is refused rather
  // than quietly turned into 12.
  // Bước 1: Nếu để trống thì lấy sức chứa mặc định là 12; nếu có nhập thì chuyển đổi sang kiểu số
  const capacityLeftEmpty =
    rawCapacity === undefined || rawCapacity === null || rawCapacity === "";

  let capacity: number | undefined;
  if (capacityLeftEmpty) {
    capacity = 12;
  } else {
    capacity = num(rawCapacity);
  }

  // Bước 2: Kiểm tra sức chứa không được vượt quá giới hạn tối đa MAX_CLASS_CAPACITY (200 học viên)
  const capacityExceedsMaximum =
    capacity !== undefined && capacity > MAX_CLASS_CAPACITY;

  if (capacityExceedsMaximum) {
    throw err.field("capacity", `Capacity cannot exceed ${MAX_CLASS_CAPACITY}.`);
  }

  // Giữ kiểm tra undefined trực tiếp để TypeScript thu hẹp kiểu trước khi trả về.
  if (capacity === undefined) {
    throw err.field("capacity", `Capacity must be a whole number from 1 to ${MAX_CLASS_CAPACITY}.`);
  }

  // Bước 3: Kiểm tra sức chứa phải là số nguyên hợp lệ và tối thiểu là 1
  const capacityIsInvalid = !Number.isInteger(capacity) || capacity < 1;
  if (capacityIsInvalid) {
    throw err.field("capacity", `Capacity must be a whole number from 1 to ${MAX_CLASS_CAPACITY}.`);
  }

  return capacity;
}

/**
 * Làm gì: đọc độ dài mỗi buổi học (phút). Chỉ nhận 60 vì mọi buổi học, slot và lượt đặt sân đều dài
 *   đúng 1 tiếng; bỏ trống thì mặc định 60.
 * Được gọi ở: readClassForm (bước 2 của classesCreate).
 * @param rawDuration Giá trị thô của ô duration_min trong body JSON.
 * @returns Số phút mỗi buổi: luôn là 60.
 * @throws Lỗi 422 nếu là số phút khác.
 */
function readClassDuration(rawDuration: unknown): number {
  // num có thể trả undefined; classMinutes khi đó dùng mặc định 60 phút.
  const durationMinutes = classMinutes(num(rawDuration));

  if (durationMinutes == null) {
    throw err.validation("Every class session lasts exactly one hour (60 minutes).");
  }

  return durationMinutes;
}

/**
 * Làm gì: đọc body JSON của request thành một object ClassForm gọn gàng: cắt khoảng trắng các ô chữ,
 *   đổi các ô số thành số, làm sạch các ô mô tả. Chưa kiểm tra thiếu ô bắt buộc (việc của hàm kế tiếp).
 * Được gọi ở: classesCreate, bước 2.
 * @param request Request POST /v1/classes do màn hình /manager/classes gửi lên.
 * @returns ClassForm chứa mọi ô của form; ô chữ bị bỏ trống thì là undefined.
 * @throws Lỗi 422 nếu body không phải JSON; lỗi 400/422 từ các hàm đọc sức chứa, thời lượng, học phí,
 *   sĩ số tối thiểu và mô tả. Thứ tự đọc ở đây cũng là thứ tự báo lỗi, nên đừng đảo.
 */
async function readClassForm(request: Request): Promise<ClassForm> {
  // Bước 1: Đọc và giải mã dữ liệu JSON từ body của request
  const body = await readJson(request);

  // Bước 2: Đọc và cắt tỉa khoảng trắng cho các trường thông tin dạng chuỗi
  const sport = str(body.sport);
  const level = str(body.level);
  const coachId = str(body.coach_id);
  const courtId = str(body.court_id);
  const recurrenceRule = str(body.rrule);
  const startOn = str(body.start_on);
  const endOn = str(body.end_on);

  // Thứ tự chuyển đổi cũng là thứ tự báo lỗi, nên chưa kiểm tra thiếu trường ở đây.
  // Bước 3: Đọc và chuẩn hóa các trường số và cấu hình nâng cao (sức chứa, thời lượng, học phí, sĩ số tối thiểu, mô tả)
  const capacity = readClassCapacity(body.capacity);
  const durationMinutes = readClassDuration(body.duration_min);

  let priceVnd: number | null = null;
  if (body.price_vnd !== undefined) {
    priceVnd = parsePrice(body.price_vnd);
  }

  const minimumEnrolled = parseMinEnrolled(body.min_enrolled, capacity);
  const description = parseClassText("description", body.description);
  const syllabus = parseClassText("syllabus", body.syllabus);
  const whoFor = parseClassText("who_for", body.who_for);
  const bring = parseClassText("bring", body.bring);

  // Bước 4: Đóng gói toàn bộ dữ liệu đã chuẩn hóa vào đối tượng ClassForm
  return {
    sport,
    level,
    coach_id: coachId,
    court_id: courtId,
    rrule: recurrenceRule,
    start_on: startOn,
    end_on: endOn,
    capacity,
    duration_min: durationMinutes,
    price_vnd: priceVnd,
    min_enrolled: minimumEnrolled,
    description,
    syllabus,
    who_for: whoFor,
    bring,
    assistantInput: body.assistant_id,
  };
}

/**
 * Làm gì: chắc chắn form có đủ môn, trình độ, người dạy, sân, lịch lặp, ngày đầu và ngày cuối.
 *   Qua được hàm này thì TypeScript biết các ô đó chắc chắn là string (nhờ "asserts form is ...").
 * Được gọi ở: classesCreate, bước 2, ngay sau readClassForm.
 * @param form Form vừa đọc từ readClassForm.
 * @throws Lỗi 422 "Class details are incomplete." nếu thiếu bất kỳ ô nào.
 */
function checkRequiredClassFields(
  form: ClassForm,
): asserts form is CompleteClassForm {
  // Kiểm tra bắt buộc phải có đầy đủ 7 trường thông tin cơ bản để định hình một lớp học
  const requiredFieldIsMissing =
    !form.sport ||
    !form.level ||
    !form.coach_id ||
    !form.court_id ||
    !form.rrule ||
    !form.start_on ||
    !form.end_on;

  if (requiredFieldIsMissing) {
    throw err.validation("Class details are incomplete.");
  }
}

/**
 * Làm gì: kiểm tra khoảng ngày của lớp: ngày cuối không được trước ngày đầu, ngày đầu không được ở quá khứ
 *   (tính theo giờ Việt Nam). So sánh chuỗi được vì ngày có dạng YYYY-MM-DD.
 * Được gọi ở: classesCreate, bước 3.
 * @param form Form đã đủ ô bắt buộc.
 * @throws Lỗi 400 gắn vào ô end_on hoặc start_on, kiểm tra end_on trước.
 */
function checkClassDates(form: CompleteClassForm): void {
  // Bước 1: So sánh chuỗi YYYY-MM-DD để đảm bảo ngày kết thúc không trước ngày bắt đầu
  const endPrecedesStart = form.start_on > form.end_on;
  if (endPrecedesStart) {
    throw err.field("end_on", "End date must be on or after start date.");
  }

  // A timetable that begins before today would publish sessions that already happened.
  const startIsInThePast = form.start_on < ictDateString();
  if (startIsInThePast) {
    throw err.field("start_on", "A class cannot start or end in the past. Pick today or a later first day.");
  }
}

/**
 * Làm gì: tách chuỗi lịch lặp RRULE thành bảng tra "tên → giá trị" để kiểm tra từng phần.
 *   RRULE là chuẩn ghi lịch lặp, ví dụ "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=18" = mỗi tuần, thứ Hai và thứ Tư, 18 giờ.
 * Được gọi ở: classesCreate, bước 3.
 * @param recurrenceRule Chuỗi rrule do màn hình ghép từ các nút chọn thứ và giờ.
 * @returns Map các phần của lịch. Hàm chỉ tách, không báo lỗi.
 */
function parseClassRecurrenceRule(recurrenceRule: string): ClassRecurrenceRule {
  // Ví dụ "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=18" thành FREQ → WEEKLY, BYDAY → MO,WE, BYHOUR → 18.
  // Dùng Map cho rõ ràng: chỉ là bảng tra "tên → giá trị", khóa trùng thì giá trị sau đè giá trị trước.
  const rule: ClassRecurrenceRule = new Map();

  for (const part of recurrenceRule.split(";")) {
    const [rawKey, rawValue] = part.split("=");
    rule.set(rawKey ?? "", rawValue ?? "");
  }

  return rule;
}

/**
 * Làm gì: kiểm tra lịch lặp đã tách: nếu có phần chọn thứ (BYDAY) thì phải chọn ít nhất một ngày,
 *   nếu có phần giờ (BYHOUR) thì giờ phải là số nguyên 0–23. Phần nào không gửi thì bỏ qua.
 * Được gọi ở: classesCreate, bước 3, ngay sau parseClassRecurrenceRule.
 * @param rule Bảng tra trả về từ parseClassRecurrenceRule.
 * @throws Lỗi 400 gắn vào ô rrule, kiểm tra ngày trước giờ.
 */
function checkClassRecurrenceRule(rule: ClassRecurrenceRule): void {
  // Bước 1: Nếu có truyền BYDAY trong quy tắc lặp thì không được để rỗng (phải chọn ít nhất một ngày trong tuần)
  const byDay = rule.get("BYDAY");
  const daysWereProvidedButEmpty = byDay !== undefined && !byDay.trim();

  if (daysWereProvidedButEmpty) {
    throw err.field("rrule", "Pick at least one day of the week.");
  }

  // Bước 2: Nếu có truyền BYHOUR thì giờ học phải là số nguyên từ 0 đến 23
  const rawHour = rule.get("BYHOUR");
  if (rawHour !== undefined) {
    const hour = Number(rawHour);
    const hourIsInvalid = !Number.isInteger(hour) || hour < 0 || hour > 23;

    if (hourIsInvalid) {
      throw err.field("rrule", "BYHOUR must be an integer between 0 and 23.");
    }
  }
}

/**
 * Làm gì: kiểm tra người dạy chính có thật, là tài khoản coach, và được phân công dạy môn này
 *   (hoặc được dạy mọi môn: sport = 'all'). Đây là quy tắc nghiệp vụ BR-25.
 * Được gọi ở: classesCreate, bước 4.
 * @param sql Kết nối database trong transaction của request (router mở sẵn).
 * @param form Form đã đủ ô; dùng coach_id và sport.
 * @throws Lỗi 422 BR-25, kiểm tra vai trò trước rồi mới tới môn.
 */
async function checkClassCoach(sql: Sql, form: CompleteClassForm): Promise<void> {
  // Bước 1: Xác minh tài khoản huấn luyện viên tồn tại và có đúng vai trò 'coach' (quy tắc BR-25)
  const coach = await one<{ role: string }>(
    sql,
    `select role from users where id = $1`,
    [form.coach_id],
  );

  const coachIsInvalid = !coach || coach.role !== "coach";
  if (coachIsInvalid) {
    throw err.br("BR-25", "That coach is not valid.");
  }

  // Bước 2: Kiểm tra phân công môn thể thao: HLV phải được phân công dạy đúng môn này hoặc được dạy mọi môn ('all')
  const sportAssignment = await one(
    sql,
    `select 1 from coach_sports where user_id = $1 and (sport = $2 or sport = 'all')`,
    [form.coach_id, form.sport],
  );

  if (!sportAssignment) {
    throw err.br("BR-25", "That coach is not assigned to this sport.");
  }
}

/**
 * Làm gì: kiểm tra sân được chọn có thật, chưa ngừng sử dụng, và đúng môn của lớp
 *   (không xếp lớp cầu lông vào sân bóng rổ).
 * Được gọi ở: classesCreate, bước 4, sau checkClassCoach.
 * @param sql Kết nối database trong transaction của request.
 * @param form Form đã đủ ô; dùng court_id và sport.
 * @throws Lỗi 400 gắn vào ô court_id.
 */
async function checkClassCourt(sql: Sql, form: CompleteClassForm): Promise<void> {
  // Bước 1: Truy vấn bảng courts để kiểm tra sân có tồn tại trong hệ thống và chưa bị ngừng hoạt động (retired_at is null)
  const court = await one<{ sport: string; retired_at: string | null }>(
    sql,
    `select sport::text as sport, retired_at from courts where id = $1`,
    [form.court_id],
  );

  if (!court || court.retired_at) {
    throw err.field("court_id", "That court does not exist.");
  }

  // Môn thể thao của sân phải khớp với môn thể thao của lớp học (tránh xếp lớp vào sân không đúng bộ môn).
  const courtSportDoesNotMatch = court.sport !== form.sport;
  if (courtSportDoesNotMatch) {
    throw err.field("court_id", "Court sport must match class sport.");
  }
}

/**
 * Làm gì: trợ giảng là tùy chọn. Nếu form có chọn trợ giảng thì kiểm tra người đó có thật và là coach.
 * Được gọi ở: classesCreate, bước 4, sau checkClassCourt.
 * @param sql Kết nối database trong transaction của request.
 * @param assistantInput Giá trị thô của ô assistant_id trong body JSON.
 * @returns Mã trợ giảng đã cắt khoảng trắng, hoặc undefined nếu không chọn.
 *   Kết quả này được dùng tiếp ở checkClassScheduleClash để xét cả lịch bận của trợ giảng.
 * @throws Lỗi 400 gắn vào ô assistant_id.
 */
async function checkClassAssistant(
  sql: Sql,
  assistantInput: unknown,
): Promise<string | undefined> {
  const assistantId = str(assistantInput);

  // Trợ giảng không bắt buộc; chuỗi rỗng không làm phát sinh truy vấn.
  if (assistantId) {
    const assistant = await one<{ role: string }>(
      sql,
      `select role from users where id = $1`,
      [assistantId],
    );

    const assistantIsInvalid = !assistant || assistant.role !== "coach";
    if (assistantIsInvalid) {
      throw err.field("assistant_id", "That assistant coach is not valid.");
    }
  }

  return assistantId;
}

/**
 * Làm gì: chặn lịch trùng. Tìm các lớp chưa hủy có khoảng ngày giao với lớp mới và dùng chung sân
 *   hoặc chung người dạy (kể cả trợ giảng), rồi so từng lớp xem có ngày học chung mà giờ chồng nhau không.
 *   Vì sao làm trước khi lưu: lớp trùng hết mọi buổi sẽ publish ra không có buổi nào.
 * Được gọi ở: classesCreate, bước 5.
 * @param sql Kết nối database trong transaction của request.
 * @param form Form đã kiểm tra; dùng sân, người dạy, lịch lặp, thời lượng và khoảng ngày.
 * @param assistantId Mã trợ giảng từ checkClassAssistant, hoặc undefined.
 * @throws Lỗi 409 ở lớp trùng đầu tiên: báo trùng sân nếu cùng sân, ngược lại báo trùng người dạy.
 */
async function checkClassScheduleClash(
  sql: Sql,
  form: CompleteClassForm,
  assistantId: string | undefined,
): Promise<void> {
  // Bước 1: Tìm các lớp khác (chưa hủy) có khoảng ngày giao nhau và dùng chung sân hoặc chung người dạy (HLV chính / trợ giảng).
  // A class whose every date sits on another class's court or coach would publish
  // with no sessions at all, so a clashing timetable is refused up front.
  const people = [form.coach_id, assistantId].filter(Boolean);
  const otherClasses = await sql.query(
    `select court_id, coach_id, assistant_id, rrule, duration_min, start_on::text, end_on::text
       from classes
      where status <> 'cancelled'
        and start_on <= $3::date and end_on >= $2::date
        and (court_id = $1 or coach_id = any($4::uuid[]) or assistant_id = any($4::uuid[]))`,
    [form.court_id, form.start_on, form.end_on, people],
  );

  // Bước 2: Chuẩn hóa lịch học dự kiến thành đối tượng ClassPattern để phục vụ đối soát trùng lặp.
  const proposedSchedule: ClassPattern = {
    rrule: form.rrule,
    duration_min: form.duration_min,
    start_on: form.start_on,
    end_on: form.end_on,
  };

  // Bước 3: Duyệt từng lớp tiềm năng xung đột và dùng hàm classPatternsClash để kiểm tra trùng giờ chi tiết theo RRULE.
  for (const otherClass of otherClasses as ClassSchedule[]) {
    const schedulesClash = classPatternsClash(proposedSchedule, otherClass);
    if (!schedulesClash) {
      continue;
    }

    // Không sắp xếp lại kết quả: lịch đầu tiên và ưu tiên lỗi sân quyết định thông báo.
    const sameCourt = otherClass.court_id === form.court_id;
    if (sameCourt) {
      throw err.conflict("Another class already uses this court on those days and hours.");
    }

    throw err.conflict("This coach already teaches another class on those days and hours.");
  }
}

/** Số tuần tối đa dời lịch khi tìm ngày bắt đầu gợi ý cho lớp bị trùng đặt sân. */
const CLASS_SHIFT_WEEKS = 8;

/**
 * Làm gì: tính các khung giờ giữ sân (đã làm tròn theo slot) của mọi buổi trong khoảng ngày của lớp.
 * Được gọi ở: checkClassBookingClash, cho lịch gốc và cho từng lịch dời tuần.
 */
function classCourtSpans(form: CompleteClassForm, startOn: string, endOn: string, slotMinutes: number): ClassSessionTime[] {
  return expandWeekly(form.rrule, form.duration_min, ictDateTime(startOn, "00:00"), ictDateTime(endOn, "23:59")).map(
    (occurrence) => slotSpan(occurrence.start, occurrence.end, slotMinutes),
  );
}

/**
 * Làm gì: tìm buổi đầu tiên của lớp đụng lịch chiếm sân (đặt sân, buổi học, bảo trì) trên cùng sân.
 *   Bỏ qua 'hold' vì giữ chỗ chỉ sống vài phút trong lúc khách thanh toán.
 * @returns Giờ bắt đầu (ISO) của buổi đụng đầu tiên, hoặc null nếu sân trống mọi buổi.
 */
async function firstCourtBookingClash(sql: Sql, courtId: string, spans: ClassSessionTime[]): Promise<string | null> {
  if (!spans.length) return null;
  const row = await one<{ clash_at: string }>(
    sql,
    `select s.a as clash_at
       from unnest($2::timestamptz[], $3::timestamptz[]) as s(a, b)
      where exists (
        select 1 from occupancies o
         where o.court_id = $1 and o.kind <> 'hold'
           and tstzrange(o.start_at, o.end_at, '[)') && tstzrange(s.a, s.b, '[)'))
      order by s.a
      limit 1`,
    [courtId, spans.map((span) => span.start.toISOString()), spans.map((span) => span.end.toISOString())],
  );
  return row ? new Date(row.clash_at).toISOString() : null;
}

/**
 * Làm gì: chặn tạo lớp nếu có buổi nào rơi vào giờ sân đã có người đặt (hoặc đang bảo trì).
 *   Kèm gợi ý: dời cả lớp lùi từng tuần (từ 1 tuần) tới khi không còn buổi nào trùng, giữ nguyên độ dài lớp.
 * Được gọi ở: classesCreate, bước 5, sau checkClassScheduleClash.
 * @throws Lỗi 409 kèm clash_at, suggested_start_on, suggested_end_on (hai ô sau vắng nếu 8 tuần vẫn trùng).
 */
async function checkClassBookingClash(sql: Sql, form: CompleteClassForm): Promise<void> {
  const { slot_minutes: slotMinutes } = await getSettings(sql);
  const clashAt = await firstCourtBookingClash(
    sql,
    form.court_id,
    classCourtSpans(form, form.start_on, form.end_on, slotMinutes),
  );
  if (!clashAt) return;

  // Dời cả ngày đầu và ngày cuối cùng một số tuần để lớp giữ nguyên số buổi và thứ trong tuần.
  for (let week = 1; week <= CLASS_SHIFT_WEEKS; week++) {
    const startOn = addDays(form.start_on, week * 7);
    const endOn = addDays(form.end_on, week * 7);
    const shifted = await firstCourtBookingClash(sql, form.court_id, classCourtSpans(form, startOn, endOn, slotMinutes));
    if (!shifted) {
      throw err.conflict("This court is already booked at some of this class's hours.", {
        field: "start_on",
        clash_at: clashAt,
        suggested_start_on: startOn,
        suggested_end_on: endOn,
      });
    }
  }
  throw err.conflict("This court is already booked at some of this class's hours.", { field: "start_on", clash_at: clashAt });
}

/**
 * Làm gì: lưu lớp vào bảng classes với trạng thái 'draft' (nháp) và trả về dòng vừa lưu.
 *   Vì sao là nháp: tạo buổi học và mở đăng ký là việc của bước publish, một request riêng.
 * Được gọi ở: classesCreate, bước 6, khi mọi kiểm tra đã qua.
 * @param sql Kết nối database trong transaction của request.
 * @param form Form đã kiểm tra đầy đủ.
 * @returns Dòng lớp vừa tạo (có id) do câu "returning *" trả về.
 */
async function insertDraftClass(sql: Sql, form: CompleteClassForm) {
  // Giữ đúng code gốc: undefined thành null; chuỗi "" sau trim vẫn là "" vì dùng ??.
  return one(
    sql,
    `insert into classes
       (sport, level, coach_id, assistant_id, court_id, capacity, rrule, duration_min, start_on, end_on, status, price_vnd, min_enrolled,
        description, syllabus, who_for, bring)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',$11,$12,$13,$14,$15,$16)
     returning *`,
    [
      form.sport,
      form.level,
      form.coach_id,
      str(form.assistantInput) ?? null,
      form.court_id,
      form.capacity,
      form.rrule,
      form.duration_min,
      form.start_on,
      form.end_on,
      form.price_vnd,
      form.min_enrolled,
      form.description,
      form.syllabus,
      form.who_for,
      form.bring,
    ],
  );
}

/**
 * Làm gì: tạo một lớp học mới ở trạng thái nháp (draft) sau khi kiểm tra hết dữ liệu form.
 *   Đọc hàm này như mục lục: mỗi dòng là một bước, chi tiết nằm trong các hàm phụ phía trên.
 *   Thứ tự các bước là cố ý: bước nào đứng trước thì lỗi của nó được báo trước cho người dùng.
 * Được gọi ở:
 *   - Màn hình /manager/classes (src/routes/manager.classes.tsx), nút "Create & publish",
 *     gửi apiPost("/classes", ...) tức POST /v1/classes.
 *   - src/server/controllers/router.ts nhận request đó và gọi hàm này qua authed(...):
 *     authed kiểm tra đăng nhập và mở transaction, lỗi ở bất kỳ bước nào thì không lưu gì cả.
 *   - Tạo xong, màn hình gửi tiếp POST /v1/classes/:id/publish để tạo buổi học và mở đăng ký.
 * @param sql Kết nối database trong transaction do router mở.
 * @param request Request chứa body JSON của form tạo lớp.
 * @param user Người đang đăng nhập; phải là manager, id được ghi vào nhật ký (audit log).
 * @returns { status: 201, body: lớp vừa tạo }; màn hình lấy id trong đó để gọi publish.
 */
export async function classesCreate(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: chỉ quản lý mới được tạo lớp.
  requireRole(user, ["manager"]);

  // Bước 2: đọc form, đổi chữ thành số, rồi chắc chắn không thiếu ô bắt buộc nào.
  const form = await readClassForm(request);
  checkRequiredClassFields(form);

  // Bước 3: ngày hợp lệ (không ngược, không ở quá khứ) và lịch lặp đọc được.
  checkClassDates(form);
  const rule = parseClassRecurrenceRule(form.rrule);
  checkClassRecurrenceRule(rule);

  // Bước 4: người dạy, sân và trợ giảng có thật và dùng được cho lớp này.
  await checkClassCoach(sql, form);
  await checkClassCourt(sql, form);
  const assistantId = await checkClassAssistant(sql, form.assistantInput);

  // Bước 5: lịch mới không được đụng lớp khác cùng sân hoặc cùng người dạy.
  await checkClassScheduleClash(sql, form, assistantId);
  // Bước 5b: không buổi nào được rơi vào giờ sân đã có người đặt; nếu trùng thì gợi ý dời lớp theo tuần.
  await checkClassBookingClash(sql, form);

  // Bước 6: lưu nháp, ghi lại ai đã tạo, trả lớp vừa tạo để màn hình gọi publish tiếp.
  const row = await insertDraftClass(sql, form);
  await audit(sql, user.id, "create_class", "class", (row as { id: string }).id);
  return { status: 201, body: row };
}

// Thông tin lớp học cần thiết cho quá trình tạo các buổi học thực tế (materialization).
type MaterializationClass = {
  id: string;
  status: string;
  court_id: string;
  coach_id: string;
  assistant_id: string | null;
  rrule: string;
  duration_min: number;
  start_on: string;
  end_on: string;
};

// Khung giờ bắt đầu và kết thúc của một buổi học.
type ClassSessionTime = { start: Date; end: Date };

// Kết quả tổng hợp danh sách các buổi học được tạo thành công hoặc bị bỏ qua do trùng lịch.
type MaterializedSessionResult = {
  created: unknown[];
  skipped: unknown[];
};

/**
 * Làm gì: đọc và khóa dòng lớp để các lần tạo buổi không sửa cùng lớp đồng thời.
 * Được gọi ở: materializeClassSessions, bước 1.
 * @param sql Kết nối database trong transaction của hàm gọi.
 * @param classId Mã lớp nhận từ tham số id của materializeClassSessions.
 * @returns Dòng lớp tồn tại và chưa bị hủy.
 * @throws Lỗi 404 NOT_FOUND nếu không có lớp; lỗi 409 CONFLICT_STATE nếu lớp đã hủy; lỗi database được truyền nguyên vẹn.
 */
async function lockClassForMaterialization(
  sql: Sql,
  classId: string,
): Promise<MaterializationClass> {
  // Bước 1: Khóa dòng dữ liệu của lớp bằng "for update" để chống race condition khi nhiều worker cùng sinh buổi học.
  const classRecord = await one<MaterializationClass>(
    sql,
    `select * from classes where id = $1 for update`,
    [classId],
  );
  // Bước 2: Kiểm tra lớp phải tồn tại và chưa bị hủy.
  if (!classRecord) {
    throw err.notFound();
  }
  if (classRecord.status === "cancelled") {
    throw err.conflictState("That class is cancelled.");
  }
  return classRecord;
}

/**
 * Làm gì: tính các buổi từ hôm nay đến 14 ngày tới, giới hạn bởi ngày đầu và cuối của lớp.
 * Được gọi ở: materializeClassSessions, bước 2.
 * @param classRecord Dòng lớp đã khóa và kiểm tra từ lockClassForMaterialization.
 * @returns Danh sách giờ học theo đúng thứ tự expandWeekly trả về.
 * @throws Không chủ động tạo lỗi HTTP; lỗi xử lý ngày hoặc lịch lặp được truyền nguyên vẹn.
 */
function expandClassSessionDates(classRecord: MaterializationClass): ClassSessionTime[] {
  // Bước 1: Xác định cửa sổ 14 ngày tới (rolling window) theo giờ ICT để tính các buổi học cần sinh.
  const currentTime = new Date();
  const fourteenDaysLater = new Date(Date.now() + 14 * 86400000);
  const todayDate = ictDateString(currentTime);
  const todayStart = ictDateTime(todayDate, "00:00");

  // Tính từ đầu ngày để vẫn tạo đủ các buổi của hôm nay như lịch gốc.
  let windowStart = todayStart;
  if (classRecord.start_on >= todayDate) {
    windowStart = ictDateTime(classRecord.start_on, "00:00");
  }
  let windowEnd = fourteenDaysLater;
  if (classRecord.end_on < ictDateString(fourteenDaysLater)) {
    windowEnd = ictDateTime(classRecord.end_on, "23:59");
  }

  // Bước 2: Mở rộng lịch lặp RRULE theo tuần trong khoảng [windowStart, windowEnd] thành danh sách các mốc thời gian cụ thể.
  return expandWeekly(classRecord.rrule, classRecord.duration_min, windowStart, windowEnd);
}

/**
 * Làm gì: tìm lịch chiếm sân chồng lên khung giờ giữ sân của buổi học.
 * Được gọi ở: materializeMissingClassSessions, bước 4 của materializeClassSessions, sau khi sinh mã buổi và làm tròn giờ sân.
 * @param sql Kết nối database trong transaction của hàm gọi.
 * @param classRecord Dòng lớp đã khóa và kiểm tra từ lockClassForMaterialization.
 * @param courtTime Khung giờ giữ sân đã làm tròn bằng slotSpan.
 * @returns Dòng trùng đầu tiên, hoặc null nếu sân trống.
 * @throws Lỗi truy vấn được truyền nguyên vẹn cho hàm gọi; mã HTTP do tầng xử lý lỗi quyết định.
 */
async function findMaterializationCourtConflict(
  sql: Sql,
  classRecord: MaterializationClass,
  courtTime: ClassSessionTime,
) {
  // Dùng toán tử giao khoảng && của kiểu tstzrange trong PostgreSQL để tìm lịch giữ sân bị trùng lấn.
  return one(
    sql,
    `select 1 from occupancies
        where court_id = $1
          and tstzrange(start_at, end_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
        limit 1`,
    [classRecord.court_id, courtTime.start.toISOString(), courtTime.end.toISOString()],
  );
}

/**
 * Làm gì: kiểm tra lịch bận của người dạy chính rồi trợ giảng, dừng ở người bận đầu tiên.
 * Được gọi ở: materializeMissingClassSessions, bước 4 của materializeClassSessions, sau kiểm tra sân kể cả khi sân đã bận.
 * @param sql Kết nối database trong transaction của hàm gọi.
 * @param classRecord Dòng lớp đã khóa và kiểm tra từ lockClassForMaterialization.
 * @param occurrence Giờ bắt đầu và kết thúc một buổi do expandClassSessionDates tạo.
 * @returns true nếu có người dạy bận; false nếu không.
 * @throws Lỗi truy vấn được truyền nguyên vẹn cho hàm gọi; mã HTTP do tầng xử lý lỗi quyết định.
 */
async function hasMaterializationCoachConflict(
  sql: Sql,
  classRecord: MaterializationClass,
  occurrence: ClassSessionTime,
): Promise<boolean> {
  // Bước 1: Gom danh sách người dạy cần kiểm tra (HLV chính và trợ giảng nếu có).
  const coaches: string[] = [];
  for (const coachId of [classRecord.coach_id, classRecord.assistant_id]) {
    if (coachId) {
      coaches.push(coachId);
    }
  }
  // Bước 2: Kiểm tra lịch bận trong coach_occupancies, dừng ngay khi phát hiện người đầu tiên bị trùng giờ.
  for (const coachId of coaches) {
    const existingOccupancy = await one(
      sql,
      `select 1 from coach_occupancies
          where coach_id = $1
            and tstzrange(start_at, end_at, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
          limit 1`,
      [coachId, occurrence.start.toISOString(), occurrence.end.toISOString()],
    );
    if (existingOccupancy) {
      return true;
    }
  }
  return false;
}

/**
 * Làm gì: báo cho người thực hiện biết một buổi bị trùng lịch; tác vụ nền không có người nhận nên không gửi.
 * Được gọi ở: materializeMissingClassSessions hoặc saveMaterializedClassSession, bước 4 của materializeClassSessions, sau khi thêm vào skipped.
 * @param sql Kết nối database trong transaction của hàm gọi.
 * @param classId Mã lớp nhận từ tham số id của materializeClassSessions.
 * @param actorId Mã người thực hiện từ classesPublish; tác vụ generateSessions truyền null.
 * @param occurrence Giờ bắt đầu và kết thúc một buổi do expandClassSessionDates tạo.
 * @returns Không trả dữ liệu; chỉ thêm thông báo khi actorId có giá trị.
 * @throws Lỗi truy vấn được truyền nguyên vẹn cho hàm gọi; mã HTTP do tầng xử lý lỗi quyết định.
 */
async function notifyMaterializationConflict(
  sql: Sql,
  classId: string,
  actorId: string | null,
  occurrence: ClassSessionTime,
): Promise<void> {
  // Chỉ gửi thông báo in-app nếu có người thực hiện (actorId) thao tác trực tiếp; job nền tự động thì không gửi.
  if (actorId) {
    await enqueue(
      sql,
      "inapp",
      "class_changed",
      actorId,
      { class_id: classId, reason: "conflict", start: occurrence.start.toISOString() },
      `class_conflict|${classId}|${occurrence.start.toISOString()}`,
    );
  }
}

/**
 * Làm gì: lưu một buổi cùng lịch giữ sân và người dạy trong savepoint. Vì sao: nếu tranh chấp sân xảy ra lúc ghi, chỉ bỏ buổi đó.
 * Được gọi ở: materializeMissingClassSessions, bước 4 của materializeClassSessions, khi sân và người dạy đều trống.
 * @param sql Kết nối database trong transaction của hàm gọi.
 * @param classId Mã lớp nhận từ tham số id của materializeClassSessions.
 * @param classRecord Dòng lớp đã khóa và kiểm tra từ lockClassForMaterialization.
 * @param actorId Mã người thực hiện từ classesPublish; tác vụ generateSessions truyền null.
 * @param occurrence Giờ bắt đầu và kết thúc một buổi do expandClassSessionDates tạo.
 * @param sessionId Mã UUID vừa sinh bằng truy vấn trước khi kiểm tra trùng lịch.
 * @param courtTime Khung giờ giữ sân đã làm tròn bằng slotSpan.
 * @param result Hai danh sách created và skipped đang được tích lũy theo thứ tự ngày học.
 * @returns Không trả dữ liệu; thêm buổi thành công vào created hoặc buổi tranh chấp vào skipped.
 * @throws Lỗi ghi không phải xung đột lịch và lỗi gửi thông báo được truyền nguyên vẹn; mã HTTP do tầng xử lý lỗi quyết định.
 */
async function saveMaterializedClassSession(
  sql: Sql,
  classId: string,
  classRecord: MaterializationClass,
  actorId: string | null,
  occurrence: ClassSessionTime,
  sessionId: string,
  courtTime: ClassSessionTime,
  result: MaterializedSessionResult,
): Promise<void> {
  try {
    // Dùng savepoint để nếu buổi này bị xung đột giữ chỗ sân (race condition) thì rollback riêng buổi đó mà không hỏng transaction lớn.
    await sql.query("savepoint sp_occ");
    // Bước 1: Giữ chỗ sân qua hàm occupancy_attach của database.
    const courtOccupancy = await one<{ occupancy_attach: string }>(
      sql,
      `select occupancy_attach($1::uuid, $2::timestamptz, $3::timestamptz, 'session'::occ_kind, $4::uuid, null) as occupancy_attach`,
      [classRecord.court_id, courtTime.start.toISOString(), courtTime.end.toISOString(), sessionId],
    );
    // Bước 2: Tạo bản ghi buổi học mới trong bảng sessions ở trạng thái scheduled.
    await sql.query(
      `insert into sessions (id, class_id, court_id, start_at, end_at, status, occupancy_id)
         values ($1,$2,$3,$4,$5,'scheduled',$6)`,
      [
        sessionId,
        classId,
        classRecord.court_id,
        occurrence.start.toISOString(),
        occurrence.end.toISOString(),
        courtOccupancy!.occupancy_attach,
      ],
    );
    // Bước 3: Đánh dấu lịch bận của huấn luyện viên chính trong bảng coach_occupancies.
    await sql.query(
      `insert into coach_occupancies (coach_id, session_id, start_at, end_at) values ($1,$2,$3,$4)`,
      [
        classRecord.coach_id,
        sessionId,
        occurrence.start.toISOString(),
        occurrence.end.toISOString(),
      ],
    );
    // Bước 4: Đánh dấu lịch bận của trợ giảng trong bảng coach_occupancies nếu lớp có trợ giảng.
    if (classRecord.assistant_id) {
      await sql.query(
        `insert into coach_occupancies (coach_id, session_id, start_at, end_at) values ($1,$2,$3,$4)`,
        [
          classRecord.assistant_id,
          sessionId,
          occurrence.start.toISOString(),
          occurrence.end.toISOString(),
        ],
      );
    }
    await sql.query("release savepoint sp_occ");
    result.created.push({ id: sessionId, start_at: occurrence.start.toISOString() });
  } catch (error) {
    // Rollback về savepoint sp_occ để hủy việc giữ sân/HLV của riêng buổi này nếu xảy ra lỗi, không làm hỏng transaction chung.
    try {
      await sql.query("rollback to savepoint sp_occ");
    } catch {
      /* ignore */
    }
    // Nếu lỗi do xung đột slot sân (CONFLICT_SLOT), ghi nhận buổi học bị bỏ qua và thông báo cho người tạo/quản lý; lỗi khác ném tiếp.
    const slotConflict =
      isConflictSlot(error) || (error instanceof Error && /CONFLICT_SLOT/.test(error.message));
    if (slotConflict) {
      result.skipped.push({ start_at: occurrence.start.toISOString() });
      await notifyMaterializationConflict(sql, classId, actorId, occurrence);
      return;
    }
    throw error;
  }
}

/**
 * Làm gì: xử lý lần lượt từng ngày học: bỏ buổi đã có, kiểm tra trùng rồi lưu buổi còn thiếu.
 * Được gọi ở: materializeClassSessions, bước 4.
 * @param sql Kết nối database trong transaction của hàm gọi.
 * @param classId Mã lớp nhận từ tham số id của materializeClassSessions.
 * @param classRecord Dòng lớp đã khóa và kiểm tra từ lockClassForMaterialization.
 * @param actorId Mã người thực hiện từ classesPublish; tác vụ generateSessions truyền null.
 * @param occurrences Danh sách giờ học được tính ở bước 2.
 * @param slotMinutes Độ dài một slot sân lấy từ getSettings ở bước 3.
 * @returns Hai danh sách created và skipped; buổi đã tồn tại không được thêm vào danh sách nào.
 * @throws Lỗi truy vấn được truyền nguyên vẹn cho hàm gọi; mã HTTP do tầng xử lý lỗi quyết định.
 */
async function materializeMissingClassSessions(
  sql: Sql,
  classId: string,
  classRecord: MaterializationClass,
  actorId: string | null,
  occurrences: ClassSessionTime[],
  slotMinutes: number,
): Promise<MaterializedSessionResult> {
  const result: MaterializedSessionResult = { created: [], skipped: [] };
  for (const occurrence of occurrences) {
    // Bước 1: Kiểm tra buổi học đã tồn tại trước đó chưa (dựa theo start_at hoặc original_start_at khi từng đổi lịch).
    const existingSession = await one(
      sql,
      `select id from sessions
        where class_id = $1 and (start_at = $2 or original_start_at = $2)`,
      [classId, occurrence.start.toISOString()],
    );
    if (existingSession) {
      continue;
    }
    // Bước 2: Sinh sessionId mới và tính toán khung giờ giữ sân (courtTime) làm tròn theo slot phút của trung tâm.
    const sessionId = (await one<{ id: string }>(sql, `select gen_random_uuid() as id`))!.id;
    // The court is held for whole slots; the session keeps its declared times.
    const courtTime = slotSpan(occurrence.start, occurrence.end, slotMinutes);
    // Bước 3: Kiểm tra xung đột lịch: sân bận hoặc huấn luyện viên (chính/trợ giảng) bận dạy lớp khác.
    const courtBusy = await findMaterializationCourtConflict(sql, classRecord, courtTime);
    const coachBusy = await hasMaterializationCoachConflict(sql, classRecord, occurrence);
    const sessionHasConflict = courtBusy || coachBusy;
    if (sessionHasConflict) {
      // Ưu tiên lý do sân khi cả sân và người dạy đều bận.
      let conflictReason = "coach";
      if (courtBusy) {
        conflictReason = "court";
      }
      result.skipped.push({ start_at: occurrence.start.toISOString(), reason: conflictReason });
      await notifyMaterializationConflict(sql, classId, actorId, occurrence);
      continue;
    }

    // Bước 4: Không có xung đột, tiến hành lưu buổi học, giữ sân và lịch HLV vào database.
    await saveMaterializedClassSession(
      sql,
      classId,
      classRecord,
      actorId,
      occurrence,
      sessionId,
      courtTime,
      result,
    );
  }
  return result;
}

/**
 * Làm gì: tạo các buổi học còn thiếu trong 14 ngày tới, giữ sân và lịch người dạy; bỏ qua các buổi bị trùng.
 * Được gọi ở: classesPublish sau khi kiểm tra quyền manager:
 *   - Màn hình /manager/classes (src/routes/manager.classes.tsx), nút "Create & publish" hoặc "Publish",
 *     gửi POST /v1/classes/:id/publish; src/server/controllers/router.ts đi qua authed(...) rồi gọi classesPublish.
 *   - generateSessions trong src/server/data/jobs.ts cũng gọi trực tiếp trong withTx cho các lớp đang mở.
 * @param sql Kết nối database trong transaction của hàm gọi.
 * @param id Mã lớp từ đường dẫn API qua classesPublish, hoặc từ danh sách lớp mở của generateSessions.
 * @param actorId Mã người thực hiện từ classesPublish; tác vụ generateSessions truyền null.
 * @returns { created, skipped }; mỗi danh sách giữ đúng thứ tự xử lý, buổi đã tồn tại không được liệt kê.
 * @throws Lỗi 404 NOT_FOUND nếu không có lớp; lỗi 409 CONFLICT_STATE nếu lớp đã hủy. Lỗi khác được truyền nguyên vẹn.
 */
export async function materializeClassSessions(
  sql: Sql,
  id: string,
  actorId: string | null,
) {
  // Bước 1: khóa lớp và kiểm tra lớp còn tồn tại, chưa bị hủy.
  const classRecord = await lockClassForMaterialization(sql, id);

  // Bước 2: tính các ngày học nằm trong khoảng tạo buổi.
  const occurrences = expandClassSessionDates(classRecord);

  // Bước 3: đọc độ dài slot để giữ sân theo khung giờ của trung tâm.
  const { slot_minutes: slotMinutes } = await getSettings(sql);

  // Bước 4: xử lý từng buổi theo thứ tự và trả về các buổi đã tạo hoặc bỏ qua.
  return materializeMissingClassSessions(sql, id, classRecord, actorId, occurrences, slotMinutes);
}

/**
 * Làm gì: Phát hành lớp học: kiểm tra quyền manager, sinh các buổi học thực tế trong 14 ngày tới (materialize sessions) kèm giữ sân và HLV, sau đó chuyển trạng thái lớp sang 'open' để mở đăng ký.
 * Được gọi ở: Route POST /v1/classes/:id/publish (src/server/controllers/router.ts); màn hình /manager/classes (src/routes/manager.classes.tsx) khi nhấn nút Publish hoặc Create & publish.
 * @param sql Kết nối database trong transaction.
 * @param id Mã UUID của lớp học cần phát hành.
 * @param user Thông tin người dùng đang thực hiện yêu cầu (bắt buộc role manager).
 * @returns Object { status: 200, body: { sessions, skipped } } chứa danh sách buổi học được tạo và buổi bị bỏ qua do trùng lịch.
 * @throws 403 FORBIDDEN nếu không phải manager; 404 NOT_FOUND nếu lớp không tồn tại; 409 CONFLICT nếu tất cả buổi học đều bị trùng lịch và không có buổi nào hoạt động.
 */
export async function classesPublish(sql: Sql, id: string, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn — chỉ quản lý (manager) mới được phép phát hành lớp học.
  requireRole(user, ["manager"]);
  // Bước 2: Sinh các buổi học thực tế trong 14 ngày tới, tự động đặt sân và giữ lịch HLV.
  const result = await materializeClassSessions(sql, id, user.id);
  // Bước 3: Nếu không tạo được buổi mới nào nhưng có buổi bị bỏ qua, kiểm tra xem lớp đã có buổi học nào khác được lên lịch chưa; nếu hoàn toàn không có buổi nào thì chặn mở lớp.
  if (!result.created.length && result.skipped.length) {
    const any = await one(sql, `select 1 from sessions where class_id = $1 and status = 'scheduled' limit 1`, [id]);
    if (!any) throw err.conflict("Every date of this class clashes with a court booking or the coach's other classes.");
  }
  // Bước 4: Cập nhật trạng thái lớp thành 'open' để học viên có thể xem và đăng ký ghi danh.
  await sql.query(`update classes set status = 'open' where id = $1`, [id]);
  return { status: 200, body: { sessions: result.created, skipped: result.skipped } };
}

/** The tuition, and whether this person's membership ends after the class. */
/**
 * Làm gì: Tính toán học phí và kiểm tra điều kiện gói hội viên của học viên có kéo dài qua ngày kết thúc lớp học không; nếu chưa đủ hạn thì gợi ý gói hội viên phù hợp để gia hạn.
 * Được gọi ở: classQuote (bước 6, khi xem trước báo giá) và classesEnroll (bước 6, khi ghi danh lớp) trong src/server/controllers/handlers/classes.ts.
 * @param sql Kết nối database.
 * @param userId Mã UUID của học viên cần tính báo giá.
 * @param cl Đối tượng chứa thông tin lớp học (có ngày kết thúc lớp cl.end_on).
 * @param tuition Học phí thực tế phải đóng sau khi đã áp dụng khuyến mãi.
 * @param promo Thông tin mã khuyến mãi đã được tính toán (hoặc null nếu không có).
 * @returns Object chứa học phí (tuition_vnd, total_vnd), thông tin promo, cờ đủ điều kiện hội viên (eligible), ngày hết hạn hiện tại và gói gia hạn gợi ý (suggested_plan).
 * @throws Lỗi truy vấn database nếu xảy ra sự cố kết nối.
 */
async function enrollmentQuote(
  sql: Sql,
  userId: string,
  cl: { end_on: string },
  tuition: number,
  promo: { code: string; name: string; discount_vnd: number } | null,
) {
  // Bước 1: Kiểm tra hạn thẻ hội viên hiện tại so với ngày kết thúc lớp (hội viên bắt buộc phải có thẻ còn hạn trong suốt khóa học).
  const currentEnd = await activeMembershipEnd(sql, userId);
  const eligible = outlastsClass(currentEnd, cl.end_on);
  // Bước 2: Nếu chưa đủ hạn thẻ, truy vấn các gói hội viên đang mở bán để chuẩn bị gợi ý gói gia hạn phù hợp.
  const plans = eligible
    ? []
    : await sql.query<{ id: string; name: string; price_vnd: number; duration_months: number | null }>(
        `select id, name, price_vnd, duration_months from membership_plans
          where is_on_sale and duration_months is not null`,
      );
  // Bước 3: Tổng hợp báo giá gồm học phí, thông tin khuyến mãi, hạn thẻ và gói gia hạn đề xuất (nếu có).
  return {
    tuition_vnd: tuition,
    promo: promo ? { code: promo.code, name: promo.name, discount_vnd: promo.discount_vnd } : null,
    total_vnd: tuition,
    eligible,
    current_end: currentEnd,
    class_end: cl.end_on,
    suggested_plan: eligible ? null : planToOutlast(plans, currentEnd ?? ictDateString(), cl.end_on),
  };
}

/** The same figures enrolment will charge, without holding a seat. */
/**
 * Làm gì: Cung cấp báo giá ghi danh lớp học (học phí, mã giảm giá, kiểm tra hạn hội viên và trùng lịch) để hiển thị trước cho người dùng mà không tạo giữ chỗ (seat hold).
 * Được gọi ở: Route GET /v1/classes/:id/quote (src/server/controllers/router.ts); màn hình /app/classes qua openQuote (src/client/lib/pages/app.classes.ts); test runner (src/server/controllers/tx.test.ts).
 * @param sql Kết nối database dạng đọc.
 * @param id Mã UUID của lớp học cần báo giá.
 * @param request Request chứa query params (promo_code, user_id nếu lễ tân/quản lý tra cứu hộ).
 * @param user Thông tin người dùng đang đăng nhập (member, receptionist, manager).
 * @returns Object { status: 200, body } chứa chi tiết báo giá và gói gia hạn gợi ý.
 * @throws 403 FORBIDDEN nếu sai vai trò; 404 NOT_FOUND nếu lớp không tồn tại; 409 CONFLICT_RULE (BR-18, BR-53) nếu lớp chưa mở hoặc chưa định giá; lỗi trùng lịch từ assertNoClassClash.
 */
export async function classQuote(sql: Sql, id: string, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra phân quyền — chỉ member, receptionist hoặc manager mới được xem báo giá.
  if (!["member", "receptionist", "manager"].includes(user.role)) throw err.forbidden();
  // Bước 2: Xác định userId cần tính giá (member tự xem cho mình, nhân viên có thể xem hộ qua query param user_id).
  const params = new URL(request.url).searchParams;
  const userId = user.role === "member" ? user.id : (str(params.get("user_id")) ?? user.id);
  // Bước 3: Lấy thông tin lớp và kiểm tra quy tắc: lớp phải đang mở (BR-18) và đã được định giá bán (BR-53).
  const cl = await one<{ status: string; sport: string; price_vnd: number | null; start_on: string; end_on: string }>(
    sql,
    `select status::text, sport::text as sport, price_vnd, start_on::text as start_on, end_on::text as end_on
       from classes where id = $1`,
    [id],
  );
  if (!cl) throw err.notFound();
  if (cl.status !== "open") throw err.br("BR-18", "That class is not open yet.");
  if (cl.price_vnd == null) throw err.br("BR-53", "This class is not open for sale yet.");
  // Bước 4: Kiểm tra học viên có bị trùng giờ với bất kỳ lớp học nào khác đang tham gia không.
  await assertNoClassClash(sql, userId, id);
  // Bước 5: Áp dụng mã khuyến mãi (nếu có và lớp có tính phí) để tính học phí sau chiết khấu.
  const code = cl.price_vnd > 0 ? str(params.get("promo_code")) : null;
  const promo = code
    ? await quotePromo(sql, { code, userId, scope: "class", sport: cl.sport, orderVnd: cl.price_vnd })
    : null;
  const tuition = promo ? promo.final_vnd : cl.price_vnd;
  // Bước 6: Gọi enrollmentQuote để tính toán báo giá đầy đủ kèm tình trạng thẻ hội viên.
  return { status: 200, body: await enrollmentQuote(sql, userId, cl, tuition, promo) };
}

/**
 * Làm gì: Đăng ký ghi danh vào lớp học: kiểm tra các điều kiện nghiệp vụ (lớp mở, giá bán, trùng lịch, giới hạn số lớp, hạn thẻ hội viên), áp dụng mã giảm giá, sau đó tạo giữ chỗ (seat hold) hoặc đưa vào hàng đợi chờ (waitlist) nếu lớp đã hết chỗ.
 * Được gọi ở: Route POST /v1/classes/:id/enroll (src/server/controllers/router.ts); màn hình học viên /app/classes qua enrol (src/client/lib/pages/app.classes.ts); màn hình lễ tân /desk/member/:id (src/routes/desk.member.$id.tsx); test runner (src/server/controllers/tx.test.ts).
 * @param sql Kết nối database trong transaction.
 * @param id Mã UUID của lớp học cần đăng ký.
 * @param request Request chứa body JSON (promo_code, user_id nếu nhân viên đăng ký hộ).
 * @param user Thông tin người dùng thực hiện yêu cầu (member, receptionist, manager).
 * @returns Object { status: 201, body } trả về bản ghi ghi danh kèm báo giá ({ enrollment, quote }) hoặc trạng thái hàng đợi ({ enrollment, waitlisted: true }).
 * @throws 403 FORBIDDEN nếu member đăng ký hộ người khác; 404 NOT_FOUND nếu lớp không tồn tại; 409 CONFLICT_RULE (BR-18, BR-22, BR-53) nếu lớp chưa mở, đã đăng ký rồi hoặc lớp chưa định giá.
 */
export async function classesEnroll(sql: Sql, id: string, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn — chỉ member, receptionist hoặc manager mới được thực hiện ghi danh.
  if (!["member", "receptionist", "manager"].includes(user.role)) throw err.forbidden();
  // Bước 2: Đọc dữ liệu body và xác định userId (member chỉ được đăng ký cho bản thân; nhân viên có thể đăng ký hộ).
  const b = await request.headers.get("content-type") ? await readJson(request) : {};
  const userId =
    user.role === "member" ? user.id : (str(b.user_id) ?? user.id);
  if (user.role === "member" && str(b.user_id) && str(b.user_id) !== user.id) {
    throw err.forbidden();
  }
  // Bước 3: Lấy thông tin lớp học và kiểm tra quy tắc: lớp phải đang mở (BR-18) và đã định giá bán (BR-53).
  const cl = await one<{
    id: string;
    status: string;
    sport: string;
    capacity: number;
    enrolled_count: number;
    price_vnd: number | null;
    start_on: string;
    end_on: string;
  }>(sql, `select *, start_on::text as start_on, end_on::text as end_on from classes where id = $1`, [id]);
  if (!cl) throw err.notFound();
  if (cl.status !== "open") throw err.br("BR-18", "That class is not open yet.");
  if (cl.price_vnd == null) throw err.br("BR-53", "This class is not open for sale yet.");
  // Bước 4: Kiểm tra các ràng buộc: không trùng giờ học, không vượt số lớp tối đa đang hoạt động, và thẻ hội viên phải còn hạn suốt khóa học.
  const settings = await getSettings(sql);
  await assertNoClassClash(sql, userId, id);
  await assertUnderClassLimit(sql, userId, id, settings.max_active_classes);
  await assertMembershipOutlastsClass(sql, userId, cl.end_on);
  // Bước 5: Áp dụng mã khuyến mãi (nếu có và lớp có tính phí) để tính học phí thực tế.
  const promoCode = cl.price_vnd > 0 ? str(b.promo_code) : null;
  const promo = promoCode
    ? await quotePromo(sql, { code: promoCode, userId, scope: "class", sport: cl.sport, orderVnd: cl.price_vnd })
    : null;
  const tuition = promo ? promo.final_vnd : cl.price_vnd;
  // Bước 6: Tạo savepoint sp_enroll và gọi enrollment_hold trong DB để giữ chỗ trong khoảng thời gian quy định (class_hold_minutes).
  await sql.query("savepoint sp_enroll");
  try {
    const row = await one<{ enrollment_hold: string }>(
      sql,
      `select enrollment_hold($1::uuid, $2::uuid, $3::int, $4::int) as enrollment_hold`,
      [id, userId, settings.class_hold_minutes, cl.price_vnd],
    );
    const quote = await enrollmentQuote(sql, userId, cl, tuition, promo);
    const total = quote.total_vnd;
    // Cập nhật giá sau chiết khấu và mã khuyến mãi vào bản ghi ghi danh vừa tạo.
    await sql.query(
      `update enrollments set price_vnd = $2, promo_id = $3, promo_discount_vnd = $4
        where id = $1`,
      [row!.enrollment_hold, total, promo?.promo_id ?? null, promo?.discount_vnd ?? 0],
    );
    // Nếu tổng học phí là 0đ (miễn phí), xác nhận chỗ thành công ngay lập tức mà không cần qua bước thanh toán.
    if (total === 0) {
      // Nothing to pay: the seat is confirmed at once.
      await sql.query(`update enrollments set status = 'confirmed', hold_until = null where id = $1`, [row!.enrollment_hold]);
    }
    await sql.query("release savepoint sp_enroll");
    // Bước 7: Nếu lớp đã đủ sĩ số sau khi giữ chỗ, chuyển trạng thái các lời mời waitlist đang chờ thành 'skipped' và thông báo cho học viên liên quan.
    const updatedClass = await one<{ enrolled_count: number; capacity: number }>(
      sql,
      `select enrolled_count, capacity from classes where id = $1`,
      [id],
    );
    if (updatedClass && updatedClass.enrolled_count >= updatedClass.capacity) {
      const pendingOffers = await sql.query<{ id: string; user_id: string }>(
        `select o.id, e.user_id
           from waitlist_offers o
           join enrollments e on e.id = o.enrollment_id
          where e.class_id = $1 and o.status = 'pending' and o.expires_at > now()`,
        [id],
      );
      for (const po of pendingOffers) {
        await sql.query(`update waitlist_offers set status = 'skipped' where id = $1`, [po.id]);
        await enqueue(sql, "inapp", "waitlist_seat_taken", po.user_id, { class_id: id, offer_id: po.id }, `wl_st|${po.id}`);
      }
    }
    const enr = await one(sql, `select * from enrollments where id = $1`, [row!.enrollment_hold]);
    return { status: 201, body: { enrollment: enr, quote } };
  } catch (e) {
    // Rollback về savepoint sp_enroll nếu việc giữ chỗ phát sinh ngoại lệ (ví dụ lớp đã đầy hoặc học viên đã đăng ký).
    try {
      await sql.query("rollback to savepoint sp_enroll");
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : String(e);
    // Xử lý ngoại lệ lớp đã đầy (CLASS_FULL): chuyển học viên vào hàng đợi (waitlist) bằng enrollment_waitlist.
    if (msg.includes("CLASS_FULL")) {
      const wl = await one<{ enrollment_waitlist: string }>(
        sql,
        `select enrollment_waitlist($1::uuid, $2::uuid) as enrollment_waitlist`,
        [id, userId],
      );
      const enr = await one(sql, `select * from enrollments where id = $1`, [wl!.enrollment_waitlist]);
      return { status: 201, body: { enrollment: enr, waitlisted: true } };
    }
    // Xử lý ngoại lệ đã đăng ký lớp này trước đó (ALREADY_ENROLLED) theo quy tắc nghiệp vụ BR-22.
    if (msg.includes("ALREADY_ENROLLED")) throw err.br("BR-22", "You are already enrolled.");
    throw e;
  }
}

// Các trường hợp kết quả có thể xảy ra khi quyết toán thanh toán ghi danh lớp học (settleEnrollment).
export type SettleOutcome =
  | "confirmed"
  | "already"
  | "duplicate"
  | "late_confirmed"
  | "late_no_seat"
  | "released"
  | "class_cancelled";

/** Outcomes where money landed without buying a seat: staff must handle them by hand. */
const FLAGGED: Record<string, string> = {
  late_no_seat: "enrollment_paid_no_seat",
  released: "enrollment_paid_released",
  class_cancelled: "enrollment_paid_class_cancelled",
  duplicate: "enrollment_paid_twice",
};

/**
 * Money for a class seat that bought no seat: write the audit row and tell the
 * desk. Every active receptionist and manager gets an in-app notification (the
 * same fan-out the absence alert uses for managers), keyed per payment and
 * per person, so a webhook retry does not notify twice.
 */
/**
 * Làm gì: Ghi nhật ký kiểm toán (audit log) và gửi thông báo in-app đến toàn bộ nhân viên lễ tân và quản lý khi có sự cố thanh toán tiền học nhưng không giữ được chỗ (ví dụ: thanh toán trễ lớp đã hết chỗ, lớp bị hủy, thanh toán trùng).
 * Được gọi ở: settleEnrollment (trong callback done) khi phân loại thanh toán rơi vào các trường hợp ngoại lệ FLAGGED trong src/server/controllers/handlers/classes.ts.
 * @param sql Kết nối database trong transaction.
 * @param outcome Kết quả phân loại thanh toán bất thường (SettleOutcome: late_no_seat, released, class_cancelled, duplicate).
 * @param enrollmentId Mã UUID của bản ghi ghi danh (enrollments.id).
 * @param classId Mã UUID của lớp học.
 * @param paymentId Mã thanh toán (payments.id) nếu có, hoặc null.
 * @returns Không trả về dữ liệu.
 * @throws Lỗi truy vấn database nếu thao tác ghi audit hoặc enqueue thông báo thất bại.
 */
async function flagSeatPayment(
  sql: Sql,
  outcome: SettleOutcome,
  enrollmentId: string,
  classId: string,
  paymentId: string | null,
) {
  // Bước 1: Kiểm tra xem kết quả thanh toán có nằm trong danh sách cần gắn cờ cảnh báo (FLAGGED) không.
  const action = FLAGGED[outcome];
  if (!action) return;
  // Bước 2: Ghi audit log để nhân viên có căn cứ đối soát và xử lý hoàn tiền hoặc xếp lớp thủ công.
  await audit(sql, null, action, "enrollment", enrollmentId, null, paymentId ? { payment_id: paymentId } : null);
  // Bước 3: Lấy thông tin chi tiết của học viên và lớp học để hiển thị rõ trong thông báo ngoại lệ.
  const who = await one<{ user_id: string; full_name: string; sport: string; level: string }>(
    sql,
    `select e.user_id, u.full_name, c.sport::text as sport, c.level
       from enrollments e join users u on u.id = e.user_id join classes c on c.id = e.class_id
      where e.id = $1`,
    [enrollmentId],
  );
  // Bước 4: Gửi thông báo in-app đến tất cả lễ tân và quản lý đang hoạt động (dùng idempotency key để tránh gửi lặp khi webhook retry).
  const staff = await sql.query<{ id: string }>(
    `select id from users where role in ('receptionist','manager') and status = 'active'`,
  );
  for (const s of staff) {
    await enqueue(
      sql,
      "inapp",
      "class_payment_exception",
      s.id,
      {
        reason: outcome,
        enrollment_id: enrollmentId,
        class_id: classId,
        payment_id: paymentId,
        user_id: who?.user_id ?? null,
        member_name: who?.full_name ?? null,
        sport: who?.sport ?? null,
        level: who?.level ?? null,
      },
      `class_pay_exc|${paymentId ?? enrollmentId}|${outcome}|${s.id}`,
    );
  }
}

/**
 * Money has arrived for a class seat: turn the hold into a confirmed seat.
 *
 * This is the one place that decides whether a payment still buys a seat, so
 * the desk, payOS and any later path agree. Locks the class, then the enrolment
 * (the order enrollment_hold uses). The callers that hold a payment row lock it
 * before calling, so the full order is payment → class → enrolment.
 *
 * - The class was cancelled: nobody is seated; the money is flagged.
 * - The seat is held: it is confirmed.
 * - It is already confirmed: by this payment (a retry) is fine; by another
 *   payment is a double charge, flagged.
 * - The member released the hold (`released`): not re-seated; flagged.
 * - The hold lapsed: seated again only if a seat is free, otherwise flagged.
 *
 * A flagged outcome still leaves the payment posted (money did arrive); the
 * audit row and a notification to the desk make it a by-hand exception.
 */
/** The code priced into the seat counts as used once the money for it has posted (BR-41). */
/**
 * Làm gì: Ghi nhận mã khuyến mãi áp dụng cho lượt ghi danh đã được sử dụng (redeem) ngay khi tiền thanh toán đã vào tài khoản theo quy tắc nghiệp vụ BR-41.
 * Được gọi ở: settleEnrollment (dòng 1169 và 1193) khi xác nhận đăng ký thành công (confirmed hoặc late_confirmed) trong src/server/controllers/handlers/classes.ts.
 * @param sql Kết nối database trong transaction.
 * @param enrollmentId Mã UUID của bản ghi ghi danh.
 * @param paymentId Mã UUID của giao dịch thanh toán thành công (nếu không có thì bỏ qua).
 * @returns Không trả về dữ liệu.
 * @throws Lỗi ném ra từ redeemPromo nếu cập nhật số lượt dùng mã khuyến mãi thất bại.
 */
async function redeemEnrollmentPromo(sql: Sql, enrollmentId: string, paymentId: string | null | undefined) {
  // Nếu không có paymentId (ví dụ lớp miễn phí hoặc xác nhận không qua thanh toán), bỏ qua việc ghi nhận redeem.
  if (!paymentId) return;
  // Lấy thông tin mã khuyến mãi đã lưu trong bản ghi ghi danh.
  const e = await one<{ user_id: string; promo_id: string | null; promo_discount_vnd: number }>(
    sql,
    `select user_id, promo_id, promo_discount_vnd from enrollments where id = $1`,
    [enrollmentId],
  );
  // Theo quy tắc BR-41: mã khuyến mãi chỉ được trừ lượt dùng thực tế khi tiền đã về tài khoản.
  if (e?.promo_id) {
    await redeemPromo(sql, { promoId: e.promo_id, userId: e.user_id, paymentId, discountVnd: e.promo_discount_vnd });
  }
}

/**
 * Làm gì: Xử lý ghi nhận tiền học đã thanh toán thành công (từ lễ tân thu tiền mặt hoặc webhook PayOS): chuyển từ trạng thái giữ chỗ (hold) sang xác nhận chính thức (confirmed), hoặc xử lý các ngoại lệ (thanh toán trễ, lớp bị hủy, thanh toán trùng).
 * Được gọi ở: Lễ tân thu tiền tại quầy (src/server/controllers/handlers/desk.ts qua payEnrollmentDesk); Webhook thanh toán trực tuyến PayOS (src/server/controllers/handlers/online.ts qua onPayOSWebhook); test runner (src/server/controllers/tx.test.ts).
 * @param sql Kết nối database trong transaction.
 * @param enrollmentId Mã UUID của bản ghi ghi danh cần quyết toán.
 * @param opts Tùy chọn gồm paymentId (mã thanh toán nếu có) và released (cờ báo người dùng đã chủ động hủy giữ chỗ).
 * @returns Object { outcome: SettleOutcome } chứa kết quả xử lý (confirmed, already, duplicate, late_confirmed, late_no_seat, released, class_cancelled).
 * @throws 404 NOT_FOUND nếu không tìm thấy bản ghi enrollment hoặc class tương ứng.
 */
export async function settleEnrollment(
  sql: Sql,
  enrollmentId: string,
  opts: { paymentId?: string | null; released?: boolean } = {},
): Promise<{ outcome: SettleOutcome }> {
  const paymentId = opts.paymentId ?? null;
  // Bước 1: Khóa dòng của lớp học (classes) rồi đến bản ghi ghi danh (enrollments) bằng FOR UPDATE theo đúng thứ tự (payment -> class -> enrollment) để tránh deadlock khi có nhiều thanh toán đồng thời.
  const pre = await one<{ class_id: string }>(sql, `select class_id from enrollments where id = $1`, [enrollmentId]);
  if (!pre) throw err.notFound();
  const cl = await one<{ enrolled_count: number; capacity: number; status: string }>(
    sql,
    `select enrolled_count, capacity, status::text as status from classes where id = $1 for update`,
    [pre.class_id],
  );
  if (!cl) throw err.notFound();
  const enr = await one<{ id: string; class_id: string; status: string }>(
    sql,
    `select id, class_id, status::text as status from enrollments where id = $1 for update`,
    [enrollmentId],
  );
  if (!enr) throw err.notFound();
  // Helper kết thúc xử lý ngoại lệ: gắn cờ cảnh báo cho lễ tân và trả về kết quả outcome tương ứng.
  const done = async (outcome: SettleOutcome) => {
    await flagSeatPayment(sql, outcome, enrollmentId, enr.class_id, paymentId);
    return { outcome };
  };
  // Bước 2: Kiểm tra nếu lớp học đã bị hủy mà học viên chưa kịp xác nhận chỗ trước đó: tiền đến nhưng không thể xếp lớp -> gắn cờ class_cancelled để nhân viên quầy xử lý hoàn tiền thủ công.
  if (cl.status !== "open" && cl.status !== "closed" && enr.status !== "confirmed") {
    return done("class_cancelled");
  }
  // Trường hợp 1: Chỗ đang ở trạng thái 'hold' -> chuyển sang 'confirmed', xóa thời hạn giữ chỗ, áp dụng gia hạn hội viên và đổi mã giảm giá.
  if (enr.status === "hold") {
    await sql.query(
      `update enrollments set status = 'confirmed', hold_until = null, transfer_requested_at = null where id = $1`,
      [enrollmentId],
    );
    await applyExtension(sql, enrollmentId);
    await redeemEnrollmentPromo(sql, enrollmentId, paymentId);
    return { outcome: "confirmed" };
  }
  // Trường hợp 2: Chỗ đã được xác nhận ('confirmed') từ trước -> kiểm tra xem có giao dịch khác đã posted không để phát hiện thanh toán trùng lặp (duplicate).
  if (enr.status === "confirmed") {
    if (paymentId) {
      const other = await one(
        sql,
        `select 1 from payments
          where ref_type = 'enrollment' and ref_id = $1 and id <> $2 and status = 'posted' and amount_vnd > 0
          limit 1`,
        [enrollmentId, paymentId],
      );
      if (other) return done("duplicate");
    }
    return { outcome: "already" };
  }
  // Trường hợp 3: Hội viên đã chủ động giải phóng chỗ (released) trước đó -> không xếp lại chỗ, đánh dấu 'released' để lễ tân xử lý hoàn tiền.
  if (opts.released && enr.status === "cancelled") return done("released");
  // Trường hợp 4: Giữ chỗ đã quá hạn (lapsed hold) nhưng tiền vẫn về -> nếu lớp còn chỗ (enrolled_count < capacity) thì tăng sĩ số và nhận muộn (late_confirmed).
  if (cl.enrolled_count < cl.capacity) {
    await sql.query(`update classes set enrolled_count = enrolled_count + 1 where id = $1`, [enr.class_id]);
    await sql.query(
      `update enrollments set status = 'confirmed', hold_until = null, transfer_requested_at = null, waitlist_pos = null where id = $1`,
      [enrollmentId],
    );
    await applyExtension(sql, enrollmentId);
    await redeemEnrollmentPromo(sql, enrollmentId, paymentId);
    return { outcome: "late_confirmed" };
  }
  // Trường hợp 5: Lớp đã đủ sĩ số, không còn chỗ nhận thêm -> đánh dấu 'late_no_seat' để tạo ngoại lệ đối soát cho nhân viên xử lý thủ công.
  return done("late_no_seat");
}

/** The member says they have paid by bank transfer: the hold gets the longer transfer clock. */
export async function enrollmentTransfer(sql: Sql, id: string, user: PublicUser) {
  // Bước 1: Kiểm tra định dạng ID hợp lệ và khóa dòng enrollment bằng FOR UPDATE OF e cùng thông tin trạng thái lớp học.
  if (!isUuid(id)) throw err.notFound();
  const enr = await one<{
    user_id: string;
    status: string;
    hold_until: string | null;
    transfer_requested_at: string | null;
    class_status: string;
  }>(
    sql,
    `select e.user_id, e.status::text as status, e.hold_until, e.transfer_requested_at, c.status::text as class_status
       from enrollments e join classes c on c.id = e.class_id
      where e.id = $1 for update of e`,
    [id],
  );
  if (!enr) throw err.notFound();
  // Bước 2: Kiểm tra các điều kiện nghiệp vụ: chỉ chính chủ mới được báo chuyển khoản, lớp chưa bị hủy (BR-18), chưa có yêu cầu chuyển khoản trước đó và hạn giữ chỗ chưa hết hạn (BR-28).
  if (enr.user_id !== user.id) throw err.forbidden();
  if (enr.class_status === "cancelled") throw err.br("BR-18", "That class is cancelled.");
  if (enr.status === "hold" && enr.transfer_requested_at) {
    throw err.conflictState("Reception is already checking the bank for this one.");
  }
  if (enr.status !== "hold" || !enr.hold_until || new Date(enr.hold_until) <= new Date()) {
    throw err.br("BR-28", "This seat hold has expired.");
  }
  // Bước 3: Đọc cấu hình hệ thống và gia hạn thời gian giữ chỗ (hold_until) thêm transfer_hold_minutes phút để chờ lễ tân đối soát tài khoản ngân hàng.
  const settings = await getSettings(sql);
  await sql.query(
    `update enrollments
        set hold_until = now() + ($2::int * interval '1 minute'), transfer_requested_at = now()
      where id = $1`,
    [id, settings.transfer_hold_minutes],
  );
  // Bước 4: Lấy lại thông tin đăng ký mới nhất sau khi gia hạn để trả về cho client.
  const fresh = await one(sql, `select * from enrollments where id = $1`, [id]);
  return { status: 200, body: { enrollment: fresh } };
}

/**
 * Làm gì: Hủy lượt đăng ký lớp học (suất giữ chỗ hold, danh sách chờ waitlisted, hoặc suất đã xác nhận confirmed) của hội viên hoặc do huấn luyện viên / quản lý thực hiện.
 * Được gọi ở: URL DELETE /api/enrollments/:id (src/server/controllers/router.ts qua authed).
 * @param sql Kết nối database trong transaction do router quản lý.
 * @param id Mã định danh UUID của bản ghi enrollment cần hủy.
 * @param user Thông tin người dùng đang gọi API (hội viên chỉ được hủy của mình, coach chỉ được hủy trong lớp mình dạy).
 * @returns Object phản hồi chứa status 200 và { ok: true }.
 * @throws Lỗi 404 NOT_FOUND nếu không tìm thấy enrollment hoặc lớp học; lỗi 403 FORBIDDEN nếu sai quyền; lỗi 409 CONFLICT nếu trạng thái không hợp lệ; lỗi BR-24 nếu hủy suất confirmed quá sát giờ học tiếp theo.
 */
export async function enrollmentDelete(sql: Sql, id: string, user: PublicUser) {
  // Bước 1: Kiểm tra sự tồn tại của lượt đăng ký và xác thực quyền hạn (hội viên chỉ được hủy của chính mình; huấn luyện viên phải phụ trách lớp này).
  const enr = await one<{
    id: string;
    class_id: string;
    user_id: string;
    status: string;
  }>(sql, `select * from enrollments where id = $1`, [id]);
  if (!enr) throw err.notFound();
  if (user.role === "member" && enr.user_id !== user.id) throw err.forbidden();
  if (user.role === "coach") {
    const cl = await one<{ coach_id: string; assistant_id: string | null }>(
      sql,
      `select coach_id, assistant_id from classes where id = $1`,
      [enr.class_id],
    );
    if (!cl) throw err.notFound();
    assertClassStaff(cl, user);
  }
  // Lock order is payment → class → enrolment, the order settleOnline uses (it locks the payment
  // row, then settleEnrollment locks the class and the enrolment). A hold's pending payOS links are
  // locked first, then the class, then the row is re-read so a payment or expiry that just landed is seen.
  // Bước 2: Khóa dữ liệu theo thứ tự chuẩn (link thanh toán payOS -> class -> enrollment) để tránh deadlock khi có webhook thanh toán đến cùng lúc.
  const links = enr.status === "hold" ? await lockEnrollmentLinks(sql, [id]) : [];
  await sql.query(`select 1 from classes where id = $1 for update`, [enr.class_id]);
  const locked = await one<{ status: string }>(sql, `select status::text as status from enrollments where id = $1 for update`, [id]);
  if (!locked) throw err.notFound();
  enr.status = locked.status;
  // Bước 3A: Xử lý hủy suất đang giữ chỗ ('hold') -> hủy đăng ký, giảm sĩ số lớp, thu hồi link payOS và mời người đầu tiên trong danh sách chờ.
  if (enr.status === "hold") {
    // Nothing has been paid for a hold, so letting it go has no cutoff and nothing to refund.
    await sql.query(`update enrollments set status = 'cancelled', waitlist_pos = null, hold_until = null where id = $1`, [id]);
    await sql.query(`update classes set enrolled_count = greatest(enrolled_count - 1, 0) where id = $1`, [enr.class_id]);
    // Withdraw the link at payOS so a late scan cannot take money for a seat the member gave up.
    // RELEASED tells settleOnline, should money still arrive, not to seat the member again.
    await withdrawLinks(sql, links, "Seat released", "RELEASED");
    await inviteWaitlist(sql, enr.class_id);
    return { status: 200, body: { ok: true } };
  }
  // Bước 3B: Xử lý hủy suất trong danh sách chờ ('waitlisted') -> đánh dấu hủy và dồn lại thứ tự hàng đợi (compactWaitlist).
  if (enr.status === "waitlisted") {
    await sql.query(`update enrollments set status = 'cancelled', waitlist_pos = null where id = $1`, [id]);
    // A member who leaves while holding an offer gives that offer up: withdraw it so it stops showing
    // and stops counting against the open seat, then pass the seat to the next person in line.
    await sql.query(
      `update waitlist_offers set status = 'expired' where enrollment_id = $1 and status = 'pending'`,
      [id],
    );
    await compactWaitlist(sql, enr.class_id);
    await inviteWaitlist(sql, enr.class_id);
    return { status: 200, body: { ok: true } };
  }
  // Bước 3C: Xử lý hủy suất đã xác nhận ('confirmed') -> bắt buộc phải hủy trước buổi học kế tiếp ít nhất cancel_class_hours tiếng (BR-24).
  if (enr.status !== "confirmed") throw err.conflictState();
  const settings = await getSettings(sql);
  const next = await one<{ start_at: string }>(
    sql,
    `select start_at from sessions
      where class_id = $1 and status = 'scheduled' and start_at > now()
      order by start_at limit 1`,
    [enr.class_id],
  );
  if (next) {
    const hours = (new Date(next.start_at).getTime() - Date.now()) / 3600000;
    if (hours < settings.cancel_class_hours) {
      throw err.br("BR-24", `Cancel at least ${settings.cancel_class_hours} hours before the next session.`);
    }
  }
  // A member leaving a class gets nothing back: tuition and extension stay paid, the end date stays.
  // Bước 4: Cập nhật trạng thái hủy, giảm sĩ số lớp (học phí không hoàn lại theo chính sách) và mời người tiếp theo từ danh sách chờ.
  await sql.query(`update enrollments set status = 'cancelled', waitlist_pos = null where id = $1`, [id]);
  await sql.query(
    `update classes set enrolled_count = greatest(enrolled_count - 1, 0) where id = $1`,
    [enr.class_id],
  );
  await inviteWaitlist(sql, enr.class_id);
  return { status: 200, body: { ok: true } };
}

/**
 * Làm gì: Lấy danh sách lịch dạy (các buổi học) sắp tới của huấn luyện viên hiện tại, hoặc toàn bộ lịch dạy nếu là quản lý.
 * Được gọi ở: URL GET /api/coach/schedule (src/server/controllers/router.ts qua authedRead).
 * @param sql Kết nối database được mở từ router.
 * @param user Thông tin người dùng đăng nhập (yêu cầu vai trò 'coach' hoặc 'manager').
 * @returns Danh sách tối đa 80 buổi học từ 1 ngày trước trở đi kèm thông tin sân, sĩ số và mã lớp (class_code).
 * @throws Lỗi 403 FORBIDDEN nếu người dùng không có vai trò coach hoặc manager.
 */
export async function coachSchedule(sql: Sql, user: PublicUser) {
  // Bước 1: Kiểm tra phân quyền, chỉ cho phép huấn luyện viên (coach) hoặc quản lý (manager) xem lịch dạy.
  requireRole(user, ["coach", "manager"]);
  // Bước 2: Truy vấn tối đa 80 buổi học từ 1 ngày trước trở đi, lọc theo HLV chính hoặc trợ giảng (nếu là manager thì xem được toàn bộ).
  const items = await sql.query(
    `select s.id, s.start_at, s.end_at, s.status, cl.level, cl.sport, cl.id as class_id,
            cl.capacity, cl.enrolled_count, cl.min_enrolled, c.court_code
       from sessions s
       join classes cl on cl.id = s.class_id
       join courts c on c.id = s.court_id
      where ($2::boolean or cl.coach_id = $1 or cl.assistant_id = $1)
        -- A manager corrects registers after the fact, so their list reaches two weeks back.
        and s.start_at > now() - (case when $2::boolean then interval '14 days' else interval '1 day' end)
        and ($2::boolean = false or s.start_at < now() + interval '2 days')
      order by case when $2::boolean then -extract(epoch from s.start_at) else extract(epoch from s.start_at) end
      limit 200`,
    [user.id, user.role === "manager"],
  );
  // Bước 3: Định dạng mã lớp hiển thị (class_code) theo môn và trình độ rồi trả về danh sách buổi học.
  return {
    status: 200,
    body: { items: items.map((s) => ({ ...s, class_code: classCode(String(s.sport), String(s.level), String(s.class_id)) })) },
  };
}

/**
 * Làm gì: Lấy danh sách các lớp học mà huấn luyện viên đang phụ trách (huấn luyện viên chính hoặc trợ giảng), kèm số buổi học sắp diễn ra.
 * Được gọi ở: URL GET /api/coach/classes (src/server/controllers/router.ts qua authedRead).
 * @param sql Kết nối database được mở từ router.
 * @param user Thông tin người dùng hiện tại (bắt buộc role là 'coach' hoặc 'manager').
 * @returns Object chứa tổng số lượng lớp (total) và mảng chi tiết các lớp học kèm mã code hiển thị.
 * @throws Lỗi 403 FORBIDDEN nếu người dùng không phải coach hoặc manager.
 */
export async function coachClasses(sql: Sql, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn, chỉ chấp nhận người dùng có vai trò coach hoặc manager.
  requireRole(user, ["coach", "manager"]);
  // Bước 2: Truy vấn danh sách lớp học kèm thông tin sân, tên HLV và đếm số buổi học sắp diễn ra (upcoming_sessions_count).
  const items = await sql.query(
    `select cl.id, cl.sport, cl.level, cl.capacity, cl.enrolled_count, cl.rrule, cl.duration_min,
            cl.start_on::text, cl.end_on::text, cl.status, cl.court_id, c.court_code,
            cl.coach_id, u.full_name as coach_name, cl.min_enrolled,
            (select count(*)::int from sessions s where s.class_id = cl.id and s.status = 'scheduled') as upcoming_sessions_count
       from classes cl
       join courts c on c.id = cl.court_id
       join users u on u.id = cl.coach_id
      where ($2::boolean or cl.coach_id = $1 or cl.assistant_id = $1)
      order by cl.status = 'open' desc, cl.start_on desc`,
    [user.id, user.role === "manager"],
  );
  // Bước 3: Gắn mã hiển thị (code) cho từng lớp và trả về tổng số lượng cùng danh sách lớp học.
  return {
    status: 200,
    body: {
      total: items.length,
      items: items.map((c) => ({ ...c, code: classCode(String(c.sport), String(c.level), String(c.id)) })),
    },
  };
}

/**
 * One class, opened (B-08 / D-07).
 *
 * The manager list showed a card and nothing behind it. This is what is behind
 * it: the class itself, every session with its date, time, court and headcount,
 * and who is on the roster. Reception sees the same thing the manager does; a
 * coach sees only a class they teach.
 */
export async function classDetail(sql: Sql, classId: string, user: PublicUser) {
  // Bước 1: Xác thực vai trò (manager, receptionist hoặc coach dạy lớp) và truy vấn thông tin chi tiết đầy đủ của lớp học.
  requireRole(user, ["manager", "receptionist", "coach"]);
  const cl = await one<{
    id: string;
    sport: string;
    level: string;
    status: string;
    capacity: number;
    enrolled_count: number;
    rrule: string;
    duration_min: number;
    start_on: string;
    end_on: string;
    court_id: string;
    court_code: string;
    coach_id: string;
    assistant_id: string | null;
    coach_name: string;
    assistant_name: string | null;
    price_vnd: number | null;
    min_enrolled: number | null;
    description: string | null;
    syllabus: string | null;
    who_for: string | null;
    bring: string | null;
  }>(
    sql,
    `select cl.id, cl.sport::text as sport, cl.level, cl.status::text as status, cl.capacity, cl.enrolled_count, cl.min_enrolled,
            cl.rrule, cl.duration_min, cl.start_on::text as start_on, cl.end_on::text as end_on,
            cl.court_id, c.court_code, cl.coach_id, cl.assistant_id,
            co.full_name as coach_name, asst.full_name as assistant_name, cl.price_vnd,
            cl.description, cl.syllabus, cl.who_for, cl.bring
       from classes cl
       join courts c on c.id = cl.court_id
       join users co on co.id = cl.coach_id
       left join users asst on asst.id = cl.assistant_id
      where cl.id = $1`,
    [classId],
  );
  if (!cl) throw err.notFound("No such class.");
  if (user.role === "coach" && cl.coach_id !== user.id && cl.assistant_id !== user.id) throw err.forbidden();

  // `headcount` is who is expected for a session still to come, and who turned
  // up (present or late) for one already taken.
  // Bước 2: Lấy danh sách toàn bộ các buổi học kèm số người tham gia (headcount: buổi đã kết thúc đếm điểm danh thực tế, buổi sắp tới lấy theo sĩ số lớp).
  const sessions = await sql.query(
    `select s.id, s.start_at, s.end_at, s.status::text as status, ct.court_code,
            case when s.status = 'done'
                 then (select count(*) from attendance a
                        where a.session_id = s.id and a.result in ('present','late'))::int
                 else $2::int end as headcount
       from sessions s
       join courts ct on ct.id = s.court_id
      where s.class_id = $1
      order by s.start_at`,
    [classId, cl.enrolled_count],
  );
  // Bước 3: Lấy danh sách học viên (roster) bao gồm các suất đã xác nhận và các suất đang chờ (waitlisted) kèm thông tin ưu đãi/vị trí chờ.
  const roster = await sql.query(
    `select u.id, u.full_name, u.member_code, u.phone, e.status::text as status,
            ${avatarUrlSql("u")},
            case when e.status = 'waitlisted' then (select count(*) from enrollments w where w.class_id = e.class_id and w.status = 'waitlisted' and (w.waitlist_pos, w.id) <= (e.waitlist_pos, e.id)) end as waitlist_pos,
            exists(
              select 1 from waitlist_offers o
               where o.enrollment_id = e.id and o.status = 'pending' and o.expires_at > now()
            ) as offer_pending,
            (select o.expires_at from waitlist_offers o where o.enrollment_id = e.id and o.status = 'pending' and o.expires_at > now() limit 1) as offer_expires_at
       from enrollments e join users u on u.id = e.user_id
      where e.class_id = $1 and e.status in ('confirmed','waitlisted')
      order by e.status, e.waitlist_pos nulls first, u.full_name`,
    [classId],
  );
  // Bước 4: Chuẩn hóa URL avatar cho học viên bằng withAvatarUrl và trả về thông tin chi tiết lớp học.
  return {
    status: 200,
    body: {
      class: { ...cl, my_enrollment: null, code: classCode(cl.sport, cl.level, cl.id) },
      sessions,
      roster: roster.map(withAvatarUrl),
    },
  };
}

/**
 * Làm gì: Lấy danh sách học viên chính thức (trạng thái confirmed) của một lớp học kèm ghi chú sức khỏe để phục vụ giảng dạy và quản lý lớp.
 * Được gọi ở: URL GET /api/classes/:id/roster (src/server/controllers/router.ts qua authedRead).
 * @param sql Kết nối database được mở từ router.
 * @param classId Mã định danh UUID của lớp học cần xem danh sách học viên.
 * @param user Thông tin tài khoản đang gọi API (coach phải là người dạy lớp này, manager hoặc receptionist xem được toàn bộ).
 * @returns Object chứa mảng items danh sách học viên với đầy đủ họ tên, mã hội viên, ghi chú sức khỏe và URL ảnh đại diện.
 * @throws Lỗi 404 NOT_FOUND nếu lớp không tồn tại; lỗi 403 FORBIDDEN nếu coach không dạy lớp này.
 */
export async function classRoster(sql: Sql, classId: string, user: PublicUser) {
  // Bước 1: Kiểm tra quyền truy cập; nếu là coach thì bắt buộc phải là HLV chính hoặc trợ giảng của lớp học này.
  requireRole(user, ["coach", "manager", "receptionist"]);
  const cl = await one<{ coach_id: string; assistant_id: string | null }>(
    sql,
    `select coach_id, assistant_id from classes where id = $1`,
    [classId],
  );
  if (!cl) throw err.notFound();
  if (user.role === "coach" && cl.coach_id !== user.id && cl.assistant_id !== user.id) {
    throw err.forbidden();
  }
  // Bước 2: Truy vấn danh sách học viên có trạng thái 'confirmed', lấy kèm thông tin sức khỏe (health_notes) và đường dẫn avatar.
  const items = await sql.query(
    `select u.id, u.full_name, u.member_code, u.health_notes, e.status, e.id as enrollment_id,
            ${avatarUrlSql("u")}
       from enrollments e
       join users u on u.id = e.user_id
      where e.class_id = $1 and e.status = 'confirmed'
      order by u.full_name`,
    [classId],
  );
  // Bước 3: Chuẩn hóa URL avatar cho từng học viên qua hàm withAvatarUrl và trả về danh sách kết quả.
  return { status: 200, body: { items: items.map(withAvatarUrl) } };
}

/* ------------------------------------------------------------------ *
 * Phase 4A — class lifecycle (FR-CLS: cancel / move a session, change *
 * the coach, close or cancel a class).                                *
 * ------------------------------------------------------------------ */

/** BR-27: a session may be moved freely only this long before its old time. */
const MOVE_FREE_HOURS = 12;

// Cấu trúc dữ liệu dòng buổi học kèm thông tin lớp được đọc khi khóa phục vụ đổi lịch hoặc hủy buổi.
type SessionRow = {
  id: string;
  class_id: string;
  court_id: string;
  start_at: string;
  end_at: string;
  status: string;
  occupancy_id: string | null;
  original_start_at: string | null;
  sport: string;
  level: string;
  coach_id: string;
  assistant_id: string | null;
  class_end_on: string | null;
};

/**
 * Làm gì: Khóa bi quan (FOR UPDATE OF s) một dòng buổi học trong database và lấy kèm thông tin lớp để chuẩn bị hủy hoặc dời lịch học.
 * Được gọi ở: Nội bộ file classes.ts (hàm sessionCancel tại dòng 1535 và hàm sessionReschedule tại dòng 1599).
 * @param sql Kết nối database trong transaction đang thực thi.
 * @param sessionId Mã định danh UUID của buổi học cần khóa.
 * @returns Dữ liệu buổi học (SessionRow) bao gồm trạng thái, thời gian bắt đầu/kết thúc, sân và thông tin lớp học.
 * @throws Lỗi 404 NOT_FOUND nếu không tìm thấy buổi học trong database.
 */
async function lockSession(sql: Sql, sessionId: string): Promise<SessionRow> {
  // Khóa dòng buổi học bằng SELECT ... FOR UPDATE OF s để đảm bảo tính nhất quán dữ liệu khi xử lý dời lịch hoặc hoàn tiền.
  const s = await one<SessionRow>(
    sql,
    `select s.id, s.class_id, s.court_id, s.start_at, s.end_at, s.status::text as status, s.occupancy_id,
            s.original_start_at, cl.sport::text as sport, cl.level, cl.coach_id, cl.assistant_id,
            cl.end_on::text as class_end_on
       from sessions s join classes cl on cl.id = s.class_id
      where s.id = $1
      for update of s`,
    [sessionId],
  );
  if (!s) throw err.notFound("No such session.");
  return s;
}

/**
 * Làm gì: Lấy danh sách ID người dùng của tất cả học viên đã xác nhận tham gia (status = 'confirmed') trong một lớp học.
 * Được gọi ở: Nội bộ file classes.ts (hàm sessionReschedule, classesAssignCoach và cancelClass).
 * @param sql Kết nối database đang chạy transaction.
 * @param classId Mã định danh UUID của lớp học cần lấy danh sách học viên.
 * @returns Mảng các chuỗi UUID đại diện cho ID của các học viên chính thức trong lớp.
 */
async function confirmedMembers(sql: Sql, classId: string): Promise<string[]> {
  // Truy vấn danh sách user_id của các học viên có trạng thái 'confirmed' trong lớp học.
  const rows = await sql.query(
    `select user_id from enrollments where class_id = $1 and status = 'confirmed'`,
    [classId],
  );
  return rows.map((r) => String(r.user_id));
}

/** Everyone a class change touches: the roster plus the coaches on it. */
async function notifyClass(
  sql: Sql,
  classId: string,
  people: string[],
  payload: Record<string, unknown>,
  key: string,
) {
  // Dùng new Set(people) để loại trừ ID trùng lặp, gửi thông báo in-app (class_changed) đến từng người kèm idempotency key.
  for (const uid of new Set(people)) {
    await enqueue(sql, "inapp", "class_changed", uid, { class_id: classId, ...payload }, `${key}|${uid}`);
  }
}

/**
 * Làm gì: Trích xuất và chuẩn hóa chuỗi lý do từ request body JSON, giới hạn độ dài tối đa 300 ký tự để lưu vào cột change_reason.
 * Được gọi ở: Nội bộ file classes.ts (các hàm sessionCancel, sessionReschedule, classesAssignCoach, cancelClass và classesPatch).
 * @param b Object record chứa dữ liệu body của request.
 * @returns Chuỗi lý do đã được cắt tối đa 300 ký tự, hoặc undefined nếu không có lý do được gửi lên.
 */
function reasonOf(b: Record<string, unknown>): string | undefined {
  // Đọc chuỗi ký tự an toàn qua hàm helper str và cắt tối đa 300 ký tự để đảm bảo giới hạn lưu trữ của cơ sở dữ liệu.
  const r = str(b.reason);
  return r ? r.slice(0, 300) : undefined;
}

/** Cancel one session of a class (FR-CLS-04, BR-29). */
export async function sessionCancel(sql: Sql, sessionId: string, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền quản lý (manager) và bắt buộc phải có lý do hủy buổi học (reason).
  requireRole(user, ["manager"]);
  const b = await readJson(request);
  const reason = reasonOf(b);
  if (!reason) throw err.field("reason", "Give a reason for cancelling this session.");
  // Match whole-class cancellation's class -> session lock order, and serialize refunds
  // for different sessions of the same class before reading the remaining paid balance.
  // Bước 2: Khóa dữ liệu lớp học (FOR UPDATE OF cl) rồi khóa buổi học (lockSession) để đồng bộ thứ tự khóa và tránh tranh chấp khi hoàn tiền.
  const cl = await one<{ rrule: string; duration_min: number; start_on: string; end_on: string }>(
    sql,
    `select cl.rrule, cl.duration_min, cl.start_on::text, cl.end_on::text
       from classes cl join sessions s on s.class_id = cl.id where s.id = $1 for update of cl`,
    [sessionId],
  );
  if (!cl) throw err.notFound("No such session.");
  const s = await lockSession(sql, sessionId);
  // Buổi học phải đang ở trạng thái 'scheduled' và chưa kết thúc thì mới được phép hủy.
  if (s.status !== "scheduled") throw err.conflictState("Only a scheduled session can be cancelled.");
  if (new Date(s.end_at).getTime() <= Date.now()) throw err.conflictState("That session has already finished.");

  // Bước 3: Giải phóng lịch giữ sân qua hàm database occupancy_release_session và lưu lý do hủy vào bảng sessions.
  await sql.query(`select occupancy_release_session($1::uuid, 'cancelled'::session_status)`, [sessionId]);
  await sql.query(`update sessions set change_reason = $2 where id = $1`, [sessionId, reason]);

  // Bước 4: Mở rộng lịch lặp RRULE để tính tổng số buổi dự kiến ban đầu (plannedSessions) làm mẫu số chia tiền hoàn học phí.
  const plannedSessions = Math.max(1, expandWeekly(
    cl.rrule, cl.duration_min, ictDateTime(cl.start_on, "00:00"), ictDateTime(addDays(cl.end_on, 1), "00:00"),
  ).length);
  // Bước 5: Khóa và truy vấn danh sách học viên chính thức (status = 'confirmed') để chuẩn bị tính toán tiền hoàn lại.
  const seats = await sql.query<{ id: string; user_id: string; price_vnd: number | null; extension_vnd: number }>(
    `select id, user_id, price_vnd, extension_vnd from enrollments
      where class_id = $1 and status = 'confirmed' order by user_id, id for update`, [s.class_id],
  );
  // Bước 5: tính toán hoàn tiền học phí cho từng học viên và tạo phiếu chi ở trạng thái 'refund_pending'.
  let refunded = 0;
  let refundedVnd = 0;
  const refundByUser = new Map<string, number>();
  for (const seat of seats) {
    // Khóa dòng user để tránh xung đột khi có nhiều giao dịch hoàn tiền hoặc thanh toán cùng lúc.
    await sql.query(`select id from users where id = $1 for update`, [seat.user_id]);
    // Tính tổng tiền học viên đã thanh toán (paid_vnd) và tổng tiền đã hoàn hoặc đang chờ hoàn (returned_vnd).
    const balance = (await sql.query<{ paid_vnd: number; returned_vnd: number }>(
      `select coalesce(sum(amount_vnd) filter (where status = 'posted' and amount_vnd > 0), 0)::int as paid_vnd,
              coalesce(sum(-amount_vnd) filter (where status in ('posted','refund_pending') and amount_vnd < 0), 0)::int as returned_vnd
         from payments where ref_type = 'enrollment' and ref_id = $1`, [seat.id],
    ))[0];
    // The seat's price includes membership extension days; cancelling a session only returns tuition.
    const tuition = Math.min(balance.paid_vnd, Math.max(0, (seat.price_vnd ?? 0) - seat.extension_vnd));
    // Tiền hoàn một buổi bằng học phí chia đều số buổi dự kiến, không vượt quá số dư thực tế còn lại.
    const refund = Math.min(Math.floor(tuition / plannedSessions), Math.max(0, balance.paid_vnd - balance.returned_vnd));
    if (refund <= 0) continue;
    // Tạo bản ghi hoàn tiền (số tiền âm, method 'cash') ở trạng thái 'refund_pending' để thu ngân chi trả sau.
    const code = await nextCode(sql, "PAY");
    await sql.query(
      `insert into payments (code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by)
       values ($1,$2,'cash',$3,0,'refund_pending','enrollment',$4,null)`,
      [code, seat.user_id, -refund, seat.id],
    );
    // Đối soát và điều chỉnh lại điểm tích lũy hoặc chiết khấu loyalty sau khi phát sinh khoản hoàn tiền.
    await reconcileLoyaltyRefund(sql, seat.user_id);
    refundByUser.set(seat.user_id, (refundByUser.get(seat.user_id) ?? 0) + refund);
    refunded += 1;
    refundedVnd += refund;
  }
  // Bước 6: gửi thông báo hủy buổi học đến học viên, huấn luyện viên chính và trợ giảng.
  const members = seats.map((seat) => seat.user_id);
  // Gửi thông báo chung cho HLV, trợ giảng và những học viên không phát sinh tiền hoàn.
  await notifyClass(
    sql,
    s.class_id,
    [...members, s.coach_id, ...(s.assistant_id ? [s.assistant_id] : [])].filter((id) => !refundByUser.has(id)),
    { kind: "session_cancelled", session_id: sessionId, start: s.start_at, reason, refund_vnd: 0 },
    `session_cancel|${sessionId}`,
  );
  // Gửi thông báo riêng kèm số tiền hoàn cụ thể cho từng học viên được hoàn tiền.
  for (const [uid, refund_vnd] of refundByUser) {
    await notifyClass(sql, s.class_id, [uid],
      { kind: "session_cancelled", session_id: sessionId, start: s.start_at, reason, refund_vnd },
      `session_cancel|${sessionId}`);
  }
  // Bước 7: ghi nhật ký kiểm toán (audit log) và trả về kết quả hủy buổi học.
  await audit(sql, user.id, "cancel_session", "session", sessionId, { status: "scheduled", start_at: s.start_at }, { status: "cancelled", reason });
  return { status: 200, body: { ok: true, notified: members.length, refunded, refunded_vnd: refundedVnd } };
}

/** Move one session to another time (FR-CLS-05, BR-26, BR-27). Same court, same coach. */
/**
 * Làm gì: dời lịch một buổi học sang thời điểm mới nhưng giữ nguyên sân và huấn luyện viên (FR-CLS-05, BR-26, BR-27).
 *   Kiểm tra thời gian mới hợp lệ (trong tương lai, khớp khung lưới slot_minutes, không vượt quá ngày kết thúc lớp và giờ đóng cửa),
 *   yêu cầu lý do nếu dời cận giờ (< 2 giờ), cập nhật occupancies, coach_occupancies, sessions, gửi thông báo và ghi audit log.
 * Được gọi ở:
 *   - Màn hình quản lý lớp học (/manager/classes, src/routes/manager.classes.tsx) qua ClassDetailModal: nút "Reschedule"
 *     trong bảng danh sách buổi học (src/client/components/class-detail.tsx) gọi apiPost(`/sessions/${sessionId}/reschedule`, body).
 *   - Route POST /v1/sessions/:id/reschedule trong src/server/controllers/router.ts.
 *   - Test runner (node --test) trong src/server/controllers/tx.test.ts.
 * @param sql Kết nối database trong transaction do router mở.
 * @param sessionId Mã UUID của buổi học cần dời lịch.
 * @param request HTTP request chứa body JSON { start_at: string, reason?: string }.
 * @param user Thông tin người thực hiện; yêu cầu quyền manager.
 * @returns { status: 200, body: { ok: true, start_at, end_at } } thời gian bắt đầu và kết thúc mới dạng ISO string.
 * @throws Lỗi 403 FORBIDDEN nếu không phải manager; lỗi 400 field "start_at" nếu thời gian rỗng, không hợp lệ, ở quá khứ,
 *   trùng giờ cũ, vượt quá ngày kết thúc lớp hoặc sau giờ đóng cửa; lỗi 409 CONFLICT_STATE nếu buổi học không ở trạng thái
 *   scheduled hoặc đã bắt đầu; lỗi 422 BR-27 nếu dời gấp dưới 2 giờ mà thiếu lý do; lỗi 409 CONFLICT_SLOT nếu sân hoặc HLV bị trùng lịch.
 */
export async function sessionReschedule(sql: Sql, sessionId: string, request: Request, user: PublicUser) {
  // Bước 1: chỉ quản lý (manager) mới có quyền dời lịch buổi học.
  requireRole(user, ["manager"]);
  // Bước 2: đọc thời gian bắt đầu mới từ body request và kiểm tra phải là thời điểm hợp lệ trong tương lai.
  const b = await readJson(request);
  const startRaw = str(b.start_at);
  const newStart = startRaw ? new Date(startRaw) : null;
  if (!newStart || Number.isNaN(newStart.getTime())) throw err.field("start_at", "Pick the new start time.");
  if (newStart.getTime() <= Date.now()) throw err.field("start_at", "The new time must be in the future.");
  // Bước 3: khóa dòng buổi học và kiểm tra trạng thái (chỉ được dời buổi đang 'scheduled' và chưa bắt đầu).
  const s = await lockSession(sql, sessionId);
  if (s.status !== "scheduled") throw err.conflictState("Only a scheduled session can be moved.");
  const oldStart = new Date(s.start_at);
  const length = new Date(s.end_at).getTime() - oldStart.getTime();
  if (oldStart.getTime() <= Date.now()) throw err.conflictState("That session has already started.");
  if (newStart.getTime() === oldStart.getTime()) throw err.field("start_at", "That is the time it already has.");

  // Bước 4: kiểm tra thời gian mới phải khớp khung lưới slot, không vượt quá ngày kết thúc lớp và giờ đóng cửa trung tâm.
  const settings = await getSettings(sql);
  assertSlotGrid(newStart, settings);
  const newStartDate = ictDateString(newStart);
  if (s.class_end_on && newStartDate > s.class_end_on) {
    throw err.field("start_at", "Cannot reschedule past class end date.");
  }
  // Giữ nguyên thời lượng (length) của buổi học cũ để tính thời điểm kết thúc mới.
  const newEnd = new Date(newStart.getTime() + length);
  const close = ictDateTime(newStartDate, settings.close_time.slice(0, 5));
  if (newEnd > close) {
    throw err.field("start_at", "Session would end after closing time.");
  }

  // Bước 5: kiểm tra quy tắc BR-27: nếu dời lịch khi còn dưới 2 giờ (MOVE_FREE_HOURS) thì bắt buộc phải có lý do.
  const reason = reasonOf(b);
  const hoursAhead = (oldStart.getTime() - Date.now()) / 3600000;
  if (hoursAhead < MOVE_FREE_HOURS && !reason) {
    throw err.br(
      "BR-27",
      `This session starts in under ${MOVE_FREE_HOURS} hours — give a reason to move it.`,
      { field: "reason" },
    );
  }

  // Bước 6: cập nhật lịch giữ sân (occupancies), lịch HLV (coach_occupancies) và thông tin buổi học (sessions).
  const { slot_minutes } = settings;
  const held = slotSpan(newStart, newEnd, slot_minutes);
  try {
    // Moved in place, so the session's own old slot never counts as a clash.
    await sql.query(`update occupancies set start_at = $2, end_at = $3 where id = $1`, [
      s.occupancy_id,
      held.start.toISOString(),
      held.end.toISOString(),
    ]);
    await sql.query(`update coach_occupancies set start_at = $2, end_at = $3 where session_id = $1`, [
      sessionId,
      newStart.toISOString(),
      newEnd.toISOString(),
    ]);
    // Cập nhật giờ mới vào sessions; lưu lại original_start_at ở lần dời đầu tiên để theo dõi lịch sử.
    await sql.query(
      `update sessions
          set start_at = $2, end_at = $3,
              original_start_at = coalesce(original_start_at, start_at),
              change_reason = $4
        where id = $1`,
      [sessionId, newStart.toISOString(), newEnd.toISOString(), reason ?? null],
    );
  } catch (e) {
    if (isConflictSlot(e)) throw err.conflictSlot("The court or the coach is busy at that time.");
    throw e;
  }

  // Bước 7: gửi thông báo dời lịch đến toàn bộ học viên đã xác nhận, HLV và trợ giảng.
  const members = await confirmedMembers(sql, s.class_id);
  await notifyClass(
    sql,
    s.class_id,
    [...members, s.coach_id, ...(s.assistant_id ? [s.assistant_id] : [])],
    {
      kind: "session_moved",
      session_id: sessionId,
      from: s.start_at,
      start: newStart.toISOString(),
      ...(reason ? { reason } : {}),
    },
    `session_move|${sessionId}|${newStart.toISOString()}`,
  );
  // Bước 8: ghi nhật ký kiểm toán (audit log) và trả về mốc thời gian mới.
  await audit(
    sql,
    user.id,
    "reschedule_session",
    "session",
    sessionId,
    { start_at: s.start_at, end_at: s.end_at },
    { start_at: newStart.toISOString(), end_at: newEnd.toISOString(), reason: reason ?? null },
  );
  return { status: 200, body: { ok: true, start_at: newStart.toISOString(), end_at: newEnd.toISOString() } };
}

/** Put another coach on a class from now on (FR-CLS-06, BR-25, BR-54). */
/**
 * Làm gì: đổi huấn luyện viên chính cho lớp học từ thời điểm hiện tại trở đi (FR-CLS-06, BR-25, BR-54).
 *   Kiểm tra HLV mới hợp lệ (vai trò coach, được phân công dạy môn của lớp, khác HLV và trợ giảng hiện tại),
 *   kiểm tra HLV mới không bị trùng lịch dạy ở bất kỳ buổi học tương lai nào của lớp (BR-26),
 *   sau đó cập nhật coach_occupancies, cập nhật lớp, gửi thông báo và ghi audit log.
 * Được gọi ở:
 *   - Màn hình quản lý lớp học (/manager/classes, src/routes/manager.classes.tsx) qua ClassDetailModal: nút "Change coach"
 *     trong src/client/components/class-detail.tsx gọi apiPost(`/classes/${classId}/coach`, body).
 *   - Route POST /v1/classes/:id/coach trong src/server/controllers/router.ts.
 *   - Test runner (node --test) trong src/server/controllers/tx.test.ts.
 * @param sql Kết nối database trong transaction do router mở.
 * @param classId Mã UUID của lớp học cần thay đổi huấn luyện viên.
 * @param request HTTP request chứa body JSON với coach_id (mã HLV mới) và reason (lý do thay đổi).
 * @param user Thông tin người dùng đăng nhập; yêu cầu vai trò manager.
 * @returns { status: 200, body: { ok: true, sessions_moved } } với sessions_moved là số ca học tương lai được gán cho HLV mới.
 * @throws Lỗi 403 FORBIDDEN nếu không phải manager; lỗi 404 NOT_FOUND nếu không tìm thấy lớp học;
 *   lỗi 409 CONFLICT_STATE nếu lớp học đã bị hủy; lỗi 400 field "coach_id" nếu chưa chọn HLV hoặc HLV mới trùng
 *   với HLV chính/trợ giảng hiện tại; lỗi 422 BR-25 nếu tài khoản không phải là coach hoặc không được phân công dạy môn của lớp;
 *   lỗi 409 CONFLICT_SLOT (BR-26) nếu HLV mới bị trùng lịch dạy ở các ca học tương lai.
 */
export async function classesAssignCoach(sql: Sql, classId: string, request: Request, user: PublicUser) {
  // Bước 1: chỉ quản lý (manager) mới có quyền thay đổi huấn luyện viên của lớp.
  requireRole(user, ["manager"]);
  // Bước 2: đọc mã HLV mới từ request body và kiểm tra không được để trống.
  const b = await readJson(request);
  const coachId = str(b.coach_id);
  if (!coachId) throw err.field("coach_id", "Choose the new coach.");
  // Bước 3: khóa dòng lớp học để kiểm tra trạng thái và ngăn chặn các thao tác sửa đổi đồng thời.
  const cl = await one<{
    id: string;
    sport: string;
    status: string;
    coach_id: string;
    assistant_id: string | null;
  }>(sql, `select id, sport::text as sport, status::text as status, coach_id, assistant_id from classes where id = $1 for update`, [classId]);
  if (!cl) throw err.notFound("No such class.");
  if (cl.status === "cancelled") throw err.conflictState("That class is cancelled.");
  if (coachId === cl.coach_id) throw err.field("coach_id", "That coach already teaches this class.");
  if (coachId === cl.assistant_id) throw err.field("coach_id", "That coach is already the assistant.");
  // Bước 4: kiểm tra HLV mới phải có vai trò 'coach' và được phân công dạy môn của lớp (BR-25).
  const coach = await one<{ role: string; full_name: string }>(
    sql,
    `select role::text as role, full_name from users where id = $1`,
    [coachId],
  );
  if (!coach || coach.role !== "coach") throw err.br("BR-25", "That coach is not valid.");
  // Bảng coach_sports phân công môn cho HLV; giá trị 'all' biểu thị HLV có thể dạy tất cả các môn.
  const sportOk = await one(
    sql,
    `select 1 from coach_sports where user_id = $1 and (sport::text = $2 or sport::text = 'all')`,
    [coachId, cl.sport],
  );
  if (!sportOk) throw err.br("BR-25", "That coach is not assigned to this sport.");

  // Bước 5: kiểm tra trùng lịch (BR-26) cho toàn bộ các buổi học sắp tới chưa kết thúc.
  const upcoming = await sql.query(
    `select s.id, s.start_at from sessions s
      where s.class_id = $1 and s.status = 'scheduled' and s.start_at > now()
      order by s.start_at`,
    [classId],
  );
  const clashes: string[] = [];
  for (const s of upcoming) {
    try {
      // Dùng SAVEPOINT để thử gán lịch HLV mới; nếu xung đột slot (isConflictSlot) thì rollback savepoint để ghi nhận ca trùng mà không hủy cả transaction.
      await sql.query("savepoint sp_coach");
      await sql.query(`update coach_occupancies set coach_id = $2 where session_id = $1 and coach_id = $3`, [
        s.id,
        coachId,
        cl.coach_id,
      ]);
      await sql.query("release savepoint sp_coach");
    } catch (e) {
      await sql.query("rollback to savepoint sp_coach").catch(() => undefined);
      if (!isConflictSlot(e)) throw e;
      clashes.push(String(s.start_at));
    }
  }
  if (clashes.length) {
    throw err.conflictSlot("That coach is already teaching at some of this class's times (BR-26).", {
      sessions: clashes,
    });
  }
  // Bước 6: cập nhật huấn luyện viên chính mới vào bản ghi lớp học.
  await sql.query(`update classes set coach_id = $2 where id = $1`, [classId, coachId]);

  // Bước 7: gửi thông báo đổi huấn luyện viên đến tất cả học viên đã xác nhận, HLV cũ và HLV mới.
  const members = await confirmedMembers(sql, classId);
  await notifyClass(
    sql,
    classId,
    [...members, cl.coach_id, coachId],
    { kind: "coach_changed", coach_name: coach.full_name, ...(reasonOf(b) ? { reason: reasonOf(b) } : {}) },
    `coach_change|${classId}|${coachId}|${upcoming.length}`,
  );
  // Bước 8: ghi nhật ký kiểm toán (audit log) và trả về số lượng buổi học tương lai đã chuyển HLV.
  await audit(sql, user.id, "change_coach", "class", classId, { coach_id: cl.coach_id }, { coach_id: coachId, sessions: upcoming.length });
  return { status: 200, body: { ok: true, sessions_moved: upcoming.length } };
}

// ─── Types cho dữ liệu chạy qua classesPatch ───────────────────────────────

/** Dòng lớp đọc từ DB, dùng để kiểm tra và ghi lại trạng thái cũ ở audit. */
type PatchableClass = {
  id: string;
  sport: string;
  level: string;
  status: string;
  capacity: number;
  enrolled_count: number;
  min_enrolled: number | null;
  coach_id: string;
  assistant_id: string | null;
  start_on: string;
  end_on: string;
};

/** Các trường sẽ được UPDATE vào DB sau khi qua hết kiểm tra. */
type PatchClassFields = {
  capacity: number;
  level: string;
  status: string | undefined;
  min_enrolled: number | null;
  end_on: string;
  price_vnd?: number | null;
  members_carried: number;
};

// ─── Hàm phụ của classesPatch ──────────────────────────────────────────────

/**
 * Làm gì: trước khi khóa lớp, nếu request đang yêu cầu hủy lớp thì khóa toàn bộ
 *   liên kết thanh toán của các chỗ giữ (hold) trước. Vì sao: giữ đúng thứ tự
 *   khóa payment → class → enrollment mà settleOnline dùng, tránh deadlock khi
 *   webhook thanh toán và thao tác hủy chạy song song.
 * Được gọi ở: classesPatch, bước 1.
 * @param sql Kết nối database trong transaction do router mở.
 * @param classId Mã lớp từ đường dẫn API (/v1/classes/:id).
 * @param requestedStatus Giá trị status trong body JSON, chưa xác thực.
 * @returns Danh sách liên kết payOS đã khóa; rỗng nếu không phải yêu cầu hủy.
 * @throws Lỗi truy vấn được truyền nguyên vẹn lên router.
 */
async function lockCancelClassPaymentLinks(
  sql: Sql,
  classId: string,
  requestedStatus: string | undefined,
): Promise<Array<{ id: string; provider_order_code: string | number | null }>> {
  const isCancelRequest = requestedStatus === "cancelled" && isUuid(classId);
  if (!isCancelRequest) {
    return [];
  }

  // Cancelling closes the seat holds' payOS links. Those payment rows are locked before the class
  // (payment → class → enrolment, the order settleOnline uses), so a webhook racing the cancel
  // queues behind it instead of deadlocking.
  const holdEnrollments = await sql.query<{ id: string }>(
    `select id from enrollments where class_id = $1 and status = 'hold'`,
    [classId],
  );
  const holdEnrollmentIds = holdEnrollments.map((r) => String(r.id));

  return lockEnrollmentLinks(sql, holdEnrollmentIds);
}

/**
 * Làm gì: đọc và khóa dòng lớp, kiểm tra lớp tồn tại và chưa bị hủy.
 *   FOR UPDATE để các request sửa cùng lớp đồng thời xếp hàng thay vì đụng nhau.
 * Được gọi ở: classesPatch, bước 2.
 * @param sql Kết nối database trong transaction do router mở.
 * @param classId Mã lớp từ đường dẫn API (/v1/classes/:id).
 * @returns Dòng lớp đã khóa với các trường cần để kiểm tra và audit.
 * @throws Lỗi 404 nếu không có lớp; lỗi 409 CONFLICT_STATE nếu lớp đã hủy.
 */
async function lockPatchableClass(sql: Sql, classId: string): Promise<PatchableClass> {
  const classRecord = await one<PatchableClass>(
    sql,
    `select id, sport::text as sport, level, status::text as status, capacity, enrolled_count, min_enrolled, coach_id, assistant_id,
            start_on::text as start_on, end_on::text as end_on
       from classes where id = $1 for update`,
    [classId],
  );
  if (!classRecord) throw err.notFound("No such class.");
  if (classRecord.status === "cancelled") throw err.conflictState("That class is cancelled.");
  return classRecord;
}

/**
 * Làm gì: kiểm tra giá trị status trong body: chỉ chấp nhận open, closed hoặc cancelled;
 *   cancelled được xử lý riêng bởi cancelClass; draft không thể chuyển sang open/closed
 *   khi chưa publish.
 * Được gọi ở: classesPatch, bước 3.
 * @param requestedStatus Giá trị status sau khi str() đọc từ body JSON; undefined nếu không gửi.
 * @param currentStatus Trạng thái hiện tại của lớp từ dòng DB đã khóa.
 * @throws Lỗi 400 field "status" nếu giá trị không hợp lệ; lỗi 409 CONFLICT_STATE nếu lớp là draft.
 */
function checkPatchClassStatus(
  requestedStatus: string | undefined,
  currentStatus: string,
): void {
  const isKnownStatus = requestedStatus === undefined || ["open", "closed"].includes(requestedStatus);
  if (!isKnownStatus) {
    throw err.field("status", "Status can be open, closed or cancelled.");
  }

  const tryingToOpenOrCloseDraftClass = requestedStatus && currentStatus === "draft";
  if (tryingToOpenOrCloseDraftClass) {
    throw err.conflictState("Publish the class before opening or closing it.");
  }
}

/**
 * Làm gì: đọc và kiểm tra sức chứa mới. Nếu body không gửi capacity thì giữ nguyên giá trị cũ.
 *   Vì sao không để xuống dưới số đã đăng ký: hội viên đã có chỗ không thể bị đẩy ra ngoài (BR-21).
 * Được gọi ở: classesPatch, bước 4.
 * @param rawCapacity Giá trị body.capacity, dạng unknown; undefined nếu không gửi.
 * @param currentCapacity Sức chứa hiện tại của lớp từ dòng DB đã khóa.
 * @param currentEnrolledCount Số hội viên đã có chỗ xác nhận, dùng để kiểm tra BR-21.
 * @returns Sức chứa hợp lệ.
 * @throws Lỗi 400 field "capacity" nếu không phải số nguyên hợp lệ;
 *   lỗi 422 BR-21 nếu xuống dưới số đang đăng ký.
 */
function checkPatchClassCapacity(
  rawCapacity: unknown,
  currentCapacity: number,
  currentEnrolledCount: number,
): number {
  const capacity = rawCapacity === undefined ? currentCapacity : num(rawCapacity);

  const capacityIsInvalid =
    capacity === undefined || !Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CLASS_CAPACITY;
  if (capacityIsInvalid) {
    throw err.field("capacity", `Capacity must be a whole number from 1 to ${MAX_CLASS_CAPACITY}.`);
  }

  const capacityDropsBelowEnrolled = capacity < currentEnrolledCount;
  if (capacityDropsBelowEnrolled) {
    throw err.br("BR-21", `${currentEnrolledCount} members are already enrolled — capacity cannot go below that.`, {
      field: "capacity",
    });
  }

  return capacity;
}

/**
 * Làm gì: đọc và kiểm tra trình độ mới. Nếu body không gửi level thì giữ nguyên.
 *   Giới hạn 24 ký tự để khớp với ô nhập trên giao diện.
 * Được gọi ở: classesPatch, bước 4, ngay sau checkPatchClassCapacity.
 * @param rawLevel Giá trị body.level sau khi str(); undefined nếu không gửi.
 * @param currentLevel Trình độ hiện tại của lớp từ dòng DB đã khóa.
 * @returns Trình độ hợp lệ.
 * @throws Lỗi 400 field "level" nếu rỗng hoặc quá 24 ký tự.
 */
function checkPatchClassLevel(
  rawLevel: string | undefined,
  currentLevel: string,
): string {
  const level = rawLevel === undefined ? currentLevel : rawLevel;

  const levelIsInvalid = !level || level.length > 24;
  if (levelIsInvalid) {
    throw err.field("level", "Level is required (24 characters at most).");
  }

  return level;
}

/**
 * Làm gì: đọc học phí mới nếu body có gửi price_vnd, giữ nguyên undefined nếu không gửi.
 *   Vì sao phân biệt "không gửi" và "gửi null": giao diện cho phép xóa giá để đóng lớp mới,
 *   nhưng không muốn vô tình xóa giá khi chỉ sửa sức chứa.
 * Được gọi ở: classesPatch, bước 4, ngay sau checkPatchClassLevel.
 * @param rawPriceVnd Giá trị body.price_vnd, dạng unknown.
 * @param priceWasSent Body có trường price_vnd hay không (body.price_vnd !== undefined).
 * @returns Học phí mới nếu gửi lên; undefined nếu không gửi.
 * @throws Lỗi 400 field "price_vnd" nếu giá trị không hợp lệ.
 */
function readPatchClassPrice(
  rawPriceVnd: unknown,
  priceWasSent: boolean,
): number | null | undefined {
  if (!priceWasSent) {
    return undefined;
  }
  return parsePrice(rawPriceVnd);
}

/**
 * Làm gì: đọc sĩ số tối thiểu mới. Nếu body gửi thì parse; nếu không gửi thì giữ giá trị cũ.
 *   Sau khi lấy được min_enrolled (dù từ body hay DB), kiểm tra thêm: nếu không gửi mà
 *   capacity mới nhỏ hơn min cũ thì cũng báo lỗi, vì dữ liệu sẽ mâu thuẫn.
 * Được gọi ở: classesPatch, bước 4, ngay sau readPatchClassPrice.
 * @param rawMinEnrolled Giá trị body.min_enrolled, dạng unknown.
 * @param minWasSent Body có trường min_enrolled hay không (body.min_enrolled !== undefined).
 * @param newCapacity Sức chứa mới đã qua checkPatchClassCapacity.
 * @param currentMinEnrolled Sĩ số tối thiểu hiện tại từ dòng DB đã khóa.
 * @returns Sĩ số tối thiểu hợp lệ.
 * @throws Lỗi 400 field "min_enrolled" nếu giá trị gửi lên không hợp lệ;
 *   lỗi 400 field "capacity" nếu capacity mới dưới min cũ mà không gửi min mới.
 */
function readPatchClassMinEnrolled(
  rawMinEnrolled: unknown,
  minWasSent: boolean,
  newCapacity: number,
  currentMinEnrolled: number | null,
): number | null {
  if (minWasSent) {
    return parseMinEnrolled(rawMinEnrolled, newCapacity);
  }

  // Không gửi min mới nhưng capacity mới nhỏ hơn min cũ: hai trường sẽ mâu thuẫn.
  const capacityDropsBelowCurrentMin = currentMinEnrolled != null && currentMinEnrolled > newCapacity;
  if (capacityDropsBelowCurrentMin) {
    throw err.field("capacity", "Capacity cannot go below the class's minimum.");
  }

  return currentMinEnrolled;
}

/**
 * Làm gì: đọc và kiểm tra ngày kết thúc mới. Nếu body không gửi thì giữ nguyên.
 *   Kiểm tra: định dạng YYYY-MM-DD hợp lệ, không trước ngày bắt đầu, và nếu rút ngắn thì
 *   không được có buổi đã lên lịch sau ngày mới (vì các buổi đó cần hủy trước).
 * Được gọi ở: classesPatch, bước 4, ngay sau readPatchClassMinEnrolled.
 * @param sql Kết nối database trong transaction do router mở.
 * @param rawEndOn Giá trị body.end_on sau khi str(); undefined nếu không gửi.
 * @param classId Mã lớp để truy vấn buổi học.
 * @param currentStartOn Ngày bắt đầu lớp từ dòng DB, để kiểm tra end_on không trước start_on.
 * @param currentEndOn Ngày kết thúc lớp từ dòng DB.
 * @returns Ngày kết thúc hợp lệ (chuỗi YYYY-MM-DD).
 * @throws Lỗi 400 field "end_on" nếu định dạng sai hoặc trước ngày bắt đầu;
 *   lỗi 409 CONFLICT_STATE nếu còn buổi lịch sau ngày mới.
 */
async function checkPatchClassEndOn(
  sql: Sql,
  rawEndOn: string | undefined,
  classId: string,
  currentStartOn: string,
  currentEndOn: string,
): Promise<string> {
  const endOn = rawEndOn === undefined ? currentEndOn : rawEndOn;

  // Bước 1: Kiểm tra định dạng YYYY-MM-DD và tính hợp lệ của ngày kết thúc.
  const endOnFormatIsInvalid =
    !endOn || !/^\d{4}-\d{2}-\d{2}$/.test(endOn) || Number.isNaN(Date.parse(endOn));
  if (endOnFormatIsInvalid) {
    throw err.field("end_on", "That date is not valid.");
  }

  // Bước 2: Ràng buộc nghiệp vụ: ngày kết thúc lớp không được trước ngày bắt đầu.
  const endOnPrecedesStartOn = endOn < currentStartOn;
  if (endOnPrecedesStartOn) {
    throw err.field("end_on", "A class cannot end before it starts.");
  }

  // Bước 3: Nếu rút ngắn ngày kết thúc, kiểm tra không còn buổi học nào (scheduled) sau ngày mới.
  const endOnIsShortenedFromCurrent = endOn < currentEndOn;
  if (endOnIsShortenedFromCurrent) {
    // Chuyển start_at về múi giờ 'Asia/Ho_Chi_Minh' để so sánh ngày lịch với ngày kết thúc.
    const sessionBeyondNewEndOn = await one(
      sql,
      `select 1 from sessions
        where class_id = $1 and status = 'scheduled'
          and (start_at at time zone 'Asia/Ho_Chi_Minh')::date > $2::date limit 1`,
      [classId, endOn],
    );
    if (sessionBeyondNewEndOn) {
      throw err.conflictState("Sessions are still scheduled after that date. Cancel them first.");
    }
  }

  return endOn;
}

/**
 * Làm gì: ghi tất cả các thay đổi vào DB: sức chứa, trình độ, trạng thái, học phí, sĩ số tối thiểu.
 *   Dùng một câu UPDATE duy nhất để giữ atomicity; end_on được UPDATE riêng ở bước sau.
 * Được gọi ở: classesPatch, bước 5.
 * @param sql Kết nối database trong transaction do router mở.
 * @param classId Mã lớp đã khóa.
 * @param fields Các trường đã qua kiểm tra ở bước 4.
 * @returns Không trả dữ liệu.
 * @throws Lỗi truy vấn được truyền nguyên vẹn lên router.
 */
async function applyPatchClassCoreFields(
  sql: Sql,
  classId: string,
  fields: PatchClassFields,
): Promise<void> {
  // Phân biệt: không gửi price_vnd (undefined) thì giữ nguyên; gửi null hoặc số thì mới cập nhật.
  const priceWasSent = fields.price_vnd !== undefined;
  // Dùng một câu UPDATE duy nhất để cập nhật đồng bộ các trường chính, đảm bảo tính nguyên tử (atomic).
  await sql.query(
    `update classes set capacity = $2, level = $3, status = coalesce($4::class_status, status),
            price_vnd = case when $5::boolean then $6::int else price_vnd end, min_enrolled = $7 where id = $1`,
    [classId, fields.capacity, fields.level, fields.status ?? null, priceWasSent, fields.price_vnd ?? null, fields.min_enrolled],
  );
}

/**
 * Làm gì: nếu ngày kết thúc thay đổi thì cập nhật DB và gia hạn tư cách thành viên
 *   của các hội viên đang đăng ký (nếu ngày được kéo dài thêm, không phải rút ngắn).
 *   Vì sao gia hạn miễn phí: trung tâm chủ động kéo dài lớp nên hội viên được hưởng lợi.
 * Được gọi ở: classesPatch, bước 6.
 * @param sql Kết nối database trong transaction do router mở.
 * @param classId Mã lớp đã khóa.
 * @param newEndOn Ngày kết thúc mới đã qua kiểm tra.
 * @param currentEndOn Ngày kết thúc cũ từ dòng DB, để so sánh.
 * @returns Số hội viên đã được gia hạn (0 nếu không có thay đổi hoặc ngày bị rút ngắn).
 * @throws Lỗi truy vấn được truyền nguyên vẹn lên router.
 */
async function applyPatchClassEndOn(
  sql: Sql,
  classId: string,
  newEndOn: string,
  currentEndOn: string,
): Promise<number> {
  // Không đổi ngày kết thúc thì thoát sớm để tránh truy vấn thừa.
  if (newEndOn === currentEndOn) {
    return 0;
  }

  await sql.query(`update classes set end_on = $2 where id = $1`, [classId, newEndOn]);

  // The centre moved the date, so members already enrolled are carried there for free.
  if (newEndOn > currentEndOn) {
    return carryMembersToClassEnd(sql, classId, newEndOn);
  }

  return 0;
}

/**
 * Làm gì: lần lượt cập nhật các ô văn bản mô tả lớp (description, syllabus, who_for, bring)
 *   nếu body gửi lên — ô nào không gửi thì không chạm vào. Chuỗi rỗng được xem là xóa nội dung.
 *   Vì sao mỗi ô một câu UPDATE riêng: giữ nguyên cách hoạt động gốc, dễ theo dõi từng ô.
 * Được gọi ở: classesPatch, bước 7.
 * @param sql Kết nối database trong transaction do router mở.
 * @param classId Mã lớp đã khóa.
 * @param body Body JSON đã parse; hàm tự đọc các ô description/syllabus/who_for/bring.
 * @returns Object chứa các ô đã sửa cùng giá trị mới; dùng để ghi vào audit và phản hồi.
 * @throws Lỗi 400 field tương ứng nếu nội dung vượt giới hạn ký tự.
 */
async function applyPatchClassTextFields(
  sql: Sql,
  classId: string,
  body: Record<string, unknown>,
): Promise<Partial<Record<ClassTextKey, string | null>>> {
  // Each text changes only when sent; an empty string clears it.
  const textEdits: Partial<Record<ClassTextKey, string | null>> = {};

  // Duyệt từng trường văn bản mô tả (description, syllabus, who_for, bring) để làm sạch và cập nhật nếu có gửi.
  for (const key of Object.keys(CLASS_TEXT_LIMITS) as ClassTextKey[]) {
    if (body[key] === undefined) continue;
    textEdits[key] = parseClassText(key, body[key]);
    await sql.query(`update classes set ${key} = $2 where id = $1`, [classId, textEdits[key]]);
  }

  return textEdits;
}

/**
 * Làm gì: nếu sức chứa tăng lên và lớp đang/sẽ mở thì mời người đầu hàng đợi vào nhận chỗ.
 *   Vì sao chỉ khi tăng: giảm sức chứa không tạo thêm chỗ trống; bước này không làm gì nếu không tăng.
 * Được gọi ở: classesPatch, bước 8.
 * @param sql Kết nối database trong transaction do router mở.
 * @param classId Mã lớp đã khóa.
 * @param newCapacity Sức chứa mới đã qua kiểm tra.
 * @param currentCapacity Sức chứa cũ từ dòng DB.
 * @param effectiveStatus Trạng thái sau khi áp dụng: status mới nếu gửi lên, ngược lại trạng thái cũ.
 * @returns Không trả dữ liệu.
 * @throws Lỗi truy vấn được truyền nguyên vẹn lên router.
 */
async function inviteWaitlistIfCapacityIncreased(
  sql: Sql,
  classId: string,
  newCapacity: number,
  currentCapacity: number,
  effectiveStatus: string,
): Promise<void> {
  // Chỉ tự động mời hội viên trong hàng đợi (waitlist) khi sức chứa thực tế tăng và lớp đang mở (open).
  const capacityIncreased = newCapacity > currentCapacity;
  const classIsOrWillBeOpen = effectiveStatus === "open";

  if (capacityIncreased && classIsOrWillBeOpen) {
    await inviteWaitlist(sql, classId);
  }
}

/**
 * Làm gì: ghi nhật ký thao tác sửa lớp để quản lý tra cứu ai đã sửa gì vào lúc nào.
 * Được gọi ở: classesPatch, bước 9.
 * @param sql Kết nối database trong transaction do router mở.
 * @param userId Mã quản lý đang đăng nhập, từ user.id.
 * @param classId Mã lớp đã sửa.
 * @param classRecord Dòng lớp trước khi sửa, để ghi trạng thái cũ.
 * @param fields Các trường đã sửa, để ghi trạng thái mới.
 * @param textEdits Các ô văn bản đã sửa, cũng được ghi vào after.
 * @returns Không trả dữ liệu.
 * @throws Lỗi ghi nhật ký được truyền nguyên vẹn lên router.
 */
async function auditPatchClass(
  sql: Sql,
  userId: string,
  classId: string,
  classRecord: PatchableClass,
  fields: PatchClassFields,
  textEdits: Partial<Record<ClassTextKey, string | null>>,
): Promise<void> {
  // Lưu đầy đủ trạng thái trước và sau khi sửa để phục vụ kiểm toán và truy vết lịch sử.
  const beforeState = {
    capacity: classRecord.capacity,
    level: classRecord.level,
    status: classRecord.status,
    min_enrolled: classRecord.min_enrolled,
    end_on: classRecord.end_on,
  };

  const afterState = {
    capacity: fields.capacity,
    level: fields.level,
    status: fields.status ?? classRecord.status,
    min_enrolled: fields.min_enrolled,
    end_on: fields.end_on,
    members_carried: fields.members_carried,
    ...(fields.price_vnd !== undefined ? { price_vnd: fields.price_vnd } : {}),
    ...textEdits,
  };

  await audit(sql, userId, "edit_class", "class", classId, beforeState, afterState);
}

/**
 * Làm gì: sửa sức chứa, trình độ, trạng thái (open/closed), học phí, sĩ số tối thiểu,
 *   ngày kết thúc và các ô mô tả của một lớp; hoặc hủy lớp nếu status = "cancelled".
 *   Đọc hàm này như mục lục: mỗi bước là một việc, chi tiết nằm trong các hàm phụ phía trên.
 *   Thứ tự các bước là cố ý: bước nào đứng trước thì lỗi của nó được báo trước cho người dùng.
 * Được gọi ở:
 *   - Màn hình /manager/classes (src/routes/manager.classes.tsx) mở ClassDetailModal với manage;
 *     các nút "Edit capacity", "Edit price", "Edit about", "Open"/"Close" và "Cancel class"
 *     trong src/client/components/class-detail.tsx đều gửi apiPatch(`/classes/:id`, body).
 *   - src/server/controllers/router.ts nhận PATCH /v1/classes/:id và gọi hàm này qua
 *     authed((sql, user) => classesPatch(sql, p1, request, user)):
 *     authed kiểm tra đăng nhập, mở transaction; lỗi ở bất kỳ bước nào thì rollback toàn bộ.
 * @param sql Kết nối database trong transaction do router mở.
 * @param classId Mã lớp từ p1 trong router (đường dẫn /v1/classes/:id).
 * @param request Request PATCH chứa body JSON với các trường cần sửa.
 * @param user Người đang đăng nhập; phải là manager, id được ghi vào nhật ký.
 * @returns { status: 200, body: { ok: true, class: { id, ...trường sau khi sửa } } }.
 * @throws Lỗi 403 nếu không phải manager; lỗi 404 nếu lớp không tồn tại;
 *   lỗi 409 CONFLICT_STATE nếu lớp đã hủy; các lỗi 400/422 từ kiểm tra dữ liệu.
 */
export async function classesPatch(sql: Sql, classId: string, request: Request, user: PublicUser) {
  // Bước 1: chỉ quản lý mới được sửa lớp.
  requireRole(user, ["manager"]);

  const body = await readJson(request);
  const requestedStatus = str(body.status);

  // Bước 2: nếu hủy lớp, khóa các liên kết thanh toán trước khi khóa lớp để tránh deadlock.
  const cancelLinks = await lockCancelClassPaymentLinks(sql, classId, requestedStatus);

  // Bước 3: đọc và khóa lớp; kiểm tra lớp tồn tại và chưa bị hủy.
  const classRecord = await lockPatchableClass(sql, classId);

  // Bước 4: nếu là yêu cầu hủy thì chuyển ngay sang cancelClass, không kiểm tra thêm.
  if (requestedStatus === "cancelled") {
    return cancelClass(sql, classRecord, reasonOf(body), user, cancelLinks);
  }

  // Bước 5: kiểm tra giá trị status mới (open/closed) và ràng buộc lớp draft.
  checkPatchClassStatus(requestedStatus, classRecord.status);

  // Bước 6: kiểm tra và đọc từng trường có thể sửa; thứ tự dưới đây là thứ tự báo lỗi.
  const newCapacity = checkPatchClassCapacity(body.capacity, classRecord.capacity, classRecord.enrolled_count);
  const newLevel = checkPatchClassLevel(str(body.level), classRecord.level);
  const newPriceVnd = readPatchClassPrice(body.price_vnd, body.price_vnd !== undefined);
  const newMinEnrolled = readPatchClassMinEnrolled(
    body.min_enrolled,
    body.min_enrolled !== undefined,
    newCapacity,
    classRecord.min_enrolled,
  );
  const newEndOn = await checkPatchClassEndOn(
    sql,
    str(body.end_on),
    classId,
    classRecord.start_on,
    classRecord.end_on,
  );

  // Bước 7: ghi các trường chính vào DB (capacity, level, status, price_vnd, min_enrolled).
  const patchedFields: PatchClassFields = {
    capacity: newCapacity,
    level: newLevel,
    status: requestedStatus,
    min_enrolled: newMinEnrolled,
    end_on: newEndOn,
    price_vnd: newPriceVnd,
    members_carried: 0,
  };
  await applyPatchClassCoreFields(sql, classId, patchedFields);

  // Bước 8: cập nhật ngày kết thúc và gia hạn tư cách thành viên nếu ngày kéo dài.
  patchedFields.members_carried = await applyPatchClassEndOn(sql, classId, newEndOn, classRecord.end_on);

  // Bước 9: cập nhật từng ô văn bản mô tả nếu body có gửi.
  const textEdits = await applyPatchClassTextFields(sql, classId, body as Record<string, unknown>);

  // Bước 10: mời người đầu hàng đợi vào nếu sức chứa tăng và lớp đang/sẽ mở.
  const effectiveStatus = requestedStatus ?? classRecord.status;
  await inviteWaitlistIfCapacityIncreased(sql, classId, newCapacity, classRecord.capacity, effectiveStatus);

  // Bước 11: ghi nhật ký ai đã sửa gì.
  await auditPatchClass(sql, user.id, classId, classRecord, patchedFields, textEdits);

  // Bước 12: trả kết quả để giao diện cập nhật hiển thị ngay.
  const responseBody = {
    capacity: newCapacity,
    level: newLevel,
    status: effectiveStatus,
    min_enrolled: newMinEnrolled,
    end_on: newEndOn,
    members_carried: patchedFields.members_carried,
    ...(newPriceVnd !== undefined ? { price_vnd: newPriceVnd } : {}),
    ...textEdits,
  };
  return { status: 200, body: { ok: true, class: { id: classId, ...responseBody } } };
}

// Danh sách mã người dùng của các nhóm tham gia lớp học khi hủy: đã xác nhận (members), đang chờ (waiting) và đang giữ chỗ (holding).
type CancelClassParticipants = {
  members: string[];
  waiting: string[];
  holding: string[];
};

// Dữ liệu đăng ký và các khoản phí đã đóng/đã hoàn của hội viên, dùng để tính toán số tiền cần hoàn khi lớp bị hủy.
type CancelClassPaidEnrollment = {
  id: string;
  user_id: string;
  price_vnd: number | null;
  extension_vnd: number;
  paid_vnd: number;
  returned_vnd: number;
};

// Thống kê kết quả hoàn tiền khi hủy lớp: tổng số lượt hoàn, tổng số tiền (VNĐ) và bảng tra cứu số tiền theo từng người dùng.
type CancelClassRefundSummary = {
  refunded: number;
  refundedVnd: number;
  refundByUser: Map<string, number>;
};

/**
 * Làm gì: yêu cầu có lý do hủy lớp để người học biết vì sao lớp bị hủy.
 * Được gọi ở: cancelClass, bước 1.
 * @param reason Lý do đã được classesPatch đọc bằng reasonOf.
 * @returns Không trả dữ liệu; sau kiểm tra, reason có kiểu string.
 * @throws Lỗi 400 VALIDATION, field reason, nếu lý do là giá trị falsy.
 */
function checkCancelClassReason(reason: string | undefined): asserts reason is string {
  // Bắt buộc phải có lý do hủy lớp để lưu vết và gửi thông báo minh bạch cho hội viên.
  if (!reason) {
    throw err.field("reason", "Give a reason for cancelling this class.");
  }
}

/**
 * Làm gì: hủy các buổi còn lịch và chưa kết thúc, trả sân và lưu lý do từng buổi.
 *   Vì sao xét giờ kết thúc: buổi đang diễn ra cũng phải được hủy.
 * Được gọi ở: cancelClass, bước 2.
 * @param sql Kết nối database trong transaction do router mở.
 * @param classId Mã lớp từ dòng lớp đã được classesPatch khóa.
 * @param reason Lý do đã qua checkCancelClassReason.
 * @returns Số buổi lấy được để hủy.
 * @throws Lỗi truy vấn được truyền nguyên lên router để đổi thành mã HTTP; không tự tạo lỗi nghiệp vụ.
 */
async function cancelClassRemainingSessions(
  sql: Sql,
  classId: string,
  reason: string,
): Promise<number> {
  // Bước 1: Tìm các buổi học có lịch (scheduled) chưa kết thúc (end_at > now()) để tiến hành hủy và trả sân.
  const upcomingSessions = await sql.query(
    `select id, start_at from sessions where class_id = $1 and status = 'scheduled' and end_at > now()`,
    [classId],
  );

  // Duyệt từng buổi học sắp tới để giải phóng lịch chiếm sân và lịch của HLV.
  for (const session of upcomingSessions) {
    // Xử lý xong từng buổi trước khi sang buổi tiếp theo để giữ thứ tự ghi dữ liệu.
    await sql.query(`select occupancy_release_session($1::uuid, 'cancelled'::session_status)`, [session.id]);
    await sql.query(`update sessions set change_reason = $2 where id = $1`, [session.id, reason]);
  }

  return upcomingSessions.length;
}

/**
 * Làm gì: lấy người đã đăng ký, đang chờ và đang giữ chỗ trước khi hủy đăng ký.
 *   Vì sao lấy lúc này: sau khi đổi trạng thái sẽ không còn truy vấn được ba nhóm cũ.
 * Được gọi ở: cancelClass, bước 3.
 * @param sql Kết nối database trong transaction của request.
 * @param classId Mã lớp đang hủy.
 * @returns Ba danh sách theo thứ tự database trả về, giữ cả mã người dùng trùng.
 * @throws Lỗi truy vấn được truyền nguyên lên router để đổi thành mã HTTP; không tự tạo lỗi nghiệp vụ.
 */
async function readCancelClassParticipants(
  sql: Sql,
  classId: string,
): Promise<CancelClassParticipants> {
  // Bước 1: Lấy danh sách ID học viên đã đăng ký chính thức (status = 'confirmed').
  const members = await confirmedMembers(sql, classId);

  // Bước 2: Lấy danh sách ID học viên trong hàng đợi (status = 'waitlisted').
  const waitingRows = await sql.query(
    `select user_id from enrollments where class_id = $1 and status = 'waitlisted'`,
    [classId],
  );
  const waiting: string[] = [];
  for (const enrollment of waitingRows) {
    waiting.push(String(enrollment.user_id));
  }

  // Bước 3: Lấy danh sách ID học viên đang giữ chỗ chưa thanh toán (status = 'hold').
  // Members holding an unpaid seat are told too: their hold ends with the class.
  const holdingRows = await sql.query(
    `select user_id from enrollments where class_id = $1 and status = 'hold'`,
    [classId],
  );
  const holding: string[] = [];
  for (const enrollment of holdingRows) {
    holding.push(String(enrollment.user_id));
  }

  return { members, waiting, holding };
}

/**
 * Làm gì: tạo phiếu hoàn tiền mặt đang chờ nhận cho một đăng ký có tiền cần hoàn.
 *   Vì sao khóa người dùng trước: giữ đúng thứ tự xử lý tiền và đối soát điểm của người đó.
 * Được gọi ở: createCancelClassRefunds, trong vòng lặp của bước 4 trong cancelClass.
 * @param sql Kết nối database trong transaction của request.
 * @param enrollment Đăng ký đã xác nhận, lấy từ truy vấn của createCancelClassRefunds.
 * @param refundVnd Số tiền dương cần hoàn, đã tính và kiểm tra trước khi gọi.
 * @returns Không trả dữ liệu; phiếu được tạo và điểm khách hàng được đối soát.
 * @throws Lỗi từ truy vấn, cấp mã hoặc đối soát được truyền nguyên lên router để đổi thành mã HTTP.
 */
async function insertCancelClassRefund(
  sql: Sql,
  enrollment: CancelClassPaidEnrollment,
  refundVnd: number,
): Promise<void> {
  // Bước 1: Khóa dòng user để tránh xung đột dữ liệu ví hoặc điểm thưởng khi xử lý đồng thời.
  await sql.query(`select id from users where id = $1 for update`, [enrollment.user_id]);
  // Bước 2: Cấp mã giao dịch thanh toán mới có tiền tố PAY.
  const paymentCode = await nextCode(sql, "PAY");
  // Bước 3: Ghi nhận phiếu hoàn tiền mặt ở trạng thái chờ chi (refund_pending), số tiền âm thể hiện dòng tiền chi ra.
  await sql.query(
    `insert into payments (code, user_id, method, amount_vnd, vat_rate, status, ref_type, ref_id, created_by)
       values ($1,$2,'cash',$3,0,'refund_pending','enrollment',$4,null)`,
    [paymentCode, enrollment.user_id, -refundVnd, enrollment.id],
  );
  // Bước 4: Đối soát và thu hồi điểm tích lũy thành viên tương ứng với số tiền hoàn.
  await reconcileLoyaltyRefund(sql, enrollment.user_id);
}

/**
 * Làm gì: tính và tạo các khoản hoàn tiền khi trung tâm hủy lớp.
 *   Vì sao giới hạn số tiền: không hoàn vượt tiền đã đóng sau khi trừ khoản đã hoàn
 *   hoặc đang chờ hoàn; ngày gia hạn còn cần cho lớp khác được rollbackExtension giữ lại.
 * Được gọi ở: cancelClass, bước 4.
 * @param sql Kết nối database trong transaction của request.
 * @param classId Mã lớp đang hủy.
 * @returns Số đăng ký có khoản hoàn, tổng tiền hoàn và tổng tiền theo từng người nhận.
 * @throws Lỗi từ database hoặc các hàm xử lý tiền được truyền nguyên lên router để đổi thành mã HTTP.
 */
async function createCancelClassRefunds(
  sql: Sql,
  classId: string,
): Promise<CancelClassRefundSummary> {
  // The centre cancelled: each member gets back the tuition paid and the extension days no other
  // class needs, less anything already sent back. Refunds are cash, so each row waits at the desk
  // until a receptionist hands the money over: only then is it posted, into that person's till.
  // created_by stays empty because nobody at the desk raised it; the audit row names the manager.
  // Bước 1: Lấy cấu hình hệ thống (member_day_rate_vnd) để tính giá hoàn mỗi ngày gia hạn gói tập.
  const settings = await getSettings(sql);
  let refunded = 0;
  let refundedVnd = 0;
  const refundByUser = new Map<string, number>();

  // Bước 2: Lấy danh sách đăng ký confirmed kèm tổng tiền đã nộp (paid_vnd) và tiền đã hoàn/chờ hoàn (returned_vnd).
  const enrollments = await sql.query<CancelClassPaidEnrollment>(
    `select e.id, e.user_id, e.price_vnd, e.extension_vnd,
            coalesce((select sum(p.amount_vnd) from payments p
                       where p.ref_type = 'enrollment' and p.ref_id = e.id and p.status = 'posted' and p.amount_vnd > 0), 0)::int as paid_vnd,
            coalesce((select sum(-p.amount_vnd) from payments p
                       where p.ref_type = 'enrollment' and p.ref_id = e.id and p.status in ('posted','refund_pending') and p.amount_vnd < 0), 0)::int as returned_vnd
       from enrollments e where e.class_id = $1 and e.status = 'confirmed'`,
    [classId],
  );

  // Bước 3: Duyệt từng đăng ký confirmed để tính tiền hoàn học phí và tiền hoàn gia hạn gói tập.
  for (const enrollment of enrollments) {
    // Tiền học phí thuần = giá lớp trừ phần phí gia hạn gói tập, tối đa bằng số tiền thực tế đã đóng.
    const tuitionVnd = Math.min(
      enrollment.paid_vnd,
      Math.max(0, (enrollment.price_vnd ?? 0) - enrollment.extension_vnd),
    );

    // Vẫn thu hồi gia hạn khi không còn tiền để hoàn; đây còn là thay đổi hạn gói tập.
    const extensionRollback = await rollbackExtension(
      sql,
      enrollment.id,
      settings.member_day_rate_vnd,
    );
    // Tổng tiền hoàn = học phí + tiền hoàn gia hạn gói tập; chặn trên bởi số tiền thực đóng còn lại chưa hoàn.
    const refundVnd = Math.min(
      tuitionVnd + extensionRollback.refund_vnd,
      Math.max(0, enrollment.paid_vnd - enrollment.returned_vnd),
    );
    // Bỏ qua nếu không có số tiền dương cần hoàn.
    if (refundVnd <= 0) {
      continue;
    }

    // Bước 4: Tạo phiếu hoàn tiền mặt (refund_pending) và cập nhật tổng hợp số tiền hoàn theo từng người.
    await insertCancelClassRefund(sql, enrollment, refundVnd);
    refundByUser.set(
      enrollment.user_id,
      (refundByUser.get(enrollment.user_id) ?? 0) + refundVnd,
    );
    refunded += 1;
    refundedVnd += refundVnd;
  }

  return { refunded, refundedVnd, refundByUser };
}

/**
 * Làm gì: hết hạn các lời mời nhận chỗ còn chờ của lớp sắp hủy.
 * Được gọi ở: cancelClass, bước 5.
 * @param sql Kết nối database trong transaction của request.
 * @param classId Mã lớp đang hủy.
 * @returns Không trả dữ liệu; các lời mời pending được đổi thành expired.
 * @throws Lỗi truy vấn được truyền nguyên lên router để đổi thành mã HTTP.
 */
async function expireCancelClassOffers(sql: Sql, classId: string): Promise<void> {
  // Chuyển các lời mời nhận chỗ đang chờ (pending) sang hết hạn (expired) vì lớp đã bị hủy.
  await sql.query(
    `update waitlist_offers set status = 'expired'
      where status = 'pending' and enrollment_id in (select id from enrollments where class_id = $1)`,
    [classId],
  );
}

/**
 * Làm gì: hủy đăng ký còn hiệu lực và xóa thông tin chờ, giữ chỗ, yêu cầu chuyển khoản.
 * Được gọi ở: cancelClass, bước 6.
 * @param sql Kết nối database trong transaction của request.
 * @param classId Mã lớp đang hủy.
 * @returns Không trả dữ liệu; các đăng ký confirmed, waitlisted và hold được hủy.
 * @throws Lỗi truy vấn được truyền nguyên lên router để đổi thành mã HTTP.
 */
async function cancelClassActiveEnrollments(sql: Sql, classId: string): Promise<void> {
  // Cập nhật trạng thái 'cancelled' và xóa sạch vị trí hàng đợi, hạn giữ chỗ, yêu cầu chuyển khoản.
  await sql.query(
    `update enrollments
        set status = 'cancelled', waitlist_pos = null, hold_until = null, transfer_requested_at = null
      where class_id = $1 and status in ('confirmed','waitlisted','hold')`,
    [classId],
  );
}

/**
 * Làm gì: đánh dấu lớp đã hủy, đưa sĩ số về không và lưu lý do.
 * Được gọi ở: cancelClass, bước 8, sau khi thu hồi liên kết thanh toán.
 * @param sql Kết nối database trong transaction của request.
 * @param classId Mã lớp đã được classesPatch khóa.
 * @param reason Lý do đã qua checkCancelClassReason.
 * @returns Không trả dữ liệu; dòng lớp được cập nhật.
 * @throws Lỗi truy vấn được truyền nguyên lên router để đổi thành mã HTTP.
 */
async function markCancelClassCancelled(
  sql: Sql,
  classId: string,
  reason: string,
): Promise<void> {
  // Cập nhật trạng thái 'cancelled', đặt sĩ số lớp về 0 và lưu lý do hủy lớp.
  await sql.query(`update classes set status = 'cancelled', enrolled_count = 0, cancel_reason = $2 where id = $1`, [
    classId,
    reason,
  ]);
}

/**
 * Làm gì: báo hủy lớp cho người học và người dạy; người được hoàn tiền nhận thêm số tiền.
 *   Vì sao chia hai lượt: người có khoản hoàn chỉ nhận thông báo chứa tổng tiền của họ.
 * Được gọi ở: cancelClass, bước 9.
 * @param sql Kết nối database trong transaction của request.
 * @param classId Mã lớp đang hủy.
 * @param participants Ba nhóm người học đã lấy trước khi hủy đăng ký.
 * @param coachId Mã người dạy chính từ dòng lớp.
 * @param assistantId Mã trợ giảng từ dòng lớp; giá trị falsy thì không thêm người nhận.
 * @param reason Lý do đã qua checkCancelClassReason.
 * @param refundByUser Tổng tiền hoàn theo người, từ createCancelClassRefunds.
 * @returns Không trả dữ liệu; thông báo được đưa vào hàng đợi qua notifyClass.
 * @throws Lỗi ghi hàng đợi được truyền nguyên lên router để đổi thành mã HTTP.
 */
async function notifyCancelClassParticipants(
  sql: Sql,
  classId: string,
  participants: CancelClassParticipants,
  coachId: string,
  assistantId: string | null,
  reason: string,
  refundByUser: Map<string, number>,
): Promise<void> {
  // Bước 1: Tổng hợp danh sách người nhận gồm toàn bộ học viên (members, waiting, holding), HLV chính và trợ giảng.
  const recipients = [
    ...participants.members,
    ...participants.waiting,
    ...participants.holding,
    coachId,
  ];
  if (assistantId) {
    recipients.push(assistantId);
  }

  // Bước 2: Tách nhóm người nhận không phát sinh khoản tiền hoàn.
  const recipientsWithoutRefund: string[] = [];
  for (const recipientId of recipients) {
    if (!refundByUser.has(recipientId)) {
      recipientsWithoutRefund.push(recipientId);
    }
  }

  // Bước 3: Gửi thông báo hủy chung cho những người không có tiền hoàn.
  // Để notifyClass khử trùng như trước; không thay đổi danh sách dùng để đếm notified.
  await notifyClass(
    sql,
    classId,
    recipientsWithoutRefund,
    { kind: "class_cancelled", reason },
    `class_cancel|${classId}`,
  );

  // Bước 4: Gửi thông báo hủy riêng kèm thông tin số tiền hoàn cụ thể cho từng học viên được hoàn tiền.
  for (const [userId, refundVnd] of refundByUser) {
    await notifyClass(
      sql,
      classId,
      [userId],
      { kind: "class_cancelled", reason, refund_vnd: refundVnd },
      `class_cancel|${classId}`,
    );
  }
}

/**
 * Làm gì: ghi nhật ký người quản lý đã hủy lớp và số buổi, khoản hoàn bị ảnh hưởng.
 * Được gọi ở: cancelClass, bước 10.
 * @param sql Kết nối database trong transaction của request.
 * @param userId Mã người quản lý đang đăng nhập, từ user.id.
 * @param classId Mã lớp đã hủy.
 * @param previousStatus Trạng thái lớp trước khi hủy, từ dòng lớp do classesPatch đọc.
 * @param reason Lý do đã qua checkCancelClassReason.
 * @param cancelledSessionCount Số buổi từ cancelClassRemainingSessions.
 * @param refunds Kết quả tạo khoản hoàn từ createCancelClassRefunds.
 * @returns Không trả dữ liệu; nhật ký cancel_class được lưu.
 * @throws Lỗi ghi nhật ký được truyền nguyên lên router để đổi thành mã HTTP.
 */
async function auditCancelClass(
  sql: Sql,
  userId: string,
  classId: string,
  previousStatus: string,
  reason: string,
  cancelledSessionCount: number,
  refunds: CancelClassRefundSummary,
): Promise<void> {
  // Ghi audit log chi tiết hành động hủy lớp của manager kèm số buổi học và số tiền hoàn bị ảnh hưởng.
  await audit(sql, userId, "cancel_class", "class", classId, { status: previousStatus }, {
    status: "cancelled",
    reason,
    sessions: cancelledSessionCount,
    members_refunded: refunds.refunded,
    refunded_vnd: refunds.refundedVnd,
  });
}

/**
 * Làm gì: ghép kết quả hủy lớp cho giao diện.
 *   Vì sao notified cộng độ dài ba nhóm: giữ cách đếm người học của API,
 *   không cộng người dạy và không đổi thành số người nhận duy nhất.
 * Được gọi ở: cancelClass, bước 11.
 * @param cancelledSessionCount Số buổi từ cancelClassRemainingSessions.
 * @param participants Ba nhóm người học đã lấy trước khi hủy đăng ký.
 * @param refunds Kết quả tạo khoản hoàn từ createCancelClassRefunds.
 * @returns Phản hồi status 200 với body chứa kết quả hủy và hoàn tiền.
 * @throws Không chủ động ném lỗi; hàm không truy vấn hay ghi dữ liệu.
 */
function buildCancelClassResponse(
  cancelledSessionCount: number,
  participants: CancelClassParticipants,
  refunds: CancelClassRefundSummary,
) {
  // Trả về mã 200 cùng thống kê chi tiết: số buổi hủy, số người nhận thông báo, số người và số tiền được hoàn.
  return {
    status: 200,
    body: {
      ok: true,
      sessions_cancelled: cancelledSessionCount,
      notified: participants.members.length + participants.waiting.length + participants.holding.length,
      refunded: refunds.refunded,
      refunded_vnd: refunds.refundedVnd,
    },
  };
}

/**
 * Làm gì: hủy toàn bộ lớp, giải phóng sân, tạo khoản hoàn tiền và thông báo người liên quan.
 *   Vì sao giữ thứ tự: phải lấy người nhận và xử lý hoàn tiền trước khi hủy các đăng ký.
 * Được gọi ở:
 *   - Màn hình /manager/classes (src/routes/manager.classes.tsx) mở ClassDetailModal
 *     với manage; nút "Cancel class" mở ActionForm để nhập lý do và xác nhận hủy.
 *   - ActionForm trong src/client/components/class-detail.tsx gửi PATCH /v1/classes/:id
 *     với status: "cancelled" và reason.
 *   - src/server/controllers/router.ts chuyển request qua authed đến classesPatch.
 *     authed mở transaction và xác thực; classesPatch kiểm tra quyền manager,
 *     khóa liên kết thanh toán rồi khóa lớp, kiểm tra lớp tồn tại/chưa hủy,
 *     sau đó gọi cancelClass.
 * @param sql Kết nối database trong transaction do router mở.
 * @param cl Dòng lớp đã được classesPatch đọc và khóa; giữ trạng thái cũ để ghi nhật ký.
 * @param reason Lý do do classesPatch lấy bằng reasonOf từ body JSON.
 * @param user Người quản lý đã được classesPatch kiểm tra quyền; id dùng cho nhật ký.
 * @param links Các liên kết thanh toán giữ chỗ đã được classesPatch khóa; mặc định là [].
 * @returns { status: 200, body } với ok, sessions_cancelled, notified, refunded và refunded_vnd.
 * @throws Lỗi 400 VALIDATION, field reason, nếu thiếu lý do; các lỗi từ hàm được gọi
 *   được truyền nguyên lên router để đổi thành mã HTTP và rollback transaction.
 */
async function cancelClass(
  sql: Sql,
  cl: { id: string; sport: string; status: string; coach_id: string; assistant_id: string | null },
  reason: string | undefined,
  user: PublicUser,
  links: Array<{ id: string; provider_order_code: string | number | null }> = [],
) {
  // Bước 1: yêu cầu lý do trước mọi truy vấn của quá trình hủy.
  checkCancelClassReason(reason);

  // Bước 2: hủy các buổi chưa kết thúc để trả sân.
  const cancelledSessionCount = await cancelClassRemainingSessions(sql, cl.id, reason);

  // Bước 3: giữ danh sách người học trước khi trạng thái đăng ký thay đổi.
  const participants = await readCancelClassParticipants(sql, cl.id);

  // Bước 4: tạo khoản hoàn khi các đăng ký vẫn còn trạng thái confirmed.
  const refunds = await createCancelClassRefunds(sql, cl.id);

  // Bước 5: đóng lời mời nhận chỗ vì lớp không còn nhận người học.
  await expireCancelClassOffers(sql, cl.id);

  // Bước 6: kết thúc các đăng ký và thông tin giữ chỗ của lớp.
  await cancelClassActiveEnrollments(sql, cl.id);

  // Bước 7: thu hồi liên kết để chỗ đã hủy không tiếp tục được thanh toán.
  // No hold can be paid any more: withdraw its link at payOS so the money never moves.
  await withdrawLinks(sql, links, "Class cancelled", "CLASS_CANCELLED");

  // Bước 8: lưu trạng thái lớp sau khi đã xử lý đăng ký và thanh toán.
  await markCancelClassCancelled(sql, cl.id, reason);

  // Bước 9: báo hủy, kèm tổng tiền cho người có khoản hoàn.
  await notifyCancelClassParticipants(
    sql,
    cl.id,
    participants,
    cl.coach_id,
    cl.assistant_id,
    reason,
    refunds.refundByUser,
  );

  // Bước 10: ghi người thực hiện và kết quả để tra cứu việc hủy.
  await auditCancelClass(sql, user.id, cl.id, cl.status, reason, cancelledSessionCount, refunds);

  // Bước 11: trả số liệu để giao diện hiển thị kết quả.
  return buildCancelClassResponse(cancelledSessionCount, participants, refunds);
}

// Giữ tham chiếu import addDays để tránh cảnh báo biến chưa sử dụng (unused import).
void addDays;
