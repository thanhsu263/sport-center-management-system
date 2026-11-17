/**
 * Check-in at the door (SRS v1.4.1 FR-TRN-02, FR-CRT-07, UC-12, UC-17; BR-30, BR-31, BR-32).
 *
 * Three ways in, all of which write the same `gate` visit and nothing else —
 * a class register is the coach's call (BR-33), so walking through the gate
 * never marks anyone present at a session and never touches a balance (BR-32):
 *
 *  1. QR (default): the member opens their code, reception scans it.   method = qr
 *  2. Manual: no phone → look the member up, pick a reason.            method = manual
 *  3. Self (optional, off by default): the member scans the desk's QR. method = self
 *
 * Nothing booked and no class today is not a hard stop — reception decides —
 * but if there is nothing at all to let them in on, reception must say why,
 * and the visit is flagged (BR-31). Plans no longer exist, so they are not read here.
 */
import type { Sql } from "@/server/data/db";
import { ApiError, err } from "../errors";
import { requireFlag } from "../../services/flags";
import { audit, getSettings, pageOf, readJson, str } from "../helpers";
import { signCheckinToken, verifyCheckinToken } from "../../services/checkin";
import { normalizePhone } from "../../services/phone";
import { avatarUrlSql, requireRole, withAvatarUrl, type PublicUser } from "../session";
import { addDays, ictDateString, ictDateTime } from "../../../shared/arena3/time";
import { one } from "../tx";
import { pageParams } from "../validate";
import { bookingsCheckIn } from "./bookings";

// Biểu thức chính quy kiểm tra định dạng chuỗi UUID hợp lệ (8-4-4-4-12 ký tự hex).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Làm gì: Danh sách các lý do hợp lệ khi cho hội viên check-in thủ công qua cổng không dùng mã QR trên điện thoại.
 * Được gọi ở: gateCheckin (src/server/controllers/handlers/checkin.ts) và trang lễ tân desk.gate.tsx.
 */
export const MANUAL_REASONS = ["no_phone", "dead_battery", "qr_failed", "forgot", "other"] as const;
/**
 * Làm gì: Danh sách các lý do hợp lệ để lễ tân ghi đè (override) cho hội viên vào cổng khi không có lịch trong ngày (BR-31).
 * Được gọi ở: overrideOrAsk (src/server/controllers/handlers/checkin.ts) và trang lễ tân desk.gate.tsx.
 */
export const OVERRIDE_REASONS = ["expired_ok", "manager_ok", "guest_pass", "renewing", "other"] as const;

// Cấu trúc dữ liệu hội viên phục vụ hiển thị và kiểm tra thông tin tại quầy check-in.
type Member = { id: string; full_name: string; member_code: string | null; status: string; avatar_url: string | null };

/**
 * Làm gì: Tra cứu thông tin hội viên theo id, mã hội viên, số điện thoại hoặc từ khóa tìm kiếm (q), kiểm tra tài khoản đang hoạt động (active).
 * Được gọi ở: deskScan, gateCheckin, meSelfCheckin (src/server/controllers/handlers/checkin.ts).
 * @param sql Kết nối cơ sở dữ liệu PostgreSQL.
 * @param b Đối tượng chứa dữ liệu tìm kiếm (member_id, code, phone hoặc q).
 * @returns Thông tin hội viên gồm id, full_name, member_code, status và avatar_url.
 * @throws err.field nếu thiếu thông tin tra cứu hoặc UUID không hợp lệ; err.conflictState nếu trùng nhiều người hoặc tài khoản bị khóa; err.notFound nếu không tìm thấy.
 */
async function findMember(sql: Sql, b: Record<string, unknown>): Promise<Member> {
  // Bước 1: Trích xuất các tiêu chí tìm kiếm từ dữ liệu đầu vào và kiểm tra không được để trống toàn bộ.
  const id = str(b.member_id) || null;
  const code = str(b.code) || null;
  const phone = str(b.phone) || null;
  const q = str(b.q) || null;
  if (!id && !code && !phone && !q) {
    throw err.field("q", "Type a name, phone number or member code.");
  }
  const cols = `select id, full_name, member_code, status::text as status, ${avatarUrlSql("users")} from users where role = 'member'`;
  // Bước 2: Thực hiện truy vấn theo thứ tự ưu tiên: theo UUID id, mã hội viên code, số điện thoại, hoặc tìm kiếm mờ qua từ khóa q.
  let rows: Member[] = [];
  if (id) {
    if (!UUID_RE.test(id)) throw err.field("member_id", "member_id is not valid.");
    rows = (await sql.query<Member>(`${cols} and id = $1`, [id])).map(withAvatarUrl);
  } else if (code) {
    rows = (await sql.query<Member>(`${cols} and upper(member_code) = upper($1)`, [code])).map(withAvatarUrl);
  } else if (phone) {
    rows = (await sql.query<Member>(`${cols} and phone = $1`, [normalizePhone(phone)])).map(withAvatarUrl);
  } else {
    // Tìm kiếm mờ theo mã hội viên, 4 số cuối điện thoại hoặc tên không dấu (lấy tối đa 6 kết quả để kiểm tra độ trùng lặp).
    const digits = (q as string).replace(/\D/g, "");
    rows = (await sql.query<Member>(
      `${cols} and (upper(member_code) = upper($1) or ($2 <> '' and phone like '%' || $2)
                    or name_normalized like '%' || lower($1) || '%')
        order by full_name limit 6`,
      [q, digits.length >= 4 ? digits : ""],
    )).map(withAvatarUrl);
    // Nếu có nhiều hơn 1 hội viên khớp với từ khóa tìm kiếm, yêu cầu người dùng chọn cụ thể từ danh sách ứng viên.
    if (rows.length > 1) {
      throw err.conflictState("More than one member matches — pick one.", {
        candidates: rows.map((r) => ({ id: r.id, full_name: r.full_name, member_code: r.member_code })),
      });
    }
  }
  // Bước 3: Xác minh tìm thấy đúng 1 hội viên và tài khoản phải ở trạng thái active (hội viên bị khóa hoặc chưa kích hoạt không được vào cổng).
  if (!rows[0]) throw err.notFound("No member matches that.");
  if (rows[0].status !== "active") {
    throw err.conflictState("This account is not active.", { member_status: rows[0].status });
  }
  return rows[0];
}

/** What reception needs to see in the five seconds after a scan. */
/**
 * Làm gì: Tra cứu lịch hoạt động trong ngày của hội viên (lượt đặt sân đã xác nhận và buổi học theo lịch) để lễ tân kiểm tra quyền vào cổng (entitled).
 * Được gọi ở: deskScan, gateCheckin, meSelfCheckin (src/server/controllers/handlers/checkin.ts).
 * @param sql Kết nối cơ sở dữ liệu PostgreSQL.
 * @param memberId Mã UUID của hội viên cần kiểm tra lịch.
 * @returns Đối tượng gồm danh sách warnings, bookings (đặt sân hôm nay), sessions (buổi học hôm nay) và cờ entitled.
 */
async function memberToday(sql: Sql, memberId: string) {
  // Bước 1: Xác định khung thời gian trọn vẹn của ngày hôm nay theo múi giờ Việt Nam (ICT).
  const today = ictDateString();
  const dayStart = ictDateTime(today, "00:00").toISOString();
  const dayEnd = ictDateTime(addDays(today, 1), "00:00").toISOString();
  const warnings: { kind: string; message: string }[] = [];
  // Bước 2: Truy vấn các lượt đặt sân trong ngày có trạng thái confirmed hoặc in_use của hội viên.
  const bookings = await sql.query(
    `select b.id, b.code, b.start_at, b.end_at, c.court_code, b.status::text as status
       from court_bookings b join courts c on c.id = b.court_id
      where b.user_id = $1 and b.status in ('confirmed','in_use') and b.start_at >= $2 and b.start_at < $3
      order by b.start_at`,
    [memberId, dayStart, dayEnd],
  );
  // Bước 3: Truy vấn các buổi học trong ngày mà hội viên đã ghi danh thành công (confirmed) và buổi học đang lên lịch (scheduled).
  const sessions = await sql.query(
    `select s.id, s.start_at, s.end_at, cl.sport::text as sport, cl.level, c.court_code
       from sessions s
       join classes cl on cl.id = s.class_id
       join courts c on c.id = s.court_id
       join enrollments e on e.class_id = cl.id and e.user_id = $1 and e.status = 'confirmed'
      where s.status = 'scheduled' and s.start_at >= $2 and s.start_at < $3
      order by s.start_at`,
    [memberId, dayStart, dayEnd],
  );
  // Something to let them in on: a court booked today or a class today.
  // Bước 4: Xác định quyền vào cổng (entitled): hội viên phải có ít nhất một lượt đặt sân hoặc buổi học trong ngày.
  const entitled = bookings.length > 0 || sessions.length > 0;
  return { warnings, bookings, sessions, entitled };
}

// Cấu trúc dữ liệu đầu vào để ghi nhận một lượt check-in qua cổng.
type VisitInput = {
  member: Member;
  method: "qr" | "manual" | "self";
  actorId: string | null;
  reason?: string | null;
  flagged?: boolean;
};

/** Write the visit, or return the one already written inside the dedup window (BR-31). */
/**
 * Làm gì: Ghi nhận lượt vào cổng (attendance kind = 'gate') vào cơ sở dữ liệu, hoặc trả về lượt vào gần nhất nếu nằm trong khoảng thời gian chống trùng lặp (BR-31).
 * Được gọi ở: deskScan, gateCheckin, overrideOrAsk, meSelfCheckin (src/server/controllers/handlers/checkin.ts).
 * @param sql Kết nối cơ sở dữ liệu PostgreSQL.
 * @param v Đối tượng chứa thông tin lượt vào cổng (member, method, actorId, reason, flagged).
 * @returns Đối tượng gồm thời điểm at, cờ duplicate và phương thức method.
 */
async function recordVisit(sql: Sql, v: VisitInput) {
  // Bước 1: Kiểm tra chống ghi nhận trùng lặp: tìm lượt check-in cổng gần nhất của hội viên trong khoảng gate_dedup_minutes (BR-31).
  const settings = await getSettings(sql);
  const since = new Date(Date.now() - settings.gate_dedup_minutes * 60_000).toISOString();
  const recent = await one<{ at: string; method: string | null }>(
    sql,
    `select at, method from attendance where user_id = $1 and kind = 'gate' and at > $2 order by at desc limit 1`,
    [v.member.id, since],
  );
  if (recent) return { at: recent.at, duplicate: true, method: recent.method };
  // Bước 2: Chèn bản ghi mới vào bảng attendance với loại kind = 'gate'.
  const row = await one<{ at: string }>(
    sql,
    `insert into attendance (kind, user_id, method, flagged, reason, checked_by)
     values ('gate', $1, $2, $3, $4, $5) returning at`,
    [v.member.id, v.method, v.flagged ?? false, v.reason ?? null, v.actorId],
  );
  return { at: row?.at ?? new Date().toISOString(), duplicate: false, method: v.method };
}

/**
 * Làm gì: Kiểm tra giá trị lý do (lý do thủ công hoặc lý do ghi đè) có thuộc danh sách hợp lệ cho phép (whitelist) hay không.
 * Được gọi ở: gateCheckin, overrideOrAsk (src/server/controllers/handlers/checkin.ts).
 * @param list Danh sách các giá trị chuỗi hợp lệ cho phép.
 * @param v Giá trị lý do cần kiểm tra (unknown từ request body).
 * @param field Tên trường dùng để báo lỗi nếu giá trị không hợp lệ.
 * @param label Nhãn mô tả lý do hiển thị trong thông báo lỗi.
 * @returns Chuỗi lý do hợp lệ sau khi kiểm tra.
 * @throws err.field nếu giá trị rỗng hoặc không nằm trong danh sách cho phép.
 */
function validReason(list: readonly string[], v: unknown, field: string, label: string): string {
  // Chuyển đổi sang chuỗi và đối chiếu với danh sách whitelist cho phép.
  const r = str(v);
  if (!r || !list.includes(r)) throw err.field(field, `Choose ${label}.`);
  return r;
}

/**
 * Scan a code. The token says who or what it is for; staff only ever see the result.
 * Member code → gate visit. Booking code → check the booking in as well.
 */
/**
 * Làm gì: Xử lý quét mã tại quầy lễ tân (mã QR hội viên, mã QR đặt sân, mã vạch hoặc số điện thoại), tự động check-in sân nếu là mã đặt sân (BR-30).
 * Được gọi ở: POST /api/desk/scan (src/server/controllers/router.ts qua authed).
 * @param sql Kết nối cơ sở dữ liệu trong transaction.
 * @param request HTTP Request chứa token, code hoặc chuỗi tìm kiếm q.
 * @param user Thông tin tài khoản nhân viên thực hiện (receptionist hoặc manager).
 * @returns Phản hồi HTTP 200 kèm thông tin hội viên, kết quả vào cổng và trạng thái check-in đặt sân nếu có.
 * @throws err.forbidden nếu sai quyền; err.conflictState nếu cờ F4 tắt; err.field nếu thiếu mã; err.br("BR-30") nếu quét mã bàn quầy hoặc mã đã dùng.
 */
export async function deskScan(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn nhân viên (receptionist hoặc manager) và kiểm tra cờ tính năng F4.
  requireRole(user, ["receptionist", "manager"]);
  await requireFlag(sql, "F4");
  // Bước 2: Đọc dữ liệu request và lấy chuỗi mã đầu vào (token, code hoặc q).
  const b = await readJson(request);
  const raw = str(b.token) || str(b.code) || str(b.q) || "";
  if (!raw.trim()) throw err.field("token", "Please enter or scan a code.");

  // Bước 3: Thử giải mã token HMAC đối với mã QR hệ thống; nếu không phải token thì chuyển sang cơ chế tìm kiếm dự phòng.
  let t: ReturnType<typeof verifyCheckinToken> | null = null;
  try {
    t = verifyCheckinToken(raw);
  } catch (e) {
    if (b.token !== undefined || raw.includes(".")) throw e;
    // If raw is not a valid HMAC token and wasn't sent as `token`, see if it matches a member code or phone number directly
  }

  // Bước 4: Xử lý khi mã quét là token QR hợp lệ (loại member hoặc booking).
  if (t) {
    if (t.kind === "desk") throw err.br("BR-30", "That is the desk code — a member scans it, reception does not.");
    // Xác định ID hội viên: nếu là token member thì lấy trực tiếp từ sub, nếu là booking thì truy vấn chủ sở hữu đặt sân.
    const memberId =
      t.kind === "member"
        ? t.sub
        : (await one<{ user_id: string | null }>(sql, `select user_id from court_bookings where id = $1`, [t.sub]))
            ?.user_id;
    if (!memberId) throw err.notFound("That booking has no member to check in.");
    const member = await findMember(sql, { member_id: memberId });
    const today = await memberToday(sql, member.id);
    // Asking reception to decide writes nothing, so it must not spend the code:
    // the retry with an override reason carries the same one.
    if (!today.entitled && b.override !== true) return await overrideOrAsk(sql, b, member, today, "qr", user);
    // Single use: the second scan of the same code is refused, not silently accepted.
    // Chống quét lặp mã QR (BR-30): ghi nhận JTI vào bảng checkin_tokens, nếu trùng JTI thì từ chối vì mã chỉ được dùng một lần.
    const first = await sql.query<{ jti: string }>(
      `insert into checkin_tokens (jti, user_id) values ($1, $2) on conflict (jti) do nothing returning jti`,
      [t.jti, memberId],
    );
    if (first.length === 0) throw err.br("BR-30", "That code was already used — ask the member to refresh it.");
    if (!today.entitled) return await overrideOrAsk(sql, b, member, today, "qr", user);
    // Ghi nhận lượt check-in cổng bằng phương thức 'qr'.
    const visit = await recordVisit(sql, { member, method: "qr", actorId: user.id });
    let booking: unknown = null;
    let bookingNote: string | null = null;
    // Nếu quét mã đặt sân, thực hiện check-in sân đồng thời (BR-11, BR-30); nếu lỗi giờ chơi thì chỉ cảnh báo, không chặn vào cổng.
    if (t.kind === "booking") {
      // Walking in early (or late) is still a gate visit; only the court itself waits
      // for its own window (BR-11). The handler refuses before it writes anything.
      try {
        booking = (await bookingsCheckIn(sql, t.sub, user)).body;
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        bookingNote = e.message;
      }
    }
    // Ghi nhật ký kiểm toán audit log nếu lượt vào cổng không bị trùng lặp.
    if (!visit.duplicate) await audit(sql, user.id, "gate_checkin", "user", member.id, null, { method: "qr" });
    return result(member, today, visit, {
      booking,
      ...(bookingNote ? { warnings: [...today.warnings, { kind: "booking", message: `Court not checked in: ${bookingNote}` }] } : {}),
    });
  }

  // Fallback: scanned or typed member code, barcode, or phone number
  // Bước 5: Cơ chế dự phòng khi không phải token HMAC: tra cứu hội viên theo mã nhập tay, mã vạch hoặc số điện thoại.
  const member = await findMember(sql, { q: raw });
  const today = await memberToday(sql, member.id);
  if (!today.entitled && b.override !== true) return await overrideOrAsk(sql, b, member, today, "manual", user, "qr_failed");
  const visit = await recordVisit(sql, { member, method: "manual", actorId: user.id, reason: "qr_failed" });
  if (!visit.duplicate) await audit(sql, user.id, "gate_checkin", "user", member.id, null, { method: "manual", code: raw });
  return result(member, today, visit);
}

/** Look a member up and let them in without a phone. A reason is mandatory. */
/**
 * Làm gì: Tra cứu hội viên và cho phép vào cổng thủ công tại quầy lễ tân khi không mang điện thoại hoặc lỗi mã, bắt buộc chọn lý do (BR-31).
 * Được gọi ở: POST /api/desk/gate-checkin (src/server/controllers/router.ts qua authed) và các bài kiểm thử flows.test.ts, tx.test.ts.
 * @param sql Kết nối cơ sở dữ liệu trong transaction.
 * @param request HTTP Request chứa tiêu chí tìm kiếm hội viên, lý do (reason) và cờ override nếu có.
 * @param user Tài khoản nhân viên lễ tân hoặc quản lý thực hiện.
 * @returns Phản hồi HTTP 200 kèm thông tin hội viên, kết quả vào cổng và lịch trình trong ngày.
 * @throws err.forbidden nếu sai vai trò; err.conflictState nếu cờ F4 tắt; err.field nếu thiếu lý do hợp lệ; err.notFound nếu không tìm thấy hội viên.
 */
export async function gateCheckin(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn nhân viên và cờ tính năng F4.
  requireRole(user, ["receptionist", "manager"]);
  await requireFlag(sql, "F4");
  // Bước 2: Đọc dữ liệu request, tra cứu hội viên và xác thực lý do vào thủ công (phải thuộc MANUAL_REASONS).
  const b = await readJson(request);
  const member = await findMember(sql, b);
  const reason = validReason(MANUAL_REASONS, b.reason, "reason", "why the code was not used");
  // Bước 3: Tra cứu lịch hoạt động trong ngày của hội viên; nếu không có lịch thì yêu cầu lễ tân ghi đè (override) hoặc từ chối.
  const today = await memberToday(sql, member.id);
  if (!today.entitled) return await overrideOrAsk(sql, b, member, today, "manual", user, reason);
  // Bước 4: Ghi nhận lượt vào cổng thủ công, ghi log kiểm toán audit và trả về kết quả.
  const visit = await recordVisit(sql, { member, method: "manual", actorId: user.id, reason });
  if (!visit.duplicate) await audit(sql, user.id, "gate_checkin", "user", member.id, null, { method: "manual", reason });
  return result(member, today, visit);
}

/**
 * Làm gì: Xử lý khi hội viên không có lịch trong ngày: yêu cầu lễ tân quyết định ghi đè (override) hoặc ghi nhận lượt vào có gắn cờ flagged (BR-31).
 * Được gọi ở: deskScan, gateCheckin (src/server/controllers/handlers/checkin.ts).
 * @param sql Kết nối cơ sở dữ liệu PostgreSQL.
 * @param b Dữ liệu request body từ client chứa cờ override và override_reason.
 * @param member Thông tin hội viên đang check-in.
 * @param today Thông tin lịch hoạt động trong ngày của hội viên.
 * @param method Phương thức check-in ('qr' hoặc 'manual').
 * @param user Nhân viên quầy lễ tân xử lý yêu cầu.
 * @param manualReason Lý do check-in thủ công trước đó (nếu có).
 * @returns Phản hồi yêu cầu lễ tân ghi đè (allowed = false) hoặc kết quả ghi nhận vào cổng kèm flagged = true.
 * @throws err.field nếu đã chọn ghi đè nhưng thiếu lý do ghi đè hợp lệ trong OVERRIDE_REASONS.
 */
async function overrideOrAsk(
  sql: Sql,
  b: Record<string, unknown>,
  member: Member,
  today: Awaited<ReturnType<typeof memberToday>>,
  method: "qr" | "manual",
  user: PublicUser,
  manualReason?: string,
) {
  // Bước 1: Nếu lễ tân chưa xác nhận ghi đè (override !== true), trả về cảnh báo needs_override và chưa ghi nhận lượt vào cổng.
  if (b.override !== true) {
    return {
      status: 200,
      body: {
        member: { id: member.id, full_name: member.full_name, member_code: member.member_code },
        allowed: false,
        needs_override: true,
        duplicate: false,
        checked_in_at: null,
        warnings: today.warnings,
        today: { bookings: today.bookings, sessions: today.sessions },
      },
    };
  }
  // Bước 2: Khi lễ tân xác nhận ghi đè, kiểm tra lý do ghi đè (phải thuộc danh sách OVERRIDE_REASONS).
  const why = validReason(OVERRIDE_REASONS, b.override_reason, "override_reason", "why this member may come in");
  // Bước 3: Ghi nhận lượt vào cổng với cờ flagged = true để kiểm toán sau này và ghi audit log.
  const visit = await recordVisit(sql, {
    member,
    method,
    actorId: user.id,
    reason: manualReason ? `${manualReason}; ${why}` : why,
    flagged: true,
  });
  if (!visit.duplicate) {
    await audit(sql, user.id, "gate_checkin_override", "user", member.id, null, { method, reason: why });
  }
  return result(member, today, visit, { flagged: true });
}

/**
 * Làm gì: Đóng gói phản hồi HTTP 200 chuẩn hóa khi hội viên được phép vào cổng thành công (allowed = true).
 * Được gọi ở: deskScan, gateCheckin, overrideOrAsk (src/server/controllers/handlers/checkin.ts).
 * @param member Thông tin chi tiết của hội viên.
 * @param today Dữ liệu lịch trình trong ngày của hội viên (bookings, sessions, warnings).
 * @param visit Thông tin lượt vào cổng (thời điểm check-in và cờ trùng lặp).
 * @param extra Các trường dữ liệu bổ sung tùy chọn (thông tin booking, cờ flagged...).
 * @returns Khách thể phản hồi HTTP 200 kèm cấu trúc body chuẩn hóa cho màn hình lễ tân.
 */
function result(
  member: Member,
  today: Awaited<ReturnType<typeof memberToday>>,
  visit: { at: string; duplicate: boolean },
  extra: Record<string, unknown> = {},
) {
  return {
    status: 200,
    body: {
      member: { id: member.id, full_name: member.full_name, member_code: member.member_code, avatar_url: member.avatar_url },
      allowed: true,
      needs_override: false,
      checked_in_at: visit.at,
      duplicate: visit.duplicate,
      warnings: today.warnings,
      today: { bookings: today.bookings, sessions: today.sessions },
      ...extra,
    },
  };
}

/** Today's gate check-ins, newest first, a page at a time (a busy day passes a hundred). */
/**
 * Làm gì: Lấy danh sách các lượt qua cổng trong ngày hôm nay theo thứ tự mới nhất trước, hỗ trợ phân trang (tối đa 100 lượt/trang).
 * Được gọi ở: GET /api/desk/gate-checkins (src/server/controllers/router.ts qua authedRead).
 * @param sql Kết nối cơ sở dữ liệu ở chế độ chỉ đọc.
 * @param request HTTP Request chứa query params phân trang (limit, offset).
 * @param user Tài khoản nhân viên đang truy cập (yêu cầu vai trò receptionist hoặc manager).
 * @returns Phản hồi HTTP 200 kèm danh sách phân trang các lượt vào cổng trong ngày.
 * @throws err.forbidden nếu người dùng không đủ quyền; err.conflictState nếu cờ F4 bị tắt.
 */
export async function gateCheckins(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền truy cập (chỉ receptionist hoặc manager) và cờ tính năng F4.
  requireRole(user, ["receptionist", "manager"]);
  await requireFlag(sql, "F4");
  // Bước 2: Phân tích tham số phân trang và xác định khoảng thời gian ngày hôm nay theo giờ Việt Nam (ICT).
  const { limit, offset } = pageParams(request, { def: 100, max: 100 });
  const today = ictDateString();
  const span = [ictDateTime(today, "00:00").toISOString(), ictDateTime(addDays(today, 1), "00:00").toISOString()];
  // Bước 3: Truy vấn danh sách lượt vào cổng trong ngày kèm tổng số bản ghi bằng hàm cửa sổ count(*) over().
  const rows = await sql.query<{ total: number } & Record<string, unknown>>(
    `select a.id, a.at, a.method, a.flagged, a.reason, u.id as user_id, u.full_name, u.member_code,
            ${avatarUrlSql("u")},
            count(*) over ()::int as total
       from attendance a join users u on u.id = a.user_id
      where a.kind = 'gate' and a.at >= $1 and a.at < $2
      order by a.at desc limit $3 offset $4`,
    [...span, limit, offset],
  );
  // Bước 4: Đính kèm avatar_url và trả về cấu trúc phân trang chuẩn qua helper pageOf.
  const body = await pageOf(rows.map(withAvatarUrl), { limit, offset }, async () =>
    ((await one<{ n: number }>(
      sql,
      `select count(*)::int as n from attendance where kind = 'gate' and at >= $1 and at < $2`,
      span,
    ))?.n ?? 0),
  );
  return { status: 200, body };
}

/** The member's own door code (UI-22). Short-lived and single use. */
/**
 * Làm gì: Tạo mã token QR vào cổng cá nhân cho hội viên (UI-22); mã có thời hạn ngắn và dùng một lần.
 * Được gọi ở: GET /api/me/checkin-token (src/server/controllers/router.ts qua authedRead).
 * @param sql Kết nối cơ sở dữ liệu ở chế độ chỉ đọc.
 * @param user Tài khoản người dùng đang đăng nhập (yêu cầu vai trò member).
 * @returns Phản hồi HTTP 200 chứa token ký HMAC, member_code và full_name để hiển thị mã QR.
 * @throws err.forbidden nếu tài khoản không phải vai trò member.
 */
export async function meCheckinToken(sql: Sql, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hội viên (role = 'member') và tra cứu mã hội viên, họ tên từ bảng users.
  requireRole(user, ["member"]);
  const m = await one<{ member_code: string | null; full_name: string }>(
    sql,
    `select member_code, full_name from users where id = $1`,
    [user.id],
  );
  // Bước 2: Ký token HMAC loại 'member' với ID người dùng và trả về cho client hiển thị mã QR.
  return {
    status: 200,
    body: {
      ...signCheckinToken("member", user.id),
      member_code: m?.member_code ?? null,
      full_name: m?.full_name ?? user.full_name,
    },
  };
}

/** The same, for one of the member's own court bookings. */
/**
 * Làm gì: Tạo mã token QR check-in cho một lượt đặt sân cụ thể của hội viên; chỉ khả dụng khi đặt sân ở trạng thái confirmed.
 * Được gọi ở: GET /api/me/bookings/:id/checkin-token (src/server/controllers/router.ts qua authedRead).
 * @param sql Kết nối cơ sở dữ liệu ở chế độ chỉ đọc.
 * @param bookingId Mã UUID của lượt đặt sân cần lấy mã QR check-in.
 * @param user Tài khoản người dùng đang đăng nhập (yêu cầu vai trò member).
 * @returns Phản hồi HTTP 200 chứa token ký HMAC loại 'booking'.
 * @throws err.forbidden nếu không phải member; err.notFound nếu bookingId không hợp lệ, không tồn tại hoặc không chính chủ; err.conflictState nếu lượt đặt sân chưa confirmed.
 */
export async function meBookingCheckinToken(sql: Sql, bookingId: string, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hội viên và kiểm tra định dạng UUID hợp lệ của bookingId.
  requireRole(user, ["member"]);
  if (!UUID_RE.test(bookingId)) throw err.notFound();
  // Bước 2: Tra cứu thông tin đặt sân và xác minh quyền sở hữu chính chủ (chỉ người đặt mới được lấy mã).
  const b = await one<{ user_id: string | null; status: string }>(
    sql,
    `select user_id, status::text as status from court_bookings where id = $1`,
    [bookingId],
  );
  if (!b || b.user_id !== user.id) throw err.notFound();
  // Bước 3: Kiểm tra trạng thái: chỉ lượt đặt sân đã xác nhận ('confirmed') mới có mã check-in.
  if (b.status !== "confirmed") throw err.conflictState("Only a confirmed booking has a check-in code.");
  // Bước 4: Ký token HMAC loại 'booking' gắn với mã lượt đặt sân và trả về cho client.
  return { status: 200, body: signCheckinToken("booking", bookingId) };
}

/** The rotating code shown on the front-desk screen for optional self check-in. */
/**
 * Làm gì: Lấy mã QR xoay vòng hiển thị trên màn hình quầy lễ tân để hội viên tự quét check-in (self check-in).
 * Được gọi ở: GET /api/desk/checkin-qr (src/server/controllers/router.ts qua authedRead).
 * @param sql Kết nối cơ sở dữ liệu ở chế độ chỉ đọc.
 * @param user Tài khoản nhân viên đang truy cập (yêu cầu vai trò receptionist hoặc manager).
 * @returns Phản hồi HTTP 200 chứa trạng thái bật/tắt self-checkin và token mã bàn quầy.
 * @throws err.forbidden nếu người dùng không phải nhân viên lễ tân hoặc quản lý.
 */
export async function deskCheckinCode(sql: Sql, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn nhân viên (receptionist hoặc manager) và đọc cấu hình bật/tắt tự check-in.
  requireRole(user, ["receptionist", "manager"]);
  const settings = await getSettings(sql);
  // Bước 2: Ký token HMAC loại 'desk' đại diện cho bàn lễ tân và trả về cho client.
  return {
    status: 200,
    body: { enabled: settings.self_checkin_enabled, ...signCheckinToken("desk", "front-desk") },
  };
}

/** Member scans the desk code with their own phone. Only when the centre has switched it on. */
/**
 * Làm gì: Xử lý khi hội viên dùng điện thoại cá nhân tự quét mã QR của bàn lễ tân để check-in qua cổng (BR-30).
 * Được gọi ở: POST /api/me/self-checkin (src/server/controllers/router.ts qua authed).
 * @param sql Kết nối cơ sở dữ liệu trong transaction.
 * @param request HTTP Request chứa token bàn quầy do điện thoại quét được.
 * @param user Tài khoản hội viên đang thực hiện (vai trò member).
 * @returns Phản hồi HTTP 200 cho biết được vào (allowed = true) hoặc cần liên hệ quầy (needs_override = true).
 * @throws err.forbidden nếu không phải member; err.conflictState nếu cờ F4 tắt; err.br("BR-30") nếu tính năng chưa bật hoặc quét sai mã.
 */
export async function meSelfCheckin(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hội viên (role = 'member') và kiểm tra cờ tính năng F4.
  requireRole(user, ["member"]);
  await requireFlag(sql, "F4");
  // Bước 2: Kiểm tra trung tâm có bật tính năng tự check-in hay không (BR-30).
  const settings = await getSettings(sql);
  if (!settings.self_checkin_enabled) {
    throw err.br("BR-30", "Self check-in is not switched on — show your code to the front desk.");
  }
  // Bước 3: Xác thực token quét được từ request; bắt buộc phải là token bàn lễ tân (kind = 'desk').
  const t = verifyCheckinToken((await readJson(request)).token);
  if (t.kind !== "desk") throw err.br("BR-30", "That is not the desk code.");
  // Bước 4: Lấy thông tin hội viên và kiểm tra lịch hoạt động trong ngày (đặt sân hoặc buổi học).
  const member = await findMember(sql, { member_id: user.id });
  const today = await memberToday(sql, member.id);
  // Nếu không có lịch hoạt động trong ngày, từ chối tự check-in và hướng dẫn hội viên gặp nhân viên tại quầy.
  if (!today.entitled) {
    return {
      status: 200,
      body: {
        allowed: false,
        needs_override: true,
        warnings: today.warnings,
        message: "Please see the front desk — your membership needs attention.",
      },
    };
  }
  // Bước 5: Ghi nhận lượt vào cổng với phương thức 'self' và trả về kết quả.
  const visit = await recordVisit(sql, { member, method: "self", actorId: user.id });
  return { status: 200, body: { allowed: true, checked_in_at: visit.at, duplicate: visit.duplicate, warnings: today.warnings } };
}
