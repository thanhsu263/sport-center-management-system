/**
 * Tiện ích quy tắc nghiệp vụ (pure functions) cho hệ thống Arena3.
 * File này xử lý các quy tắc về tiền cọc (deposit), chính sách hoàn tiền khi hủy đặt sân (cancellation refund tiers)
 * và tính toán lịch đặt sân cố định hàng tuần (fixed weekly series).
 * Các hàm được viết dưới dạng hàm thuần túy (pure functions), không truy vấn trực tiếp database
 * để dễ dàng kiểm thử độc lập và tái sử dụng ở các controller/handler.
 */
import type { CancelQuote, CancelTier } from "../../shared/arena3/contracts";
import { err } from "../controllers/errors";
import { addDays, ictDateTime, ictWeekday, roundVnd } from "../../shared/arena3/time";

/**
 * Money and calendar rules for deposits, late cancellation and fixed weekly
 * bookings. Pure functions on purpose: the handlers read the database, these
 * only decide, so the rules can be tested without one.
 */

export type { CancelQuote, CancelTier };

/** What most Vietnamese venues publish: 24h+ free, 4–24h half, under 4h nothing. */
export const DEFAULT_CANCEL_TIERS: CancelTier[] = [
  { hours: 24, refund_pct: 100 },
  { hours: 4, refund_pct: 50 },
  { hours: 0, refund_pct: 0 },
];

/**
 * Check the tiers a manager typed. They must start from the longest notice and
 * only ever refund less as the notice gets shorter, and the last tier must be
 * "0 hours" so that every cancellation lands somewhere.
 */
export function parseCancelTiers(v: unknown): CancelTier[] {
  // Bước 1: Kiểm tra cấu trúc danh sách mốc hủy, yêu cầu phải là mảng từ 1 đến 6 bậc để giao diện không bị quá tải.
  if (!Array.isArray(v) || v.length < 1 || v.length > 6) {
    throw err.field("cancel_tiers", "Add between 1 and 6 cancellation steps.");
  }
  // Bước 2: Chuẩn hóa và xác thực dữ liệu từng bậc (số giờ báo trước từ 0 đến 720 giờ tức tối đa 30 ngày, tỷ lệ hoàn tiền từ 0% đến 100%).
  const tiers = v.map((raw) => {
    const r = raw as { hours?: unknown; refund_pct?: unknown };
    const hours = Number(r.hours);
    const pct = Number(r.refund_pct);
    if (!Number.isInteger(hours) || hours < 0 || hours > 720) {
      throw err.field("cancel_tiers", "Hours must be a whole number from 0 to 720.");
    }
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
      throw err.field("cancel_tiers", "A refund must be a whole percentage from 0 to 100.");
    }
    return { hours, refund_pct: pct };
  });
  // Bước 3: Sắp xếp các bậc theo số giờ giảm dần để bậc có thời gian báo trước xa nhất đứng đầu.
  tiers.sort((a, b) => b.hours - a.hours);
  // Bước 4: Kiểm tra tính hợp lý giữa các bậc: không trùng số giờ và hủy càng sát giờ thì tỷ lệ hoàn tiền chỉ được giảm dần.
  for (let i = 1; i < tiers.length; i += 1) {
    if (tiers[i]!.hours === tiers[i - 1]!.hours) {
      throw err.field("cancel_tiers", "Two steps cannot start at the same number of hours.");
    }
    if (tiers[i]!.refund_pct > tiers[i - 1]!.refund_pct) {
      throw err.field("cancel_tiers", "A later cancellation cannot be refunded more than an earlier one.");
    }
  }
  // Bước 5: Bắt buộc bậc cuối cùng phải là 0 giờ để mọi trường hợp hủy sát giờ đều có tỷ lệ áp dụng rõ ràng.
  if (tiers[tiers.length - 1]!.hours !== 0) {
    throw err.field("cancel_tiers", "The last step must start at 0 hours, so every cancellation is covered.");
  }
  return tiers;
}

/** The refund percentage a cancellation `hoursLeft` before the start earns. */
export function refundPctFor(tiers: CancelTier[], hoursLeft: number): number {
  // Bước 1: Sắp xếp các bậc giảm dần theo số giờ để bậc có mốc thời gian báo trước lớn nhất được kiểm tra trước tiên.
  const sorted = [...tiers].sort((a, b) => b.hours - a.hours);
  for (const t of sorted) if (hoursLeft >= t.hours) return t.refund_pct;
  // Bước 2: Nếu thời gian còn lại không khớp bậc nào (ví dụ hủy sát giờ hoặc đã qua giờ bắt đầu), áp dụng tỷ lệ của bậc cuối cùng.
  return sorted[sorted.length - 1]?.refund_pct ?? 0;
}

/**
 * Làm gì: Tính toán chi tiết báo giá hủy đặt sân, gồm số giờ báo trước, tỷ lệ hoàn tiền, số tiền hoàn trả khách và phí phạt hủy giữ lại.
 * Được gọi ở: src/server/controllers/handlers/bookings.ts (trong bookingCancelQuote xem trước báo giá hủy và bookingsCancel khi thực hiện hủy).
 * @param args.tiers Danh sách các bậc chính sách hủy của sân (số giờ báo trước và % hoàn tiền).
 * @param args.startAt Thời điểm bắt đầu của lượt đặt sân (chuỗi ISO hoặc đối tượng Date).
 * @param args.paidVnd Số tiền khách đã thanh toán cho lượt đặt sân (VNĐ).
 * @param args.now Mốc thời gian tính toán hiện tại tùy chọn (mili-giây), mặc định là Date.now().
 * @param args.waived Cờ miễn phí phạt hủy (true khi trung tâm hủy hoặc nhân viên miễn phạt, được hoàn 100%).
 * @returns CancelQuote Đối tượng chứa chi tiết báo giá hủy gồm hours_left, refund_pct, paid_vnd, refund_vnd, fee_vnd, waived.
 */
export function quoteCancel(args: {
  tiers: CancelTier[];
  startAt: string | Date;
  paidVnd: number;
  now?: number;
  waived?: boolean;
}): CancelQuote {
  // Bước 1: Tính số giờ còn lại từ thời điểm hiện tại đến lúc bắt đầu đặt sân (chia 3_600_000 ms để đổi sang giờ).
  const hoursLeft = (new Date(args.startAt).getTime() - (args.now ?? Date.now())) / 3_600_000;
  // Bước 2: Xác định tỷ lệ hoàn tiền: nếu được miễn phạt (waived) thì hoàn 100%, ngược lại tra cứu theo các bậc chính sách.
  const pct = args.waived ? 100 : refundPctFor(args.tiers, hoursLeft);
  // Bước 3: Tính số tiền hoàn trả theo phần trăm số tiền đã thanh toán, không vượt quá tổng số tiền khách đã trả.
  const refund = Math.min(args.paidVnd, Math.round((args.paidVnd * pct) / 100));
  // Bước 4: Trả về đối tượng báo giá hủy, làm tròn số giờ còn lại đến 1 chữ số thập phân và tính phí phạt hủy giữ lại.
  return {
    hours_left: Math.round(hoursLeft * 10) / 10,
    refund_pct: pct,
    paid_vnd: args.paidVnd,
    refund_vnd: refund,
    fee_vnd: args.paidVnd - refund,
    waived: !!args.waived,
  };
}

/**
 * How much of a booking has to be paid to confirm it.
 *
 * 0 means "the whole price" — a booking with no deposit rule is paid in full,
 * exactly as before. A deposit never exceeds the price and is rounded to the
 * centre's rounding step so a bank transfer is a figure a person can type.
 */
export function depositFor(args: {
  priceVnd: number;
  pct: number;
  peakOnly: boolean;
  isPeak: boolean;
  round: number;
}): number {
  // Bước 1: Nếu không cấu hình tỷ lệ cọc hoặc giá đặt sân là 0đ thì không thu cọc riêng (0 nghĩa là thanh toán toàn bộ).
  if (args.pct <= 0 || args.priceVnd <= 0) return 0;
  // Bước 2: Nếu chính sách cọc chỉ áp dụng cho giờ cao điểm nhưng khung giờ này là thấp điểm thì không thu cọc.
  if (args.peakOnly && !args.isPeak) return 0;
  // Bước 3: Tính tiền cọc theo phần trăm và làm tròn theo bước giá của trung tâm (ví dụ 1.000đ) để khách dễ chuyển khoản.
  const d = Math.min(args.priceVnd, roundVnd((args.priceVnd * args.pct) / 100, args.round));
  // Bước 4: Nếu tiền cọc sau làm tròn bằng hoặc lớn hơn giá trị đơn đặt thì trả về 0 để thu trọn vẹn toàn bộ giá đơn.
  return d >= args.priceVnd ? 0 : d;
}

/** What to collect now for a held booking. */
export function dueNow(b: { price_vnd: number; deposit_vnd?: number | null }): number {
  // Nếu có tiền cọc hợp lệ (lớn hơn 0 và nhỏ hơn tổng giá) thì chỉ thu tiền cọc trước, ngược lại thu toàn bộ tiền sân.
  const d = Number(b.deposit_vnd ?? 0);
  return d > 0 && d < b.price_vnd ? d : b.price_vnd;
}

/**
 * The calendar days of a fixed weekly booking, as `YYYY-MM-DD` in the centre's
 * time zone. `firstDate` is the first session; the rest follow every 7 days.
 */
export function seriesDates(firstDate: string, weeks: number): string[] {
  // Tạo danh sách chuỗi ngày YYYY-MM-DD cho từng tuần, mỗi buổi cách nhau đúng 7 ngày.
  return Array.from({ length: weeks }, (_, i) => addDays(firstDate, i * 7));
}

/**
 * Làm gì: Xác định chỉ số thứ trong tuần (0: Chủ nhật đến 6: Thứ bảy) theo múi giờ Việt Nam (ICT) cho chuỗi đặt sân cố định.
 * Được gọi ở: src/server/controllers/handlers/extras.ts (trong seriesPreview, seriesCreate và resolveSeriesWeekdayVietnamese).
 * @param firstDate Chuỗi ngày của buổi đầu tiên theo định dạng YYYY-MM-DD.
 * @param startLocal Giờ bắt đầu trong ngày theo định dạng HH:mm.
 * @returns Số nguyên từ 0 (Chủ nhật) đến 6 (Thứ bảy).
 */
export function seriesWeekday(firstDate: string, startLocal: string): number {
  // Ghép ngày và giờ thành mốc thời gian ICT để xác định thứ trong tuần khớp với getDay() của JS.
  return ictWeekday(ictDateTime(firstDate, startLocal));
}
