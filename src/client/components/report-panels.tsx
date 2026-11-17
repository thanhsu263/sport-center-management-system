/**
 * File: src/client/components/report-panels.tsx
 * Vai trò: Cung cấp các panel và biểu đồ báo cáo quản trị cho hệ thống Arena3 (công suất sử dụng sân, giờ cao điểm, doanh thu và hội viên).
 * Vị trí trong app:
 * - Được tích hợp trong trang báo cáo quản lý tại src/routes/manager.index.tsx (route /manager).
 * - Cung cấp component dùng chung ExportButtons để xuất file Excel/PDF cho các loại báo cáo.
 * - Cung cấp CapacityPanel (thống kê công suất sân, doanh thu sân vs lớp, biểu đồ giờ bận BusyBars).
 * - Cung cấp MembersPanel (thống kê số lượng hội viên, chuyển đổi gói tập và phân bổ hạng thành viên).
 */
import { Fragment, useEffect, useMemo, useState } from "react";
import { CalendarDays, Flame, Gauge, LayoutGrid, TrendingUp, UserPlus, Users } from "lucide-react";
import { CardTitle, SectionTitle } from "@/client/components/section";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { toast } from "sonner";
import { money } from "@/client/components/shell";
import { Badge, Button, Card, EmptyState, LoadError, Select, ShowMore, Skeleton, Stat } from "@/client/components/ui";
import { SportDot, useSports } from "@/client/components/sports-ui";
import { downloadReport } from "@/client/arena3/client";
import { levelLabel, sportLabel } from "@/shared/arena3/labels";
import { t, tk, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";
import { useLimits } from "@/client/lib/use-centre";
import { cn } from "@/client/lib/cn";

// Các loại báo cáo trong hệ thống hỗ trợ xuất dữ liệu ra file Excel hoặc PDF
type Kind = "revenue" | "capacity" | "members" | "attendance" | "at-risk";

/** Excel and PDF of the report on screen, with the same filters it is showing. */
/**
 * Làm gì: Hiển thị bộ nút xuất báo cáo ra file Excel (.xlsx) hoặc PDF (.pdf) theo các bộ lọc hiện tại trên giao diện.
 * Được gọi ở:
 * - src/routes/manager.index.tsx (báo cáo doanh thu tại route /manager)
 * - src/client/components/report-panels.tsx (panel công suất sân CapacityPanel và hội viên MembersPanel)
 * - src/client/components/attendance-panels.tsx (panel chuyên cần AttendancePanel và học viên nguy cơ AtRiskPanel)
 * @param kind Loại báo cáo cần xuất ("revenue" | "capacity" | "members" | "attendance" | "at-risk").
 * @param from Ngày bắt đầu kỳ báo cáo (định dạng YYYY-MM-DD).
 * @param to Ngày kết thúc kỳ báo cáo (định dạng YYYY-MM-DD).
 * @param extra Các tham số lọc bổ sung gửi kèm theo dạng query param (ví dụ: sport, method, by).
 * @param disabled Cờ vô hiệu hóa các nút xuất (ví dụ khi server từ chối khoảng ngày hoặc không có dữ liệu).
 * @returns Khung JSX chứa các nút Button xuất file Excel và PDF.
 */
export function ExportButtons({
  kind,
  from,
  to,
  extra = {},
  disabled = false,
}: {
  kind: Kind;
  from: string;
  to: string;
  extra?: Record<string, string | null | undefined>;
  /** The period on screen is one the server refuses, so there is nothing to export. */
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState<"xlsx" | "pdf" | null>(null);
  /**
   * Làm gì: Tải file báo cáo từ server theo định dạng được chọn và hiển thị thông báo toast khi hoàn thành hoặc có lỗi.
   * Được gọi ở: ExportButtons (sự kiện onClick của nút Export Excel và Export PDF).
   * @param format Định dạng file cần tải xuống ("xlsx" hoặc "pdf").
   * @returns Promise<void>
   */
  async function go(format: "xlsx" | "pdf") {
    // Bước 1: Đánh dấu trạng thái đang xử lý (busy) để vô hiệu hóa nút bấm và hiển thị nhãn "Preparing…".
    setBusy(format);
    try {
      // Bước 2: Tạo query parameters gồm khoảng ngày (from, to), định dạng file và các bộ lọc bổ sung từ props extra.
      const q = new URLSearchParams({ from, to, format });
      for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
      // Bước 3: Gọi API /reports/:kind/export để tải file về máy và hiển thị toast thông báo thành công hoặc lỗi từ server.
      const name = await downloadReport(`/reports/${kind}/export?${q}`, `lelong-${kind}-${from}_${to}.${format}`);
      toast.success(t("Saved {name}", { name }));
    } catch (e) {
      toast.error(tServer((e as Error).message));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" disabled={disabled || busy !== null} onClick={() => void go("xlsx")}>
        {busy === "xlsx" ? t("Preparing…") : t("Export Excel")}
      </Button>
      <Button variant="outline" size="sm" disabled={disabled || busy !== null} onClick={() => void go("pdf")}>
        {busy === "pdf" ? t("Preparing…") : t("Export PDF")}
      </Button>
    </div>
  );
}

/**
 * Làm gì: Chuyển đổi số phút sang số giờ và làm tròn đến 1 chữ số thập phân.
 * Được gọi ở: src/client/components/report-panels.tsx (trong CapacityPanel để hiển thị số giờ đã bán và giờ mở cửa).
 * @param min Số phút cần quy đổi sang giờ.
 * @returns Số giờ sau khi làm tròn (ví dụ: 90 phút thành 1.5 giờ).
 */
const hours = (min: number) => Math.round((min / 60) * 10) / 10;
/**
 * Làm gì: Chuyển đổi giá trị tỷ lệ phần trăm thành chuỗi hiển thị có ký tự "%", hoặc trả về "-" nếu null hoặc undefined.
 * Được gọi ở: src/client/components/report-panels.tsx (trong CapacityPanel để hiển thị tỷ lệ giờ cao điểm và thấp điểm trong bảng).
 * @param v Tỷ lệ phần trăm dạng số, hoặc null/undefined nếu chưa có số liệu.
 * @returns Chuỗi định dạng tỷ lệ phần trăm (ví dụ: "75%") hoặc "-".
 */
const pctText = (v: number | null | undefined) => (v == null ? "-" : `${v}%`);

/**
 * Làm gì: Dropdown lựa chọn môn thể thao để lọc dữ liệu báo cáo, lấy danh sách môn hoạt động từ hook useSports.
 * Được gọi ở: src/client/components/report-panels.tsx (các panel CapacityPanel và MembersPanel).
 * @param value Mã code của môn thể thao đang chọn (chuỗi rỗng "" đại diện cho tất cả môn).
 * @param onChange Callback kích hoạt khi người dùng thay đổi môn thể thao đã chọn.
 * @returns Khung JSX Select chứa danh sách các môn thể thao.
 */
function SportSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { sports } = useSports();
  return (
    <div className="w-44">
      <Select aria-label={t("Sport")} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("All sports")}</option>
        {sports.map((s) => (
          <option key={s.code} value={s.code}>
            {sportLabel(s.code)}
          </option>
        ))}
      </Select>
    </div>
  );
}

// ---- capacity -------------------------------------------------------------------

// Cấu trúc dữ liệu báo cáo công suất sân và doanh thu trả về từ API GET /reports/capacity
type Capacity = {
  open_hour: number;
  close_hour: number;
  totals: { sold_min: number; open_min: number; pct: number };
  by_sport: Array<{
    sport: string;
    sold_min: number;
    open_min: number;
    pct: number;
    peak_pct: number | null;
    offpeak_pct: number | null;
  }>;
  by_hour: Array<{ hour: number; pct: number }>;
  hours: number[];
  courts: Array<{
    court_id: string;
    court_code: string;
    sport: string;
    pct: number;
    cells: number[];
    cell_details?: Array<{ hr: number; pct: number; days_booked: number; days_total: number }>;
  }>;
  revenue_by_source: { court_vnd: number; class_vnd: number };
};

/** Share of courts in play per hour, one labelled bar per hour; the peak hours are lit. */
/**
 * Làm gì: Hiển thị biểu đồ thanh dọc tỷ lệ sử dụng sân theo từng khung giờ trong ngày; các khung giờ cao điểm được làm nổi bật với hiệu ứng phát sáng.
 * Được gọi ở: src/client/components/report-panels.tsx (trong CapacityPanel khi hiển thị phần chi tiết part="busy").
 * @param rows Danh sách các khung giờ kèm tỷ lệ phần trăm sử dụng sân tương ứng (hour, pct).
 * @param peakPct Ngưỡng phần trăm so với mức cao nhất để xác định giờ cao điểm cần làm nổi bật.
 * @returns Khung JSX danh sách thanh bar cuộn ngang hiển thị công suất từng giờ.
 */
function BusyBars({ hours: rows, peakPct }: { hours: Array<{ hour: number; pct: number }>; peakPct: number }) {
  // Bước 1: Tìm tỷ lệ sử dụng cao nhất (tối thiểu là 1 để tránh chia cho 0) làm mốc quy đổi 100% chiều cao cột biểu đồ.
  const top = Math.max(1, ...rows.map((x) => x.pct));
  return (
    <div className="overflow-x-auto px-4 pb-4 pt-4" role="region" aria-label={t("Busy hours chart, scrolls sideways")} tabIndex={0}>
      <ol className="flex min-w-[560px] items-end gap-1.5">
        {rows.map((h) => {
          const peak = h.pct > 0 && h.pct >= (top * peakPct) / 100;
          const hh = `${String(h.hour).padStart(2, "0")}h`;
          return (
            <li key={h.hour} className="flex flex-1 flex-col items-center gap-1" title={`${hh} · ${Math.round(h.pct)}%`}>
              <span className={cn("text-2xs tabular-nums", peak ? "font-semibold text-fg" : "text-muted")}>
                {Math.round(h.pct)}%
              </span>
              <div className="flex h-36 w-full items-end rounded-t-[4px] bg-wood/40">
                <div
                  className={cn(
                    "w-full rounded-t-[4px] transition-[height] duration-500 motion-reduce:transition-none",
                    peak ? "bg-accent shadow-[0_0_14px_rgb(212_245_60/0.4)]" : "bg-accent/40",
                  )}
                  style={{ height: h.pct > 0 ? `${Math.max(3, (h.pct / top) * 100)}%` : "2px" }}
                />
              </div>
              <span className={cn("text-2xs tabular-nums", peak ? "font-semibold text-fg" : "text-muted")}>{hh}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** `summary` = totals and the per-sport table; `busy` = the whole-day court × hour grid, shown last on the page. */
/**
 * Làm gì: Hiển thị panel báo cáo công suất sử dụng sân thể thao theo khoảng ngày, hỗ trợ xem tổng quan (summary) hoặc chi tiết giờ bận (busy).
 * Được gọi ở: src/routes/manager.index.tsx (màn hình báo cáo trung tâm của quản lý tại route /manager).
 * @param from Ngày bắt đầu kỳ báo cáo (định dạng YYYY-MM-DD).
 * @param to Ngày kết thúc kỳ báo cáo (định dạng YYYY-MM-DD).
 * @param part Chế độ hiển thị: "summary" (tổng quan số giờ, doanh thu và bảng theo môn) hoặc "busy" (biểu đồ giờ bận và ma trận sân theo giờ). Mặc định là "summary".
 * @returns Khung giao diện JSX phần báo cáo công suất sân kèm bộ lọc và các thẻ chỉ số.
 */
export function CapacityPanel({ from, to, part = "summary" }: { from: string; to: string; part?: "summary" | "busy" }) {
  // Bước 1: Khởi tạo state môn thể thao, tạo URLSearchParams và nạp dữ liệu công suất qua useRead từ API /reports/capacity.
  const [sport, setSport] = useState("");
  const q = new URLSearchParams({ from, to });
  if (sport) q.set("sport", sport);
  const limits = useLimits();
  const { data, error, reload } = useRead<Capacity>(`/reports/capacity?${q}`);

  // Bước 2: Tính toán chuỗi tóm tắt các khung giờ cao điểm bận nhất dựa trên tỷ lệ đặt sân (sắp xếp giảm dần).
  const busiestSummary = useMemo(() => {
    if (!data?.by_hour?.length) return "";
    const sorted = [...data.by_hour]
      .filter((h) => h.pct > 0)
      .sort((a, b) => b.pct - a.pct);
    if (sorted.length === 0) return t("No bookings in this window");
    // Lấy top các giờ bận nhất theo cấu hình giới hạn (limits.report_peak_hours, mặc định 3 giờ cao điểm)
    const top3 = sorted.slice(0, limits.report_peak_hours);
    const text = top3
      .map((h, idx) =>
        idx === 0
          ? `${String(h.hour).padStart(2, "0")}:00 (${Math.round(h.pct)}%)`
          : `${String(h.hour).padStart(2, "0")}:00`
      )
      .join(", ");
    return t("Busiest: {hours}", { hours: text });
  }, [data, limits.report_peak_hours]);

  // Bước 3: Render giao diện báo cáo: tiêu đề theo chế độ hiển thị, bộ lọc môn & nút xuất file, các thẻ Stat tổng quan và bảng chi tiết từng môn.
  return (
    <section className="mt-10" aria-labelledby={part === "summary" ? "cap-h" : "busy-h"}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        {part === "summary" ? (
          <SectionTitle
            id="cap-h"
            icon={LayoutGrid}
            text={tk("Court capacity")}
            hint={t("Share of open hours that were sold, as bookings or class sessions.")}
          />
        ) : (
          <SectionTitle id="busy-h" icon={Flame} text={t("Busy hours")} hint={t("The whole day, hour by hour, for every court.")} />
        )}
        <div className="flex flex-wrap items-center gap-2">
          <SportSelect value={sport} onChange={setSport} />
          <ExportButtons kind="capacity" from={from} to={to} extra={{ sport }} />
        </div>
      </div>

      {error ? (
        <div className="mt-4">
          <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
        </div>
      ) : !data ? (
        <Skeleton className="mt-4 h-64" />
      ) : data.courts.length === 0 ? (
        <div className="mt-4">
          <EmptyState title={t("No courts to report on")} hint={t("Courts that are ready for play show up here.")} />
        </div>
      ) : (
        <>
          {part === "summary" && (
          <>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <Stat
              label={t("Hours sold")}
              value={`${hours(data.totals.sold_min)} h`}
              hint={t("of {n} h open", { n: hours(data.totals.open_min) })}
            />
            <Stat label={t("Used")} value={`${data.totals.pct}%`} icon={Gauge} note={t("Hours sold ÷ hours open")} />
            <Stat
              label={t("Court rental vs classes")}
              value={money(data.revenue_by_source.court_vnd)}
              hint={t("Class fees {amount}", { amount: money(data.revenue_by_source.class_vnd) })}
            />
          </div>

          <Card className="mt-3 overflow-x-auto p-0" role="region" aria-label={t("Court use table, scrolls sideways")} tabIndex={0}>
            <table className="w-full text-sm">
              <thead className="text-left text-2xs text-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">{t("Sport")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("Sold")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("Used")}</th>
                  <th className="px-3 py-2 text-right font-medium">{t("Peak")}</th>
                  <th className="px-4 py-2 text-right font-medium">{t("Off-peak")}</th>
                </tr>
              </thead>
              <tbody>
                {data.by_sport.map((s) => (
                  <tr key={s.sport} className="border-t border-line/60">
                    <td className="px-4 py-2">{sportLabel(s.sport)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{hours(s.sold_min)} h</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.pct}%</td>
                    <td className="px-3 py-2 text-right tabular-nums">{pctText(s.peak_pct)}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{pctText(s.offpeak_pct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          </>
          )}

          {part === "busy" && (
          <Card className="mt-4 p-0">
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4">
              <CardTitle
                icon={Flame}
                title={t("When courts are busy ({from} – {to})", { from, to })}
                hint={t("Share of courts in play at each hour. The brightest bars are the peak.")}
              />
              {busiestSummary && (
                <div className="text-right">
                  <span className="inline-block rounded-full bg-surface px-3 py-1 text-xs font-medium text-fg border border-line">
                    {busiestSummary}
                  </span>
                </div>
              )}
            </div>

            <BusyBars hours={data.by_hour} peakPct={limits.report_peak_pct} />
          </Card>
          )}
        </>
      )}
    </section>
  );
}

// ---- members and class sign-ups -------------------------------------------------

// Cấu trúc dữ liệu báo cáo hội viên và danh sách lớp học trả về từ API GET /reports/members
type MembersReport = {
  members: {
    new: number;
    active: number;
  };
  trend: Array<{ month: string; new_members: number; classes_joined: number }>;
  attendance_on: boolean;
  classes: Array<{
    id: string;
    code: string;
    sport: string;
    level: string;
    status: string;
    coach: string;
    capacity: number;
    enrolled: number;
    waitlisted: number;
    fill_pct: number;
    attendance_pct: number | null;
  }>;
};

/**
 * Làm gì: Hiển thị báo cáo hội viên và tình hình đăng ký lớp học theo khoảng ngày được chọn, gồm số lượng hội viên mới/đang hoạt động, biểu đồ xu hướng 12 tháng qua và danh sách lớp học kèm tỷ lệ lấp đầy, danh sách chờ.
 * Được gọi ở: src/routes/manager.index.tsx (component Page tại route /manager).
 * @param from Ngày bắt đầu kỳ báo cáo (định dạng YYYY-MM-DD).
 * @param to Ngày kết thúc kỳ báo cáo (định dạng YYYY-MM-DD).
 * @returns Khung giao diện JSX section chứa báo cáo hội viên và danh sách lớp học.
 */
export function MembersPanel({ from, to }: { from: string; to: string }) {
  // Bước 1: Khởi tạo state môn thể thao cần lọc và cờ sẵn sàng render biểu đồ Recharts.
  const [sport, setSport] = useState("");
  const [chartReady, setChartReady] = useState(false);
  // Recharts ResponsiveContainer cần DOM đo kích thước; trì hoãn sang useEffect để tránh lỗi hydration mismatch khi render ở client.
  useEffect(() => setChartReady(true), []);
  // Bước 2: Tạo query parameters và nạp dữ liệu báo cáo hội viên qua hook useRead từ API /reports/members.
  const q = new URLSearchParams({ from, to });
  if (sport) q.set("sport", sport);
  const { data, error, reload } = useRead<MembersReport>(`/reports/members?${q}`);
  // Only show the attendance column when at least one class has a figure for it.
  const showAttendance = !!data?.attendance_on && !!data?.classes.some((c) => c.attendance_pct != null);
  // Bước 3: Quản lý số lượng lớp hiển thị ban đầu; mỗi lần bấm xem thêm sẽ tăng 12 lớp (CLASS_STEP) để giữ DOM nhẹ.
  const CLASS_STEP = 12;
  const [classShown, setClassShown] = useState(CLASS_STEP);
  // Bước 4: Sắp xếp danh sách lớp theo độ ưu tiên cần xử lý (tỷ lệ lấp đầy giảm dần -> số người chờ giảm dần -> mã lớp theo alphabet).
  // Fullest first, so the classes that need a decision (full with a waitlist, or nearly empty) sit at the two ends.
  const classes = useMemo(
    () => [...(data?.classes ?? [])].sort((a, b) => b.fill_pct - a.fill_pct || b.waitlisted - a.waitlisted || a.code.localeCompare(b.code)),
    [data],
  );
  // Bước 5: Thống kê nhanh các chỉ số vận hành: số lớp đã đầy chỗ (>= 100%), số lớp vắng (< 40%) và tổng số học viên trong danh sách chờ.
  const classSummary = useMemo(() => {
    const full = classes.filter((c) => c.fill_pct >= 100).length;
    const low = classes.filter((c) => c.fill_pct < 40).length;
    const waiting = classes.reduce((n, c) => n + c.waitlisted, 0);
    return { full, low, waiting };
  }, [classes]);

  // Bước 6: Render giao diện báo cáo: tiêu đề, bộ lọc môn & nút xuất file, các thẻ Stat hội viên, biểu đồ Recharts xu hướng 12 tháng và bảng chi tiết các lớp học.
  return (
    <section className="mt-10" aria-labelledby="mem-h">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SectionTitle
          id="mem-h"
          icon={Users}
          text={tk("Members and class sign-ups")}
          hint={t("New members, participation and how full each class is.")}
        />
        <div className="flex flex-wrap items-center gap-2">
          <SportSelect value={sport} onChange={setSport} />
          <ExportButtons kind="members" from={from} to={to} extra={{ sport }} />
        </div>
      </div>

      {error ? (
        <div className="mt-4">
          <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
        </div>
      ) : !data ? (
        <Skeleton className="mt-4 h-64" />
      ) : (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <Stat label={t("New members")} value={data.members.new} icon={UserPlus} note={t("Signed up in this period")} />
            <Stat label={t("Participating members")} value={data.members.active} hint={t("With a booking or confirmed class in this period")} />
          </div>

          <Card className="mt-3">
            <CardTitle icon={TrendingUp} title={t("Last 12 months")} hint={t("New members by signup month; confirmed class places by class start month.")} />
            {chartReady ? (
              <div className="mt-3 h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke="var(--color-line)" strokeDasharray="2 4" />
                    <XAxis
                      dataKey="month"
                      tick={{ fontSize: 12 }}
                      stroke="var(--color-muted)"
                      tickLine={false}
                      tickFormatter={(m: string) => `${m.slice(5)}/${m.slice(2, 4)}`}
                    />
                    <YAxis
                      tick={{ fontSize: 12 }}
                      stroke="var(--color-muted)"
                      tickLine={false}
                      axisLine={false}
                      width={32}
                      allowDecimals={false}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "var(--color-surface)",
                        border: "1px solid var(--color-line)",
                        borderRadius: 12,
                        fontSize: 12,
                      }}
                      cursor={{ fill: "var(--color-wood)", opacity: 0.5 }}
                    />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                    <Bar dataKey="new_members" name={t("New members")} fill="var(--color-accent)" radius={[4, 4, 0, 0]} maxBarSize={18} />
                    <Bar dataKey="classes_joined" name={t("Confirmed class places")} fill="var(--color-line-strong)" radius={[4, 4, 0, 0]} maxBarSize={18} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <Skeleton className="mt-3 h-52" />
            )}
          </Card>

          <Card className="mt-3 p-0">
            <div className="flex flex-wrap items-end justify-between gap-3 px-4 pt-4">
              <CardTitle icon={CalendarDays} title={t("Classes running in this period")} hint={t("How full each class was.")} />
              {classes.length > 0 ? (
                <div className="flex flex-wrap gap-1.5 text-2xs">
                  <span className="rounded-full border border-line px-2.5 py-1 tabular-nums text-muted">
                    {t("{n} classes", { n: classes.length })}
                  </span>
                  <span className="rounded-full bg-accent/15 px-2.5 py-1 font-medium tabular-nums text-accent">
                    {t("{n} full", { n: classSummary.full })}
                  </span>
                  {classSummary.waiting > 0 ? (
                    <span className="rounded-full bg-warn/15 px-2.5 py-1 font-medium tabular-nums text-warn">
                      {t("{n} waiting", { n: classSummary.waiting })}
                    </span>
                  ) : null}
                  <span className="rounded-full border border-line px-2.5 py-1 tabular-nums text-muted">
                    {t("{n} under 40%", { n: classSummary.low })}
                  </span>
                </div>
              ) : null}
            </div>
            {classes.length === 0 ? (
              <p className="px-4 pb-4 pt-2 text-sm text-muted">{t("No classes were running in this period.")}</p>
            ) : (
              <div className="overflow-x-auto" role="region" aria-label={t("Classes table, scrolls sideways")} tabIndex={0}>
                <table className="mt-3 w-full min-w-[560px] text-sm">
                  <thead className="text-left text-2xs text-muted">
                    <tr>
                      <th className="px-4 py-2 font-medium">{t("Class")}</th>
                      <th className="px-3 py-2 font-medium">{t("Coach")}</th>
                      <th className="w-[38%] px-3 py-2 font-medium">{t("Full")}</th>
                      <th className="px-3 py-2 text-right font-medium">{t("Waitlist")}</th>
                      {showAttendance ? <th className="px-4 py-2 text-right font-medium">{t("Attendance")}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {classes.slice(0, classShown).map((c) => {
                      const full = c.fill_pct >= 100;
                      const low = c.fill_pct < 40;
                      return (
                        <tr key={c.id} className="border-t border-line/50 transition-colors duration-150 hover:bg-fg/[0.03]">
                          <td className="px-4 py-2.5">
                            <span className="flex items-center gap-2 font-medium">
                              <SportDot sport={c.sport} />
                              {sportLabel(c.sport)} · {levelLabel(c.level)}
                            </span>
                            <span className="block pl-4 font-mono text-2xs text-muted">{c.code}</span>
                          </td>
                          <td className="px-3 py-2.5 text-muted">{c.coach}</td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-3">
                              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-fg/[0.07]" aria-hidden="true">
                                <div
                                  className={cn("h-full rounded-full", full ? "bg-accent" : low ? "bg-muted/50" : "bg-accent/55")}
                                  style={{ width: `${Math.min(100, c.fill_pct)}%` }}
                                />
                              </div>
                              <span className="w-24 shrink-0 text-right text-xs tabular-nums">
                                <span className={cn("font-medium", full ? "text-accent" : low ? "text-muted" : "text-fg")}>
                                  {c.enrolled}/{c.capacity}
                                </span>
                                <span className="ml-1.5 text-muted">{c.fill_pct}%</span>
                              </span>
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            {c.waitlisted > 0 ? <Badge tone="hold">{c.waitlisted}</Badge> : <span className="text-muted/50">·</span>}
                          </td>
                          {showAttendance ? (
                            <td className="px-4 py-2.5 text-right tabular-nums">{pctText(c.attendance_pct)}</td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="pb-4">
              <ShowMore shown={classShown} total={classes.length} step={CLASS_STEP} onMore={() => setClassShown((n) => n + CLASS_STEP)} />
            </div>
          </Card>
        </>
      )}
    </section>
  );
}
