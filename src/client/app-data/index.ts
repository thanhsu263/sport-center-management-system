/**
 * File: src/client/app-data/index.ts
 * Vai trò: Điểm xuất khẩu tập trung (barrel export) an toàn cho phía client của module app-data.
 * Vị trí trong app: Tập hợp và tái xuất (re-export) toàn bộ các hằng số, kiểu dữ liệu, hàm kiểm tra đăng nhập/token, phân loại lỗi và hook theo dõi connector token; giúp các component UI phía client sử dụng an toàn mà không vi phạm ranh giới server-only.
 */
export {
  CONNECTOR_TOKEN_HEADER,
  ConnectorType,
  GoogleCalendarTools,
  GoogleDriveTools,
} from "../../shared/app-data/types.ts";
// Tái xuất các kiểu dữ liệu dùng chung cho tham số và kết quả gọi công cụ connector
export type {
  CallToolOptions,
  CallToolResult,
  ConnectorTypeName,
  ToolArgs,
} from "../../shared/app-data/types.ts";
/**
 * Làm gì: Tái xuất các hàm tiện ích kiểm tra trạng thái token và điều hướng đăng nhập tài khoản người dùng qua Grok.
 * Được gọi ở: Các component client khi kiểm tra kết quả gọi tool connector.
 */
export {
  isConnectorPending,
  isLoginRequired,
  redirectToLoginIfRequired,
} from "../../shared/app-data/login.ts";
/**
 * Làm gì: Tái xuất hàm classifyCallToolError để phân loại mã lỗi từ kết quả gọi tool connector sang trạng thái chuẩn hóa cho UI hiển thị.
 * Được gọi ở: Các component client khi tương tác với connector tools của Grok.
 * @param result Đối tượng CallToolResult trả về từ thao tác gọi tool connector.
 * @returns Trạng thái lỗi CallToolErrorState chứa loại lỗi và thông điệp hiển thị, hoặc null nếu gọi tool thành công.
 */
export { classifyCallToolError } from "./errors.ts";
// Tái xuất các kiểu dữ liệu phân loại nhóm lỗi và cấu trúc lỗi trả về cho giao diện
export type { CallToolErrorKind, CallToolErrorState } from "./errors.ts";
/**
 * Làm gì: Tái xuất React hook useRefetchWhenConnectorReady để thăm dò và kích hoạt gọi lại hàm refetch khi connector token chuyển sang trạng thái sẵn sàng.
 * Được gọi ở: Các component client cần hiển thị dữ liệu từ connector bên thứ ba (Google Drive, Calendar...).
 * @param waiting Cờ boolean xác định đang chờ connector token hay không.
 * @param refetch Hàm callback thực hiện tải lại dữ liệu khi token sẵn sàng.
 * @returns Trạng thái chờ hiện tại của connector (ConnectorWaitStatus).
 */
export { useRefetchWhenConnectorReady } from "./use-connector-readiness.ts";
// Tái xuất kiểu dữ liệu định nghĩa các trạng thái chờ sẵn sàng của connector token
export type { ConnectorWaitStatus } from "./use-connector-readiness.ts";
