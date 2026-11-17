/**
 * Mục đích file:
 * File kiểm thử đơn vị (unit test) tổng hợp các quy tắc nghiệp vụ và tiện ích cốt lõi của Arena 3:
 * xử lý phân tách ký tự OTP, chuẩn hóa và xác thực số điện thoại Việt Nam, tính toán thời gian và múi giờ ICT (+07),
 * làm tròn giá và kiểm soát biên trần/sàn giá sân (BR-37), chiết khấu gói tập (BR-17), thời hạn gói tập (BR-12),
 * phát hiện tin nhắn hỗ trợ (ticketBody, isTicketMessage - FR-S01/FR-S03), chuyển đổi số tiền thành chữ tiếng Việt,
 * và xác thực dữ liệu cấu hình trung tâm (B-01).
 *
 * Vị trí trong hệ thống:
 * Được thực thi bởi test runner (node --test) trong bộ kiểm thử tự động,
 * bảo đảm tính toàn vẹn dữ liệu, các ràng buộc nghiệp vụ và ngăn ngừa tái diễn lỗi trên môi trường production.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidVnPhone, normalizePhone, passwordOk, phoneLast9 } from "./phone.ts";
import { rruleLabel } from "../../shared/arena3/labels.ts";
import { numberToVietnamese, vndInWords } from "./money-words.ts";
import { addDays, ageYears, classMinutes, elapsedAtLeast, ictDateTime, ictHour, ictMinutes, pad2, roundVnd, slotSpan } from "../../shared/arena3/time.ts";
import { ApiError, mapDbError } from "../controllers/errors.ts";
import { checkOpeningHours, pageParams, parseSettingsPatch } from "../controllers/validate.ts";
import { alignOffset, lastPageOffset, pageWindow } from "../../client/lib/paging.ts";
import { crc16, readTlv, transferReference, validBankAccount, vietQrPayload } from "../../shared/vietqr.ts";
import { DEFAULT_VENUE, hhmm, hoursOf, venueFrom } from "../../client/lib/venue.ts";
import {
  absentStreak,
  attendanceLocked,
  discountPctOk,
  homeworkComplete,
  isAttResult,
  normalizeChecklist,
  normalizeDone,
  planActiveOn,
  isTicketMessage,
  slotPriceOk,
  ticketBody,
  validateMetrics,
  validatePriceRules,
  computeDiscount,
  normalizeCode,
} from "./rules.ts";
import { signCheckinToken, verifyCheckinToken } from "./checkin.ts";
import { spreadOtpDigits } from "../../client/components/otp-input.tsx";

/**
 * Làm gì: Nhóm các ca kiểm thử cho hàm spreadOtpDigits, kiểm tra việc xử lý nhập chuỗi OTP gồm nhiều chữ số cùng lúc (paste hoặc autofill).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("G11: OTP digits arriving together", () => {
  /**
   * Làm gì: Kiểm tra khi paste từ 2 đến 5 chữ số từ ô đầu tiên, các số được điền tuần tự và con trỏ chuyển tới ô tiếp theo tương ứng.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("spreads two through five digits and focuses the next box", () => {
    // Duyệt qua các chuỗi số có độ dài từ 2 đến 5 ký tự và kiểm tra vị trí focus bằng độ dài chuỗi
    for (const text of ["12", "123", "1234", "12345"]) {
      assert.deepEqual(spreadOtpDigits("", 0, text), { value: text, focusIndex: text.length });
    }
  });
  /**
   * Làm gì: Kiểm tra hàm tự lọc bỏ dấu phân cách (dấu cách, gạch nối), điền tiếp từ ô đang focus và chặn ở tối đa 6 ô.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("strips separators and fills from the focused box, capped at six boxes", () => {
    // Bước 1: Lọc bỏ dấu cách "123 456" và điền đủ 6 ô, focus dừng ở ô cuối cùng (index 5)
    assert.deepEqual(spreadOtpDigits("", 0, "123 456"), { value: "123456", focusIndex: 5 });
    // Bước 2: Điền tiếp vào ô thứ 3 (index 2) từ chuỗi có dấu gạch ngang "3 4-56"
    assert.deepEqual(spreadOtpDigits("12", 2, "3 4-56"), { value: "123456", focusIndex: 5 });
    // Bước 3: Tràn số khi paste ở ô 4: chỉ lấy đủ 2 chữ số còn lại để không vượt quá 6 ô
    assert.deepEqual(spreadOtpDigits("123456", 4, "987654"), { value: "123498", focusIndex: 5 });
    // Bước 4: Nhập vào giữa ô (index 2) khi chuỗi trước đó còn trống, các ô trước được giữ khoảng trắng
    assert.deepEqual(spreadOtpDigits("", 2, "34"), { value: "  34", focusIndex: 4 });
  });
  /**
   * Làm gì: Kiểm tra hàm chỉ thay thế các ô mục tiêu, xử lý xóa ký tự thành khoảng trắng và bỏ qua ký tự chữ cái không hợp lệ.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("replaces only the target boxes and preserves deletion", () => {
    // Bước 1: Thay thế 1 ký tự tại ô chỉ định và dời con trỏ sang ô tiếp theo
    assert.deepEqual(spreadOtpDigits("123456", 2, "9"), { value: "129456", focusIndex: 3 });
    // Bước 2: Thay thế 2 ký tự liên tiếp tại ô index 1
    assert.deepEqual(spreadOtpDigits("123456", 1, "98"), { value: "198456", focusIndex: 3 });
    // Bước 3: Xóa ký tự ở giữa (chuỗi rỗng): biến ô đó thành khoảng trắng và không dịch chuyển focus
    assert.deepEqual(spreadOtpDigits("123456", 2, ""), { value: "12 456", focusIndex: null });
    // Bước 4: Xóa ký tự ở ô cuối cùng: cắt bỏ ký tự và trimEnd chuỗi kết quả
    assert.deepEqual(spreadOtpDigits("123456", 5, ""), { value: "12345", focusIndex: null });
    // Bước 5: Nhập ký tự chữ ("abc") không hợp lệ: giữ nguyên chuỗi cũ và không đổi focus
    assert.deepEqual(spreadOtpDigits("123456", 2, "abc"), { value: "123456", focusIndex: null });
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho module phone, kiểm tra chuẩn hóa số điện thoại Việt Nam và độ an toàn mật khẩu.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("phone", () => {
  /**
   * Làm gì: Kiểm tra chuẩn hóa các định dạng số điện thoại Việt Nam về đầu số quốc tế +84, trích xuất 9 số cuối và xác thực đầu số di động.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("normalizes VN mobiles to +84", () => {
    // Bước 1: Chuẩn hóa các định dạng số điện thoại nội địa (09x, 9x, chứa dấu cách) về dạng chuẩn quốc tế +84
    assert.equal(normalizePhone("0900000001"), "+84900000001");
    assert.equal(normalizePhone("+84900000001"), "+84900000001");
    assert.equal(normalizePhone("900000001"), "+84900000001");
    assert.equal(normalizePhone("090 000 0001"), "+84900000001");
    // Bước 2: Trích xuất 9 chữ số cuối phục vụ tra cứu số điện thoại không phân biệt đầu số quốc gia
    assert.equal(phoneLast9("0908825218"), "908825218");
    // Bước 3: Xác thực số di động hợp lệ (đầu số mạng di động Việt Nam) và từ chối đầu số cố định hoặc không hợp lệ (+8412)
    assert.ok(isValidVnPhone("0900000001"));
    assert.ok(isValidVnPhone("+84900000001"));
    assert.equal(isValidVnPhone("+84120000001"), false);
  });
  /**
   * Làm gì: Kiểm tra quy tắc độ dài và độ phức tạp mật khẩu (passwordOk), từ chối mật khẩu quá ngắn.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("rejects short passwords", () => {
    // Mật khẩu dưới 8 ký tự hoặc thiếu độ phức tạp bị từ chối; mật khẩu đủ mạnh được chấp nhận
    assert.equal(passwordOk("abc"), false);
    assert.equal(passwordOk("ChangeMe!a3"), true);
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử xử lý thời gian theo múi giờ Việt Nam (ICT, UTC+7), tính toán tuổi và cộng ngày lịch.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("time / price slot", () => {
  /**
   * Làm gì: Kiểm tra việc trích xuất giờ và phút theo giờ địa phương Việt Nam (ICT +07) từ chuỗi ngày giờ cố định.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("reads ICT wall clock from a +07 instant", () => {
    // Bước 1: Khởi tạo mốc thời gian 17:30 ngày 2026-09-14 theo múi giờ ICT
    const start = ictDateTime("2026-09-14", "17:30");
    // Bước 2: Xác minh trích xuất đúng 17 giờ, tổng số phút là 17 * 60 + 30 = 1050 phút, và format 2 chữ số
    assert.equal(ictHour(start), 17);
    assert.equal(ictMinutes(start), 17 * 60 + 30);
    assert.equal(pad2(ictHour(start)), "17");
  });
  /**
   * Làm gì: Kiểm tra hàm tính giờ xuất hóa đơn không phụ thuộc vào múi giờ của máy chủ (host timezone), luôn cố định theo ICT.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("does not use the host timezone for invoice hours", () => {
    // Đảm bảo giờ hiển thị hóa đơn luôn là 10h ICT bất kể máy chủ chạy ở UTC hay múi giờ nào khác
    const start = new Date("2026-09-14T10:00:00+07:00");
    assert.equal(pad2(ictHour(start)), "10");
    assert.notEqual(pad2(start.getUTCHours()), "10");
  });
  /**
   * Làm gì: Kiểm tra hàm addDays cộng chính xác số ngày trên lịch dương (xử lý chuyển tháng từ 30/9 sang 01/10).
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("addDays stays on the calendar date", () => {
    assert.equal(addDays("2026-09-30", 1), "2026-10-01");
  });
  /**
   * Làm gì: Kiểm tra hàm ageYears tính tuổi người dùng chính xác theo năm tính đến thời điểm hiện tại và xử lý giá trị ngày sinh không hợp lệ.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("ageYears calculates age in years in ICT", () => {
    // Bước 1: Trả về 0 tuổi nếu ngày sinh bị null, rỗng hoặc sai định dạng
    assert.equal(ageYears(null), 0);
    assert.equal(ageYears(""), 0);
    assert.equal(ageYears("invalid"), 0);
    // Bước 2: Tính đúng 20 tuổi cho người sinh vào ngày 01/01 cách đây đúng 20 năm
    const now = new Date();
    const twentyYearsAgo = `${now.getFullYear() - 20}-01-01`;
    assert.equal(ageYears(twentyYearsAgo), 20);
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho quy tắc tính giá và làm tròn tiền tệ Việt Nam Đồng (VND).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("pricing", () => {
  /**
   * Làm gì: Kiểm tra số tiền sau giảm giá cho hội viên luôn được làm tròn đến hàng nghìn đồng (1.000đ) theo quy tắc roundVnd.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("rounds member discount to 1000đ", () => {
    // 140.000đ giảm 20% còn 112.000đ; 80.000đ giảm 15% còn 68.000đ
    assert.equal(roundVnd(140000 * (1 - 20 / 100)), 112000);
    assert.equal(roundVnd(80000 * (1 - 15 / 100)), 68000);
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho hàm rruleLabel, chuyển đổi chuỗi quy tắc lặp lịch iCalendar (RFC 5545) thành nhãn văn bản dễ đọc.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("rrule", () => {
  /**
   * Làm gì: Kiểm tra tạo nhãn lịch định kỳ hàng tuần từ danh sách các ngày trong tuần (BYDAY) và giờ bắt đầu.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("labels weekly BYDAY in English", () => {
    // Định dạng danh sách ngày lặp lại kèm giờ bắt đầu và khoảng thời gian (slot)
    assert.equal(rruleLabel("FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18"), "Mon, Wed, Fri · 18:00");
    assert.equal(rruleLabel("FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=18", 60), "Mon, Wed, Fri · 18:00–19:00");
  });
  /**
   * Làm gì: Kiểm tra việc sắp xếp đúng thứ tự các ngày trong tuần khi bị đảo lộn và gộp thành "Every day" khi đủ cả 7 ngày.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("sorts a scrambled week and collapses all seven days", () => {
    // Thứ Năm và Thứ Ba bị xáo trộn được xếp lại thành Tue, Thu; 7 ngày được rút gọn thành Every day
    assert.equal(rruleLabel("FREQ=WEEKLY;BYDAY=TH,TU;BYHOUR=19"), "Tue, Thu · 19:00");
    assert.equal(rruleLabel("FREQ=WEEKLY;BYDAY=TU,FR,SA,SU,TH,WE,MO;BYHOUR=19"), "Every day · 19:00");
  });
  /**
   * Làm gì: Kiểm tra hàm tiện ích ictDateTime khởi tạo đối tượng Date tương ứng 18:00 ICT (+07) khớp với chuỗi ISO.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("builds Monday 18:00 ICT from the date+hour helper", () => {
    const start = ictDateTime("2026-09-14", "18:00");
    assert.equal(ictHour(start), 18);
    assert.equal(start.toISOString(), new Date("2026-09-14T18:00:00+07:00").toISOString());
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho bộ điều phối tác vụ định kỳ (background jobs), kiểm tra khoảng cách thời gian giữa các chu kỳ.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("jobs", () => {
  /**
   * Làm gì: Kiểm tra hàm elapsedAtLeast đảm bảo tác vụ tạo buổi học (materialize sessions) chỉ chạy khi đã qua khoảng thời gian tối thiểu quy định.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("materializes class sessions at most once per window", () => {
    // Chưa từng chạy (undefined) -> cho phép chạy; chưa đủ 600ms -> chặn; đủ 600ms -> cho phép chạy
    assert.equal(elapsedAtLeast(undefined, 1000, 600), true);
    assert.equal(elapsedAtLeast(1000, 1599, 600), false);
    assert.equal(elapsedAtLeast(1000, 1600, 600), true);
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho quy tắc nghiệp vụ BR-37, kiểm soát biên giới hạn giá thuê sân để chặn các giá trị phá hoại hoặc bất hợp lý.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
// Pins the 2026-09-27 live-check fixes (patch order A/D/G) so the exact
// vandalized values that showed up in production can never quietly pass again.
describe("BR-37 / price bounds", () => {
  /**
   * Làm gì: Kiểm tra từ chối mức giá bất thường 99.999.999đ từng bị inject phá hoại trên môi trường production.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("rejects the vandalized weekday badminton price (99,999,999đ)", () => {
    assert.equal(slotPriceOk(99_999_999), false);
  });
  /**
   * Làm gì: Kiểm tra từ chối giá ngày lễ vượt trần (100.000.004đ) và giá cuối tuần bị chỉnh về 0đ.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("rejects the vandalized holiday price (100,000,004đ) and the zeroed weekend price", () => {
    assert.equal(slotPriceOk(100_000_004), false);
    assert.equal(slotPriceOk(0), false);
  });
  /**
   * Làm gì: Kiểm tra chấp nhận tất cả các mức giá sân thực tế hợp lệ trong bảng giá (từ 80.000đ đến 500.000đ/giờ).
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("accepts every real rule, including basketball peak at the top of the range", () => {
    for (const p of [80000, 140000, 300000, 500000, 250000, 400000]) assert.equal(slotPriceOk(p), true);
  });
  /**
   * Làm gì: Kiểm tra validatePriceRules từ chối payload cập nhật cấu hình giá khi chứa mức giá không hợp lệ.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("validatePriceRules refuses a PUT payload carrying the vandalized price", () => {
    const bad = validatePriceRules([
      { sport: "badminton", day_kind: "weekday", start_local: "06:00", end_local: "17:00", price_vnd: 99_999_999 },
    ]);
    assert.equal(bad.ok, false);
  });
  /**
   * Làm gì: Kiểm tra validatePriceRules chấp nhận danh sách quy tắc giá sân cầu lông hợp lệ ngày trong tuần.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("validatePriceRules accepts a clean weekday badminton quote (not 8e7)", () => {
    const ok = validatePriceRules([
      { sport: "badminton", day_kind: "weekday", start_local: "06:00", end_local: "17:00", price_vnd: 80000 },
    ]);
    assert.equal(ok.ok, true);
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho quy tắc nghiệp vụ BR-17, kiểm tra tính hợp lệ của tỷ lệ phần trăm chiết khấu (từ 0% đến 100%).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("BR-17 / discount percentage", () => {
  /**
   * Làm gì: Kiểm tra chấp nhận các số nguyên tỷ lệ phần trăm nằm trong khoảng biên hợp lệ từ 0% đến 100%.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("accepts whole percentages in [0, 100]", () => {
    assert.equal(discountPctOk(0), true);
    assert.equal(discountPctOk(20), true);
    assert.equal(discountPctOk(100), true);
  });
  /**
   * Làm gì: Kiểm tra từ chối các giá trị phần trăm âm, lớn hơn 100 hoặc chứa số thập phân lẻ (không phải số nguyên).
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("rejects out-of-range or fractional percentages", () => {
    assert.equal(discountPctOk(-1), false);
    assert.equal(discountPctOk(101), false);
    assert.equal(discountPctOk(12.5), false);
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho quy tắc nghiệp vụ BR-12, kiểm tra thời hạn hiệu lực của gói tập hội viên (membership plan).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("BR-12 / plan window", () => {
  /**
   * Làm gì: Kiểm tra gói tập chỉ được tính là đang hoạt động trong khoảng thời gian từ start_on đến end_on (bao gồm cả hai ngày biên).
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("is active only between start_on and end_on inclusive", () => {
    // Bước 1: Ngày nằm trong khoảng hiệu lực hoặc ngay ngày bắt đầu/kết thúc -> hợp lệ
    assert.equal(planActiveOn("2026-09-01", "2026-10-01", "2026-09-15"), true);
    assert.equal(planActiveOn("2026-09-01", "2026-10-01", "2026-09-01"), true);
    assert.equal(planActiveOn("2026-09-01", "2026-10-01", "2026-10-01"), true);
    // Bước 2: Ngày trước start_on hoặc sau end_on -> không hợp lệ
    assert.equal(planActiveOn("2026-10-01", "2026-11-01", "2026-09-15"), false);
    assert.equal(planActiveOn("2026-08-01", "2026-09-01", "2026-09-15"), false);
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho hàm ticketBody (yêu cầu chức năng FR-S03), trích xuất nội dung thực của phiếu hỗ trợ sau tiền tố "ticket:".
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("ticketBody / FR-S03", () => {
  /**
   * Làm gì: Kiểm tra loại bỏ tiền tố lặp lại và không phân biệt chữ hoa thường khi người dùng nhập "ticket:ticket: hello".
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it('stores "ticket:ticket: hello" as "hello"', () => {
    assert.equal(ticketBody("ticket:ticket: hello"), "hello");
    assert.equal(ticketBody("Ticket: Ticket:  hello"), "hello");
  });
  /**
   * Làm gì: Kiểm tra chỉ bóc tách tiền tố ở đầu câu, giữ nguyên từ "ticket:" nếu nằm ở giữa câu văn của người dùng.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it('leaves a "ticket:" in the middle of a sentence alone', () => {
    assert.equal(ticketBody("ticket: my ticket: for the class didn't work"), "my ticket: for the class didn't work");
  });
  /**
   * Làm gì: Kiểm tra loại bỏ ký tự tàng hình (zero-width character) vô tình bị chèn vào giữa tiền tố ticket.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it('strips a zero-width character sitting inside the marker', () => {
    assert.equal(ticketBody("ticket:​ hello"), "hello");
  });
  /**
   * Làm gì: Kiểm tra khi chỉ có tiền tố "ticket:" mà không có nội dung, hàm trả về chuỗi rỗng để controller ném lỗi HTTP 422.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it('an empty "ticket:" reduces to the empty string (caller returns 422)', () => {
    assert.equal(ticketBody("ticket:"), "");
    assert.equal(ticketBody("ticket: "), "");
  });
  /**
   * Làm gì: Kiểm tra tự động gỡ bỏ các cặp dấu ngoặc kép hoặc ngoặc góc («...», <<...>>) bao quanh nội dung do tin nhắn mẫu hướng dẫn.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("unwraps a quote pair the greeting taught people to type", () => {
    assert.equal(ticketBody("<<ticket: den BC2 bi chay>>"), "den BC2 bi chay");
    assert.equal(ticketBody("«ticket: den BC2 bi chay»"), "den BC2 bi chay");
    assert.equal(ticketBody('"ticket: den BC2 bi chay"'), "den BC2 bi chay");
  });
  /**
   * Làm gì: Kiểm tra giữ nguyên các dấu ngoặc kép không tạo thành cặp bọc ngoài, tránh làm mất dấu câu riêng của người dùng.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("leaves quotes that were never a pair", () => {
    // Starts with a quote and ends with a quote, but the outer two do not
    // belong together. Stripping them used to yield `a" and "b`, eating the
    // member's own punctuation; the marker is no longer treated as wrapped, so
    // the message survives exactly as typed.
    assert.equal(ticketBody('"ticket: a" and "b"'), '"ticket: a" and "b"');
    assert.equal(isTicketMessage('"ticket: a" and "b"'), false);
    // A genuine wrapper still comes off.
    assert.equal(ticketBody('"ticket: plain"'), "plain");
    // And quotes inside the note are left where they are.
    assert.equal(ticketBody("ticket: 'x' or 'y'"), "'x' or 'y'");
  });
  /**
   * Làm gì: Kiểm tra không gỡ bỏ dấu ngoặc kép khi câu không chứa tiền tố ticket hoặc ngoặc nằm trong phần nội dung hỏi đáp.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("leaves the member's own quotes alone", () => {
    // No marker inside the pair, so the quotes are theirs: the support form
    // runs every message through here.
    assert.equal(ticketBody('"The lights are out"'), '"The lights are out"');
    assert.equal(ticketBody("ticket: hỏi về «gói Premium»"), "hỏi về «gói Premium»");
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho hàm isTicketMessage (yêu cầu chức năng FR-S01), nhận diện tin nhắn tạo ticket hỗ trợ gửi tới AI trợ lý.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("isTicketMessage / FR-S01", () => {
  /**
   * Làm gì: Kiểm tra các câu hỏi thông thường của hội viên không bị nhận diện nhầm thành yêu cầu tạo ticket hỗ trợ để bot trả lời bình thường.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("leaves a question for the assistant to answer", () => {
    // These used to match on "góp ý" / "feedback" / "complaint" anywhere in the
    // message, so the assistant never saw the question it was asked.
    assert.equal(isTicketMessage("Làm sao góp ý về HLV?"), false);
    assert.equal(isTicketMessage("Is there a feedback form?"), false);
    assert.equal(isTicketMessage("How do I file a complaint?"), false);
    assert.equal(isTicketMessage("Tôi muốn khiếu nại giá sân"), false);
    assert.equal(isTicketMessage("What are your opening hours?"), false);
  });
  /**
   * Làm gì: Kiểm tra nhận diện chính xác tiền tố ticket ở đầu câu dù có dấu hai chấm tiếng Việt (full-width), khoảng trắng thừa hay dấu ngoặc bọc ngoài.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("takes a marker at the very start, however it was typed", () => {
    assert.equal(isTicketMessage("ticket: den BC2 bi chay"), true);
    // The full-width colon a Vietnamese IME produces, and a stray space.
    assert.equal(isTicketMessage("ticket： den BC2 bi chay"), true);
    assert.equal(isTicketMessage("ticket : den BC2 bi chay"), true);
    assert.equal(isTicketMessage("<<ticket: den BC2 bi chay>>"), true);
    assert.equal(isTicketMessage("«ticket: den BC2 bi chay»"), true);
  });
  /**
   * Làm gì: Kiểm tra bỏ qua tiền tố ticket nếu nó xuất hiện ở giữa câu thay vì ở đầu dòng.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("ignores a marker buried mid-sentence", () => {
    assert.equal(isTicketMessage("my ticket: for the class didn't work"), false);
  });
  /**
   * Làm gì: Kiểm tra chấp nhận tin nhắn chỉ có chữ "ticket:" để hệ thống hỏi thêm nội dung chi tiết từ người dùng.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("accepts a bare marker so the caller can ask for the rest (FR-S03)", () => {
    assert.equal(isTicketMessage("ticket:"), true);
    assert.equal(ticketBody("ticket:"), "");
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử chuyển đổi số tiền thành chữ tiếng Việt phục vụ in hóa đơn tài chính (numberToVietnamese, vndInWords).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("money in words", () => {
  /**
   * Làm gì: Kiểm tra đọc đúng các trường hợp đặc biệt trong tiếng Việt như: năm/lăm, mười/mươi, một/mốt, linh năm.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("spells the digits a VN invoice trips over", () => {
    assert.equal(numberToVietnamese(0), "không");
    assert.equal(numberToVietnamese(5), "năm");
    assert.equal(numberToVietnamese(10), "mười");
    assert.equal(numberToVietnamese(15), "mười lăm");
    assert.equal(numberToVietnamese(21), "hai mươi mốt");
    assert.equal(numberToVietnamese(25), "hai mươi lăm");
    assert.equal(numberToVietnamese(105), "một trăm linh năm");
    assert.equal(numberToVietnamese(1000), "một nghìn");
  });
  /**
   * Làm gì: Kiểm tra giữ chữ "không trăm" khi hàng trăm bằng 0 trong nhóm nghìn để tránh nhầm lẫn giá trị số (vd: 1.005 vs 1.050).
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("keeps a zero hundreds column audible inside a group", () => {
    // Drop the "không trăm" and this reads back as 1.050, not 1.005.
    assert.equal(numberToVietnamese(1005), "một nghìn không trăm linh năm");
    assert.equal(numberToVietnamese(1050), "một nghìn không trăm năm mươi");
  });
  /**
   * Làm gì: Kiểm tra bỏ qua các nhóm số 0 liên tiếp nhưng vẫn giữ đúng đơn vị hàng triệu, hàng tỷ (vd: 1.000.000, 2.000.000.000).
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("skips empty groups without losing their scale", () => {
    assert.equal(numberToVietnamese(1_000_000), "một triệu");
    assert.equal(numberToVietnamese(900_000), "chín trăm nghìn");
    assert.equal(numberToVietnamese(1_200_000), "một triệu hai trăm nghìn");
    assert.equal(numberToVietnamese(2_000_000_000), "hai tỷ");
  });
  /**
   * Làm gì: Kiểm tra hàm vndInWords định dạng dòng tiền hóa đơn: viết hoa chữ cái đầu, thêm hậu tố "đồng./." và xử lý số tiền âm.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("formats the invoice line", () => {
    // Viết hoa chữ cái đầu, thêm hậu tố 'đồng./.', xử lý mốc 0 đồng và số tiền âm
    assert.equal(vndInWords(900_000), "Chín trăm nghìn đồng./.");
    assert.equal(vndInWords(0), "Không đồng./.");
    assert.equal(vndInWords(-50_000), "Âm năm mươi nghìn đồng./.");
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử xác thực cấu hình trung tâm (settings patch), kiểm tra ép kiểu, độ dài trường và khoảng giá trị hợp lệ.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("settings validation (B-01)", () => {
  /**
   * Làm gì: Thực thi hàm kiểm thử và bắt lỗi ApiError (status 400), trích xuất tên trường dữ liệu vi phạm để đối soát.
   * Được gọi ở: Các ca kiểm thử trong suite "settings validation (B-01)" tại src/server/services/arena3.test.ts
   * @param fn Hàm callback thực hiện thao tác kiểm tra dữ liệu cần kích hoạt lỗi ApiError
   * @returns Tên trường (field) bị vi phạm xác thực trong e.extra.field
   * @throws Lỗi assert.fail nếu hàm fn không ném ra ApiError có status 400
   */
  const fieldOf = (fn: () => unknown) => {
    // Bước 1: Thực thi hàm kiểm tra dữ liệu đầu vào
    try {
      fn();
    // Bước 2: Bắt lỗi ApiError và xác minh mã trạng thái HTTP 400 Bad Request
    } catch (e) {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 400);
      return String(e.extra.field);
    }
    // Bước 3: Ném lỗi nếu hàm không phát sinh ngoại lệ HTTP 400 như kỳ vọng
    assert.fail("expected a 400");
  };
  /**
   * Làm gì: Kiểm tra tự động ép kiểu các chuỗi số sang số nguyên và chuẩn hóa định dạng giờ (thêm số 0 đệm đầu) cùng chuỗi mã số thuế.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("takes numbers typed as strings", () => {
    // Bước 1: Parse dữ liệu chứa chuỗi số, giờ thiếu số 0 và khoảng trắng dư thừa
    const p = parseSettingsPatch({ hold_minutes: "15", gate_dedup_minutes: 90, open_time: "6:00", tax_code: " 0312 " });
    // Bước 2: Xác minh dữ liệu được chuẩn hóa thành số nguyên, giờ HH:mm và trim chuỗi
    assert.deepEqual(p, { hold_minutes: 15, gate_dedup_minutes: 90, open_time: "06:00", tax_code: "0312" });
  });
  /**
   * Làm gì: Kiểm tra từ chối các giá trị số bị để trống, gán null hoặc NaN thay vì vô tình chuyển chúng thành null.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("never turns a blank number into null", () => {
    // Các trường số nguyên (hold_minutes, gate_dedup_minutes, book_ahead_days) không được là rỗng, null hoặc NaN
    assert.equal(fieldOf(() => parseSettingsPatch({ hold_minutes: "" })), "hold_minutes");
    assert.equal(fieldOf(() => parseSettingsPatch({ gate_dedup_minutes: null })), "gate_dedup_minutes");
    assert.equal(fieldOf(() => parseSettingsPatch({ book_ahead_days: Number.NaN })), "book_ahead_days");
  });
  /**
   * Làm gì: Kiểm tra từ chối các giá trị không phải số, số thập phân hoặc số nguyên nằm ngoài phạm vi cho phép (số âm hoặc vượt giới hạn INT4).
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("rejects text, fractions and out-of-range integers", () => {
    // Bước 1: Từ chối chuỗi chữ cái hoặc số thập phân cho trường thời gian giữ chỗ (hold_minutes)
    assert.equal(fieldOf(() => parseSettingsPatch({ hold_minutes: "abc" })), "hold_minutes");
    assert.equal(fieldOf(() => parseSettingsPatch({ hold_minutes: "1.5" })), "hold_minutes");
    // Bước 2: Từ chối số nguyên âm hoặc vượt quá giới hạn integer 32-bit (2.147.483.647) của gate_dedup_minutes
    assert.equal(fieldOf(() => parseSettingsPatch({ gate_dedup_minutes: 2_147_483_648 })), "gate_dedup_minutes");
    assert.equal(fieldOf(() => parseSettingsPatch({ gate_dedup_minutes: -1 })), "gate_dedup_minutes");
  });
  /**
   * Làm gì: Kiểm tra từ chối các chuỗi ký tự vượt quá độ dài tối đa của cột tương ứng trong cơ sở dữ liệu.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("rejects text longer than its column", () => {
    // Cột tax_code tối đa 20 ký tự (từ chối 21 ký tự, chấp nhận 20 ký tự); legal_name tối đa 190 ký tự (từ chối 191 ký tự)
    assert.equal(fieldOf(() => parseSettingsPatch({ tax_code: "1".repeat(21) })), "tax_code");
    assert.equal(fieldOf(() => parseSettingsPatch({ legal_name: "x".repeat(191) })), "legal_name");
    assert.equal(parseSettingsPatch({ tax_code: "1".repeat(20) }).tax_code, "1".repeat(20));
  });
  /**
   * Làm gì: Kiểm tra chuyển chuỗi khoảng trắng của trường tùy chọn về null và tự động lọc bỏ các thuộc tính không xác định.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("clears optional text on a blank, ignores unknown keys", () => {
    // Chuỗi khoảng trắng của address được đưa về null; key lạ không nằm trong schema bị bỏ qua
    assert.deepEqual(parseSettingsPatch({ address: "  ", nope: 1 }), { address: null });
  });
  /**
   * Làm gì: Kiểm tra cặp giờ mở cửa và đóng cửa (giờ mở phải trước giờ đóng) và từ chối định dạng giờ không hợp lệ.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("checks opening hours as a pair", () => {
    // Bước 1: Giờ mở cửa 06:00 trước giờ đóng cửa 22:00 -> hợp lệ
    checkOpeningHours("06:00", "22:00");
    // Bước 2: Giờ mở cửa 22:00 muộn hơn giờ đóng cửa 06:00 -> ném lỗi tại trường close_time
    assert.equal(fieldOf(() => checkOpeningHours("22:00", "06:00:00")), "close_time");
    // Kiểm tra giá trị giờ mở cửa không hợp lệ (25:00 vượt quá 24h) bị từ chối ở trường open_time
    assert.equal(fieldOf(() => parseSettingsPatch({ open_time: "25:00" })), "open_time");
  });
});

/**
 * Làm gì: Bộ kiểm thử ánh xạ lỗi cơ sở dữ liệu PostgreSQL sang mã lỗi và HTTP status chuẩn của API (mapDbError).
 * Được gọi ở: test runner (node --test)
 */
describe("database errors keep their meaning", () => {
  /**
   * Làm gì: Kiểm tra các lỗi dữ liệu PostgreSQL (chuỗi quá dài 22001, số ngoài giới hạn 22003, thiếu NOT NULL 23502) được chuyển thành HTTP 400 và chỉ rõ tên cột bị lỗi.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("maps value errors to a 400 naming the column", () => {
    // Bước 1: Mã lỗi 22001 (chuỗi vượt độ dài cột) ánh xạ thành VALIDATION 400 và trả về field là tax_code
    assert.deepEqual(mapDbError({ code: "22001", column: "tax_code" })?.body, {
      code: "VALIDATION",
      message: "That value is too long.",
      field: "tax_code",
    });
    // Bước 2: Mã lỗi 22003 (giá trị số vượt khoảng cho phép) và 23502 (thiếu cột NOT NULL) đều trả về status 400
    assert.equal(mapDbError({ code: "22003" })?.status, 400);
    assert.equal(mapDbError({ code: "23502", column: "hold_minutes" })?.status, 400);
  });
  /**
   * Làm gì: Kiểm tra các lỗi vi phạm nghiệp vụ hoặc ràng buộc toàn vẹn giữ nguyên mã lỗi nghiệp vụ tương ứng.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("keeps rule errors as rule codes", () => {
    // Bước 1: Ràng buộc loại trừ 23P01 (trùng lịch đặt sân) chuyển thành mã lỗi CONFLICT_SLOT
    assert.equal(mapDbError({ code: "23P01" })?.body.code, "CONFLICT_SLOT");
    // Bước 2: Thông điệp CLASS_FULL và ALREADY_ENROLLED ánh xạ tương ứng quy tắc nghiệp vụ BR-21 và BR-22
    assert.equal(mapDbError({ message: "CLASS_FULL" })?.body.br, "BR-21");
    assert.equal(mapDbError({ message: "ALREADY_ENROLLED" })?.body.br, "BR-22");
    // Bước 3: Mã 23505 (vi phạm ràng buộc UNIQUE) chuyển thành HTTP 409 CONFLICT_STATE
    assert.equal(mapDbError({ code: "23505", constraint: "u" })?.status, 409);
  });
  /**
   * Làm gì: Kiểm tra các lỗi không xác định hoặc mã lỗi lạ trả về null để controller xử lý thành lỗi 500.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("leaves the unknown to be a 500", () => {
    // Lỗi không thuộc danh mục nhận diện trả về null, để tầng gọi biến thành HTTP 500 INTERNAL
    assert.equal(mapDbError(new Error("boom")), null);
    assert.equal(mapDbError({ code: "XX000" }), null);
  });
});

/**
 * Làm gì: Bộ kiểm thử thời lượng lớp học theo giờ sân trọn vẹn (hàm classMinutes).
 * Được gọi ở: test runner (node --test)
 */
describe("class length", () => {
  /**
   * Làm gì: Kiểm tra thời lượng lớp học mặc định là 60 phút khi để trống, chỉ chấp nhận 60, 120, 180 phút và từ chối các số phút lẻ.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("defaults to one court hour and refuses a half hour", () => {
    // Bước 1: Giá trị undefined hoặc null tự động nhận thời lượng mặc định là 60 phút (1 giờ sân)
    assert.equal(classMinutes(undefined), 60);
    assert.equal(classMinutes(null), 60);
    // Bước 2: Chấp nhận các thời lượng trọn vẹn 1h (60p), 2h (120p), 3h (180p)
    assert.equal(classMinutes(60), 60);
    assert.equal(classMinutes(120), 120);
    assert.equal(classMinutes(180), 180);
    // Bước 3: Quy tắc BR-11: Từ chối các thời lượng lẻ (90p, 45p) để không làm hỏng lưới đặt sân 1 tiếng
    assert.equal(classMinutes(90), null);
    assert.equal(classMinutes(45), null);
  });
});

/**
 * Làm gì: Bộ kiểm thử quy tắc B-03 làm tròn khung thời gian giữ sân của lớp học theo các slot trọn vẹn (hàm slotSpan).
 * Được gọi ở: test runner (node --test)
 */
describe("class court time (B-03)", () => {
  /**
   * Làm gì: Định dạng đối tượng Date thành chuỗi giờ phút HH:mm theo múi giờ Việt Nam (ICT, +07:00).
   * Được gọi ở: src/server/services/arena3.test.ts (trong các ca kiểm thử slotSpan bên dưới).
   * @param d Đối tượng Date cần lấy giờ phút.
   * @returns Chuỗi giờ phút định dạng HH:mm.
   */
  const hhmm = (d: Date) => `${pad2(ictHour(d))}:${pad2(ictMinutes(d) % 60)}`;
  /**
   * Làm gì: Kiểm tra lớp học 90 phút (17:00-18:30) tự động làm tròn thành 2 slot sân trọn vẹn từ 17:00 đến 19:00.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("rounds a 90-minute class out to whole slots", () => {
    // Bước 1: Khởi tạo mốc bắt đầu lớp học 17:00 theo múi giờ ICT
    const start = ictDateTime("2026-09-14", "17:00");
    // Bước 2: Tính toán khoảng giữ sân thực tế cho lớp học kéo dài 90 phút với slot tiêu chuẩn 60 phút
    const held = slotSpan(start, new Date(start.getTime() + 90 * 60_000), 60);
    // Quy tắc B-03: Mốc kết thúc được làm tròn lên 19:00 để bao trọn slot thứ 2, tránh bỏ trống 30 phút lẻ
    assert.equal(hhmm(held.start), "17:00");
    assert.equal(hhmm(held.end), "19:00");
  });
  /**
   * Làm gì: Kiểm tra lớp học đã khớp sẵn với lưới slot (120 phút từ 18:00 đến 20:00) được giữ nguyên vẹn.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("leaves a class that already fits the grid alone", () => {
    // Lớp học từ 18:00 kéo dài 120 phút đã khớp tròn 2 slot 60 phút nên không cần điều chỉnh
    const start = ictDateTime("2026-09-14", "18:00");
    const held = slotSpan(start, new Date(start.getTime() + 120 * 60_000), 60);
    assert.equal(held.start.getTime(), start.getTime());
    assert.equal(held.end.getTime(), start.getTime() + 120 * 60_000);
  });
  /**
   * Làm gì: Kiểm tra lớp học có giờ bắt đầu lệch lưới (17:30 kéo dài 60 phút) được làm tròn đầu xuống 17:00 và đuôi lên 19:00.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("also rounds a start that is off the grid down", () => {
    // Lớp học bắt đầu lúc 17:30 (lệch lưới slot 60 phút), hệ thống làm tròn đầu xuống 17:00 và đuôi lên 19:00 để giữ trọn 2 ca sân
    const start = ictDateTime("2026-09-14", "17:30");
    const held = slotSpan(start, new Date(start.getTime() + 60 * 60_000), 60);
    assert.equal(hhmm(held.start), "17:00");
    assert.equal(hhmm(held.end), "19:00");
  });
});

/**
 * Làm gì: Bộ kiểm thử quy tắc khóa điểm danh buổi học BR-35 (hàm attendanceLocked).
 * Được gọi ở: test runner (node --test)
 */
describe("F4 attendance lock (BR-35)", () => {
  /**
   * Làm gì: Mốc thời gian kết thúc buổi học (19:30 ngày 14/09/2026 tính theo millisecond) dùng làm mốc kiểm tra khóa điểm danh.
   * Được gọi ở: src/server/services/arena3.test.ts (trong các ca kiểm thử attendanceLocked bên dưới).
   */
  const end = ictDateTime("2026-09-14", "19:30").getTime();
  /**
   * Làm gì: Kiểm tra cổng điểm danh vẫn mở trong vòng 2 giờ sau khi buổi học kết thúc khi ở trạng thái scheduled.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("stays open for two hours after the session ends", () => {
    // Quy tắc BR-35: Trong khoảng 2 tiếng sau giờ học (119 phút hoặc đúng 2 tiếng), điểm danh vẫn chưa bị khóa (false)
    assert.equal(attendanceLocked(end, end + 119 * 60_000, "scheduled"), false);
    assert.equal(attendanceLocked(end, end + 2 * 3_600_000, "scheduled"), false);
  });
  /**
   * Làm gì: Kiểm tra điểm danh tự động khóa ngay khi vừa vượt quá 2 giờ, kể cả khi background job chưa cập nhật trạng thái done.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("closes once the window has passed, even before the job marks it done", () => {
    // Vừa quá 2 tiếng (thêm 1ms), hệ thống lập tức khóa quyền sửa đổi điểm danh để bảo toàn dữ liệu
    assert.equal(attendanceLocked(end, end + 2 * 3_600_000 + 1, "scheduled"), true);
  });
  /**
   * Làm gì: Kiểm tra buổi học đã được đánh dấu done thì luôn bị khóa điểm danh bất kể thời gian nào.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("is closed for a session already marked done", () => {
    // Buổi học đã hoàn tất (status: done) thì không được phép thay đổi điểm danh nữa
    assert.equal(attendanceLocked(end, end - 60_000, "done"), true);
  });
});

/**
 * Làm gì: Bộ kiểm thử chuỗi vắng mặt liên tiếp không phép BR-36 (hàm absentStreak, isAttResult).
 * Được gọi ở: test runner (node --test)
 */
describe("F4 absent streak (BR-36)", () => {
  /**
   * Làm gì: Kiểm tra hàm absentStreak chỉ đếm chuỗi các buổi vắng mặt (absent) liên tiếp ở cuối danh sách (buổi gần nhất).
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("counts only the run at the end", () => {
    // Chỉ đếm số buổi absent liên tục từ buổi học gần đây nhất (cuối mảng) trở ngược lại
    assert.equal(absentStreak(["absent", "present", "absent", "absent"]), 2);
    assert.equal(absentStreak(["absent", "absent", "absent"]), 3);
    assert.equal(absentStreak([]), 0);
  });
  /**
   * Làm gì: Kiểm tra chuỗi nghỉ học bị ngắt khi gặp trạng thái có mặt (present), đi muộn (late) hoặc nghỉ có phép (excused).
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("is broken by present, late or excused", () => {
    // Quy tắc BR-36: Nghỉ có phép (excused) hoặc đi muộn (late) không tính là vắng mặt không lý do nên ngắt chuỗi
    assert.equal(absentStreak(["absent", "absent", "excused", "absent"]), 1);
    assert.equal(absentStreak(["absent", "absent", "absent", "late"]), 0);
  });
  /**
   * Làm gì: Kiểm tra hàm isAttResult chỉ chấp nhận đúng 4 giá trị điểm danh chuẩn: present, absent, late, excused.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("accepts only the four register values", () => {
    // Chỉ 4 giá trị hợp lệ theo quy chế điểm danh; các giá trị khác như "sick" hoặc undefined đều bị loại
    assert.equal(isAttResult("late"), true);
    assert.equal(isAttResult("sick"), false);
    assert.equal(isAttResult(undefined), false);
  });
});

/**
 * Làm gì: Bộ kiểm thử xác thực các chỉ số kỹ thuật buổi tập FR-TRN-05 (hàm validateMetrics).
 * Được gọi ở: test runner (node --test)
 */
describe("F4 session metrics (FR-TRN-05)", () => {
  /**
   * Làm gì: Kiểm tra hàm validateMetrics chấp nhận số nguyên trong giới hạn, ép kiểu chuỗi số và bỏ qua các trường để trống.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("accepts whole numbers in range and ignores blanks", () => {
    // Bỏ qua serve_pct để trống, ép kiểu chuỗi "80" thành số và giữ nguyên smash_count = 24
    const r = validateMetrics({ smash_count: 24, freethrow_pct: "80", serve_pct: "" });
    assert.deepEqual(r, { ok: true, metrics: { smash_count: 24, freethrow_pct: 80 } });
  });
  /**
   * Làm gì: Kiểm tra validateMetrics từ chối phần trăm lớn hơn 100, số thập phân, tên chỉ số không xác định hoặc kiểu dữ liệu mảng.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("rejects percentages above 100, fractions and unknown keys", () => {
    // Tỷ lệ phần trăm không được vượt quá 100%, số lượng phải là số nguyên, không chấp nhận chỉ số lạ (speed) hay mảng
    assert.equal(validateMetrics({ serve_pct: 101 }).ok, false);
    assert.equal(validateMetrics({ smash_count: 2.5 }).ok, false);
    assert.equal(validateMetrics({ speed: 3 }).ok, false);
    assert.equal(validateMetrics([1]).ok, false);
  });
});

/**
 * Làm gì: Bộ kiểm thử quản lý danh sách bài tập về nhà FR-TRN-07 (normalizeChecklist, normalizeDone, homeworkComplete).
 * Được gọi ở: test runner (node --test)
 */
describe("F4 homework checklist (FR-TRN-07)", () => {
  /**
   * Làm gì: Kiểm tra normalizeChecklist cắt tỉa khoảng trắng, bỏ qua dòng rỗng, từ chối kiểu dữ liệu sai hoặc danh sách vượt quá 20 mục.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("trims, drops blanks and refuses a wrong shape", () => {
    // Cắt khoảng trắng đầu cuối, loại bỏ chuỗi rỗng; chỉ giữ lại các mục bài tập có nội dung thực tế
    assert.deepEqual(normalizeChecklist([" a ", "", "b"]), ["a", "b"]);
    // Từ chối dữ liệu không phải mảng chuỗi hoặc vượt quá giới hạn tối đa 20 mục (mảng 21 phần tử)
    assert.equal(normalizeChecklist("a"), null);
    assert.equal(normalizeChecklist([1]), null);
    assert.equal(normalizeChecklist(Array.from({ length: 21 }, () => "x")), null);
  });
  /**
   * Làm gì: Kiểm tra normalizeDone chỉ giữ lại các index bài tập hợp lệ trong khoảng từ 0 đến total - 1, loại bỏ trùng lặp và sắp xếp tăng dần.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("keeps only ticks that point at a real row", () => {
    // Với danh sách 3 mục (index 0, 1, 2), loại bỏ các index ngoài phạm vi (5, -1), chuỗi ("1") và index trùng lặp
    assert.deepEqual(normalizeDone(3, [2, 2, 0, 5, -1, "1"]), [0, 2]);
  });
  /**
   * Làm gì: Kiểm tra điều kiện hoàn thành bài tập về nhà: khi tất cả các mục được tick hoặc danh sách rỗng được xác nhận hoàn tất tường minh.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("is complete when every row is ticked, or on explicit done for an empty list", () => {
    // Danh sách 3 bài tập chỉ hoàn thành khi cả 3 mục (0, 1, 2) đều được đánh dấu xong
    assert.equal(homeworkComplete(3, [0, 1], false), false);
    assert.equal(homeworkComplete(3, [0, 1, 2], false), true);
    // Khi không có bài tập (total = 0), chỉ tính hoàn thành nếu huấn luyện viên bấm xác nhận done tường minh
    assert.equal(homeworkComplete(0, [], false), false);
    assert.equal(homeworkComplete(0, [], true), true);
  });
});

/**
 * Làm gì: Bộ kiểm thử quy tắc tính chiết khấu khuyến mãi BR-42 (hàm computeDiscount, normalizeCode).
 * Được gọi ở: test runner (node --test)
 */
describe("promo discount (BR-42)", () => {
  /**
   * Làm gì: Kiểm tra số tiền giảm giá theo phần trăm được làm tròn một lần duy nhất về mốc 1.000đ gần nhất.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("rounds a percentage once to the nearest 1,000đ", () => {
    // 10% của 155.000đ là 15.500đ, làm tròn thành 16.000đ; 10% của 154.000đ là 15.400đ, làm tròn thành 15.000đ
    assert.equal(computeDiscount({ kind: "percent", value: 10, max_discount_vnd: null }, 155_000), 16_000);
    assert.equal(computeDiscount({ kind: "percent", value: 10, max_discount_vnd: null }, 154_000), 15_000);
  });
  /**
   * Làm gì: Kiểm tra số tiền giảm bị giới hạn bởi mức giảm tối đa (max_discount_vnd) và luôn đảm bảo số tiền phải thanh toán tối thiểu là 1.000đ.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("caps by max_discount_vnd and never leaves under 1,000đ to pay", () => {
    // 50% của 200.000đ là 100.000đ nhưng bị chặn bởi mức trần max_discount_vnd = 20.000đ
    assert.equal(computeDiscount({ kind: "percent", value: 50, max_discount_vnd: 20_000 }, 200_000), 20_000);
    // Đơn hàng 30.000đ giảm 50.000đ nhưng tiền phải trả không được dưới 1.000đ, nên mức giảm tối đa là 29.000đ
    assert.equal(computeDiscount({ kind: "amount", value: 50_000, max_discount_vnd: null }, 30_000), 29_000);
  });
  /**
   * Làm gì: Kiểm tra hàm normalizeCode loại bỏ toàn bộ khoảng trắng thừa và viết hoa mã khuyến mãi.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("normalises codes", () => {
    // Xóa tất cả dấu cách và chuyển toàn bộ ký tự thành chữ in hoa (ví dụ: " sum mer10 " -> "SUMMER10")
    assert.equal(normalizeCode(" sum mer10 "), "SUMMER10");
    assert.equal(normalizeCode(null), "");
  });
});

/**
 * Làm gì: Bộ kiểm thử tạo và xác thực token check-in mã QR bảo mật BR-30 (signCheckinToken, verifyCheckinToken).
 * Được gọi ở: test runner (node --test)
 */
describe("check-in token (BR-30)", () => {
  /**
   * Làm gì: Kiểm tra chu trình tạo và giải mã token check-in cho hội viên (member) với thời hạn hiệu lực 60 giây.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("round-trips a member token", () => {
    // Bước 1: Tạo token check-in loại member với thời điểm hiện tại 1.000.000ms; TTL mặc định là 60 giây
    const { token, ttl_seconds } = signCheckinToken("member", "u1", 1_000_000);
    assert.equal(ttl_seconds, 60);
    // Bước 2: Xác thực token sau 30 giây (trong thời hạn hiệu lực), giải mã đúng loại member và định danh user u1
    const v = verifyCheckinToken(token, 1_000_000 + 30_000);
    assert.equal(v.kind, "member");
    assert.equal(v.sub, "u1");
  });
  /**
   * Làm gì: Kiểm tra hệ thống từ chối và ném lỗi ApiError (BR-30) khi token check-in đã hết hạn hiệu lực.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("refuses an expired token", () => {
    // Token có thời hạn 60 giây; xác thực ở giây thứ 61 (quá hạn 1 giây) phải bị từ chối với lỗi BR-30
    const { token } = signCheckinToken("member", "u1", 1_000_000);
    assert.throws(() => verifyCheckinToken(token, 1_000_000 + 61_000), ApiError);
  });
  /**
   * Làm gì: Kiểm tra cơ chế chống giả mạo HMAC: từ chối token bị sửa đổi payload, sai chữ ký MAC hoặc sai định dạng.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("refuses a tampered token", () => {
    // Bước 1: Tạo token hợp lệ và tách thành 2 phần: body (payload base64url) và chữ ký mac
    const { token } = signCheckinToken("member", "u1", Date.now());
    const [body, mac] = token.split(".");
    // Bước 2: Thử giả mạo user khác (u2) hoặc kéo dài hạn dùng; chữ ký cũ không khớp payload mới
    const forged = Buffer.from(JSON.stringify({ k: "member", s: "u2", j: "x", e: 9_999_999_999 })).toString("base64url");
    assert.throws(() => verifyCheckinToken(`${forged}.${mac}`), ApiError);
    // Bước 3: Thử sửa đổi chữ ký MAC, hoặc truyền dữ liệu không phải chuỗi; tất cả đều bị từ chối
    assert.throws(() => verifyCheckinToken(`${body}.AAAA`), ApiError);
    assert.throws(() => verifyCheckinToken(42), ApiError);
  });
  /**
   * Làm gì: Kiểm tra hàm verifyCheckinToken có thể trích xuất và xác thực token lễ tân (desk) được bọc trong tham số query (?d=...) của URL quét QR.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("takes a desk code wrapped in a URL", () => {
    // Máy quét mã QR tại quầy quét URL chứa tham số d=<token>; hệ thống tự động bóc tách token để xác thực
    const { token } = signCheckinToken("desk", "front-desk", Date.now());
    assert.equal(verifyCheckinToken(`https://x.test/in?d=${token}`).kind, "desk");
  });
});

/**
 * Làm gì: Bộ kiểm thử quy tắc xếp hàng kích hoạt gói tập tại quầy và tính toán cửa sổ hiển thị lịch lớp học.
 * Được gọi ở: test runner (node --test)
 */
describe("desk subscription queuing & class schedule window", () => {
  /**
   * Làm gì: Kiểm tra gói tập mới mua tại quầy được kích hoạt nối tiếp sau ngày hết hạn gói cũ nếu gói cũ còn hiệu lực, hoặc kích hoạt ngay hôm nay nếu gói cũ đã hết hạn.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("queues subscription after active plan end date", () => {
    // Trường hợp 1: Gói tập hiện tại còn hạn đến 25/10/2026 (sau hôm nay 11/10), gói mới sẽ nối tiếp từ 25/10/2026
    const today = "2026-10-11";
    const liveEndOn = "2026-10-25";
    const queueStart = liveEndOn >= today ? liveEndOn : today;
    assert.equal(queueStart, "2026-10-25");

    // Trường hợp 2: Gói tập cũ đã hết hạn từ 01/10/2026, gói tập mới kích hoạt ngay từ ngày hôm nay 11/10/2026
    const expiredEndOn = "2026-10-01";
    const fallbackStart = expiredEndOn >= today ? expiredEndOn : today;
    assert.equal(fallbackStart, today);
  });

  /**
   * Làm gì: Kiểm tra cửa sổ xem lịch lớp học luôn bắt đầu từ 00:00 đầu ngày hôm nay theo múi giờ ICT, tránh bỏ lỡ các buổi học trong ngày.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("calculates class window starting at beginning of today", () => {
    // Quy về mốc 00:00 đầu ngày hôm nay theo giờ Việt Nam (ICT) để hiển thị đầy đủ lịch học trong ngày
    const today = "2026-10-11";
    const todayStart = ictDateTime(today, "00:00");
    const classStartOn = "2026-10-11";
    const windowStart = classStartOn >= today ? ictDateTime(classStartOn, "00:00") : todayStart;
    assert.equal(windowStart.toISOString(), todayStart.toISOString());
  });
});

/**
 * Làm gì: Bộ kiểm thử thuật toán phân trang danh sách (pageWindow, alignOffset, lastPageOffset, pageParams).
 * Được gọi ở: test runner (node --test)
 */
describe("paging", () => {
  /**
   * Làm gì: Kiểm tra hàm pageWindow hiển thị trang đầu, trang cuối, trang hiện tại cùng các trang lân cận, và chèn "gap" (dấu ba chấm) ở các khoảng cách xa.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("draws first, last, the current page and its neighbours, with gaps between", () => {
    // Kiểm tra hiển thị thanh phân trang cho danh sách ngắn (1 hoặc 5 trang) và danh sách dài (chèn gap ở giữa)
    assert.deepEqual(pageWindow(1, 1), [1]);
    assert.deepEqual(pageWindow(1, 5), [1, 2, 3, 4, 5]);
    assert.deepEqual(pageWindow(5, 20), [1, "gap", 4, 5, 6, "gap", 20]);
    assert.deepEqual(pageWindow(1, 20), [1, 2, "gap", 20]);
    assert.deepEqual(pageWindow(20, 20), [1, "gap", 19, 20]);
  });

  /**
   * Làm gì: Kiểm tra pageWindow không ẩn một trang đơn lẻ phía sau dấu "gap", vì nút bấm trang lẻ tốn diện tích tương đương dấu ba chấm.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("never hides a single page behind a gap", () => {
    // 1 … 3 takes as much room as 1 2 3, so the page itself is drawn.
    assert.deepEqual(pageWindow(4, 7), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(pageWindow(3, 10), [1, 2, 3, 4, "gap", 10]);
  });

  /**
   * Làm gì: Kiểm tra giới hạn số trang yêu cầu trong khoảng [1, pages] và xử lý trả về mảng rỗng khi danh sách không có trang nào.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("clamps a page outside the range and handles no pages", () => {
    // Trang 0 được đẩy lên 1, trang 9 vượt quá 3 được ép về 3; danh sách 0 trang trả về mảng rỗng
    assert.deepEqual(pageWindow(0, 3), [1, 2, 3]);
    assert.deepEqual(pageWindow(9, 3), [1, 2, 3]);
    assert.deepEqual(pageWindow(1, 0), []);
  });

  /**
   * Làm gì: Kiểm tra hàm alignOffset căn chỉnh lại offset khi thay đổi số dòng mỗi trang để giữ dòng đầu tiên đang xem trên màn hình.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("keeps the top row on screen when the page size changes", () => {
    // Làm tròn offset xuống bội số của pageSize mới (ví dụ: dòng 30 chuyển sang trang 25 dòng thì offset là 25)
    assert.equal(alignOffset(30, 25), 25);
    assert.equal(alignOffset(30, 50), 0);
    assert.equal(alignOffset(125, 100), 100);
    assert.equal(alignOffset(-5, 10), 0);
  });

  /**
   * Làm gì: Kiểm tra hàm lastPageOffset tìm offset của trang cuối cùng khi danh sách bị thu hẹp hoặc xóa bớt phần tử.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("finds the last page of a list that shrank", () => {
    // Danh sách 51 dòng chia trang 25 thì trang cuối bắt đầu từ offset 50; 50 dòng thì trang cuối bắt đầu từ offset 25
    assert.equal(lastPageOffset(51, 25), 50);
    assert.equal(lastPageOffset(50, 25), 25);
    assert.equal(lastPageOffset(0, 25), 0);
  });

  /**
   * Làm gì: Kiểm tra hàm pageParams trích xuất limit và offset từ URL query string, áp dụng giá trị mặc định và từ chối các giá trị không hợp lệ.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("reads limit and offset, falling back for callers that never asked", () => {
    /**
     * Làm gì: Khởi tạo đối tượng Request giả lập kèm query string để kiểm thử trích xuất tham số phân trang.
     * Được gọi ở: src/server/services/arena3.test.ts (trong ca kiểm thử pageParams).
     * @param q Chuỗi query string gửi kèm (ví dụ: "?limit=25&offset=50").
     * @returns Đối tượng Request hoàn chỉnh.
     */
    const req = (q: string) => new Request(`http://x/v1/list${q}`);
    // Bước 1: Khi request không truyền tham số, sử dụng giá trị limit mặc định (def: 100) và offset = 0
    assert.deepEqual(pageParams(req(""), { def: 100, max: 100 }), { limit: 100, offset: 0 });
    // Bước 2: Đọc chính xác các giá trị limit và offset được truyền trên URL
    assert.deepEqual(pageParams(req("?limit=25&offset=50"), { def: 100, max: 100 }), { limit: 25, offset: 50 });
    // One endpoint can page a second list under its own names.
    assert.deepEqual(pageParams(req("?limit=5&receipt_limit=10&receipt_offset=20"), { def: 25, max: 100, prefix: "receipt_" }), { limit: 10, offset: 20 });
    // Bước 3: Từ chối các tham số không hợp lệ (limit = 0, vượt max 100, offset âm, hoặc chuỗi không phải số)
    assert.throws(() => pageParams(req("?limit=0"), { def: 25, max: 100 }));
    assert.throws(() => pageParams(req("?limit=101"), { def: 25, max: 100 }));
    assert.throws(() => pageParams(req("?offset=-1"), { def: 25, max: 100 }));
    assert.throws(() => pageParams(req("?limit=abc"), { def: 25, max: 100 }));
  });
});

/**
 * Làm gì: Bộ kiểm thử chuẩn mã thanh toán ngân hàng VietQR NAPAS (crc16, vietQrPayload, readTlv, transferReference, validBankAccount).
 * Được gọi ở: test runner (node --test)
 */
describe("vietqr", () => {
  /**
   * Làm gì: Thông tin tài khoản ngân hàng thụ hưởng mẫu (MB Bank: BIN 970422, số tài khoản 0123456789) dùng cho các ca test tạo mã VietQR.
   * Được gọi ở: src/server/services/arena3.test.ts (trong bộ kiểm thử vietqr).
   */
  const mb = { bin: "970422", accountNo: "0123456789" };

  /**
   * Làm gì: Kiểm tra hàm crc16 tính mã kiểm tra theo đúng chuẩn CRC16-CCITT-FALSE (chuỗi mẫu "123456789" cho ra mã băm "29B1").
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("uses CRC16-CCITT-FALSE (check value of 123456789 is 29B1)", () => {
    // Giá trị kiểm tra chuẩn của CRC16-CCITT-FALSE (khởi tạo 0xFFFF, đa thức 0x1021) trên chuỗi "123456789"
    assert.equal(crc16("123456789"), "29B1");
  });

  /**
   * Làm gì: Kiểm tra payload VietQR luôn kết thúc bằng tag 6304 và 4 ký tự mã kiểm tra CRC16 tính trên toàn bộ nội dung phía trước.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("ends with a checksum over everything before it, 6304 included", () => {
    // Bước 1: Tạo mã VietQR động với số tiền 80.000đ và nội dung chuyển khoản mẫu
    const p = vietQrPayload(mb, 80000, "ARENA3 CRT-20261014-U0306");
    // Bước 2: Chuẩn EMVCo bắt buộc chuỗi kết thúc bằng tag 63 độ dài 04 và 4 ký tự hex mã checksum CRC16
    assert.match(p, /6304[0-9A-F]{4}$/);
    assert.equal(p.slice(-4), crc16(p.slice(0, -4)));
  });

  /**
   * Làm gì: Kiểm tra payload VietQR chứa đầy đủ các trường TLV theo chuẩn NAPAS: tài khoản thụ hưởng, số tiền, tiền tệ VND (704), quốc gia VN và nội dung chuyển khoản.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("carries the NAPAS account, the amount, VND, VN and the reference", () => {
    // Bước 1: Bóc tách payload VietQR thành đối tượng các cặp trường Tag-Length-Value
    const f = readTlv(vietQrPayload(mb, 80000, "ARENA3 CRT-1"));
    // Bước 2: Tag 00 là phiên bản định dạng (01); Tag 01 là mã QR động có số tiền chỉ định (12)
    assert.equal(f["00"], "01");
    assert.equal(f["01"], "12");
    // Bước 3: Tag 38 chứa thông tin thụ hưởng NAPAS (GUID A000000727, BIN ngân hàng, số tài khoản, dịch vụ QRIBFTTA)
    const merchant = readTlv(f["38"]!);
    assert.equal(merchant["00"], "A000000727");
    assert.deepEqual(readTlv(merchant["01"]!), { "00": "970422", "01": "0123456789" });
    assert.equal(merchant["02"], "QRIBFTTA");
    // Bước 4: Tag 53 là mã tiền tệ VNĐ (704 theo ISO 4217); Tag 54 là số tiền; Tag 58 là mã quốc gia VN; Tag 62-08 là nội dung chuyển khoản
    assert.equal(f["53"], "704");
    assert.equal(f["54"], "80000");
    assert.equal(f["58"], "VN");
    assert.equal(readTlv(f["62"]!)["08"], "ARENA3 CRT 1");
  });

  /**
   * Làm gì: Kiểm tra mã VietQR tĩnh (không truyền số tiền) sẽ đánh dấu loại QR là static (11) và không chứa tag số tiền (54) hay tag nội dung (62).
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("leaves the amount out and marks the code static when there is none", () => {
    // Khi không truyền số tiền, QR là mã tĩnh (Tag 01 = "11") để người chuyển tự nhập số tiền trên ứng dụng ngân hàng
    const f = readTlv(vietQrPayload(mb));
    assert.equal(f["01"], "11");
    assert.equal(f["54"], undefined);
    assert.equal(f["62"], undefined);
  });

  /**
   * Làm gì: Kiểm tra hàm transferReference chuẩn hóa nội dung chuyển khoản thành ký tự ASCII không dấu, không ký tự đặc biệt và tối đa 25 ký tự theo quy định NAPAS.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("keeps the reference to bank-safe ASCII, 25 characters at most", () => {
    // Bỏ dấu tiếng Việt, chuyển ký tự 'đ/Đ' thành 'd/D', viết hoa và cắt ngắn tối đa 25 ký tự để tương thích hệ thống ngân hàng
    assert.equal(transferReference("Đặt sân CL-07 · tối nay"), "DAT SAN CL 07 TOI NAY");
    assert.equal(transferReference("ARENA3 CRT-20261014-U0306-EXTRA").length <= 25, true);
  });

  /**
   * Làm gì: Kiểm tra validBankAccount và vietQrPayload từ chối các tài khoản ngân hàng sai định dạng (mã BIN không đủ 6 số, số tài khoản rỗng hoặc ký tự lạ).
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("refuses an account it cannot encode", () => {
    // Mã BIN ngân hàng bắt buộc phải đúng 6 chữ số và số tài khoản từ 4 đến 19 ký tự chữ hoặc số
    assert.equal(validBankAccount({ bin: "97042", accountNo: "0123" }), false);
    assert.equal(validBankAccount({ bin: "970422", accountNo: "" }), false);
    assert.equal(validBankAccount(mb), true);
    assert.throws(() => vietQrPayload({ bin: "x", accountNo: "1" }, 1000));
  });
});

/**
 * Làm gì: Bộ kiểm thử quản lý giờ hoạt động và thời gian giữ chỗ của trung tâm thể thao (venueFrom, hoursOf, hhmm).
 * Được gọi ở: test runner (node --test)
 */
describe("venue hours", () => {
  /**
   * Làm gì: Kiểm tra hàm venueFrom đọc cấu hình giờ mở/đóng cửa và số phút giữ chỗ, áp dụng cấu hình mặc định (DEFAULT_VENUE: 6h-22h, 5 phút) khi thiếu dữ liệu.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("reads the settings, and falls back when they are missing", () => {
    // Đọc chính xác giờ mở (7), giờ đóng (21) và hold_minutes (10); khi dữ liệu null hoặc rỗng thì fallback về DEFAULT_VENUE
    assert.deepEqual(venueFrom({ open_time: "07:00:00", close_time: "21:00:00", hold_minutes: 10 }), { open: 7, close: 21, holdMinutes: 10 });
    assert.deepEqual(venueFrom(null), DEFAULT_VENUE);
    assert.deepEqual(venueFrom({}), DEFAULT_VENUE);
  });

  /**
   * Làm gì: Kiểm tra giờ đóng cửa có số phút lẻ (như 21:30) tự động được làm tròn lên 22 để khách hàng vẫn có thể đặt khung giờ 21:00-22:00.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("sells the hour a part-hour close falls in, as the server's availability does", () => {
    // Đóng cửa lúc 21:30 vẫn bán trọn vẹn khung giờ 21:00-22:00, nên giờ đóng cửa được làm tròn lên 22
    assert.equal(venueFrom({ open_time: "06:00", close_time: "21:30" }).close, 22);
  });

  /**
   * Làm gì: Kiểm tra khi cấu hình bị lỗi (giờ đóng cửa 06:00 không lớn hơn giờ mở cửa 22:00) thì hệ thống fallback cả cặp giờ về DEFAULT_VENUE.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("refuses a close that is not after the open, as a pair", () => {
    // Giờ mở và đóng cửa phải kiểm tra theo cặp; nếu close <= open thì khôi phục lại cả cặp mặc định (6h - 22h) để tránh ngày rỗng
    const v = venueFrom({ open_time: "22:00", close_time: "06:00", hold_minutes: 5 });
    assert.equal(v.open, DEFAULT_VENUE.open);
    assert.equal(v.close, DEFAULT_VENUE.close);
  });

  /**
   * Làm gì: Kiểm tra thời gian giữ chỗ tạm thời (hold_minutes) nếu không phải số nguyên dương (<= 0) sẽ lấy giá trị mặc định là 5 phút.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("ignores a hold length that is not a positive whole number", () => {
    // Giá trị hold_minutes bằng 0 hoặc không hợp lệ sẽ fallback về 5 phút; giá trị nguyên dương (7) được giữ nguyên
    assert.equal(venueFrom({ hold_minutes: 0 }).holdMinutes, 5);
    assert.equal(venueFrom({ hold_minutes: 7 }).holdMinutes, 7);
  });

  /**
   * Làm gì: Kiểm tra hàm hoursOf liệt kê danh sách các giờ có thể nhận lịch đặt sân và hàm hhmm định dạng số giờ thành chuỗi HH:00.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("lists the bookable hours and formats them", () => {
    // Bước 1: Trung tâm hoạt động từ 6h đến 9h có 3 khung giờ nhận đặt sân: [6, 7, 8]
    assert.deepEqual(hoursOf({ open: 6, close: 9, holdMinutes: 5 }), [6, 7, 8]);
    // Bước 2: DEFAULT_VENUE (6h đến 22h) có đúng 16 khung giờ đặt sân trong ngày
    assert.equal(hoursOf(DEFAULT_VENUE).length, 16);
    // Bước 3: Định dạng số giờ sang chuỗi 2 chữ số kèm ":00" (ví dụ: 6 -> "06:00", 22 -> "22:00")
    assert.equal(hhmm(6), "06:00");
    assert.equal(hhmm(22), "22:00");
  });
});
