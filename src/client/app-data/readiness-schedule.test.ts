/**
 * Mục đích file:
 * File kiểm thử đơn vị (unit test) cho module src/client/app-data/readiness-schedule.ts.
 * Kiểm tra thuật toán tăng độ trễ thăm dò (backoff delay) và giới hạn thời gian chờ tối đa (timeout budget)
 * khi kiểm tra trạng thái sẵn sàng của connector token từ Grok preview.
 *
 * Vị trí trong hệ thống:
 * Được thực thi bởi test runner (node --test) trong bộ kiểm thử tự động,
 * đảm bảo hook useRefetchWhenConnectorReady có lịch trình retry và timeout chính xác, tránh spam request hoặc treo vô hạn.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  READINESS_PROBE_DELAYS_MS,
  READINESS_PROBE_MAX_TOTAL_MS,
  readinessProbeDelayMs,
  readinessProbeExhausted,
} from "./readiness-schedule.ts";

/**
 * Làm gì: Nhóm các ca kiểm thử cho hàm readinessProbeDelayMs, kiểm tra thuật toán tính độ trễ thăm dò tăng dần và xử lý giá trị biên.
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("readinessProbeDelayMs", () => {
  /**
   * Làm gì: Kiểm tra độ trễ tăng dần qua từng lần thử theo READINESS_PROBE_DELAYS_MS ([1s, 2s, 3s, 5s]) và giữ nguyên mốc cuối cùng (5s) khi vượt quá số mốc.
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("backs off through the schedule and then holds the last delay", () => {
    // Bước 1: Lấy giá trị trễ tối đa ở cuối danh sách cấu hình (5.000 ms)
    const last = READINESS_PROBE_DELAYS_MS[READINESS_PROBE_DELAYS_MS.length - 1];
    // Bước 2: Kiểm tra các lần thử 0, 1, 2, 3 khớp tương ứng [1s, 2s, 3s, 5s]; các lần thử 4 và 50 đều neo lại ở mức tối đa 5s
    assert.deepEqual(
      [0, 1, 2, 3, 4, 50].map(readinessProbeDelayMs),
      [...READINESS_PROBE_DELAYS_MS, last, last],
    );
  });

  /**
   * Làm gì: Kiểm tra cơ chế bảo vệ khi attempt là số âm, hàm phải tự ép về mốc trễ đầu tiên READINESS_PROBE_DELAYS_MS[0] (1.000 ms).
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("clamps a negative attempt to the first delay", () => {
    // Math.max(attempt, 0) bảo đảm attempt âm (-3) được đưa về 0, tránh lỗi index mảng âm
    assert.equal(readinessProbeDelayMs(-3), READINESS_PROBE_DELAYS_MS[0]);
  });
});

/**
 * Làm gì: Nhóm các ca kiểm thử cho hàm readinessProbeExhausted, kiểm tra logic hết hạn ngân sách chờ tối đa (3 phút).
 * Được gọi ở: test runner (node --test)
 * @returns {void}
 */
describe("readinessProbeExhausted", () => {
  /**
   * Làm gì: Kiểm tra hàm readinessProbeExhausted chỉ trả về true khi tổng thời gian chờ vượt hoặc bằng mức READINESS_PROBE_MAX_TOTAL_MS (3 phút).
   * Được gọi ở: test runner (node --test)
   * @returns {void}
   */
  it("gives up only once the total wait budget has elapsed", () => {
    // Bước 1: Khi vừa bắt đầu (elapsed = 0ms), ngân sách chưa hết hạn -> trả về false
    assert.equal(readinessProbeExhausted(1_000, 1_000), false);
    // Bước 2: Thời điểm cận trên ngay trước hạn mức (3 phút - 1ms), vẫn trong thời gian chờ hợp lệ -> trả về false
    assert.equal(
      readinessProbeExhausted(1_000, 1_000 + READINESS_PROBE_MAX_TOTAL_MS - 1),
      false,
    );
    // Bước 3: Đạt đúng mốc 3 phút (READINESS_PROBE_MAX_TOTAL_MS), hết ngân sách chờ -> trả về true để dừng thăm dò
    assert.equal(
      readinessProbeExhausted(1_000, 1_000 + READINESS_PROBE_MAX_TOTAL_MS),
      true,
    );
  });
});
