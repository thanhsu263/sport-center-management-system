/**
 * File: src/client/components/menu-settings.tsx
 * Vai trò: Giao diện quản lý cấu hình thanh điều hướng (menu/tabs) và giới hạn độ dài danh sách rút gọn (limits).
 * Vị trí trong app: Được nhúng trong trang cài đặt hệ thống của quản lý (/manager/settings), cho phép tùy biến thanh tab theo từng vai trò (role) và độ dài các danh sách hiển thị trước khi bấm "Xem thêm".
 */
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ExternalLink, X } from "lucide-react";
import { SectionTitle } from "@/client/components/section";
import { pageInfo } from "@/client/components/shell";
import { Button, Card, Check, Field, Input, LoadError, Select, Seg, Skeleton } from "@/client/components/ui";
import { Reveal } from "@/client/components/motion";
import { ApiClientError, apiPatch } from "@/client/arena3/client";
import { roleLabel } from "@/shared/arena3/labels";
import { t, tk, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";
import {
  LIMITS,
  LIMIT_KEYS,
  LINK_LABEL_MAX,
  MAX_LINKS,
  NAV_PAGES,
  NAV_ROLES,
  defaultNav,
  isLinkTab,
  navProblem,
  uiConfigFrom,
  type LimitKey,
  type NavEntry,
  type NavRole,
  type UiConfig,
} from "@/shared/ui-config";

// Marked here so the extractor sees them; ui-config.ts stays free of imports.
tk("Free hours on the member home");
tk("Bookings shown before \"Show more\"");
tk("Other hours suggested when one is taken");
tk("Days with the most free hours");
tk("Sessions in the coach's \"Below minimum\" list");
tk("Upcoming sessions on the desk");
tk("Recent gate check-ins on the desk");
tk("Peak hours named in the report");
tk("An hour counts as peak from (% of the busiest)");

type Draft = { nav: Record<NavRole, NavEntry[]>; limits: Record<LimitKey, string> };

/**
 * Làm gì: Chuyển đổi cấu hình giao diện chuẩn (UiConfig) thành đối tượng Draft cho form state, ép kiểu các giá trị giới hạn số thành chuỗi để thuận tiện xử lý trong ô nhập liệu.
 * Được gọi ở:
 * - src/client/components/menu-settings.tsx: khởi tạo state draft trong MenuSettings
 * - src/client/components/menu-settings.tsx: hàm save, cập nhật lại draft sau khi PATCH /settings thành công
 * - src/client/components/menu-settings.tsx: nút "Put the lengths back as shipped" (khôi phục giới hạn mặc định)
 * @param ui Cấu hình giao diện gốc (UiConfig) nhận từ server hoặc giá trị mặc định.
 * @returns Đối tượng Draft chứa cấu hình nav và limits dạng chuỗi.
 */
function draftFrom(ui: UiConfig): Draft {
  return {
    nav: ui.nav,
    // Chuyển số thành chuỗi để ô input xử lý mượt mà khi người dùng đang nhập hoặc tạm xóa trống.
    limits: Object.fromEntries(LIMIT_KEYS.map((k) => [k, String(ui.limits[k])])) as Record<LimitKey, string>,
  };
}

/**
 * Làm gì: Kiểm tra giá trị chuỗi nhập vào của một ô giới hạn danh sách có phải là số nguyên hợp lệ nằm trong khoảng [min, max] hay không.
 * Được gọi ở: src/client/components/menu-settings.tsx: hàm save bên trong component MenuSettings.
 * @param k Khóa định danh của mục giới hạn (LimitKey).
 * @param v Chuỗi giá trị nhập từ ô input cần kiểm tra.
 * @returns Chuỗi thông báo lỗi bản địa hóa nếu không hợp lệ, hoặc null nếu giá trị đạt yêu cầu.
 */
function limitProblem(k: LimitKey, v: string): string | null {
  const n = Number(v);
  const { min, max } = LIMITS[k];
  // Number("") sẽ trả về 0 nên bắt buộc phải kiểm tra chuỗi không rỗng trước khi kiểm tra số nguyên trong khoảng [min, max].
  return v.trim() !== "" && Number.isInteger(n) && n >= min && n <= max
    ? null
    : t("Enter a whole number from {min} to {max}.", { min, max });
}

/**
 * Manager › Settings: each role's tabs (which pages, their order, which sit in the phone's bottom
 * bar, links of the centre's own) and how many items the short lists show.
 */
/**
 * Làm gì: Component giao diện quản lý cấu hình hệ thống, cho phép quản lý tùy biến danh sách tab điều hướng (thứ tự, ghim thanh dock điện thoại, thêm liên kết ngoài) cho từng vai trò và đặt giới hạn số lượng mục hiển thị trong các danh sách rút gọn.
 * Được gọi ở: src/routes/manager.settings.tsx trong component ManagerSettings (route /manager/settings).
 * @returns Khối JSX chứa 2 phần: cài đặt menu điều hướng (Menus) và cài đặt độ dài danh sách rút gọn (List lengths).
 */
export function MenuSettings() {
  const read = useRead<{ ui?: unknown }>("/flags");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [role, setRole] = useState<NavRole>("member");
  const [linkLabel, setLinkLabel] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // Nếu lỗi phân quyền (refused) thì không cho phép thử lại; nếu lỗi mạng thì cho phép bấm reload.
  if (read.error) return <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />;
  // Ưu tiên bản nháp đang chỉnh sửa d; nếu chưa sửa thì chuyển đổi cấu hình ui từ server thành Draft.
  const d = draft ?? (read.data ? draftFrom(uiConfigFrom(read.data.ui)) : null);
  if (!d) return <Skeleton className="h-64" />;

  const items = d.nav[role];
  // Cập nhật danh sách tab cho vai trò hiện tại và xóa bỏ lỗi cũ của vai trò đó trong errors state.
  const setItems = (next: NavEntry[]) => {
    setDraft({ ...d, nav: { ...d.nav, [role]: next } });
    setErrors(({ [`nav.${role}`]: _gone, ...rest }) => rest);
  };
  // Hoán đổi vị trí tab tại chỉ số i với phần tử liền kề (by = -1 là lên trên, 1 là xuống dưới).
  const move = (i: number, by: -1 | 1) => {
    const next = [...items];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    setItems(next);
  };
  // Lọc ra các trang hệ thống của vai trò này chưa được thêm vào thanh tab, để hiển thị trong dropdown "Add a page".
  const unused = NAV_PAGES[role].filter((p) => !items.some((it) => it.to === p.to));
  const links = items.filter((it) => isLinkTab(it.to)).length;
  // Lỗi của vai trò hiện tại: ưu tiên lỗi trả về từ API backend, sau đó mới đến lỗi kiểm tra tại client.
  const problem = errors[`nav.${role}`] ?? (navProblem(role, items) ? tServer(navProblem(role, items)!) : null);

  /**
   * Làm gì: Thêm một liên kết ngoài mới vào danh sách tab của vai trò hiện tại sau khi kiểm tra tính hợp lệ bằng navProblem.
   * Được gọi ở: Sự kiện onClick của nút "Add" liên kết trong component MenuSettings.
   */
  function addLink() {
    // Bước 1: Chuẩn hóa nhãn và URL liên kết (cắt khoảng trắng thừa), tạo danh sách tab mới (mặc định không ghim dock)
    const label = linkLabel.trim();
    const to = linkUrl.trim();
    const next = [...items, { to, label, dock: false }];
    // Bước 2: Kiểm tra tính hợp lệ của menu (số lượng liên kết tối đa, URL hợp lệ); nếu vi phạm thì ghi nhận lỗi và dừng
    const why = navProblem(role, next);
    if (why) {
      setErrors({ ...errors, link: tServer(why) });
      return;
    }
    // Bước 3: Cập nhật danh sách tab mới vào state, xóa trắng các ô nhập và xóa lỗi liên kết cũ
    setItems(next);
    setLinkLabel("");
    setLinkUrl("");
    setErrors(({ link: _gone, ...rest }) => rest);
  }

  /**
   * Làm gì: Xác thực toàn bộ cấu hình menu của tất cả vai trò và các giá trị giới hạn, sau đó gửi PATCH /settings để lưu cấu hình giao diện lên hệ thống.
   * Được gọi ở: Sự kiện onClick của nút "Save menus and lengths" trong component MenuSettings.
   */
  async function save() {
    // Bước 1: Kiểm tra tính hợp lệ của menu từng vai trò (navProblem) và các giá trị giới hạn (limitProblem)
    const found: Record<string, string> = {};
    for (const r of NAV_ROLES) {
      const why = navProblem(r, d!.nav[r]);
      if (why) found[`nav.${r}`] = tServer(why);
    }
    for (const k of LIMIT_KEYS) {
      const why = limitProblem(k, d!.limits[k]);
      if (why) found[`limits.${k}`] = why;
    }
    setErrors(found);
    // Bước 2: Tự động chuyển tab sang vai trò đầu tiên có lỗi để người dùng thấy ngay vấn đề cần sửa
    const firstNav = NAV_ROLES.find((r) => found[`nav.${r}`]);
    if (firstNav) setRole(firstNav);
    // Bước 3: Nếu có bất kỳ lỗi nào thì hiển thị thông báo lỗi (toast.error) và dừng, không gửi API
    if (Object.keys(found).length) {
      toast.error(t("Some settings need fixing before they can be saved."));
      return;
    }
    // Bước 4: Chuyển đổi các giới hạn từ chuỗi sang số nguyên và gửi PATCH /settings lên server
    setSaving(true);
    try {
      const limits = Object.fromEntries(LIMIT_KEYS.map((k) => [k, Number(d!.limits[k])]));
      const r = await apiPatch<{ ui_config?: unknown }>("/settings", { ui_config: { nav: d!.nav, limits } });
      setDraft(draftFrom(uiConfigFrom(r.ui_config)));
      toast.success(t("Saved. Menus change as people move to their next page."));
    } catch (e) {
      // Bước 5: Bắt lỗi trả về từ API backend; nếu có lỗi trường cụ thể thì gán lỗi và chuyển tab tương ứng
      if (e instanceof ApiClientError && e.body.field) {
        const field = e.body.field;
        setErrors({ [field]: tServer(e.message) });
        const r = NAV_ROLES.find((x) => field === `nav.${x}`);
        if (r) setRole(r);
      }
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      // Bước 6: Tắt cờ trạng thái saving khi hoàn tất (dù thành công hay thất bại)
      setSaving(false);
    }
  }

  return (
    <>
      <SectionTitle text={tk("Menus")} className="mb-1 mt-8 font-display text-2xl" />
      <p className="mb-3 max-w-2xl text-sm text-muted">
        {t("Choose the tabs each role sees, in order. Tabs marked for the bottom bar sit there on a phone and stay one click away on a laptop; the rest go under More.")}
      </p>
      <Reveal>
        <Card className="grid gap-4">
          <Seg
            value={role}
            onChange={(v) => setRole(v as NavRole)}
            options={NAV_ROLES.map((r) => ({ value: r, label: t(roleLabel(r)) }))}
          />
          {problem ? (
            <p role="alert" className="text-sm text-danger">
              {problem}
            </p>
          ) : null}
          <ol className="grid gap-1.5">
            {items.map((it, i) => {
              const link = isLinkTab(it.to);
              const info = link ? null : pageInfo(role, it.to);
              const Icon = info?.icon ?? ExternalLink;
              const name = link ? (it.label ?? it.to) : info ? t(info.label) : it.to;
              return (
                <li
                  key={it.to}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius-md)] border border-line bg-surface px-3 py-1.5"
                >
                  <span className="w-5 text-right font-mono text-xs text-subtle">{i + 1}</span>
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-muted" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{name}</span>
                    <span className="block truncate text-xs text-muted">{link ? it.to : t(info?.group ?? "")}</span>
                  </span>
                  <Check
                    checked={it.dock}
                    onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, dock: e.target.checked } : x)))}
                    label={t("Bottom bar")}
                  />
                  <span className="flex items-center gap-0.5">
                    <IconButton label={t("Move {name} up", { name })} disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp className="size-4" />
                    </IconButton>
                    <IconButton label={t("Move {name} down", { name })} disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                      <ArrowDown className="size-4" />
                    </IconButton>
                    <IconButton label={t("Remove {name}", { name })} disabled={items.length === 1} onClick={() => setItems(items.filter((_, j) => j !== i))}>
                      <X className="size-4" />
                    </IconButton>
                  </span>
                </li>
              );
            })}
          </ol>

          <div className="grid gap-3 md:grid-cols-2">
            <Field label={t("Add a page")} tone="muted" hint={unused.length ? undefined : t("Every page this role can open is already a tab.")}>
              <Select
                value=""
                disabled={!unused.length}
                onChange={(e) => e.target.value && setItems([...items, { to: e.target.value, dock: false }])}
              >
                <option value="">{t("Choose a page")}</option>
                {unused.map((p) => {
                  const info = pageInfo(role, p.to);
                  return (
                    <option key={p.to} value={p.to}>
                      {info ? t(info.label) : p.to}
                    </option>
                  );
                })}
              </Select>
            </Field>
            <div className="grid gap-1.5">
              <p className="text-sm font-medium">{t("Add a link")}</p>
              <div className="flex flex-wrap gap-2">
                <Input
                  className="w-36"
                  aria-label={t("Link name")}
                  placeholder={t("Name")}
                  maxLength={LINK_LABEL_MAX}
                  value={linkLabel}
                  onChange={(e) => setLinkLabel(e.target.value)}
                />
                <Input
                  className="min-w-0 flex-1"
                  type="url"
                  inputMode="url"
                  aria-label={t("Link address")}
                  placeholder="https://"
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                />
                <Button size="sm" variant="outline" disabled={links >= MAX_LINKS || !linkLabel.trim() || !linkUrl.trim()} onClick={addLink}>
                  {t("Add")}
                </Button>
              </div>
              <p className={errors.link ? "text-xs text-danger" : "text-xs text-muted"} role={errors.link ? "alert" : undefined}>
                {errors.link ?? t("Opens in a new browser tab: a booking form, a group chat, the centre's page.")}
              </p>
            </div>
          </div>
          <div>
            <Button size="sm" variant="outline" onClick={() => setItems(defaultNav(role))}>
              {t("Put this menu back as it shipped")}
            </Button>
          </div>
        </Card>
      </Reveal>

      <SectionTitle text={tk("List lengths")} className="mb-1 mt-8 font-display text-2xl" />
      <p className="mb-3 max-w-2xl text-sm text-muted">{t("How many items the short lists show before the full page.")}</p>
      <Reveal>
        <Card className="grid gap-3 md:grid-cols-2">
          {LIMIT_KEYS.map((k) => (
            <Field
              key={k}
              label={t(LIMITS[k].label)}
              tone={errors[`limits.${k}`] ? "danger" : "muted"}
              hint={errors[`limits.${k}`] ?? t("{min} to {max}, shipped as {def}", LIMITS[k])}
            >
              <Input
                inputMode="numeric"
                value={d.limits[k]}
                aria-invalid={errors[`limits.${k}`] ? true : undefined}
                onChange={(e) => {
                  setDraft({ ...d, limits: { ...d.limits, [k]: e.target.value } });
                  setErrors(({ [`limits.${k}`]: _gone, ...rest }) => rest);
                }}
              />
            </Field>
          ))}
          <div className="flex flex-wrap gap-2 md:col-span-2">
            <Button disabled={saving} onClick={() => void save()}>
              {saving ? t("Saving…") : t("Save menus and lengths")}
            </Button>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => setDraft({ ...d, limits: draftFrom(uiConfigFrom(null)).limits })}
            >
              {t("Put the lengths back as shipped")}
            </Button>
          </div>
        </Card>
      </Reveal>
    </>
  );
}

/**
 * Làm gì: Nút bấm hình vuông nhỏ gọn hiển thị icon thao tác (di chuyển lên/xuống, xóa tab), hỗ trợ nhãn tiếp cận (aria-label) và tooltip (title).
 * Được gọi ở: Nội bộ file src/client/components/menu-settings.tsx (các nút di chuyển và xóa tab trong MenuSettings).
 * @param props.label Nhãn mô tả hành động dành cho tooltip và công nghệ hỗ trợ đọc màn hình (screen reader).
 * @param props.disabled Cờ vô hiệu hóa nút bấm khi không thể thao tác (ví dụ đang ở đầu/cuối danh sách).
 * @param props.onClick Hàm xử lý khi người dùng bấm nút.
 * @param props.children Phần tử icon SVG con hiển thị bên trong nút.
 * @returns Khối button đã được định dạng kích thước và hiệu ứng hover.
 */
function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-11 place-items-center rounded-[var(--radius-sm)] text-muted transition-colors duration-150 hover:bg-wood hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent sm:size-8"
    >
      {children}
    </button>
  );
}
