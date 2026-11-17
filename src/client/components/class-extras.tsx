/**
 * File này chứa các component phụ trợ (extras) dùng chung cho các màn hình lớp học:
 * - MinSizeBadge: Huy hiệu cảnh báo khi sĩ số lớp chưa đạt mức tối thiểu.
 * - AddToCalendar: Nút liên kết thêm ca học vào Google Calendar cho học viên và huấn luyện viên.
 */
import { CalendarPlus } from "lucide-react";
import { Badge } from "@/client/components/ui";
import { googleCalendarUrl, type CalendarEvent } from "@/client/arena3/gcal";
import { t } from "@/client/lib/i18n";

/** Staff see when a running class has fewer members than its minimum. It only warns. */
/**
 * Làm gì: Hiển thị huy hiệu (Badge) cảnh báo khi lớp học có số học viên đăng ký ít hơn sĩ số tối thiểu.
 * Giúp quản lý và huấn luyện viên nhanh chóng nhận biết lớp học có nguy cơ hủy hoặc cần gom thêm học viên.
 * Được gọi ở:
 * - src/routes/coach.index.tsx (thẻ ca dạy tiếp theo của huấn luyện viên)
 * - src/routes/manager.classes.tsx (danh sách lớp học của quản lý)
 * @param enrolled Số lượng học viên hiện đã đăng ký tham gia lớp.
 * @param min Sĩ số tối thiểu cần thiết để tổ chức lớp học (bỏ qua nếu không thiết lập).
 * @param status Trạng thái của lớp học (bỏ qua nếu lớp đã bị hủy: 'cancelled').
 * @returns Thẻ Badge cảnh báo tone 'hold' hiển thị số người còn thiếu, hoặc null nếu không cần cảnh báo.
 */
export function MinSizeBadge({ enrolled, min, status }: { enrolled: number; min?: number | null; status?: string }) {
  // Không hiển thị cảnh báo nếu lớp không yêu cầu sĩ số tối thiểu, đã đủ học viên, hoặc đã bị hủy.
  if (!min || enrolled >= min || status === "cancelled") return null;
  return (
    <Badge tone="hold" title={t("Minimum to run: {n}", { n: min })}>
      {t("Below minimum · {n} more needed", { n: min - enrolled })}
    </Badge>
  );
}

/** Opens Google Calendar with the event filled in, in a new tab. `onLime` sets it in the dark ink of a lime card. */
/**
 * Làm gì: Hiển thị nút liên kết mở Google Calendar trong tab mới với thông tin buổi tập đã điền sẵn.
 * Giúp học viên và huấn luyện viên thuận tiện lưu lịch tập vào ứng dụng lịch cá nhân mà không cần đồng bộ tài khoản.
 * Được gọi ở:
 * - src/routes/app.book.tsx (màn hình xác nhận đặt sân/lớp thành công)
 * - src/routes/app.index.tsx (màn hình chính học viên, thẻ lịch tập sắp tới)
 * - src/routes/app.train.tsx (trang lịch tập cá nhân của học viên)
 * - src/routes/coach.index.tsx (màn hình tổng quan HLV, thẻ ca dạy tiếp theo)
 * @param event Đối tượng CalendarEvent chứa thông tin sự kiện (tiêu đề, thời gian bắt đầu, kết thúc, địa điểm, mô tả).
 * @param className Tùy chọn class CSS bổ sung để căn chỉnh khoảng cách, vị trí bên ngoài.
 * @param onLime Cờ boolean; khi true sẽ dùng màu chữ tương phản cao text-accent-fg để nổi bật trên nền thẻ màu chanh (lime card).
 * @returns Thẻ <a> mở tab mới trỏ tới URL tạo sự kiện Google Calendar.
 */
export function AddToCalendar({ event, className, onLime = false }: { event: CalendarEvent; className?: string; onLime?: boolean }) {
  return (
    <a
      href={googleCalendarUrl(event)}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex min-h-9 items-center gap-1.5 text-xs font-medium underline-offset-2 hover:underline ${onLime ? "font-semibold text-accent-fg" : "text-accent-2"} ${className ?? ""}`}
    >
      <CalendarPlus className="size-4" aria-hidden />
      {t("Add to Google Calendar")}
    </a>
  );
}
