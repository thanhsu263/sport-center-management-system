/**
 * Module xử lý nghiệp vụ quản lý sân tập (courts) dành cho cấp quản lý (manager).
 * Phục vụ các API quản trị tại route /manager/courts:
 * - Lấy danh sách sân kèm thống kê lịch đặt sắp tới, lớp học đang mở và cấu hình giá riêng.
 * - Thêm mới sân tập (tự động sinh mã sân court_code hoặc kiểm tra trùng lặp mã tùy chỉnh).
 * - Ngưng hoạt động (retire) và khôi phục (restore) sân an toàn, bảo toàn dữ liệu lịch sử đặt sân.
 */
import type { Sql } from "@/server/data/db";
import { ApiError, err } from "../errors";
import { audit, num, readJson, str } from "../helpers";
import { one } from "../tx";
import { requireRole, type PublicUser } from "../session";

// Biểu thức chính quy kiểm tra định dạng mã sân: gồm đúng 2 chữ cái in hoa, dấu gạch ngang và 2 đến 3 chữ số (ví dụ: CL-01, BR-12, TN-101).
const COURT_CODE_RE = /^[A-Z]{2}-\d{2,3}$/;

/**
 * Làm gì: tự động sinh mã sân mới duy nhất theo tiền tố môn thể thao (ví dụ CL-01, BR-02) bằng cách tìm số thứ tự nhỏ nhất chưa được dùng.
 *   Giúp người quản lý không cần tự nghĩ mã sân và đảm bảo mã sân đúng chuẩn định dạng, không bị trùng lặp.
 * Được gọi ở: hàm managerCourtCreate (bước 3 trong file này) khi người quản lý tạo sân mới nhưng không nhập mã sân tùy chỉnh.
 * @param sql Kết nối cơ sở dữ liệu để truy vấn danh sách mã sân hiện có theo tiền tố.
 * @param courtPrefix Tiền tố 2 chữ cái của môn thể thao lấy từ bảng sports (ví dụ: 'CL', 'BR'); nếu null sẽ mặc định dùng 'CT'.
 * @returns Chuỗi mã sân mới được định dạng dạng [Tiền tố]-[Số thứ tự 2 chữ số] (ví dụ: 'CL-01').
 */
async function generateCourtCode(sql: Sql, courtPrefix: string | null): Promise<string> {
  // Bước 1: xác định tiền tố mã sân theo môn thể thao, mặc định là "CT-" (Court) nếu môn không có tiền tố riêng.
  const prefix = courtPrefix ? `${courtPrefix}-` : "CT-";
  // Bước 2: truy vấn tất cả các mã sân hiện có bắt đầu bằng tiền tố này để kiểm tra danh sách số đã dùng.
  const existing = await sql.query<{ court_code: string }>(
    `select court_code from courts where court_code like $1`,
    [`${prefix}%`],
  );
  // Bước 3: trích xuất số thứ tự từ các mã sân hiện có và đưa vào Set để phục vụ tra cứu nhanh O(1).
  const usedNumbers = new Set<number>();
  for (const court of existing) {
    const match = /^[A-Z]{2}-(\d+)$/.exec(court.court_code);
    if (match && match[1]) {
      usedNumbers.add(parseInt(match[1], 10));
    }
  }
  // Bước 4: duyệt từ 1 để tìm số nguyên dương nhỏ nhất chưa được sử dụng, giúp tái sử dụng các số còn trống.
  let nextNumber = 1;
  while (usedNumbers.has(nextNumber)) nextNumber++;
  // Bước 5: ghép tiền tố với số thứ tự được đệm số 0 thành tối thiểu 2 chữ số (ví dụ: 1 -> "01", 12 -> "12").
  return `${prefix}${String(nextNumber).padStart(2, "0")}`;
}

/**
 * Làm gì: chuyển đổi thông tin một lịch chiếm sân (occupancy) thành cấu trúc mô tả thân thiện, dễ hiểu cho người dùng.
 *   Giúp hiển thị rõ ràng cho quản lý biết sự kiện cụ thể nào (đặt sân, lớp học, bảo trì) đang cản trở việc ngưng hoạt động sân.
 * Được gọi ở: hàm checkCourtRetireUpcomingOccupancies (bước 4 quy trình retire sân trong file này).
 * @param occupancy Bản ghi lịch chiếm sân gồm loại lịch (kind), thời gian (start_at, end_at), mã đặt sân (code) hoặc tên lớp (title).
 * @returns Đối tượng chứa thông tin lịch chiếm sân kèm chuỗi mô tả chi tiết (description) để trả về client.
 */
function describeCourtBlocker(occupancy: {
  kind: string;
  start_at: string;
  end_at: string;
  code: string | null;
  title: string | null;
}) {
  // Ưu tiên hiển thị mã đặt sân nếu có, tiếp theo là tên lớp học, cuối cùng là loại lịch mặc định (hold/maintenance).
  return {
    kind: occupancy.kind,
    start_at: occupancy.start_at,
    end_at: occupancy.end_at,
    description: occupancy.code
      ? `Booking ${occupancy.code}`
      : occupancy.title ? `Class ${occupancy.title}` : occupancy.kind,
  };
}

/**
 * Làm gì: lấy danh sách toàn bộ sân tập trong hệ thống kèm số liệu thống kê tổng hợp (lịch đặt sắp tới, lớp học mở, cấu hình giá).
 *   Cung cấp dữ liệu cho bảng điều khiển quản trị sân, giúp quản lý theo dõi trạng thái vận hành và tải sử dụng của từng sân.
 * Được gọi ở:
 *   - Màn hình quản lý sân /manager/courts (src/routes/manager.courts.tsx) thông qua hook useManagerCourts (src/client/lib/pages/manager.courts.ts).
 *   - Route: GET /v1/manager/courts, được router (src/server/controllers/router.ts) chuyển tiếp qua authedRead.
 * @param sql Kết nối cơ sở dữ liệu ở chế độ đọc (authedRead).
 * @param user Thông tin người dùng đang đăng nhập, yêu cầu phải có vai trò quản lý (manager).
 * @returns Đối tượng { status: 200, body: { items } } chứa danh sách các sân kèm thông tin thống kê.
 * @throws Lỗi 403 (FORBIDDEN) nếu người dùng không có vai trò manager.
 */
export async function managerCourtsList(sql: Sql, user: PublicUser) {
  // Bước 1: kiểm tra phân quyền, chỉ người có vai trò quản lý (manager) mới được xem danh sách này.
  requireRole(user, ["manager"]);

  // Bước 2: truy vấn danh sách sân kết hợp thống kê lịch bận và lớp học sắp tới bằng các câu truy vấn con (LEFT JOIN).
  // - occ: đếm số lượt đặt sân (booking) và giữ chỗ (hold) chưa kết thúc (end_at > now()).
  // - cls: đếm số lớp học khác nhau có buổi học sắp tới chưa bị hủy.
  // - has_custom_price: kiểm tra sự tồn tại của quy tắc giá riêng áp dụng cho sân trong price_rules.
  const items = await sql.query<{
    id: string;
    court_code: string;
    sport: string;
    status: string;
    display_name: string | null;
    sort_order: number | null;
    retired_at: string | null;
    upcoming_bookings: number;
    active_classes: number;
    has_custom_price: boolean;
  }>(
    `select c.id, c.court_code, c.sport, c.status, c.display_name, c.sort_order, c.retired_at,
            coalesce(occ.upcoming_count, 0)::int as upcoming_bookings,
            coalesce(cls.class_count, 0)::int as active_classes,
            (exists (select 1 from price_rules pr where pr.court_id = c.id)) as has_custom_price
       from courts c
       left join (
         select court_id, count(*)::int as upcoming_count
           from occupancies
          where end_at > now() and kind in ('booking', 'hold')
          group by court_id
       ) occ on occ.court_id = c.id
       left join (
         select court_id, count(distinct class_id)::int as class_count
           from sessions
          where end_at > now() and status <> 'cancelled'
          group by court_id
       ) cls on cls.court_id = c.id
      order by c.sort_order nulls last, c.court_code`,
  );

  // Bước 3: trả về danh sách sân đã được sắp xếp theo sort_order (ưu tiên) rồi đến court_code.
  return { status: 200, body: { items } };
}

/**
 * Làm gì: tạo mới một sân tập vào cơ sở dữ liệu và ghi nhật ký kiểm toán (audit log).
 *   Xác thực môn thể thao hợp lệ, sinh mã sân tự động hoặc kiểm tra mã tùy chỉnh, và lưu thông tin sân ở trạng thái sẵn sàng.
 * Được gọi ở:
 *   - Màn hình quản lý sân /manager/courts (src/routes/manager.courts.tsx) trong form tạo sân của modal "Add court" (hàm handleCreate trong src/client/lib/pages/manager.courts.ts).
 *   - Route: POST /v1/manager/courts, được router (src/server/controllers/router.ts) chuyển tiếp qua authed (mở transaction).
 * @param sql Kết nối cơ sở dữ liệu trong transaction do router quản lý.
 * @param request Request HTTP POST chứa body JSON gồm: sport, court_code (tùy chọn), display_name, status, sort_order.
 * @param user Thông tin người dùng đang đăng nhập, yêu cầu phải có vai trò quản lý (manager).
 * @returns Đối tượng { status: 201, body: { court } } chứa bản ghi sân vừa được tạo thành công.
 * @throws Lỗi 403 (FORBIDDEN) nếu người dùng không có vai trò manager.
 * @throws Lỗi 422 (UNPROCESSABLE_ENTITY) nếu thiếu môn thể thao, môn không hợp lệ hoặc đã ngưng hoạt động, mã sân sai định dạng, hoặc tên hiển thị vượt quá 40 ký tự.
 * @throws Lỗi 409 (CONFLICT_SLOT) nếu mã sân tùy chỉnh đã tồn tại trong hệ thống.
 */
export async function managerCourtCreate(sql: Sql, request: Request, user: PublicUser) {
  // Bước 1: kiểm tra quyền manager và đọc dữ liệu JSON gửi lên từ request body.
  requireRole(user, ["manager"]);
  const b = await readJson(request);

  // Bước 2: kiểm tra môn thể thao bắt buộc, phải đang được bật (enabled), chưa ngưng hoạt động và không phải scope chung.
  const sport = str(b.sport);
  if (!sport) {
    throw err.field("sport", "Sport is required.");
  }

  const spRow = await one<{ court_prefix: string | null; enabled: boolean; retired_at: string | null }>(
    sql,
    `select court_prefix, enabled, retired_at from sports where code = $1 and not is_scope_all`,
    [sport],
  );
  if (!spRow || !spRow.enabled || spRow.retired_at) {
    throw err.field("sport", "Invalid or retired sport.");
  }

  // Bước 3: xử lý mã sân - nếu để trống thì tự động sinh theo tiền tố của môn, nếu tự nhập thì kiểm tra định dạng và trùng lặp.
  let courtCode = str(b.court_code)?.trim().toUpperCase();

  if (!courtCode) {
    // Auto-generate code based on sport prefix and lowest unused number
    courtCode = await generateCourtCode(sql, spRow.court_prefix);
  } else {
    // Validate custom code
    if (courtCode.length > 8 || !COURT_CODE_RE.test(courtCode)) {
      throw err.validation(
        "Court code must match format like CL-01 or BR-12 (2 capital letters, dash, 2-3 digits).",
        { field: "court_code" },
      );
    }
    // Kiểm tra trùng mã sân trong cơ sở dữ liệu (so sánh không phân biệt hoa thường).
    const duplicate = await one(
      sql,
      `select 1 from courts where lower(court_code) = lower($1)`,
      [courtCode],
    );
    if (duplicate) {
      throw err.conflictSlot("That court code is already in use.");
    }
  }

  // Bước 4: chuẩn hóa tên hiển thị (tối đa 40 ký tự), trạng thái ban đầu (mặc định 'ready') và thứ tự sắp xếp.
  const displayName = str(b.display_name)?.trim() || null;
  if (displayName && displayName.length > 40) {
    throw err.field("display_name", "Display name cannot exceed 40 characters.");
  }

  const status = str(b.status) || "ready";
  const sortOrder = num(b.sort_order) ?? null;

  // Bước 5: thêm bản ghi sân mới vào bảng courts và trả về thông tin chi tiết của sân vừa tạo.
  const court = await one<{
    id: string;
    court_code: string;
    sport: string;
    status: string;
    display_name: string | null;
    sort_order: number | null;
    retired_at: string | null;
  }>(
    sql,
    `insert into courts (court_code, sport, status, display_name, sort_order)
     values ($1, $2, $3, $4, $5)
     returning id, court_code, sport, status, display_name, sort_order, retired_at`,
    [courtCode, sport, status, displayName, sortOrder],
  );

  // Bước 6: ghi nhật ký kiểm toán (audit log) lưu vết ai là người tạo sân và thông tin ban đầu.
  await audit(sql, user.id, "create_court", "court", court!.id, null, {
    court_code: courtCode,
    sport,
    display_name: displayName,
  });

  // Bước 7: trả về HTTP 201 Created cùng dữ liệu sân mới cho giao diện quản trị cập nhật danh sách.
  return { status: 201, body: { court } };
}

// Các kiểu dữ liệu phục vụ quy trình kiểm tra và ngưng hoạt động sân tập (managerCourtRetire).
type CourtRetireTarget = {
  id: string;
  court_code: string;
  sport: string;
  status: string;
  retired_at: string | null;
};

type CourtRetireRemainingCount = {
  cnt: number;
};

type CourtRetireActiveClassCount = {
  cnt: number;
};

type CourtRetireOccupancyBlocker = {
  id: string;
  start_at: string;
  end_at: string;
  kind: string;
  ref_id: string;
  code: string | null;
  title: string | null;
};

type CourtRetireDescribedBlocker = {
  kind: string;
  start_at: string;
  end_at: string;
  description: string;
};

type RetiredCourtResult = {
  id: string;
  court_code: string;
  sport: string;
  status: string;
  display_name: string | null;
  sort_order: number | null;
  retired_at: string | null;
};

/**
 * Làm gì: tìm kiếm bản ghi sân theo mã định danh (courtId) trong cơ sở dữ liệu và kiểm tra
 *   xem sân có tồn tại không, cũng như đã bị ngưng hoạt động từ trước hay chưa.
 *   Vì sao: phải kiểm tra sự tồn tại trước khi thao tác; nếu sân đã ngưng hoạt động rồi thì
 *   từ chối ngay để tránh ghi đè sai lệch mốc thời gian retired_at ban đầu.
 * Được gọi ở: managerCourtRetire, bước 2.
 * @param sql Kết nối cơ sở dữ liệu trong transaction do router mở.
 * @param courtId Mã định danh UUID của sân cần ngưng hoạt động, nhận từ tham số id của hàm chính.
 * @returns Bản ghi thông tin sân hợp lệ (CourtRetireTarget) sẵn sàng để xét duyệt ngưng hoạt động.
 * @throws Lỗi 404 (NOT_FOUND) "No such court." nếu không tìm thấy sân trong bảng courts.
 * @throws Lỗi 422 (UNPROCESSABLE_ENTITY) "Court is already retired." nếu sân đã ngưng hoạt động trước đó.
 */
async function findCourtForRetirement(
  sql: Sql,
  courtId: string,
): Promise<CourtRetireTarget> {
  const courtRecord = await one<CourtRetireTarget>(
    sql,
    `select id, court_code, sport, status, retired_at from courts where id = $1`,
    [courtId],
  );

  const courtDoesNotExist = !courtRecord;
  if (courtDoesNotExist) {
    throw err.notFound("No such court.");
  }

  const courtIsAlreadyRetired = Boolean(courtRecord.retired_at);
  if (courtIsAlreadyRetired) {
    throw err.validation("Court is already retired.");
  }

  return courtRecord;
}

/**
 * Làm gì: kiểm tra quy tắc bảo vệ sân cuối cùng của một môn thể thao. Nếu sân này là sân hoạt động
 *   cuối cùng của môn và môn đó vẫn còn ít nhất một lớp học đang mở ('open'), hệ thống sẽ từ chối ngưng hoạt động.
 *   Vì sao: lớp học đang mở cần sân để tổ chức các buổi học; nếu đóng toàn bộ sân của môn thì học viên
 *   và huấn luyện viên sẽ không có sân tập luyện, làm đổ vỡ lịch học của trung tâm.
 * Được gọi ở: managerCourtRetire, bước 3.
 * @param sql Kết nối cơ sở dữ liệu trong transaction do router mở.
 * @param court Bản ghi sân cần ngưng hoạt động lấy từ findCourtForRetirement; dùng sport và id.
 * @returns Không trả về dữ liệu (Promise<void>) nếu thỏa mãn điều kiện bảo vệ.
 * @throws Lỗi 409 (CONFLICT_STATE) "Cannot retire the last court for a sport with active classes."
 *   khi không còn sân nào khác cùng môn đang hoạt động và vẫn còn lớp học đang mở ('open').
 */
async function checkCourtRetireLastCourtProtection(
  sql: Sql,
  court: CourtRetireTarget,
): Promise<void> {
  // Protection: cannot retire the last court of a sport with active classes
  const remainingCourtsRecord = await one<CourtRetireRemainingCount>(
    sql,
    `select count(*)::int as cnt from courts where sport = $1 and retired_at is null and id <> $2`,
    [court.sport, court.id],
  );

  // Kiểm tra xem môn thể thao này có còn sân nào khác chưa bị ngưng hoạt động hay không.
  const hasNoOtherActiveCourts =
    !remainingCourtsRecord || remainingCourtsRecord.cnt === 0;

  if (hasNoOtherActiveCourts) {
    // Đếm số lượng lớp học của môn này đang ở trạng thái mở ('open').
    const activeClassesRecord = await one<CourtRetireActiveClassCount>(
      sql,
      `select count(*)::int as cnt from classes where sport = $1 and status = 'open'`,
      [court.sport],
    );

    const activeClassCount = activeClassesRecord?.cnt ?? 0;
    const hasActiveClasses = activeClassCount > 0;

    // Nếu không còn sân nào khác mà vẫn còn lớp học đang mở thì chặn không cho ngưng hoạt động.
    if (hasActiveClasses) {
      throw new ApiError(
        409,
        "CONFLICT_STATE",
        "Cannot retire the last court for a sport with active classes.",
      );
    }
  }
}

/**
 * Làm gì: kiểm tra xem sân có lịch chiếm dụng nào trong tương lai hay không (bao gồm các lượt đặt sân,
 *   giữ chỗ, buổi học của lớp, hoặc bảo trì có thời gian kết thúc sau thời điểm hiện tại).
 *   Vì sao: sân đang có lịch sử dụng sắp tới thì không được đóng đột ngột; quản lý phải hủy hoặc dời
 *   các lịch này sang sân khác trước khi ngưng hoạt động sân để đảm bảo quyền lợi khách hàng.
 * Được gọi ở: managerCourtRetire, bước 4.
 * @param sql Kết nối cơ sở dữ liệu trong transaction do router mở.
 * @param courtId Mã định danh UUID của sân cần kiểm tra, lấy từ tham số id của hàm chính.
 * @returns Không trả về dữ liệu (Promise<void>) nếu sân hoàn toàn không có lịch bận trong tương lai.
 * @throws Lỗi 409 (CONFLICT_STATE) "Cannot retire court with upcoming bookings or sessions." kèm
 *   danh sách chi tiết affected và blockers nếu phát hiện bất kỳ lịch chiếm sân nào chưa kết thúc.
 */
async function checkCourtRetireUpcomingOccupancies(
  sql: Sql,
  courtId: string,
): Promise<void> {
  // Check upcoming bookings, holds, classes, maintenance
  const upcomingOccupancies = await sql.query<CourtRetireOccupancyBlocker>(
    `select o.id, o.start_at, o.end_at, o.kind, o.ref_id,
            b.code,
            concat_ws(' ', c.sport::text, c.level) as title
       from occupancies o
       left join court_bookings b on o.kind = 'booking' and b.id = o.ref_id
       left join sessions s on o.kind = 'session' and s.id = o.ref_id
       left join classes c on c.id = s.class_id
      where o.court_id = $1 and o.end_at > now()
      order by o.start_at`,
    [courtId],
  );

  const hasUpcomingOccupancies = upcomingOccupancies.length > 0;
  if (hasUpcomingOccupancies) {
    // Chuyển đổi danh sách lịch chiếm sân thành cấu trúc mô tả chi tiết để trả về cho giao diện hiển thị
    const affectedBlockers: CourtRetireDescribedBlocker[] = [];
    for (const occupancy of upcomingOccupancies) {
      affectedBlockers.push(describeCourtBlocker(occupancy));
    }

    const blockersList: CourtRetireDescribedBlocker[] = [];
    for (const occupancy of upcomingOccupancies) {
      blockersList.push(describeCourtBlocker(occupancy));
    }

    throw new ApiError(
      409,
      "CONFLICT_STATE",
      "Cannot retire court with upcoming bookings or sessions.",
      {
        affected: affectedBlockers,
        blockers: blockersList,
      },
    );
  }
}

/**
 * Làm gì: cập nhật bản ghi sân trong cơ sở dữ liệu: gán thời điểm ngưng hoạt động (retired_at = now())
 *   và chuyển trạng thái hoạt động của sân sang đóng cửa (status = 'closed').
 *   Vì sao: đánh dấu chính thức sân đã ngừng hoạt động và ngăn không cho sân xuất hiện ở trạng thái sẵn sàng.
 * Được gọi ở: managerCourtRetire, bước 5.
 * @param sql Kết nối cơ sở dữ liệu trong transaction do router mở.
 * @param courtId Mã định danh UUID của sân cần ngưng hoạt động, lấy từ tham số id của hàm chính.
 * @returns Không trả về dữ liệu (Promise<void>).
 * @throws Lỗi truy vấn cơ sở dữ liệu (nếu có) được truyền nguyên vẹn lên tầng xử lý lỗi.
 */
async function markCourtAsRetired(
  sql: Sql,
  courtId: string,
): Promise<void> {
  await sql.query(
    `update courts set retired_at = now(), status = 'closed' where id = $1`,
    [courtId],
  );
}

/**
 * Làm gì: ghi lại nhật ký kiểm toán (audit log) cho hành động "retire_court" của quản lý, lưu trữ
 *   trạng thái trước đó của sân (from_status) và mốc thời gian ISO khi ngưng hoạt động (retired_at).
 *   Vì sao: đảm bảo tính minh bạch, tuân thủ quy chuẩn kiểm toán hệ thống để tra cứu ai đã ngưng sân nào và lúc nào.
 * Được gọi ở: managerCourtRetire, bước 6.
 * @param sql Kết nối cơ sở dữ liệu trong transaction do router mở.
 * @param managerUserId Mã định danh UUID của người quản lý thực hiện, lấy từ user.id.
 * @param courtId Mã định danh UUID của sân bị ngưng hoạt động, lấy từ tham số id của hàm chính.
 * @param previousStatus Trạng thái hoạt động của sân trước khi đóng, lấy từ courtToRetire.status ở bước 2.
 * @returns Không trả về dữ liệu (Promise<void>).
 * @throws Lỗi ghi nhật ký vào database (nếu có) được truyền nguyên vẹn lên tầng xử lý lỗi.
 */
async function recordCourtRetireAudit(
  sql: Sql,
  managerUserId: string,
  courtId: string,
  previousStatus: string,
): Promise<void> {
  await audit(
    sql,
    managerUserId,
    "retire_court",
    "court",
    courtId,
    { from_status: previousStatus },
    { retired_at: new Date().toISOString() },
  );
}

/**
 * Làm gì: đọc lại toàn bộ thông tin chi tiết mới nhất của sân từ bảng courts sau khi đã cập nhật.
 *   Vì sao: cung cấp bản ghi sân sau cập nhật (trạng thái mới 'closed' và thời điểm retired_at)
 *   cho màn hình quản lý để cập nhật lại giao diện người dùng mà không cần tải lại toàn bộ trang.
 * Được gọi ở: managerCourtRetire, bước 7.
 * @param sql Kết nối cơ sở dữ liệu trong transaction do router mở.
 * @param courtId Mã định danh UUID của sân vừa cập nhật, lấy từ tham số id của hàm chính.
 * @returns Dòng thông tin sân RetiredCourtResult, hoặc undefined nếu không tìm thấy bản ghi.
 * @throws Lỗi truy vấn cơ sở dữ liệu (nếu có) được truyền nguyên vẹn lên tầng xử lý lỗi.
 */
async function fetchRetiredCourtDetails(
  sql: Sql,
  courtId: string,
): Promise<RetiredCourtResult | undefined> {
  return one<RetiredCourtResult>(
    sql,
    `select id, court_code, sport, status, display_name, sort_order, retired_at from courts where id = $1`,
    [courtId],
  );
}

/**
 * Làm gì: ngưng hoạt động (retire) một sân thể thao và cập nhật trạng thái sân thành đóng cửa ('closed').
 *   Đọc hàm này như mục lục: mỗi dòng là một bước rõ ràng, chi tiết nằm ở các hàm phụ phía trên.
 *   Thứ tự các bước được giữ nguyên vẹn: kiểm tra quyền quản lý, kiểm tra sân tồn tại và chưa ngưng,
 *   kiểm tra bảo vệ sân cuối cùng của môn thể thao có lớp học, kiểm tra lịch chiếm sân trong tương lai,
 *   cập nhật trạng thái sân, ghi nhật ký kiểm toán và trả về dữ liệu sân sau cập nhật.
 *   Vì sao: sân bị hỏng, bảo trì dài hạn hoặc ngừng khai thác cần được đưa vào trạng thái ngưng hoạt động
 *   thay vì xóa cứng khỏi cơ sở dữ liệu, nhằm bảo toàn dữ liệu lịch sử đặt sân và hóa đơn. Quy trình
 *   ngăn chặn việc đóng sân nếu vẫn còn lịch bận hoặc làm ảnh hưởng đến các lớp học đang diễn ra.
 * Được gọi ở:
 *   - Màn hình quản lý sân /manager/courts (src/routes/manager.courts.tsx): người dùng mở menu thao tác
 *     của một sân, chọn "Retire court" để mở modal xác nhận "Retire this court?", rồi nhấn nút "Retire court".
 *   - Hàm handleRetire trong src/client/lib/pages/manager.courts.ts gửi apiPost(`/manager/courts/${court.id}/retire`, {}),
 *     tương ứng với HTTP method POST đường dẫn /v1/manager/courts/:id/retire.
 *   - src/server/controllers/router.ts bắt khớp nhánh method === "POST" && p0 === "manager" && p1 === "courts" && p2 && parts[3] === "retire"
 *     và gọi hàm này thông qua authed((sql, user) => courtH.managerCourtRetire(sql, p2, request, user)):
 *     hàm authed xác thực phiên đăng nhập và tự động mở transaction cơ sở dữ liệu; nếu bất kỳ bước nào ném lỗi,
 *     toàn bộ transaction sẽ tự động rollback.
 * @param sql Kết nối cơ sở dữ liệu trong transaction do router quản lý.
 * @param id Mã định danh UUID của sân cần ngưng hoạt động, truyền từ tham số đường dẫn URL (:id / p2).
 * @param _request Request HTTP POST do client gửi lên (không dùng body trong nghiệp vụ này).
 * @param user Người dùng đang đăng nhập lấy từ session xác thực; bắt buộc phải có vai trò quản lý (manager).
 * @returns Đối tượng { status: 200, body: { ok: true, court } } chứa thông tin sân sau khi cập nhật để giao diện làm mới dòng tương ứng.
 * @throws Lỗi 403 (FORBIDDEN) nếu người dùng không có vai trò quản lý (manager).
 * @throws Lỗi 404 (NOT_FOUND) "No such court." nếu không tìm thấy sân theo mã id cung cấp.
 * @throws Lỗi 422 (UNPROCESSABLE_ENTITY) "Court is already retired." nếu sân đã ngưng hoạt động từ trước.
 * @throws Lỗi 409 (CONFLICT_STATE) "Cannot retire the last court for a sport with active classes." nếu đây là sân
 *   hoạt động cuối cùng của môn thể thao và môn đó vẫn còn lớp học đang mở đăng ký.
 * @throws Lỗi 409 (CONFLICT_STATE) "Cannot retire court with upcoming bookings or sessions." kèm danh sách affected
 *   và blockers nếu sân còn lịch đặt chỗ hoặc buổi học trong tương lai.
 */
export async function managerCourtRetire(
  sql: Sql,
  id: string,
  _request: Request,
  user: PublicUser,
) {
  // Bước 1: chỉ người có vai trò quản lý (manager) mới được phép ngưng hoạt động sân.
  requireRole(user, ["manager"]);

  // Bước 2: tìm sân theo mã định danh, kiểm tra sân có tồn tại và chưa bị ngưng hoạt động trước đó.
  const courtToRetire = await findCourtForRetirement(sql, id);

  // Bước 3: kiểm tra quy tắc bảo vệ: không cho phép ngưng sân cuối cùng của môn nếu vẫn còn lớp học mở.
  await checkCourtRetireLastCourtProtection(sql, courtToRetire);

  // Bước 4: kiểm tra lịch bận: không cho phép ngưng sân nếu còn lịch đặt, giữ chỗ hoặc buổi học sắp tới.
  await checkCourtRetireUpcomingOccupancies(sql, id);

  // Bước 5: cập nhật sân sang trạng thái đóng cửa ('closed') và lưu thời điểm ngưng hoạt động.
  await markCourtAsRetired(sql, id);

  // Bước 6: ghi nhật ký kiểm toán (audit log) ghi nhận người quản lý thực hiện và trạng thái trước khi đóng.
  await recordCourtRetireAudit(sql, user.id, id, courtToRetire.status);

  // Bước 7: đọc lại thông tin chi tiết của sân sau cập nhật và phản hồi về cho giao diện quản trị.
  const updatedCourt = await fetchRetiredCourtDetails(sql, id);

  return { status: 200, body: { ok: true, court: updatedCourt } };
}

/**
 * Làm gì: khôi phục hoạt động cho một sân thể thao đã bị ngưng hoạt động (retired) trước đó: xóa thời điểm ngưng hoạt động (retired_at = null) và đưa trạng thái sân về sẵn sàng đón khách (status = 'ready').
 *   Vì sao: khi trung tâm cần đưa sân vào vận hành lại sau bảo trì hoặc mở lại môn thể thao, việc khôi phục giúp giữ nguyên mã sân (court_code), cấu hình giá và toàn bộ lịch sử giao dịch thay vì tạo sân mới.
 * Được gọi ở:
 *   - Màn hình quản lý sân /manager/courts (src/routes/manager.courts.tsx): người dùng mở menu thao tác của sân đã bị ngưng, chọn "Restore court" để khôi phục.
 *   - Hàm handleRestore trong src/client/lib/pages/manager.courts.ts gửi apiPost(`/manager/courts/${court.id}/restore`, {}).
 *   - src/server/controllers/router.ts: bắt khớp nhánh method === "POST" && p0 === "manager" && p1 === "courts" && p2 && parts[3] === "restore" (tương ứng route HTTP POST /v1/manager/courts/:id/restore), bọc qua wrapper authed.
 * @param sql Kết nối cơ sở dữ liệu trong transaction do router quản lý.
 * @param id Mã định danh UUID của sân cần khôi phục, truyền từ tham số đường dẫn URL (:id / p2).
 * @param user Thông tin người dùng đang đăng nhập lấy từ session xác thực; bắt buộc phải có vai trò quản lý (manager).
 * @returns Đối tượng { status: 200, body: { ok: true, court } } chứa dữ liệu chi tiết của sân sau khi khôi phục để giao diện cập nhật dòng tương ứng.
 * @throws Lỗi 403 (FORBIDDEN) nếu người dùng không có vai trò quản lý (manager).
 * @throws Lỗi 404 (NOT_FOUND) "No such court." nếu không tìm thấy sân theo mã id trong bảng courts.
 * @throws Lỗi 422 (UNPROCESSABLE_ENTITY) "Court is not retired." nếu sân hiện chưa bị ngưng hoạt động (retired_at đang là null).
 */
export async function managerCourtRestore(sql: Sql, id: string, user: PublicUser) {
  // Bước 1: chỉ người có vai trò quản lý (manager) mới được phép khôi phục sân.
  requireRole(user, ["manager"]);

  // Bước 2: tìm sân theo mã định danh (id), kiểm tra sân có tồn tại và đang ở trạng thái ngưng hoạt động hay không.
  const cur = await one<{
    id: string;
    court_code: string;
    sport: string;
    status: string;
    retired_at: string | null;
  }>(sql, `select id, court_code, sport, status, retired_at from courts where id = $1`, [id]);

  // Không tìm thấy sân trong cơ sở dữ liệu thì báo lỗi 404 (NOT_FOUND).
  if (!cur) {
    throw err.notFound("No such court.");
  }
  // Nếu sân chưa từng bị ngưng hoạt động (retired_at là null) thì chặn lại, tránh thao tác khôi phục trùng lặp.
  if (!cur.retired_at) {
    throw err.validation("Court is not retired.");
  }

  // Bước 3: cập nhật cơ sở dữ liệu: xóa thời điểm ngưng hoạt động (retired_at = null) và mở lại sân với trạng thái sẵn sàng ('ready').
  await sql.query(
    `update courts set retired_at = null, status = 'ready' where id = $1`,
    [id],
  );

  // Bước 4: ghi nhật ký kiểm toán (audit log) ghi nhận người quản lý thực hiện hành động "restore_court" và trạng thái mới 'ready'.
  await audit(sql, user.id, "restore_court", "court", id, null, { status: "ready" });

  // Bước 5: đọc lại thông tin chi tiết mới nhất của sân sau khi khôi phục từ bảng courts.
  const court = await one(
    sql,
    `select id, court_code, sport, status, display_name, sort_order, retired_at from courts where id = $1`,
    [id],
  );

  // Bước 6: phản hồi kết quả thành công kèm thông tin sân đã cập nhật để giao diện client làm mới hiển thị.
  return { status: 200, body: { ok: true, court } };
}
