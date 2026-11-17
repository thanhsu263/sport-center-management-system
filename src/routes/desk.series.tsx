/**
 * File này quản lý trang đặt lịch sân cố định hàng tuần (/desk/series) dành cho nhân viên lễ tân và quản lý.
 * Cho phép khách hàng đặt một khung giờ cố định trên cùng một sân qua nhiều tuần liên tiếp (series booking)
 * với mức giá ưu đãi trọn gói trả trước, đồng thời theo dõi và quản lý các gói đặt sân đang hoạt động.
 */
import { createFileRoute } from "@tanstack/react-router";
import { CalendarPlus, Repeat } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { SectionTitle } from "@/client/components/section";
import { Shell, money, when, useSessionUser } from "@/client/components/shell";
import {
  Badge,
  Button,
  Card,
  Check,
  DateField,
  EmptyState,
  Field,
  Input,
  LoadError,
  Modal,
  Seg,
  Select,
  Skeleton,
} from "@/client/components/ui";
import { Reveal, Stagger, StaggerItem } from "@/client/components/motion";
import { TillNotice, useTillOpen } from "@/client/components/till-notice";
import { ApiClientError, apiGet, apiPost } from "@/client/arena3/client";
import { addDaysISO, formatDate, sportLabel, todayISO } from "@/shared/arena3/labels";
import { t, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";

/**
 * Làm gì: Định nghĩa route `/desk/series` cho TanStack Router, kết nối URL với component Page quản lý đặt lịch cố định.
 * Được gọi ở: /desk/series
 */
export const Route = createFileRoute("/desk/series")({ component: Page });

type Court = { id: string; court_code: string; sport: string; status: string };
type Line = { date: string; start_at: string; list_vnd: number; price_vnd: number; is_peak: boolean; available: boolean; reason?: string };
type Preview = {
  court_code: string;
  customer: { name: string; phone: string; is_member: boolean };
  discount_pct: number;
  min_weeks: number;
  lines: Line[];
  booked: number;
  skipped: number;
  list_total_vnd: number;
  total_vnd: number;
};
type Series = {
  id: string;
  code: string;
  weekday: number;
  start_local: string;
  weeks: number;
  starts_on: string;
  discount_pct: number;
  status: string;
  court_code: string;
  customer: string;
  phone: string;
  remaining: number;
  next_at: string | null;
};
/** The few centre settings the form needs: how long a block may run and when the doors are open. */
type Cfg = {
  series_min_weeks: number;
  series_max_weeks: number;
  open_time: string;
  close_time: string;
  slot_minutes: number;
};

// Cấu hình mặc định dự phòng khi chưa tải được thông tin thiết lập từ server (/settings).
const FALLBACK: Cfg = { series_min_weeks: 4, series_max_weeks: 12, open_time: "06:00", close_time: "22:00", slot_minutes: 60 };

/**
 * Làm gì: Chuyển đổi chuỗi giờ "HH:MM" thành tổng số phút tính từ đầu ngày (00:00).
 * Được gọi ở: src/routes/desk.series.tsx trong hàm startTimes().
 * @param hhmm Chuỗi thời gian định dạng "HH:MM".
 * @returns Tổng số phút tính từ 00:00.
 */
function minutes(hhmm: string) {
  const [h = 0, m = 0] = hhmm.slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

/** Every start time a slot can begin at, from opening time to the last slot that still ends before closing. */
function startTimes(cfg: Cfg) {
  const out: string[] = [];
  // Bước nhảy thời gian theo độ dài mỗi ca (slot), mặc định là 60 phút nếu cấu hình không hợp lệ.
  const step = cfg.slot_minutes > 0 ? cfg.slot_minutes : 60;
  // Chỉ tạo các mốc giờ mà ca chơi kết thúc trước hoặc đúng thời điểm đóng cửa.
  for (let m = minutes(cfg.open_time); m + step <= minutes(cfg.close_time); m += step) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  }
  return out;
}

/** The week counts offered as buttons: all of them when there are few, else a handful of round ones. */
function weekChoices(min: number, max: number) {
  if (max - min < 9) return Array.from({ length: max - min + 1 }, (_, i) => min + i);
  // Nếu khoảng tuần rộng, chỉ gợi ý các mốc tuần tròn phổ biến (8, 12, 16, 24) nằm trong khoảng min-max để giao diện gọn gàng.
  return [...new Set([min, 8, 12, 16, 24, max])].filter((n) => n >= min && n <= max).sort((a, b) => a - b);
}

/**
 * Làm gì: Chuyển đổi số thứ tự ngày trong tuần (0: Chủ Nhật đến 6: Thứ Bảy) thành tên ngày theo ngôn ngữ hiển thị.
 * Được gọi ở: src/routes/desk.series.tsx trong component Page (phần tóm tắt lịch và danh sách series).
 * @param w Chỉ số ngày trong tuần từ 0 (Chủ Nhật) đến 6 (Thứ Bảy).
 * @returns Tên thứ trong tuần đã được bản địa hóa.
 */
function weekdayName(w: number) {
  return [t("Sunday"), t("Monday"), t("Tuesday"), t("Wednesday"), t("Thursday"), t("Friday"), t("Saturday")][w] ?? "";
}

/**
 * Làm gì: Xác định thứ trong tuần (0-6) từ chuỗi ngày định dạng ISO "YYYY-MM-DD".
 * Được gọi ở: src/routes/desk.series.tsx trong component Page (khi xác định thứ của ngày bắt đầu).
 * @param iso Chuỗi ngày định dạng chuẩn ISO "YYYY-MM-DD".
 * @returns Số thứ tự ngày trong tuần từ 0 (Chủ Nhật) đến 6 (Thứ Bảy).
 */
function weekdayOf(iso: string) {
  const [y = 1970, m = 1, d = 1] = iso.slice(0, 10).split("-").map(Number);
  // Dùng Date.UTC để tránh lệch ngày do múi giờ địa phương.
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * Làm gì: Hiển thị giao diện bàn lễ tân để tạo gói đặt sân cố định hàng tuần và theo dõi các gói series đang chạy.
 * Được gọi ở: /desk/series (thông qua Route)
 * @returns Giao diện quản lý đặt sân cố định theo tuần.
 */
function Page() {
  // Bước 1: Khởi tạo state, kiểm tra quyền truy cập và nạp dữ liệu sân, lịch đặt cố định.
  const user = useSessionUser();
  // Phân quyền: chỉ quản lý (manager) mới có quyền chỉnh sửa cấu hình và không bắt buộc mở ca thu ngân.
  const role = user?.role === "manager" ? "manager" : "receptionist";
  const form = useRef<HTMLFormElement>(null);
  const courtsRead = useRead<{ items: Court[] }>("/courts");
  const seriesRead = useRead<{ items: Series[] }>("/series");
  // Chỉ giữ lại những sân ở trạng thái "ready" (sẵn sàng hoạt động) để khách đặt lịch.
  const courts = useMemo(() => (courtsRead.data?.items ?? []).filter((x) => x.status === "ready"), [courtsRead.data]);
  // null = not known yet (still asking, or the question failed) — never an empty list.
  const list = seriesRead.data?.items ?? null;
  const [cfg, setCfg] = useState<Cfg>(FALLBACK);
  const [courtId, setCourtId] = useState("");
  const [date, setDate] = useState(todayISO());
  const [time, setTime] = useState("19:00");
  const [weeks, setWeeks] = useState(8);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [method, setMethod] = useState("cash");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ field?: string; message: string } | null>(null);
  const [stopping, setStopping] = useState<Series | null>(null);
  // Lễ tân bắt buộc phải có ca thu ngân đang mở thì mới được phép thu tiền đặt cọc hoặc thanh toán.
  const tillOpen = useTillOpen(role === "receptionist");

  // Bước 2: Tự động chọn sân đầu tiên làm mặc định khi danh sách sân được nạp.
  useEffect(() => {
    setCourtId((cur) => cur || courts[0]?.id || "");
  }, [courts]);
  // Bước 3: Nạp cấu hình hoạt động của trung tâm từ server (giờ mở/đóng cửa, giới hạn số tuần đặt).
  useEffect(() => {
    // The limits are the manager's to change, so they are read, not hard-coded. Failing to read
    // them is not fatal: the server still enforces the real ones when the weeks are checked.
    void apiGet<Partial<Cfg>>("/settings")
      .then((s) =>
        setCfg({
          series_min_weeks: Number(s.series_min_weeks ?? FALLBACK.series_min_weeks),
          series_max_weeks: Number(s.series_max_weeks ?? FALLBACK.series_max_weeks),
          open_time: String(s.open_time ?? FALLBACK.open_time),
          close_time: String(s.close_time ?? FALLBACK.close_time),
          slot_minutes: Number(s.slot_minutes ?? FALLBACK.slot_minutes),
        }),
      )
      .catch(() => undefined);
  }, []);

  // Bước 4: Tính toán danh sách mốc giờ bắt đầu và các tùy chọn số tuần phù hợp với cấu hình.
  const times = startTimes(cfg);
  const choices = weekChoices(cfg.series_min_weeks, Math.max(cfg.series_min_weeks, cfg.series_max_weeks));
  // Keep the picks inside what the centre allows once the settings arrive.
  useEffect(() => {
    setWeeks((w) => Math.min(Math.max(w, choices[0] ?? w), choices[choices.length - 1] ?? w));
    // Ưu tiên mốc 19:00 vì đây là khung giờ vàng khách hay đặt cố định, nếu không khả dụng thì lấy mốc đầu tiên.
    setTime((cur) => (times.includes(cur) ? cur : times.includes("19:00") ? "19:00" : (times[0] ?? cur)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg]);

  /** Any change to the form makes the checked weeks out of date, so the result is cleared with it. */
  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPreview(null);
      setErr(null);
    };

  /**
   * Làm gì: Đóng gói các giá trị nhập trên form thành payload để gửi lên API preview hoặc book series.
   * Được gọi ở: src/routes/desk.series.tsx trong hàm check() và book().
   * @returns Đối tượng payload phục vụ kiểm tra hoặc tạo lịch cố định.
   */
  const body = () => ({
    court_id: courtId,
    first_date: date,
    start_local: time,
    weeks,
    phone,
    // Khách vãng lai mới cần nhập tên; hội viên đã có sẵn hồ sơ tra cứu theo số điện thoại.
    guest_name: name || undefined,
    method,
  });

  /**
   * Làm gì: Xử lý và chuẩn hóa lỗi nhận được từ API hoặc hệ thống, hiển thị lỗi lên giao diện và focus vào ô nhập liệu tương ứng.
   * Được gọi ở: src/routes/desk.series.tsx trong hàm check() và book().
   * @param e Lỗi bắt được từ khối try/catch.
   */
  function fail(e: unknown) {
    const next =
      e instanceof ApiClientError
        ? { field: e.body.field, message: tServer(e.message) }
        : { message: e instanceof Error ? tServer(e.message) : t("Something went wrong") };
    setErr(next);
    // Put the cursor on the field that needs fixing instead of leaving it on the button.
    const el = next.field ? form.current?.elements.namedItem(next.field) : null;
    if (el instanceof HTMLElement) requestAnimationFrame(() => el.focus());
  }

  /**
   * Làm gì: Gửi dữ liệu form lên API `/series/preview` để kiểm tra độ trùng lịch từng tuần và tính tổng tiền chiết khấu trước khi đặt.
   * Được gọi ở: src/routes/desk.series.tsx khi người dùng submit form đặt lịch cố định.
   * @param e Sự kiện submit form HTML (nếu có) để chặn reload trang.
   */
  async function check(e?: FormEvent) {
    // Bước 1: Ngăn chặn reload trang, xóa lỗi cũ và đánh dấu trạng thái đang xử lý (busy).
    e?.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      // Bước 2: Gọi API preview để kiểm tra tính khả dụng của từng tuần và tính tổng tiền.
      setPreview(await apiPost<Preview>("/series/preview", body()));
    } catch (error) {
      setPreview(null);
      fail(error);
    } finally {
      // Bước 3: Tắt trạng thái bận khi kết thúc kiểm tra (dù thành công hay thất bại).
      setBusy(false);
    }
  }

  /**
   * Làm gì: Gọi API `/series` để thực hiện đặt chuỗi lịch cố định, ghi nhận thanh toán vào ca trực và cập nhật danh sách.
   * Được gọi ở: src/routes/desk.series.tsx khi người dùng bấm nút xác nhận đặt lịch trong modal xem trước.
   */
  async function book() {
    // Bước 1: Xóa thông báo lỗi trước đó và bật trạng thái đang xử lý.
    setErr(null);
    setBusy(true);
    try {
      // Bước 2: Gọi API POST /series; tham số thứ ba là true để kích hoạt xử lý thanh toán ngay trong ca trực.
      const r = await apiPost<{ booked: number; skipped: unknown[]; total_vnd: number }>("/series", body(), true);
      // Bước 3: Thông báo đặt thành công, làm mới form nhập thông tin khách và tải lại danh sách series.
      toast.success(t("{n} weeks booked · {amount}", { n: r.booked, amount: money(r.total_vnd) }));
      setPreview(null);
      setPhone("");
      setName("");
      seriesRead.reload();
    } catch (e) {
      fail(e);
    } finally {
      // Bước 4: Tắt trạng thái đang xử lý khi hoàn tất.
      setBusy(false);
    }
  }

  /**
   * Làm gì: Lấy nội dung lỗi tương ứng với một trường nhập liệu cụ thể nếu trường đó có lỗi.
   * Được gọi ở: src/routes/desk.series.tsx trong các component Field của form.
   * @param f Tên trường cần kiểm tra lỗi.
   * @returns Chuỗi thông báo lỗi hoặc undefined nếu trường không có lỗi.
   */
  const fieldErr = (f: string) => (err?.field === f ? err.message : undefined);
  // Bước 5: Phân loại danh sách series đang chạy và đã kết thúc, tính ngày buổi tập cuối cùng.
  const running = (list ?? []).filter((s) => s.status === "active" && s.remaining > 0);
  const ended = (list ?? []).filter((s) => !(s.status === "active" && s.remaining > 0));
  // Tính ngày của buổi tập cuối cùng trong chuỗi (cách ngày bắt đầu 7 ngày nhân với số tuần trừ 1).
  const last = addDaysISO(date, 7 * (weeks - 1));

  // Bước 6: Render toàn bộ giao diện đặt lịch cố định, cảnh báo ca trực và form nhập liệu.
  return (
    <Shell
      role={role}
      title={t("Fixed weekly bookings")}
      subtitle={t("Same court, same hour, every week. Paid up front for the whole block at a discount.")}
    >
      {tillOpen ? null : <TillNotice />}
      <Reveal from="down">
        <Card className="mb-4">
          <SectionTitle text={t("Set up a fixed booking")} icon={CalendarPlus} className="mb-4" />
          {/* Without the courts the form cannot be filled in, so say why before the person tries. */}
          {courtsRead.error ? (
            <div className="mb-4">
              <LoadError
                message={courtsRead.error.message}
                onRetry={courtsRead.error.refused ? undefined : courtsRead.reload}
              />
            </div>
          ) : null}
          <form ref={form} onSubmit={(e) => void check(e)} className="grid gap-5">
            <fieldset className="m-0 min-w-0 border-0 p-0">
              <legend className="kicker mb-2 p-0 text-2xs text-muted">{t("Customer")}</legend>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label={t("Phone")} hint={fieldErr("phone")}>
                  <Input
                    name="phone"
                    inputMode="tel"
                    autoComplete="off"
                    placeholder={t("09xx xxx xxx")}
                    value={phone}
                    aria-invalid={fieldErr("phone") ? true : undefined}
                    onChange={(e) => edit(setPhone)(e.target.value)}
                  />
                </Field>
                <Field
                  label={t("Name (for a guest)")}
                  hint={fieldErr("guest_name") ?? t("Only for a guest. A member is found by their phone number.")}
                  tone={fieldErr("guest_name") ? "danger" : "muted"}
                >
                  <Input
                    name="guest_name"
                    autoComplete="off"
                    value={name}
                    aria-invalid={fieldErr("guest_name") ? true : undefined}
                    onChange={(e) => edit(setName)(e.target.value)}
                  />
                </Field>
              </div>
            </fieldset>

            <fieldset className="m-0 min-w-0 border-0 p-0">
              <legend className="kicker mb-2 p-0 text-2xs text-muted">{t("Court and time")}</legend>
              <div className="grid gap-3 md:grid-cols-3">
                <Field label={t("Court")} hint={fieldErr("court_id")}>
                  <Select
                    name="court_id"
                    value={courtId}
                    disabled={!courts.length}
                    onChange={(e) => edit(setCourtId)(e.target.value)}
                  >
                    {courts.length ? (
                      courts.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.court_code} · {sportLabel(c.sport)}
                        </option>
                      ))
                    ) : (
                      <option value="">{courtsRead.data ? t("No courts") : courtsRead.error ? "-" : t("Loading")}</option>
                    )}
                  </Select>
                </Field>
                <Field label={t("First date")} hint={fieldErr("first_date")}>
                  <DateField value={date} onChange={edit(setDate)} aria-label={t("First date")} />
                </Field>
                <Field label={t("Start time")} hint={fieldErr("start_local")}>
                  <Select name="start_local" value={time} onChange={(e) => edit(setTime)(e.target.value)}>
                    {times.map((h) => (
                      <option key={h}>{h}</option>
                    ))}
                  </Select>
                </Field>
              </div>
            </fieldset>

            <fieldset className="m-0 min-w-0 border-0 p-0">
              <legend className="kicker mb-2 p-0 text-2xs text-muted">{t("Weeks")}</legend>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Seg
                  value={String(weeks)}
                  onChange={(v) => edit(setWeeks)(Number(v))}
                  options={choices.map((n) => ({ value: String(n), label: String(n) }))}
                />
                <p className="text-sm text-muted">
                  {t("Every {day} at {time} for {n} weeks, {from} to {to}", {
                    day: weekdayName(weekdayOf(date)),
                    time,
                    n: weeks,
                    from: formatDate(date),
                    to: formatDate(last),
                  })}
                </p>
              </div>
              {fieldErr("weeks") ? (
                <p role="alert" className="mt-1.5 text-sm text-danger">
                  {fieldErr("weeks")}
                </p>
              ) : null}
            </fieldset>

            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={busy || !courtId || !phone.trim()}>
                {busy ? t("Checking…") : t("Check the weeks")}
              </Button>
              {err && !err.field ? (
                <p role="alert" className="text-sm text-danger">
                  {err.message}
                </p>
              ) : null}
            </div>
          </form>
        </Card>
      </Reveal>

      {preview ? (
        <Reveal>
          <Card className="mb-6 border border-accent/30">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-display text-xl">
                  {preview.court_code} · {time} · {preview.customer.name}
                </p>
                <p className="text-xs text-muted">
                  {preview.customer.is_member ? t("Member") : t("Guest")} · {preview.customer.phone} ·{" "}
                  {t("{pct}% off for a fixed booking", { pct: preview.discount_pct })}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-muted line-through tabular-nums">{money(preview.list_total_vnd)}</p>
                <p className="font-display text-2xl tabular-nums">{money(preview.total_vnd)}</p>
                <p className="text-xs text-muted">{t("{n} weeks", { n: preview.booked })}</p>
              </div>
            </div>
            <ul className="mt-3 grid gap-1 text-sm sm:grid-cols-2">
              {preview.lines.map((l) => (
                <li
                  key={l.date}
                  className={`flex items-center justify-between gap-2 rounded-[var(--radius-sm)] px-3 py-1.5 ${l.available ? "bg-wood/50" : "bg-danger/10 text-danger"}`}
                >
                  <span>{formatDate(l.date)}</span>
                  <span className="tabular-nums">
                    {l.available ? money(l.price_vnd) : l.reason === "past" ? t("In the past") : t("Already taken: skipped")}
                  </span>
                </li>
              ))}
            </ul>
            {preview.skipped > 0 ? (
              <p className="mt-2 text-xs text-hold">{t("{n} week(s) are taken and will be left out; you are only charged for the rest.", { n: preview.skipped })}</p>
            ) : null}
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <Field label={t("Paid by")}>
                <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                  <option value="cash">{t("Cash")}</option>
                  <option value="card">{t("Card")}</option>
                  <option value="transfer">{t("Bank transfer")}</option>
                </Select>
              </Field>
              <Button onClick={() => void book()} disabled={busy || preview.booked === 0 || !tillOpen}>
                {tillOpen ? t("Take {amount} and book", { amount: money(preview.total_vnd) }) : t("Open a shift first")}
              </Button>
              <Button variant="outline" onClick={() => setPreview(null)}>
                {t("Change")}
              </Button>
            </div>
          </Card>
        </Reveal>
      ) : null}

      <SectionTitle text={t("Running now")} icon={Repeat} className="mb-3" />
      {seriesRead.error ? (
        <LoadError
          message={seriesRead.error.message}
          onRetry={seriesRead.error.refused ? undefined : seriesRead.reload}
        />
      ) : !list ? (
        <Skeleton className="h-24" />
      ) : running.length === 0 ? (
        <EmptyState
          title={list.length ? t("None running right now") : t("No fixed bookings yet")}
          hint={t("Fill in the form above to set one up for a regular.")}
        />
      ) : (
        <Stagger className="grid gap-2 md:grid-cols-2" gap={0.04}>
          {running.map((s) => (
            <StaggerItem key={s.id}>
              <SeriesCard s={s} onStop={() => setStopping(s)} />
            </StaggerItem>
          ))}
        </Stagger>
      )}

      {ended.length > 0 ? (
        <>
          <SectionTitle text={t("Ended")} className="mb-3 mt-8" />
          <div className="grid gap-2 md:grid-cols-2">
            {ended.map((s) => (
              <SeriesCard key={s.id} s={s} />
            ))}
          </div>
        </>
      ) : null}

      <StopDialog
        series={stopping}
        onClose={() => setStopping(null)}
        onDone={() => {
          setStopping(null);
          seriesRead.reload();
        }}
      />
    </Shell>
  );
}

/**
 * Làm gì: Hiển thị thẻ tóm tắt thông tin một gói đặt sân cố định hàng tuần (series), gồm sân, thứ, giờ, khách hàng, số tuần còn lại và nút dừng gói.
 * Được gọi ở: src/routes/desk.series.tsx trong component Page (danh sách đang chạy ở dòng 411, danh sách đã kết thúc ở dòng 422).
 * @param s Đối tượng Series chứa thông tin chi tiết của gói đặt sân cố định.
 * @param onStop Callback mở modal xác nhận dừng gói (chỉ áp dụng cho các gói đang hoạt động).
 * @returns JSX phần tử Card hiển thị tóm tắt gói đặt sân.
 */
function SeriesCard({ s, onStop }: { s: Series; onStop?: () => void }) {
  // Xác định gói đặt sân còn hiệu lực (live): đang ở trạng thái hoạt động (active) và còn ít nhất một tuần chưa sử dụng.
  const live = s.status === "active" && s.remaining > 0;
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
      <div>
        <p className="font-medium">
          {s.court_code} · {weekdayName(s.weekday)} {s.start_local.slice(0, 5)}
        </p>
        <p className="text-xs text-muted">
          {s.customer} · {s.phone} · <span className="font-mono">{s.code}</span>
        </p>
        <p className="mt-1 text-xs text-muted">
          {live
            ? t("{n} of {total} weeks to go", { n: s.remaining, total: s.weeks }) + (s.next_at ? ` · ${t("next")} ${when(s.next_at)}` : "")
            : s.status === "cancelled"
              ? t("Cancelled")
              : t("Finished")}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Badge tone={live ? "accent" : "muted"}>-{s.discount_pct}%</Badge>
        {live && onStop ? (
          <Button size="sm" variant="outline" onClick={onStop}>
            {t("Stop")}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * Làm gì: Modal xác nhận dừng gói đặt sân cố định hàng tuần (series), hủy tất cả các buổi còn lại và tính tiền hoàn trả theo quy định hoặc miễn phí hủy.
 * Được gọi ở: src/routes/desk.series.tsx trong component Page (dòng 428).
 * @param series Đối tượng gói đặt sân cần dừng (Series), hoặc null nếu modal đang đóng.
 * @param onClose Hàm callback đóng modal khi người dùng chọn giữ gói hoặc nhấn ra ngoài.
 * @param onDone Hàm callback xử lý sau khi hủy gói thành công để đóng modal và làm mới danh sách.
 * @returns JSX phần tử Modal xác nhận dừng gói đặt sân cố định.
 */
/** Stopping a block cancels every week still to come, so it is said out loud and confirmed first. */
function StopDialog({ series, onClose, onDone }: { series: Series | null; onClose: () => void; onDone: () => void }) {
  // Bước 1: Khởi tạo state cho tùy chọn miễn phí phạt hủy (waive) và cờ trạng thái đang gọi API (busy).
  const [waive, setWaive] = useState(false);
  const [busy, setBusy] = useState(false);
  // The dialog fades out after `series` is cleared; keep what it showed so the text does not blink away.
  const [shown, setShown] = useState<Series | null>(null);
  // Cập nhật lại dữ liệu gói cần dừng vào state shown và đặt lại tùy chọn waive khi prop series thay đổi.
  useEffect(() => {
    if (!series) return;
    setShown(series);
    setWaive(false);
  }, [series]);
  // Giữ lại dữ liệu của gói (từ shown) trong lúc modal mờ dần khi đóng, tránh giật nội dung giao diện.
  const s = series ?? shown;

  /**
   * Làm gì: Gửi yêu cầu hủy các tuần còn lại của gói đặt sân lên API backend, hiển thị kết quả hoàn tiền và kích hoạt callback hoàn tất.
   * Được gọi ở: src/routes/desk.series.tsx trong sự kiện onClick của nút xác nhận dừng (dòng 508).
   * @returns Promise<void>
   * @throws Bắt lỗi nội bộ và hiển thị thông báo lỗi qua toast, không ném lỗi ra ngoài.
   */
  async function go() {
    // Bước 1: Kiểm tra gói hợp lệ và bật trạng thái bận để vô hiệu hóa nút, tránh người dùng bấm trùng lặp.
    if (!series) return;
    setBusy(true);
    try {
      // Bước 2: Gọi API POST /series/:id/cancel để hủy các buổi còn lại của gói kèm tùy chọn miễn phí phạt hủy (waive).
      const r = await apiPost<{ cancelled: number; refunded_vnd: number }>(`/series/${series.id}/cancel`, { waive });
      // Bước 3: Thông báo số tuần đã hủy kèm số tiền hoàn cho khách qua toast, sau đó kích hoạt callback onDone để làm mới dữ liệu.
      toast.success(t("{n} weeks cancelled · refunded {amount}", { n: r.cancelled, amount: money(r.refunded_vnd) }));
      onDone();
    } catch (e) {
      // Bước 4: Bắt lỗi nếu gọi API thất bại và hiển thị thông báo lỗi từ server hoặc lỗi mặc định qua toast.
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      // Bước 5: Tắt trạng thái bận để khôi phục lại các nút bấm trên modal.
      setBusy(false);
    }
  }

  // Bước 2: Render Modal xác nhận dừng gói đặt sân, hiển thị số tuần còn lại và tùy chọn miễn phí phạt hủy khi gặp sự cố bất khả kháng.
  return (
    <Modal
      open={!!series}
      onClose={onClose}
      title={t("Stop this fixed booking?")}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("Keep it")}
          </Button>
          <Button variant="danger" onClick={() => void go()} disabled={busy}>
            {busy ? t("Stopping…") : t("Yes, stop it")}
          </Button>
        </>
      }
    >
      {s ? (
        <div className="grid gap-3 text-sm">
          <p className="font-medium">
            {s.court_code} · {weekdayName(s.weekday)} {s.start_local.slice(0, 5)} · {s.customer}
          </p>
          <p>{t("{n} weeks are still to come. Each one is refunded by the normal cancellation rules.", { n: s.remaining })}</p>
          <Check
            checked={waive}
            onChange={(e) => setWaive(e.target.checked)}
            label={t("Waive the fee")}
            hint={t("For cancellations that are not the customer's doing: centre closed, flood, accident.")}
          />
        </div>
      ) : null}
    </Modal>
  );
}
