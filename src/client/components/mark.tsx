/**
 * File: src/client/components/mark.tsx
 * Vai trò: Cung cấp các biểu tượng đồ họa SVG nhận diện thương hiệu và hình nền trang trí sân đấu cho ứng dụng Arena3.
 * Vị trí trong app: Chạy ở client, xuất các component ArenaMark (logo sân thể thao Arena3), AssistantMark (biểu tượng trợ lý AI) và CourtBackdrop (hình nền vector sân thi đấu), được sử dụng trên thanh điều hướng, chân trang, landing page và các trang xác thực (login, register, verify).
 */
import { cn } from "@/client/lib/cn";

/**
 * Làm gì: Hiển thị biểu tượng logo Arena3 (hình sân thể thao cách điệu với vạch lưới accent trong khung vuông bo góc).
 * Được gọi ở:
 * - src/client/components/shell.tsx: component AppShell (logo thương hiệu trên thanh điều hướng)
 * - src/client/components/landing/header.tsx, closing.tsx: header và footer trang landing
 * - src/routes/login.tsx, src/routes/register.tsx, src/routes/verify.$code.tsx: tiêu đề các trang xác thực
 * - src/client/components/legal-page.tsx, src/client/components/media.tsx
 * @param className Class CSS tùy biến kích thước và màu sắc (mặc định size-8).
 * @returns Thẻ JSX <svg> chứa logo thương hiệu Arena3 với tỷ lệ viewBox 32x32.
 */
export function ArenaMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8", className)} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-fg" />
      <rect x="7" y="7" width="18" height="18" fill="none" className="stroke-bg" strokeWidth="1.7" />
      <line x1="16" y1="7" x2="16" y2="25" className="stroke-bg" strokeWidth="1.7" />
      <rect x="7" y="15.1" width="18" height="1.8" className="fill-accent" />
    </svg>
  );
}

/**
 * The mark for the in-app assistant.
 *
 * A plain speech bubble was doing this job — the same glyph every chat widget
 * on the internet uses, and one that says nothing about what this particular
 * assistant knows. It also sat in the header and in the Quick actions grid at
 * once, so the member met the same anonymous bubble twice.
 *
 * This is the court the Arena3 mark is built from, with a spark over the corner
 * it leaves open: the assistant answers out of the centre's own timetable and
 * prices, and the icon should say which centre. Drawn to lucide's geometry —
 * 24px box, 1.75 stroke, round joins — so it sits in a row of lucide icons
 * without looking pasted in.
 */
/**
 * Làm gì: Hiển thị biểu tượng trợ lý AI của Arena3 (sân thể thao cách điệu mở góc kèm ngôi sao bốn cánh), thiết kế theo chuẩn kích thước và độ dày nét của Lucide icon.
 * Được gọi ở:
 * - src/client/components/shell.tsx: component AppHeader (nút mở nhanh trợ lý AI ở thanh điều hướng trên)
 * - src/routes/app.assistant.tsx: tiêu đề trang trợ lý ảo
 * - src/routes/app.index.tsx: component MemberDashboard (thẻ Ask AI trong lưới thao tác nhanh Quick actions)
 * @param className Class CSS tùy biến kích thước và màu sắc (mặc định size-6).
 * @param strokeWidth Độ dày nét vẽ SVG (mặc định 1.75 để hài hòa với hệ thống Lucide icons).
 * @returns Thẻ JSX <svg> biểu tượng trợ lý AI kích thước viewBox 24x24.
 */
export function AssistantMark({
  className,
  strokeWidth = 1.75,
}: {
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-6", className)}
      aria-hidden
    >
      <path d="M13.5 5H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1v-7" />
      <path d="M4 12h15" />
      <path d="M18.6 2l.85 1.9 1.9.85-1.9.85-.85 1.9-.85-1.9-1.9-.85 1.9-.85z" />
    </svg>
  );
}

/**
 * Làm gì: Hiển thị hình nền vector mô phỏng sơ đồ sân thi đấu (vạch biên, vạch trung tâm, ô giao cầu và dải lưới) làm họa tiết trang trí nền.
 * Được gọi ở: Các thành phần giao diện cần hình nền sân thể thao (card thông tin sân đấu, hero banner hoặc widget đặt sân).
 * @param className Class CSS tùy biến màu sắc và độ mờ bổ sung (mặc định mang class text-accent).
 * @returns Thẻ JSX <svg> sơ đồ sân thi đấu với tỷ lệ khung hình viewBox 200x280.
 */
export function CourtBackdrop({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 280" className={cn("text-accent", className)} aria-hidden>
      <rect x="18" y="12" width="164" height="256" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.35" />
      <line x1="100" y1="12" x2="100" y2="268" stroke="currentColor" strokeWidth="2" opacity="0.35" />
      <rect x="18" y="132" width="164" height="16" fill="currentColor" opacity="0.28" />
      <rect x="40" y="12" width="48" height="80" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.28" />
      <rect x="112" y="12" width="48" height="80" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.28" />
      <rect x="40" y="188" width="48" height="80" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.28" />
      <rect x="112" y="188" width="48" height="80" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.28" />
    </svg>
  );
}
