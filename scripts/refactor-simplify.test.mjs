/**
 * File: scripts/refactor-simplify.test.mjs
 * Mục đích: Bộ kiểm thử đơn vị (unit test) kiểm tra các hàm nghiệp vụ trọng yếu sau khi tối giản hóa code (refactor).
 * Vai trò trong dự án:
 * - Kiểm thử độc lập logic mở rộng lịch lặp tuần (rrule) và chuẩn hóa giờ mở/đóng cửa sân (venue).
 * - Kiểm thử tự động sinh mã sân (court code) và helper tạo câu lệnh SQL UPDATE động (sqlPatch).
 * - Kiểm thử tổng hợp công suất sử dụng sân (capacity) và kiểm tra tính hợp lệ của mã khuyến mãi (promos validate) theo quy tắc nghiệp vụ BR-41.
 * - Sử dụng TypeScript compiler API để nạp và mock module động trên bộ nhớ mà không cần khởi động database hay server thật.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import * as time from "../src/shared/arena3/time.ts";
import { venueFrom } from "../src/client/lib/venue.ts";
import { summarizeCapacity } from "../src/server/services/capacity.ts";

/**
 * Làm gì: Nạp file mã nguồn TypeScript, biên dịch sang CommonJS trên bộ nhớ bằng ts.transpileModule,
 * và chạy trong sandbox với các dependency giả lập (mock) để trích xuất các hàm cần kiểm thử.
 * Được gọi ở: Các ca kiểm thử trong file này (scripts/refactor-simplify.test.mjs).
 * - Tham số path: Đường dẫn tương đối từ file hiện tại đến file TypeScript cần kiểm thử.
 * - Tham số dependencies: Đối tượng chứa các module giả lập để inject khi mã nguồn gọi require().
 * - Tham số extraExports: Chuỗi mã lệnh bổ sung nối vào cuối file để xuất các hàm nội bộ không được export sẵn.
 * - Trả về: Đối tượng exports chứa các hàm hoặc biến được module xuất ra.
 * - Lỗi có thể ném: AssertionError nếu mã nguồn gọi require một dependency chưa được khai báo trong dependencies.
 */
function loadFunctions(path, dependencies, extraExports = "") {
  // Bước 1: Đọc toàn bộ nội dung file nguồn TypeScript từ đường dẫn chỉ định.
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  // Bước 2: Dùng TypeScript compiler API biên dịch mã TS sang CommonJS. Nối thêm extraExports nếu cần xuất các hàm private.
  const { outputText } = ts.transpileModule(source + extraExports, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  // Bước 3: Chuẩn bị đối tượng exports rỗng để nhận các hàm được xuất ra từ module.
  const exports = {};
  // Bước 4: Khởi chạy mã đã biên dịch qua new Function, mô phỏng hàm require() để inject dependency mock.
  new Function("require", "exports", outputText)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  // Bước 5: Trả về đối tượng exports chứa các hàm đã nạp thành công.
  return exports;
}

/**
 * Làm gì: Kiểm tra hàm expandWeekly mở rộng quy tắc lặp hàng tuần (RRULE): giữ đúng múi giờ ICT (+07:00),
 * giờ bắt đầu mặc định (18:00), thời lượng buổi tập, lọc bỏ thứ trùng lặp hoặc không hợp lệ, và bỏ qua tần suất không phải WEEKLY.
 * Được gọi ở: test runner (node --test)
 */
test("weekly sessions retain ICT boundaries, default hours and invalid-day filtering", () => {
  // Bước 1: Nạp hàm expandWeekly từ rrule.ts kèm mock module xử lý thời gian theo múi giờ ICT.
  const { expandWeekly } = loadFunctions("../src/server/services/rrule.ts", {
    "../../shared/arena3/time": time,
  });
  // Bước 2: Thiết lập khoảng thời gian kiểm tra từ Thứ Hai (09/11/2026) đến Thứ Hai tuần kế tiếp (16/11/2026).
  const from = new Date("2026-11-09T18:00:00+07:00");
  const until = new Date("2026-11-16T18:00:00+07:00");
  // Bước 3: Mở rộng lịch lặp với chuỗi BYDAY chứa ngày trùng (MO) và ngày lỗi (invalid), thời lượng mỗi buổi 90 phút.
  const sessions = expandWeekly("BYDAY=MO,WE,MO,invalid", 90, from, until);
  // Kỳ vọng: Hệ thống tự lọc bỏ ngày lỗi và ngày trùng, chỉ sinh 2 buổi vào Thứ Hai (09/11) và Thứ Tư (11/11) từ 18:00 đến 19:30.
  assert.deepEqual(sessions, [
    { start: from, end: new Date("2026-11-09T19:30:00+07:00") },
    { start: new Date("2026-11-11T18:00:00+07:00"), end: new Date("2026-11-11T19:30:00+07:00") },
  ]);
  // Bước 4: Kiểm tra điều kiện tần suất: nếu FREQ không phải WEEKLY (ở đây là DAILY), hàm phải trả về mảng rỗng.
  assert.deepEqual(expandWeekly("FREQ=DAILY;BYDAY=MO", 60, from, until), []);
});

/**
 * Làm gì: Kiểm tra hàm venueFrom xử lý giờ mở/đóng cửa của trung tâm: làm tròn lên giờ đóng cửa nếu có phút lẻ
 * (ví dụ 21:30 làm tròn thành 22 để khách vẫn đặt được khung 21:00-22:00) và áp dụng giá trị mặc định theo cặp khi dữ liệu bị lỗi.
 * Được gọi ở: test runner (node --test)
 */
test("closing hours retain partial-hour rounding and paired fallback", () => {
  // Trường hợp 1: Giờ đóng cửa 21:30 có số phút lẻ nên được làm tròn lên 22 để phục vụ khung giờ 21:00; giữ nguyên hold_minutes = 7.
  assert.deepEqual(venueFrom({ open_time: "06:00", close_time: "21:30", hold_minutes: 7 }), {
    open: 6, close: 22, holdMinutes: 7,
  });
  // Trường hợp 2: Giờ mở cửa muộn hơn giờ đóng cửa (lỗi dữ liệu), áp dụng fallback theo cặp mặc định 6h-22h; hold_minutes = 0 lấy mặc định là 5 phút.
  assert.deepEqual(venueFrom({ open_time: "22:00", close_time: "06:00", hold_minutes: 0 }), {
    open: 6, close: 22, holdMinutes: 5,
  });
});

/**
 * Làm gì: Kiểm tra logic tự động sinh mã sân (lấp vào số thứ tự nhỏ nhất còn trống, ví dụ CL-02 khi đã có CL-01 và CL-03)
 * và mô tả lịch chiếm sân (ưu tiên hiển thị mã đặt sân Booking code hơn là tiêu đề lớp học).
 * Được gọi ở: test runner (node --test)
 */
test("court codes fill the first gap and blockers keep booking precedence", async () => {
  // Bước 1: Nạp hàm generateCourtCode và describeCourtBlocker từ courts.ts (bổ sung export vì là các hàm nội bộ).
  const { generateCourtCode, describeCourtBlocker } = loadFunctions("../src/server/controllers/handlers/courts.ts", {
    "../errors": {}, "../helpers": {}, "../tx": {}, "../session": {},
  }, "\nexport { generateCourtCode, describeCourtBlocker };\n");
  // Bước 2: Giả lập truy vấn database trả về danh sách mã sân hiện có theo tiền tố CL- (CL-01, CL-03 và chuỗi không hợp lệ).
  const sql = { query: async (query, params) => {
    assert.equal(query, "select court_code from courts where court_code like $1");
    assert.deepEqual(params, ["CL-%"]);
    return ["CL-01", "CL-03", "invalid"].map(court_code => ({ court_code }));
  } };
  // Bước 3: Kiểm tra sinh mã sân mới: thuật toán phải điền vào khoảng trống đầu tiên còn thiếu là CL-02.
  assert.equal(await generateCourtCode(sql, "CL"), "CL-02");
  // Bước 4: Kiểm tra mô tả lịch cản trở: khi có cả mã booking B1 và tên lớp C1, hệ thống ưu tiên hiển thị 'Booking B1'.
  assert.deepEqual(describeCourtBlocker({ kind: "booking", start_at: "start", end_at: "end", code: "B1", title: "C1" }), {
    kind: "booking", start_at: "start", end_at: "end", description: "Booking B1",
  });
});

/**
 * Làm gì: Kiểm tra helper sqlPatch tạo mệnh đề UPDATE động: bảo toàn thứ tự tham số ($2, $3, $4),
 * ép kiểu trong SQL (ví dụ ::jsonb) và giữ nguyên giá trị null rõ ràng thay vì bỏ qua.
 * Được gọi ở: test runner (node --test)
 */
test("SQL patches preserve parameter order, casts and explicit null values", () => {
  // Bước 1: Nạp helper sqlPatch từ helpers.ts kèm các mock dependency liên quan.
  const { sqlPatch } = loadFunctions("../src/server/controllers/helpers.ts", {
    "../services/crypto": {}, "./errors": {}, "./tx": {},
    "../../shared/arena3/labels": {}, "../../shared/arena3/time": time,
  });
  // Bước 2: Khởi tạo patch với tham số cố định ban đầu (ví dụ $1 là ID của dòng cần cập nhật).
  const patch = sqlPatch(["row-id"]);
  // Bước 3: Thêm các cột cần cập nhật: giá trị boolean, giá trị null rõ ràng, và chuỗi JSON kèm ép kiểu ::jsonb.
  patch.add("published", false);
  patch.add("title", null);
  patch.add("payload", '{"blocks":[]}', "::jsonb");
  // Bước 4: Kiểm tra mảng mệnh đề SET: số thứ tự placeholder phải tăng dần chính xác ($2, $3, $4::jsonb).
  assert.deepEqual(patch.sets, ["published = $2", "title = $3", "payload = $4::jsonb"]);
  // Bước 5: Kiểm tra danh sách tham số: giữ đúng thứ tự truyền vào và bảo toàn giá trị null.
  assert.deepEqual(patch.params, ["row-id", false, null, '{"blocks":[]}']);
});

/**
 * Làm gì: Kiểm tra hàm summarizeCapacity tổng hợp công suất sân: duy trì thứ tự xuất hiện của các sân,
 * gán giá trị 0 cho các khung giờ không có dữ liệu, phân định chính xác giờ cao điểm/thấp điểm,
 * và an toàn trước các thuộc tính prototype đặc biệt như __proto__.
 * Được gọi ở: test runner (node --test)
 */
test("capacity summaries keep court order, missing hours and peak boundaries", () => {
  /**
   * Làm gì: Tạo đối tượng CapacityCell giả lập biểu diễn công suất của một sân trong một khung giờ cụ thể.
   * Được gọi ở: Test tổng hợp công suất ngay bên dưới.
   * - Tham số court_id: Mã định danh sân.
   * - Tham số sport: Môn thể thao (ví dụ badminton).
   * - Tham số hr: Khung giờ kiểm tra (0-23).
   * - Tham số sold_min: Số phút đã bán / đã đặt.
   * - Tham số slots: Số slot tối đa trong khung giờ (mặc định 2 slot = 120 phút).
   * - Trả về: Đối tượng CapacityCell hoàn chỉnh.
   */
  const cell = (court_id, sport, hr, sold_min, slots = 2) => ({
    court_id, court_code: court_id, sport, hr, slots, sold_min, days_booked: 1, days_total: slots,
  });
  // Bước 1: Tính toán bảng tổng hợp công suất từ 17:00 đến 20:00 (3 tiếng), khung giờ cao điểm là 17h-18h (1020 - 1080 phút).
  const summary = summarizeCapacity([
    cell("B", "badminton", 17, 90), cell("A", "badminton", 17, 60),
    cell("B", "badminton", 18, 30), cell("C", "__proto__", 17, 60),
  ], [{ sport: "badminton", start_min: 17 * 60, end_min: 18 * 60 }], 17, 20, 2);
  // Bước 2: Kiểm tra thứ tự các sân trong kết quả phải giữ nguyên theo thứ tự xuất hiện ban đầu (B, sau đó đến A, rồi đến C).
  assert.deepEqual(summary.courts.map(court => court.court_id), ["B", "A", "C"]);
  // Bước 3: Kiểm tra phần trăm lấp đầy theo từng giờ của sân B: 17h là 75% (90/120 phút), 18h là 25% (30/120 phút), 19h trống 0%.
  assert.deepEqual(summary.courts[0].cells, [75, 25, 0]);
  assert.deepEqual(summary.courts[0].days_booked, [1, 1, 0]);
  // Bước 4: Kiểm tra tổng công suất toàn trung tâm (tổng thời gian đã bán 240 phút / tổng thời gian mở 480 phút).
  assert.deepEqual(summary.all, { sold: 240, open: 480 });
  // Bước 5: Kiểm tra số liệu môn cầu lông: phân bổ chính xác giữa giờ cao điểm (peak: 150/240 phút) và giờ thấp điểm (off-peak: 30/120 phút).
  assert.deepEqual(summary.bySport.get("badminton"), {
    sold: 180, open: 360, peakSold: 150, peakOpen: 240, offSold: 30, offOpen: 120,
  });
  // Bước 6: Kiểm tra tính an toàn: tên môn thể thao trùng với thuộc tính nhạy cảm __proto__ không làm lỗi hệ thống.
  assert.equal(summary.bySport.get("__proto__").peakOpen, 0);
  // Bước 7: Kiểm tra trường hợp biên khi giờ mở cửa lớn hơn giờ đóng cửa (22h đến 6h) -> trả về mảng rỗng an toàn.
  const empty = summarizeCapacity([], [], 22, 6, 1);
  assert.deepEqual(empty.hours, []);
  assert.deepEqual(empty.courts, []);
  assert.deepEqual(empty.all, { sold: 0, open: 0 });
});

/**
 * Làm gì: Kiểm tra hàm promosValidate xem trước giá trị khuyến mãi: điều hướng xử lý theo đúng phạm vi (plan, class, court),
 * và từ chối áp dụng mã giảm giá nếu khách hàng đã được hưởng giá ưu đãi hội viên đặt sân (quy tắc nghiệp vụ BR-41).
 * Được gọi ở: test runner (node --test)
 */
test("promo previews dispatch each scope and reject member court fees before quoting", async () => {
  const calls = [];
  /**
   * Làm gì: Tạo lỗi giả lập cho trường dữ liệu không hợp lệ (validation error).
   * Được gọi ở: Đối tượng mock err bên dưới.
   * - Tham số field: Tên trường bị lỗi (ví dụ "scope").
   * - Tham số message: Thông điệp mô tả lỗi.
   * - Trả về: Đối tượng Error có gắn thêm thuộc tính field.
   */
  const field = (field, message) => Object.assign(new Error(message), { field });
  // Bước 1: Khởi tạo các dependency giả lập: giá cước sân niêm yết 100k, giá gói tập/lớp học 200k.
  const dependencies = {
    "../../services/membership": { memberCourtFee: async () => null },
    "../errors": { err: { field, notFound: message => new Error(message), br: (code, message) => Object.assign(new Error(message), { code }) } },
    "../helpers": { str: value => typeof value === "string" ? value.trim() : undefined, readJson: request => request.json(), getSettings: async () => ({}) },
    "../../services/pricing": { lookupPrice: async () => ({ price_vnd: 100000 }) },
    "../../services/promos": { quotePromo: async (sql, input) => { calls.push(input); return { discount_vnd: 10000 }; } },
    "../session": {}, "../tx": { one: async () => ({ price_vnd: 200000, sport_scope: "all", sport: "badminton" }) },
    "../validate": {}, "./sports": {},
  };
  // Bước 2: Nạp hàm promosValidate từ file handlers/promos.ts kèm các mock dependency vừa tạo.
  const { promosValidate } = loadFunctions("../src/server/controllers/handlers/promos.ts", dependencies);
  /**
   * Làm gì: Tạo đối tượng Request giả lập gọi vào API xem trước khuyến mãi với method POST và body JSON.
   * Được gọi ở: Các lần gọi kiểm thử promosValidate bên dưới.
   * - Tham số body: Dữ liệu payload JSON cần gửi.
   * - Trả về: Đối tượng Request chuẩn.
   */
  const request = body => new Request("https://arena.test/v1/promotions/validate", { method: "POST", body: JSON.stringify(body) });
  // Bước 3: Lặp qua 3 phạm vi khuyến mãi hợp lệ (gói tập, lớp học, đặt sân) để xác minh định tuyến và tính giá cơ bản.
  for (const scope of ["plan", "class", "court"]) {
    const result = await promosValidate({}, request({ scope, code: "PROMO", plan_id: "plan", class_id: "class", court_id: "court", start_at: "2026-11-09T17:00:00+07:00", user_id: "other" }), { id: "member", role: "member" });
    assert.equal(result.status, 200);
    assert.equal(result.body.valid, true);
    assert.equal(result.body.order_vnd, scope === "court" ? 100000 : 200000);
    // Với tài khoản hội viên thông thường (role: member), hệ thống bắt buộc dùng ID của chính họ, bỏ qua user_id người khác gửi lên.
    assert.equal(calls.at(-1).scope, scope);
    assert.equal(calls.at(-1).userId, "member");
  }
  // Bước 4: Kiểm tra trường hợp truyền scope không hợp lệ -> ném lỗi validation tại trường scope.
  await assert.rejects(promosValidate({}, request({ scope: "invalid", code: "PROMO" }), { id: "member", role: "member" }), error => error.field === "scope");
  // Bước 5: Giả lập trường hợp khách hàng được áp dụng phí hội viên đặc biệt khi đặt sân (memberCourtFee trả về mức phí).
  dependencies["../../services/membership"].memberCourtFee = async () => ({ fee_vnd: 20000 });
  const count = calls.length;
  // Quy tắc nghiệp vụ BR-41: Phí đặt sân theo giá ưu đãi hội viên không được phép áp dụng thêm bất kỳ mã khuyến mãi nào.
  await assert.rejects(promosValidate({}, request({ scope: "court", code: "PROMO", court_id: "court", start_at: "2026-11-09T17:00:00+07:00" }), { id: "member", role: "member" }), error => error.code === "BR-41");
  // Kiểm tra số lượt gọi quotePromo không tăng thêm, chứng minh hệ thống đã từ chối trước khi tính toán giảm giá.
  assert.equal(calls.length, count);
});
