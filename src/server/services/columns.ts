/**
 * File: src/server/services/columns.ts
 * Vai trò: Định nghĩa danh sách các cột cố định cho các bảng dữ liệu cốt lõi (court_bookings, payments, invoices) để thay thế hoàn toàn cú pháp "SELECT *".
 * Vị trí trong app: Thuộc tầng server services, cung cấp các hằng số danh sách cột cho các handler API (bookings, desk) khi truy vấn database và hỗ trợ tx.test.ts kiểm tra tính toàn vẹn của schema.
 */
import type { Booking, Invoice, Payment } from "../../shared/arena3/contracts";

/**
 * Column lists for the rows the API sends whole, in place of `select *`.
 *
 * Each list is written as a `Record` over the row type, so a column the type
 * names but the list forgets (or the reverse) fails to compile. `tx.test.ts`
 * checks the same lists against the migrated tables, so a migration that adds
 * a column fails a test instead of quietly widening every response.
 */
/**
 * Làm gì: Chuyển đổi đối tượng Record định nghĩa các cột của kiểu T thành chuỗi tên cột phân tách bằng dấu phẩy để dùng trong câu lệnh SQL SELECT. Bắt buộc kiểm tra kiểu tĩnh (type-safe) tại thời điểm compile để danh sách cột luôn khớp chính xác với kiểu T.
 * Được gọi ở: src/server/services/columns.ts (nội bộ file: khởi tạo BOOKING_COLS, PAYMENT_COLS, INVOICE_COLS).
 * @param cols Đối tượng Record ánh xạ từng thuộc tính của kiểu T với giá trị boolean true.
 * @returns Chuỗi tên các cột phân tách bởi dấu phẩy và khoảng trắng (ví dụ: "id, code, user_id, ...").
 */
function list<T>(cols: Record<keyof T, true>): string {
  return Object.keys(cols).join(", ");
}

/**
 * Làm gì: Chuỗi danh sách toàn bộ các cột của bảng court_bookings phân tách bằng dấu phẩy. Dùng trong các câu lệnh SQL SELECT thay cho "SELECT *" để nạp toàn bộ một hàng đặt sân vào đúng kiểu TypeScript Booking.
 * Được gọi ở:
 * - src/server/controllers/handlers/bookings.ts: các hàm bookingsHold, settleHeldBooking, bookingsCancel, bookingsWalkIn, bookingsTransferConfirm, bookingsCheckIn
 * - test runner (node --test): src/server/controllers/tx.test.ts (kiểm tra khớp schema bảng court_bookings)
 */
export const BOOKING_COLS = list<Booking>({
  id: true,
  code: true,
  court_id: true,
  user_id: true,
  guest_name: true,
  guest_phone: true,
  start_at: true,
  end_at: true,
  status: true,
  channel: true,
  price_vnd: true,
  discount_pct: true,
  vat_rate: true,
  hold_until: true,
  occupancy_id: true,
  quota_hours: true,
  transfer_requested_at: true,
  promo_id: true,
  promo_discount_vnd: true,
  series_id: true,
  deposit_vnd: true,
  paid_vnd: true,
  cancel_refund_pct: true,
  cancel_fee_vnd: true,
});

/**
 * Làm gì: Chuỗi danh sách toàn bộ các cột của bảng payments phân tách bằng dấu phẩy. Dùng trong các câu lệnh SQL SELECT hoặc RETURNING thay cho "SELECT *" để nạp hoặc trả về toàn bộ một hàng thanh toán vào đúng kiểu TypeScript Payment.
 * Được gọi ở:
 * - src/server/controllers/handlers/bookings.ts: các hàm settleHeldBooking, bookingsWalkIn, bookingsTransferConfirm
 * - src/server/controllers/handlers/desk.ts: hàm deskPaymentsCreate
 * - test runner (node --test): src/server/controllers/tx.test.ts (kiểm tra khớp schema bảng payments)
 */
export const PAYMENT_COLS = list<Payment>({
  id: true,
  code: true,
  user_id: true,
  shift_id: true,
  method: true,
  amount_vnd: true,
  vat_rate: true,
  status: true,
  ref_type: true,
  ref_id: true,
  created_by: true,
  created_at: true,
  capture_mode: true,
  provider: true,
  provider_order_code: true,
  provider_txn_id: true,
  provider_status: true,
  paid_at: true,
  promo_id: true,
  discount_vnd: true,
});

/**
 * Làm gì: Chuỗi danh sách toàn bộ các cột của bảng invoices phân tách bằng dấu phẩy. Dùng trong các câu lệnh SQL SELECT thay cho "SELECT *" để nạp toàn bộ một hàng hóa đơn vào đúng kiểu TypeScript Invoice.
 * Được gọi ở:
 * - src/server/controllers/handlers/desk.ts: hàm deskPaymentsCreate
 * - test runner (node --test): src/server/controllers/tx.test.ts (kiểm tra khớp schema bảng invoices)
 */
export const INVOICE_COLS = list<Invoice>({
  id: true,
  code: true,
  payment_id: true,
  buyer_name: true,
  buyer_tax_code: true,
  issued_at: true,
  form_no: true,
  serial_no: true,
  buyer_address: true,
  seller_legal_name: true,
  seller_tax_code: true,
  seller_address: true,
  subtotal_vnd: true,
  vat_rate: true,
  vat_vnd: true,
  total_vnd: true,
  buyer_phone: true,
  exported_at: true,
});
