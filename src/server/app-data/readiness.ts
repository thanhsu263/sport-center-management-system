/**
 * File: src/server/app-data/readiness.ts
 * Vai trò: Cung cấp server function kiểm tra trạng thái sẵn sàng của connector token (Google Drive, Calendar...).
 * Vị trí trong app: Chạy ở server (TanStack Start), cung cấp API endpoint dạng POST để client thăm dò trạng thái token từ header request mà không cần gọi trực tiếp tới gate bên ngoài.
 */
import { createServerFn } from "@tanstack/react-start";

/**
 * Làm gì: Định nghĩa kiểu dữ liệu kết quả kiểm tra trạng thái sẵn sàng của connector token, chứa cờ ready cho biết token đã sẵn sàng hay chưa.
 * Được gọi ở: Kiểu trả về của server function getConnectorReadiness trong file này.
 */
export type ConnectorReadiness = { ready: boolean };

/**
 * Làm gì: Tạo server function (phương thức POST) để client thăm dò xem request hiện tại đã đính kèm connector token hợp lệ hay chưa, kiểm tra qua header mà không gọi ra gate bên ngoài.
 * Được gọi ở: src/client/app-data/use-connector-readiness.ts trong hàm isConnectorReady.
 * @returns Promise<ConnectorReadiness> Đối tượng chứa thuộc tính ready (true nếu đã có token hợp lệ và chưa từng bị gate từ chối, ngược lại là false).
 */
export const getConnectorReadiness = createServerFn({ method: "POST" }).handler(
  async (): Promise<ConnectorReadiness> => {
    // Bước 1: Dùng dynamic import tải module client.server.ts tại runtime để tránh kéo mã server-only vào bundle phía client
    const { isConnectorTokenReady } = await import("./client.server.ts");
    // Bước 2: Kiểm tra connector token từ header của request và trả về trạng thái sẵn sàng
    return { ready: isConnectorTokenReady() };
  },
);
