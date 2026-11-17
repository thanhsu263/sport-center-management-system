/**
 * Quản lý logic kiểm tra đăng nhập và điều hướng cho connector app-data.
 * File dùng chung giữa client và server để xử lý kết quả gọi tool cần đăng nhập, connector đang chờ token, và tự động chuyển hướng.
 */
import type { CallToolResult } from "./types.ts";

/**
 * Làm gì: Kiểm tra xem kết quả gọi tool connector có thất bại do yêu cầu đăng nhập tài khoản hay không.
 * Được gọi ở: src/client/app-data/errors.ts (toCallToolErrorState), src/server/app-data/app-data.test.ts, re-export tại src/client/app-data/index.ts và src/server/app-data/client.server.ts
 * @param result Kết quả phản hồi từ tool connector (CallToolResult)
 * @returns true nếu thất bại và có cờ loginRequired = true, ngược lại false
 */
export function isLoginRequired(result: CallToolResult): boolean {
  return result.ok === false && result.loginRequired === true;
}

/**
 * Làm gì: Kiểm tra xem connector có đang trong trạng thái chờ người dùng cấp token xác thực hay không.
 * Được gọi ở: src/client/app-data/errors.ts (toCallToolErrorState), re-export tại src/client/app-data/index.ts
 * @param result Kết quả phản hồi từ tool connector (CallToolResult)
 * @returns true nếu thất bại và có cờ pending = true, ngược lại false
 */
export function isConnectorPending(result: CallToolResult): boolean {
  return result.ok === false && result.pending === true;
}

/**
 * Làm gì: Kiểm tra xem trang hiện tại có đang chạy bên trong iframe (như môi trường Grok preview) hay không.
 * Được gọi ở: src/shared/app-data/login.ts (redirectToLoginIfRequired), src/client/app-data/use-connector-readiness.ts (useEffect)
 * @returns true nếu đang nằm trong iframe hoặc bị chặn cross-origin, false nếu chạy độc lập
 */
export function isFramed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    // Trình duyệt chặn truy cập window.top do khác origin -> chắc chắn trang đang nằm trong iframe
    return true;
  }
}

/**
 * Làm gì: Tự động chuyển hướng hoặc mở tab mới tới trang đăng nhập nếu kết quả gọi tool yêu cầu xác thực.
 * Được gọi ở: src/server/app-data/app-data.test.ts, re-export tại src/client/app-data/index.ts và src/server/app-data/client.server.ts
 * @param result Kết quả phản hồi từ tool connector (CallToolResult)
 * @returns true nếu đã mở tab mới hoặc bắt đầu điều hướng, false nếu không cần đăng nhập hoặc thiếu URL
 */
export function redirectToLoginIfRequired(result: CallToolResult): boolean {
  // Bước 1: Kiểm tra xem kết quả có yêu cầu đăng nhập và có loginUrl hợp lệ hay không
  if (!isLoginRequired(result)) return false;
  const url = result.loginUrl;
  if (!url) return false;
  // Bỏ qua nếu chạy ở môi trường server (SSR) không có đối tượng window
  if (typeof window === "undefined") return false;
  // Bước 2: Nếu đang nằm trong iframe, mở trang đăng nhập ở tab mới để tránh bị chặn frame
  if (isFramed()) {
    const opened = window.open(url, "_blank");
    if (opened) {
      // Xóa opener để ngăn tab mới can thiệp ngược lại trang hiện tại qua window.opener
      opened.opener = null;
      return true;
    }
  }
  // Bước 3: Nếu chạy trực tiếp ở cửa sổ chính (hoặc popup bị chặn), điều hướng ngay tại tab hiện tại
  window.location.assign(url);
  return true;
}
