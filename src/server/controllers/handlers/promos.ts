/**
 * Promotions — manager CRUD and the "does this code work?" preview (FR-PAY-03, UC-25).
 *
 * Only a manager creates, edits or pauses a code (BR-43). A code that has been
 * used is never deleted, and editing it only changes orders priced afterwards:
 * orders already quoted keep the discount written onto them.
 */
import { memberCourtFee } from "../../services/membership";
import type { Sql } from "@/server/data/db";
import { err } from "../errors";
import { audit, bool, readJson, sqlPatch, str } from "../helpers";
import { lookupPrice } from "../../services/pricing";
import { normalizeCode, quotePromo, type PromoScope } from "../../services/promos";
import { requireRole, type PublicUser } from "../session";
import { getSettings } from "../helpers";
import { one } from "../tx";
import { INT4_MAX, parseInteger } from "../validate";
import { getActiveSportCodes } from "./sports";

// On a class a code lowers the tuition only, never the membership extension.
const SCOPES: PromoScope[] = ["plan", "court", "class"];
const CODE_RE = /^[A-Z0-9_-]{3,24}$/;

/**
 * Làm gì: Kiểm tra một giá trị bất kỳ có bị rỗng hay không (undefined, null hoặc chuỗi chỉ chứa khoảng trắng).
 * Được gọi ở: src/server/controllers/handlers/promos.ts (hàm optInt, optDate, parseBody).
 * @param v Giá trị bất kỳ cần kiểm tra tính rỗng.
 * @returns true nếu giá trị rỗng (undefined, null hoặc chuỗi rỗng), ngược lại false.
 */
function isBlank(v: unknown) {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

/**
 * Làm gì: Parse và xác thực một số nguyên tùy chọn trong khoảng [min, max], trả về null nếu giá trị để trống.
 * Được gọi ở: src/server/controllers/handlers/promos.ts (hàm parseBody).
 * @param field Tên trường dữ liệu dùng để gắn lỗi validation.
 * @param label Tên hiển thị thân thiện của trường để tạo thông báo lỗi.
 * @param v Giá trị đầu vào cần chuyển đổi sang số nguyên.
 * @param min Giá trị nguyên nhỏ nhất cho phép.
 * @param max Giá trị nguyên lớn nhất cho phép.
 * @returns Số nguyên hợp lệ hoặc null nếu bỏ trống.
 * @throws Lỗi 400 nếu giá trị không phải số nguyên hoặc nằm ngoài khoảng [min, max].
 */
function optInt(field: string, label: string, v: unknown, min: number, max: number): number | null {
  return isBlank(v) ? null : parseInteger(field, label, v, min, max);
}

/**
 * Làm gì: Parse và kiểm tra chuỗi ngày giờ tùy chọn, chuyển đổi thành định dạng chuẩn ISO string hoặc null nếu để trống.
 * Được gọi ở: src/server/controllers/handlers/promos.ts (hàm parseBody).
 * @param field Tên trường ngày giờ để gắn lỗi khi không hợp lệ.
 * @param v Chuỗi hoặc giá trị ngày giờ đầu vào cần parse.
 * @returns Chuỗi ISO 8601 hợp lệ của ngày giờ, hoặc null nếu không truyền.
 * @throws Lỗi 400 nếu định dạng ngày giờ không hợp lệ.
 */
function optDate(field: string, v: unknown): string | null {
  if (isBlank(v)) return null;
  const d = new Date(String(v));
  // Kiểm tra tính hợp lệ của mốc thời gian sau khi parse, tránh lưu chuỗi không hợp lệ vào database.
  if (Number.isNaN(d.getTime())) throw err.field(field, "That date is not valid.");
  return d.toISOString();
}

/**
 * Làm gì: Xác thực danh sách phạm vi áp dụng (applies_to) của mã khuyến mãi, loại bỏ trùng lặp và đảm bảo thuộc các phạm vi cho phép ("plan", "court", "class").
 * Được gọi ở: src/server/controllers/handlers/promos.ts (hàm parseBody).
 * @param v Dữ liệu đầu vào của trường applies_to từ request body.
 * @returns Mảng các phạm vi áp dụng hợp lệ đã được chuẩn hóa.
 * @throws Lỗi 400 nếu dữ liệu không phải mảng, mảng rỗng hoặc chứa phạm vi không hợp lệ.
 */
function parseScopes(v: unknown): string[] {
  // Mặc định nếu không truyền applies_to thì áp dụng cho cả gói tập (plan) và đặt sân (court).
  if (v === undefined) return ["plan", "court"];
  if (!Array.isArray(v) || v.length === 0) throw err.field("applies_to", "Pick plans, courts or classes.");
  // Loại bỏ các giá trị trùng lặp trong mảng phạm vi áp dụng.
  const out = [...new Set(v.map(String))];
  for (const s of out) {
    if (!(SCOPES as string[]).includes(s)) throw err.field("applies_to", `"${s}" is not something a code can apply to.`);
  }
  return out;
}

type Parsed = {
  code: string;
  name: string;
  kind: "percent" | "amount";
  value: number;
  max_discount_vnd: number | null;
  min_order_vnd: number;
  starts_at: string | null;
  ends_at: string | null;
  max_uses: number | null;
  max_per_member: number;
  applies_to: string[];
  sport: string | null;
  plan_id: string | null;
  stackable: boolean;
};

/**
 * Làm gì: Parse và xác thực toàn bộ các trường dữ liệu của mã khuyến mãi từ request body, hỗ trợ cả tạo mới đầy đủ lẫn cập nhật một phần.
 * Được gọi ở: src/server/controllers/handlers/promos.ts (hàm promosCreate, promosPatch).
 * @param sql Client kết nối cơ sở dữ liệu để kiểm tra danh sách môn thể thao hợp lệ.
 * @param b Dữ liệu JSON thô nhận từ request body.
 * @param partial true nếu cho phép cập nhật từng phần (PATCH), false nếu bắt buộc kiểm tra đầy đủ khi tạo mới (POST).
 * @returns Đối tượng Partial<Parsed> chứa các trường đã được parse và chuẩn hóa hợp lệ.
 * @throws Lỗi 400 nếu bất kỳ trường nào vi phạm định dạng hoặc giá trị cho phép.
 */
async function parseBody(sql: Sql, b: Record<string, unknown>, partial: boolean): Promise<Partial<Parsed>> {
  const out: Partial<Parsed> = {};
  const has = (k: string) => b[k] !== undefined;
  // Bước 1: Validate mã code (chuẩn hóa chữ hoa, không dấu cách, độ dài từ 3 đến 24 ký tự).
  if (!partial || has("code")) {
    const code = normalizeCode(b.code);
    if (!CODE_RE.test(code)) {
      throw err.field("code", "Use 3–24 letters, digits, - or _ (no spaces).");
    }
    out.code = code;
  }
  // Bước 2: Validate tên chương trình khuyến mãi (bắt buộc nhập, độ dài tối đa 120 ký tự).
  if (!partial || has("name")) {
    const name = str(b.name)?.trim();
    if (!name) throw err.field("name", "Give the code a name.");
    if (name.length > 120) throw err.field("name", "The name must be at most 120 characters.");
    out.name = name;
  }
  // Bước 3: Validate loại giảm giá (chỉ chấp nhận "percent" hoặc "amount") và giá trị giảm.
  if (!partial || has("kind")) {
    const kind = str(b.kind);
    if (kind !== "percent" && kind !== "amount") throw err.field("kind", "Choose percent or fixed amount.");
    out.kind = kind;
  }
  if (!partial || has("value")) {
    out.value = parseInteger("value", "Value", b.value, 1, INT4_MAX);
  }
  // Bước 4: Validate các điều kiện: mức giảm tối đa, đơn hàng tối thiểu, khoảng thời gian hiệu lực và giới hạn lượt dùng.
  if (!partial || has("max_discount_vnd")) out.max_discount_vnd = optInt("max_discount_vnd", "Max discount", b.max_discount_vnd, 1000, INT4_MAX);
  if (!partial || has("min_order_vnd")) out.min_order_vnd = optInt("min_order_vnd", "Minimum order", b.min_order_vnd, 0, INT4_MAX) ?? 0;
  if (!partial || has("starts_at")) out.starts_at = optDate("starts_at", b.starts_at);
  if (!partial || has("ends_at")) out.ends_at = optDate("ends_at", b.ends_at);
  if (!partial || has("max_uses")) out.max_uses = optInt("max_uses", "Total uses", b.max_uses, 1, INT4_MAX);
  if (!partial || has("max_per_member")) out.max_per_member = optInt("max_per_member", "Uses per member", b.max_per_member, 1, 1000) ?? 1;
  // Bước 5: Validate phạm vi áp dụng (applies_to), môn thể thao, gói hội viên liên kết và cờ cho phép cộng dồn (stackable).
  if (!partial || has("applies_to")) out.applies_to = parseScopes(b.applies_to);
  if (!partial || has("sport")) {
    const sport = isBlank(b.sport) ? null : String(b.sport);
    // Truy vấn danh sách môn thể thao đang kích hoạt trong hệ thống để đảm bảo mã hợp lệ; "all" đại diện cho mọi môn.
    const valid = await getActiveSportCodes(sql, true);
    if (sport && !valid.includes(sport)) throw err.field("sport", "Pick a sport or leave it for all.");
    out.sport = sport === "all" ? null : sport;
  }
  if (!partial || has("plan_id")) out.plan_id = isBlank(b.plan_id) ? null : String(b.plan_id);
  if (!partial || has("stackable")) out.stackable = bool(b.stackable) ?? false;
  return out;
}

/**
 * Làm gì: Kiểm tra tính nhất quán logic nghiệp vụ giữa các trường: phần trăm giảm tối đa 100%, số tiền cố định là bội số của 1.000đ (BR-42), và ngày kết thúc phải sau ngày bắt đầu.
 * Được gọi ở: src/server/controllers/handlers/promos.ts (hàm promosCreate, promosPatch).
 * @param p Đối tượng chứa thông tin thời gian bắt đầu và kết thúc của khuyến mãi.
 * @param kind Loại giảm giá ("percent" hoặc "amount").
 * @param value Giá trị giảm giá cần kiểm tra.
 * @throws Lỗi 400 nếu vi phạm ràng buộc về phần trăm, bội số tiền tệ hoặc thứ tự thời gian.
 */
function checkShape(p: Partial<Parsed>, kind: string, value: number) {
  if (kind === "percent" && value > 100) throw err.field("value", "A percentage is at most 100.");
  // Quy tắc BR-42: Số tiền giảm cố định phải là bội số của 1.000 VNĐ để phù hợp với mệnh giá tiền tệ.
  if (kind === "amount" && value % 1000 !== 0) {
    throw err.field("value", "A fixed amount is a multiple of 1,000đ (BR-42).");
  }
  // Đảm bảo thời gian kết thúc chương trình phải diễn ra sau thời gian bắt đầu.
  if (p.starts_at && p.ends_at && new Date(p.ends_at) <= new Date(p.starts_at)) {
    throw err.field("ends_at", "The end must be after the start.");
  }
}

// Mẫu câu truy vấn SQL chuẩn lấy thông tin khuyến mãi: tính trạng thái động (state) theo thời gian thực và tổng hợp lượt dùng, số tiền đã giảm qua subquery lateral.
const SELECT = `
  select p.id, p.code, p.name, p.kind, p.value, p.max_discount_vnd, p.min_order_vnd, p.starts_at, p.ends_at,
         p.max_uses, p.max_per_member, p.applies_to, p.sport::text as sport, p.plan_id, mp.name as plan_name,
         p.stackable, p.status, p.created_at, p.updated_at,
         case
           when p.status = 'paused' then 'paused'
           when p.ends_at is not null and p.ends_at <= now() then 'expired'
           when p.starts_at > now() then 'scheduled'
           when p.max_uses is not null and u.used >= p.max_uses then 'exhausted'
           else 'active'
         end as state,
         coalesce(u.used, 0)::int as used,
         coalesce(u.given, 0)::int as discount_given_vnd
    from promotions p
    left join membership_plans mp on mp.id = p.plan_id
    left join lateral (
      select count(*) filter (where r.status = 'applied') as used,
             coalesce(sum(r.discount_vnd) filter (where r.status = 'applied'), 0) as given
        from promotion_redemptions r where r.promo_id = p.id
    ) u on true`;

/**
 * Làm gì: Lấy danh sách tất cả các mã khuyến mãi trong hệ thống xếp theo thời gian tạo mới nhất, kèm thống kê lượt dùng và số tiền đã chiết khấu.
 * Được gọi ở: src/server/controllers/router.ts (route GET /api/promotions).
 * @param sql Client kết nối cơ sở dữ liệu để thực thi truy vấn.
 * @param user Thông tin người dùng hiện tại từ phiên đăng nhập.
 * @returns Phản hồi HTTP 200 với danh sách khuyến mãi trong thuộc tính items.
 * @throws Lỗi 403 nếu người dùng không phải là manager.
 */
export async function promosList(sql: Sql, user: PublicUser) {
  // Bước 1: Kiểm tra phân quyền — chỉ quản lý (manager) mới có quyền xem danh sách khuyến mãi (BR-43).
  requireRole(user, ["manager"]);
  // Bước 2: Thực thi truy vấn danh sách khuyến mãi kèm thống kê lượt dùng, sắp xếp mới nhất lên đầu.
  const items = await sql.query(`${SELECT} order by p.created_at desc`);
  return { status: 200, body: { items } };
}

/**
 * Làm gì: Tạo mới một mã khuyến mãi trong hệ thống, kiểm tra tính duy nhất của mã, lưu trữ dữ liệu và ghi nhật ký kiểm toán (audit log).
 * Được gọi ở: src/server/controllers/router.ts (route POST /api/promotions).
 * @param sql Client kết nối cơ sở dữ liệu để thực thi truy vấn và thêm bản ghi.
 * @param request Đối tượng Request chứa body dữ liệu của mã khuyến mãi cần tạo.
 * @param user Thông tin người dùng hiện tại thực hiện thao tác.
 * @returns Phản hồi HTTP 201 kèm thông tin chi tiết của mã khuyến mãi vừa tạo trong thuộc tính promo.
 * @throws Lỗi 403 nếu không phải manager, hoặc 400 nếu dữ liệu không hợp lệ hoặc mã code đã tồn tại.
 */
export async function promosCreate(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền manager — chỉ quản lý mới được phép tạo chương trình khuyến mãi (BR-43).
  requireRole(user, ["manager"]);
  // Bước 2: Đọc body JSON, parse và validate đầy đủ các trường thông tin của mã khuyến mãi.
  const p = (await parseBody(sql, await readJson(request), false)) as Parsed;
  checkShape(p, p.kind, p.value);
  // Bước 3: Đảm bảo mã khuyến mãi là duy nhất trong toàn hệ thống (so sánh không phân biệt hoa thường).
  if (await one(sql, `select 1 as ok from promotions where upper(code) = $1`, [p.code])) {
    throw err.field("code", "That code already exists.");
  }
  // Nếu mã giới hạn cho gói hội viên cụ thể, kiểm tra gói hội viên đó có tồn tại trong hệ thống.
  if (p.plan_id && !(await one(sql, `select 1 as ok from membership_plans where id = $1`, [p.plan_id]))) {
    throw err.field("plan_id", "No such plan.");
  }
  // Bước 4: Thêm bản ghi khuyến mãi mới vào bảng promotions; mặc định thời gian bắt đầu là hiện tại nếu không chỉ định.
  const row = await one<{ id: string }>(
    sql,
    `insert into promotions
       (code, name, kind, value, max_discount_vnd, min_order_vnd, starts_at, ends_at, max_uses, max_per_member,
        applies_to, sport, plan_id, stackable, created_by)
     values ($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz, now()),$8,$9,$10,$11,$12,$13,$14,$15)
     returning id`,
    [
      p.code, p.name, p.kind, p.value, p.max_discount_vnd, p.min_order_vnd, p.starts_at, p.ends_at,
      p.max_uses, p.max_per_member, p.applies_to, p.sport, p.plan_id, p.stackable, user.id,
    ],
  );
  // Bước 5: Ghi nhật ký kiểm toán (audit log) để lưu lại lịch sử người quản lý tạo mã khuyến mãi.
  await audit(sql, user.id, "create_promo", "promotion", row!.id, null, { code: p.code });
  // Bước 6: Truy vấn lại đầy đủ dữ liệu khuyến mãi vừa tạo kèm trạng thái tính toán và trả về HTTP 201 Created.
  const promo = await one(sql, `${SELECT} where p.id = $1`, [row!.id]);
  return { status: 201, body: { promo } };
}

/**
 * Làm gì: Cập nhật thông tin hoặc trạng thái (active/paused) của mã khuyến mãi, ngăn đổi tên mã đã từng được sử dụng (BR-43) và ghi log kiểm toán.
 * Được gọi ở: src/server/controllers/router.ts (route PATCH /api/promotions/:id).
 * @param sql Client kết nối cơ sở dữ liệu để thực thi truy vấn và cập nhật.
 * @param id Mã định danh (UUID) của chương trình khuyến mãi cần chỉnh sửa.
 * @param request Đối tượng Request chứa dữ liệu cập nhật từng phần dạng JSON.
 * @param user Thông tin người dùng hiện tại thực hiện thao tác.
 * @returns Phản hồi HTTP 200 kèm thông tin chi tiết của mã khuyến mãi sau khi cập nhật trong thuộc tính promo.
 * @throws Lỗi 403 nếu không phải manager, 404 nếu mã không tồn tại, hoặc 400 nếu vi phạm quy tắc nghiệp vụ BR-43/dữ liệu không hợp lệ.
 */
export async function promosPatch(sql: Sql, id: string, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền manager — chỉ quản lý mới được quyền chỉnh sửa hoặc tạm dừng mã (BR-43).
  requireRole(user, ["manager"]);
  // Bước 2: Truy vấn bản ghi hiện tại và khóa dòng dữ liệu bằng FOR UPDATE để đảm bảo an toàn giao dịch khi cập nhật.
  const cur = await one<{
    id: string;
    code: string;
    kind: string;
    value: number;
    status: string;
    starts_at: string | Date;
    ends_at: string | Date | null;
  }>(
    sql,
    `select id, code, kind, value, status, starts_at, ends_at from promotions where id = $1 for update`,
    [id],
  );
  if (!cur) throw err.notFound("No such code.");
  // Bước 3: Đọc body JSON và parse các trường cần cập nhật theo chế độ partial.
  const b = await readJson(request);
  const p = await parseBody(sql, b, true);
  const status = str(b.status);
  if (status && status !== "active" && status !== "paused") throw err.field("status", "Status is active or paused.");
  // Bước 4: Đếm số lượt mã đã từng được áp dụng trong bảng promotion_redemptions.
  const used = await one<{ n: number }>(sql, `select count(*)::int as n from promotion_redemptions where promo_id = $1`, [id]);
  // Quy tắc BR-43: Mã khuyến mãi đã có lượt sử dụng thì không được phép đổi tên mã; phải tạm dừng mã cũ và tạo mã mới.
  if (p.code && p.code !== cur.code && (used?.n ?? 0) > 0) {
    throw err.br("BR-43", "A code that has been used keeps its name — pause it and create a new one.");
  }
  // Nếu đổi mã code mới, kiểm tra mã mới không bị trùng với các mã khác đã có trong hệ thống.
  if (p.code && p.code !== cur.code && (await one(sql, `select 1 as ok from promotions where upper(code) = $1 and id <> $2`, [p.code, id]))) {
    throw err.field("code", "That code already exists.");
  }
  // Moving only one end of the window must still leave the end after the start.
  // Bước 5: Kiểm tra tính hợp lệ logic giữa ngày bắt đầu, kết thúc và giá trị giảm khi kết hợp giữa giá trị mới và cũ.
  checkShape(
    {
      ...p,
      starts_at: (p.starts_at ?? cur.starts_at) as Parsed["starts_at"],
      ends_at: (p.ends_at === undefined ? cur.ends_at : p.ends_at) as Parsed["ends_at"],
    },
    p.kind ?? cur.kind,
    p.value ?? cur.value,
  );
  // Bước 6: Xây dựng mệnh đề SET động bằng helper sqlPatch cho các trường có thay đổi giá trị.
  const { sets, params: vals, add } = sqlPatch([id]);
  for (const [k, v] of Object.entries(p)) {
    // Không cho phép xóa rỗng starts_at vì mã khuyến mãi bắt buộc phải có thời điểm bắt đầu.
    if (k === "starts_at" && v === null) continue;
    add(k, v, k.endsWith("_at") ? "::timestamptz" : "");
  }
  if (status) add("status", status);
  if (!sets.length) throw err.validation("Nothing to change.");
  sets.push("updated_at = now()");
  // Bước 7: Cập nhật cơ sở dữ liệu với updated_at mới nhất và ghi nhật ký kiểm toán (pause/resume hoặc patch_promo).
  await sql.query(`update promotions set ${sets.join(", ")} where id = $1`, vals);
  await audit(sql, user.id, status && Object.keys(p).length === 0 ? `${status === "paused" ? "pause" : "resume"}_promo` : "patch_promo", "promotion", id, cur, { ...p, status });
  // Bước 8: Truy vấn lại thông tin khuyến mãi sau cập nhật kèm trạng thái động và trả về HTTP 200.
  const promo = await one(sql, `${SELECT} where p.id = $1`, [id]);
  return { status: 200, body: { promo } };
}

/** Per-code redemptions, newest first — what the manager reads to see a campaign working. */
/**
 * Làm gì: Lấy danh sách lịch sử các lượt áp dụng của một mã khuyến mãi cụ thể, sắp xếp mới nhất trước (tối đa 200 bản ghi) để Manager theo dõi hiệu quả chiến dịch.
 * Được gọi ở: src/server/controllers/router.ts (route GET /api/promotions/:id/redemptions).
 * @param sql Client kết nối cơ sở dữ liệu để thực thi truy vấn.
 * @param id Mã định danh (UUID) của chương trình khuyến mãi cần xem lịch sử.
 * @param user Thông tin người dùng hiện tại từ phiên đăng nhập.
 * @returns Phản hồi HTTP 200 với danh sách lượt sử dụng khuyến mãi trong thuộc tính items.
 * @throws Lỗi 403 nếu người dùng không phải là manager.
 */
export async function promosRedemptions(sql: Sql, id: string, user: PublicUser) {
  // Bước 1: Kiểm tra quyền manager — chỉ quản lý mới được xem lịch sử áp dụng mã khuyến mãi.
  requireRole(user, ["manager"]);
  // Bước 2: Truy vấn danh sách lượt sử dụng kèm thông tin hội viên và mã thanh toán liên quan, giới hạn 200 bản ghi mới nhất.
  const items = await sql.query(
    `select r.id, r.status, r.discount_vnd, r.created_at, r.restored_at, u.full_name, u.member_code,
            p.code as payment_code, p.ref_type
       from promotion_redemptions r
       left join users u on u.id = r.user_id
       join payments p on p.id = r.payment_id
      where r.promo_id = $1
      order by r.created_at desc limit 200`,
    [id],
  );
  return { status: 200, body: { items } };
}

/**
 * Preview: what would this code take off this order? Used by the order forms so the
 * price on screen is the price that will be charged. Nothing is written.
 */
/**
 * Làm gì: Xem trước (preview) số tiền giảm giá mà mã khuyến mãi sẽ áp dụng cho một đơn hàng (gói tập, lớp học hoặc đặt sân) mà không ghi dữ liệu vào database.
 * Được gọi ở: src/server/controllers/router.ts (route POST /api/promotions/validate).
 * @param sql Client kết nối cơ sở dữ liệu để tra cứu thông tin giá và tính chiết khấu.
 * @param request Đối tượng Request chứa body gồm code, scope, target user và thông tin đơn hàng tương ứng.
 * @param user Thông tin người dùng hiện tại đang gửi yêu cầu xác thực.
 * @returns Phản hồi HTTP 200 chứa thông tin báo giá chiết khấu gồm discount_vnd, final_vnd và valid = true.
 * @throws Lỗi 400 nếu thiếu mã, phạm vi áp dụng không hợp lệ hoặc mã không thỏa mãn điều kiện đơn hàng.
 */
export async function promosValidate(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Đọc body request, kiểm tra phạm vi áp dụng (scope) và mã khuyến mãi bắt buộc nhập.
  const b = await readJson(request);
  const scope = str(b.scope) as PromoScope | undefined;
  if (!scope || !SCOPES.includes(scope)) throw err.field("scope", "scope must be plan, court or class.");
  const code = str(b.code);
  if (!code) throw err.field("promo_code", "Enter a promo code.");
  // Bước 2: Xác định người hưởng ưu đãi: nhân viên (receptionist/manager) có thể kiểm tra cho khách hàng khác qua user_id.
  const staff = user.role === "receptionist" || user.role === "manager";
  const targetUser = staff && str(b.user_id) ? str(b.user_id)! : user.id;

  // Bước 3: Điều hướng tính toán báo giá chiết khấu theo từng phạm vi nghiệp vụ tương ứng (plan, class hoặc court).
  if (scope === "plan") return quotePlanPromo(sql, b, code, targetUser);
  if (scope === "class") return quoteClassPromo(sql, b, code, targetUser);
  return quoteCourtPromo(sql, b, code, targetUser);
}
/**
 * Làm gì: Tra cứu giá của gói hội viên (membership plan) và tính toán số tiền giảm giá khi áp dụng mã khuyến mãi cho gói đó.
 * Được gọi ở: src/server/controllers/handlers/promos.ts (hàm promosValidate khi scope = "plan").
 * @param sql Client kết nối cơ sở dữ liệu để truy vấn giá gói hội viên và kiểm tra mã.
 * @param b Dữ liệu request chứa plan_id của gói hội viên cần mua.
 * @param code Chuỗi mã khuyến mãi người dùng nhập.
 * @param targetUser ID người dùng được áp dụng mã chiết khấu.
 * @returns Phản hồi HTTP 200 kèm giá gốc (order_vnd) và chi tiết báo giá chiết khấu.
 * @throws Lỗi 400 nếu thiếu plan_id, 404 nếu không tìm thấy gói tập, hoặc lỗi từ quotePromo nếu mã không hợp lệ.
 */
async function quotePlanPromo(sql: Sql, b: Record<string, unknown>, code: string, targetUser: string) {
  const scope = "plan";
  // Bước 1: Kiểm tra và lấy plan_id từ request body.
  const planId = str(b.plan_id);
  if (!planId) throw err.field("plan_id", "plan_id is required.");
  // Bước 2: Truy vấn cơ sở dữ liệu để lấy giá niêm yết (price_vnd) của gói hội viên.
  const plan = await one<{ price_vnd: number }>(
    sql,
    `select price_vnd from membership_plans where id = $1`,
    [planId],
  );
  if (!plan) throw err.notFound("No such plan.");
  // Bước 3: Gọi hàm dịch vụ quotePromo để xác thực tính hợp lệ của mã và tính toán số tiền chiết khấu thực tế.
  const q = await quotePromo(sql, { code, userId: targetUser, scope, sport: "all", planId, orderVnd: plan.price_vnd });
  return { status: 200, body: { valid: true, order_vnd: plan.price_vnd, ...q } };
}

/**
 * Làm gì: Tra cứu học phí và môn thể thao của lớp học, sau đó tính toán số tiền giảm giá của mã khuyến mãi trên học phí lớp học đó.
 * Được gọi ở: src/server/controllers/handlers/promos.ts (hàm promosValidate khi scope = "class").
 * @param sql Client kết nối cơ sở dữ liệu để truy vấn thông tin lớp học và kiểm tra mã.
 * @param b Dữ liệu request chứa class_id của lớp học cần đăng ký.
 * @param code Chuỗi mã khuyến mãi người dùng nhập.
 * @param targetUser ID người dùng được áp dụng mã chiết khấu.
 * @returns Phản hồi HTTP 200 kèm học phí gốc (order_vnd) và chi tiết báo giá chiết khấu.
 * @throws Lỗi 400 nếu thiếu class_id, 404 nếu không tìm thấy lớp học, hoặc lỗi từ quotePromo nếu mã không hợp lệ.
 */
async function quoteClassPromo(sql: Sql, b: Record<string, unknown>, code: string, targetUser: string) {
  const scope = "class";
  // Bước 1: Kiểm tra và lấy class_id từ request body.
  const classId = str(b.class_id);
  if (!classId) throw err.field("class_id", "class_id is required.");
  // Bước 2: Truy vấn thông tin học phí (price_vnd) và môn thể thao của lớp học từ bảng classes.
  const cl = await one<{ price_vnd: number; sport: string }>(
    sql,
    `select price_vnd, sport::text as sport from classes where id = $1`,
    [classId],
  );
  if (!cl) throw err.notFound("No such class.");
  // Bước 3: Tính toán chiết khấu qua quotePromo (mã chỉ giảm trên học phí, không áp dụng cho phí gia hạn hội viên đi kèm).
  const q = await quotePromo(sql, { code, userId: targetUser, scope, sport: cl.sport, orderVnd: cl.price_vnd });
  return { status: 200, body: { valid: true, order_vnd: cl.price_vnd, ...q } };}

/**
 * Làm gì: Tra cứu giá thuê sân theo khung giờ, kiểm tra điều kiện hội viên và tính toán số tiền giảm giá khi áp dụng mã khuyến mãi cho lượt đặt sân.
 * Được gọi ở: src/server/controllers/handlers/promos.ts (hàm promosValidate khi scope = "court").
 * @param sql Client kết nối cơ sở dữ liệu để tra cứu giá sân, cài đặt hệ thống và kiểm tra mã.
 * @param b Dữ liệu request chứa court_id và thời gian bắt đầu thuê sân (start_at).
 * @param code Chuỗi mã khuyến mãi người dùng nhập.
 * @param targetUser ID người dùng đặt sân.
 * @returns Phản hồi HTTP 200 kèm tiền thuê gốc (order_vnd) và chi tiết báo giá chiết khấu.
 * @throws Lỗi 400 nếu thiếu court_id/start_at hoặc thời gian không hợp lệ, 404 nếu sân không tồn tại, hoặc lỗi BR-41 nếu hưởng giá hội viên.
 */
async function quoteCourtPromo(sql: Sql, b: Record<string, unknown>, code: string, targetUser: string) {
  const scope = "court";
  // Bước 1: Kiểm tra các tham số bắt buộc court_id và thời gian bắt đầu start_at.
  const courtId = str(b.court_id);
  const startAt = str(b.start_at);
  if (!courtId || !startAt) throw err.field("court_id", "court_id and start_at are required.");
  // Bước 2: Truy vấn thông tin sân để xác định môn thể thao tương ứng.
  const court = await one<{ sport: string }>(sql, `select sport::text as sport from courts where id = $1`, [courtId]);
  if (!court) throw err.notFound("No such court.");
  // Bước 3: Lấy cấu hình hệ thống và tính giá niêm yết của sân theo khung giờ qua dịch vụ pricing.
  const settings = await getSettings(sql);
  const start = new Date(startAt);
  if (Number.isNaN(start.getTime())) throw err.field("start_at", "That time is not valid.");
  const list = await lookupPrice(sql, { sport: court.sport, courtId, start });
  // Quy tắc BR-41: Khách hàng đang hưởng giá ưu đãi hội viên (member court fee) thì không được áp dụng thêm mã khuyến mãi.
  if (await memberCourtFee(sql, targetUser, start, settings)) {
    throw err.br("BR-41", "The member court fee takes no promo code.");
  }
  // Bước 4: Tính toán chiết khấu đơn đặt sân qua quotePromo và trả về kết quả báo giá xem trước.
  const order = list.price_vnd;
  const q = await quotePromo(sql, { code, userId: targetUser, scope, sport: court.sport, orderVnd: order, listVnd: list.price_vnd });
  return { status: 200, body: { valid: true, order_vnd: order, ...q } };
}
