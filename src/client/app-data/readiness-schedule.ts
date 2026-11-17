export const READINESS_PROBE_DELAYS_MS = [1_000, 2_000, 3_000, 5_000] as const;

/**
 * Làm gì: Giới hạn tổng thời gian chờ tối đa (3 phút = 180.000 ms) cho toàn bộ quá trình thăm dò trước khi dừng lại do timeout.
 * Được gọi ở:
 * - src/client/app-data/readiness-schedule.ts: hàm readinessProbeExhausted
 * - src/client/app-data/use-connector-readiness.ts: hook useRefetchWhenConnectorReady
 * - test runner (node --test): src/client/app-data/readiness-schedule.test.ts
 */
export const READINESS_PROBE_MAX_TOTAL_MS = 3 * 60_000;

/**
 * Làm gì: Lấy khoảng thời gian chờ (ms) tương ứng với số lần thử thăm dò (attempt), tự động giới hạn chỉ số trong mảng READINESS_PROBE_DELAYS_MS để tránh vượt ngưỡng.
 * Được gọi ở:
 * - src/client/app-data/use-connector-readiness.ts: hàm schedule trong hook useRefetchWhenConnectorReady
 * - test runner (node --test): src/client/app-data/readiness-schedule.test.ts
 * @param attempt Số lần đã thử thăm dò (bắt đầu từ 0).
 * @returns Khoảng thời gian trễ (ms) cần chờ cho lần thăm dò tiếp theo.
 */
export function readinessProbeDelayMs(attempt: number): number {
  // Giữ index trong khoảng hợp lệ [0, READINESS_PROBE_DELAYS_MS.length - 1] để tránh lỗi undefined nếu attempt âm hoặc vượt quá số mốc delay.
  const index = Math.min(
    Math.max(attempt, 0),
    READINESS_PROBE_DELAYS_MS.length - 1,
  );
  return READINESS_PROBE_DELAYS_MS[index];
}

/**
 * Làm gì: Kiểm tra xem tổng thời gian thăm dò từ lúc bắt đầu đến thời điểm hiện tại đã vượt quá hạn mức tối đa (READINESS_PROBE_MAX_TOTAL_MS) hay chưa.
 * Được gọi ở:
 * - src/client/app-data/use-connector-readiness.ts: hàm probe trong hook useRefetchWhenConnectorReady
 * - test runner (node --test): src/client/app-data/readiness-schedule.test.ts
 * @param startedAtMs Thời điểm bắt đầu phiên thăm dò (timestamp ms).
 * @param nowMs Thời điểm hiện tại cần đối soát (timestamp ms).
 * @returns true nếu đã quá hạn mức thời gian chờ (hết ngân sách thử lại), ngược lại false.
 */
export function readinessProbeExhausted(
  startedAtMs: number,
  nowMs: number,
): boolean {
  return nowMs - startedAtMs >= READINESS_PROBE_MAX_TOTAL_MS;
}
