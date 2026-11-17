/**
 * Quản lý định giá và tính toán chiết khấu cho các khung giờ thuê sân (court slots).
 * File này tra cứu bảng giá niêm yết price_rules theo môn thể thao, loại ngày và khung giờ ICT,
 * đảm bảo tuân thủ quy tắc nghiệp vụ BR-37 (từ chối báo giá nếu chưa cấu hình giá hợp lệ),
 * và tính số tiền sau chiết khấu được làm tròn theo đơn vị VNĐ quy định.
 */
import type { Sql } from "@/server/data/db";
import { err } from "../controllers/errors";
import { slotPriceOk } from "./rules";
import { ictMinutes, isWeekendIct, roundVnd } from "../../shared/arena3/time";

export type PriceRule = {
  id: string;
  sport: string;
  court_id: string | null;
  day_kind: string;
  start_local: string;
  end_local: string;
  price_vnd: number;
  is_peak: boolean;
  start_min: number;
  end_min: number;
};

/**
 * Làm gì: Tra cứu giá niêm yết (price_vnd) và trạng thái giờ cao điểm (is_peak) cho khung giờ thuê sân cụ thể. Ưu tiên quy tắc riêng của sân trước quy tắc chung của môn.
 * Được gọi ở: handlers/bookings.ts (bookingsHold, checkBookingsReschedulePrice, calculateWalkInPrice), handlers/extras.ts (seriesQuote), handlers/promos.ts (quoteCourtPromo).
 * @param sql Kết nối database để truy vấn bảng price_rules.
 * @param opts Thông tin tra cứu gồm môn thể thao (sport), mã sân (courtId) và thời điểm bắt đầu ca (start).
 * @returns Object chứa price_vnd (đơn giá VNĐ) và is_peak (true nếu là khung giờ cao điểm).
 * @throws Lỗi 422 BR-37 (BR_VIOLATION) nếu khung giờ chưa có giá hoặc giá không hợp lệ (không phải số nguyên dương trong giới hạn).
 */
export async function lookupPrice(
  sql: Sql,
  opts: { sport: string; courtId: string; start: Date },
): Promise<{ price_vnd: number; is_peak: boolean }> {
  // Bước 1: Xác định loại ngày (weekend nếu thứ Bảy/CN, weekday nếu ngày thường) và số phút từ 00:00 theo múi giờ Việt Nam (ICT).
  const dayKind = isWeekendIct(opts.start) ? "weekend" : "weekday";
  const minutes = ictMinutes(opts.start);
  // Bước 2: Truy vấn các quy tắc giá khớp môn, loại ngày và thời điểm bắt đầu. Đưa quy tắc riêng của sân (court_id khác null) lên trước.
  const rules = await sql.query<PriceRule>(
    `select id, sport, court_id, day_kind, start_local::text, end_local::text,
            price_vnd, is_peak, start_min, end_min
       from price_rules
      where sport = $1 and day_kind = $2
        and start_min <= $3 and end_min > $3
      order by (court_id is not null) desc`,
    [opts.sport, dayKind, minutes],
  );
  // Bước 3: Tìm quy tắc giá phù hợp, ưu tiên quy tắc riêng của sân (courtRule) trước quy tắc mặc định của môn (sportRule).
  const courtRule = rules.find((rule) => rule.court_id === opts.courtId);
  const sportRule = rules.find((rule) => rule.court_id == null);
  const priceRule = courtRule ?? sportRule;
  // Bước 4: Kiểm tra tính hợp lệ của giá theo quy tắc nghiệp vụ BR-37.
  // BR-37. No rule is not a free court, and a rule outside the bounds a
  // price can have is not a price — 0đ or 99,999,999đ both came from a table
  // somebody edited by hand. Refuse to quote either; callers look the price up
  // before `booking_replace_hold`, so the member's current hold survives.
  if (!priceRule || !slotPriceOk(priceRule.price_vnd)) {
    throw err.br("BR-37", "There is no price for that slot yet — ask the desk.", {
      sport: opts.sport,
      day_kind: dayKind,
    });
  }
  // Bước 5: Trả về đơn giá niêm yết (VNĐ) và trạng thái giờ cao điểm (is_peak).
  return { price_vnd: priceRule.price_vnd, is_peak: priceRule.is_peak };
}

/**
 * Làm gì: Tính giá tiền sau khi trừ phần trăm giảm giá (discountPct) và làm tròn theo bước quy định (mặc định 1.000đ).
 * Được gọi ở: handlers/bookings.ts (checkBookingsReschedulePrice), handlers/extras.ts (seriesQuote).
 * @param listPrice Giá gốc niêm yết (VNĐ).
 * @param discountPct Phần trăm giảm giá (từ 0 đến 100).
 * @param roundingStep Bước làm tròn tiền VNĐ (mặc định 1.000đ để tránh tiền lẻ).
 * @returns Số tiền sau chiết khấu đã được làm tròn thành số nguyên VNĐ.
 */
export function applyDiscount(listPrice: number, discountPct: number, roundingStep = 1000): number {
  return roundVnd(listPrice * (1 - discountPct / 100), roundingStep);
}
