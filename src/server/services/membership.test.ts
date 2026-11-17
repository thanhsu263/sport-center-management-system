/**
 * Mục đích file:
 * Kiểm thử đơn vị (unit test) cho các tiện ích tính toán gói hội viên trong src/server/services/membership.ts.
 * Bao gồm: tính ngày cộng thêm tháng (addMonths), kiểm tra điều kiện hạn hội viên bao trọn lớp học (outlastsClass),
 * tính toán số ngày và số tiền hoàn lại khi hủy lớp kèm gia hạn (computeRollback), và gợi ý gói tập rẻ nhất (planToOutlast).
 *
 * Vị trí trong hệ thống:
 * Chạy độc lập trong bộ test runner (node --test), bảo đảm các quy tắc nghiệp vụ về thẻ hội viên và tính toán tiền tệ
 * hoạt động chính xác tuyệt đối trước khi áp dụng vào các luồng đăng ký lớp học, gia hạn và hoàn tiền.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { addMonths, computeRollback, outlastsClass, planToOutlast } from "./membership";

// Đơn giá ngày mẫu (500.000 VNĐ / 30 ngày ≈ 16.667 VNĐ/ngày) dùng để tính tiền hoàn gia hạn
const dayRate = 16667;
// Danh sách các gói tập mẫu với giá và thời hạn tính theo tháng dùng cho bài test gợi ý gói phù hợp
const plans = [
  { price_vnd: 500_000, duration_months: 1 },
  { price_vnd: 1_350_000, duration_months: 3 },
  { price_vnd: 2_400_000, duration_months: 6 },
];

/**
 * Làm gì: Kiểm tra hàm addMonths tự động co về ngày cuối tháng (clamp) nếu tháng sau ngắn hơn ngày hiện tại.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("addMonths clamps to the last day of a shorter month", () => {
  // Ngày 31/01 cộng 1 tháng rơi vào tháng 2 không nhuận -> co về 28/02; 30/11 cộng 3 tháng cũng co về 28/02
  assert.equal(addMonths("2027-01-31", 1), "2027-02-28");
  assert.equal(addMonths("2026-11-30", 3), "2027-02-28");
  assert.equal(addMonths("2026-12-15", 1), "2027-01-15");
});

/**
 * Làm gì: Kiểm tra quy tắc nghiệp vụ BR-19: hạn thẻ hội viên phải kết thúc sau ngày kết thúc của lớp học (strictly after: membershipEnd > classEnd).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("the membership must end strictly after the class", () => {
  // Thẻ phải kết thúc sau lớp (16/01 > 15/01 -> true); trùng ngày hoặc kết thúc trước đều không đủ (false); chưa có thẻ (null) -> false
  assert.equal(outlastsClass("2027-01-16", "2027-01-15"), true);
  assert.equal(outlastsClass("2027-01-15", "2027-01-15"), false);
  assert.equal(outlastsClass("2027-01-14", "2027-01-15"), false);
  assert.equal(outlastsClass(null, "2027-01-15"), false);
});

/**
 * Làm gì: Kiểm tra kịch bản trung tâm thể thao hủy lớp học duy nhất: hoàn lại toàn bộ số ngày gia hạn và 100% số tiền đã đóng.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("the centre cancelling the only class refunds the whole extension", () => {
  // Hôm nay (15/11) chưa đến hạn dùng gia hạn (01/12) và không có lớp khác -> hoàn toàn bộ 62 ngày và 1.033.000 VNĐ
  const r = computeRollback({ fromOn: "2026-12-01", toOn: "2027-01-31", amountVnd: 1_033_000, otherClassEnd: null, today: "2026-11-15", dayRate });
  assert.deepEqual(r, { days: 62, refund_vnd: 1_033_000 });
});

/**
 * Làm gì: Kiểm tra logic chỉ hoàn tiền phần ngày dư thừa: các ngày lớp học khác còn cần (otherClassEnd) sẽ được giữ lại.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("days another class needs are kept and not refunded", () => {
  // Giữ lại thẻ đến 15/01 cho lớp khác, chỉ thu hồi 16 ngày dư (16/01 - 31/01); hoàn 16 * 16.667 = 267.000 VNĐ (làm tròn nghìn)
  const r = computeRollback({ fromOn: "2026-12-01", toOn: "2027-01-31", amountVnd: 1_033_000, otherClassEnd: "2027-01-15", today: "2026-11-15", dayRate });
  assert.deepEqual(r, { days: 16, refund_vnd: 267_000 });
});

/**
 * Làm gì: Kiểm tra trường hợp hủy lớp khi đợt gia hạn đang diễn ra: các ngày đã trôi qua tính đến hôm nay (today) không được hoàn tiền.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("days already used are not refunded", () => {
  // Đã dùng từ 01/12 đến 21/12 (21 ngày), chỉ còn 10 ngày chưa dùng (22/12 - 31/12); hoàn 10 * 16.667 = 167.000 VNĐ
  const r = computeRollback({ fromOn: "2026-12-01", toOn: "2026-12-31", amountVnd: 517_000, otherClassEnd: null, today: "2026-12-22", dayRate });
  assert.equal(r.days, 10);
  assert.equal(r.refund_vnd, 167_000);
});

/**
 * Làm gì: Kiểm tra hàm planToOutlast gợi ý gói hội viên có giá rẻ nhất mà ngày hết hạn sau ngày kết thúc lớp học.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
test("the suggestion is the cheapest plan that ends after the class", () => {
  // Gói 1 tháng (hết hạn 06/12) không đủ; gói 3 tháng (hết hạn 06/02) đủ bao trọn lớp đến 27/01 và rẻ hơn gói 6 tháng
  assert.equal(planToOutlast(plans, "2026-11-06", "2027-01-27")?.duration_months, 3);
  // A 3-month plan would end exactly on the class end, which is not enough.
  assert.equal(planToOutlast(plans, "2026-11-06", "2027-02-06")?.duration_months, 6);
  // Lớp kết thúc quá xa (01/01/2028), không gói nào trong danh sách bao trọn được -> trả về null
  assert.equal(planToOutlast(plans, "2026-11-06", "2028-01-01"), null);
});
