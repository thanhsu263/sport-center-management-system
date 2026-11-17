export const CONNECTOR_TOKEN_HEADER = "x-connector-access-token";

/**
 * Làm gì: Mã định danh lỗi quy ước khi access token của connector đang được xử lý hoặc chưa sẵn sàng.
 * Được gọi ở: src/server/app-data/client.server.ts (hàm callConnectorTool).
 */
export const CONNECTOR_TOKEN_PENDING_CODE = "connector_token_pending";

/**
 * Làm gì: Tên sự kiện DOM phát trên window khi token của connector đã sẵn sàng, giúp UI tự động refetch dữ liệu.
 * Được gọi ở: src/client/lib/preview-host-bridge.ts (phát event), src/client/app-data/use-connector-readiness.ts (lắng nghe event).
 */
export const CONNECTOR_TOKEN_READY_EVENT = "grok:connector-token-ready";

/**
 * Làm gì: Đối tượng enum định nghĩa danh sách các loại connector bên thứ ba được hệ thống hỗ trợ kết nối.
 * Được gọi ở: src/server/app-data/client.server.ts (hàm callConnectorTool), src/server/app-data/app-data.test.ts, src/client/app-data/index.ts.
 */
export const ConnectorType = {
  GoogleDrive: "GoogleDrive",
  Gmail: "Gmail",
  GoogleCalendar: "GoogleCalendar",
  Outlook: "Outlook",
  OutlookCalendar: "OutlookCalendar",
  MicrosoftTeams: "MicrosoftTeams",
  Mcp: "Mcp",
} as const;

/**
 * Làm gì: Kiểu dữ liệu TypeScript đại diện cho tên hợp lệ của một connector (Union string từ các giá trị của ConnectorType).
 * Được gọi ở: src/shared/app-data/types.ts (CallToolOptions), src/server/app-data/client.server.ts, src/client/app-data/index.ts.
 */
export type ConnectorTypeName =
  (typeof ConnectorType)[keyof typeof ConnectorType];

/**
 * Làm gì: Danh mục tên các công cụ (tools) thao tác với Google Drive (tìm kiếm, đọc file, quản lý thư mục, xóa file).
 * Được gọi ở: src/client/app-data/index.ts, src/server/app-data/client.server.ts.
 */
export const GoogleDriveTools = {
  search: "google_drive_search",
  readFile: "google_drive_read_file",
  listFolder: "google_drive_list_folder",
  createFolder: "google_drive_create_folder",
  trashFile: "google_drive_trash_file",
} as const;

/**
 * Làm gì: Danh mục tên các công cụ (tools) thao tác với Google Calendar (danh sách lịch, tìm kiếm, xem sự kiện, kiểm tra lịch rảnh).
 * Được gọi ở: src/server/app-data/app-data.test.ts, src/client/app-data/index.ts, src/server/app-data/client.server.ts.
 */
export const GoogleCalendarTools = {
  listCalendars: "google_calendar_list_calendars",
  search: "google_calendar_search",
  getEvent: "google_calendar_get_event",
  availability: "google_calendar_availability",
} as const;

/**
 * Làm gì: Cấu trúc kết quả chuẩn trả về khi gọi một công cụ của connector (gồm cờ thành công, dữ liệu, thông báo lỗi hoặc URL yêu cầu đăng nhập).
 * Được gọi ở: src/shared/app-data/login.ts, src/client/app-data/errors.ts, src/server/app-data/client.server.ts.
 */
export type CallToolResult<T = unknown> = {
  ok: boolean;
  data: T | null;
  errorMessage?: string;
  loginRequired?: boolean;
  loginUrl?: string;
  pending?: boolean;
};

/**
 * Làm gì: Các tùy chọn cấu hình khi gọi công cụ của connector (loại connector, catalog ID nếu dùng MCP, token tùy chọn).
 * Được gọi ở: src/server/app-data/client.server.ts (hàm callConnectorTool), src/client/app-data/index.ts.
 */
export type CallToolOptions = {
  connectorType: ConnectorTypeName;
  connectorCatalogId?: string;
  token?: string | null;
};

/**
 * Làm gì: Kiểu dữ liệu đại diện cho danh sách tham số dạng key-value truyền vào khi thực thi công cụ của connector.
 * Được gọi ở: src/server/app-data/client.server.ts (hàm callConnectorTool), src/server/app-data/app-data.test.ts.
 */
export type ToolArgs = Record<string, unknown>;
