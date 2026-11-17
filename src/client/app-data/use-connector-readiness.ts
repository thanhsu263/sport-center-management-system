/**
 * File: src/client/app-data/use-connector-readiness.ts
 * Vai trò: Hook và tiện ích thăm dò (probe) kiểm tra trạng thái sẵn sàng của connector token (Google Drive, Calendar...) trong môi trường Grok preview.
 * Vị trí trong app: Chạy ở client, tự động thăm dò server hoặc đón nhận sự kiện bridge để kích hoạt refetch dữ liệu khi token của connector đã được cấp.
 */
import { useEffect, useRef, useState } from "react";
import { isFramed } from "../../shared/app-data/login.ts";
import { getConnectorReadiness } from "../../server/app-data/readiness.ts";
import {
  READINESS_PROBE_MAX_TOTAL_MS,
  readinessProbeDelayMs,
  readinessProbeExhausted,
} from "./readiness-schedule.ts";
import { CONNECTOR_TOKEN_READY_EVENT } from "../../shared/app-data/types.ts";

/**
 * Làm gì: Định nghĩa các trạng thái chờ sẵn sàng của connector token (idle: nghỉ/không chờ, waiting: đang thăm dò, timed_out: quá thời gian tối đa, not_embedded: không nằm trong iframe preview).
 * Được gọi ở: src/client/app-data/index.ts (re-export), giá trị trả về của hook useRefetchWhenConnectorReady.
 */
export type ConnectorWaitStatus =
  | "idle"
  | "waiting"
  | "timed_out"
  | "not_embedded";

/**
 * Làm gì: Thời gian giới hạn tối đa (10.000 ms = 10 giây) cho mỗi lần thăm dò kiểm tra token sẵn sàng trước khi coi là timeout.
 * Được gọi ở: Nội bộ file src/client/app-data/use-connector-readiness.ts (hàm isConnectorReady).
 */
export const READINESS_PROBE_TIMEOUT_MS = 10_000;

/**
 * Làm gì: Bọc một Promise với giới hạn thời gian (timeout); trả về null nếu Promise chạy quá hạn hoặc bị reject thay vì để ứng dụng bị treo vô hạn.
 * Được gọi ở: Nội bộ file src/client/app-data/use-connector-readiness.ts (hàm isConnectorReady).
 * @param promise Promise cần theo dõi thời gian thực thi.
 * @param ms Thời gian tối đa cho phép Promise hoàn thành (tính bằng mili-giây).
 * @returns Kết quả của Promise nếu kịp hoàn thành, hoặc null nếu quá hạn / gặp lỗi.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    // Thiết lập bộ đếm thời gian: tự động trả về null nếu Promise không giải quyết xong trong khoảng thời gian ms
    const timer = setTimeout(() => resolve(null), ms);
    const settle = (value: T | null) => {
      clearTimeout(timer);
      resolve(value);
    };
    // Lắng nghe Promise; dù thành công hay thất bại (reject) đều hủy timer và trả về kết quả tương ứng
    promise.then(settle, () => settle(null));
  });
}

/**
 * Làm gì: Gọi server function getConnectorReadiness để thăm dò xem request hiện tại đã có connector token hợp lệ hay chưa, kèm giới hạn thời gian chạy tối đa.
 * Được gọi ở: Nội bộ file src/client/app-data/use-connector-readiness.ts (hàm probe trong hook useRefetchWhenConnectorReady).
 * @returns Promise trả về true nếu connector token đã sẵn sàng, ngược lại false nếu chưa có hoặc quá thời gian chờ.
 */
async function isConnectorReady(): Promise<boolean> {
  // Bước 1: Thăm dò server với thời gian timeout READINESS_PROBE_TIMEOUT_MS (10s) để tránh treo request
  const result = await withTimeout(
    getConnectorReadiness(),
    READINESS_PROBE_TIMEOUT_MS,
  );
  // Bước 2: Chỉ trả về true khi server xác nhận token đã sẵn sàng (ready === true)
  return result?.ready === true;
}

/**
 * While `waiting` is true (a connector call returned `pending`), probes the
 * server for the connector token and calls `refetch` once it is present. The
 * probe is a header check on the app's own server — it never reaches the gate.
 * A `connector-token-ready` bridge event from the Grok preview chrome triggers
 * `refetch` immediately. A top-level page (download/export, local dev, the
 * sandbox's own `npm run preview`) is not framed by any preview, so no token
 * can ever arrive: the hook reports `not_embedded` without probing. Any framed
 * page probes, even when the parent origin cannot be resolved (empty referrer,
 * no `ancestorOrigins`): the token comes through the preview proxy, and the
 * bridge event is only the faster signal.
 */
export function useRefetchWhenConnectorReady(
  waiting: boolean,
  refetch: () => unknown,
): ConnectorWaitStatus {
  // Bước 1: Khởi tạo ref lưu callback refetch mới nhất và các state theo dõi trạng thái chờ (timeout, không nằm trong iframe)
  const refetchRef = useRef(refetch);
  const [timedOut, setTimedOut] = useState(false);
  const [notEmbedded, setNotEmbedded] = useState(false);

  // Bước 2: Đồng bộ refetch mới nhất vào refetchRef để tránh lỗi stale closure mà không làm kích hoạt lại effect thăm dò
  useEffect(() => {
    refetchRef.current = refetch;
  }, [refetch]);

  // Bước 3: Thiết lập effect thăm dò định kỳ và lắng nghe sự kiện token sẵn sàng khi waiting = true
  useEffect(() => {
    // Bỏ qua nếu không ở trạng thái chờ token (waiting = false)
    if (!waiting) return;
    // Nếu trang không nằm trong iframe (ví dụ dev local hoặc mở tab riêng), sẽ không có preview proxy cung cấp token -> dừng ngay
    if (!isFramed()) {
      setNotEmbedded(true);
      return () => setNotEmbedded(false);
    }
    // Khởi tạo các biến kiểm soát vòng lặp: cờ huỷ, cờ đang gọi refetch, số lần thử và mốc thời gian bắt đầu
    let cancelled = false;
    let refetching = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();

    // Hàm kích hoạt refetch dữ liệu; chặn gọi trùng lặp (refetching) nếu lần gọi trước chưa hoàn tất
    const runRefetch = async () => {
      if (refetching) return;
      refetching = true;
      try {
        await refetchRef.current();
      } catch {
        // The query owns its own error state; a failed refetch must not stop
        // the probe loop.
      } finally {
        refetching = false;
      }
    };
    // Lên lịch lượt thăm dò tiếp theo với độ trễ tăng dần (exponential backoff) dựa trên số lần đã thử (attempt)
    const schedule = () => {
      timer = setTimeout(probe, readinessProbeDelayMs(attempt));
      attempt += 1;
    };
    // Hàm thực hiện một lượt thăm dò: kiểm tra token qua server, nếu sẵn sàng thì refetch, ngược lại tiếp tục lên lịch thử lại
    const probe = async () => {
      if (cancelled || readinessProbeExhausted(startedAt, Date.now())) return;
      const ready = await isConnectorReady();
      if (cancelled) return;
      if (ready) await runRefetch();
      if (!cancelled) schedule();
    };
    // Xử lý sự kiện bridge từ Grok preview: kích hoạt refetch ngay mà không cần chờ đến lượt thăm dò tiếp theo
    const onTokenReady = () => {
      void runRefetch();
    };
    // Time-based terminal state: a probe that never settles or a refetch that
    // throws cannot leave the UI on "waiting" forever.
    const deadline = setTimeout(() => {
      if (!cancelled) setTimedOut(true);
    }, READINESS_PROBE_MAX_TOTAL_MS);

    // Đăng ký sự kiện từ preview host bridge và kích hoạt lượt thăm dò đầu tiên
    window.addEventListener(CONNECTOR_TOKEN_READY_EVENT, onTokenReady);
    schedule();
    // Dọn dẹp tài nguyên khi unmount hoặc khi waiting thay đổi: hủy timer, gỡ listener và reset cờ timeout
    return () => {
      cancelled = true;
      clearTimeout(deadline);
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener(CONNECTOR_TOKEN_READY_EVENT, onTokenReady);
      setTimedOut(false);
    };
  }, [waiting]);

  // Bước 4: Xác định trạng thái trả về cho UI dựa trên waiting, cờ notEmbedded và cờ timedOut
  if (!waiting) return "idle";
  if (notEmbedded) return "not_embedded";
  return timedOut ? "timed_out" : "waiting";
}
