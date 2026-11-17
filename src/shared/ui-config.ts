/**
 * The menus and list lengths a manager sets (`center_settings.ui_config`), with what the centre
 * shipped with as the default for every key.
 *
 * Pure, no imports: the server checks a patch against the same pages and ranges the screens
 * draw from, and the node test runner can load it directly.
 */

/**
 * Làm gì: Định nghĩa 4 vai trò người dùng trong hệ thống có thể tùy biến thanh điều hướng (hội viên, lễ tân, huấn luyện viên, quản lý).
 * Được gọi ở: src/shared/ui-config.ts, src/client/components/shell.tsx, src/client/components/menu-settings.tsx, src/client/lib/use-centre.ts.
 */
export type NavRole = "member" | "receptionist" | "coach" | "manager";
/**
 * Làm gì: Mảng danh sách 4 vai trò người dùng trong hệ thống theo thứ tự phân quyền, dùng để duyệt khởi tạo và xác thực cấu hình thanh điều hướng.
 * Được gọi ở: src/client/components/menu-settings.tsx (MenuSettings), src/shared/ui-config.ts (uiConfigFrom, parseUiConfigPatch).
 */
export const NAV_ROLES: NavRole[] = ["member", "receptionist", "coach", "manager"];

/**
 * One tab. `to` is a page the role can open, or an `https://` link the centre added, which
 * needs a `label` because there is no page to name it.
 */
export type NavEntry = { to: string; dock: boolean; label?: string };

type PageSpec = { to: string; dock: boolean; shown: boolean };

/**
 * Every page each role can open, in the order they ship. `shown: false` pages are not in the
 * menu until a manager adds them; `dock` is whether the tab sits in the phone's bottom bar.
 */
/**
 * Làm gì: Danh mục toàn bộ các trang nội bộ mặc định cho từng vai trò trong hệ thống, quy định trạng thái hiển thị (shown) và việc có ghim lên thanh dock điện thoại hay không (dock).
 * Được gọi ở: src/client/components/menu-settings.tsx (MenuSettings), src/shared/ui-config.ts (defaultNav, navProblem).
 */
export const NAV_PAGES: Record<NavRole, PageSpec[]> = {
  member: [
    { to: "/app", dock: true, shown: true },
    { to: "/app/book", dock: true, shown: true },
    { to: "/app/classes", dock: true, shown: true },
    { to: "/app/train", dock: false, shown: true },
    { to: "/app/points", dock: false, shown: true },
    { to: "/app/plans", dock: false, shown: true },
    { to: "/chat", dock: false, shown: true },
    { to: "/app/pass", dock: true, shown: true },
    { to: "/app/assistant", dock: false, shown: false },
    { to: "/app/notifications", dock: false, shown: false },
    { to: "/account", dock: false, shown: false },
  ],
  receptionist: [
    { to: "/desk", dock: true, shown: true },
    { to: "/desk/gate", dock: true, shown: true },
    { to: "/desk/courts", dock: true, shown: true },
    { to: "/desk/classes", dock: false, shown: true },
    { to: "/desk/series", dock: false, shown: true },
    { to: "/desk/payments", dock: true, shown: true },
    { to: "/desk/at-risk", dock: false, shown: true },
    { to: "/chat", dock: false, shown: true },
    { to: "/desk/gear", dock: false, shown: true },
    { to: "/desk/maintenance", dock: false, shown: true },
    { to: "/account", dock: false, shown: false },
  ],
  coach: [
    { to: "/coach", dock: true, shown: true },
    { to: "/coach/classes", dock: true, shown: true },
    { to: "/coach/attendance", dock: true, shown: true },
    { to: "/chat", dock: true, shown: true },
    { to: "/coach/earnings", dock: true, shown: true },
    { to: "/account", dock: true, shown: true },
  ],
  manager: [
    { to: "/manager", dock: true, shown: true },
    { to: "/manager/members", dock: true, shown: true },
    { to: "/manager/attendance", dock: true, shown: true },
    { to: "/desk/payments", dock: true, shown: true },
    { to: "/manager/plans", dock: false, shown: true },
    { to: "/manager/promos", dock: false, shown: true },
    { to: "/manager/prices", dock: false, shown: true },
    { to: "/manager/commission", dock: false, shown: true },
    { to: "/manager/invoices", dock: false, shown: true },
    { to: "/manager/classes", dock: false, shown: true },
    { to: "/desk/series", dock: false, shown: true },
    { to: "/manager/courts", dock: false, shown: true },
    { to: "/manager/sports", dock: false, shown: true },
    { to: "/desk/gear", dock: false, shown: true },
    { to: "/desk/maintenance", dock: false, shown: true },
    { to: "/chat", dock: false, shown: true },
    { to: "/manager/staff", dock: false, shown: true },
    { to: "/manager/media", dock: false, shown: true },
    { to: "/manager/audit", dock: false, shown: true },
    { to: "/manager/settings", dock: false, shown: true },
    { to: "/account", dock: false, shown: false },
  ],
};

/** The menu as shipped. */
/**
 * Làm gì: Lấy danh sách các tab điều hướng mặc định ban đầu của một vai trò (chỉ lấy các trang có shown: true và chuyển thành cấu trúc NavEntry gồm to và dock).
 * Được gọi ở: src/client/components/menu-settings.tsx (MenuSettings - nút Reset), src/shared/ui-config.ts (hàm uiConfigFrom làm giá trị fallback khi menu lỗi).
 * @param role Vai trò người dùng cần lấy danh sách tab mặc định (NavRole).
 * @returns Danh sách các tab điều hướng mặc định (NavEntry[]) của vai trò đó.
 */
export function defaultNav(role: NavRole): NavEntry[] {
  return NAV_PAGES[role].filter((p) => p.shown).map(({ to, dock }) => ({ to, dock }));
}

/** Links the centre adds per role, on top of its pages. */
/**
 * Làm gì: Số lượng liên kết ngoài (https://) tối đa mà quản lý được phép bổ sung vào thanh điều hướng của mỗi vai trò (tối đa 6 liên kết).
 * Được gọi ở: src/shared/ui-config.ts (navProblem), src/client/components/menu-settings.tsx (MenuSettings).
 */
export const MAX_LINKS = 6;
/**
 * Làm gì: Giới hạn độ dài tối đa của nhãn hiển thị cho một liên kết ngoài (tối đa 24 ký tự) nhằm tránh tràn vỡ giao diện thanh điều hướng.
 * Được gọi ở: src/shared/ui-config.ts (navProblem), src/client/components/menu-settings.tsx (MenuSettings).
 */
export const LINK_LABEL_MAX = 24;
/**
 * Làm gì: Giới hạn độ dài tối đa của chuỗi URL liên kết ngoài (tối đa 300 ký tự) nhằm ngăn chặn việc lưu trữ chuỗi quá dài hoặc tấn công DoS.
 * Được gọi ở: src/shared/ui-config.ts (validLink), src/client/components/menu-settings.tsx (MenuSettings).
 */
export const LINK_URL_MAX = 300;

/**
 * Làm gì: Kiểm tra một đường dẫn tab có phải là liên kết ngoài (bắt đầu bằng giao thức https://) hay là đường dẫn trang nội bộ trong ứng dụng.
 * Được gọi ở: src/shared/ui-config.ts (navProblem, entryFrom), src/client/components/shell.tsx (Shell), src/client/components/menu-settings.tsx (MenuSettings).
 * @param to Chuỗi đường dẫn hoặc URL của tab cần kiểm tra.
 * @returns true nếu đường dẫn bắt đầu bằng https:// (liên kết ngoài), ngược lại false (trang nội bộ).
 */
export function isLinkTab(to: string): boolean {
  return to.startsWith("https://");
}

/** How many items the short lists show. `min`/`max` are what the settings form accepts. */
/**
 * Làm gì: Bảng cấu hình độ dài cho các danh sách rút gọn trên giao diện (nhãn mô tả, giá trị mặc định def, giá trị nhỏ nhất min, giá trị lớn nhất max).
 * Được gọi ở: src/shared/ui-config.ts (DEFAULT_LIMITS, uiConfigFrom, parseUiConfigPatch), src/client/components/menu-settings.tsx (MenuSettings).
 */
export const LIMITS = {
  member_free_hours: { label: "Free hours on the member home", def: 6, min: 1, max: 24 },
  member_bookings: { label: "Bookings shown before \"Show more\"", def: 4, min: 1, max: 50 },
  book_alternatives: { label: "Other hours suggested when one is taken", def: 3, min: 1, max: 10 },
  book_best_days: { label: "Days with the most free hours", def: 4, min: 1, max: 14 },
  coach_below_min: { label: "Sessions in the coach's \"Below minimum\" list", def: 5, min: 1, max: 50 },
  desk_upcoming: { label: "Upcoming sessions on the desk", def: 4, min: 1, max: 20 },
  desk_checkins: { label: "Recent gate check-ins on the desk", def: 6, min: 1, max: 50 },
  report_peak_hours: { label: "Peak hours named in the report", def: 3, min: 1, max: 10 },
  report_peak_pct: { label: "An hour counts as peak from (% of the busiest)", def: 85, min: 50, max: 100 },
  landing_coaches: { label: "Coaches shown on the landing page", def: 4, min: 1, max: 24 },
} as const;

export type LimitKey = keyof typeof LIMITS;
/**
 * Làm gì: Mảng chứa toàn bộ các khóa định danh (LimitKey) của các mục cấu hình giới hạn số lượng phần tử hiển thị.
 * Được gọi ở: src/shared/ui-config.ts (DEFAULT_LIMITS, uiConfigFrom, parseUiConfigPatch), src/client/components/menu-settings.tsx (MenuSettings).
 */
export const LIMIT_KEYS = Object.keys(LIMITS) as LimitKey[];
export type Limits = Record<LimitKey, number>;

export type UiConfig = { nav: Record<NavRole, NavEntry[]>; limits: Limits };

/**
 * Làm gì: Đối tượng chứa giá trị giới hạn mặc định ban đầu của toàn bộ các danh sách (được tạo tự động từ trường def của LIMITS).
 * Được gọi ở: src/shared/ui-config.ts (dùng làm giá trị khởi tạo và fallback an toàn trong hàm uiConfigFrom).
 */
export const DEFAULT_LIMITS: Limits = Object.fromEntries(LIMIT_KEYS.map((k) => [k, LIMITS[k].def])) as Limits;

/**
 * Làm gì: Type guard kiểm tra một giá trị chưa rõ kiểu có phải là đối tượng Record hợp lệ (kiểu object, khác null và không phải mảng) hay không.
 * Được gọi ở: Nội bộ src/shared/ui-config.ts (hàm entryFrom, uiConfigFrom, parseUiConfigPatch).
 * @param v Giá trị bất kỳ cần kiểm tra kiểu dữ liệu.
 * @returns true nếu v là đối tượng Record<string, unknown>, ngược lại false.
 */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Làm gì: Kiểm tra một đường dẫn URL liên kết ngoài có hợp lệ hay không (không vượt quá 300 ký tự và có giao thức bắt buộc là https:).
 * Được gọi ở: Nội bộ src/shared/ui-config.ts (hàm navProblem).
 * @param to Chuỗi URL cần kiểm tra tính hợp lệ.
 * @returns true nếu chuỗi là URL https:// hợp lệ và độ dài <= 300 ký tự, ngược lại false.
 */
function validLink(to: string): boolean {
  // Bước 1: Kiểm tra độ dài URL không vượt quá LINK_URL_MAX (300 ký tự) để ngăn lưu trữ chuỗi quá lớn.
  if (to.length > LINK_URL_MAX) return false;
  // Bước 2: Dùng URL constructor để kiểm tra cú pháp và bắt buộc giao thức bảo mật phải là https:.
  try {
    return new URL(to).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The problem with one role's menu, or null if it can be saved. Shared by the server (which
 * refuses the save) and the form (which says so before sending).
 */
/**
 * Làm gì: Kiểm tra các quy tắc nghiệp vụ của menu điều hướng cho một vai trò (không rỗng, không trùng trang, link ngoài https hợp lệ kèm nhãn <= 24 ký tự, trang nội bộ phải thuộc vai trò, tối đa 6 link ngoài); trả về thông báo lỗi hoặc null nếu hợp lệ.
 * Được gọi ở: src/client/components/menu-settings.tsx (MenuSettings), src/shared/ui-config.ts (uiConfigFrom, parseUiConfigPatch).
 * @param role Vai trò người dùng đang kiểm tra menu (NavRole).
 * @param items Danh sách các mục tab điều hướng (NavEntry[]) cần xác thực.
 * @returns Chuỗi thông báo lỗi tiếng Anh nếu cấu hình không hợp lệ, hoặc null nếu hợp lệ để lưu.
 */
export function navProblem(role: NavRole, items: NavEntry[]): string | null {
  // Bước 1: Bắt buộc menu phải giữ ít nhất 1 tab để người dùng luôn có lối điều hướng.
  if (items.length === 0) return "Keep at least one tab.";
  // Bước 2: Tạo tập hợp các trang hợp lệ của vai trò từ NAV_PAGES để đối chiếu, và chuẩn bị Set để phát hiện tab trùng lặp.
  const pages = new Set(NAV_PAGES[role].map((p) => p.to));
  const seen = new Set<string>();
  let links = 0;
  // Bước 3: Duyệt từng tab để kiểm tra trùng lặp và xác thực tính hợp lệ của liên kết ngoài hoặc trang nội bộ.
  for (const it of items) {
    if (seen.has(it.to)) return "Each page can be a tab only once.";
    seen.add(it.to);
    // Nếu là liên kết ngoài: tăng biến đếm, yêu cầu địa chỉ https hợp lệ và nhãn hiển thị từ 1 đến LINK_LABEL_MAX (24) ký tự.
    if (isLinkTab(it.to)) {
      links += 1;
      if (!validLink(it.to)) return "A link must be a full https:// address.";
      const label = (it.label ?? "").trim();
      if (!label || label.length > LINK_LABEL_MAX) return `Name each link (${LINK_LABEL_MAX} characters at most).`;
    // Nếu là trang nội bộ: kiểm tra xem vai trò hiện tại có quyền mở trang này trong NAV_PAGES hay không.
    } else if (!pages.has(it.to)) {
      return "That page is not one this role can open.";
    }
  }
  // Bước 4: Giới hạn tổng số liên kết ngoài trong một menu không được vượt quá MAX_LINKS (6 liên kết) để tránh làm chật thanh menu.
  if (links > MAX_LINKS) return `A menu holds ${MAX_LINKS} links at most.`;
  return null;
}

/**
 * Làm gì: Chuyển đổi và chuẩn hóa một đối tượng dữ liệu thô thành NavEntry (cắt khoảng trắng to/label, ép dock thành boolean); trả về null nếu dữ liệu không đúng cấu trúc.
 * Được gọi ở: Nội bộ src/shared/ui-config.ts (hàm uiConfigFrom, parseUiConfigPatch).
 * @param v Dữ liệu thô cần phân tích thành NavEntry.
 * @returns Đối tượng NavEntry chuẩn hóa hoặc null nếu dữ liệu không hợp lệ.
 */
function entryFrom(v: unknown): NavEntry | null {
  // Bước 1: Kiểm tra cấu trúc object cơ bản và đảm bảo thuộc tính to là chuỗi ký tự.
  if (!isRecord(v) || typeof v.to !== "string") return null;
  // Bước 2: Cắt bỏ khoảng trắng thừa ở hai đầu của đường dẫn to và nhãn label.
  const to = v.to.trim();
  const label = typeof v.label === "string" ? v.label.trim() : undefined;
  // Bước 3: Đóng gói thành NavEntry; chỉ gán thuộc tính label cho liên kết ngoài, dock nhận giá trị boolean chặt chẽ.
  return isLinkTab(to) ? { to, dock: v.dock === true, label } : { to, dock: v.dock === true };
}

/**
 * The config to draw with, from whatever is stored. Never throws: a role whose menu cannot be
 * used, or a number out of range, falls back to the default on its own.
 */
/**
 * Làm gì: Chuyển đổi dữ liệu cấu hình thô từ database hoặc API thành UiConfig hoàn chỉnh để render giao diện; tự động fallback về giá trị mặc định nếu dữ liệu hỏng hoặc nằm ngoài khoảng cho phép mà không bao giờ ném lỗi.
 * Được gọi ở: src/server/controllers/handlers/ops.ts (flagsGet), src/client/lib/use-centre.ts (useCentre), src/client/components/menu-settings.tsx (MenuSettings).
 * @param raw Dữ liệu cấu hình thô đọc từ cột center_settings.ui_config hoặc endpoint GET /flags.
 * @returns Cấu hình UiConfig an toàn gồm nav (danh sách tab của từng vai trò) và limits (giới hạn độ dài các danh sách).
 */
export function uiConfigFrom(raw: unknown): UiConfig {
  // Bước 1: Trích xuất các đối tượng nav và limits từ dữ liệu thô, dùng object rỗng nếu dữ liệu không đúng dạng.
  const r = isRecord(raw) ? raw : {};
  const navRaw = isRecord(r.nav) ? r.nav : {};
  const limitsRaw = isRecord(r.limits) ? r.limits : {};
  const nav = {} as Record<NavRole, NavEntry[]>;
  // Bước 2: Duyệt từng vai trò trong NAV_ROLES để chuẩn hóa danh sách tab; nếu menu bị lỗi hoặc không đạt navProblem thì tự động fallback về defaultNav(role).
  for (const role of NAV_ROLES) {
    const list = Array.isArray(navRaw[role]) ? navRaw[role].map(entryFrom) : null;
    const items = list && list.every((x): x is NavEntry => x !== null) ? list : null;
    nav[role] = items && navProblem(role, items) === null ? items : defaultNav(role);
  }
  // Bước 3: Khởi tạo limits từ DEFAULT_LIMITS; chỉ ghi đè khi giá trị trong limitsRaw là số nguyên hợp lệ trong khoảng [min, max].
  const limits = { ...DEFAULT_LIMITS };
  for (const k of LIMIT_KEYS) {
    const n = Number(limitsRaw[k]);
    if (Number.isInteger(n) && n >= LIMITS[k].min && n <= LIMITS[k].max) limits[k] = n;
  }
  // Bước 4: Trả về đối tượng UiConfig an toàn để client vẽ giao diện mà không lo lỗi sập ứng dụng.
  return { nav, limits };
}

/**
 * A patch checked for saving. Returns the config to store, or the field and message to show.
 * Only what was sent is checked; the rest of the stored config stays.
 */
/**
 * Làm gì: Xác thực bản vá cập nhật cấu hình giao diện (PATCH payload) gửi từ client, hợp nhất với cấu hình đang lưu trong database và trả về dữ liệu chuẩn để lưu hoặc thông tin lỗi gắn với từng trường cụ thể.
 * Được gọi ở: src/server/controllers/handlers/desk.ts (hàm settingsPatch xử lý route PATCH /settings).
 * @param raw Dữ liệu cập nhật ui_config gửi lên từ client trong request body.
 * @param stored Cấu hình ui_config hiện tại đang lưu trong cột center_settings.ui_config của database.
 * @returns Kết quả { ok: true, value: { nav, limits } } nếu hợp lệ, hoặc { ok: false, field, message } nếu xác thực thất bại.
 */
export function parseUiConfigPatch(
  raw: unknown,
  stored: unknown,
): { ok: true; value: { nav: Partial<Record<NavRole, NavEntry[]>>; limits: Partial<Limits> } } | { ok: false; field: string; message: string } {
  // Bước 1: Kiểm tra payload gửi lên phải là đối tượng hợp lệ; sao chép cấu hình nền tảng từ stored để hợp nhất từng phần.
  if (!isRecord(raw)) return { ok: false, field: "ui_config", message: "The menu settings could not be read." };
  const base = isRecord(stored) ? stored : {};
  const nav: Partial<Record<NavRole, NavEntry[]>> = isRecord(base.nav) ? { ...(base.nav as Partial<Record<NavRole, NavEntry[]>>) } : {};
  const limits: Partial<Limits> = isRecord(base.limits) ? { ...(base.limits as Partial<Limits>) } : {};
  // Bước 2: Xử lý cập nhật nav nếu client có gửi; duyệt qua từng vai trò để cập nhật, xóa hoặc kiểm tra lỗi.
  if (raw.nav !== undefined) {
    if (!isRecord(raw.nav)) return { ok: false, field: "ui_config", message: "The menu settings could not be read." };
    for (const role of NAV_ROLES) {
      const v = raw.nav[role];
      // Bỏ qua các vai trò không được gửi trong bản vá để giữ nguyên cấu hình đã lưu trước đó.
      if (v === undefined) continue;
      // Nếu giá trị là null, xóa cấu hình tùy biến của vai trò đó để hệ thống quay lại menu mặc định xuất xưởng.
      if (v === null) {
        delete nav[role];
        continue;
      }
      if (!Array.isArray(v)) return { ok: false, field: `nav.${role}`, message: "The menu settings could not be read." };
      const items = v.map(entryFrom);
      if (items.some((x) => x === null)) return { ok: false, field: `nav.${role}`, message: "The menu settings could not be read." };
      // Xác thực tính hợp lệ của toàn bộ menu vai trò bằng navProblem; trả về lỗi gắn với trường nav.<role> nếu vi phạm.
      const problem = navProblem(role, items as NavEntry[]);
      if (problem) return { ok: false, field: `nav.${role}`, message: problem };
      nav[role] = items as NavEntry[];
    }
  }
  // Bước 3: Xử lý cập nhật limits nếu client có gửi; kiểm tra từng khóa theo khoảng [min, max] quy định trong LIMITS.
  if (raw.limits !== undefined) {
    if (!isRecord(raw.limits)) return { ok: false, field: "ui_config", message: "The list lengths could not be read." };
    for (const k of LIMIT_KEYS) {
      const v = raw.limits[k];
      if (v === undefined) continue;
      // Nếu giá trị là null hoặc chuỗi rỗng, xóa tùy biến để giá trị giới hạn quay về mặc định ban đầu.
      if (v === null || v === "") {
        delete limits[k];
        continue;
      }
      const n = Number(v);
      const { min, max } = LIMITS[k];
      // Bắt buộc giá trị phải là số nguyên nằm trong khoảng [min, max] cho phép của mục cấu hình đó.
      if (!Number.isInteger(n) || n < min || n > max) {
        return { ok: false, field: `limits.${k}`, message: `Enter a whole number from ${min} to ${max}.` };
      }
      limits[k] = n;
    }
  }
  // Bước 4: Toàn bộ bản vá hợp lệ, trả về đối tượng nav và limits đã hợp nhất sẵn sàng lưu vào database.
  return { ok: true, value: { nav, limits } };
}
