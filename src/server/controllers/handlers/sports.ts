/**
 * Quản lý danh mục môn thể thao (sports) trong hệ thống trung tâm thể thao.
 * Module này cung cấp các API công khai cho khách xem danh sách môn đang mở,
 * và các API nội bộ cho Manager (tạo môn mới, cập nhật cấu hình, bảng giá mặc định và ảnh đại diện).
 */
import type { Sql } from "@/server/data/db";
import { ApiError, err } from "../errors";
import { audit, num, readJson, str } from "../helpers";
import { limit, RULES } from "../ratelimit";
import { requireRole, type PublicUser } from "../session";
import { one } from "../tx";

const CODE_RE = /^[a-z][a-z0-9_-]{1,23}$/;
const PREFIX_RE = /^[A-Z]{2}$/;
/**
 * Làm gì: Danh sách mã màu chủ đề hợp lệ được phép gán cho môn thể thao để chuẩn hóa giao diện.
 * Được gọi ở: parseSportColorKey, managerSportPatch (src/server/controllers/handlers/sports.ts)
 */
export const ALLOWED_COLOR_KEYS = ["leaf", "clay", "sky", "plum", "sun", "slate", "moss", "dune"] as const;

export type SportRow = {
  code: string;
  name_en: string;
  name_vi: string;
  court_prefix: string | null;
  color_key: string;
  glyph_key: string;
  is_scope_all: boolean;
  max_players: number;
  slot_duration_min: number;
  sort_order: number;
  enabled: boolean;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Làm gì: Lấy danh sách các môn thể thao đang hoạt động để hiển thị công khai cho khách và học viên.
 *   Chỉ lấy các môn enabled = true, chưa giải thể (retired_at is null) và bỏ qua môn phạm vi chung ('all').
 * Được gọi ở: GET /v1/sports (src/server/controllers/router.ts: publicSportsList)
 * @param sql Kết nối cơ sở dữ liệu để thực thi truy vấn.
 * @returns Đối tượng HTTP response chứa status 200 và danh sách môn thể thao kèm photo_url.
 */
export async function publicSportsList(sql: Sql) {
  // Bước 1: Truy vấn danh sách môn đang hoạt động, tạo sẵn đường dẫn photo_url theo mã code
  const items = await sql.query<SportRow & { photo_url: string }>(
    `select s.code, s.name_en, s.name_vi, s.court_prefix, s.color_key, s.glyph_key,
            s.is_scope_all, s.max_players, s.slot_duration_min, s.sort_order, s.enabled,
            s.retired_at, s.created_at, s.updated_at,
            concat('/v1/site-assets/sport.', s.code, '/file') as photo_url
       from sports s
      where not s.is_scope_all and s.enabled = true and s.retired_at is null
      order by s.sort_order asc, s.code asc`,
  );
  // Bước 2: Trả về kết quả HTTP 200 kèm danh sách môn thể thao
  return { status: 200, body: { items } };
}

/**
 * Làm gì: Lấy danh sách toàn bộ môn thể thao dành cho người quản lý, kèm các số liệu thống kê:
 *   số sân sẵn sàng, số lượt đặt sân trong tương lai và số lớp học sắp diễn ra.
 * Được gọi ở: GET /v1/manager/sports (src/server/controllers/router.ts: managerSportsList)
 * @param sql Kết nối cơ sở dữ liệu để thực thi truy vấn.
 * @param user Thông tin người dùng đăng nhập, bắt buộc có vai trò 'manager'.
 * @returns Đối tượng HTTP response chứa status 200 và danh sách môn thể thao kèm thống kê active_courts_count, future_bookings_count, future_classes_count.
 * @throws Lỗi 403 nếu tài khoản không có vai trò manager.
 */
export async function managerSportsList(sql: Sql, user: PublicUser) {
  // Bước 1: Kiểm tra quyền hạn (bắt buộc vai trò 'manager' mới được truy cập dữ liệu quản trị)
  requireRole(user, ["manager"]);

  // Bước 2: Truy vấn danh sách môn kèm thống kê:
  // - active_courts_count: số sân đang sẵn sàng ('ready') và chưa bị xóa (retired_at is null)
  // - future_bookings_count: số lượt đặt sân trong tương lai (start_at > now())
  // - future_classes_count: số lớp học đang mở và chưa kết thúc (status = 'open', end_on >= current_date)
  const items = await sql.query<
    SportRow & {
      active_courts_count: number;
      future_bookings_count: number;
      future_classes_count: number;
      photo_url: string;
    }
  >(
    `select s.code, s.name_en, s.name_vi, s.court_prefix, s.color_key, s.glyph_key,
            s.is_scope_all, s.max_players, s.slot_duration_min, s.sort_order, s.enabled,
            s.retired_at, s.created_at, s.updated_at,
            concat('/v1/site-assets/sport.', s.code, '/file') as photo_url,
            coalesce(c.courts_count, 0)::int as active_courts_count,
            coalesce(b.bookings_count, 0)::int as future_bookings_count,
            coalesce(cl.classes_count, 0)::int as future_classes_count
       from sports s
       left join (
         select sport, count(*)::int as courts_count
           from courts
          where status = 'ready' and retired_at is null
          group by sport
       ) c on c.sport = s.code
       left join (
         select ct.sport, count(*)::int as bookings_count
           from occupancies o
           join courts ct on ct.id = o.court_id
          where o.kind = 'booking' and o.start_at > now()
          group by ct.sport
       ) b on b.sport = s.code
       left join (
         select sport, count(*)::int as classes_count
           from classes
          where status = 'open' and end_on >= current_date
          group by sport
       ) cl on cl.sport = s.code
      order by s.sort_order asc, s.code asc`,
  );

  // Bước 3: Trả về kết quả HTTP 200 kèm danh sách môn và các số liệu thống kê
  return { status: 200, body: { items } };
}

type SportCreateForm = {
  code: string;
  name_en: string;
  name_vi: string;
  court_prefix: string;
  color_key: string;
  glyph_key: string;
  sort_order: number;
  max_players: number;
  slot_duration_min: number;
  default_photo_path: string;
  weekday_price_vnd: number;
  weekday_peak_price_vnd: number;
  weekend_price_vnd: number;
  weekend_peak_price_vnd: number;
};

type SportCreatePriceRule = {
  day_kind: string;
  start_local: string;
  end_local: string;
  price_vnd: number;
  is_peak: boolean;
  start_min: number;
  end_min: number;
};

/**
 * Làm gì: kiểm tra quyền hạn của người dùng (bắt buộc vai trò 'manager') và áp dụng giới hạn tần suất thao tác (rate limit).
 *   Vì sao: bảo vệ dữ liệu cấu hình trung tâm khỏi thao tác của người dùng không đủ quyền và ngăn ngừa việc spam tạo môn liên tục.
 * Được gọi ở: managerSportCreate, bước 1.
 * @param user Người dùng đang đăng nhập, lấy từ session do router truyền vào.
 * @throws Lỗi 403 nếu tài khoản không có vai trò manager; lỗi 429 nếu gọi vượt quá tần suất thao tác cho phép.
 */
function assertSportCreateAuthorized(user: PublicUser): void {
  requireRole(user, ["manager"]);
  limit(`sport:${user.id}`, RULES.sportMutation);
}

/**
 * Làm gì: đọc và chuẩn hóa mã môn thể thao (chuyển chữ thường, cắt khoảng trắng); kiểm tra mã phải có từ 2-24 ký tự
 *   hợp lệ theo biểu thức chính quy và không được trùng với mã 'all' dành riêng cho hệ thống.
 *   Vì sao: mã môn được dùng làm định danh (slug) trên URL, database và khóa phân quyền; 'all' là từ khóa hệ thống dành cho phạm vi toàn bộ các môn.
 * Được gọi ở: readSportCreateForm (hàm phụ của managerSportCreate, bước 2).
 * @param rawCode Giá trị thô của ô code từ body JSON request.
 * @returns Mã môn thể thao hợp lệ dạng chữ thường (ví dụ: 'badminton', 'pickleball').
 * @throws Lỗi 400 gắn vào ô code nếu mã sai định dạng hoặc là từ khóa 'all'.
 */
function parseSportCode(rawCode: unknown): string {
  const code = str(rawCode)?.trim().toLowerCase();

  const codeIsInvalidFormat = !code || !CODE_RE.test(code);
  if (codeIsInvalidFormat) {
    throw err.field(
      "code",
      "Code must be 2-24 lowercase letters, numbers, hyphens or underscores, starting with a letter.",
    );
  }

  const codeIsReservedScope = code === "all";
  if (codeIsReservedScope) {
    throw err.field("code", "Code 'all' is reserved for global scope.");
  }

  return code;
}

/**
 * Làm gì: đọc và cắt khoảng trắng tên môn thể thao bằng tiếng Anh, kiểm tra bắt buộc nhập và không quá 40 ký tự.
 *   Vì sao: tên tiếng Anh được dùng trên giao diện đa ngôn ngữ và làm văn bản thay thế (alt text) cho hình ảnh môn học.
 * Được gọi ở: readSportCreateForm (hàm phụ của managerSportCreate, bước 2).
 * @param rawNameEn Giá trị thô của ô name_en từ body JSON request.
 * @returns Tên tiếng Anh hợp lệ của môn thể thao.
 * @throws Lỗi 400 gắn vào ô name_en nếu bỏ trống hoặc dài quá 40 ký tự.
 */
function parseSportNameEn(rawNameEn: unknown): string {
  const nameEn = str(rawNameEn)?.trim();

  const nameEnIsInvalid = !nameEn || nameEn.length > 40;
  if (nameEnIsInvalid) {
    throw err.field("name_en", "English name is required (max 40 characters).");
  }

  return nameEn;
}

/**
 * Làm gì: đọc và cắt khoảng trắng tên môn thể thao bằng tiếng Việt, kiểm tra bắt buộc nhập và không quá 40 ký tự.
 *   Vì sao: tên tiếng Việt là tên hiển thị chính thức cho hội viên và nhân viên tại trung tâm.
 * Được gọi ở: readSportCreateForm (hàm phụ của managerSportCreate, bước 2).
 * @param rawNameVi Giá trị thô của ô name_vi từ body JSON request.
 * @returns Tên tiếng Việt hợp lệ của môn thể thao.
 * @throws Lỗi 400 gắn vào ô name_vi nếu bỏ trống hoặc dài quá 40 ký tự.
 */
function parseSportNameVi(rawNameVi: unknown): string {
  const nameVi = str(rawNameVi)?.trim();

  const nameViIsInvalid = !nameVi || nameVi.length > 40;
  if (nameViIsInvalid) {
    throw err.field("name_vi", "Vietnamese name is required (max 40 characters).");
  }

  return nameVi;
}

/**
 * Làm gì: đọc và chuẩn hóa tiền tố mã sân (chuyển chữ in hoa, cắt khoảng trắng), kiểm tra phải gồm đúng 2 chữ cái in hoa.
 *   Vì sao: tiền tố này được dùng để tự động sinh mã sân (ví dụ 'PB' cho sân PB-01, PB-02), giúp phân biệt loại sân trực quan.
 * Được gọi ở: readSportCreateForm (hàm phụ của managerSportCreate, bước 2).
 * @param rawCourtPrefix Giá trị thô của ô court_prefix từ body JSON request.
 * @returns Tiền tố sân gồm đúng 2 chữ cái in hoa (ví dụ: 'PB', 'TN').
 * @throws Lỗi 400 gắn vào ô court_prefix nếu không đúng định dạng 2 chữ cái in hoa.
 */
function parseSportCourtPrefix(rawCourtPrefix: unknown): string {
  const courtPrefix = str(rawCourtPrefix)?.trim().toUpperCase();

  const courtPrefixIsInvalid = !courtPrefix || !PREFIX_RE.test(courtPrefix);
  if (courtPrefixIsInvalid) {
    throw err.field(
      "court_prefix",
      "Court prefix must be exactly 2 capital letters (e.g. PB).",
    );
  }

  return courtPrefix;
}

/**
 * Làm gì: đọc mã màu chủ đề của môn thể thao, đối chiếu với danh sách màu được phép trong hệ thống.
 *   Nếu người dùng không gửi hoặc gửi màu không có trong danh sách thì dùng màu mặc định 'leaf'.
 *   Vì sao: đảm bảo hệ thống nhận diện màu sắc (badge, lịch, thẻ sân) luôn nhất quán theo bảng màu chuẩn.
 * Được gọi ở: readSportCreateForm (hàm phụ của managerSportCreate, bước 2).
 * @param rawColorKey Giá trị thô của ô color_key từ body JSON request.
 * @returns Mã màu hợp lệ (thuộc ALLOWED_COLOR_KEYS) hoặc 'leaf'.
 */
function parseSportColorKey(rawColorKey: unknown): string {
  const rawColor = str(rawColorKey)?.trim().toLowerCase() ?? "leaf";
  const isAllowedColor = (ALLOWED_COLOR_KEYS as readonly string[]).includes(rawColor);
  return isAllowedColor ? rawColor : "leaf";
}

/**
 * Làm gì: đọc toàn bộ thông tin tạo môn thể thao từ body JSON của request, kiểm tra định dạng
 *   từng trường (mã, tên tiếng Anh, tên tiếng Việt, tiền tố sân), tính toán các giá trị mặc định
 *   cho màu sắc, biểu tượng, số người chơi, thời lượng và khung giá ban đầu.
 * Được gọi ở: managerSportCreate, bước 2.
 * @param request Request POST /v1/manager/sports từ giao diện quản lý gửi lên.
 * @returns Object SportCreateForm đã được chuẩn hóa và kiểm tra đầy đủ định dạng.
 * @throws Lỗi 422 nếu body không phải JSON; lỗi 400 (gắn vào tên trường) từ các hàm kiểm tra trường nếu dữ liệu không hợp lệ.
 */
async function readSportCreateForm(request: Request): Promise<SportCreateForm> {
  const requestBody = await readJson(request);

  // Thứ tự kiểm tra các trường tuân thủ nghiêm ngặt thứ tự ban đầu để đảm bảo lỗi nào xuất hiện trước thì báo trước.
  const code = parseSportCode(requestBody.code);
  const nameEn = parseSportNameEn(requestBody.name_en);
  const nameVi = parseSportNameVi(requestBody.name_vi);
  const courtPrefix = parseSportCourtPrefix(requestBody.court_prefix);
  const colorKey = parseSportColorKey(requestBody.color_key);

  const glyphKey = str(requestBody.glyph_key)?.trim().toLowerCase() || "generic";
  const sortOrder = num(requestBody.sort_order) ?? 100;
  const maxPlayers = num(requestBody.max_players) ?? 4;
  // Mọi slot đặt sân và buổi học dài đúng 1 tiếng, nên môn mới cũng chỉ nhận 60 phút.
  const slotDurationMin = num(requestBody.slot_duration_min) ?? 60;
  if (slotDurationMin !== 60) {
    throw new ApiError(422, "VALIDATION", "Every slot lasts exactly one hour (60 minutes).", { field: "slot_duration_min" });
  }

  // Tính toán khung giá mặc định ban đầu: nếu không chỉ định giá ngày thường thì mặc định 100.000 VNĐ,
  // giờ cao điểm nhân hệ số 1.5; cuối tuần nếu không chỉ định thì lấy bằng giá ngày thường.
  const weekdayPrice = num(requestBody.weekday_price_vnd) ?? num(requestBody.price_vnd) ?? 100000;
  const weekdayPeakPrice = num(requestBody.weekday_peak_price_vnd) ?? Math.round(weekdayPrice * 1.5);
  const weekendPrice = num(requestBody.weekend_price_vnd) ?? weekdayPrice;
  const weekendPeakPrice = num(requestBody.weekend_peak_price_vnd) ?? Math.round(weekendPrice * 1.5);

  const defaultPhotoPath = str(requestBody.default_path) || `/media/sports/${code}.jpg`;

  return {
    code,
    name_en: nameEn,
    name_vi: nameVi,
    court_prefix: courtPrefix,
    color_key: colorKey,
    glyph_key: glyphKey,
    sort_order: sortOrder,
    max_players: maxPlayers,
    slot_duration_min: slotDurationMin,
    default_photo_path: defaultPhotoPath,
    weekday_price_vnd: weekdayPrice,
    weekday_peak_price_vnd: weekdayPeakPrice,
    weekend_price_vnd: weekendPrice,
    weekend_peak_price_vnd: weekendPeakPrice,
  };
}

/**
 * Làm gì: kiểm tra xem mã môn thể thao đã tồn tại trong cơ sở dữ liệu chưa (so sánh không phân biệt hoa thường).
 *   Vì sao: mã môn là khóa chính (hoặc định danh duy nhất) trong bảng sports, không được phép trùng lặp.
 * Được gọi ở: managerSportCreate, bước 3.
 * @param sql Kết nối cơ sở dữ liệu trong transaction của request.
 * @param code Mã môn thể thao cần kiểm tra tính duy nhất.
 * @throws Lỗi 409 (Conflict) nếu mã môn thể thao này đã có trong bảng sports.
 */
async function assertSportCodeUnique(sql: Sql, code: string): Promise<void> {
  // Check code uniqueness
  const duplicatedCode = await one(
    sql,
    `select 1 from sports where lower(code) = lower($1)`,
    [code],
  );

  if (duplicatedCode) {
    throw err.conflict("A sport with this code already exists.");
  }
}

/**
 * Làm gì: kiểm tra xem tiền tố mã sân (court_prefix) đã được môn thể thao nào khác sử dụng chưa.
 *   Vì sao: tiền tố sân phải là duy nhất trên toàn trung tâm để không bị xung đột khi đánh số sân (ví dụ PB-01).
 * Được gọi ở: managerSportCreate, bước 4.
 * @param sql Kết nối cơ sở dữ liệu trong transaction của request.
 * @param courtPrefix Tiền tố 2 ký tự in hoa cần kiểm tra tính duy nhất.
 * @throws Lỗi 409 (Conflict) nếu tiền tố sân đã được đăng ký bởi môn khác.
 */
async function assertCourtPrefixUnique(
  sql: Sql,
  courtPrefix: string,
): Promise<void> {
  // Check prefix uniqueness
  const duplicatedPrefix = await one(
    sql,
    `select 1 from sports where court_prefix = $1`,
    [courtPrefix],
  );

  if (duplicatedPrefix) {
    throw err.conflict("That court prefix is already used by another sport.");
  }
}

/**
 * Làm gì: thêm mới một môn thể thao vào bảng sports với trạng thái kích hoạt (enabled = true)
 *   và phạm vi môn cụ thể (is_scope_all = false), sau đó trả về bản ghi vừa tạo.
 *   Vì sao: môn thể thao mới tạo luôn ở trạng thái sẵn sàng để cấu hình sân và hoạt động.
 * Được gọi ở: managerSportCreate, bước 5.
 * @param sql Kết nối cơ sở dữ liệu trong transaction của request.
 * @param form Thông tin môn thể thao đã được xác thực hợp lệ.
 * @returns Bản ghi môn thể thao mới được thêm vào database do câu lệnh "returning *" trả về.
 */
async function insertSport(
  sql: Sql,
  form: SportCreateForm,
): Promise<SportRow | undefined> {
  // Insert sport
  return one<SportRow>(
    sql,
    `insert into sports (code, name_en, name_vi, court_prefix, color_key, glyph_key, is_scope_all, max_players, slot_duration_min, sort_order, enabled)
     values ($1, $2, $3, $4, $5, $6, false, $7, $8, $9, true)
     returning *`,
    [
      form.code,
      form.name_en,
      form.name_vi,
      form.court_prefix,
      form.color_key,
      form.glyph_key,
      form.max_players,
      form.slot_duration_min,
      form.sort_order,
    ],
  );
}

/**
 * Làm gì: thiết lập danh sách 4 quy tắc giá mặc định: ngày thường (giờ tiêu chuẩn & giờ cao điểm),
 *   và cuối tuần (giờ tiêu chuẩn & giờ cao điểm).
 *   Vì sao: khi tạo môn mới, cần có khung giá cơ sở ngay lập tức để hệ thống đặt sân tính được tiền thuê.
 * Được gọi ở: insertDefaultPriceRules (hàm phụ của managerSportCreate, bước 6).
 * @param form Thông tin môn thể thao chứa các mức giá đã tính toán.
 * @returns Mảng 4 quy tắc giá với các khung giờ từ 06:00 đến 22:00.
 */
function buildSportPriceRules(form: SportCreateForm): SportCreatePriceRule[] {
  // Initial price rules
  return [
    {
      day_kind: "weekday",
      start_local: "06:00:00",
      end_local: "17:00:00",
      price_vnd: form.weekday_price_vnd,
      is_peak: false,
      start_min: 360,
      end_min: 1020,
    },
    {
      day_kind: "weekday",
      start_local: "17:00:00",
      end_local: "22:00:00",
      price_vnd: form.weekday_peak_price_vnd,
      is_peak: true,
      start_min: 1020,
      end_min: 1320,
    },
    {
      day_kind: "weekend",
      start_local: "06:00:00",
      end_local: "08:00:00",
      price_vnd: form.weekend_price_vnd,
      is_peak: false,
      start_min: 360,
      end_min: 480,
    },
    {
      day_kind: "weekend",
      start_local: "08:00:00",
      end_local: "22:00:00",
      price_vnd: form.weekend_peak_price_vnd,
      is_peak: true,
      start_min: 480,
      end_min: 1320,
    },
  ];
}

/**
 * Làm gì: lưu 4 quy tắc giá mặc định vào bảng price_rules trong cơ sở dữ liệu.
 *   Vì sao: các sân mới thuộc môn này sau này sẽ tự động kế thừa bảng giá mặc định này nếu không có bảng giá riêng.
 * Được gọi ở: managerSportCreate, bước 6.
 * @param sql Kết nối cơ sở dữ liệu trong transaction của request.
 * @param form Thông tin môn thể thao chứa mã môn và giá.
 */
async function insertDefaultPriceRules(
  sql: Sql,
  form: SportCreateForm,
): Promise<void> {
  const priceRules = buildSportPriceRules(form);

  for (const priceRule of priceRules) {
    await sql.query(
      `insert into price_rules (id, sport, court_id, day_kind, start_local, end_local, price_vnd, is_peak)
       values (gen_random_uuid(), $1, null, $2, $3, $4, $5, $6)`,
      [
        form.code,
        priceRule.day_kind,
        priceRule.start_local,
        priceRule.end_local,
        priceRule.price_vnd,
        priceRule.is_peak,
      ],
    );
  }
}

/**
 * Làm gì: đăng ký vị trí ảnh đại diện (site asset slot dạng 'sport.<code\>') cho môn thể thao vào bảng site_assets.
 *   Nếu slot đã tồn tại từ trước thì bỏ qua (on conflict do nothing).
 *   Vì sao: giúp màn hình người dùng hiển thị được ảnh đại diện mặc định hoặc ảnh do ban quản trị tải lên sau này.
 * Được gọi ở: managerSportCreate, bước 7.
 * @param sql Kết nối cơ sở dữ liệu trong transaction của request.
 * @param form Thông tin môn thể thao gồm mã môn, đường dẫn ảnh mặc định, tên tiếng Anh và tên tiếng Việt.
 */
async function registerSportSiteAsset(
  sql: Sql,
  form: SportCreateForm,
): Promise<void> {
  // Register site asset slot
  await sql.query(
    `insert into site_assets (slot, kind, default_path, alt_en, alt_vi, enabled)
     values ($1, 'image', $2, $3, $4, true)
     on conflict (slot) do nothing`,
    [
      `sport.${form.code}`,
      form.default_photo_path,
      `${form.name_en} court photo`,
      `Ảnh sân ${form.name_vi}`,
    ],
  );
}

/**
 * Làm gì: ghi lại nhật ký kiểm toán (audit log) ghi nhận ai đã tạo môn thể thao nào, đồng thời
 *   xóa bộ nhớ đệm (cache) danh sách môn thể thao đang hoạt động.
 *   Vì sao: đảm bảo truy vết hành động của người quản lý và để danh sách môn ở các màn hình khác cập nhật ngay lập tức.
 * Được gọi ở: managerSportCreate, bước 8.
 * @param sql Kết nối cơ sở dữ liệu trong transaction của request.
 * @param user Thông tin tài khoản quản lý thực hiện hành động.
 * @param form Thông tin môn thể thao mới tạo.
 */
async function recordSportCreateAudit(
  sql: Sql,
  user: PublicUser,
  form: SportCreateForm,
): Promise<void> {
  await audit(sql, user.id, "create_sport", "sport", form.code, null, {
    code: form.code,
    name_en: form.name_en,
    court_prefix: form.court_prefix,
  });

  // Xóa bộ nhớ đệm danh sách môn thể thao để các yêu cầu tiếp theo đọc được dữ liệu mới nhất.
  invalidateSportCodesCache();
}

/**
 * Làm gì: tạo một môn thể thao mới trong hệ thống cùng các cấu hình ban đầu (bảng giá mặc định 4 khung giờ,
 *   slot ảnh đại diện, nhật ký kiểm toán và xóa cache danh sách môn).
 *   Đọc hàm này như một mục lục: từng dòng là một bước rõ ràng, chi tiết thực thi nằm ở các hàm phụ phía trên.
 *   Thứ tự các bước được giữ nguyên tuyệt đối để đảm bảo thứ tự kiểm tra lỗi và ghi dữ liệu không thay đổi.
 * Được gọi ở:
 *   - Màn hình quản lý môn thể thao /manager/sports (src/routes/manager.sports.tsx), trong modal "Add sport",
 *     nút "Create sport" kích hoạt hàm handleCreate (src/client/lib/pages/manager.sports.ts),
 *     gửi apiPost("/manager/sports", ...) tức POST /v1/manager/sports.
 *   - src/server/controllers/router.ts tại nhánh if (method === "POST" && p0 === "manager" && p1 === "sports" && !p2),
 *     gọi qua wrapper authed((sql, user) => sportsH.managerSportCreate(sql, request, user)).
 *     Wrapper authed kiểm tra đăng nhập và mở một transaction database; nếu có lỗi ở bất kỳ bước nào, toàn bộ transaction sẽ tự động rollback.
 * @param sql Kết nối cơ sở dữ liệu trong transaction do router mở sẵn.
 * @param request Request HTTP chứa body JSON với các thông tin tạo môn thể thao.
 * @param user Thông tin người dùng đang đăng nhập lấy từ session; bắt buộc phải có vai trò 'manager'.
 * @returns Object phản hồi { status: 201, body: { ok: true, sport: row } } chứa môn thể thao vừa tạo.
 * @throws Lỗi 403 nếu người dùng không phải manager; lỗi 429 nếu vượt quá tần suất thao tác (rate limit);
 *   lỗi 422 nếu body không phải JSON; lỗi 400 gắn vào trường tương ứng nếu code, name_en, name_vi hoặc court_prefix không hợp lệ;
 *   lỗi 409 nếu mã code hoặc court_prefix đã tồn tại trong cơ sở dữ liệu.
 */
export async function managerSportCreate(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền quản lý (manager) và giới hạn tần suất thao tác (rate limit).
  assertSportCreateAuthorized(user);

  // Bước 2: Đọc dữ liệu JSON từ body request và kiểm tra tính hợp lệ của từng trường.
  const form = await readSportCreateForm(request);

  // Bước 3: Đảm bảo mã môn thể thao chưa được sử dụng bởi môn nào khác.
  await assertSportCodeUnique(sql, form.code);

  // Bước 4: Đảm bảo tiền tố mã sân chưa bị môn thể thao khác chiếm dụng.
  await assertCourtPrefixUnique(sql, form.court_prefix);

  // Bước 5: Thêm mới dòng dữ liệu môn thể thao vào bảng sports.
  const createdSport = await insertSport(sql, form);

  // Bước 6: Thiết lập 4 quy tắc tính giá sân mặc định (ngày thường, cuối tuần, giờ thường, cao điểm).
  await insertDefaultPriceRules(sql, form);

  // Bước 7: Khởi tạo vị trí tài nguyên ảnh đại diện (site asset slot) cho môn thể thao.
  await registerSportSiteAsset(sql, form);

  // Bước 8: Ghi nhật ký kiểm toán hành động tạo môn và làm mới bộ nhớ đệm danh sách môn.
  await recordSportCreateAudit(sql, user, form);

  // Bước 9: Trả về HTTP 201 Created cùng dữ liệu môn thể thao vừa tạo.
  return { status: 201, body: { ok: true, sport: createdSport } };
}

/**
 * Làm gì: Cập nhật một phần thông tin của môn thể thao (tên tiếng Anh, tên tiếng Việt, tiền tố sân, màu sắc, icon, thứ tự, trạng thái).
 *   Đảm bảo toàn vẹn dữ liệu: không cho đổi tiền tố nếu môn đã có sân, cấm trùng tiền tố với môn khác.
 * Được gọi ở:
 *   - Route: PATCH /v1/manager/sports/:code (src/server/controllers/router.ts:836).
 *   - Client: Modal "Edit sport" trên trang /manager/sports qua hàm handleUpdate (src/client/lib/pages/manager.sports.ts:316).
 * @param sql Kết nối cơ sở dữ liệu trong transaction của request.
 * @param code Mã định danh duy nhất của môn thể thao cần cập nhật (ví dụ: 'badminton', 'tennis').
 * @param request Request HTTP chứa body JSON các trường cần cập nhật.
 * @param user Thông tin tài khoản người dùng đang đăng nhập, bắt buộc có vai trò 'manager'.
 * @returns Object phản hồi { status: 200, body: { ok: true, sport: row } } chứa thông tin môn sau khi sửa.
 * @throws Lỗi 403 nếu không phải manager; lỗi 429 nếu vượt quá tần suất thao tác (rate limit); lỗi 404 nếu không tìm thấy môn thể thao;
 *   lỗi 400 nếu tên hoặc tiền tố không hợp lệ; lỗi 409 nếu tiền tố bị trùng hoặc môn đã có sân hoạt động.
 */
export async function managerSportPatch(sql: Sql, code: string, request: Request, user: PublicUser) {
  // Bước 1: Kiểm tra quyền quản lý (manager) và giới hạn tần suất thao tác (rate limit).
  requireRole(user, ["manager"]);
  limit(`sport:${user.id}`, RULES.sportMutation);

  // Bước 2: Kiểm tra môn thể thao có tồn tại trong hệ thống hay không (ném lỗi 404 nếu không tìm thấy).
  const cur = await one<SportRow>(sql, `select * from sports where code = $1`, [code]);
  if (!cur) throw err.notFound("No such sport.");

  // Bước 3: Đọc body JSON và kiểm tra tính hợp lệ của tên môn thể thao (tiếng Anh và tiếng Việt từ 1-40 ký tự).
  const b = await readJson(request);

  const nameEn = b.name_en !== undefined ? str(b.name_en)?.trim() : cur.name_en;
  if (!nameEn || nameEn.length > 40) throw err.field("name_en", "English name must be 1-40 characters.");

  const nameVi = b.name_vi !== undefined ? str(b.name_vi)?.trim() : cur.name_vi;
  if (!nameVi || nameVi.length > 40) throw err.field("name_vi", "Vietnamese name must be 1-40 characters.");

  // Bước 4: Kiểm tra các quy tắc nghiệp vụ khi thay đổi tiền tố mã sân (court_prefix).
  let courtPrefix = cur.court_prefix;
  if (b.court_prefix !== undefined && b.court_prefix !== cur.court_prefix) {
    const nextPrefix = str(b.court_prefix)?.trim().toUpperCase();
    // Scope 'all' đại diện cho toàn bộ trung tâm (dùng cho gói tập chung), không phải môn cụ thể nên không có tiền tố sân.
    if (cur.is_scope_all) {
      throw err.field("court_prefix", "Scope 'all' cannot have a court prefix.");
    }
    // Tiền tố sân bắt buộc gồm đúng 2 ký tự in hoa (ví dụ: 'TN', 'BM') dùng để tạo mã sân như TN01, BM01.
    if (!nextPrefix || !PREFIX_RE.test(nextPrefix)) {
      throw err.field("court_prefix", "Court prefix must be exactly 2 capital letters.");
    }
    // Check if courts already exist for this sport
    // Không được phép đổi tiền tố khi đã có sân trực thuộc vì sẽ làm sai lệch quy tắc đặt tên các sân hiện có.
    const courtCount = await one<{ cnt: number }>(sql, `select count(*)::int as cnt from courts where sport = $1`, [code]);
    if ((courtCount?.cnt ?? 0) > 0) {
      throw err.conflict("Cannot change prefix when courts already exist for this sport.");
    }
    // Check if prefix in use by other sport
    // Đảm bảo tiền tố không trùng với bất kỳ môn thể thao nào khác đang có trong hệ thống.
    const dup = await one(sql, `select 1 from sports where court_prefix = $1 and code <> $2`, [nextPrefix, code]);
    if (dup) {
      throw err.conflict("Court prefix is already in use by another sport.");
    }
    courtPrefix = nextPrefix;
  }

  // Bước 5: Chuẩn hóa các thuộc tính giao diện (màu sắc, icon), thứ tự sắp xếp và cờ kích hoạt.
  const rawColor = b.color_key !== undefined ? str(b.color_key)?.trim().toLowerCase() : cur.color_key;
  // Chỉ chấp nhận mã màu trong ALLOWED_COLOR_KEYS, nếu giá trị không hợp lệ thì gán về màu mặc định 'leaf'.
  const colorKey = (ALLOWED_COLOR_KEYS as readonly string[]).includes(rawColor ?? "") ? (rawColor ?? "leaf") : cur.color_key;
  const glyphKey = b.glyph_key !== undefined ? str(b.glyph_key)?.trim().toLowerCase() || "generic" : cur.glyph_key;
  const sortOrder = b.sort_order !== undefined ? num(b.sort_order) ?? cur.sort_order : cur.sort_order;
  const enabled = b.enabled !== undefined ? b.enabled === true || b.enabled === "true" : cur.enabled;

  // Bước 6: Cập nhật thông tin môn thể thao vào bảng sports và lấy lại dữ liệu mới nhất.
  const row = await one<SportRow>(
    sql,
    `update sports
        set name_en = $1, name_vi = $2, court_prefix = $3, color_key = $4,
            glyph_key = $5, sort_order = $6, enabled = $7, updated_at = now()
      where code = $8
      returning *`,
    [nameEn, nameVi, courtPrefix, colorKey, glyphKey, sortOrder, enabled, code],
  );

  // Bước 7: Ghi nhật ký kiểm toán (audit log) kèm dữ liệu trước/sau thay đổi và xóa bộ nhớ đệm danh sách môn.
  await audit(sql, user.id, "update_sport", "sport", code, cur, row);
  // Xóa cache để các request tiếp theo truy vấn danh sách môn nhận được dữ liệu mới nhất.
  invalidateSportCodesCache();
  return { status: 200, body: { ok: true, sport: row } };
}

/**
 * Làm gì: Ngưng hoạt động (retire / soft-delete) một môn thể thao, ngăn tạo thêm sân và đặt sân mới.
 *   Kiểm tra nghiêm ngặt các điều kiện chặn (blockers): không cho ngưng môn cuối cùng, yêu cầu giải quyết hết
 *   sân đang hoạt động, lịch đặt sân tương lai và các lớp học sắp/đang diễn ra.
 * Được gọi ở:
 *   - Route: POST /v1/manager/sports/:code/retire (src/server/controllers/router.ts:839).
 *   - Client: Nút "Retire" trên trang /manager/sports qua hàm handleRetire (src/client/lib/pages/manager.sports.ts:351).
 * @param sql Kết nối cơ sở dữ liệu trong transaction của request.
 * @param code Mã định danh của môn thể thao cần ngưng hoạt động.
 * @param user Thông tin tài khoản người dùng đang đăng nhập, bắt buộc có vai trò 'manager'.
 * @returns Object phản hồi { status: 200, body: { ok: true, sport: row } } chứa dữ liệu môn thể thao sau khi ngưng.
 * @throws Lỗi 403 nếu không phải manager; lỗi 429 nếu vượt rate limit; lỗi 404 nếu không tìm thấy môn;
 *   lỗi 409 (CONFLICT / CONFLICT_STATE) nếu là scope 'all', là môn hoạt động cuối cùng, hoặc còn sân/lịch đặt/lớp học chưa xử lý.
 */
export async function managerSportRetire(sql: Sql, code: string, user: PublicUser) {
  // Bước 1: Kiểm tra quyền quản lý (manager) và giới hạn tần suất thao tác (rate limit).
  requireRole(user, ["manager"]);
  limit(`sport:${user.id}`, RULES.sportMutation);

  // Bước 2: Kiểm tra sự tồn tại và tính hợp lệ của môn thể thao cần ngưng hoạt động.
  const cur = await one<SportRow>(sql, `select * from sports where code = $1`, [code]);
  if (!cur) throw err.notFound("No such sport.");
  // Scope 'all' là phạm vi toàn hệ thống (dùng cho khuyến mãi/gói tập chung), tuyệt đối không được ngưng.
  if (cur.is_scope_all) {
    throw err.conflict("Cannot retire the global 'all' sport scope.");
  }
  // Xử lý idempotent: nếu môn đã ở trạng thái ngưng hoạt động thì trả về kết quả hiện tại ngay.
  if (cur.retired_at) {
    return { status: 200, body: { ok: true, sport: cur } };
  }

  // Bước 3: Đảm bảo trung tâm luôn duy trì ít nhất một môn thể thao đang hoạt động.
  // Cannot retire the last active playable sport
  const remainingActive = await one<{ cnt: number }>(
    sql,
    `select count(*)::int as cnt from sports where enabled and retired_at is null and not is_scope_all and code <> $1`,
    [code],
  );
  // Trung tâm không thể vận hành nếu tất cả các môn thể thao đều bị ngưng hoạt động.
  if (!remainingActive || remainingActive.cnt === 0) {
    throw err.conflict("Cannot retire the last active sport.");
  }

  // Bước 4: Kiểm tra 3 điều kiện chặn (blockers): sân đang hoạt động, lịch đặt trong tương lai, lớp học sắp tới.
  // Check blockers: active courts, future bookings, future classes
  const blockers: string[] = [];

  // Điều kiện 1: Phải ngưng hoạt động tất cả sân đang sẵn sàng ('ready') thuộc môn này trước.
  const activeCourts = await one<{ cnt: number }>(
    sql,
    `select count(*)::int as cnt from courts where sport = $1 and status = 'ready' and retired_at is null`,
    [code],
  );
  if ((activeCourts?.cnt ?? 0) > 0) {
    blockers.push(`${activeCourts!.cnt} active court(s) must be retired first.`);
  }

  // Điều kiện 2: Không thể ngưng môn nếu còn khách đã đặt sân trong tương lai (start_at > now()).
  const futureBookings = await one<{ cnt: number }>(
    sql,
    `select count(*)::int as cnt
       from occupancies o
       join courts c on c.id = o.court_id
      where c.sport = $1 and o.kind = 'booking' and o.start_at > now()`,
    [code],
  );
  if ((futureBookings?.cnt ?? 0) > 0) {
    blockers.push(`${futureBookings!.cnt} future booking(s) exist for this sport.`);
  }

  // Điều kiện 3: Không thể ngưng môn nếu còn lớp học đang mở và chưa kết thúc (end_on >= current_date).
  const futureClasses = await one<{ cnt: number }>(
    sql,
    `select count(*)::int as cnt from classes where sport = $1 and status = 'open' and end_on >= current_date`,
    [code],
  );
  if ((futureClasses?.cnt ?? 0) > 0) {
    blockers.push(`${futureClasses!.cnt} active or upcoming class(es) exist for this sport.`);
  }

  // Nếu có bất kỳ điều kiện nào chưa thỏa mãn, ném lỗi 409 CONFLICT_STATE kèm danh sách lý do cụ thể.
  if (blockers.length > 0) {
    throw new ApiError(409, "CONFLICT_STATE", `Cannot retire sport: ${blockers.join(" ")}`, {
      reasons: blockers,
    });
  }

  // Bước 5: Cập nhật thời điểm ngưng hoạt động (retired_at = now()) vào bảng sports.
  const row = await one<SportRow>(
    sql,
    `update sports set retired_at = now(), updated_at = now() where code = $1 returning *`,
    [code],
  );

  // Bước 6: Ghi nhật ký kiểm toán (audit log), xóa cache danh sách môn và trả về phản hồi 200 OK.
  await audit(sql, user.id, "retire_sport", "sport", code, { retired_at: null }, { retired_at: row!.retired_at });
  invalidateSportCodesCache();
  return { status: 200, body: { ok: true, sport: row } };
}

/**
 * Làm gì: Khôi phục một môn thể thao đã bị ngưng hoạt động (đặt lại retired_at = null và enabled = true).
 *   Cho phép môn thể thao xuất hiện trở lại trên giao diện khách hàng và mở lại tính năng quản lý sân/lịch.
 * Được gọi ở:
 *   - Route: POST /v1/manager/sports/:code/restore (src/server/controllers/router.ts:842).
 *   - Client: Nút "Restore" trên trang /manager/sports qua hàm handleRestore (src/client/lib/pages/manager.sports.ts:380).
 * @param sql Kết nối cơ sở dữ liệu trong transaction của request.
 * @param code Mã định danh của môn thể thao cần khôi phục.
 * @param user Thông tin tài khoản người dùng đang đăng nhập, bắt buộc có vai trò 'manager'.
 * @returns Object phản hồi { status: 200, body: { ok: true, sport: row } } chứa thông tin môn sau khi khôi phục.
 * @throws Lỗi 403 nếu không phải manager; lỗi 429 nếu vượt rate limit; lỗi 404 nếu không tìm thấy môn thể thao.
 */
export async function managerSportRestore(sql: Sql, code: string, user: PublicUser) {
  // Bước 1: Kiểm tra quyền quản lý (manager) và giới hạn tần suất thao tác (rate limit).
  requireRole(user, ["manager"]);
  limit(`sport:${user.id}`, RULES.sportMutation);

  // Bước 2: Kiểm tra sự tồn tại và trạng thái ngưng hoạt động của môn thể thao.
  const cur = await one<SportRow>(sql, `select * from sports where code = $1`, [code]);
  if (!cur) throw err.notFound("No such sport.");
  // Xử lý idempotent: nếu môn đang hoạt động bình thường (retired_at rỗng) thì trả về dữ liệu hiện tại ngay.
  if (!cur.retired_at) {
    return { status: 200, body: { ok: true, sport: cur } };
  }

  // Bước 3: Cập nhật cơ sở dữ liệu để xóa mốc retired_at và kích hoạt lại môn thể thao (enabled = true).
  const row = await one<SportRow>(
    sql,
    `update sports set retired_at = null, enabled = true, updated_at = now() where code = $1 returning *`,
    [code],
  );

  // Bước 4: Ghi nhật ký kiểm toán (audit log), xóa cache danh sách môn và trả về kết quả 200 OK.
  await audit(sql, user.id, "restore_sport", "sport", code, { retired_at: cur.retired_at }, { retired_at: null });
  invalidateSportCodesCache();
  return { status: 200, body: { ok: true, sport: row } };
}

/**
 * Làm gì: Xóa vĩnh viễn (hard-delete) một môn thể thao cùng bảng giá và ảnh đại diện khỏi hệ thống.
 *   Chỉ cho phép xóa khi môn chưa phát sinh bất kỳ dữ liệu lịch sử nào (sân, lớp, khuyến mãi, thiết bị, cấp độ hội viên, đánh giá, HLV).
 * Được gọi ở:
 *   - Route: DELETE /v1/manager/sports/:code (src/server/controllers/router.ts:845).
 *   - Client: Nút "Delete" trên trang /manager/sports qua hàm handleDelete (src/client/lib/pages/manager.sports.ts:402).
 * @param sql Kết nối cơ sở dữ liệu trong transaction của request.
 * @param code Mã định danh của môn thể thao cần xóa vĩnh viễn.
 * @param user Thông tin tài khoản người dùng đang đăng nhập, bắt buộc có vai trò 'manager'.
 * @returns Object phản hồi { status: 200, body: { ok: true, deleted: code } } xác nhận mã môn đã bị xóa.
 * @throws Lỗi 403 nếu không phải manager; lỗi 429 nếu vượt rate limit; lỗi 404 nếu không tìm thấy môn;
 *   lỗi 409 nếu là môn phạm vi 'all' hoặc môn đã phát sinh dữ liệu trong bất kỳ bảng nào (bắt buộc phải retire thay vì xóa).
 */
export async function managerSportDelete(sql: Sql, code: string, user: PublicUser) {
  // Bước 1: Kiểm tra quyền quản lý (manager) và giới hạn tần suất thao tác (rate limit).
  requireRole(user, ["manager"]);
  limit(`sport:${user.id}`, RULES.sportMutation);

  // Bước 2: Kiểm tra sự tồn tại của môn thể thao và bảo vệ phạm vi toàn hệ thống 'all'.
  const cur = await one<SportRow>(sql, `select * from sports where code = $1`, [code]);
  if (!cur) throw err.notFound("No such sport.");
  // Scope 'all' là cấu hình hệ thống dùng chung cho toàn trung tâm, tuyệt đối không được xóa.
  if (cur.is_scope_all) {
    throw err.conflict("Cannot delete the global 'all' sport scope.");
  }

  // Bước 3: Quét kiểm tra lịch sử dữ liệu của môn thể thao trên 7 bảng nghiệp vụ liên quan.
  // Check if sport has ANY history anywhere in the system
  const checks = [
    { table: "courts", query: `select 1 from courts where sport = $1 limit 1` },
    { table: "classes", query: `select 1 from classes where sport = $1 limit 1` },
    { table: "promotions", query: `select 1 from promotions where sport = $1 limit 1` },
    { table: "equipment_items", query: `select 1 from equipment_items where sport = $1 limit 1` },
    { table: "member_levels", query: `select 1 from member_levels where sport = $1 limit 1` },
    { table: "progress_reviews", query: `select 1 from progress_reviews where sport = $1 limit 1` },
    { table: "coach_sports", query: `select 1 from coach_sports where sport = $1 limit 1` },
  ];

  // Nếu đã có bất kỳ bản ghi nào liên kết (sân, lớp, khuyến mãi, thiết bị...), từ chối xóa để bảo toàn dữ liệu và yêu cầu dùng retire.
  for (const c of checks) {
    const hasHistory = await one(sql, c.query, [code]);
    if (hasHistory) {
      throw err.conflict("This sport has history. Retire it instead.");
    }
  }

  // Bước 4: Xóa sạch các dữ liệu liên kết phụ thuộc theo đúng thứ tự ràng buộc khóa ngoại trước khi xóa môn.
  // Safe to delete completely
  // Xóa các quy tắc giá mặc định của môn trong price_rules.
  await sql.query(`delete from price_rules where sport = $1`, [code]);
  // Earlier photos point at the slot, so they go first.
  await sql.query(`delete from site_asset_history where slot = $1`, [`sport.${code}`]);
  await sql.query(`delete from site_assets where slot = $1`, [`sport.${code}`]);
  await sql.query(`delete from sports where code = $1`, [code]);

  // Bước 5: Ghi nhật ký kiểm toán (audit log), xóa cache danh sách môn và trả về kết quả 200 OK.
  await audit(sql, user.id, "delete_sport", "sport", code, cur, null);
  invalidateSportCodesCache();
  return { status: 200, body: { ok: true, deleted: code } };
}

// Bộ nhớ đệm (in-memory cache) danh sách mã môn thể thao để giảm tải truy vấn database khi kiểm tra hợp lệ.
let cachedSportCodes: { codes: string[]; timestamp: number } | null = null;
let cachedAllSportCodes: { codes: string[]; timestamp: number } | null = null;

/**
 * Làm gì: Xóa sạch bộ nhớ đệm (cache) danh sách mã môn thể thao trong tiến trình hiện tại.
 *   Được gọi ngay sau khi tạo mới, cập nhật, ngưng hoạt động, khôi phục hoặc xóa môn thể thao.
 * Được gọi ở:
 *   - Các hàm mutation trong src/server/controllers/handlers/sports.ts (recordSportCreateAudit, managerSportPatch,
 *     managerSportRetire, managerSportRestore, managerSportDelete).
 * @returns void Không trả về giá trị.
 */
export function invalidateSportCodesCache() {
  cachedSportCodes = null;
  cachedAllSportCodes = null;
}

/**
 * Làm gì: Lấy danh sách các mã môn thể thao đang hoạt động (chưa bị ngưng: retired_at is null),
 *   sử dụng bộ nhớ đệm trong vòng 30 giây (TTL) để tối ưu hiệu năng khi xác thực mã môn liên tục.
 * Được gọi ở:
 *   - Các controller kiểm tra mã môn hợp lệ: src/server/controllers/handlers/attendance.ts, bookings.ts,
 *     members.ts, ops.ts, promos.ts, reports.ts, staff.ts, training.ts.
 * @param sql Kết nối cơ sở dữ liệu để truy vấn khi cache hết hạn hoặc chưa khởi tạo.
 * @param includeScopeAll Cờ xác định có bao gồm cả scope đặc biệt 'all' hay không (mặc định là false).
 * @returns Promise<string[]> Mảng danh sách mã môn thể thao sắp xếp theo thứ tự hiển thị.
 */
export async function getActiveSportCodes(sql: Sql, includeScopeAll = false): Promise<string[]> {
  // Bước 1: Kiểm tra bộ nhớ đệm (cache), nếu còn trong thời hạn 30 giây thì trả về ngay mà không cần truy vấn database.
  const now = Date.now();
  const cache = includeScopeAll ? cachedAllSportCodes : cachedSportCodes;
  // Thời gian sống của cache (TTL) là 30.000 ms (30 giây), đủ ngắn để cập nhật nhanh nhưng giảm tải lớn cho database.
  if (cache && now - cache.timestamp < 30_000) {
    return cache.codes;
  }
  // Bước 2: Truy vấn danh sách mã môn thể thao đang hoạt động từ bảng sports trong database.
  const rows = await sql.query<{ code: string }>(
    `select code from sports where retired_at is null ${includeScopeAll ? "" : "and not is_scope_all"} order by sort_order asc, code asc`,
  );
  const codes = rows.map((r) => r.code);
  // Bước 3: Lưu kết quả kèm mốc thời gian vào cache tương ứng và trả về danh sách mã môn.
  if (includeScopeAll) {
    cachedAllSportCodes = { codes, timestamp: now };
  } else {
    cachedSportCodes = { codes, timestamp: now };
  }
  return codes;
}

