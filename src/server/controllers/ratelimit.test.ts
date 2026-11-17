/**
 * Mục đích file:
 * File kiểm thử đơn vị (unit test) cho bộ điều khiển giới hạn tần suất gọi API (rate limiter) trong src/server/controllers/ratelimit.ts.
 * Kiểm tra thuật toán cửa sổ trượt (sliding-window) và các quy tắc giới hạn cho yêu cầu hỗ trợ (ticket), đàm phán WebRTC và gửi tin nhắn chat.
 *
 * Vị trí trong hệ thống:
 * Được thực thi bởi test runner (node --test) thông qua tsx trong bộ kiểm thử tự động,
 * bảo đảm hệ thống ngăn chặn lạm dụng và vòng lặp vô tận từ client nhưng không làm gián đoạn trải nghiệm của người dùng bình thường.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clearAll, RULES, take } from "./ratelimit";

/**
 * Runs under `tsx`, not `node --experimental-strip-types`, because
 * `ratelimit.ts` imports `./errors` without a file extension and plain ESM
 * cannot resolve that. `arena3.test.ts` is the extension-free suite; this
 * module needs a resolver, so it lives beside `tx.test.ts` in the npm script.
 *
 * Every test calls `clearAll()` first: the limiter's buckets are module state,
 * so a leftover hit from a neighbour would decide the outcome here.
 */

/**
 * Làm gì: Nhóm các ca kiểm thử giới hạn tần suất tạo yêu cầu hỗ trợ (support ticket), kiểm tra trần theo phút, tích lũy theo giờ, tách biệt giữa các user và cách tính thời gian chờ.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("support request rate limit", () => {
  /**
   * Làm gì: Kiểm tra quy tắc RULES.ticketCreate cho phép tối đa 3 yêu cầu trong 1 phút và chặn lại ở yêu cầu thứ 4.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("lets three through a minute and holds the fourth", () => {
    // Bước 1: Xóa sạch bộ nhớ bucket rate limit để đảm bảo trạng thái cô lập giữa các ca kiểm thử
    clearAll();
    const t0 = 1_000_000;
    // Bước 2: Gửi 3 yêu cầu liên tiếp trong cùng một phút, kiểm tra tất cả đều được thông qua (take trả về 0)
    for (let i = 0; i < 3; i += 1) {
      assert.equal(take("ticket:u1", RULES.ticketCreate, t0 + i * 100), 0);
    }
    // Bước 3: Gửi yêu cầu thứ 4 trong cùng cửa sổ 60 giây, kiểm tra yêu cầu bị chặn (take trả về số giây phải chờ > 0)
    assert.ok(take("ticket:u1", RULES.ticketCreate, t0 + 300) > 0);
  });

  /**
   * Làm gì: Kiểm tra chốt chặn tích lũy theo giờ (RULES.ticketCreateHourly), chặn yêu cầu thứ 11 dù người dùng gửi rải rác mỗi phút một lần.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("still caps the hour once the per-minute window keeps reopening", () => {
    // Bước 1: Đặt lại trạng thái rate limit và thiết lập mốc thời gian ban đầu
    clearAll();
    let now = 2_000_000;
    // Bước 2: Gửi 10 yêu cầu rải rác mỗi phút 1 lần để lách qua giới hạn phút nhưng tích lũy vào hạn mức giờ (tối đa 10)
    // Spread out so the 3-a-minute rule never bites; the hourly guard is what
    // stops a member burying the desk queue one request at a time.
    for (let i = 0; i < 10; i += 1) {
      now += 61_000;
      assert.equal(take("ticket:u1", RULES.ticketCreate, now), 0);
      assert.equal(take("ticket:u1:hour", RULES.ticketCreateHourly, now), 0);
    }
    // Bước 3: Ở yêu cầu thứ 11, giới hạn phút vẫn cho phép nhưng giới hạn giờ chặn lại do đã hết ngân sách 10 yêu cầu/giờ
    now += 61_000;
    assert.equal(take("ticket:u1", RULES.ticketCreate, now), 0);
    assert.ok(take("ticket:u1:hour", RULES.ticketCreateHourly, now) > 0);
  });

  /**
   * Làm gì: Kiểm tra yêu cầu tạo ticket qua trợ lý AI bị chặn bởi hạn mức bàn trực (3/phút) trước khi chạm trần gọi trợ lý (20/phút).
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("bites long before the assistant ceiling does", () => {
    // Bước 1: Xóa bộ nhớ rate limit trước khi kiểm tra cơ chế kiểm soát 2 tầng
    clearAll();
    const t0 = 3_000_000;
    // A `ticket:` turn through the assistant pays twice: the endpoint ceiling
    // (FR-A03) and the desk's own budget. The desk's is the one that stops a
    // flood — three a minute, not twenty. That gap was the whole of bug #2:
    // `RULES.assistant` was the only guard, so twenty a minute reached the
    // queue, or about 1,200 an hour.
    // Bước 2: Thực hiện 3 lượt gửi ticket qua trợ lý AI, cả hạn mức AI và hạn mức ticket đều cho phép
    for (let i = 0; i < 3; i += 1) {
      assert.equal(take("ai:u1", RULES.assistant, t0 + i), 0);
      assert.equal(take("ticket:u1", RULES.ticketCreate, t0 + i), 0);
    }
    // Bước 3: Ở lượt thứ 4, tầng AI vẫn còn chỗ nhưng tầng bàn trực đã hết hạn mức nên bị chặn
    // The endpoint would still take a fourth turn; the desk will not.
    assert.equal(take("ai:u1", RULES.assistant, t0 + 3), 0);
    assert.ok(take("ticket:u1", RULES.ticketCreate, t0 + 3) > 0);
  });

  /**
   * Làm gì: Kiểm tra mỗi người dùng có hạn mức riêng biệt dựa trên key (ticket:u1, ticket:u2), không bị ảnh hưởng chéo lẫn nhau.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("gives each member their own allowance", () => {
    // Bước 1: Khởi tạo lại trạng thái rate limit
    clearAll();
    const t0 = 4_000_000;
    // Bước 2: Dùng hết toàn bộ hạn mức 3 lần tạo ticket của người dùng u1 và kiểm tra lần thứ 4 của u1 bị chặn
    for (let i = 0; i < 3; i += 1) take("ticket:u1", RULES.ticketCreate, t0 + i);
    assert.ok(take("ticket:u1", RULES.ticketCreate, t0 + 3) > 0);
    // Bước 3: Xác minh người dùng u2 vẫn còn nguyên ngân sách và gửi yêu cầu thành công
    assert.equal(take("ticket:u2", RULES.ticketCreate, t0 + 4), 0);
  });

  /**
   * Làm gì: Kiểm tra hàm take tính toán chính xác số giây làm tròn mà client cần phải chờ trước khi được phép gửi tiếp.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("reports how long the caller has to wait, in whole seconds", () => {
    // Bước 1: Xóa trạng thái rate limit và gửi liên tiếp 3 yêu cầu tại thời điểm t0 để làm đầy cửa sổ
    clearAll();
    const t0 = 5_000_000;
    for (let i = 0; i < 3; i += 1) take("ticket:u1", RULES.ticketCreate, t0);
    // Bước 2: Kiểm tra khi gọi lại ngay lập tức tại t0, thời gian chờ đúng bằng độ dài cửa sổ (60 giây)
    // Asked again straight away: the oldest hit has the full window left.
    assert.equal(take("ticket:u1", RULES.ticketCreate, t0), 60);
    // Bước 3: Kiểm tra sau khi trôi qua nửa cửa sổ (30 giây), thời gian chờ còn lại giảm chính xác còn 30 giây
    // Half a window later, half of it remains.
    assert.equal(take("ticket:u1", RULES.ticketCreate, t0 + 30_000), 30);
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử giới hạn tần suất đàm phán tín hiệu WebRTC (signaling), kiểm tra tính tương thích với chu kỳ thăm dò P2P và phân tách theo phòng.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("webrtc signaling rate limit", () => {
  /**
   * Làm gì: Kiểm tra hạn mức RULES.rtcSignal (400/phút) đáp ứng đủ tốc độ client thăm dò 400ms một lần (150 lần/phút) kèm gửi tín hiệu mà không bị nghẽn.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("leaves room for a real negotiation at the client's own poll rate", () => {
    // Bước 1: Xóa sạch bộ nhớ rate limit trước khi giả lập lưu lượng WebRTC
    clearAll();
    const t0 = 7_000_000;
    // Bước 2: Giả lập chuỗi 150 lần thăm dò liên tục mỗi 400ms trong 1 phút, xác nhận không lần nào bị chặn
    // `p2p.ts` polls every 400ms while a pair is connecting — 150 a minute —
    // and posts offers, answers and ICE candidates alongside. A full minute of
    // that must not trip the limit, or the fix from Phase 4 is undone by this.
    let now = t0;
    for (let i = 0; i < 150; i += 1) {
      now += 400;
      assert.equal(take("rtc:u1", RULES.rtcSignal, now), 0);
    }
    // Bước 3: Xác minh vẫn còn dư dung lượng để gửi các gói tin trao đổi tín hiệu (offer/answer/candidate)
    // Still headroom left for the signal posts that go with those polls.
    assert.equal(take("rtc:u1", RULES.rtcSignal, now), 0);
  });

  /**
   * Làm gì: Kiểm tra hạn mức tín hiệu WebRTC được phân bổ riêng cho từng phòng (room), tránh xung đột khi người dùng mở nhiều phòng khác nhau.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("gives each room its own budget", () => {
    // Bước 1: Xóa bộ nhớ rate limit trước khi kiểm thử
    clearAll();
    const t0 = 9_000_000;
    // Bước 2: Tiêu thụ hết hạn mức tín hiệu cho roomA (400 lần) và kiểm tra yêu cầu thứ 401 bị chặn
    // The limit is sized from one room's poll rate, so keying on the user alone
    // meant a second tab tripped it and lost P2P in both.
    for (let i = 0; i < RULES.rtcSignal.limit; i += 1) {
      assert.equal(take("rtc:u1:roomA", RULES.rtcSignal, t0 + i), 0);
    }
    assert.ok(take("rtc:u1:roomA", RULES.rtcSignal, t0 + RULES.rtcSignal.limit) > 0);
    // Bước 3: Xác nhận cùng người dùng u1 nhưng ở roomB vẫn còn nguyên hạn mức và gửi tín hiệu thành công
    assert.equal(take("rtc:u1:roomB", RULES.rtcSignal, t0 + RULES.rtcSignal.limit) ,0);
    clearAll();
  });

  /**
   * Làm gì: Kiểm tra cơ chế giới hạn tần suất chặn đứng vòng lặp gọi vô hạn (tight loop) khi gửi liên tục vượt ngưỡng RULES.rtcSignal.limit.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("still stops a tight loop", () => {
    // Bước 1: Xóa bộ nhớ rate limit
    clearAll();
    const t0 = 8_000_000;
    // Bước 2: Gửi liên tiếp các yêu cầu trong vòng lặp kín cho đến khi chạm mức trần 400
    for (let i = 0; i < RULES.rtcSignal.limit; i += 1) {
      assert.equal(take("rtc:u1", RULES.rtcSignal, t0 + i), 0);
    }
    // Bước 3: Xác nhận yêu cầu vượt trần ngay lập tức bị chặn lại
    assert.ok(take("rtc:u1", RULES.rtcSignal, t0 + RULES.rtcSignal.limit) > 0);
    clearAll();
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử giới hạn tần suất gửi tin nhắn chat, bảo đảm quy tắc tập trung RULES.chatMessage duy trì đúng hành vi gốc.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("chat message rate limit", () => {
  /**
   * Làm gì: Kiểm tra hằng số RULES.chatMessage giữ đúng cấu hình 25 tin nhắn trong 10 giây và chặn chính xác ở tin nhắn thứ 26.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("moved out of the handler without changing what it allows", () => {
    // Bước 1: Xóa trạng thái rate limit
    clearAll();
    const t0 = 6_000_000;
    // Bước 2: Xác thực các thông số cấu hình giới hạn (limit = 25, windowMs = 10.000ms)
    // The handler used to carry `{ windowMs: 10_000, limit: 25 }` inline.
    assert.equal(RULES.chatMessage.limit, 25);
    assert.equal(RULES.chatMessage.windowMs, 10_000);
    // Bước 3: Cho phép gửi 25 tin nhắn hợp lệ liên tiếp trong cửa sổ 10 giây
    for (let i = 0; i < 25; i += 1) {
      assert.equal(take("chat:u1", RULES.chatMessage, t0 + i), 0);
    }
    // Bước 4: Chặn tin nhắn thứ 26 khi gửi vượt ngưỡng trong cùng khoảng thời gian
    assert.ok(take("chat:u1", RULES.chatMessage, t0 + 25) > 0);
    clearAll();
  });
});
