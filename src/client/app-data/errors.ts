/**
 * File: src/client/app-data/errors.ts
 * Vai trò: Chuẩn hóa và phân loại các lỗi phát sinh khi gọi connector tools (Google Calendar, Drive, Notion...) từ Grok.
 * Vị trí trong app: Chạy ở client, nhận CallToolResult để phân loại thành CallToolErrorState giúp UI hiển thị thông báo hoặc hành động phù hợp (login, kết nối lại, báo lỗi).
 */
import type { CallToolResult } from "../../shared/app-data/types.ts";
import { isConnectorPending, isLoginRequired } from "../../shared/app-data/login.ts";

/**
 * Phân loại các nhóm lỗi khi gọi connector tool:
 * - pending: Connector đang trong quá trình kết nối hoặc cấp token.
 * - login: Cần người dùng đăng nhập tài khoản qua Grok.
 * - not_connected: Connector chưa được kích hoạt hoặc chưa kết nối trong Grok.
 * - scope_denied: Gọi công cụ nằm ngoài phạm vi cấp phép (grant scope).
 * - access_denied: Người dùng không có quyền truy cập dữ liệu được yêu cầu.
 * - error: Lỗi hệ thống hoặc lỗi không xác định khác.
 */
export type CallToolErrorKind =
  | "pending"
  | "login"
  | "not_connected"
  | "scope_denied"
  | "access_denied"
  | "error";

/**
 * Cấu trúc trạng thái lỗi trả về để giao diện người dùng hiển thị:
 * - kind: Loại lỗi chuẩn hóa dùng để render UI tương ứng (banner, nút login, retry).
 * - message: Thông điệp giải thích ngắn gọn, dễ hiểu cho người dùng cuối.
 * - detail: Chi tiết kỹ thuật hoặc thông báo lỗi gốc phục vụ kiểm tra/debug.
 */
export type CallToolErrorState = {
  kind: CallToolErrorKind;
  message: string;
  detail?: string;
};

// Cấu trúc một quy tắc ánh xạ từ khóa lỗi sang loại lỗi CallToolErrorKind
type MessageRule = {
  needles: readonly string[];
  kind: CallToolErrorKind;
  message: string;
};

/**
 * Làm gì: Danh sách các quy tắc khớp từ khóa để nhận diện loại lỗi connector cụ thể kèm câu thông báo tương ứng.
 * Được gọi ở: Nội bộ file src/client/app-data/errors.ts (hàm matchMessageRule).
 */
const MESSAGE_RULES: readonly MessageRule[] = [
  {
    needles: ["not_connected", "failed_precondition"],
    kind: "not_connected",
    message: "Connect this connector in Grok to load your data.",
  },
  {
    needles: ["scope_denied"],
    kind: "scope_denied",
    message: "This view isn't available — the app requested a tool outside its grant.",
  },
  {
    needles: ["access_denied"],
    kind: "access_denied",
    message: "You don't have access to this data.",
  },
];

/**
 * Làm gì: Quét chuỗi thông báo lỗi thô để tìm quy tắc phân loại lỗi khớp đầu tiên trong MESSAGE_RULES.
 * Được gọi ở: src/client/app-data/errors.ts (hàm classifyCallToolError).
 * @param raw Chuỗi thông báo lỗi đã chuyển thành chữ thường.
 * @returns Quy tắc MessageRule tìm thấy đầu tiên, hoặc undefined nếu không khớp từ khóa nào.
 */
function matchMessageRule(raw: string): MessageRule | undefined {
  return MESSAGE_RULES.find((rule) =>
    rule.needles.some((needle) => raw.includes(needle)),
  );
}

/**
 * Làm gì: Phân tích kết quả gọi tool (CallToolResult) khi thất bại, chuyển thành trạng thái lỗi chuẩn hóa và thông điệp thân thiện cho người dùng.
 * Được gọi ở: src/client/app-data/index.ts (re-export); test runner (node --test trong src/server/app-data/app-data.test.ts); các component client khi thao tác với connector tools.
 * @param result Đối tượng CallToolResult trả về từ thao tác gọi tool connector.
 * @returns Trạng thái lỗi CallToolErrorState chứa loại lỗi và thông điệp hiển thị, hoặc null nếu gọi tool thành công.
 */
export function classifyCallToolError(
  result: CallToolResult,
): CallToolErrorState | null {
  // Bước 1: Kiểm tra kết quả thành công, nếu không có lỗi (ok = true) thì trả về null
  if (result.ok) return null;
  // Bước 2: Chuẩn hóa chuỗi lỗi chi tiết và tạo bản chữ thường (raw) để so khớp từ khóa không phân biệt hoa thường
  const detail = result.errorMessage || undefined;
  const raw = (result.errorMessage ?? "").toLowerCase();
  // Bước 3: Ưu tiên kiểm tra token connector đang chờ xử lý (pending trong môi trường preview); hiển thị thông báo đang kết nối
  if (isConnectorPending(result)) {
    return { kind: "pending", message: "Connecting to your data…", detail };
  }
  // Bước 4: Kiểm tra lỗi thiếu token connector; báo người dùng mở app qua Grok edge gate thay vì hiển thị nút login
  if (raw.includes("missing_connector_token")) {
    return {
      kind: "error",
      message: "Open this app from Grok to load your data.",
      detail,
    };
  }
  // Bước 5: Kiểm tra yêu cầu đăng nhập từ hệ thống; yêu cầu người dùng tiếp tục xác thực tài khoản qua Grok
  if (isLoginRequired(result)) {
    return {
      kind: "login",
      message: "Continue with Grok to load your data.",
      detail,
    };
  }
  // Bước 6: So khớp với các quy tắc từ khóa đặc thù (chưa liên kết connector, vượt grant scope, bị từ chối truy cập)
  const rule = matchMessageRule(raw);
  if (rule) return { kind: rule.kind, message: rule.message, detail };
  // Bước 7: Fallback cho các trường hợp lỗi còn lại; trả về loại error kèm chi tiết lỗi hoặc thông báo mặc định
  return {
    kind: "error",
    message: detail ?? "Something went wrong. Try again.",
    detail,
  };
}
