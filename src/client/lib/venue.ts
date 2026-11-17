/**
 * Opening hours and the hold length, as the manager set them (open_time, close_time,
 * hold_minutes in the centre's settings), for copy and grids that used to write "06:00-22:00"
 * and "five minutes" in by hand.
 *
 * Pure functions, no imports: the node test runner checks them directly.
 */

export type Venue = { open: number; close: number; holdMinutes: number };

/** What the centre shipped with; used until the settings arrive, or if they are unreadable. */
/**
 * Làm gì: Cấu hình vận hành mặc định của trung tâm thể thao (mở cửa lúc 06:00, đóng cửa lúc 22:00, thời gian giữ chỗ 5 phút); dùng làm giá trị dự phòng khi chưa tải được cài đặt từ server hoặc dữ liệu bị lỗi.
 * Được gọi ở: src/client/lib/venue.ts (giá trị fallback trong venueFrom), src/client/components/landing/util.tsx, src/client/lib/pages/app.book.ts, src/server/services/arena3.test.ts.
 */
export const DEFAULT_VENUE: Venue = { open: 6, close: 22, holdMinutes: 5 };

/** The settings' raw shape: `HH:MM[:SS]` times and a minute count. */
export type VenueRaw = { open_time?: string | null; close_time?: string | null; hold_minutes?: number | null };

/**
 * Làm gì: Trích xuất chỉ số giờ (từ 0 đến 24) từ chuỗi thời gian định dạng "HH:MM" hoặc "HH:MM:SS" (ví dụ: "06:00" -> 6, "21:30" -> 21); trả về null nếu chuỗi không hợp lệ.
 * Được gọi ở: Nội bộ src/client/lib/venue.ts (trong các hàm closingHour và venueFrom).
 * @param time Chuỗi thời gian định dạng "HH:MM" hoặc "HH:MM:SS" (có thể null hoặc undefined).
 * @returns Số nguyên biểu thị giờ (0-24), hoặc null nếu chuỗi không đúng định dạng hoặc vượt quá 24.
 */
function hourOf(time: string | null | undefined): number | null {
  // Bước 1: Dùng biểu thức chính quy (regex) để trích xuất phần giờ và phút từ chuỗi thời gian HH:MM hoặc HH:MM:SS
  const match = /^(\d{1,2}):(\d{2})/.exec(time ?? "");
  if (!match) return null;
  // Bước 2: Ép kiểu phần giờ sang số và kiểm tra trong phạm vi hợp lệ từ 0 đến 24 giờ (24:00 tính là hết ngày)
  const hour = Number(match[1]);
  return hour >= 0 && hour <= 24 ? hour : null;
}

/**
 * Làm gì: Xác định giờ kết thúc vận hành từ chuỗi thời gian đóng cửa; nếu có số phút lẻ (ví dụ: 21:30), tự động làm tròn lên (thành 22) để khung giờ 21:00-22:00 vẫn có thể phục vụ khách.
 * Được gọi ở: Nội bộ src/client/lib/venue.ts (trong hàm venueFrom).
 * @param time Chuỗi thời gian đóng cửa (ví dụ: "21:00", "21:30").
 * @returns Số nguyên biểu thị giờ đóng cửa đã làm tròn lên (0-24), hoặc null nếu thời gian không hợp lệ.
 */
function closingHour(time: string): number | null {
  // Bước 1: Lấy số giờ cơ sở từ chuỗi thời gian đóng cửa
  const hour = hourOf(time);
  if (hour == null) return null;
  // Bước 2: Kiểm tra nếu có phút lẻ (khác :00) sau dấu ':' thì làm tròn lên thêm 1 giờ để bán trọn khung giờ đó
  const hasPartialHour = /:(?!00)\d{2}/.test(time.slice(time.indexOf(":")));
  return hasPartialHour ? hour + 1 : hour;
}

/**
 * The venue from raw settings, falling back field by field. A close that is not after the open
 * (a typo in the settings) falls back as a pair rather than drawing an empty day.
 */
/**
 * Làm gì: Chuyển đổi dữ liệu cài đặt thô (VenueRaw) từ server thành đối tượng Venue hoàn chỉnh; tự động làm tròn giờ đóng cửa và fallback về DEFAULT_VENUE nếu dữ liệu bị lỗi (giờ đóng không lớn hơn giờ mở).
 * Được gọi ở: src/client/lib/use-centre.ts (hook useCentre), src/client/lib/pages/app.book.ts (useBookingState), src/routes/desk.courts.tsx (CourtsPage), src/routes/index.tsx (LandingRoute), src/server/services/arena3.test.ts.
 * @param raw Dữ liệu cấu hình thô nhận từ server (chứa open_time, close_time, hold_minutes), có thể null hoặc undefined.
 * @returns Đối tượng Venue chứa open, close và holdMinutes đã được chuẩn hóa an toàn.
 */
export function venueFrom(raw?: VenueRaw | null): Venue {
  // Bước 1: Trích xuất giờ mở cửa và giờ đóng cửa (tự động làm tròn lên nếu có phút lẻ)
  const open = hourOf(raw?.open_time);
  // A closing time like 21:30 still sells the 21:00 hour, so the close rounds up.
  const close = closingHour(raw?.close_time ?? "");
  // Bước 2: Ép kiểu số phút giữ chỗ đặt sân (hold_minutes)
  const hold = Number(raw?.hold_minutes);
  // Bước 3: Xác thực tính hợp lệ của cặp giờ mở và đóng cửa (bắt buộc phải có cả hai và close > open)
  const pairOk = open != null && close != null && close > open;
  // Bước 4: Trả về đối tượng Venue hoàn chỉnh; nếu cặp giờ bị sai logic thì fallback cả cặp về DEFAULT_VENUE để tránh vẽ lịch rỗng
  return {
    open: pairOk ? open! : DEFAULT_VENUE.open,
    close: pairOk ? close! : DEFAULT_VENUE.close,
    holdMinutes: Number.isInteger(hold) && hold > 0 ? hold : DEFAULT_VENUE.holdMinutes,
  };
}

/** The bookable hours of the day: open, open + 1, …, close - 1. */
/**
 * Làm gì: Tạo mảng danh sách các mốc giờ có thể đặt sân trong ngày, từ giờ mở cửa (open) đến trước giờ đóng cửa (close - 1).
 * Được gọi ở: src/client/components/landing/schedule.tsx, src/client/lib/pages/app.book.ts (nearestFree), src/routes/desk.courts.tsx, src/routes/index.tsx, src/routes/manager.classes.tsx, src/server/services/arena3.test.ts.
 * @param venue Đối tượng Venue chứa thông tin giờ mở cửa (open) và giờ đóng cửa (close).
 * @returns Mảng số nguyên chứa các giờ có thể nhận lịch đặt sân trong ngày (ví dụ: [6, 7, ..., 21]).
 */
export function hoursOf(venue: Venue): number[] {
  // Tạo mảng gồm (close - open) khung giờ, bắt đầu từ open; dùng Math.max(0, ...) để chống lỗi nếu close < open
  return Array.from({ length: Math.max(0, venue.close - venue.open) }, (_, index) => venue.open + index);
}

/** 6 → "06:00". */
/**
 * Làm gì: Định dạng số giờ thành chuỗi thời gian chuẩn "HH:00" với 2 chữ số (ví dụ: 6 -> "06:00", 22 -> "22:00") để hiển thị lên giao diện.
 * Được gọi ở: src/client/components/landing/closing.tsx, src/client/components/landing/hero.tsx, src/server/services/arena3.test.ts.
 * @param h Số giờ nguyên cần định dạng (từ 0 đến 24).
 * @returns Chuỗi thời gian có dạng "HH:00".
 */
export const hhmm = (h: number) => `${String(h).padStart(2, "0")}:00`;
