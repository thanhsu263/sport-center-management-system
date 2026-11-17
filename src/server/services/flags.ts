/**
 * Dịch vụ quản lý và kiểm tra trạng thái các cờ tính năng (feature flags) trong hệ thống Arena 3.
 * Đọc cấu hình bật/tắt các module từ bảng feature_flags:
 * - F4: Module đào tạo, điểm danh lớp học và check-in cổng (training, attendance, gate check-in).
 * - F5: Module AI hỗ trợ gợi ý giáo án và bài tập huấn luyện (AI drills).
 * - F6: Module tin nhắn nội bộ và trợ lý AI (chat, AI assistant).
 * Đảm bảo tuân thủ quy tắc nghiệp vụ BR-52: từ chối truy cập với mã lỗi 403 FORBIDDEN khi module bị tắt.
 */
import type { Sql } from "@/server/data/db";
import { ApiError } from "../controllers/errors";
import { one } from "../controllers/tx";

// Danh sách các mã cờ tính năng được quản lý: F4 (lớp học & điểm danh), F5 (AI giáo án), F6 (chat & trợ lý AI).
export type FlagKey = "F4" | "F5" | "F6";

/**
 * Làm gì: Lấy bản đồ trạng thái bật/tắt của tất cả các cờ tính năng từ bảng feature_flags.
 * Được gọi ở: src/server/controllers/handlers/ops.ts (hàm flagsGet, phục vụ route GET /flags để trả về cấu hình cho client).
 * @param sql Kết nối cơ sở dữ liệu Postgres (Sql) để thực thi truy vấn.
 * @returns Object Record<string, boolean> chứa trạng thái của từng cờ (F4, F5, F6), mặc định là false nếu chưa có trong database.
 * @throws Không chủ động ném lỗi; có thể ném ngoại lệ nếu truy vấn SQL thất bại.
 */
export async function flagsMap(sql: Sql): Promise<Record<string, boolean>> {
  // Bước 1: Lấy toàn bộ danh sách cờ tính năng và trạng thái bật/tắt từ bảng feature_flags.
  const rows = await sql.query<{ key: string; enabled: boolean }>(
    `select key, enabled from feature_flags`,
  );
  // Bước 2: Khởi tạo giá trị mặc định là false cho mọi cờ (fail-closed) để đảm bảo an toàn nếu database chưa cấu hình.
  const out: Record<string, boolean> = { F4: false, F5: false, F6: false };
  // Cập nhật trạng thái thực tế từ các bản ghi đọc được trong database.
  for (const r of rows) out[r.key] = r.enabled;
  return out;
}

/**
 * Làm gì: Kiểm tra một cờ tính năng cụ thể (F4, F5 hoặc F6) có đang được bật hay không.
 * Được gọi ở: Hàm requireFlag trong file này; src/server/controllers/handlers/live.ts (hàm resolveLiveStreamAllowedTopics để kiểm tra cờ F6 khi mở kết nối SSE).
 * @param sql Kết nối cơ sở dữ liệu Postgres (Sql) để thực thi truy vấn.
 * @param key Mã cờ tính năng cần kiểm tra ("F4", "F5" hoặc "F6").
 * @returns true nếu cờ đang bật (enabled = true); false nếu cờ bị tắt hoặc không tồn tại trong database.
 * @throws Không chủ động ném lỗi; có thể ném ngoại lệ nếu truy vấn SQL thất bại.
 */
export async function flagOn(sql: Sql, key: FlagKey): Promise<boolean> {
  const row = await one<{ enabled: boolean }>(sql, `select enabled from feature_flags where key = $1`, [key]);
  // So sánh nghiêm ngặt với true; nếu không tìm thấy bản ghi (row là null/undefined) thì mặc định coi như cờ đang tắt.
  return row?.enabled === true;
}

/**
 * Refuse a request for a module the manager has switched off.
 *
 * 403, not 422: SRS BR-52 says a module that is off answers "forbidden", and the
 * code is stable so a screen can tell "switched off" from "not allowed for you".
 */
/**
 * Làm gì: Chặn request và ném lỗi 403 FORBIDDEN nếu module tương ứng đang bị quản lý tắt qua cờ tính năng.
 * Được gọi ở: Các handler kiểm tra cờ F4 (handlers/attendance.ts, handlers/checkin.ts, handlers/training.ts), cờ F5 (handlers/ops.ts), cờ F6 (handlers/chat.ts, handlers/ops.ts).
 * @param sql Kết nối cơ sở dữ liệu Postgres (Sql) để kiểm tra trạng thái cờ.
 * @param key Mã cờ tính năng bắt buộc phải bật để thực hiện thao tác (F4, F5 hoặc F6).
 * @throws ApiError (403, "FORBIDDEN") theo quy tắc BR-52 nếu cờ tính năng đang bị tắt.
 */
export async function requireFlag(sql: Sql, key: FlagKey) {
  // Quy tắc BR-52: Nếu tính năng đang bị tắt, ném lỗi 403 FORBIDDEN để client phân biệt giữa tính năng bị tắt và không có quyền hạn.
  if (!(await flagOn(sql, key))) {
    throw new ApiError(403, "FORBIDDEN", `Feature ${key} is switched off.`, { br: "BR-52", flag: key });
  }
}
