/**
 * Định tuyến và hiển thị trang Điều khoản sử dụng (/terms) của hệ thống Arena 3.
 * Sử dụng TanStack Router để render văn bản điều khoản (TERMS) qua LegalPage và liên kết sang trang chính sách bảo mật (/privacy).
 */
import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/client/components/legal-page";
import { TERMS } from "@/client/lib/legal";

/**
 * Làm gì: Khởi tạo định tuyến cho trang Điều khoản sử dụng (/terms) bằng TanStack Router, thiết lập tiêu đề trang và render component LegalPage với dữ liệu TERMS.
 * Được gọi ở: URL /terms (TanStack Router tự động đăng ký và nạp route).
 * @returns Route object cấu hình cho đường dẫn /terms.
 */
export const Route = createFileRoute("/terms")({
  head: () => ({ meta: [{ title: "Terms of use · Lê Long Sport" }] }),
  component: () => <LegalPage doc={TERMS} other="privacy" />,
});
