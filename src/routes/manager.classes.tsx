/**
 * Quản lý danh sách lớp học và lịch học (Classes & Sessions) dành cho vai trò Quản lý (Manager).
 * Tệp này định nghĩa trang `/manager/classes`, cung cấp các chức năng:
 * - Xem số liệu thống kê nhanh (lớp đang mở, lớp nháp, tổng số học viên đăng ký).
 * - Lọc danh sách lớp học theo huấn luyện viên, thứ trong tuần và buổi trong ngày.
 * - Tạo lớp học mới theo quy tắc lặp lại hàng tuần (RRULE) và tự động xuất bản (publish) các buổi học.
 * - Quản lý chi tiết từng lớp học (danh sách buổi học, học viên ghi danh) qua ClassDetailModal.
 */
import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Shell, money } from "@/client/components/shell";
import { PageHero } from "@/client/components/page-hero";
import { StatStrip } from "@/client/components/stat-strip";
import { SportBadge, useSports } from "@/client/components/sports-ui";
import { Badge, Button, Card, DateField, EmptyState, Field, Input, LoadError, Select, ShowMore, Skeleton, StatusBadge } from "@/client/components/ui";
import { Lift, Reveal, Stagger, StaggerItem, motion } from "@/client/components/motion";
import { SpotlightCard } from "@/client/components/fx";
import { ClassDetailModal } from "@/client/components/class-detail";
import { MinSizeBadge } from "@/client/components/class-extras";
import { ApiClientError, apiPost } from "@/client/arena3/client";
import { ictDateString } from "@/shared/arena3/time";
import { classSlotMatches, composeWeeklyRrule, levelLabel, rruleLabel, sportLabel, todayISO, addDaysISO, formatDate } from "@/shared/arena3/labels";
import { t, tk, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";
import { useCentre } from "@/client/lib/use-centre";
import { hoursOf } from "@/client/lib/venue";
import { HighlightBadge, useLive } from "@/client/lib/use-live";

/**
 * Làm gì: Định nghĩa route `/manager/classes` của TanStack Router, liên kết URL tới component Page để quản lý các lớp học.
 * Được gọi ở: URL `/manager/classes` (cấu hình trong src/shared/ui-config.ts, điều hướng từ menu Quản lý hoặc trang chi tiết hội viên).
 * @returns Route definition object của TanStack Router dành cho trang `/manager/classes`.
 */
export const Route = createFileRoute("/manager/classes")({
  component: Page,
});

/** Matches MAX_CLASS_CAPACITY in the classes handler, which refuses anything above it. */
const MAX_CAPACITY = 200;

// Danh sách các thứ trong tuần kèm mã 2 ký tự theo chuẩn iCal RRULE (MO, TU,...) dùng để cấu hình lịch lặp lại.
const DAYS = [
  { k: "MO", l: tk("Mon") },
  { k: "TU", l: tk("Tue") },
  { k: "WE", l: tk("Wed") },
  { k: "TH", l: tk("Thu") },
  { k: "FR", l: tk("Fri") },
  { k: "SA", l: tk("Sat") },
  { k: "SU", l: tk("Sun") },
];

// Kiểu dữ liệu đại diện cho một dòng thông tin lớp học trả về từ API /classes.
type ClassRow = {
  id: string;
  code: string;
  sport: string;
  level: string;
  status: string;
  court_code: string;
  coach_name: string;
  enrolled_count: number;
  confirmed_count: number;
  running_below_minimum: boolean;
  capacity: number;
  rrule?: string;
  duration_min?: number;
  price_vnd?: number | null;
  min_enrolled?: number | null;
};

/**
 * Làm gì: Component giao diện trang quản lý lớp học; hiển thị tổng quan số liệu, bộ lọc tìm kiếm, form tạo mới và danh sách các lớp học cùng trạng thái hoạt động.
 * Được gọi ở: Route `/manager/classes` (src/routes/manager.classes.tsx) khi người dùng truy cập trang quản lý lớp học.
 * @returns Giao diện React hoàn chỉnh của trang quản lý lớp học nằm trong khung layout Shell role="manager".
 */
function Page() {
  // Bước 1: Khởi tạo dữ liệu và trạng thái trang (tải danh sách lớp học, sân thể thao, huấn luyện viên đang hoạt động).
  const { venue } = useCentre();
  // Giới hạn 8 lớp học mỗi lần hiển thị ban đầu để tối ưu tốc độ render danh sách.
  const [limit, setLimit] = useState(8);
  const classesRead = useRead<{ items: ClassRow[] }>("/classes");
  const courtsRead = useRead<{ items: Array<{ id: string; court_code: string; sport: string }> }>("/courts");
  // Chỉ lấy nhân sự có vai trò coach và trạng thái đang hoạt động (active) để phân công phụ trách lớp.
  const coachesRead = useRead<{ items: Array<{ id: string; full_name: string; sports: string[] | null }> }>(
    "/staff?role=coach&status=active",
  );
  const items = classesRead.data?.items ?? null;
  // Bước 2: Thiết lập bộ lọc và xử lý danh sách lớp học theo huấn luyện viên, thứ trong tuần, buổi và trạng thái huỷ.
  // Cancelled classes stay on record but are folded away; the server sends the newest first.
  const [showCancelled, setShowCancelled] = useState(false);
  const cancelledCount = items?.filter((c) => c.status === "cancelled").length ?? 0;
  // The same coach, weekday and time-of-day filters members have, to find a class without scrolling.
  const [coach, setCoach] = useState("");
  const [day, setDay] = useState("");
  const [part, setPart] = useState("");
  const filtering = !!(coach || day || part);
  // Trích xuất danh sách tên HLV duy nhất từ các lớp học và sắp xếp theo thứ tự bảng chữ cái tiếng Việt.
  const coachNames = [...new Set((items ?? []).map((c) => c.coach_name))].sort((a, b) => a.localeCompare(b, "vi"));
  // Lọc danh sách lớp học: loại bỏ lớp đã huỷ (nếu không bật xem lớp huỷ), lọc theo HLV và khớp lịch lặp lại (rrule).
  const listed = items
    ? (showCancelled ? items : items.filter((c) => c.status !== "cancelled"))
        .filter((c) => !coach || c.coach_name === coach)
        .filter((c) => classSlotMatches(c.rrule, day, part))
    : null;
  // Reset số lượng hiển thị về 8 khi người dùng thay đổi bất kỳ tiêu chí lọc nào để xem từ đầu kết quả mới.
  useEffect(() => setLimit(8), [coach, day, part]);
  const courts = useMemo(() => courtsRead.data?.items ?? [], [courtsRead.data]);
  const coaches = useMemo(() => coachesRead.data?.items ?? [], [coachesRead.data]);
  // The form can only say "no coach teaches this" once the coaches have really been read.
  const loaded = !!courtsRead.data && !!coachesRead.data;
  const formError = courtsRead.error ?? coachesRead.error;
  // The class whose sessions and roster are open (B-08).
  const [detail, setDetail] = useState<string | null>(null);
  // Bước 3: Khởi tạo state cho form tạo mới lớp học với các thông số mặc định (lặp thứ Ba/Năm lúc 19:00, thời lượng 60 ngày).
  const [creating, setCreating] = useState(false);
  const [days, setDays] = useState<string[]>(["TU", "TH"]);
  const [hour, setHour] = useState(19);
  const { sports } = useSports();
  const [form, setForm] = useState({
    sport: "",
    level: "beginner",
    coach_id: "",
    court_id: "",
    capacity: "12",
    min: "",
    price: "",
    duration_min: 60,
    start_on: todayISO(),
    end_on: addDaysISO(todayISO(), 60),
  });
  // A refused create because the court is booked: when, and the first later start that is free.
  const [bookingClash, setBookingClash] = useState<{ clashAt?: string; start?: string; end?: string } | null>(null);
  // Any change to the timetable makes the old refusal stale.
  useEffect(() => setBookingClash(null), [form.court_id, form.start_on, form.duration_min, days, hour]);
  // Tự động gán môn thể thao mặc định là môn đầu tiên trong danh mục khi vừa mở form nếu chưa có môn nào được chọn.
  useEffect(() => {
    if (!form.sport && sports.length > 0) {
      setForm((prev) => ({ ...prev, sport: sports[0].code }));
    }
  }, [form.sport, sports]);

  // After a change, the class list is read again (a published class is a new row or a new status).
  const load = classesRead.reload;
  // Lắng nghe sự kiện realtime qua WebSocket trên kênh "classes" để tự động tải lại danh sách khi có thay đổi trên server.
  useLive("classes", load);

  // Bước 4: Lọc danh sách sân và huấn luyện viên phù hợp với môn thể thao được chọn trong form.
  // The people and courts a class of this sport can actually use. Nothing is
  // assumed about which accounts exist: a centre that issued its own coach
  // logins has none of the seed ids.
  const sportCourts = useMemo(() => courts.filter((c) => c.sport === form.sport), [courts, form.sport]);
  const sportCoaches = useMemo(
    () => coaches.filter((c) => (c.sports ?? []).some((s) => s === form.sport || s === "all")),
    [coaches, form.sport],
  );
  // Tự động cập nhật lại court_id và coach_id mặc định khi danh sách sân hoặc HLV theo môn thể thao thay đổi.
  useEffect(() => {
    setForm((f) => {
      const court_id = sportCourts.some((c) => c.id === f.court_id) ? f.court_id : (sportCourts[0]?.id ?? "");
      const coach_id = sportCoaches.some((c) => c.id === f.coach_id) ? f.coach_id : (sportCoaches[0]?.id ?? "");
      return court_id === f.court_id && coach_id === f.coach_id ? f : { ...f, court_id, coach_id };
    });
  }, [sportCourts, sportCoaches]);
  // Kiểm tra điều kiện tiên quyết: cảnh báo nếu môn thể thao được chọn chưa có HLV phụ trách hoặc chưa có sân tập.
  const missing = !loaded
    ? null
    : !sportCoaches.length
      ? t("No active coach teaches this sport yet.")
      : !sportCourts.length
        ? t("There is no court for this sport.")
        : null;

  // The same limits the server holds the class to, said beside the box before the click rather
  // than after it. Typed as text so a half-typed or emptied box is shown as wrong, not as 0.
  /**
   * Làm gì: Chuyển đổi chuỗi thành số nguyên dương hợp lệ; trả về NaN nếu chuỗi không phải chữ số thuần túy hoặc bị rỗng.
   * Được gọi ở: Component Page trong src/routes/manager.classes.tsx (khi validate form tạo lớp học).
   * @param v Chuỗi nhập từ ô input cần kiểm tra và parse sang số nguyên.
   * @returns Số nguyên đã parse thành công, hoặc NaN nếu chuỗi không hợp lệ.
   */
  const whole = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN);
  // Bước 5: Validate dữ liệu form phía client (sức chứa 1-200, số lượng tối thiểu, giá tiền, ngày bắt đầu, ngày trong tuần).
  const capacityN = whole(form.capacity);
  const capacityError =
    Number.isInteger(capacityN) && capacityN >= 1 && capacityN <= MAX_CAPACITY
      ? null
      : t("Capacity must be a whole number from 1 to {max}.", { max: MAX_CAPACITY });
  const minN = whole(form.min);
  const minError =
    form.min.trim() === "" || (Number.isInteger(minN) && minN >= 1 && (capacityError || minN <= capacityN))
      ? null
      : t("The minimum must be a whole number from 1 up to the capacity.");
  const priceError =
    form.price.trim() === "" || Number.isInteger(whole(form.price)) ? null : t("Price must be a whole number of dong, or empty.");
  // Quy tắc nghiệp vụ: Lớp học không được bắt đầu trong quá khứ để tránh xung đột lịch đặt sân.
  const startError =
    form.start_on && form.start_on < todayISO() ? t("A class cannot start or end in the past. Pick today or a later first day.") : null;
  // No day picked used to fall back to Monday and then report a clash nobody asked for.
  const daysError = days.length ? null : t("Pick at least one day of the week.");
  // Xác định trạng thái không hợp lệ của toàn bộ form để vô hiệu hóa nút tạo lớp nếu có lỗi nhập liệu.
  const invalid = !!(capacityError || minError || priceError || startError || daysError);

  /**
   * Làm gì: Chọn hoặc bỏ chọn một thứ trong tuần để cấu hình chu kỳ lặp lại hàng tuần của lớp học.
   * Được gọi ở: Nút chọn ngày lặp lại (DAYS buttons) trong form tạo lớp của component Page.
   * @param k Mã thứ trong tuần theo chuẩn iCal RRULE (ví dụ: "MO", "TU", "WE",...).
   * @returns Không trả về giá trị (cập nhật state days).
   */
  function toggleDay(k: string) {
    setDays((prev) => (prev.includes(k) ? prev.filter((d) => d !== k) : [...prev, k]));
  }

  // Bước 6: Tính toán các chỉ số thống kê tổng quan (tổng số lớp, lớp đang mở, lớp nháp, tổng số học viên đăng ký).
  const totalClasses = items?.length ?? 0;
  const publishedClasses = items?.filter((c) => c.status === "open").length ?? 0;
  const draftClasses = items?.filter((c) => c.status === "draft").length ?? 0;
  const totalEnrolled = items?.reduce((sum, c) => sum + (c.enrolled_count || 0), 0) ?? 0;

  // Bước 7: Render giao diện trang quản lý gồm banner, khối thống kê, form tạo lớp học và danh sách lớp học.
  return (
    <Shell role="manager">
      <PageHero
        slot="banner.classes"
        title={t("Classes")}
        subtitle={t("Pick the days and the hour. Clashes on court or coach are blocked for you.")}
        className="mb-6"
      />

      <StatStrip
        stats={[
          { label: t("Active classes"), value: publishedClasses },
          { label: t("Drafts"), value: draftClasses },
          { label: t("Enrolled students"), value: totalEnrolled },
          { label: t("Total classes"), value: totalClasses },
        ]}
        className="mb-6"
      />

      <details className="group mb-6 rounded-[var(--radius-xl)] border border-line bg-surface">
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 rounded-[var(--radius-xl)] p-4 font-semibold text-fg focus-visible:outline-2 focus-visible:outline-accent">
          {t("Create class")}
          <span aria-hidden="true" className="text-xl text-accent group-open:rotate-45">+</span>
        </summary>
      {formError ? (
        // Without the courts and coaches the form would offer nothing to pick, so it says why instead.
        <div className="mb-6">
          <LoadError
            message={formError.message}
            onRetry={
              formError.refused
                ? undefined
                : () => {
                    courtsRead.reload();
                    coachesRead.reload();
                  }
            }
          />
        </div>
      ) : (
      <Reveal from="down">
      <Card className="mb-6 grid gap-3 md:grid-cols-3">
        <Field label={t("Sport")}>
          <Select value={form.sport} onChange={(e) => setForm({ ...form, sport: e.target.value })}>
            {sports.map((s) => (
              <option key={s.code} value={s.code}>
                {s.name_en || (s as any).name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("Level")}>
          <Select value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })}>
            <option value="beginner">{t("Beginner")}</option>
            <option value="intermediate">{t("Intermediate")}</option>
            <option value="advanced">{t("Advanced")}</option>
            <option value="team">{t("Squad")}</option>
          </Select>
        </Field>
        <Field label={t("Court")}>
          <Select value={form.court_id} onChange={(e) => setForm({ ...form, court_id: e.target.value })}>
            {sportCourts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.court_code} · {sportLabel(c.sport)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("Coach")}>
          <Select value={form.coach_id} onChange={(e) => setForm({ ...form, coach_id: e.target.value })}>
            {sportCoaches.map((c) => (
              <option key={c.id} value={c.id}>
                {c.full_name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="md:col-span-2">
          <p className="text-2xs font-medium text-muted">{t("Repeats weekly on")}</p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {DAYS.map((d) => (
              <button
                key={d.k}
                type="button"
                onClick={() => toggleDay(d.k)}
                className={`relative min-h-11 min-w-11 rounded-[var(--radius-sm)] px-2 text-sm font-medium sm:min-h-9 transition-colors duration-200 active:scale-95 ${
                  days.includes(d.k) ? "text-bg" : "bg-wood text-muted hover:bg-wood/70"
                }`}
              >
                {days.includes(d.k) ? (
                  <motion.span
                    layoutId={`byday-${d.k}`}
                    className="absolute inset-0 rounded-[var(--radius-sm)] bg-fg"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  />
                ) : null}
                <span className="relative">{t(d.l)}</span>
              </button>
            ))}
          </div>
          {daysError ? (
            <p role="alert" className="mt-1.5 text-sm text-danger">
              {daysError}
            </p>
          ) : null}
        </div>
        <Field label={t("Start time")}>
          <Select value={String(hour)} onChange={(e) => setHour(Number(e.target.value))}>
            {hoursOf(venue).map((h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, "0")}:00
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t("First day")} hint={startError ?? undefined} tone={startError ? "danger" : "muted"}>
          {/* The class runs 60 days from its first day, so the end moves with it. */}
          <DateField
            value={form.start_on}
            onChange={(v) => setForm({ ...form, start_on: v, end_on: v ? addDaysISO(v, 60) : form.end_on })}
            aria-label={t("Start date")}
          />
        </Field>
        <Field label={t("Capacity")} hint={capacityError ?? undefined}>
          <Input
            type="number"
            min={1}
            max={MAX_CAPACITY}
            step={1}
            inputMode="numeric"
            aria-invalid={capacityError ? true : undefined}
            value={form.capacity}
            onChange={(e) => setForm({ ...form, capacity: e.target.value })}
          />
        </Field>
        <Field
          label={t("Minimum to run")}
          hint={minError ?? t("Leave empty for no minimum. Below it the class is only flagged.")}
          tone={minError ? "danger" : "muted"}
        >
          <Input
            type="number"
            min={1}
            max={capacityError ? MAX_CAPACITY : capacityN}
            step={1}
            inputMode="numeric"
            aria-invalid={minError ? true : undefined}
            value={form.min}
            onChange={(e) => setForm({ ...form, min: e.target.value })}
          />
        </Field>
        <Field
          label={t("Price (VND)")}
          hint={priceError ?? t("Leave empty until the class is ready to sell.")}
          tone={priceError ? "danger" : "muted"}
        >
          <Input
            type="number"
            min={0}
            step={1000}
            inputMode="numeric"
            aria-invalid={priceError ? true : undefined}
            value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value })}
          />
        </Field>
        <div className="flex flex-col justify-end gap-1">
          {bookingClash ? (
            <div role="alert" className="space-y-1.5 rounded-md border border-danger/40 bg-danger/5 p-2 text-xs">
              <p className="text-danger">
                {t("The court is already booked on {date} at this class's hour.", {
                  date: bookingClash.clashAt ? formatDate(ictDateString(new Date(bookingClash.clashAt))) : "",
                })}
              </p>
              {bookingClash.start && bookingClash.end ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => setForm({ ...form, start_on: bookingClash.start!, end_on: bookingClash.end! })}
                >
                  {t("Start on {date} instead", { date: formatDate(bookingClash.start) })}
                </Button>
              ) : (
                <p className="text-muted-foreground">{t("No free week found in the next two months. Pick another court or hour.")}</p>
              )}
            </div>
          ) : null}
          {missing ? (
            <p className="text-xs text-danger">
              {missing}{" "}
              {!sportCoaches.length ? (
                <Link to="/manager/staff" className="underline">
                  {t("Add a coach")}
                </Link>
              ) : null}
            </p>
          ) : null}
          <Button
            className="w-full"
            disabled={creating || invalid || !!missing || !form.coach_id || !form.court_id}
            onClick={async () => {
              // One click used to land many identical classes: the button stayed
              // live for the whole create-and-publish round trip.
              if (creating || invalid) return;
              // Bước 1: Bật cờ creating để khóa nút bấm, tránh việc người quản lý bấm nhiều lần tạo trùng lớp học (double-click).
              setCreating(true);
              try {
                // Bước 2: Chuẩn bị payload và gọi API POST /classes tạo lớp học mới ở trạng thái bản nháp (draft); tự động sinh chuỗi quy tắc lặp rrule theo thứ và giờ bắt đầu.
                const { price, min, ...rest } = form;
                const row = await apiPost<{ id: string }>("/classes", {
                  ...rest,
                  capacity: capacityN,
                  min_enrolled: min.trim() === "" ? null : Number(min),
                  price_vnd: price.trim() === "" ? null : Number(price),
                  rrule: composeWeeklyRrule(days, hour),
                });
                toast.success(t("Draft created"));
                // Bước 3: Xuất bản lớp học ngay sau khi tạo nháp thành công qua API POST /classes/:id/publish; hệ thống sẽ tự động sinh các ca học (sessions) cụ thể trong vòng 60 ngày tới.
                const pub = await apiPost<{ sessions: unknown[]; skipped: unknown[] }>(`/classes/${row.id}/publish`);
                toast.success(t("Published {n} sessions", { n: pub.sessions.length }));
                // Bước 4: Tải lại danh sách lớp học (classesRead.reload) để cập nhật giao diện hiển thị lớp mới vừa xuất bản.
                load();
              } catch (e) {
                // Bước 5: Bắt lỗi nếu gọi API thất bại và hiển thị thông báo lỗi từ máy chủ qua toast.error.
                // A clash with a court booking stays on the form with a later start to apply.
                if (e instanceof ApiClientError && e.body.clash_at) {
                  setBookingClash({ clashAt: e.body.clash_at, start: e.body.suggested_start_on, end: e.body.suggested_end_on });
                  return;
                }
                toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
              } finally {
                // Mở lại nút bấm tạo lớp sau khi tiến trình hoàn tất hoặc gặp lỗi.
                setCreating(false);
              }
            }}
          >
            {creating ? t("Publishing…") : t("Create & publish")}
          </Button>
        </div>
      </Card>
      </Reveal>
      )}
      </details>
      {classesRead.error ? (
        <LoadError message={classesRead.error.message} onRetry={classesRead.error.refused ? undefined : classesRead.reload} />
      ) : !items ? (
        <Skeleton className="h-40" />
      ) : null}
      {items?.length ? (
        <div className="mb-4 grid gap-2 sm:grid-cols-3">
          <Select aria-label={t("Coach")} value={coach} onChange={(e) => setCoach(e.target.value)}>
            <option value="">{t("All coaches")}</option>
            {coachNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
          <Select aria-label={t("Day")} value={day} onChange={(e) => setDay(e.target.value)}>
            <option value="">{t("Any day")}</option>
            {DAYS.map((d) => (
              <option key={d.k} value={d.k}>
                {t(d.l)}
              </option>
            ))}
          </Select>
          <Select aria-label={t("Time of day")} value={part} onChange={(e) => setPart(e.target.value)}>
            <option value="">{t("Any time")}</option>
            <option value="morning">{t("Morning (before 12:00)")}</option>
            <option value="afternoon">{t("Afternoon (12:00-17:00)")}</option>
            <option value="evening">{t("Evening (from 17:00)")}</option>
          </Select>
        </div>
      ) : null}
      <Stagger className="grid gap-3 md:grid-cols-2" gap={0.06}>
        {(listed ?? []).slice(0, limit).map((c) => (
          <StaggerItem key={c.id} className="h-full">
          <Lift className="h-full">
          <SpotlightCard className="h-full rounded-[var(--radius-xl)]" size={320} strength={0.1}>
          <Card interactive className="relative z-[2] h-full">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <SportBadge sport={c.sport} />
                <StatusBadge status={c.status} />
                {!c.running_below_minimum && <MinSizeBadge enrolled={c.confirmed_count} min={c.min_enrolled} status={c.status} />}
              </div>
              <span className="text-2xs tabular-nums text-muted">{c.code}</span>
            </div>
            {c.running_below_minimum && (
              <Badge tone="hold" className="mt-2 max-w-full whitespace-normal">
                {t("Running below minimum · {count}/{minimum} confirmed", { count: c.confirmed_count, minimum: c.min_enrolled ?? 0 })}
              </Badge>
            )}
            <h2 className="mt-2 font-display text-2xl">
              {sportLabel(c.sport)} · {levelLabel(c.level)}
            </h2>
            <p className="text-sm text-muted">
              {c.coach_name} · {c.court_code} · <HighlightBadge value={c.enrolled_count}>{c.enrolled_count}</HighlightBadge>/{c.capacity}
            </p>
            {c.rrule ? <p className="text-sm">{rruleLabel(c.rrule, c.duration_min)}</p> : null}
            <p className="text-sm tabular-nums text-muted">{c.price_vnd == null ? t("Price: not set") : money(c.price_vnd)}</p>
            <Button className="mt-3" variant="outline" onClick={() => setDetail(c.id)}>
              {t("Sessions & students")}
            </Button>
            {c.status === "draft" ? (
              <Button
                className="mt-3 ml-2"
                onClick={async () => {
                  try {
                    // Bước 1: Gọi API POST /classes/:id/publish để xuất bản lớp học từ trạng thái nháp (draft) sang mở (open) và sinh các buổi học theo lịch.
                    await apiPost(`/classes/${c.id}/publish`);
                    toast.success(t("Published"));
                    // Bước 2: Thông báo xuất bản thành công và làm mới danh sách lớp học để cập nhật trạng thái mới nhất trên giao diện.
                    load();
                  } catch (e) {
                    // Bước 3: Bắt lỗi và hiển thị thông báo lỗi từ máy chủ nếu xuất bản lớp học thất bại.
                    toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
                  }
                }}
              >
                {t("Publish")}
              </Button>
            ) : null}
          </Card>
          </SpotlightCard>
          </Lift>
          </StaggerItem>
        ))}
      </Stagger>
      {listed ? (
        <ShowMore shown={Math.min(limit, listed.length)} total={listed.length} step={8} onMore={() => setLimit((n) => n + 8)} />
      ) : null}
      {cancelledCount ? (
        <div className="mt-3 text-center">
          <Button variant="ghost" onClick={() => setShowCancelled((v) => !v)}>
            {showCancelled ? t("Hide cancelled classes") : t("Show {n} cancelled classes", { n: cancelledCount })}
          </Button>
        </div>
      ) : null}
      {filtering && listed && !listed.length ? (
        <EmptyState title={t("No class matches these filters")} hint={t("Change the coach, day or time above.")} />
      ) : null}
      {items && !items.length ? (
        <EmptyState
          title={t("No classes yet")}
          hint={t("Open Create class, pick a sport, coach and days, then press Create & publish. Members can book as soon as it is published.")}
        />
      ) : null}
      <ClassDetailModal classId={detail} onClose={() => setDetail(null)} manage onChanged={() => void load()} />
    </Shell>
  );
}
