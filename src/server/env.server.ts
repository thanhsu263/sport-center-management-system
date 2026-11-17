/**
 * File: src/server/env.server.ts
 * Vai trò: Cung cấp tiện ích đọc biến môi trường an toàn phía server và kiểm tra môi trường runtime của ứng dụng.
 * Vị trí trong app: Chạy ở tầng server-side, làm nguồn chân lý duy nhất (single source of truth) giúp module xác thực (gate-identity) và module dữ liệu connector (app-data) phân biệt giữa môi trường sandbox preview và môi trường production đã triển khai.
 */
/**
 * Làm gì: Đọc giá trị biến môi trường từ process.env theo tên khóa (key), tự động cắt tỉa khoảng trắng ở hai đầu chuỗi và quy đổi chuỗi rỗng thành undefined.
 * Được gọi ở: src/server/env.server.ts (hàm isWorkspacePreview), src/server/app-data/client.server.ts (hàm connectorsBaseFor, inboundContext), src/server/auth/gate-identity.server.ts (hàm isGateAuthEnabled, expectedGateAudience, resolveGateEndpoints).
 * @param key Tên của biến môi trường cần truy xuất trong process.env.
 * @returns Chuỗi giá trị hợp lệ sau khi cắt khoảng trắng, hoặc undefined nếu biến không tồn tại hay chỉ gồm khoảng trắng.
 */
export function env(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v || undefined;
}

/**
 * Workspace preview vs deployed app. The deployer writes GROK_PROJECT_ID on
 * every publish; the sandbox preview never has it. Single source of truth for
 * the split — gate audience, gate endpoints and connector-token semantics all
 * key off this predicate.
 */
export function isWorkspacePreview(): boolean {
  return !env("GROK_PROJECT_ID");
}
