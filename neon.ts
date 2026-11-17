/**
 * File cấu hình tài nguyên Neon Postgres (Config-as-Code) của dự án.
 * Định nghĩa cấu hình cho nền tảng Neon Serverless Postgres để quản lý database, branch và compute.
 */
import { defineConfig } from "@neon/config/v1";

/**
 * Làm gì: Khởi tạo và export cấu hình dự án Neon Postgres thông qua hàm defineConfig.
 * Được gọi ở: Neon CLI / thư viện @neon/config khi đọc cấu hình dự án để quản lý database.
 * @returns Đối tượng cấu hình Neon đã được chuẩn hóa.
 */
export default defineConfig({});
