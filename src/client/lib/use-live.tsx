/**
 * File: src/client/lib/use-live.tsx
 * Vai trò: Quản lý kết nối thời gian thực (SSE) và cung cấp các hook/component cập nhật dữ liệu tự động cho client.
 * Vị trí trong app:
 * - Khởi tạo singleton LiveHub duy nhất để gom toàn bộ các chủ đề (topics) cần lắng nghe vào một luồng EventSource (/api/live).
 * - Cung cấp hook useLive để các trang và component (sân tập, lớp học, thông báo, chat, thanh toán...) tự động refetch khi có dữ liệu mới.
 * - Cung cấp hook useChangedHighlight và component HighlightBadge tạo hiệu ứng chuyển động/nhấp nháy nhẹ khi giá trị thay đổi trên giao diện.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { getToken } from "../arena3/client";

// Kiểu hàm callback không tham số được gọi khi topic nhận sự kiện mới từ server
type Listener = () => void;

/**
 * Làm gì: Quản lý kết nối Server-Sent Events (SSE) tập trung cho toàn bộ ứng dụng; gom tất cả topic vào một luồng EventSource duy nhất, tự ngắt khi ẩn tab và chuyển sang polling nếu mất kết nối.
 * Được gọi ở: Khởi tạo biến singleton liveHub ở cuối file (dòng 181), phục vụ hook useLive.
 */
class LiveHub {
  private listeners = new Map<string, Set<Listener>>();
  private eventSource: EventSource | null = null;
  private currentTopicsKey = "";
  private isVisible = true;
  private isPollingFallback = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private connectTimeout: ReturnType<typeof setTimeout> | null = null;

  /**
   * Làm gì: Khởi tạo instance LiveHub, kiểm tra trạng thái hiển thị của tab trình duyệt và đăng ký sự kiện visibilitychange để quản lý kết nối.
   * Được gọi ở: Khởi tạo singleton liveHub (dòng 181).
   */
  constructor() {
    // Bước 1: Chỉ chạy trên trình duyệt (tránh lỗi khi thực thi trong môi trường server / SSR)
    if (typeof window !== "undefined") {
      this.isVisible = !document.hidden;
      // Bước 2: Lắng nghe sự kiện chuyển tab để tự động tạm ngắt hoặc khôi phục luồng mạng
      document.addEventListener("visibilitychange", () => {
        const visible = !document.hidden;
        if (this.isVisible !== visible) {
          this.isVisible = visible;
          if (visible) {
            // Tab active again: refetch everything once to catch up, then resume stream
            this.notifyAll();
            this.syncConnection();
          } else {
            // Tab hidden: pause network stream
            this.disconnect();
            this.stopPolling();
          }
        }
      });
    }
  }

  /**
   * Làm gì: Đăng ký một hàm callback lắng nghe sự kiện của một topic cụ thể, tự động kích hoạt đồng bộ kết nối SSE và trả về hàm hủy đăng ký (unsubscribe).
   * Được gọi ở: useLive (trong file này).
   * @param topic Tên chủ đề cần lắng nghe (ví dụ: "courts", "classes", "chat", "alerts").
   * @param listener Hàm callback sẽ được gọi khi có thông báo mới thuộc topic này.
   * @returns Hàm dọn dẹp để hủy đăng ký listener khi component unmount.
   */
  subscribe(topic: string, listener: Listener): () => void {
    // Bước 1: Khởi tạo Set chứa các listener cho topic nếu chưa có, sau đó thêm listener vào danh sách
    if (!this.listeners.has(topic)) {
      this.listeners.set(topic, new Set());
    }
    this.listeners.get(topic)!.add(listener);
    // Bước 2: Đồng bộ lại kết nối SSE với danh sách topic mới sau khi thêm
    this.syncConnection();

    // Bước 3: Trả về hàm cleanup để hủy đăng ký listener và đồng bộ lại kết nối khi unmount
    return () => {
      const set = this.listeners.get(topic);
      if (set) {
        set.delete(listener);
        if (set.size === 0) {
          this.listeners.delete(topic);
        }
      }
      this.syncConnection();
    };
  }

  /**
   * Làm gì: Lấy danh sách tất cả các topic đang có ít nhất một listener và sắp xếp theo thứ tự bảng chữ cái để tạo chuỗi key so sánh ổn định.
   * Được gọi ở: LiveHub.syncConnection.
   * @returns Mảng chuỗi chứa tên các topic đang hoạt động.
   */
  private getActiveTopics(): string[] {
    return Array.from(this.listeners.keys()).sort();
  }

  /**
   * Làm gì: Kích hoạt lần lượt tất cả các hàm callback đã đăng ký cho một topic cụ thể khi nhận được sự kiện từ server.
   * Được gọi ở: LiveHub.notifyAll, LiveHub.connect (khi EventSource nhận tin nhắn).
   * @param topic Tên chủ đề cần thông báo tới các listener.
   */
  private notifyTopic(topic: string) {
    const set = this.listeners.get(topic);
    if (set) {
      for (const listener of set) {
        // Bọc try-catch để lỗi của một listener không làm gián đoạn các listener khác
        try {
          listener();
        } catch (e) {
          console.error("[live] listener error", e);
        }
      }
    }
  }

  /**
   * Làm gì: Kích hoạt thông báo cho toàn bộ các topic đang theo dõi để ép các component refetch lại dữ liệu mới nhất.
   * Được gọi ở: LiveHub.constructor (khi người dùng mở lại tab), LiveHub.startPolling (mỗi chu kỳ fallback polling).
   */
  private notifyAll() {
    for (const topic of this.listeners.keys()) {
      this.notifyTopic(topic);
    }
  }

  /**
   * Làm gì: Kiểm tra danh sách các topic đang hoạt động để quyết định mở kết nối SSE mới, ngắt kết nối nếu không còn ai nghe, hoặc giữ nguyên nếu danh sách không đổi.
   * Được gọi ở: LiveHub.constructor, LiveHub.subscribe.
   */
  private syncConnection() {
    // Bước 1: Không kết nối nếu đang chạy SSR trên server hoặc người dùng đang ẩn tab
    if (typeof window === "undefined" || !this.isVisible) return;

    // Bước 2: Lấy danh sách topic và tạo key định danh bằng chuỗi nối các topic
    const topics = this.getActiveTopics();
    const key = topics.join(",");

    // Bước 3: Nếu không còn component nào lắng nghe topic, ngắt toàn bộ kết nối và dừng polling
    if (topics.length === 0) {
      this.disconnect();
      this.stopPolling();
      this.currentTopicsKey = "";
      return;
    }

    // Bước 4: Nếu danh sách topic không thay đổi và kết nối (hoặc polling) vẫn đang chạy thì giữ nguyên
    if (this.currentTopicsKey === key && (this.eventSource || this.isPollingFallback)) {
      return;
    }

    // Bước 5: Cập nhật key chủ đề hiện tại và thiết lập kết nối mới
    this.currentTopicsKey = key;
    this.connect(topics);
  }

  /**
   * Làm gì: Khởi tạo kết nối EventSource tới endpoint SSE /api/live kèm theo JWT token và danh sách topics; thiết lập timeout 8 giây dự phòng chuyển sang polling nếu kết nối bị nghẽn.
   * Được gọi ở: LiveHub.syncConnection.
   * @param topics Danh sách tên các topic cần đăng ký nhận sự kiện từ server.
   */
  private connect(topics: string[]) {
    // Bước 1: Đóng kết nối EventSource cũ trước khi tạo kết nối mới
    this.disconnect();

    // Bước 2: Nếu trình duyệt không hỗ trợ EventSource (môi trường cũ), chuyển sang cơ chế polling dự phòng
    if (typeof EventSource === "undefined") {
      this.startPolling();
      return;
    }

    // Bước 3: Đính kèm JWT token (nếu có) và danh sách topic vào URL query parameters
    const token = getToken();
    const params = new URLSearchParams({
      topics: topics.join(","),
    });
    if (token) params.set("token", token);

    // Bước 4: Khởi tạo đối tượng EventSource kết nối tới endpoint SSE /api/live
    const es = new EventSource(`/api/live?${params.toString()}`);
    this.eventSource = es;

    // If connection doesn't establish within 8 seconds, fall back to polling
    // Bước 5: Đặt timeout 8 giây; nếu SSE vẫn ở trạng thái CONNECTING thì chuyển sang polling fallback
    this.connectTimeout = setTimeout(() => {
      if (es.readyState === EventSource.CONNECTING) {
        this.disconnect();
        this.startPolling();
      }
    }, 8000);

    // Bước 6: Xử lý khi kết nối mở thành công: hủy timeout và dừng polling dự phòng
    es.onopen = () => {
      if (this.connectTimeout) clearTimeout(this.connectTimeout);
      this.stopPolling();
    };

    // Bước 7: Nhận dữ liệu sự kiện từ server, parse JSON và kích hoạt listener của topic tương ứng
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data && typeof data.topic === "string") {
          this.notifyTopic(data.topic);
        }
      } catch {
        // ignore malformed message
      }
    };

    // Bước 8: Xử lý khi kết nối gặp lỗi hoặc bị đóng vĩnh viễn: ngắt SSE và chuyển sang polling dự phòng
    es.onerror = () => {
      // If stream closes or errors out permanently, fall back to polling
      if (es.readyState === EventSource.CLOSED) {
        this.disconnect();
        this.startPolling();
      }
    };
  }

  /**
   * Làm gì: Bật cơ chế dự phòng thăm dò (polling) chu kỳ 4 giây một lần khi SSE gặp sự cố hoặc không được hỗ trợ, nhằm đảm bảo UI vẫn nhận được cập nhật.
   * Được gọi ở: LiveHub.connect (khi timeout kết nối, khi lỗi đóng stream, hoặc trình duyệt thiếu EventSource).
   */
  private startPolling() {
    // Tránh khởi tạo nhiều timer nếu đã ở chế độ polling fallback
    if (this.isPollingFallback) return;
    this.isPollingFallback = true;
    this.stopPolling();

    // Poll every 4 seconds when falling back
    // Chu kỳ 4 giây: nếu tab đang hiển thị thì kích hoạt refetch cho tất cả topic
    this.pollTimer = setInterval(() => {
      if (!this.isVisible) return;
      this.notifyAll();
    }, 4000);
  }

  /**
   * Làm gì: Dừng timer polling và đặt lại trạng thái dự phòng polling về false.
   * Được gọi ở: LiveHub.constructor (khi ẩn tab), LiveHub.syncConnection, LiveHub.connect, LiveHub.startPolling.
   */
  private stopPolling() {
    this.isPollingFallback = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Làm gì: Xóa bộ đếm thời gian kết nối và đóng kết nối EventSource hiện tại nếu đang mở.
   * Được gọi ở: LiveHub.constructor (khi ẩn tab), LiveHub.syncConnection, LiveHub.connect.
   */
  private disconnect() {
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }
}

/**
 * Làm gì: Instance duy nhất (singleton) của LiveHub dùng chung trên toàn ứng dụng client để quản lý kết nối thời gian thực.
 * Được gọi ở: useLive (trong file này).
 */
export const liveHub = new LiveHub();

/**
 * Shared live subscription hook. Subscribes to a topic on the app-wide singleton EventSource.
 * Pauses when tab is hidden, falls back to polling if SSE drops.
 */
/**
 * Làm gì: React hook đăng ký lắng nghe sự kiện thời gian thực theo topic từ singleton liveHub; tự động gọi lại hàm refetch khi topic có dữ liệu mới.
 * Được gọi ở: Các màn hình và component cần cập nhật tự động: court-grid.tsx, class-detail.tsx, pay-online.tsx, shell.tsx, alerts.tsx, chat.tsx, coach.attendance.tsx, coach.classes.tsx, desk.classes.tsx, desk.courts.tsx, desk.gate.tsx, manager.classes.tsx.
 * @param topic Tên chủ đề cần lắng nghe (ví dụ: "courts", "classes", "chat", "alerts"), hoặc null/undefined nếu chưa cần kích hoạt.
 * @param refetch Hàm callback tải lại dữ liệu của component khi nhận tín hiệu cập nhật từ server.
 */
export function useLive(topic: string | null | undefined, refetch: () => void) {
  // Bước 1: Lưu refetch vào useRef để tránh kích hoạt lại useEffect mỗi khi hàm refetch bị tạo lại ở component cha
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  // Bước 2: Đăng ký topic với liveHub và trả về hàm hủy đăng ký khi component unmount hoặc đổi topic
  useEffect(() => {
    if (!topic) return;
    const unsub = liveHub.subscribe(topic, () => {
      refetchRef.current();
    });
    return unsub;
  }, [topic]);
}

/**
 * Highlight animation when a number or value changes, honoring reduced motion.
 */
/**
 * Làm gì: React hook theo dõi sự thay đổi của một giá trị; trả về cờ boolean true trong khoảng thời gian durationMs khi giá trị thay đổi để hiển thị hiệu ứng highlight/pulse trên giao diện.
 * Được gọi ở: HighlightBadge (trong file này).
 * @param value Giá trị cần theo dõi thay đổi (ví dụ: số chỗ trống, trạng thái sân, số tiền...).
 * @param durationMs Thời gian duy trì trạng thái highlight tính bằng mili-giây (mặc định 1200ms).
 * @returns Boolean xác định giá trị vừa mới thay đổi hay không.
 */
export function useChangedHighlight(value: unknown, durationMs = 1200): boolean {
  // Bước 1: Khởi tạo state lưu trạng thái highlight và các ref lưu giá trị trước đó cùng cờ mounted
  const [highlighted, setHighlighted] = useState(false);
  const prevRef = useRef(value);
  const mountedRef = useRef(false);

  useEffect(() => {
    // Bước 2: Bỏ qua lần render đầu tiên (lúc mount) để không kích hoạt hiệu ứng khi dữ liệu mới nạp lần đầu
    if (!mountedRef.current) {
      mountedRef.current = true;
      prevRef.current = value;
      return;
    }

    // Bước 3: Khi giá trị thay đổi so với lần trước, bật highlight và hẹn giờ tự động tắt sau durationMs
    if (prevRef.current !== value) {
      prevRef.current = value;
      setHighlighted(true);
      const timer = setTimeout(() => setHighlighted(false), durationMs);
      return () => clearTimeout(timer);
    }
  }, [value, durationMs]);

  return highlighted;
}

/**
 * Lightweight wrapper to subtly pulse on value change.
 */
/**
 * Làm gì: Component bọc (wrapper) phần tử hiển thị; tự động tạo hiệu ứng nhấp nháy (pulse) đổi màu chữ sang màu nhấn (accent) khi giá trị truyền vào thay đổi.
 * Được gọi ở: class-detail.tsx, app.classes.tsx, chat.tsx, coach.attendance.tsx, coach.classes.tsx, desk.classes.tsx, manager.classes.tsx.
 * @param value Giá trị cần giám sát thay đổi để kích hoạt animation.
 * @param children Nội dung React con hiển thị bên trong thẻ span.
 * @param className Các class Tailwind CSS bổ sung cho thẻ span bọc ngoài.
 * @returns Thẻ span bao bọc children kèm hiệu ứng chuyển màu nhấp nháy khi giá trị thay đổi.
 */
export function HighlightBadge({
  value,
  children,
  className = "",
}: {
  value: unknown;
  children: ReactNode;
  className?: string;
}) {
  // Bước 1: Dùng hook useChangedHighlight để phát hiện khi prop value bị thay đổi và render class hiệu ứng pulse
  const isChanged = useChangedHighlight(value);
  return (
    <span
      className={`${className} transition-colors duration-300 ${
        isChanged ? "text-accent font-semibold motion-safe:animate-pulse" : ""
      }`}
    >
      {children}
    </span>
  );
}
