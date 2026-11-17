/**
 * File: src/client/lib/use-centre.ts
 * Vai trò: Cung cấp các React hook để lấy thông tin cấu hình giao diện và vận hành trung tâm thể thao.
 * Vị trí trong app: Chạy ở client, gọi API public /flags để lấy thông tin venue (giờ mở/đóng cửa, thời gian giữ chỗ) và uiConfig (danh sách menu điều hướng nav, giới hạn danh sách limits). Lưu cache vào bộ nhớ tab để tránh giật nháy giao diện khi chuyển trang.
 */
import { useMemo } from "react";
import { uiConfigFrom, type UiConfig } from "@/shared/ui-config";
import { venueFrom, type Venue, type VenueRaw } from "@/client/lib/venue";
import { useRead } from "@/client/lib/use-read";

/*
 * The last answer, kept for the life of the tab. Moving between screens mounts the shell again,
 * and drawing the shipped menu until `/flags` answers would make a menu the manager changed jump
 * back and forth on every click.
 */
let last: { ui: UiConfig; venue: Venue } | null = null;

/**
 * The centre's menus, list lengths and opening hours as the manager set them, from the public
 * `/flags` read. Until it answers (or if it fails) the shipped defaults stand in.
 */
/**
 * Làm gì: Lấy cấu hình menu điều hướng, giới hạn danh sách (ui) và thông tin vận hành trung tâm (venue) từ endpoint GET /flags. Sử dụng cache bộ nhớ tab để tránh giật nháy menu khi chuyển trang.
 * Được gọi ở: src/client/components/shell.tsx (Shell), src/routes/manager.classes.tsx (ManagerClassesPage), và nội bộ hook useLimits.
 * @returns Đối tượng chứa ui (cấu hình UiConfig gồm nav và limits) và venue (thông tin Venue gồm open, close, holdMinutes).
 */
export function useCentre(): { ui: UiConfig; venue: Venue } {
  // Bước 1: Gửi yêu cầu đọc dữ liệu cấu hình trung tâm từ endpoint public /flags
  const { data } = useRead<{ ui?: unknown; venue?: VenueRaw }>("/flags");
  // Bước 2: Dùng useMemo ghi nhớ kết quả, tránh tính toán lại và giữ tham chiếu khi component re-render
  return useMemo(() => {
    // Khi chưa có data: dùng lại cache cũ để tránh giật giao diện, hoặc fallback về giá trị mặc định
    if (!data) return last ?? { ui: uiConfigFrom(null), venue: venueFrom(null) };
    // Khi có data: chuẩn hóa dữ liệu từ server, cập nhật biến cache last cho các màn hình tiếp theo
    last = { ui: uiConfigFrom(data.ui), venue: venueFrom(data.venue) };
    return last;
  }, [data]);
}

/** Just the list lengths. */
/**
 * Làm gì: Lấy nhanh cấu hình giới hạn số lượng phần tử hiển thị (limits) cho các danh sách và bảng trong ứng dụng từ useCentre.
 * Được gọi ở: src/client/components/landing/coaches.tsx (LandingCoaches), src/client/components/report-panels.tsx (ReportPanels), src/client/lib/pages/app.book.ts (useBookingState), src/routes/app.index.tsx (/app), src/routes/coach.index.tsx (/coach), src/routes/desk.index.tsx (/desk).
 * @returns Đối tượng limits chứa các giá trị giới hạn số lượng hiển thị (member_free_hours, desk_checkins, coach_below_min...).
 */
export const useLimits = () => useCentre().ui.limits;
