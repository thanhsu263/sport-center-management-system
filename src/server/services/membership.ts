/**
 * Mục đích file:
 * Quản lý logic nghiệp vụ thẻ hội viên (membership / subscription) của trung tâm thể thao Arena 3.
 * Đảm bảo các quy tắc cốt lõi:
 * - Kiểm tra hạn sử dụng thẻ hội viên để áp dụng giá ưu đãi khi đặt sân (member court fee).
 * - Cổng kiểm soát đăng ký lớp học (quy tắc BR-19): Thẻ hội viên phải có ngày hết hạn sau ngày kết thúc lớp học.
 * - Xử lý phần gia hạn (extension) mua kèm lớp học khi học viên chưa có thẻ hoặc thẻ sắp hết hạn.
 * - Tự động đồng bộ kéo dài hạn thẻ khi lớp học dời lịch kết thúc muộn hơn (carry members).
 * - Hoàn tiền và thu hồi ngày gia hạn (rollback) công bằng khi trung tâm hủy lớp học.
 * - Ngăn chặn đóng băng (freeze) gói tập khi hội viên đang có lớp học chưa hoàn thành.
 *
 * Vị trí trong hệ thống:
 * Nằm trong tầng nghiệp vụ server (services), được gọi bởi các API handlers:
 * - bookings: Tính phí sân hội viên khi đặt sân trực tuyến hoặc giữ chỗ.
 * - classes: Kiểm tra điều kiện ghi danh, áp dụng và hoàn hủy gia hạn thẻ theo lớp học.
 * - desk: Thanh toán và xuất hóa đơn đăng ký lớp học tại quầy lễ tân.
 * - online: Xử lý hóa đơn và thanh toán trực tuyến đăng ký lớp học.
 * - ops: Kiểm tra điều kiện đóng băng thẻ và duyệt đăng ký lớp từ trang quản trị.
 */
import type { Sql } from "@/server/data/db";
import { err } from "../controllers/errors";
import { addDays, ictDateString, roundVnd } from "../../shared/arena3/time";
import { one, q } from "../controllers/tx";

/** The plan row a class-created membership points at when the member has none. */
/**
 * Làm gì: Mã ID cố định của gói tập ngắn hạn nhất (gói 1 tháng) trong hệ thống, dùng làm gói mặc định để gán cho subscription được tạo tự động khi học viên đăng ký lớp học mà chưa có thẻ hội viên.
 * Được gọi ở: src/server/services/membership.ts (hàm applyExtension); src/server/controllers/tx.test.ts (kiểm thử giao dịch).
 */
export const SHORTEST_PLAN_ID = "20000000-0000-0000-0000-000000000051";

/** Whole-thousand dong: the unit prices are quoted in. */
/**
 * Làm gì: Làm tròn số tiền VND đến hàng nghìn gần nhất (chia cho 1.000, làm tròn số học rồi nhân lại 1.000) theo quy ước đơn vị giá niêm yết của trung tâm.
 * Được gọi ở: src/server/services/membership.ts (hàm computeRollback).
 * @param vnd Số tiền VND cần làm tròn.
 * @returns Số tiền VND đã được làm tròn đến hàng nghìn.
 */
export function roundThousand(vnd: number): number {
  return Math.round(vnd / 1000) * 1000;
}

/** Same day n months later; a day the month lacks falls back to its last day (31/01 + 1 = 28/02). */
/**
 * Làm gì: Cộng thêm một số tháng vào ngày dạng YYYY-MM-DD. Nếu tháng kết quả không có ngày tương ứng (ví dụ 31/01 + 1 tháng -> tháng 2), hàm tự động lùi về ngày cuối cùng của tháng đó (28/02 hoặc 29/02).
 * Được gọi ở: src/server/services/membership.ts (hàm planToOutlast); src/server/controllers/handlers/desk.ts; src/server/controllers/handlers/plans.ts; src/server/services/membership.test.ts.
 * @param date Chuỗi ngày bắt đầu theo định dạng ISO YYYY-MM-DD.
 * @param months Số tháng cần cộng thêm (số nguyên dương).
 * @returns Chuỗi ngày sau khi cộng tháng theo định dạng YYYY-MM-DD.
 */
export function addMonths(date: string, months: number): string {
  // Bước 1: Tách chuỗi ngày thành năm, tháng (1-12), ngày và tính tổng số tháng lũy kế từ năm 0
  const [y, m, d] = date.split("-").map(Number);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = total % 12;
  // Bước 2: Tìm ngày cuối cùng của tháng đích bằng UTC để tránh lệch múi giờ; nếu ngày ban đầu vượt quá ngày cuối tháng thì lấy ngày cuối tháng (ví dụ 31/01 -> 28/02)
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const day = Math.min(d, last);
  // Bước 3: Định dạng lại thành chuỗi YYYY-MM-DD với 2 chữ số cho tháng và ngày
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Làm gì: Tính số ngày chênh lệch giữa hai mốc ngày (to - from). Sử dụng mốc 00:00:00 UTC để triệt tiêu ảnh hưởng của chênh lệch múi giờ hay giờ mùa hè (DST).
 * Được gọi ở: src/server/services/membership.ts (hàm computeRollback).
 * @param from Ngày bắt đầu định dạng YYYY-MM-DD.
 * @param to Ngày kết thúc định dạng YYYY-MM-DD.
 * @returns Số ngày chênh lệch giữa hai ngày (86.400.000 ms = 1 ngày).
 */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** A class can be joined only when the membership ends after the class does. */
/**
 * Làm gì: Kiểm tra hạn thẻ hội viên có kéo dài nghiêm ngặt sau ngày kết thúc lớp học hay không (membershipEnd > classEnd). Đây là điều kiện tiên quyết để tham gia lớp học theo quy tắc BR-19.
 * Được gọi ở: src/server/services/membership.ts (hàm planToOutlast, assertMembershipOutlastsClass); src/server/controllers/handlers/classes.ts; src/server/services/membership.test.ts.
 * @param membershipEnd Ngày hết hạn của thẻ hội viên (YYYY-MM-DD), hoặc null nếu chưa có thẻ.
 * @param classEnd Ngày kết thúc của lớp học (YYYY-MM-DD).
 * @returns true nếu thẻ hội viên tồn tại và có hạn kết thúc sau ngày kết thúc lớp học; ngược lại false.
 */
export function outlastsClass(membershipEnd: string | null, classEnd: string): boolean {
  return membershipEnd !== null && membershipEnd > classEnd;
}

/**
 * The cheapest plan that, bought now, ends after the class.
 * `buyFrom` is the date the purchase counts from: the current end, or today with no live membership.
 */
/**
 * Làm gì: Tìm gói tập rẻ nhất trong danh sách gói tập sao cho khi mua từ ngày buyFrom, ngày hết hạn mới sẽ vượt qua ngày kết thúc lớp học. Dùng để gợi ý gói tập phù hợp cho học viên khi đăng ký lớp.
 * Được gọi ở: src/server/controllers/handlers/classes.ts (hàm getClassDetail); src/server/services/membership.test.ts.
 * @param plans Danh sách các gói tập có giá tiền (price_vnd) và thời hạn tháng (duration_months).
 * @param buyFrom Ngày bắt đầu tính hạn gói: ngày hết hạn hiện tại nếu đang có thẻ, hoặc ngày hôm nay nếu chưa có thẻ.
 * @param classEnd Ngày kết thúc lớp học (YYYY-MM-DD).
 * @returns Gói tập có giá thấp nhất thỏa mãn điều kiện thời hạn, hoặc null nếu không có gói nào đủ dài.
 */
export function planToOutlast<P extends { price_vnd: number; duration_months: number | null }>(
  plans: P[],
  buyFrom: string,
  classEnd: string,
): P | null {
  // Bước 1: Lọc các gói có số tháng đủ để kéo dài qua ngày kết thúc lớp học, sau đó sắp xếp tăng dần theo giá tiền để chọn gói rẻ nhất
  const enough = plans
    .filter((p) => p.duration_months && outlastsClass(addMonths(buyFrom, p.duration_months), classEnd))
    .sort((a, b) => a.price_vnd - b.price_vnd);
  // Bước 2: Trả về gói rẻ nhất thỏa mãn, hoặc null nếu không có gói nào đáp ứng
  return enough[0] ?? null;
}

type LiveSub = { id: string; start_on: string; end_on: string; status: string };

/** The member's one live membership; pass lock when about to change it. */
/**
 * Làm gì: Lấy thông tin gói hội viên hiện tại đang hoạt động (active) hoặc tạm dừng (frozen) của người dùng. Cho phép khóa dòng (SELECT FOR UPDATE) để đồng thời bảo vệ dữ liệu khi chuẩn bị cập nhật hạn thẻ trong transaction.
 * Được gọi ở: src/server/services/membership.ts (hàm activeMembershipEnd, applyExtension).
 * @param sql Kết nối database hoặc transaction runner.
 * @param userId ID người dùng cần tra cứu gói hội viên.
 * @param lock Cờ kích hoạt chế độ khóa bi quan 'FOR UPDATE', mặc định false.
 * @returns Thông tin gói hội viên (LiveSub) hoặc null nếu không có gói nào đang active/frozen.
 */
export async function liveMembership(sql: Sql, userId: string, lock = false): Promise<LiveSub | null> {
  // Khóa dòng 'FOR UPDATE' nếu lock=true để tránh race condition khi nhiều giao dịch cùng cập nhật thẻ
  return (
    (await one<LiveSub>(
      sql,
      `select id, start_on::text, end_on::text, status::text from subscriptions
        where user_id = $1 and status in ('active','frozen') limit 1${lock ? " for update" : ""}`,
      [userId],
    )) ?? null
  );
}

/** The active membership covering a play date, if any. A frozen one covers nothing. */
/**
 * Làm gì: Kiểm tra xem người dùng có thẻ hội viên đang active bao phủ ngày chơi chỉ định hay không (start_on <= date <= end_on). Thẻ đang bị đóng băng (frozen) không được tính là bao phủ.
 * Được gọi ở: src/server/services/membership.ts (hàm memberCourtFee).
 * @param sql Kết nối database hoặc transaction runner.
 * @param userId ID người dùng cần kiểm tra.
 * @param date Ngày chơi cần kiểm tra (YYYY-MM-DD).
 * @returns Bản ghi subscription đang active bao trọn ngày đó, hoặc null nếu không có.
 */
export async function coverageOn(sql: Sql, userId: string, date: string): Promise<LiveSub | null> {
  // Chỉ kiểm tra status = 'active' vì thẻ đang đóng băng (frozen) không được hưởng quyền lợi giảm giá khi đặt sân
  return (
    (await one<LiveSub>(
      sql,
      `select id, start_on::text, end_on::text, status::text from subscriptions
        where user_id = $1 and status = 'active' and start_on <= $2::date and end_on >= $2::date limit 1`,
      [userId, date],
    )) ?? null
  );
}

/** The member fee for one slot on that play date, or null when no membership covers it. */
/**
 * Làm gì: Tính phí thuê sân ưu đãi dành riêng cho hội viên cho một slot chơi, dựa trên thời lượng slot và cấu hình giá sân của trung tâm. Trả về null nếu người dùng không có thẻ hội viên active bao phủ ngày chơi.
 * Được gọi ở: src/server/controllers/handlers/bookings.ts; src/server/controllers/handlers/extras.ts; src/server/controllers/handlers/promos.ts.
 * @param sql Kết nối database.
 * @param userId ID người dùng thuê sân.
 * @param start Thời điểm bắt đầu của slot chơi.
 * @param settings Cấu hình giá gồm đơn giá sân/giờ cho hội viên (member_court_fee_vnd), độ dài slot tính bằng phút (slot_minutes), và bước làm tròn tiền (round_vnd).
 * @returns Đối tượng chứa số tiền ưu đãi (fee_vnd) và ngày hết hạn thẻ (end_on), hoặc null nếu không được hưởng ưu đãi.
 */
export async function memberCourtFee(
  sql: Sql,
  userId: string,
  start: Date,
  settings: { member_court_fee_vnd: number; slot_minutes: number; round_vnd: number },
): Promise<{ fee_vnd: number; end_on: string } | null> {
  // Bước 1: Kiểm tra hội viên có thẻ active bao phủ ngày bắt đầu slot chơi hay không (theo giờ Việt Nam ICT)
  const sub = await coverageOn(sql, userId, ictDateString(start));
  if (!sub) return null;
  // Bước 2: Quy đổi giá theo giờ thành giá cho 1 slot (slot_minutes / 60) và làm tròn theo bước cấu hình round_vnd
  return {
    fee_vnd: roundVnd((settings.member_court_fee_vnd * settings.slot_minutes) / 60, settings.round_vnd),
    end_on: sub.end_on,
  };
}

/** The active membership's end, or null. A frozen membership does not qualify. */
/**
 * Làm gì: Lấy ngày kết thúc của thẻ hội viên nếu thẻ đang trong trạng thái 'active' và chưa hết hạn so với hôm nay. Thẻ đang đóng băng (frozen) hoặc đã quá hạn sẽ trả về null.
 * Được gọi ở: src/server/services/membership.ts (hàm assertMembershipOutlastsClass); src/server/controllers/handlers/classes.ts.
 * @param sql Kết nối database.
 * @param userId ID người dùng cần kiểm tra.
 * @returns Ngày kết thúc thẻ (YYYY-MM-DD) nếu hợp lệ, hoặc null.
 */
export async function activeMembershipEnd(sql: Sql, userId: string): Promise<string | null> {
  // Lấy gói hội viên hiện tại; chỉ chấp nhận thẻ active và ngày kết thúc chưa trôi qua so với ngày hiện tại (ICT)
  const live = await liveMembership(sql, userId);
  return live?.status === "active" && live.end_on >= ictDateString() ? live.end_on : null;
}

/** The enrolment gate, used by every path that gives or queues a seat. */
/**
 * Làm gì: Cổng kiểm tra nghiệp vụ bắt buộc (BR-19): yêu cầu thẻ hội viên của người dùng phải có hạn kết thúc sau ngày kết thúc lớp học. Ném ra lỗi nghiệp vụ BR-19 nếu không thỏa mãn.
 * Được gọi ở: src/server/controllers/handlers/classes.ts (ghi danh hoặc đăng ký waitlist lớp học); src/server/controllers/handlers/ops.ts (nhân viên ghi danh cho hội viên).
 * @param sql Kết nối database.
 * @param userId ID người dùng cần ghi danh lớp học.
 * @param classEnd Ngày kết thúc của lớp học (YYYY-MM-DD).
 * @throws err.br("BR-19") nếu người dùng chưa có thẻ hoặc hạn thẻ không kéo dài qua ngày kết thúc lớp.
 */
export async function assertMembershipOutlastsClass(sql: Sql, userId: string, classEnd: string): Promise<void> {
  // Bước 1: Tra cứu ngày hết hạn của thẻ hội viên active hiện tại
  const currentEnd = await activeMembershipEnd(sql, userId);
  // Bước 2: Kiểm tra quy tắc BR-19; nếu thẻ không kéo dài sau ngày kết thúc lớp thì chặn ngay lập tức
  if (!outlastsClass(currentEnd, classEnd)) {
    throw err.br("BR-19", `The membership must end after this class ends (${classEnd}). Buy or extend a plan first.`, {
      class_end: classEnd,
      current_end: currentEnd,
    });
  }
}

/** What is left to collect on a held seat. */
/**
 * Làm gì: Lấy số tiền học phí/phí gia hạn còn phải thu (price_vnd) cho một đơn ghi danh lớp học đang giữ chỗ.
 * Được gọi ở: src/server/controllers/handlers/desk.ts; src/server/controllers/handlers/online.ts.
 * @param sql Kết nối database.
 * @param enrollmentId ID của bản ghi ghi danh (enrollment) cần tra cứu.
 * @returns Số tiền VND cần thu, mặc định 0 nếu không tìm thấy hoặc giá null.
 */
export async function enrollmentAmountDue(sql: Sql, enrollmentId: string): Promise<number> {
  const e = await one<{ price_vnd: number | null }>(sql, `select price_vnd from enrollments where id = $1`, [enrollmentId]);
  return e?.price_vnd ?? 0;
}

/** Runs when a seat is confirmed. Only seats sold before the enrolment gate carry an extension to honour. */
/**
 * Làm gì: Cập nhật thời hạn thẻ hội viên khi đơn ghi danh lớp học được xác nhận thanh toán. Nếu hội viên đang có thẻ active thì kéo dài end_on tới extension_to; nếu chưa có thẻ hoặc thẻ đã hết hạn thì tạo mới subscription trỏ vào SHORTEST_PLAN_ID, đồng thời ghi nhận lịch sử vào bảng membership_extensions.
 * Được gọi ở: src/server/controllers/handlers/classes.ts (sau khi thanh toán ghi danh thành công).
 * @param sql Kết nối database trong transaction thanh toán.
 * @param enrollmentId ID bản ghi ghi danh lớp học vừa được thanh toán xác nhận.
 */
export async function applyExtension(sql: Sql, enrollmentId: string): Promise<void> {
  // Bước 1: Lấy thông tin gia hạn kèm theo đơn ghi danh; nếu không có gia hạn hoặc số tiền <= 0 thì bỏ qua
  const e = await one<{ user_id: string; extension_vnd: number; extension_to: string | null; start_on: string }>(
    sql,
    `select e.user_id, e.extension_vnd, e.extension_to::text, c.start_on::text
       from enrollments e join classes c on c.id = e.class_id where e.id = $1`,
    [enrollmentId],
  );
  if (!e || !e.extension_to || e.extension_vnd <= 0) return;
  // Bước 2: Khóa dòng gói hội viên hiện tại (lock = true) để ngăn ngừa xung đột dữ liệu khi cập nhật hạn thẻ
  const today = ictDateString();
  const live = await liveMembership(sql, e.user_id, true);
  let subId: string;
  let from: string;
  // Bước 3: Nếu đang có thẻ hội viên còn hiệu lực (end_on >= hôm nay), kéo dài ngày kết thúc thẻ tới ngày kết thúc gia hạn nếu cần
  if (live && live.end_on >= today) {
    subId = live.id;
    from = addDays(live.end_on, 1);
    if (live.end_on < e.extension_to) {
      await sql.query(`update subscriptions set end_on = $2 where id = $1`, [live.id, e.extension_to]);
    } else {
      from = e.extension_to; // Another class got there first; the row still records what was paid.
    }
  // Bước 4: Nếu chưa có thẻ hoặc thẻ đã quá hạn, đánh dấu thẻ cũ 'expired' và tạo mới thẻ hội viên active gắn với gói SHORTEST_PLAN_ID
  } else {
    if (live) await sql.query(`update subscriptions set status = 'expired' where id = $1`, [live.id]);
    from = e.start_on > today ? e.start_on : today;
    const created = await one<{ id: string }>(
      sql,
      `insert into subscriptions (user_id, plan_id, start_on, end_on, status, price_vnd)
       values ($1, $2, $3, $4, 'active', 0) returning id`,
      [e.user_id, SHORTEST_PLAN_ID, from, e.extension_to],
    );
    subId = created!.id;
  }
  // Bước 5: Lưu lại vết gia hạn vào bảng membership_extensions phục vụ đối soát và xử lý hoàn tiền nếu lớp bị hủy sau này
  await sql.query(
    `insert into membership_extensions (subscription_id, enrollment_id, from_on, to_on, amount_vnd)
     values ($1, $2, $3, $4, $5)`,
    [subId, enrollmentId, from, e.extension_to, e.extension_vnd],
  );
}

/** Days given back and the refund: only what no other class needs and nobody has used yet. */
/**
 * Làm gì: Tính toán số ngày thẻ hội viên cần thu hồi và số tiền hoàn lại khi hủy gia hạn của một lớp học. Đảm bảo nguyên tắc chỉ thu hồi những ngày mà các lớp học khác không cần và hội viên chưa sử dụng đến.
 * Được gọi ở: src/server/services/membership.ts (hàm rollbackExtension); src/server/services/membership.test.ts.
 * @param args.fromOn Ngày bắt đầu của đợt gia hạn (YYYY-MM-DD).
 * @param args.toOn Ngày kết thúc của đợt gia hạn (YYYY-MM-DD).
 * @param args.amountVnd Số tiền đã thanh toán cho đợt gia hạn này (VNĐ).
 * @param args.otherClassEnd Ngày kết thúc muộn nhất của các lớp học khác mà hội viên đang tham gia, hoặc null nếu không có.
 * @param args.today Ngày hiện tại (YYYY-MM-DD).
 * @param args.dayRate Đơn giá hoàn tiền cho mỗi ngày gia hạn (VNĐ/ngày).
 * @returns Đối tượng chứa số ngày thu hồi (days) và số tiền hoàn trả (refund_vnd).
 */
export function computeRollback(args: {
  fromOn: string;
  toOn: string;
  amountVnd: number;
  otherClassEnd: string | null;
  today: string;
  dayRate: number;
}): { days: number; refund_vnd: number } {
  const { fromOn, toOn, amountVnd, otherClassEnd, today, dayRate } = args;
  // Bước 1: Xác định mốc ngày sàn (keepTo) tối thiểu phải giữ lại: không thu hồi ngày trước đợt gia hạn, ngày đã qua trong quá khứ, hoặc ngày mà lớp học khác vẫn cần
  const floors = [addDays(fromOn, -1), addDays(today, -1)];
  if (otherClassEnd) floors.push(otherClassEnd);
  const keepTo = floors.reduce((a, b) => (a > b ? a : b));
  // Bước 2: Tính số ngày thực tế có thể thu hồi (từ sau keepTo đến toOn); nếu bằng 0 nghĩa là toàn bộ ngày đã được dùng hoặc cần cho lớp khác
  const days = Math.max(0, daysBetween(keepTo, toOn));
  if (days === 0) return { days: 0, refund_vnd: 0 };
  // Bước 3: Tính tiền hoàn: nếu thu hồi trọn vẹn toàn bộ kỳ gia hạn thì hoàn 100% amountVnd, ngược lại nhân theo đơn giá ngày dayRate và làm tròn hàng nghìn (không vượt quá số tiền đã đóng)
  const whole = daysBetween(fromOn, toOn) + 1;
  return { days, refund_vnd: days >= whole ? amountVnd : Math.min(amountVnd, roundThousand(days * dayRate)) };
}

/** The centre cancelled a class: shorten the membership and return the dong to refund. */
/**
 * Làm gì: Xử lý thu hồi gia hạn thẻ hội viên khi lớp học bị hủy. Hàm tính toán số ngày hoàn lại và số tiền tương ứng, cập nhật trạng thái extension thành 'refunded', rút ngắn ngày kết thúc (end_on) của gói tập và chuyển trạng thái sang 'expired' nếu ngày kết thúc mới nằm trong quá khứ.
 * Được gọi ở: src/server/controllers/handlers/classes.ts (hàm cancelClass / createCancelClassRefunds khi trung tâm hủy lớp học).
 * @param sql Kết nối database trong transaction hủy lớp.
 * @param enrollmentId ID bản ghi ghi danh lớp học bị hủy.
 * @param dayRate Đơn giá hoàn trả cho mỗi ngày gia hạn thu hồi (lấy từ cấu hình member_day_rate_vnd).
 * @returns Đối tượng gồm số tiền hoàn trả (refund_vnd), số ngày thu hồi (days) và ngày hết hạn mới của thẻ (new_end).
 */
export async function rollbackExtension(
  sql: Sql,
  enrollmentId: string,
  dayRate: number,
): Promise<{ refund_vnd: number; days: number; new_end: string | null }> {
  const none = { refund_vnd: 0, days: 0, new_end: null };
  // Bước 1: Khóa và đọc bản ghi gia hạn đang active gắn với đơn ghi danh lớp học này
  const ext = await one<{ id: string; subscription_id: string; from_on: string; to_on: string; amount_vnd: number }>(
    sql,
    `select id, subscription_id, from_on::text, to_on::text, amount_vnd from membership_extensions
      where enrollment_id = $1 and status = 'active' for update`,
    [enrollmentId],
  );
  if (!ext) return none;
  // Bước 2: Khóa gói hội viên liên quan và đánh dấu bản ghi gia hạn thành 'refunded'
  const sub = await one<{ user_id: string; end_on: string }>(
    sql,
    `select user_id, end_on::text from subscriptions where id = $1 for update`,
    [ext.subscription_id],
  );
  await sql.query(`update membership_extensions set status = 'refunded' where id = $1`, [ext.id]);
  if (!sub) return none;
  // Bước 3: Tìm ngày kết thúc muộn nhất của các lớp học khác mà hội viên vẫn đang tham gia để tránh thu hồi nhầm ngày họ cần
  const other = await one<{ end_on: string | null }>(
    sql,
    `select max(c.end_on)::text as end_on from enrollments e join classes c on c.id = e.class_id
      where e.user_id = $1 and e.id <> $2 and e.status = 'confirmed' and c.status <> 'cancelled'`,
    [sub.user_id, enrollmentId],
  );
  const today = ictDateString();
  // Bước 4: Tính số ngày và số tiền hoàn dựa trên ngày hiện tại và nhu cầu của các lớp học khác
  const { days, refund_vnd } = computeRollback({
    fromOn: ext.from_on,
    toOn: ext.to_on,
    amountVnd: ext.amount_vnd,
    otherClassEnd: other?.end_on ?? null,
    today,
    dayRate,
  });
  // Bước 5: Cập nhật ngày hết hạn mới (end_on) cho thẻ hội viên; nếu ngày mới trước hôm nay thì chuyển sang trạng thái 'expired'
  if (days === 0) return { ...none, new_end: sub.end_on };
  const newEnd = addDays(sub.end_on, -days);
  await sql.query(
    `update subscriptions
        set end_on = $2::date,
            status = case when $2::date < $3::date then 'expired' else status end
      where id = $1`,
    [ext.subscription_id, newEnd, today],
  );
  return { refund_vnd, days, new_end: newEnd };
}

/** The centre moved a class's last day later: members already enrolled are carried there for free. */
/**
 * Làm gì: Tự động gia hạn miễn phí thẻ hội viên của tất cả học viên đã đăng ký khi trung tâm dời ngày kết thúc lớp học muộn hơn ngày cũ, đảm bảo học viên không bị gián đoạn quyền tham gia lớp theo BR-19.
 * Được gọi ở: src/server/controllers/handlers/classes.ts (hàm rescheduleClass / đổi lịch kết thúc lớp học).
 * @param sql Kết nối database.
 * @param classId ID của lớp học được dời lịch kết thúc.
 * @param newEnd Ngày kết thúc mới của lớp học (YYYY-MM-DD).
 * @returns Số lượng thẻ hội viên đã được tự động cập nhật kéo dài hạn.
 */
export async function carryMembersToClassEnd(sql: Sql, classId: string, newEnd: string): Promise<number> {
  // Cập nhật hàng loạt end_on lên mốc newEnd cho các hội viên đã xác nhận học mà thẻ có end_on nhỏ hơn ngày kết thúc mới
  const rows = await q<{ id: string }>(
    sql,
    `update subscriptions s set end_on = $2::date
       from enrollments e
      where e.class_id = $1 and e.status = 'confirmed' and e.user_id = s.user_id
        and s.status in ('active','frozen') and s.end_on < $2::date
      returning s.id`,
    [classId, newEnd],
  );
  return rows.length;
}

/** A member with a class still ahead cannot pause: the class would outrun the membership. */
/**
 * Làm gì: Kiểm tra xem hội viên có đang tham gia bất kỳ lớp học nào chưa kết thúc (c.end_on >= hôm nay và không bị hủy) hay không. Ngăn hội viên đóng băng thẻ khi lớp đang học vì sẽ vi phạm điều kiện thẻ bao trọn thời gian học.
 * Được gọi ở: src/server/controllers/handlers/ops.ts (hàm freezeMembershipHandler / tạm dừng thẻ hội viên).
 * @param sql Kết nối database.
 * @param userId ID người dùng cần kiểm tra.
 * @returns true nếu người dùng đang có ít nhất một lớp học chưa kết thúc; ngược lại false.
 */
export async function hasRunningClass(sql: Sql, userId: string): Promise<boolean> {
  // Truy vấn kiểm tra tồn tại lớp học mà hội viên đã ghi danh thành công và ngày kết thúc vẫn còn ở tương lai
  const row = await one(
    sql,
    `select 1 from enrollments e join classes c on c.id = e.class_id
      where e.user_id = $1 and e.status = 'confirmed' and c.status <> 'cancelled'
        and c.end_on >= $2::date limit 1`,
    [userId, ictDateString()],
  );
  return !!row;
}

/** Tuition and extension as separate invoice lines; undefined when the payment bought tuition only. */
/**
 * Làm gì: Tách số tiền thanh toán ghi danh lớp học thành hai dòng chi tiết trên hóa đơn: một dòng học phí lớp và một dòng phí gia hạn thẻ hội viên (kèm ngày gia hạn đến). Trả về undefined nếu đơn chỉ thanh toán học phí thuần túy.
 * Được gọi ở: src/server/controllers/handlers/desk.ts (thanh toán tại quầy); src/server/controllers/handlers/online.ts (thanh toán online).
 * @param sql Kết nối database.
 * @param enrollmentId ID bản ghi ghi danh lớp học.
 * @param amountVnd Tổng số tiền khách hàng đã thanh toán (VNĐ).
 * @param item Thông tin mô tả và đơn vị tính của mục học phí lớp học.
 * @returns Mảng các dòng hóa đơn chi tiết, hoặc undefined nếu không có khoản gia hạn hợp lệ.
 */
export async function enrollmentInvoiceLines(
  sql: Sql,
  enrollmentId: string,
  amountVnd: number,
  item: { description: string; unit: string },
): Promise<{ description: string; unit: string; amount_vnd: number }[] | undefined> {
  // Bước 1: Tra cứu khoản tiền và ngày gia hạn đi kèm trong đơn ghi danh
  const e = await one<{ extension_vnd: number; extension_to: string | null }>(
    sql,
    `select extension_vnd, extension_to::text from enrollments where id = $1`,
    [enrollmentId],
  );
  // Bước 2: Nếu không có tiền gia hạn hợp lệ hoặc tiền gia hạn vượt quá tổng thanh toán thì trả về undefined để dùng dòng hóa đơn mặc định
  if (!e || e.extension_vnd <= 0 || !e.extension_to || e.extension_vnd >= amountVnd) return undefined;
  // Bước 3: Tách thành 2 dòng hóa đơn riêng biệt: học phí (tổng tiền - tiền gia hạn) và phí gia hạn hội viên
  const [y, m, d] = e.extension_to.split("-");
  return [
    { description: item.description, unit: item.unit, amount_vnd: amountVnd - e.extension_vnd },
    { description: `Gia hạn hội viên đến ${d}/${m}/${y}`, unit: "lần", amount_vnd: e.extension_vnd },
  ];
}
