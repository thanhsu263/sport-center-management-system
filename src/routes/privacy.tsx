/**
 * File: src/routes/privacy.tsx
 * Vai trò: Định nghĩa route và trang hiển thị Chính sách bảo vệ dữ liệu cá nhân (/privacy) của hệ thống Lê Long Sport.
 * Vị trí trong app:
 * - Tuyến đường công khai "/privacy" để người dùng xem thông báo về việc xử lý và bảo vệ dữ liệu cá nhân.
 * - Được liên kết từ hộp kiểm đồng ý khi đăng ký tài khoản (src/routes/register.tsx) và liên kết chéo tại trang điều khoản sử dụng (src/routes/terms.tsx).
 * - Sử dụng component LegalPage cùng tài liệu PRIVACY để hiển thị nội dung theo ngôn ngữ được chọn (Anh - Việt).
 */
import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/client/components/legal-page";
import { PRIVACY } from "@/client/lib/legal";

/**
 * Làm gì: Định nghĩa route cho trang chính sách bảo mật ("/privacy") trên TanStack Router, thiết lập tiêu đề trang và gắn component LegalPage với dữ liệu PRIVACY.
 * Được gọi ở: URL /privacy (TanStack Router tự động đăng ký và nạp route khi người dùng truy cập hoặc bấm liên kết từ trang đăng ký/điều khoản).
 * @returns Đối tượng cấu hình route của TanStack Router cho đường dẫn /privacy.
 */
export const Route = createFileRoute("/privacy")({
  head: () => ({ meta: [{ title: "Personal data notice · Lê Long Sport" }] }),
  component: () => <LegalPage doc={PRIVACY} other="terms" />,
});
