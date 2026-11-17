/**
 * Controller xử lý các nghiệp vụ liên quan đến gói hội viên (membership plans) và đăng ký gói (subscriptions).
 *
 * Vị trí trong hệ thống:
 * - Cung cấp API công khai/hội viên: xem danh sách các gói tập đang mở bán kèm phí thuê sân ưu đãi (/plans), tự đặt mua gói tập (/subscriptions).
 * - Cung cấp API quầy lễ tân (desk): hỗ trợ lễ tân và quản lý bán gói tập trực tiếp tại quầy hoặc gán gói cho hội viên.
 * - Cung cấp API quản trị cho Quản lý (manager): tạo mới, cập nhật giá/thời hạn, bật/tắt mở bán (BR-16) và xem thống kê số người sở hữu gói (G-05).
 * - Thực thi các quy tắc nghiệp vụ: kiểm soát đóng băng gói (BR-14), dừng bán gói (BR-16), áp dụng mã giảm giá và tính ngày hiệu lực nối tiếp.
 */
import type { Sql } from "@/server/data/db";
import { err } from "../errors";
import { addDays, ictDateString } from "../../../shared/arena3/time";
import { audit, bool, getSettings, readJson, str } from "../helpers";
import { addMonths } from "../../services/membership";
import { quotePromo } from "../../services/promos";
import { limit, RULES } from "../ratelimit";
import { requireRole, type PublicUser } from "../session";
import { one } from "../tx";
import { parseInteger } from "../validate";

/**
 * Làm gì: Lấy danh sách các gói hội viên và phí thuê sân ưu đãi của hội viên (member_court_fee_vnd). Khách và hội viên chỉ thấy các gói đang mở bán (is_on_sale = true), trong khi quản lý (manager) sẽ thấy toàn bộ danh sách gói tập.
 * Được gọi ở:
 * - URL: GET /api/plans hoặc GET /v1/plans
 * - Controller: src/server/controllers/router.ts (dòng 173) trong handler GET /plans.
 * - Frontend: src/routes/app.plans.tsx (trang chọn gói của hội viên), src/routes/desk.index.tsx (quầy lễ tân), src/routes/manager.plans.tsx (quản lý gói tập).
 * @param sql Kết nối database PostgreSQL (đối tượng Sql).
 * @param user Thông tin người dùng hiện tại từ session, hoặc null nếu chưa đăng nhập.
 * @returns Đối tượng chứa status 200 và body gồm items (danh sách gói tập) và member_court_fee_vnd (phí thuê sân của hội viên).
 */
export async function plansList(sql: Sql, user: PublicUser | null) {
  // Bước 1: Xác định phạm vi xem gói tập dựa trên quyền hạn (manager xem được tất cả gói, khách và hội viên chỉ thấy gói đang mở bán).
  const all = user?.role === "manager";
  // Bước 2: Truy vấn danh sách gói tập từ bảng membership_plans, sắp xếp theo giá tăng dần.
  const items = await sql.query(
    `select id, name, duration_months, duration_days, price_vnd, is_on_sale
       from membership_plans
      where $1 or is_on_sale = true
      order by price_vnd`,
    [all],
  );
  // Bước 3: Lấy cấu hình hệ thống để gửi kèm phí thuê sân ưu đãi dành cho hội viên (member_court_fee_vnd).
  const settings = await getSettings(sql);
  // Bước 4: Trả về HTTP 200 kèm danh sách gói tập và thông tin phí sân.
  return {
    status: 200,
    body: {
      items,
      member_court_fee_vnd: settings.member_court_fee_vnd,
    },
  };
}

// Giá trị lớn nhất của số nguyên 4-byte có dấu (INT4 / integer) trong PostgreSQL (2^31 - 1), dùng chặn trên khi parse giá tiền price_vnd tránh lỗi tràn số cột DB.
const INT4 = 2_147_483_647;

/**
 * Làm gì: Chuẩn hóa và kiểm tra độ dài tên gói tập (cắt khoảng trắng, giới hạn tối đa 80 ký tự).
 * Được gọi ở:
 * - src/server/controllers/handlers/plans.ts trong các hàm plansCreate (dòng 43) và plansPatch (dòng 90).
 * @param v Giá trị tên gói tập truyền vào từ request body.
 * @returns Tên gói tập hợp lệ dạng chuỗi hoặc undefined nếu không cung cấp.
 * @throws Lỗi trường dữ liệu 400 (err.field) nếu tên dài quá 80 ký tự.
 */
function planName(v: unknown): string | undefined {
  // Bước 1: Chuyển đổi giá trị sang chuỗi và cắt bỏ khoảng trắng thừa ở hai đầu bằng helper str.
  const name = str(v);
  if (name === undefined) return undefined;
  // Bước 2: Giới hạn độ dài tên gói tối đa 80 ký tự để phù hợp với độ dài cột trong cơ sở dữ liệu và hiển thị giao diện.
  if (name.length > 80) throw err.field("name", "A plan name is at most 80 characters.");
  return name;
}

/**
 * Làm gì: Tạo một gói hội viên mới (chỉ quản lý được thực hiện), tính toán thời hạn theo ngày (duration_days = duration_months * 30) và ghi nhật ký kiểm toán (audit log).
 * Được gọi ở:
 * - URL: POST /api/plans hoặc POST /v1/plans
 * - Controller: src/server/controllers/router.ts (dòng 347) trong handler POST /plans.
 * - Frontend: src/routes/manager.plans.tsx (hàm handleCreate khi submit form tạo gói mới).
 * @param sql Kết nối database trong transaction.
 * @param request HTTP request chứa JSON tạo gói (name, price_vnd, duration_months, is_on_sale).
 * @param user Thông tin người dùng gửi yêu cầu (bắt buộc role 'manager').
 * @returns Đối tượng chứa status 201 và body là bản ghi gói tập vừa tạo trong bảng membership_plans.
 * @throws Lỗi 403 nếu không phải manager; lỗi 400 nếu thiếu tên hoặc dữ liệu số không hợp lệ.
 */
export async function plansCreate(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra phân quyền, chỉ người dùng có vai trò 'manager' mới được phép tạo gói hội viên.
  requireRole(user, ["manager"]);
  // Bước 2: Đọc dữ liệu JSON từ request và kiểm tra tính hợp lệ của các trường dữ liệu.
  const b = await readJson(request);
  const name = planName(b.name);
  if (!name) throw err.field("name", "A plan needs a name.");
  // Giới hạn giá tiền từ 0 đến tối đa INT4 (2,147,483,647 VND) và thời hạn gói từ 1 đến 60 tháng (tối đa 5 năm).
  const price_vnd = parseInteger("price_vnd", "Price", b.price_vnd, 0, INT4);
  const duration_months = parseInteger("duration_months", "Duration", b.duration_months, 1, 60);
  // Bước 3: Thêm gói tập vào bảng membership_plans; tự động quy đổi duration_days = duration_months * 30 ngày.
  const row = await one(
    sql,
    `insert into membership_plans (name, duration_months, duration_days, price_vnd, is_on_sale)
     values ($1, $2, $3, $4, coalesce($5, true))
     returning *`,
    [name, duration_months, duration_months * 30, price_vnd, bool(b.is_on_sale)],
  );
  // Bước 4: Ghi nhật ký kiểm toán (audit log) ghi nhận hành vi tạo gói tập mới của quản lý.
  await audit(sql, user.id, "create_plan", "plan", (row as { id: string }).id);
  // Bước 5: Trả về HTTP 201 cùng dữ liệu gói tập vừa tạo.
  return { status: 201, body: row };
}

/**
 * One plan opened up (G-05): everything the table holds about it, and how many
 * people hold it today — which is what decides whether withdrawing it from sale
 * matters to anyone (it never takes it away from them; BR-16 only stops new
 * orders).
 */
/**
 * Làm gì: Lấy thông tin chi tiết của một gói tập kèm số lượng hội viên đang giữ gói theo từng trạng thái (active, pending, frozen, ever) phục vụ việc đánh giá trước khi dừng bán (G-05, BR-16).
 * Được gọi ở:
 * - URL: GET /api/plans/:id hoặc GET /v1/plans/:id
 * - Controller: src/server/controllers/router.ts (dòng 350) qua authedRead.
 * - Frontend: src/routes/manager.plans.tsx (hàm handleOpenDetail khi quản lý bấm xem chi tiết gói tập).
 * @param sql Kết nối database PostgreSQL.
 * @param id UUID định danh của gói tập cần tra cứu (từ URL path param).
 * @param user Thông tin người dùng gửi yêu cầu (bắt buộc role 'manager').
 * @returns Đối tượng chứa status 200 và body gồm thông tin gói plan cùng thống kê holders.
 * @throws Lỗi 403 nếu không phải manager; lỗi 404 nếu không tìm thấy gói tập.
 */
export async function plansGet(sql: Sql, id: string, user: PublicUser) {
  // Bước 1: Xác thực phân quyền, chỉ quản lý (manager) mới có quyền xem thông tin chi tiết và thống kê gói tập.
  requireRole(user, ["manager"]);
  // Bước 2: Truy vấn thông tin chi tiết gói tập theo id trong bảng membership_plans.
  const plan = await one(
    sql,
    `select id, name, duration_months, duration_days, price_vnd, is_on_sale
       from membership_plans where id = $1`,
    [id],
  );
  // Báo lỗi 404 nếu không tìm thấy gói tập tương ứng với ID được truyền vào.
  if (!plan) throw err.notFound("No such plan.");
  // Bước 3: Thống kê số lượng hội viên đang sở hữu gói theo từng trạng thái (active: đang hoạt động, pending: chờ thanh toán, frozen: đang đóng băng, ever: tổng từ trước đến nay).
  const holders = await one<Record<string, number>>(
    sql,
    `select count(*) filter (where status = 'active')::int as active,
            count(*) filter (where status = 'pending')::int as pending,
            count(*) filter (where status = 'frozen')::int as frozen,
            count(*)::int as ever
       from subscriptions where plan_id = $1`,
    [id],
  );
  // Bước 4: Trả về HTTP 200 kèm thông tin gói tập và dữ liệu thống kê số lượng người sở hữu.
  return { status: 200, body: { plan, holders } };
}

/**
 * Làm gì: Cập nhật thông tin gói tập (tên, thời hạn, giá tiền, trạng thái mở bán) và ghi nhận nhật ký kiểm toán tương ứng với thao tác (put_plan_on_sale, withdraw_plan_from_sale hoặc patch_plan).
 * Được gọi ở:
 * - URL: PATCH /api/plans/:id hoặc PATCH /v1/plans/:id
 * - Controller: src/server/controllers/router.ts (dòng 353) qua authed.
 * - Frontend: src/routes/manager.plans.tsx (hàm handleToggleSale khi bật/tắt bán gói tập).
 * @param sql Kết nối database trong transaction.
 * @param id UUID định danh của gói tập cần chỉnh sửa.
 * @param request HTTP request chứa JSON các trường cần cập nhật (name, duration_months, price_vnd, is_on_sale).
 * @param user Thông tin người dùng gửi yêu cầu (bắt buộc role 'manager').
 * @returns Đối tượng chứa status 200 và body là bản ghi gói tập sau khi cập nhật.
 * @throws Lỗi 403 nếu không phải manager; lỗi 404 nếu không tìm thấy gói; lỗi 400 nếu dữ liệu cập nhật không hợp lệ.
 */
export async function plansPatch(sql: Sql, id: string, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra phân quyền, chỉ 'manager' mới có quyền chỉnh sửa thông tin gói tập.
  requireRole(user, ["manager"]);
  // Bước 2: Đọc dữ liệu JSON từ request và lấy bản ghi hiện tại của gói tập để đối soát snapshot trước khi sửa.
  const b = await readJson(request);
  const cur = await one(sql, `select * from membership_plans where id = $1`, [id]);
  if (!cur) throw err.notFound();
  // Bước 3: Kiểm tra và chuẩn hóa các trường cập nhật; trường nào không truyền lên sẽ giữ nguyên giá trị cũ.
  const name = planName(b.name) ?? null;
  const price = b.price_vnd === undefined ? null : parseInteger("price_vnd", "Price", b.price_vnd, 0, INT4);
  const months = b.duration_months === undefined ? null : parseInteger("duration_months", "Duration", b.duration_months, 1, 60);
  // Bước 4: Cập nhật thông tin gói tập trong bảng membership_plans bằng hàm coalesce; tự động tính lại duration_days = months * 30.
  await sql.query(
    `update membership_plans set
       name = coalesce($2, name),
       duration_months = coalesce($3::int, duration_months),
       duration_days = coalesce($3::int * 30, duration_days),
       price_vnd = coalesce($4, price_vnd),
       is_on_sale = coalesce($5, is_on_sale)
     where id = $1`,
    [id, name, months, price, bool(b.is_on_sale) ?? null],
  );
  // Bước 5: Truy vấn lại bản ghi gói tập sau khi cập nhật để lưu snapshot mới cho audit log.
  const row = await one(sql, `select * from membership_plans where id = $1`, [id]);
  // Bước 6: Ghi nhật ký kiểm toán: phân loại hành động mở bán lại (put_plan_on_sale), ngừng bán (withdraw_plan_from_sale) hay cập nhật chung (patch_plan).
  await audit(
    sql,
    user.id,
    typeof b.is_on_sale === "boolean" && Object.keys(b).length === 1
      ? b.is_on_sale
        ? "put_plan_on_sale"
        : "withdraw_plan_from_sale"
      : "patch_plan",
    "plan",
    id,
    cur,
    row,
  );
  // Bước 7: Trả về HTTP 200 kèm thông tin gói tập mới nhất sau khi cập nhật.
  return { status: 200, body: row };
}

/**
 * Làm gì: Tạo hoặc cập nhật đơn đăng ký gói hội viên ở trạng thái chờ thanh toán (pending). Hỗ trợ hội viên tự đặt mua hoặc nhân viên quầy đăng ký hộ, kiểm tra chống spam (rate limit), áp dụng quy tắc ngừng bán (BR-16), đóng băng (BR-14), nối tiếp thời hạn và áp mã giảm giá (promo code).
 * Được gọi ở:
 * - URL: POST /api/subscriptions hoặc POST /v1/subscriptions
 * - Controller: src/server/controllers/router.ts (dòng 356) qua authed.
 * - Frontend: src/routes/app.plans.tsx (hội viên tự mua gói), src/routes/desk.index.tsx và src/routes/desk.member.$id.tsx (lễ tân gán gói tại quầy).
 * - Test runner: src/server/controllers/tx.test.ts (dòng 5512 trong test case RP-sub-target).
 * @param sql Kết nối database trong transaction.
 * @param request HTTP request chứa JSON đăng ký gói (plan_id, tùy chọn user_id, promo_code).
 * @param user Thông tin người dùng gửi yêu cầu (vai trò 'member', 'receptionist' hoặc 'manager').
 * @returns Đối tượng chứa status 201 và body gồm subscription (đơn đăng ký), preview_end (ngày kết thúc dự kiến), amount_due_vnd (số tiền cần thu) và promo (chi tiết mã giảm giá).
 * @throws Lỗi 401/403 nếu sai quyền; 400 nếu thiếu plan_id hoặc user_id không hợp lệ; 429 nếu vượt giới hạn gửi yêu cầu; 404 nếu không tìm thấy gói; vi phạm BR-16 nếu gói ngừng bán; vi phạm BR-14 nếu gói cũ đang bị đóng băng.
 */
export async function subscriptionsCreate(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra phân quyền, chỉ hội viên hoặc nhân viên quầy (receptionist, manager) mới được phép thực hiện.
  requireRole(user, ["member", "receptionist", "manager"]);
  // Bước 2: Đọc dữ liệu JSON từ request và kiểm tra bắt buộc phải có plan_id.
  const b = await readJson(request);
  const planId = str(b.plan_id);
  if (!planId) throw err.validation("plan_id is required.");
  // Bước 3: Xác định hội viên thụ hưởng gói tập; nếu là nhân viên quầy thì có thể đăng ký hộ cho hội viên khác qua user_id.
  let userId = user.id;
  if (user.role === "receptionist" || user.role === "manager") {
    userId = str(b.user_id) ?? user.id;
    const targetUser = await one<{ role: string; status: string }>(
      sql,
      `select role, status from users where id = $1`,
      [userId],
    );
    if (!targetUser) throw err.field("user_id", "That user does not exist.");
    // Chỉ cấp gói tập cho người dùng có vai trò là hội viên ('member'), không cấp cho tài khoản nhân viên (receptionist, manager, coach).
    if (targetUser.role !== "member") {
      throw err.forbidden("Subscriptions can only be issued to members.");
    }
  }
  // Members only. Staff raise these on behalf of somebody standing at the desk,
  // and a queue of walk-ins legitimately looks like a burst.
  // Bước 4: Áp dụng rate limit đối với hội viên tự thao tác qua ứng dụng để tránh spam yêu cầu hoặc ấn nhầm nút.
  if (user.role === "member") {
    // Short window first: a double-tap or a stuck button is the common case and
    // deserves the cheaper, friendlier message.
    limit(`plan:${user.id}`, RULES.planRequest, "plan requests");
    limit(`plan-h:${user.id}`, RULES.planRequestHourly, "plan requests");
  }
  // Bước 5: Truy vấn thông tin gói tập được chọn từ bảng membership_plans.
  const plan = await one<{
    id: string;
    duration_months: number | null;
    duration_days: number | null;
    price_vnd: number;
    is_on_sale: boolean;
  }>(sql, `select * from membership_plans where id = $1`, [planId]);
  if (!plan) throw err.notFound("No such plan.");
  // Quy tắc BR-16: Hội viên không được mua gói đã ngừng bán; nhân viên quầy vẫn có thể xử lý cho khách nếu cần.
  if (!plan.is_on_sale && user.role === "member") throw err.br("BR-16", "That plan is no longer on sale.");

  // Bước 6: Kiểm tra các gói tập hiện tại của hội viên để xử lý ràng buộc nghiệp vụ và tính thời hạn.
  const today = ictDateString();
  const live = await one<{ status: string; end_on: string }>(
    sql,
    `select status::text, end_on::text from subscriptions
      where user_id = $1 and status in ('active','frozen')
      limit 1`,
    [userId],
  );
  // Quy tắc BR-14: Nếu gói hiện tại đang bị đóng băng (frozen), bắt buộc phải mở đóng băng trước khi mua thêm hoặc gia hạn.
  if (live?.status === "frozen") throw err.br("BR-14", "Your plan is frozen — unfreeze it before buying more.");
  // Kiểm tra xem hội viên đã có đơn đăng ký gói nào đang ở trạng thái chờ thanh toán (pending) hay chưa.
  const pending = await one<{ id: string }>(
    sql,
    `select id from subscriptions where user_id = $1 and status = 'pending'`,
    [userId],
  );
  // Tính ngày hiệu lực: nếu gói cũ còn hạn (end_on >= hôm nay) thì nối tiếp từ end_on; thời hạn mới tính theo tháng (addMonths) hoặc ngày (addDays).
  const start = live && live.end_on >= today ? live.end_on : today;
  const end = plan.duration_months ? addMonths(start, plan.duration_months) : addDays(start, plan.duration_days ?? 30);
  // Bước 7: Tính toán chiết khấu nếu có mã ưu đãi (promo_code) gửi kèm trong yêu cầu.
  // The code is priced into the order now; the use is counted when it is paid (BR-41).
  const promoCode = str(b.promo_code);
  const promo = promoCode
    ? await quotePromo(sql, {
        code: promoCode,
        userId,
        scope: "plan",
        sport: "all",
        planId: plan.id,
        orderVnd: plan.price_vnd,
      })
    : null;
  // Số tiền thực thu bằng giá niêm yết trừ đi số tiền được giảm giá từ mã khuyến mãi.
  const amountDue = plan.price_vnd - (promo?.discount_vnd ?? 0);
  // Bước 8: Ghi nhận đơn đăng ký. Nếu hội viên đã có đơn pending thì tái sử dụng và cập nhật thông tin mới tránh đơn rác.
  if (pending) {
    await sql.query(
      `update subscriptions set plan_id = $2, start_on = $3, end_on = $4,
              court_hours_left = 0, session_left = null, promo_id = $5, promo_discount_vnd = $6,
              price_vnd = $7
        where id = $1`,
      [pending.id, plan.id, start, end, promo?.promo_id ?? null, promo?.discount_vnd ?? 0, plan.price_vnd],
    );
    const row = await one(sql, `select * from subscriptions where id = $1`, [pending.id]);
    return { status: 201, body: { subscription: row, preview_end: end, amount_due_vnd: amountDue, promo } };
  }
  // Nếu chưa có đơn pending, tạo mới bản ghi trong bảng subscriptions với trạng thái 'pending' chờ thanh toán.
  const row = await one(
    sql,
    `insert into subscriptions
       (user_id, plan_id, start_on, end_on, status, court_hours_left, session_left, promo_id, promo_discount_vnd, price_vnd)
     values ($1,$2,$3,$4,'pending',0,null,$5,$6,$7)
     returning *`,
    [userId, plan.id, start, end, promo?.promo_id ?? null, promo?.discount_vnd ?? 0, plan.price_vnd],
  );
  // Bước 9: Trả về HTTP 201 kèm thông tin đơn đăng ký, ngày kết thúc dự kiến, số tiền cần trả và chi tiết mã ưu đãi.
  return { status: 201, body: { subscription: row, preview_end: end, amount_due_vnd: amountDue, promo } };
}
