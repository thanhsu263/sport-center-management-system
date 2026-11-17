/**
 * File: src/server/app-data/server-only.ts
 * Vai trò: Cung cấp chốt chặn runtime (assertion) để đảm bảo các module connector phía server không bị import hoặc thực thi trên client.
 * Vị trí trong app: Thuộc tầng server app-data, bảo vệ module client.server.ts chỉ được phép chạy trên server và được gọi thông qua createServerFn.
 */
/**
 * Làm gì: Kiểm tra môi trường thực thi và ném lỗi nếu phát hiện mã đang chạy trên trình duyệt (client) thay vì server.
 * Được gọi ở: src/server/app-data/client.server.ts; src/server/app-data/server-only.ts (dòng 11 khi nạp module).
 * @param context Tên định danh module hoặc ngữ cảnh cần bảo vệ server-only (mặc định là "app-data/client.server").
 * @returns Không có giá trị trả về (void).
 * @throws Error Ném lỗi khi typeof window !== "undefined" (phát hiện đối tượng window của trình duyệt).
 */
export function assertAppDataServerOnly(
  context = "app-data/client.server",
): void {
  // Kiểm tra đối tượng window toàn cục: nếu tồn tại tức là mã đang chạy ở trình duyệt phía client
  if (typeof window !== "undefined") {
    throw new Error(
      `@/server/${context} is server-only. Call connector tools from a createServerFn handler (dynamic import of @/server/app-data/client.server), never from a React component, useEffect, or browser fetch. Types and login helpers are client-safe via @/client/app-data.`,
    );
  }
}

// Tự động kiểm tra ngay khi module được import để phát hiện vi phạm ranh giới server-only ngay lúc nạp file
assertAppDataServerOnly("app-data/client.server");
