/**
 * Quản lý hội viên (members) trong hệ thống Arena 3.
 *
 * File này chứa các controller xử lý toàn bộ nghiệp vụ liên quan đến hội viên:
 * - Tra cứu nhanh hội viên phục vụ quầy lễ tân (desk) và mượn trả dụng cụ.
 * - Đăng ký hội viên mới, kiểm tra trùng số điện thoại và thông tin người giám hộ (vị thành niên).
 * - Xem chi tiết hồ sơ hội viên: gói tập, lịch đặt sân, lớp học, điểm danh, lịch sử thanh toán.
 * - Cập nhật hồ sơ, phân trang danh bạ hội viên và đặt lại mật khẩu tạm thời.
 *
 * Kết nối: Được gọi bởi router API (src/server/controllers/router.ts) qua các hàm bọc giao dịch authed / authedRead.
 */
import type { Sql } from "@/server/data/db";
import { hashPassword } from "../../services/crypto";
import { err } from "../errors";
import { ageYears, audit, getSettings, readJson, str } from "../helpers";
import { isValidVnPhone, normalizePhone, phoneLast9, unaccentVi } from "../../services/phone";
import { PUBLIC_COLS, avatarUrlSql, requireRole, toPublic, withAvatarUrl, type PublicUser } from "../session";
import { one } from "../tx";
import { revoke, tempPassword } from "./staff";
import { getActiveSportCodes } from "./sports";

/**
 * Làm gì: Tìm kiếm nhanh hội viên theo từ khóa (tên không dấu, số điện thoại, mã hội viên)
 *   với độ dài tối thiểu 3 ký tự. Giới hạn tối đa 20 kết quả, phục vụ tra cứu tức thì tại
 *   quầy lễ tân hoặc khi làm thủ tục mượn dụng cụ.
 * Được gọi ở:
 *   - Route: GET /api/members?q=... (src/server/controllers/router.ts)
 *   - Client: src/routes/desk.index.tsx (màn hình quầy lễ tân), src/routes/desk.gear.tsx (mượn dụng cụ)
 *   - Test: src/server/controllers/tx.test.ts (kiểm tra avatar_url khi tìm kiếm)
 * @param sql Kết nối database mở sẵn bởi authedRead trong router.ts.
 * @param request HTTP Request chứa URL query parameter `q` là từ khóa tìm kiếm.
 * @param user Thông tin tài khoản nhân viên đang đăng nhập; yêu cầu quyền manager, receptionist hoặc coach.
 * @returns Object phản hồi { status: 200, body: { items: [...] } } chứa danh sách tối đa 20 hội viên kèm avatar_url.
 * @throws Lỗi 403 (forbidden) nếu người dùng không thuộc các role cho phép.
 */
export async function membersSearch(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra phân quyền — chỉ nhân viên quản lý, lễ tân hoặc huấn luyện viên mới được tra cứu hội viên.
  requireRole(user, ["manager", "receptionist", "coach"]);
  // Bước 2: Lấy tham số tìm kiếm "q" từ URL query string và cắt khoảng trắng thừa.
  const q = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  // Từ khóa dưới 3 ký tự thì trả về danh sách rỗng ngay, tránh quét bảng users với pattern quá rộng gây chậm database.
  if (q.length < 3) return { status: 200, body: { items: [] } };
  // Bước 3: Chuẩn hóa các biến thể tìm kiếm: bỏ dấu tiếng Việt (nq), xóa dấu cách/gạch nối số điện thoại, và tách 9 chữ số cuối.
  const nq = unaccentVi(q);
  const phone = q.replace(/[\s-]/g, "");
  const tail = phoneLast9(q);
  // Bước 4: Truy vấn cơ sở dữ liệu tìm hội viên khớp tên, số điện thoại, mã hội viên hoặc đuôi 9 số (khớp cả +84 và 0). Giới hạn tối đa 20 kết quả.
  const items = await sql.query(
    `select id, member_code, full_name, phone, email, role, status, date_of_birth,
            ${avatarUrlSql("users")}
       from users
      where role = 'member'
        and (
          name_normalized like '%' || $1 || '%'
          or phone like '%' || $2 || '%'
          or coalesce(member_code,'') ilike '%' || $3 || '%'
          or ($4::text is not null and right(phone, 9) = $4)
        )
      order by name_normalized
      limit 20`,
    [nq, phone, q, tail],
  );
  // Bước 5: Bổ sung avatar_url đầy đủ cho từng hội viên và trả về danh sách kết quả.
  return { status: 200, body: { items: items.map(withAvatarUrl) } };
}

/**
 * Làm gì: Đăng ký tài khoản hội viên mới tại quầy lễ tân. Tự động kiểm tra trùng số điện thoại,
 *   xác thực người giám hộ nếu là người vị thành niên, tạo mật khẩu tạm thời ngẫu nhiên
 *   và cấp mã hội viên tự tăng từ sequence database.
 * Được gọi ở:
 *   - Route: POST /api/members (src/server/controllers/router.ts)
 *   - Client: src/routes/desk.index.tsx (hộp thoại tạo hội viên mới khi khách đăng ký tại quầy)
 * @param sql Kết nối database mở sẵn trong giao dịch authed ở router.ts.
 * @param request HTTP Request chứa payload JSON thông tin hội viên (full_name, phone, dob, pii_consent, guardian_name, guardian_phone, email).
 * @param user Thông tin tài khoản nhân viên đang thao tác; yêu cầu quyền receptionist hoặc manager.
 * @returns Object phản hồi:
 *   - HTTP 201 kèm thông tin hội viên mới và temp_password nếu tạo thành công.
 *   - HTTP 200 kèm thông tin hội viên cũ và cờ existing: true nếu số điện thoại đã tồn tại.
 * @throws Lỗi 400 (validation) nếu thiếu họ tên hoặc số điện thoại không hợp lệ theo định dạng Việt Nam.
 * @throws Lỗi BR-04 nếu khách chưa chấp thuận điều khoản bảo vệ dữ liệu cá nhân (pii_consent).
 * @throws Lỗi BR-03 nếu hội viên là người vị thành niên (< minor_age) mà thiếu thông tin người giám hộ.
 * @throws Lỗi 403 (forbidden) nếu người thực hiện không phải receptionist hoặc manager.
 */
export async function membersCreate(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn — chỉ lễ tân (receptionist) hoặc quản lý (manager) mới được tạo hội viên.
  requireRole(user, ["receptionist", "manager"]);
  // Bước 2: Đọc body JSON và chuẩn hóa dữ liệu đầu vào (họ tên, số điện thoại, ngày sinh, đồng ý PII).
  const body = await readJson(request);
  const full_name = str(body.full_name);
  const phone = normalizePhone(str(body.phone) ?? "");
  const dob = str(body.dob) ?? str(body.date_of_birth);
  const pii = body.pii_consent === true;
  // Bước 3: Xác thực các điều kiện bắt buộc: phải có họ tên, số điện thoại VN hợp lệ, và khách phải đồng ý chính sách PII (BR-04).
  if (!full_name) throw err.validation("Full name is required.");
  if (!isValidVnPhone(phone)) throw err.validation("That phone number is not valid.");
  if (!pii) throw err.br("BR-04", "You must accept the terms and the data-privacy notice.");
  // Bước 4: Kiểm tra xem số điện thoại đã tồn tại trong hệ thống chưa.
  const existing = await one<Record<string, unknown>>(
    sql,
    `select ${PUBLIC_COLS}
       from users where phone = $1`,
    [phone],
  );
  // Nếu số điện thoại đã tồn tại, trả về hồ sơ hiện có kèm cờ existing=true để quầy lễ tân xử lý tiếp, tránh tạo trùng tài khoản.
  if (existing) {
    return { status: 200, body: { user: toPublic(existing), existing: true } };
  }
  // Bước 5: Kiểm tra quy tắc bảo vệ người vị thành niên (BR-03): nếu dưới độ tuổi quy định (minor_age), bắt buộc phải có thông tin người giám hộ.
  const settings = await getSettings(sql);
  if (dob && ageYears(dob) < settings.minor_age) {
    if (!str(body.guardian_name) || !str(body.guardian_phone)) {
      throw err.br("BR-03", "A minor needs guardian details.");
    }
  }
  // Bước 6: Tạo mật khẩu tạm thời ngẫu nhiên (dạng A3tmpXXXXa) và lấy mã hội viên tiếp theo từ function next_member_code() trong DB.
  const tmp = `A3tmp${Math.floor(1000 + Math.random() * 9000)}a`;
  const code = await one<{ next_member_code: string }>(sql, `select next_member_code() as next_member_code`);
  // Bước 7: Thêm tài khoản hội viên mới vào bảng users với role 'member', trạng thái 'active', lưu thời điểm đồng ý PII và yêu cầu đổi mật khẩu ở lần đầu đăng nhập.
  const inserted = await one<{ id: string }>(
    sql,
    `insert into users
       (full_name, name_normalized, phone, email, role, status, password_hash,
        date_of_birth, guardian_name, guardian_phone, pii_consent_at, member_code, must_change_password)
     values ($1,$2,$3,$4,'member','active',$5,$6,$7,$8, now(), $9, true)
     returning id`,
    [
      full_name,
      unaccentVi(full_name),
      phone,
      str(body.email) ?? null,
      hashPassword(tmp),
      dob ?? null,
      str(body.guardian_name) ?? null,
      str(body.guardian_phone) ? normalizePhone(String(body.guardian_phone)) : null,
      code?.next_member_code,
    ],
  );
  // Bước 8: Ghi nhật ký kiểm toán (audit log) lưu vết nhân viên đã tạo hồ sơ hội viên này.
  await audit(sql, user.id, "create_member", "user", inserted!.id);
  // Bước 9: Đọc lại toàn bộ thông tin công khai (PUBLIC_COLS) của hội viên vừa tạo.
  const created = await one<Record<string, unknown>>(
    sql,
    `select ${PUBLIC_COLS}
       from users where id = $1`,
    [inserted!.id],
  );
  // Bước 10: Trả về HTTP 201 Created cùng dữ liệu người dùng (toPublic) và mật khẩu tạm thời để quầy lễ tân in/gửi cho hội viên.
  return { status: 201, body: { user: toPublic(created!), temp_password: tmp } };
}

// ─────────────────────────── Types ───────────────────────────

/** Dòng thành viên trả về từ truy vấn PUBLIC_COLS mở rộng thêm created_at và pii_consent_at. */
type MemberGetRawRow = Record<string, unknown> & {
  created_at: string | Date | null;
  pii_consent_at: string | Date | null;
  role: string;
};

/** Thông tin người giám hộ lấy riêng vì không nằm trong PUBLIC_COLS. */
type MemberGetGuardianRow = {
  guardian_name: string | null;
  guardian_phone: string | null;
};

/** Tóm tắt điểm danh 30 ngày gần nhất và lần ghé thăm cuối cùng. */
type MemberGetAttendanceSummary = {
  present: number;
  late: number;
  absent: number;
  excused: number;
  last_visit_at: string | null;
};

// ─────────────────────────── Hàm phụ ───────────────────────────

/**
 * Làm gì: kiểm tra quyền xem hồ sơ. Coach chỉ được xem thành viên mà họ đang/đã dạy —
 *   truy vấn vào bảng enrollments + classes để xác nhận có lớp nào có coach_id hoặc assistant_id
 *   trùng với id của coach đang đăng nhập không.
 * Được gọi ở: memberGet, bước 2.
 * @param sql Kết nối database mở sẵn bởi authedRead trong router.ts.
 * @param memberId Id thành viên lấy từ p1 (tham số đường dẫn) ở router.ts.
 * @param memberRow Dòng thành viên đã đọc ở bước 1; dùng role để bỏ qua kiểm tra khi không phải 'member'.
 * @param viewer Người đang đăng nhập; chỉ kiểm tra khi role là 'coach'.
 * @throws Lỗi 403 "Coaches can only view members in their own classes." khi coach xem thành viên
 *   không học lớp nào của họ.
 */
async function assertCoachCanViewMember(
  sql: Sql,
  memberId: string,
  memberRow: MemberGetRawRow,
  viewer: PublicUser,
): Promise<void> {
  // Chỉ áp dụng quy tắc này khi người xem là coach và hồ sơ đang xem là member.
  const viewerIsCoachAndTargetIsMember =
    viewer.role === "coach" && memberRow.role === "member";
  if (!viewerIsCoachAndTargetIsMember) {
    return;
  }

  const taught = await one(
    sql,
    `select 1 from enrollments e
       join classes c on c.id = e.class_id
      where e.user_id = $1 and (c.coach_id = $2 or c.assistant_id = $2)
      limit 1`,
    [memberId, viewer.id],
  );

  if (!taught) {
    throw err.forbidden("Coaches can only view members in their own classes.");
  }
}

/**
 * Làm gì: truy vấn danh sách gói tập (subscriptions) của thành viên kèm thông tin
 *   khoản phải thu (due_vnd). Trường due_vnd là con số quầy lễ tân cần thu — bằng giá
 *   gói trừ mã giảm giá đã gắn vào đơn chưa thanh toán — để màn hình "Nhận thanh toán"
 *   hiển thị đúng mà không cần tính lại phía client.
 * Được gọi ở: memberGet, bước 3.
 * @param sql Kết nối database mở sẵn bởi authedRead trong router.ts.
 * @param memberId Id thành viên lấy từ p1 (tham số đường dẫn) ở router.ts.
 * @returns Mảng các gói tập, mới nhất (theo end_on) xếp trước.
 */
async function fetchMemberSubscriptions(sql: Sql, memberId: string): Promise<unknown[]> {
  // due_vnd is what "Take payment" has to collect — exactly what POST /payments will accept: the plan
  // price less any code already on an unpaid order, or the full price for a renewal. The desk sends
  // this number rather than working it out, so a code on the order can never make it come out wrong.
  return sql.query(
    `select s.id, s.status, s.start_on::text, s.end_on::text, s.court_hours_left, s.session_left,
            s.frozen_days, p.name as plan_name, p.session_quota as plan_session_quota, coalesce(s.price_vnd, p.price_vnd)::int as price_vnd,
            (coalesce(s.price_vnd, p.price_vnd) - case when s.status::text = 'pending' then coalesce(s.promo_discount_vnd, 0) else 0 end)::int as due_vnd
       from subscriptions s join membership_plans p on p.id = s.plan_id
      where s.user_id = $1 order by s.end_on desc`,
    [memberId],
  );
}

/**
 * Làm gì: lấy tên và số điện thoại người giám hộ. Hai trường này không có trong PUBLIC_COLS
 *   nên phải truy vấn riêng — quầy lễ tân cần chúng để sửa hồ sơ điền sai lúc đăng ký.
 * Được gọi ở: memberGet, bước 3.
 * @param sql Kết nối database mở sẵn bởi authedRead trong router.ts.
 * @param memberId Id thành viên lấy từ p1 (tham số đường dẫn) ở router.ts.
 * @returns Dòng có guardian_name và guardian_phone; cả hai là null nếu chưa điền.
 */
async function fetchMemberGuardian(
  sql: Sql,
  memberId: string,
): Promise<MemberGetGuardianRow | undefined> {
  // Guardian details are not part of the public user shape, but the desk needs
  // them to correct a profile that was filled in wrongly.
  return one<MemberGetGuardianRow>(
    sql,
    `select guardian_name, guardian_phone from users where id = $1`,
    [memberId],
  );
}

/**
 * Làm gì: lấy danh sách các lịch đặt sân hôm nay của thành viên theo giờ Việt Nam.
 *   Lọc theo ngày hôm nay (timezone Asia/Ho_Chi_Minh) để quầy lễ tân thấy được tình huống
 *   hiện tại mà không bị ảnh hưởng bởi các đặt sân cũ hoặc tương lai.
 * Được gọi ở: memberGet, bước 4.
 * @param sql Kết nối database mở sẵn bởi authedRead trong router.ts.
 * @param memberId Id thành viên lấy từ p1 (tham số đường dẫn) ở router.ts.
 * @returns Mảng các lịch đặt sân hôm nay, sắp xếp theo giờ bắt đầu.
 */
async function fetchMemberTodayBookings(sql: Sql, memberId: string): Promise<unknown[]> {
  return sql.query(
    `select b.id, b.code, b.start_at, b.end_at, b.status, b.price_vnd, b.paid_vnd, c.court_code
       from court_bookings b join courts c on c.id = b.court_id
      where b.user_id = $1
        and (b.start_at at time zone 'Asia/Ho_Chi_Minh')::date
            = (now() at time zone 'Asia/Ho_Chi_Minh')::date
      order by b.start_at`,
    [memberId],
  );
}

/**
 * Làm gì: lấy danh sách các buổi học có lịch hôm nay mà thành viên đã đăng ký xác nhận.
 *   Chỉ lấy buổi 'scheduled' để không hiện buổi đã hủy; chỉ lấy enrollment 'confirmed'
 *   vì waitlisted chưa có chỗ chắc chắn.
 * Được gọi ở: memberGet, bước 4.
 * @param sql Kết nối database mở sẵn bởi authedRead trong router.ts.
 * @param memberId Id thành viên lấy từ p1 (tham số đường dẫn) ở router.ts.
 * @returns Mảng các buổi học hôm nay.
 */
async function fetchMemberTodayClasses(sql: Sql, memberId: string): Promise<unknown[]> {
  return sql.query(
    `select s.id, s.start_at, s.end_at, cl.level, cl.sport, ct.court_code
       from sessions s
       join classes cl on cl.id = s.class_id
       join enrollments e on e.class_id = cl.id and e.user_id = $1 and e.status = 'confirmed'
       join courts ct on ct.id = s.court_id
      where s.status = 'scheduled'
        and (s.start_at at time zone 'Asia/Ho_Chi_Minh')::date
            = (now() at time zone 'Asia/Ho_Chi_Minh')::date`,
    [memberId],
  );
}

/**
 * Làm gì: lấy tất cả các lớp thành viên đang đăng ký (confirmed) hoặc đang chờ chỗ (waitlisted),
 *   kèm thứ hạng waitlist và trạng thái ưu đãi nếu có.
 * Được gọi ở: memberGet, bước 5.
 * @param sql Kết nối database mở sẵn bởi authedRead trong router.ts.
 * @param memberId Id thành viên lấy từ p1 (tham số đường dẫn) ở router.ts.
 * @returns Mảng các enrollment, confirmed xếp trước, trong cùng status sắp theo waitlist_pos rồi ngày bắt đầu lớp.
 */
async function fetchMemberEnrollments(sql: Sql, memberId: string): Promise<unknown[]> {
  return sql.query(
    `select e.id, e.class_id, e.status::text as status,
            c.sport::text as sport, c.level, c.rrule, c.duration_min,
            u_coach.full_name as coach_name,
            ct.court_code,
            case when e.status = 'waitlisted' then (
              select count(*) from enrollments w
               where w.class_id = e.class_id and w.status = 'waitlisted' and (w.waitlist_pos, w.id) <= (e.waitlist_pos, e.id)
            ) end as waitlist_pos,
            exists(
              select 1 from waitlist_offers o
               where o.enrollment_id = e.id and o.status = 'pending' and o.expires_at > now()
            ) as offer_pending,
            (select o.expires_at from waitlist_offers o where o.enrollment_id = e.id and o.status = 'pending' and o.expires_at > now() limit 1) as offer_expires_at
       from enrollments e
       join classes c on c.id = e.class_id
       join users u_coach on u_coach.id = c.coach_id
       left join courts ct on ct.id = c.court_id
      where e.user_id = $1 and e.status in ('confirmed', 'waitlisted')
      order by e.status, e.waitlist_pos nulls first, c.start_on`,
    [memberId],
  );
}

/**
 * Làm gì: tính tóm tắt điểm danh 30 ngày gần nhất (present/late/absent/excused) và
 *   thời điểm ghé thăm cuối cùng (tính trên toàn lịch sử, không giới hạn 30 ngày).
 *   Vì sao dùng coalesce(..., 0): đảm bảo trả về số nguyên dù thành viên chưa có
 *   bản ghi điểm danh nào, tránh null phía client phải xử lý thêm.
 * Được gọi ở: memberGet, bước 6.
 * @param sql Kết nối database mở sẵn bởi authedRead trong router.ts.
 * @param memberId Id thành viên lấy từ p1 (tham số đường dẫn) ở router.ts.
 * @returns Object tóm tắt; nếu chưa có bản ghi điểm danh thì các số bằng 0, last_visit_at là null.
 */
async function fetchMemberAttendanceSummary(
  sql: Sql,
  memberId: string,
): Promise<MemberGetAttendanceSummary> {
  const result = await one<MemberGetAttendanceSummary>(
    sql,
    `select
       coalesce(sum(case when kind = 'session' and result = 'present' and at >= now() - interval '30 days' then 1 else 0 end), 0)::int as present,
       coalesce(sum(case when kind = 'session' and result = 'late' and at >= now() - interval '30 days' then 1 else 0 end), 0)::int as late,
       coalesce(sum(case when kind = 'session' and result = 'absent' and at >= now() - interval '30 days' then 1 else 0 end), 0)::int as absent,
       coalesce(sum(case when kind = 'session' and result = 'excused' and at >= now() - interval '30 days' then 1 else 0 end), 0)::int as excused,
       (select max(at)::text from attendance where user_id = $1) as last_visit_at
      from attendance
     where user_id = $1`,
    [memberId],
  );

  // Fallback phòng trường hợp bảng attendance không có hàng nào cho memberId này
  // (one trả null); giữ cấu trúc nhất quán để client không phải kiểm tra null.
  return result ?? { present: 0, late: 0, absent: 0, excused: 0, last_visit_at: null };
}

/**
 * Làm gì: lấy 20 giao dịch thanh toán gần nhất của thành viên kèm số tiền còn hoàn được.
 *   Coach không được xem thông tin tài chính của thành viên — chỉ truy vấn khi người xem
 *   không phải coach, và trả mảng rỗng ngay nếu là coach.
 * Được gọi ở: memberGet, bước 7.
 * @param sql Kết nối database mở sẵn bởi authedRead trong router.ts.
 * @param memberId Id thành viên lấy từ p1 (tham số đường dẫn) ở router.ts.
 * @param viewer Người đang đăng nhập; bỏ qua truy vấn nếu role là 'coach'.
 * @returns Mảng tối đa 20 giao dịch, hoặc mảng rỗng nếu viewer là coach.
 */
async function fetchMemberPaymentsIfAllowed(
  sql: Sql,
  memberId: string,
  viewer: PublicUser,
): Promise<unknown[]> {
  // Coach chỉ được xem lịch học, không được xem thông tin tài chính.
  if (viewer.role === "coach") {
    return [];
  }

  // Lấy tối đa 20 giao dịch gần nhất; tính refundable_vnd dựa trên tổng tiền đã thanh toán (status = 'posted') trừ đi các khoản đang hoặc đã hoàn tiền.
  return sql.query(
    `select p.id, p.code, p.method, p.amount_vnd, p.status, p.created_at,
            p.ref_type, p.ref_id, i.id as invoice_id,
            least(p.amount_vnd, greatest((
              select coalesce(sum(q.amount_vnd) filter (where q.amount_vnd > 0 and q.status = 'posted'), 0)
                   - coalesce(sum(-q.amount_vnd) filter (where q.amount_vnd < 0 and q.status in ('posted','refund_pending')), 0)
                from payments q
               where q.ref_type = p.ref_type and q.ref_id = p.ref_id
            ), 0))::int as refundable_vnd
       from payments p
       left join invoices i on i.payment_id = p.id
      where p.user_id = $1
      order by p.created_at desc
      limit 20`,
    [memberId],
  );
}

/**
 * Làm gì: ghép dữ liệu thành viên từ dòng raw (Record) thành object trả về client.
 *   - created_at được chuẩn hoá thành ISO 8601 (hoặc null).
 *   - pii_consent_at bị ẩn với coach (trả undefined) vì đây là thông tin pháp lý
 *     chỉ quản lý và lễ tân cần thấy để kiểm tra đồng ý chính sách dữ liệu.
 * Được gọi ở: memberGet, bước 8.
 * @param memberRow Dòng raw từ bước 1, có toPublic và hai trường ngày mở rộng.
 * @param viewer Người đang đăng nhập; dùng role để quyết định có trả pii_consent_at không.
 * @returns Object user sẵn sàng để đưa vào body phản hồi.
 */
function buildMemberUserObject(
  memberRow: MemberGetRawRow,
  viewer: PublicUser,
): Record<string, unknown> {
  // Chuẩn hóa created_at sang chuỗi định dạng ISO 8601 để client dễ xử lý hiển thị.
  const createdAtIso = memberRow.created_at
    ? new Date(memberRow.created_at as string | Date).toISOString()
    : null;

  // Coach không được thấy pii_consent_at — dùng undefined để trường này không xuất hiện trong JSON.
  const piiConsentAtIso =
    viewer.role === "coach"
      ? undefined
      : memberRow.pii_consent_at
        ? new Date(memberRow.pii_consent_at as string | Date).toISOString()
        : null;

  return {
    ...toPublic(memberRow),
    created_at: createdAtIso,
    pii_consent_at: piiConsentAtIso,
  };
}

// ─────────────────────────── Hàm chính ───────────────────────────

/**
 * Làm gì: trả về toàn bộ hồ sơ thành viên mà quầy lễ tân cần để phục vụ một người:
 *   thông tin cá nhân, người giám hộ, gói tập, lịch hôm nay, danh sách lớp đăng ký,
 *   điểm danh 30 ngày và lịch sử thanh toán (nếu không phải coach).
 * Được gọi ở:
 *   - Màn hình /desk/member/:id (src/routes/desk.member.$id.tsx), hook useRead<Member>(`/members/${id}`)
 *     tự động gọi khi trang mở, GET /v1/members/:id.
 *   - router.ts dòng 336–337: `if (method === "GET" && p0 === "members" && p1 && !p2)`
 *     → `authedRead((sql, user) => memberH.memberGet(sql, p1, user))`.
 *     authedRead mở transaction read-only, kiểm tra đăng nhập, rồi gọi hàm này.
 * @param sql Kết nối database trong transaction read-only do authedRead mở.
 * @param id Id thành viên lấy từ p1 (đoạn thứ hai của đường dẫn /v1/members/:id).
 * @param user Người đang đăng nhập; phải là manager, receptionist hoặc coach.
 * @returns { status: 200, body: { user, guardian, subscriptions, payments?, today, enrollments, attendance_summary } }.
 *   Trường payments vắng mặt hoàn toàn trong JSON khi viewer là coach (spread điều kiện).
 * @throws Lỗi 403 nếu không đúng vai trò; 404 nếu không tìm thấy thành viên;
 *   403 nếu coach xem thành viên không học lớp của họ.
 */
export async function memberGet(sql: Sql, id: string, user: PublicUser) {
  // Bước 1: chỉ quản lý, lễ tân và coach mới được xem hồ sơ thành viên.
  requireRole(user, ["manager", "receptionist", "coach"]);

  // Bước 2: đọc dòng thành viên; 404 nếu không có, rồi kiểm tra coach có được xem không.
  const memberRow = await one<MemberGetRawRow>(
    sql,
    `select ${PUBLIC_COLS}, created_at, pii_consent_at
       from users where id = $1`,
    [id],
  );
  if (!memberRow) throw err.notFound();
  await assertCoachCanViewMember(sql, id, memberRow, user);

  // Bước 3: gói tập và thông tin người giám hộ.
  const subscriptions = await fetchMemberSubscriptions(sql, id);
  const guardianRow = await fetchMemberGuardian(sql, id);

  // Bước 4: lịch hôm nay — đặt sân và buổi học (timezone Việt Nam).
  const todayBookings = await fetchMemberTodayBookings(sql, id);
  const todayClasses = await fetchMemberTodayClasses(sql, id);

  // Bước 5: tất cả lớp đang đăng ký hoặc đang chờ chỗ.
  const enrollments = await fetchMemberEnrollments(sql, id);

  // Bước 6: tóm tắt điểm danh 30 ngày gần nhất.
  const attendanceSummary = await fetchMemberAttendanceSummary(sql, id);

  // Bước 7: lịch sử thanh toán — bỏ qua nếu người xem là coach.
  const payments = await fetchMemberPaymentsIfAllowed(sql, id, user);

  // Bước 8: ghép object user (chuẩn hoá ngày, ẩn pii với coach) để trả về.
  const userObject = buildMemberUserObject(memberRow, user);

  // Ghép và trả về toàn bộ thông tin hội viên; ẩn lịch sử thanh toán nếu người xem là coach.
  return {
    status: 200,
    body: {
      user: userObject,
      guardian: { name: guardianRow?.guardian_name ?? null, phone: guardianRow?.guardian_phone ?? null },
      subscriptions,
      ...(user.role !== "coach" ? { payments } : {}),
      today: { bookings: todayBookings, classes: todayClasses },
      enrollments,
      attendance_summary: attendanceSummary,
    },
  };
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** Dòng hội viên được đọc và khóa từ DB, dùng làm giá trị "trước chỉnh sửa". */
type MemberUpdateCurrentRow = {
  id: string;
  full_name: string;
  phone: string;
  date_of_birth: string | null;
  guardian_name: string | null;
  guardian_phone: string | null;
  role: string;
};

/**
 * Tập hợp các trường có thể được chỉnh sửa trong một lần gọi membersUpdate.
 * Dùng để so sánh trước/sau và tạo bản ghi audit.
 */
type MemberUpdateFields = {
  full_name: string;
  phone: string;
  date_of_birth: string | null;
  guardian_name: string | null;
  guardian_phone: string | null;
};

// ─── Helper: đọc và khóa dòng hội viên ───────────────────────────────────────

/**
 * Làm gì: Đọc và khóa dòng hội viên trong transaction để tránh cập nhật đồng thời.
 *   Vì sao dùng FOR UPDATE: nếu hai request cùng đổi phone một lúc, cần đảm bảo
 *   kiểm tra trùng phone và ghi DB là nguyên tử.
 * Được gọi ở: membersUpdate, Bước 1.
 * @param sql Kết nối database trong transaction do router mở.
 * @param memberId UUID của hội viên cần đọc.
 * @returns Dòng hội viên hiện tại, hoặc undefined nếu không tồn tại.
 */
async function fetchAndLockMemberForUpdate(
  sql: Sql,
  memberId: string,
): Promise<MemberUpdateCurrentRow | undefined> {
  // Khóa dòng dữ liệu (SELECT ... FOR UPDATE) để đảm bảo không bị xung đột khi nhiều người cùng cập nhật.
  return one<MemberUpdateCurrentRow>(
    sql,
    `select id, full_name, phone, date_of_birth::text as date_of_birth, guardian_name, guardian_phone, role::text as role
       from users where id = $1 for update`,
    [memberId],
  );
}

// ─── Helper: kiểm tra hội viên tồn tại ───────────────────────────────────────

/**
 * Làm gì: Ném lỗi 404 nếu dòng không tồn tại hoặc không phải hội viên.
 *   Vì sao: membersUpdate chỉ được phép sửa tài khoản có role = 'member';
 *   staff hay coach có UUID khác không được sửa qua endpoint này.
 * Được gọi ở: membersUpdate, Bước 2.
 * @param currentRow Kết quả từ fetchAndLockMemberForUpdate.
 * @throws 404 NOT_FOUND nếu currentRow là null hoặc role khác 'member'.
 */
function assertMemberUpdateExists(currentRow: MemberUpdateCurrentRow | undefined): asserts currentRow is MemberUpdateCurrentRow {
  // Chỉ cho phép sửa tài khoản có role là 'member', chặn cập nhật nếu là tài khoản nhân viên hoặc coach.
  if (!currentRow || currentRow.role !== "member") throw err.notFound("No such member.");
}

// ─── Helper: khởi tạo snapshot "sau chỉnh sửa" ───────────────────────────────

/**
 * Làm gì: Tạo bản sao các trường có thể chỉnh sửa từ dòng hiện tại.
 *   Bắt đầu bằng giá trị cũ; các bước parse sẽ ghi đè giá trị mới vào đây.
 *   Vì sao tách ra: giữ currentRow bất biến để so sánh trước/sau trong audit.
 * Được gọi ở: membersUpdate, Bước 3.
 * @param currentRow Dòng hội viên hiện tại vừa đọc từ DB.
 * @returns Snapshot ban đầu bằng đúng giá trị cũ.
 */
function initMemberUpdateNext(currentRow: MemberUpdateCurrentRow): MemberUpdateFields {
  // Tạo bản sao giá trị hiện tại làm mặc định, các trường mới gửi lên sẽ ghi đè lên bản sao này.
  return {
    full_name: currentRow.full_name,
    phone: currentRow.phone,
    date_of_birth: currentRow.date_of_birth,
    guardian_name: currentRow.guardian_name,
    guardian_phone: currentRow.guardian_phone,
  };
}

// ─── Helper: parse và validate full_name ─────────────────────────────────────

/**
 * Làm gì: Nếu body gửi lên full_name, kiểm tra độ dài và cập nhật vào snapshot.
 *   Vì sao giới hạn 120 ký tự: đồng bộ với ràng buộc cột DB và form phía client.
 * Được gọi ở: membersUpdate, Bước 4.
 * @param body Body JSON thô từ request.
 * @param next Snapshot "sau chỉnh sửa" sẽ được ghi đè tại chỗ.
 * @throws 400 field "full_name" nếu giá trị rỗng hoặc quá 120 ký tự.
 */
function applyMemberUpdateFullName(body: Record<string, unknown>, next: MemberUpdateFields): void {
  if (body.full_name === undefined) return;

  // Chuẩn hóa khoảng trắng và kiểm tra họ tên không được để trống, độ dài tối đa 120 ký tự.
  const name = typeof body.full_name === "string" ? body.full_name.trim() : "";
  if (!name) throw err.field("full_name", "Full name is required.");
  if (name.length > 120) throw err.field("full_name", "Full name must be at most 120 characters.");
  next.full_name = name;
}

// ─── Helper: parse và validate phone ─────────────────────────────────────────

/**
 * Làm gì: Nếu body gửi lên phone, kiểm tra định dạng VN và cập nhật vào snapshot.
 *   Vì sao dùng normalizePhone: lưu về dạng chuẩn +84... để tránh trùng phone khi
 *   so sánh sau này (ví dụ 0912... vs +84912...).
 * Được gọi ở: membersUpdate, Bước 5.
 * @param body Body JSON thô từ request.
 * @param next Snapshot "sau chỉnh sửa" sẽ được ghi đè tại chỗ.
 * @throws 400 field "phone" nếu không phải số điện thoại VN hợp lệ.
 */
function applyMemberUpdatePhone(body: Record<string, unknown>, next: MemberUpdateFields): void {
  if (body.phone === undefined) return;

  // Xác thực định dạng số điện thoại Việt Nam hợp lệ và chuẩn hóa về dạng thống nhất (+84...).
  const rawPhone = typeof body.phone === "string" ? body.phone : "";
  if (!isValidVnPhone(rawPhone)) throw err.field("phone", "That phone number is not valid.");
  next.phone = normalizePhone(rawPhone);
}

// ─── Helper: parse và validate date_of_birth ─────────────────────────────────

/**
 * Làm gì: Nếu body gửi lên date_of_birth (hoặc dob), kiểm tra định dạng
 *   YYYY-MM-DD, kiểm tra không ở tương lai, và cập nhật vào snapshot.
 *   null/"" xóa ngày sinh (hội viên không cung cấp).
 *   Vì sao chấp nhận cả "dob": client cũ và client mới dùng tên field khác nhau.
 * Được gọi ở: membersUpdate, Bước 6.
 * @param body Body JSON thô từ request.
 * @param next Snapshot "sau chỉnh sửa" sẽ được ghi đè tại chỗ.
 * @throws 400 field "date_of_birth" nếu định dạng sai hoặc ngày ở tương lai.
 */
function applyMemberUpdateDateOfBirth(body: Record<string, unknown>, next: MemberUpdateFields): void {
  // Chấp nhận cả hai tên field để tương thích với client cũ dùng "dob".
  const dobIn = body.date_of_birth !== undefined ? body.date_of_birth : body.dob;
  if (dobIn === undefined) return;

  // Nếu client truyền null hoặc chuỗi rỗng thì xóa ngày sinh của hội viên.
  if (dobIn === null || dobIn === "") {
    next.date_of_birth = null;
    return;
  }

  // Kiểm tra định dạng ngày sinh YYYY-MM-DD và đảm bảo ngày sinh không nằm ở tương lai.
  const dobString = typeof dobIn === "string" ? dobIn.trim() : "";
  const isValidFormat = /^\d{4}-\d{2}-\d{2}$/.test(dobString) && !Number.isNaN(Date.parse(`${dobString}T00:00:00Z`));
  if (!isValidFormat) throw err.field("date_of_birth", "Date of birth must be a real date (YYYY-MM-DD).");

  // Dùng +07:00 để so sánh đúng ngày theo giờ Việt Nam, tránh off-by-one do UTC.
  const isInFuture = new Date(`${dobString}T00:00:00+07:00`).getTime() > Date.now();
  if (isInFuture) {
    throw err.field("date_of_birth", "Date of birth cannot be in the future.");
  }

  next.date_of_birth = dobString;
}

// ─── Helper: parse và validate guardian_name ─────────────────────────────────

/**
 * Làm gì: Nếu body gửi lên guardian_name, kiểm tra độ dài và cập nhật vào snapshot.
 *   Chuỗi rỗng được coi là "xóa tên người giám hộ" (lưu null).
 * Được gọi ở: membersUpdate, Bước 7.
 * @param body Body JSON thô từ request.
 * @param next Snapshot "sau chỉnh sửa" sẽ được ghi đè tại chỗ.
 * @throws 400 field "guardian_name" nếu tên dài hơn 120 ký tự.
 */
function applyMemberUpdateGuardianName(body: Record<string, unknown>, next: MemberUpdateFields): void {
  if (body.guardian_name === undefined) return;

  // Chuẩn hóa khoảng trắng và kiểm tra độ dài tên người giám hộ không quá 120 ký tự.
  const guardianName = typeof body.guardian_name === "string" ? body.guardian_name.trim() : "";
  if (guardianName.length > 120) throw err.field("guardian_name", "Guardian name must be at most 120 characters.");
  // Rỗng nghĩa là xóa; lưu null thay vì chuỗi rỗng để nhất quán với các trường nullable khác.
  next.guardian_name = guardianName || null;
}

// ─── Helper: parse và validate guardian_phone ────────────────────────────────

/**
 * Làm gì: Nếu body gửi lên guardian_phone, kiểm tra định dạng VN (nếu có) và
 *   cập nhật vào snapshot. Chuỗi rỗng xóa số điện thoại người giám hộ.
 * Được gọi ở: membersUpdate, Bước 8.
 * @param body Body JSON thô từ request.
 * @param next Snapshot "sau chỉnh sửa" sẽ được ghi đè tại chỗ.
 * @throws 400 field "guardian_phone" nếu số không rỗng nhưng không hợp lệ.
 */
function applyMemberUpdateGuardianPhone(body: Record<string, unknown>, next: MemberUpdateFields): void {
  if (body.guardian_phone === undefined) return;

  const rawGuardianPhone = typeof body.guardian_phone === "string" ? body.guardian_phone.trim() : "";
  if (rawGuardianPhone && !isValidVnPhone(rawGuardianPhone)) {
    throw err.field("guardian_phone", "That guardian phone number is not valid.");
  }
  // Rỗng nghĩa là xóa; lưu null thay vì chuỗi rỗng để nhất quán với các trường nullable khác.
  next.guardian_phone = rawGuardianPhone ? normalizePhone(rawGuardianPhone) : null;
}

// ─── Helper: kiểm tra phone không trùng tài khoản khác ───────────────────────

/**
 * Làm gì: Nếu phone thay đổi, truy vấn DB để đảm bảo số đó chưa thuộc tài khoản nào khác.
 *   Vì sao: BR-01 — phone là định danh đăng ký, không được có hai tài khoản cùng số.
 *   Vì sao chỉ kiểm tra khi thay đổi: nếu giữ nguyên số cũ thì không cần truy vấn thêm.
 * Được gọi ở: membersUpdate, Bước 9.
 * @param sql Kết nối database trong transaction do router mở.
 * @param newPhone Số điện thoại mới (đã normalize) từ snapshot.
 * @param currentPhone Số điện thoại hiện tại trong DB.
 * @param memberId UUID của hội viên đang sửa (loại trừ chính họ khi tìm trùng).
 * @throws 400 BR-01 nếu số đã có tài khoản khác dùng.
 */
async function assertMemberUpdatePhoneNotTaken(
  sql: Sql,
  newPhone: string,
  currentPhone: string,
  memberId: string,
): Promise<void> {
  if (newPhone === currentPhone) return;

  const taken = await one(sql, `select 1 as x from users where phone = $1 and id <> $2`, [newPhone, memberId]);
  if (taken) throw err.br("BR-01", "That phone number already has an account.", { field: "phone" });
}

// ─── Helper: kiểm tra hội viên vị thành niên có đủ thông tin giám hộ ─────────

/**
 * Làm gì: Nếu ngày sinh trong snapshot cho thấy hội viên là vị thành niên,
 *   yêu cầu tên và số điện thoại người giám hộ phải có mặt sau khi sửa.
 *   Vì sao: BR-03 — trung tâm không được lưu hồ sơ trẻ vị thành niên mà thiếu
 *   thông tin liên lạc người bảo hộ hợp pháp.
 *   Vì sao dùng settings.minor_age thay vì hằng số: ngưỡng tuổi có thể khác nhau
 *   theo quy định và được cấu hình trong DB.
 * Được gọi ở: membersUpdate, Bước 10.
 * @param sql Kết nối database trong transaction do router mở.
 * @param next Snapshot "sau chỉnh sửa" với ngày sinh và thông tin giám hộ đã cập nhật.
 * @throws 400 BR-03 nếu hội viên là vị thành niên nhưng thiếu tên hoặc số giám hộ.
 */
async function assertMemberUpdateMinorHasGuardian(
  sql: Sql,
  next: MemberUpdateFields,
): Promise<void> {
  if (!next.date_of_birth) return;

  const settings = await getSettings(sql);
  const isMemberMinor = ageYears(next.date_of_birth) < settings.minor_age;
  if (!isMemberMinor) return;

  const isGuardianInfoMissing = !next.guardian_name || !next.guardian_phone;
  if (isGuardianInfoMissing) {
    throw err.br("BR-03", "A minor needs guardian details.", { field: "guardian_name" });
  }
}

// ─── Helper: tính danh sách field thực sự thay đổi ───────────────────────────

/**
 * Làm gì: So sánh từng field giữa currentRow và next để tìm những field thực sự thay đổi.
 *   Vì sao: chỉ ghi DB và audit khi có thay đổi thực sự, tránh ghi thừa và
 *   giữ log audit sạch (chỉ ghi đúng những gì đã sửa).
 * Được gọi ở: membersUpdate, Bước 11.
 * @param currentRow Giá trị trước chỉnh sửa từ DB.
 * @param next Giá trị sau chỉnh sửa từ snapshot.
 * @returns Mảng tên các field có giá trị khác nhau.
 */
function findMemberUpdateChangedFields(
  currentRow: MemberUpdateCurrentRow,
  next: MemberUpdateFields,
): Array<keyof MemberUpdateFields> {
  const allKeys = Object.keys(next) as Array<keyof MemberUpdateFields>;
  return allKeys.filter((fieldName) => next[fieldName] !== currentRow[fieldName]);
}

// ─── Helper: ghi DB và audit nếu có thay đổi ─────────────────────────────────

/**
 * Làm gì: Nếu danh sách field thay đổi không rỗng, cập nhật dòng DB và ghi audit log.
 *   Vì sao ghi cả before lẫn after vào audit: giúp tra cứu lịch sử chỉnh sửa và
 *   hoàn tác nếu cần, không phải đọc snapshot DB từ thời điểm trước.
 *   Vì sao cập nhật name_normalized: cột này dùng để tìm kiếm không dấu, phải đồng bộ
 *   với full_name mỗi khi full_name thay đổi.
 * Được gọi ở: membersUpdate, Bước 12.
 * @param sql Kết nối database trong transaction do router mở.
 * @param memberId UUID của hội viên cần cập nhật.
 * @param currentRow Giá trị trước chỉnh sửa, dùng cho phần "before" của audit.
 * @param next Giá trị sau chỉnh sửa sẽ được ghi vào DB.
 * @param changedFields Danh sách field thực sự thay đổi (từ findMemberUpdateChangedFields).
 * @param actorId UUID của nhân viên thực hiện thao tác, lưu vào audit log.
 */
async function saveMemberUpdateIfChanged(
  sql: Sql,
  memberId: string,
  currentRow: MemberUpdateCurrentRow,
  next: MemberUpdateFields,
  changedFields: Array<keyof MemberUpdateFields>,
  actorId: string,
): Promise<void> {
  if (changedFields.length === 0) return;

  await sql.query(
    `update users
        set full_name = $2, name_normalized = $3, phone = $4,
            date_of_birth = $5, guardian_name = $6, guardian_phone = $7
      where id = $1`,
    [
      memberId,
      next.full_name,
      unaccentVi(next.full_name),
      next.phone,
      next.date_of_birth,
      next.guardian_name,
      next.guardian_phone,
    ],
  );

  // Ghi trạng thái trước và sau theo từng field đã đổi để audit rõ ràng.
  const beforeSnapshot = Object.fromEntries(changedFields.map((fieldName) => [fieldName, currentRow[fieldName]]));
  const afterSnapshot = Object.fromEntries(changedFields.map((fieldName) => [fieldName, next[fieldName]]));
  await audit(sql, actorId, "update_member", "user", memberId, beforeSnapshot, afterSnapshot);
}

// ─── Hàm chính ────────────────────────────────────────────────────────────────

/**
 * Làm gì: Chỉnh sửa hồ sơ hội viên theo yêu cầu của lễ tân hoặc quản lý (B-11 / D-06).
 *   Hội viên hay nhập sai tên, số điện thoại, ngày sinh khi đăng ký và quầy lễ tân
 *   cần có cách hiệu chỉnh. Chỉ bốn trường chính và thông tin giám hộ được phép sửa;
 *   các trường khác trên tài khoản không bị ảnh hưởng.
 *   - Phone đã có tài khoản khác bị từ chối bằng BR-01 — không được gộp im lặng.
 *   - Ngày sinh khiến hội viên là vị thành niên bắt buộc có thông tin giám hộ (BR-03),
 *     kiểm tra dựa trên giá trị sẽ lưu sau khi sửa.
 *   - Audit chỉ ghi đúng những field thực sự thay đổi, cả trước lẫn sau.
 * Được gọi ở:
 *   - Màn hình desk.member.$id.tsx (src/routes/desk.member.$id.tsx), nút "Edit profile"
 *     trong phần hồ sơ hội viên; gọi apiPatch(`/members/${id}`, {...}) khi nhấn Save.
 *   - API: PATCH /v1/members/:id
 *   - src/server/controllers/router.ts dòng 342–344: điều kiện
 *     `method === "PATCH" && p0 === "members" && p1 && !p2` → authed() mở transaction
 *     và xác thực session, sau đó gọi memberH.membersUpdate(sql, p1, request, user).
 * @param sql Kết nối database trong transaction do router mở.
 * @param id UUID của hội viên cần chỉnh sửa, lấy từ path param p1 trong router.
 * @param request Request gốc từ client, chứa body JSON với các field cần sửa.
 * @param user Người dùng đã xác thực (lễ tân hoặc quản lý), lấy từ session trong router.
 * @returns `{ status: 200, body: { ok: true, changed: string[] } }` —
 *   `changed` là danh sách tên field đã thay đổi (rỗng nếu không có gì đổi).
 * @throws 403 FORBIDDEN nếu user không phải receptionist hoặc manager.
 * @throws 404 NOT_FOUND nếu không tìm thấy hội viên hoặc id thuộc tài khoản khác role.
 * @throws 400 field "full_name" nếu tên rỗng hoặc quá 120 ký tự.
 * @throws 400 field "phone" nếu số điện thoại không hợp lệ.
 * @throws 400 field "date_of_birth" nếu định dạng sai hoặc ngày ở tương lai.
 * @throws 400 field "guardian_name" nếu tên giám hộ quá 120 ký tự.
 * @throws 400 field "guardian_phone" nếu số giám hộ không hợp lệ.
 * @throws 400 BR-01 field "phone" nếu số đã có tài khoản khác dùng.
 * @throws 400 BR-03 field "guardian_name" nếu hội viên là vị thành niên nhưng thiếu thông tin giám hộ.
 */
export async function membersUpdate(sql: Sql, id: string, request: Request, user: PublicUser) {
  // Bước 1: kiểm tra quyền — chỉ lễ tân và quản lý được phép sửa hồ sơ.
  requireRole(user, ["receptionist", "manager"]);

  // Bước 2: đọc body JSON từ request để lấy các field cần cập nhật.
  const body = await readJson(request);

  // Bước 3: đọc và khóa dòng hội viên trong DB để tránh race condition khi sửa.
  const currentRow = await fetchAndLockMemberForUpdate(sql, id);

  // Bước 4: đảm bảo hội viên tồn tại và đúng role trước khi làm bất cứ gì.
  assertMemberUpdateExists(currentRow);

  // Bước 5: khởi tạo snapshot "sau chỉnh sửa" bắt đầu từ giá trị cũ.
  const next = initMemberUpdateNext(currentRow);

  // Bước 6: parse và áp dụng full_name mới (nếu có trong request).
  applyMemberUpdateFullName(body, next);

  // Bước 7: parse và áp dụng phone mới (nếu có); chưa kiểm tra trùng ở đây.
  applyMemberUpdatePhone(body, next);

  // Bước 8: parse và áp dụng date_of_birth mới (nếu có); null/"" xóa ngày sinh.
  applyMemberUpdateDateOfBirth(body, next);

  // Bước 9: parse và áp dụng guardian_name mới (nếu có).
  applyMemberUpdateGuardianName(body, next);

  // Bước 10: parse và áp dụng guardian_phone mới (nếu có).
  applyMemberUpdateGuardianPhone(body, next);

  // Bước 11: kiểm tra phone mới chưa thuộc tài khoản khác (BR-01).
  await assertMemberUpdatePhoneNotTaken(sql, next.phone, currentRow.phone, id);

  // Bước 12: kiểm tra nếu hội viên là vị thành niên thì phải có đủ thông tin giám hộ (BR-03).
  await assertMemberUpdateMinorHasGuardian(sql, next);

  // Bước 13: tìm danh sách field thực sự thay đổi để quyết định có ghi DB không.
  const changedFields = findMemberUpdateChangedFields(currentRow, next);

  // Bước 14: ghi DB và audit nếu có thay đổi; bỏ qua nếu không có gì đổi.
  await saveMemberUpdateIfChanged(sql, id, currentRow, next, changedFields, user.id);

  return { status: 200, body: { ok: true, changed: changedFields } };
}

/**
 * The manager's member list (FR-MEM-04): everyone with an account, filtered by
 * status and sport, in name order and paged.
 *
 * A sport matches a member with a confirmed place in a class of that sport or a
 * court booking on a court of that sport. Plans no longer exist, so nothing here reads them.
 */
/**
 * Làm gì: Lấy danh sách danh bạ hội viên có phân trang cho Quản lý (FR-MEM-04).
 *   Hỗ trợ tìm kiếm theo tên, số điện thoại hoặc mã hội viên; lọc theo trạng thái tài khoản và môn thể thao.
 *   Một hội viên khớp với môn thể thao nếu họ có lớp học đã xác nhận hoặc có lượt đặt sân thuộc môn đó.
 * Được gọi ở:
 *   - Màn hình Quản lý hội viên (src/routes/manager.members.tsx dòng 88) qua hook useRead("/directory/members?...").
 *   - Route GET /v1/directory/members trong src/server/controllers/router.ts dòng 327–328.
 *   - Kiểm thử tự động: src/server/controllers/tx.test.ts (chạy với node --test).
 * @param sql Kết nối database trong transaction read-only do router mở qua authedRead.
 * @param request Request từ client chứa query params: q, status, sport, limit, offset.
 * @param user Thông tin người dùng đã xác thực từ session, yêu cầu vai trò manager.
 * @returns Object { status: 200, body: { total, limit, offset, items } } với danh sách hội viên kèm avatar_url.
 * @throws 403 FORBIDDEN nếu user không có vai trò manager.
 * @throws 400 field "status" nếu trạng thái lọc không thuộc active, locked, disabled.
 * @throws 400 field "sport" nếu mã môn thể thao không tồn tại trong danh sách môn đang hoạt động.
 * @throws 400 field limit/offset nếu tham số phân trang không phải số nguyên trong khoảng cho phép.
 */
export async function membersDirectory(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra phân quyền — chỉ Quản lý (manager) mới có quyền xem danh bạ toàn bộ hội viên (FR-MEM-04).
  requireRole(user, ["manager"]);
  // Bước 2: Đọc và xác thực các tham số tìm kiếm, lọc và phân trang từ query string URL.
  const sp = new URL(request.url).searchParams;
  const q = (sp.get("q") ?? "").trim();
  const status = sp.get("status");
  // Chỉ chấp nhận 3 trạng thái tài khoản hợp lệ trong hệ thống: active, locked, disabled.
  if (status && !["active", "locked", "disabled"].includes(status)) throw err.field("status", "Unknown status.");
  const sport = sp.get("sport");
  // Kiểm tra mã môn thể thao theo danh sách môn đang hoạt động từ DB để tránh tìm kiếm với mã môn không tồn tại.
  if (sport && !(await getActiveSportCodes(sql)).includes(sport)) throw err.field("sport", "Unknown sport.");
  /**
   * Làm gì: Đọc và kiểm tra tham số số nguyên từ URL query; trả về fallback nếu để trống.
   * Được gọi ở: membersDirectory (src/server/controllers/handlers/members.ts) để đọc limit và offset.
   * @param name Tên tham số query trong URL.
   * @param fallback Giá trị mặc định khi tham số không xuất hiện trong URL.
   * @param min Giá trị số nguyên nhỏ nhất cho phép.
   * @param max Giá trị số nguyên lớn nhất cho phép.
   * @returns Số nguyên hợp lệ sau khi kiểm tra.
   * @throws 400 field [name] nếu giá trị không phải số nguyên hoặc vượt ngoài khoảng [min, max].
   */
  const intParam = (name: string, fallback: number, min: number, max: number) => {
    const raw = sp.get(name);
    if (raw === null) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw err.field(name, `${name} must be a whole number from ${min} to ${max}.`);
    return n;
  };
  // Giới hạn phân trang an toàn: limit mặc định 25 (tối đa 100 bản ghi/trang), offset tối đa 100.000 để bảo vệ DB.
  const limit = intParam("limit", 25, 1, 100);
  const offset = intParam("offset", 0, 0, 100000);
  // Chuẩn hóa từ khóa tìm kiếm: bỏ dấu tiếng Việt để tìm gần đúng trên cột name_normalized.
  const nq = q ? unaccentVi(q) : null;

  // Bước 3: Truy vấn danh bạ hội viên bằng CTE base kết hợp Window Function count(*) over() để lấy dữ liệu và tổng số dòng trong một lượt.
  // CTE base lọc role = 'member', điều kiện status và tìm kiếm trên tên không dấu, SĐT hoặc member_code; subquery đếm số lớp confirmed.
  // Mệnh đề ngoài lọc theo sport: hội viên có lớp xác nhận thuộc môn đó HOẶC có lượt đặt sân (confirmed, in_use, completed) môn đó.
  const rows = await sql.query(
    `with base as (
       select u.id, u.member_code, u.full_name, u.phone, u.status::text as status, u.created_at,
              u.date_of_birth::text as date_of_birth,
              ${avatarUrlSql("u")},
              u.name_normalized,
              (select count(*) from enrollments e where e.user_id = u.id and e.status = 'confirmed')::int as classes
         from users u
        where u.role = 'member'
          and ($1::text is null or u.status::text = $1)
          and ($2::text is null
               or u.name_normalized like '%' || $2 || '%'
               or u.phone like '%' || $3 || '%'
               or coalesce(u.member_code,'') ilike '%' || $4 || '%')
     )
     select *, count(*) over ()::int as total
       from base
      where ($5::text is null
             or exists (
                  select 1 from enrollments e join classes cl on cl.id = e.class_id
                   where e.user_id = base.id and e.status = 'confirmed' and cl.sport = $5::text)
             or exists (
                  select 1 from court_bookings b join courts c on c.id = b.court_id
                   where b.user_id = base.id and b.status in ('confirmed','in_use','completed') and c.sport = $5::text))
      order by name_normalized, id
      limit $6 offset $7`,
    [status, nq, q.replace(/[\s-]/g, ""), q, sport, limit, offset],
  );
  // Bước 4: Lấy tổng số dòng từ cột total do Window Function tính toán ở dòng đầu tiên (nếu không có kết quả thì total = 0).
  const total = rows.length ? Number(rows[0]!.total) : 0;
  // Bước 5: Trả về HTTP 200 kèm metadata phân trang; loại bỏ các cột kỹ thuật (total, name_normalized) và bổ sung avatar_url qua withAvatarUrl.
  return {
    status: 200,
    body: {
      total,
      limit,
      offset,
      items: rows.map(({ total: _t, name_normalized: _n, ...r }) => withAvatarUrl(r)),
    },
  };
}

/**
 * Front-desk password reset for a member.
 *
 * The self-service route (`/forgot`) mails a code, which is no use to a member
 * with no email on file or no access to it. This is the way back in for them:
 * a one-time temporary password, shown once to the person at the desk, that the
 * member must replace at first sign-in. Every open session is signed out, and
 * the audit row records who did it — never the password itself.
 */
/**
 * Làm gì: Cấp lại mật khẩu tạm thời cho hội viên tại quầy lễ tân (khi hội viên quên mật khẩu hoặc không có email).
 *   Hệ thống sinh mật khẩu ngẫu nhiên dùng một lần, yêu cầu đổi mật khẩu ở lần đăng nhập tiếp theo,
 *   mở khóa tài khoản, thu hồi toàn bộ session đang hoạt động và ghi nhật ký kiểm toán (audit).
 * Được gọi ở:
 *   - Màn hình Lễ tân quản lý hội viên (src/routes/desk.member.$id.tsx dòng 232) khi bấm nút Reset password.
 *   - Route POST /v1/members/:id/reset-password trong src/server/controllers/router.ts dòng 339–340.
 * @param sql Kết nối database trong transaction do router mở qua authed.
 * @param id UUID của hội viên cần reset mật khẩu (lấy từ path param :id).
 * @param user Thông tin nhân viên thực hiện thao tác (lễ tân hoặc quản lý) từ session.
 * @returns Object { status: 200, body: { temp_password, full_name, phone, sessions_revoked } } chứa mật khẩu tạm để nhân viên bàn giao cho hội viên.
 * @throws 403 FORBIDDEN nếu user không phải receptionist hoặc manager.
 * @throws 404 NOT_FOUND nếu không tìm thấy hội viên hoặc tài khoản không phải vai trò member.
 */
export async function memberResetPassword(sql: Sql, id: string, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn — chỉ Lễ tân (receptionist) và Quản lý (manager) mới được phép cấp lại mật khẩu cho hội viên.
  requireRole(user, ["receptionist", "manager"]);
  // Bước 2: Tìm và khóa dòng dữ liệu của hội viên (FOR UPDATE) để đảm bảo không bị cập nhật đồng thời.
  const target = await one<{ id: string; full_name: string; phone: string; role: string }>(
    sql,
    `select id, full_name, phone, role::text as role from users where id = $1 for update`,
    [id],
  );
  // Chỉ cho phép đặt lại mật khẩu cho hội viên; từ chối nếu không tìm thấy hoặc là tài khoản nhân viên (tránh leo thang đặc quyền).
  if (!target || target.role !== "member") throw err.notFound("No such member.");
  // Bước 3: Sinh mật khẩu tạm ngẫu nhiên gồm chữ và số dễ đọc, không chứa ký tự dễ nhầm lẫn.
  const tmp = tempPassword();
  // Bước 4: Băm mật khẩu tạm bằng SHA-256 và cập nhật vào bảng users;
  // Bật cờ must_change_password bắt buộc đổi mật khẩu khi đăng nhập, xóa failed_logins = 0 và mở khóa tài khoản (locked_until = null).
  await sql.query(
    `update users set password_hash = $1, must_change_password = true, failed_logins = 0, locked_until = null
      where id = $2`,
    [hashPassword(tmp), id],
  );
  // Bước 5: Thu hồi (revoke) toàn bộ session đang hoạt động của hội viên để đăng xuất ngay lập tức khỏi mọi thiết bị.
  const revoked = await revoke(sql, id);
  // Bước 6: Ghi nhật ký kiểm toán (audit log) ghi nhận người thực hiện và số phiên bị hủy; tuyệt đối không ghi mật khẩu vào log.
  await audit(sql, user.id, "reset_member_password", "user", id, null, { sessions_revoked: revoked });
  // Bước 7: Trả về HTTP 200 kèm mật khẩu tạm thời để nhân viên thông báo trực tiếp cho hội viên tại quầy.
  return {
    status: 200,
    body: { temp_password: tmp, full_name: target.full_name, phone: target.phone, sessions_revoked: revoked },
  };
}
