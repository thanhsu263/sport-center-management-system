/**
 * File: src/client/lib/pages/manager.index.ts
 * Vai trò: Hook logic và các hàm tiện ích hỗ trợ cho màn hình Dashboard Báo cáo quản lý (Manager Overview).
 * Vị trí trong app:
 * - Được import và sử dụng trực tiếp bởi trang route /manager/ tại src/routes/manager.index.tsx.
 * - Cung cấp hook useManagerOverview quản lý state khoảng ngày lọc (from/to), phương thức thanh toán,
 *   gọi các API báo cáo doanh thu (/reports/revenue), công suất sân (/reports/occupancy, /occupancy) và kiểm tra cảnh báo nhân sự (/staff).
 * - Cung cấp các hàm tiện ích: tính tỷ lệ tăng trưởng so với kỳ trước (delta), rút gọn số tiền trên trục biểu đồ (compactVnd),
 *   cấu hình tooltip biểu đồ Recharts (TOOLTIP), và tải báo cáo định dạng CSV (downloadCsv).
 */
import { useEffect, useState } from "react";
import { type Court, type OccSlot } from "@/client/components/court-grid";
import { money } from "@/client/components/shell";
import { type Trend } from "@/client/components/ui";
import { t } from "@/client/lib/i18n";
import { addDaysISO, methodLabel, sourceLabel, todayISO } from "@/shared/arena3/labels";
import { useRead } from "@/client/lib/use-read";


// Cấu trúc dữ liệu báo cáo doanh thu trả về từ endpoint /reports/revenue (bao gồm tổng thu, hoàn tiền, phân bổ theo nguồn/phương thức và dữ liệu kỳ trước)
type Rev = {
  from: string;
  to: string;
  totals: { revenue_vnd: number; gross_vnd?: number; refund_vnd: number; quota_hours: number };
  by_source: Record<string, number>;
  refunds_by_source?: Record<string, number>;
  by_shift?: Array<{
    shift_id: string | null;
    cashier: string | null;
    opened_at: string | null;
    closed_at: string | null;
    takings_vnd: number;
    refunds_vnd: number;
    count: number;
  }>;
  by_method: Record<string, number>;
  /** One row per ICT day in the window, including days with no takings. */
  by_day?: Array<{ day: string; revenue_vnd: number }>;
  /** The window just before this one, same length and same method filter. */
  prev?: Pick<Rev, "from" | "to" | "totals" | "by_source">;
};


// Cấu trúc dữ liệu công suất sử dụng sân theo ngày trả về từ endpoint /reports/occupancy
type Occ = { date: string; items: Array<{ court_code: string; minutes: number; pct: number }> };


/**
 * Làm gì: Lấy chuỗi ngày đầu tiên của tháng (dạng YYYY-MM-01) từ chuỗi ngày chuẩn ISO.
 * Được gọi ở: src/client/lib/pages/manager.index.ts (hàm applyPeriod trong hook useManagerOverview khi chọn lọc theo "month").
 * @param iso Chuỗi ngày định dạng chuẩn ISO (ví dụ: "YYYY-MM-DD").
 * @returns Chuỗi ngày đầu tháng định dạng "YYYY-MM-01".
 */
function monthStart(iso: string) {
  return `${iso.slice(0, 7)}-01`;
}


/**
 * This period against the one before it.
 *
 * `upIsGood` is asked for rather than assumed. These three tiles sit in a row
 * and two of them mean opposite things: revenue rising is the centre having a
 * good week, refunds rising is the centre having a bad one. A single colour
 * rule keyed on the sign would paint a week of refunds green.
 */
/**
 * Làm gì: Tính toán tỷ lệ phần trăm thay đổi và xác định xu hướng (tăng/giảm tốt hay xấu) so với kỳ trước để hiển thị badge chỉ số Stat.
 * Được gọi ở: src/routes/manager.index.tsx (hiển thị trend doanh thu với upIsGood=true và tiền hoàn trả với upIsGood=false).
 * @param cur Giá trị số liệu kỳ hiện tại (ví dụ: tổng doanh thu hoặc tổng tiền hoàn).
 * @param prev Giá trị số liệu kỳ trước đó liền kề có cùng độ dài thời gian.
 * @param upIsGood Quy ước hướng tăng là tích cực (true) hay tiêu cực (false). Ví dụ: doanh thu tăng là tốt (true), nhưng hoàn tiền tăng là xấu (false).
 * @returns Đối tượng Trend gồm { pct, label, good } dùng trực tiếp cho component Stat.
 */
function delta(cur: number, prev: number, upIsGood: boolean): Trend {
  // Xử lý trường hợp biên: kỳ trước không có dữ liệu (prev === 0) để tránh lỗi chia cho 0
  if (prev === 0 && cur === 0) return { pct: 0, label: t("Same as the previous period"), good: null };
  if (prev === 0) return { pct: null, label: t("New this period"), good: upIsGood };
  // Tính % thay đổi theo công thức (cur - prev) / |prev| * 100, làm tròn 1 chữ số thập phân (nhân 1000 rồi chia 10)
  const pct = Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10;
  const sign = pct > 0 ? "+" : "";
  return {
    pct,
    label: t("{pct}% vs the previous period", { pct: `${sign}${pct}` }),
    good: pct === 0 ? null : pct > 0 === upIsGood,
  };
}


/**
 * Axis ticks in the shortest form that is still unambiguous.
 *
 * Full VND on an axis is six to nine digits per tick, which crowds them into
 * each other; the tooltip carries the exact figure.
 */
/**
 * Làm gì: Rút gọn số tiền VNĐ thành dạng ngắn gọn (k, tr) để nhãn trục tọa độ biểu đồ không bị tràn hoặc đè lên nhau.
 * Được gọi ở: src/routes/manager.index.tsx (truyền vào thuộc tính tickFormatter của trục YAxis trên các biểu đồ AreaChart và BarChart).
 * @param v Số tiền VNĐ cần rút gọn.
 * @returns Chuỗi tiền tệ rút gọn (ví dụ: 1.500.000 -> "1.5tr", 50.000 -> "50k", 0 -> "0").
 */
function compactVnd(v: number): string {
  if (!v) return "0";
  // Rút gọn từ hàng triệu trở lên thành đơn vị "tr", làm tròn 1 chữ số thập phân (ví dụ: 1.500.000 -> "1.5tr")
  if (Math.abs(v) >= 1_000_000) return `${Math.round(v / 100_000) / 10}tr`;
  // Rút gọn từ hàng nghìn trở lên thành đơn vị "k" (ví dụ: 50.000 -> "50k")
  if (Math.abs(v) >= 1_000) return `${Math.round(v / 1_000)}k`;
  return String(v);
}


/** One tooltip skin for every chart on the page, in the app's own surface. */
/**
 * Làm gì: Cấu hình giao diện (theme) và bộ định dạng tiền tệ đồng nhất cho tooltip của tất cả biểu đồ Recharts trên trang.
 * Được gọi ở: src/routes/manager.index.tsx (truyền qua props {...TOOLTIP} cho component Tooltip của AreaChart và BarChart).
 */
const TOOLTIP = {
  // Định dạng giá trị hiển thị trên tooltip thành chuỗi tiền tệ VNĐ đầy đủ qua hàm money()
  formatter: (v: unknown) => money(Number(v ?? 0)),
  contentStyle: {
    background: "var(--color-surface)",
    border: "1px solid var(--color-line)",
    borderRadius: 12,
    fontSize: 12,
  },
  labelStyle: { color: "var(--color-muted)", fontSize: 12 },
  itemStyle: { color: "var(--color-fg)", fontWeight: 600 },
} as const;


/**
 * Làm gì: Tạo và kích hoạt tải xuống file CSV trực tiếp từ trình duyệt từ mảng dữ liệu 2 chiều.
 * Được gọi ở: src/routes/manager.index.tsx (sự kiện onClick của nút Export CSV để xuất bảng doanh thu tổng hợp).
 * @param filename Tên file CSV khi tải về máy (ví dụ: "lelong-report-2026-11-01_2026-11-16.csv").
 * @param rows Mảng 2 chiều chứa các hàng và ô dữ liệu (chuỗi hoặc số).
 * @returns Không trả về giá trị (tự động tạo thẻ a và kích hoạt click tải xuống).
 */
function downloadCsv(filename: string, rows: (string | number)[][]) {
  // Bước 1: Chuyển đổi dữ liệu thành các dòng CSV: bọc từng ô trong dấu nháy kép, escape dấu nháy kép bên trong và phân tách cột bằng dấu chấm phẩy (;)
  const body = rows
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(";"))
    .join("\r\n");
  // Bước 2: Thêm ký tự BOM (\uFEFF) ở đầu nội dung để Microsoft Excel nhận diện đúng mã hóa UTF-8 tiếng Việt có dấu mà không bị lỗi font
  const blob = new Blob(["\uFEFF" + body], { type: "text/csv;charset=utf-8" });
  // Bước 3: Tạo thẻ <a> ẩn chứa URL của Blob, kích hoạt click tải file về máy người dùng rồi thu hồi URL bộ nhớ tạm (revokeObjectURL)
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Làm gì: Hook quản trị tổng hợp dữ liệu báo cáo cho trang Manager Overview; quản lý bộ lọc ngày, phương thức thanh toán, gọi các endpoint doanh thu, công suất sân, danh sách nhân viên để cảnh báo thiếu hụt và chuẩn bị dữ liệu biểu đồ.
 * Được gọi ở: src/routes/manager.index.tsx (component Page tại route /manager/).
 * @returns Đối tượng chứa các state bộ lọc (from, to, period, method), kết quả truy vấn API (revRead, occRead, mapRead), cờ cảnh báo nhân sự (missingReceptionist, missingCoach), hàm applyPeriod và dữ liệu biểu đồ đã định dạng (chartData, sourceData, trendData, showTrend).
 */
export function useManagerOverview() {
  // Bước 1: Khởi tạo các state quản lý khoảng thời gian (từ ngày - đến ngày), chế độ chọn nhanh (period), và phương thức thanh toán (method)
  const today = todayISO();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [period, setPeriod] = useState("today");
  const [method, setMethod] = useState("");
  // Bước 2: Tải dữ liệu từ các API backend (báo cáo doanh thu theo kỳ, công suất sân và sơ đồ ô giờ ngày cuối, danh sách nhân sự)
  // The server returns the previous window of the same length alongside, with
  // the same method filter, so the comparison is always like for like.
  const revRead = useRead<Rev>(`/reports/revenue?from=${from}&to=${to}${method ? `&method=${method}` : ""}`);
  // Court usage and the map are about the last day of the window only, so a window the server
  // refuses leaves them standing.
  const occRead = useRead<Occ>(`/reports/occupancy?date=${to}`);
  const mapRead = useRead<{ courts: Court[]; slots: OccSlot[] }>(`/occupancy?date=${to}`);
  // Giới hạn 100 nhân viên để kiểm tra sự hiện diện của các vị trí vận hành thiết yếu
  const staffRead = useRead<{ items: Array<{ role: string; status: string }> }>("/staff?limit=100");
  const rev = revRead.data;
  const prev = rev?.prev ?? null;
  const occ = occRead.data;
  const map = mapRead.data;
  // Bước 3: Kiểm tra cảnh báo vận hành nếu cơ sở chưa có lễ tân hoặc huấn luyện viên đang hoạt động (active) để hiển thị banner nhắc nhở
  const activeReceptionists = staffRead.data?.items.filter((s) => s.role === "receptionist" && s.status === "active") ?? [];
  const activeCoaches = staffRead.data?.items.filter((s) => s.role === "coach" && s.status === "active") ?? [];
  const hasLoadedStaff = !!staffRead.data;
  const missingReceptionist = hasLoadedStaff && activeReceptionists.length === 0;
  const missingCoach = hasLoadedStaff && activeCoaches.length === 0;
  // Bước 4: Xử lý lỗi xác thực khoảng ngày từ server (ví dụ: ngày kết thúc trước ngày bắt đầu hoặc khoảng ngày vượt quá giới hạn)
  // A window the server refuses (backwards, far too long) is said once, where the numbers would
  // be, with the date box it is about marked. Asking again gets the same words, so there is no
  // "Try again", and nothing counted from the window is shown as if it were zero.
  const revError = revRead.error;
  const refused = revError?.refused === true;
  // Xác định ô nhập ngày cụ thể (from hoặc to) bị đánh dấu lỗi để highlight viền đỏ trên giao diện
  const faulty = (f: "from" | "to") => refused && (revError?.field ? revError.field === f : true);
  const dayError = occRead.error ?? mapRead.error;
  // Đợi sau khi mount trên trình duyệt mới render biểu đồ Recharts nhằm tránh lỗi hydration mismatch giữa client và SSR
  const [chartReady, setChartReady] = useState(false);
  useEffect(() => setChartReady(true), []);

  /**
   * Làm gì: Áp dụng khoảng thời gian nhanh (hôm nay, 7 ngày qua, hoặc từ đầu tháng đến nay) cho bộ lọc báo cáo.
   * Được gọi ở: src/client/lib/pages/manager.index.ts (useManagerOverview) và src/routes/manager.index.tsx (bộ chọn Seg).
   * @param p Mã khoảng thời gian: "today" (hôm nay), "week" (7 ngày qua), "month" (từ đầu tháng).
   */
  function applyPeriod(p: string) {
    setPeriod(p);
    if (p === "today") {
      setFrom(today);
      setTo(today);
    } else if (p === "week") {
      // 7 ngày gần nhất tính cả hôm nay (lùi 6 ngày từ ngày hiện tại)
      setFrom(addDaysISO(today, -6));
      setTo(today);
    } else if (p === "month") {
      // Lấy từ ngày mùng 1 của tháng hiện tại đến ngày hôm nay
      setFrom(monthStart(today));
      setTo(today);
    }
  }

  // Bước 5: Chuyển đổi và định dạng dữ liệu cho các biểu đồ (doanh thu theo phương thức, theo nguồn và xu hướng theo ngày)
  const chartData = Object.entries(rev?.by_method ?? {}).map(([k, v]) => ({
    name: methodLabel(k),
    vnd: v,
  }));
  // Biggest first: a magnitude comparison is read down the list, and leaving it
  // in map order makes the reader do the sorting themselves.
  const sourceData = Object.entries(rev?.by_source ?? {})
    .map(([k, v]) => ({ name: sourceLabel(k), vnd: v }))
    .sort((a, b) => b.vnd - a.vnd);
  // Rút gọn ngày dạng "YYYY-MM-DD" thành "DD/MM" để hiển thị gọn gàng trên trục hoành biểu đồ xu hướng
  const trendData = (rev?.by_day ?? []).map((d) => ({
    day: d.day.slice(8) + "/" + d.day.slice(5, 7),
    vnd: d.revenue_vnd,
  }));
  // One day is a point, not a trend — the tiles above already say that number.
  const showTrend = trendData.length > 1;
  // Bước 6: Trả về state bộ lọc, các hàm cập nhật và dữ liệu đã qua xử lý cho component Page tiêu thụ
  return {
    from, setFrom, to, setTo, period, setPeriod, method, setMethod, revRead, occRead, mapRead, rev,
    prev, occ, map, missingReceptionist, missingCoach, revError, refused, faulty, dayError,
    chartReady, applyPeriod, chartData, sourceData, trendData, showTrend,
  };
}

export { delta, compactVnd, TOOLTIP, downloadCsv };
