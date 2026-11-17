/**
 * File: src/client/components/availability-calendar.tsx
 * Vai trò: Thành phần lịch tháng hiển thị số lượng sân/khung giờ còn trống theo từng ngày và hook tải dữ liệu tình trạng sân trống.
 * Vị trí trong app: Được sử dụng tại trang đặt sân /app/book (src/routes/app.book.tsx) và thanh chọn ngày trong CourtGrid (src/client/components/court-grid.tsx) giúp hội viên tra cứu nhanh ngày còn sân trống để đặt lịch.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { apiGet } from "@/client/arena3/client";
import { cn } from "@/client/lib/cn";
import { addDaysISO, todayISO } from "@/shared/arena3/labels";
import { locale, t, tk } from "@/client/lib/i18n";

/**
 * One day of the calendar: how many court-slots are still free (M-03), and for a member how many
 * courts they already have that day.
 */
export type DayAvail = { date: string; free: number; total: number; bookable: boolean; mine?: number };
export type AvailMap = Record<string, DayAvail>;

/**
 * Làm gì: Giới hạn số ngày tối đa (62 ngày ~ 2 tháng) để tải và hiển thị dữ liệu lịch sân trống tính từ ngày hiện tại.
 * Được gọi ở: useAvailability (gọi API /availability) và MonthCalendar (kiểm tra giới hạn nút Next month).
 */
const SPAN_DAYS = 62;

/**
 * Free-slot counts for the coming two months, in one request. `refreshKey`
 * changes whenever the member's own action could have changed them (a hold, a
 * move), so the calendar never keeps showing a slot they just took.
 */
export function useAvailability(sport: string, refreshKey: unknown): AvailMap | null {
  const [map, setMap] = useState<AvailMap | null>(null);
  // Bước 1: Khởi chạy effect tải dữ liệu lịch trống mỗi khi môn thể thao (sport) hoặc refreshKey thay đổi
  useEffect(() => {
    // Cờ live kiểm soát race condition, ngăn cập nhật state nếu component unmount trước khi API phản hồi
    let live = true;
    // Bước 2: Tạo query param lọc theo môn thể thao nếu có chọn cụ thể
    const q = sport ? `&sport=${encodeURIComponent(sport)}` : "";
    // Bước 3: Gửi request GET tới /availability lấy số slot trống trong vòng SPAN_DAYS (62 ngày) từ hôm nay
    void apiGet<{ days: DayAvail[] }>(`/availability?from=${todayISO()}&days=${SPAN_DAYS}${q}`)
      .then((r) => {
        // Chuyển mảng kết quả thành map theo date dạng { [date]: DayAvail } để tra cứu O(1)
        if (live) setMap(Object.fromEntries(r.days.map((d) => [d.date, d])));
      })
      .catch(() => {
        // The calendar is a convenience: without counts the day buttons still work.
        if (live) setMap({});
      });
    // Bước 4: Cleanup gán live = false khi unmount hoặc effect chạy lại để tránh memory leak
    return () => {
      live = false;
    };
  }, [sport, refreshKey]);
  return map;
}

/**
 * "12 free" / "Full" / nothing, for a day the member cannot book yet.
 */
export function availLabel(a: DayAvail | undefined): string {
  if (!a || !a.bookable) return "";
  return a.free > 0 ? t("{n} free", { n: a.free }) : t("Full");
}

/**
 * Làm gì: Danh sách mã dịch tên các thứ trong tuần (từ Thứ 2 đến Chủ nhật) để hiển thị hàng tiêu đề cột của lịch.
 * Được gọi ở: MonthCalendar (line 126).
 */
const WEEKDAYS = [tk("Mon"), tk("Tue"), tk("Wed"), tk("Thu"), tk("Fri"), tk("Sat"), tk("Sun")];

/**
 * Làm gì: Trả về chuỗi ngày đầu tiên của tháng (YYYY-MM-01) từ một chuỗi ngày ISO bất kỳ.
 * Được gọi ở: MonthCalendar (khởi tạo state month, đồng bộ khi value thay đổi, và kiểm tra điều kiện lùi tháng canPrev).
 * @param iso Chuỗi ngày định dạng YYYY-MM-DD.
 * @returns Chuỗi ngày mùng 1 của tháng dạng YYYY-MM-01.
 */
function monthStart(iso: string) {
  return `${iso.slice(0, 7)}-01`;
}
/**
 * Làm gì: Tịnh tiến tháng theo số lượng tháng chỉ định (tiến hoặc lùi) và trả về ngày đầu tháng mới dạng YYYY-MM-DD.
 * Được gọi ở: MonthCalendar (tính số ngày trong tháng cho cells, chuyển tháng trước/sau khi bấm nút prev/next, và kiểm tra canNext).
 * @param iso Chuỗi ngày ISO YYYY-MM-DD (ngày mùng 1 của tháng).
 * @param by Số tháng cần dịch chuyển (số âm để lùi tháng, số dương để tiến tháng).
 * @returns Chuỗi ngày mùng 1 của tháng mới dạng YYYY-MM-01.
 */
function shiftMonth(iso: string, by: number) {
  const [y, m] = iso.split("-").map(Number);
  // Dùng Date.UTC với ngày cố định là 1 để tránh lỗi nhảy tháng do lệch múi giờ hoặc các tháng có số ngày khác nhau
  const dt = new Date(Date.UTC(y!, m! - 1 + by, 1));
  return dt.toISOString().slice(0, 10);
}
/**
 * Làm gì: Định dạng chuỗi ngày thành tên tháng và năm theo ngôn ngữ hiện tại của người dùng (ví dụ: "tháng 11 năm 2026").
 * Được gọi ở: MonthCalendar (hiển thị tiêu đề tháng ở giữa hai nút chuyển tháng).
 * @param iso Chuỗi ngày ISO YYYY-MM-DD đại diện cho tháng cần hiển thị.
 * @returns Chuỗi tên tháng và năm đã định dạng theo locale hiện tại.
 */
function monthTitle(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale(), {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * A month at a glance: every day says how many slots are left, so "any evening
 * next week" is one look instead of opening each day. A day that is past or not
 * yet open for booking is shown but cannot be picked.
 */
export function MonthCalendar({
  value,
  onChange,
  avail,
}: {
  value: string;
  onChange: (iso: string) => void;
  avail: AvailMap | null;
}) {
  // Bước 1: Khởi tạo ngày hiện tại và state lưu tháng đang xem (mặc định theo ngày được chọn value)
  const today = todayISO();
  const [month, setMonth] = useState(() => monthStart(value));
  // Follow the selected date when it moves to another month (date picker, strip).
  useEffect(() => setMonth(monthStart(value)), [value]);

  // Bước 2: Tạo mảng các ô hiển thị trong tháng (cells), gồm các ô trống đệm đầu tuần và danh sách ngày trong tháng
  const cells = useMemo(() => {
    const first = month;
    // Tính số ô trống đệm đầu tuần sao cho Thứ 2 luôn là cột đầu tiên ((getUTCDay() + 6) % 7)
    const lead = (new Date(`${first}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday first
    const next = shiftMonth(first, 1);
    // 86.400.000 ms = 24h x 60m x 60s x 1.000ms; chia khoảng cách timestamp giữa 2 tháng để tính chính xác số ngày của tháng
    const days = Math.round((Date.parse(next) - Date.parse(first)) / 86400000);
    return [
      ...Array.from({ length: lead }, () => null),
      ...Array.from({ length: days }, (_, i) => addDaysISO(first, i)),
    ];
  }, [month]);

  // Bước 3: Xác định dữ liệu lịch trống đã sẵn sàng hay chưa và kiểm tra điều kiện cho phép chuyển tháng
  const known = avail !== null && Object.keys(avail).length > 0;
  // canPrev: không cho lùi về trước tháng hiện tại; canNext: không cho xem vượt quá phạm vi SPAN_DAYS (62 ngày)
  const canPrev = month > monthStart(today);
  const canNext = shiftMonth(month, 1) <= addDaysISO(today, SPAN_DAYS - 1);

  // Bước 4: Render giao diện lịch tháng gồm thanh điều hướng tháng, tiêu đề các thứ trong tuần và lưới các ô ngày
  return (
    <div className="rounded-[var(--radius-lg)] bg-surface p-3 shadow-[var(--shadow-border)]">
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          aria-label={t("Previous month")}
          disabled={!canPrev}
          onClick={() => setMonth(shiftMonth(month, -1))}
          className="grid size-11 place-items-center rounded-full hover:bg-wood disabled:opacity-30 sm:size-9"
        >
          <ChevronLeft className="size-4" />
        </button>
        <p className="font-display text-lg">{monthTitle(month)}</p>
        <button
          type="button"
          aria-label={t("Next month")}
          disabled={!canNext}
          onClick={() => setMonth(shiftMonth(month, 1))}
          className="grid size-11 place-items-center rounded-full hover:bg-wood disabled:opacity-30 sm:size-9"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-2xs font-medium text-muted">
        {WEEKDAYS.map((d) => (
          <span key={d}>{t(d)}</span>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((iso, i) => {
          if (!iso) return <span key={`pad-${i}`} />;
          const a = avail?.[iso];
          const past = iso < today;
          const open = !past && (known ? Boolean(a?.bookable) : true);
          const on = iso === value;
          const label = availLabel(a);
          return (
            <button
              key={iso}
              type="button"
              disabled={past || !open}
              onClick={() => onChange(iso)}
              aria-pressed={on}
              aria-label={`${iso}${label ? `, ${label}` : ""}`}
              className={cn(
                "flex min-h-14 flex-col items-center justify-center rounded-[var(--radius-md)] px-1 text-center transition-colors",
                on ? "bg-accent text-accent-fg" : open ? "bg-wood/60 hover:bg-wood" : "opacity-40",
              )}
            >
              <span className="font-display text-base tabular-nums leading-none">{Number(iso.slice(8, 10))}</span>
              <span
                className={cn(
                  "mt-1 text-2xs leading-none",
                  on ? "opacity-90" : a && a.free === 0 && open ? "text-muted line-through" : "text-accent-2",
                )}
              >
                {label || (past ? "" : "·")}
              </span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-2xs text-muted">
        {t("Numbers are free court-hours that day. Days further out open for booking as the date approaches.")}
      </p>
    </div>
  );
}
