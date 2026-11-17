/**
 * Dịch vụ xử lý quy tắc lặp lịch (recurrence rule - rrule) cho các lớp học (classes).
 * Phân tích cú pháp chuỗi cấu hình lặp hàng tuần (subset iCalendar dạng FREQ=WEEKLY...) và mở rộng thành danh sách các ca học cụ thể (thời điểm bắt đầu, kết thúc) theo múi giờ ICT.
 * Được dùng để sinh lịch học tự động cho các lớp học (materialize sessions) và tính tổng số buổi của lớp khi hủy hoặc hoàn tiền.
 */
import { addDays, ictDateString, ictDateTime, ictWeekday } from "../../shared/arena3/time";

// Bảng ánh xạ mã thứ viết tắt chuẩn iCalendar (SU..SA) sang số thứ tự trong tuần (0: Chủ Nhật .. 6: Thứ Bảy) khớp với quy ước của ictWeekday.
const DAY_MAP: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

/**
 * Làm gì: Phân tích cú pháp chuỗi quy tắc lặp rrule dạng "key=value;..." thành object chứa các cặp khóa - giá trị để tiện tra cứu cấu hình lặp.
 * Được gọi ở: src/server/services/rrule.ts trong hàm expandWeekly.
 * @param rrule Chuỗi quy tắc lặp theo chuẩn rút gọn iCalendar (ví dụ: "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=18").
 * @returns Object chứa các cặp khóa và giá trị cấu hình tương ứng.
 * @throws Không chủ động ném lỗi.
 */
function parseWeeklyRule(rrule: string) {
  return Object.fromEntries(
    rrule.split(";").map((part) => {
      const [key, value] = part.split("=");
      return [key ?? "", value ?? ""];
    }),
  );
}

/** Subset: FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=18 */
/**
 * Làm gì: Mở rộng quy tắc lặp rrule hàng tuần thành danh sách các ca học cụ thể (thời điểm bắt đầu và kết thúc) trong khoảng thời gian từ from đến until.
 * Được gọi ở: src/server/controllers/handlers/classes.ts (expandClassSessionDates khi sinh lịch 14 ngày tới, và cancelSession khi tính tổng số buổi của lớp).
 * @param rrule Chuỗi quy tắc lặp hàng tuần theo chuẩn rút gọn iCalendar (chứa FREQ=WEEKLY, BYDAY, BYHOUR).
 * @param durationMin Thời lượng mỗi ca học tính bằng phút.
 * @param from Thời điểm bắt đầu của khoảng thời gian cần mở rộng lịch.
 * @param until Thời điểm kết thúc của khoảng thời gian cần mở rộng lịch.
 * @returns Mảng các ca học gồm thời điểm bắt đầu (start) và thời điểm kết thúc (end).
 * @throws Không chủ động ném lỗi; trả về mảng rỗng nếu FREQ khác "WEEKLY".
 */
export function expandWeekly(
  rrule: string,
  durationMin: number,
  from: Date,
  until: Date,
): { start: Date; end: Date }[] {
  // Bước 1: Phân tích cú pháp chuỗi rrule thành object và kiểm tra tần suất lặp. Chỉ hỗ trợ lặp hàng tuần (WEEKLY).
  const parts = parseWeeklyRule(rrule);
  if ((parts.FREQ ?? "WEEKLY") !== "WEEKLY") return [];
  // Bước 2: Tách danh sách các ngày trong tuần (BYDAY) và chuyển thành mảng số thứ tự (0: Chủ Nhật .. 6: Thứ Bảy).
  const days = (parts.BYDAY ?? "")
    .split(",")
    .map((d) => DAY_MAP[d.trim()])
    .filter((n): n is number => n !== undefined);
  // Bước 3: Xác định giờ bắt đầu ca học (mặc định 18:00 nếu thiếu) và đổi thời lượng (phút) sang mili-giây để tiện tính giờ kết thúc.
  const hour = Number(parts.BYHOUR ?? 18);
  const startTime = `${String(hour).padStart(2, "0")}:00`;
  const durationMs = durationMin * 60_000;
  // Bước 4: Duyệt từng ngày từ from đến until theo múi giờ ICT, tạo các ca học thỏa mãn điều kiện thứ và nằm trong khoảng thời gian yêu cầu.
  const sessions: { start: Date; end: Date }[] = [];
  let cursor = ictDateString(from);
  const endDate = ictDateString(until);
  while (cursor <= endDate) {
    const start = ictDateTime(cursor, startTime);
    const weekday = ictWeekday(start);
    // Chỉ lưu ca học nếu rơi vào đúng thứ quy định và thời điểm bắt đầu nằm trong nửa khoảng [from, until).
    if (days.includes(weekday) && start >= from && start < until) {
      sessions.push({ start, end: new Date(start.getTime() + durationMs) });
    }
    cursor = addDays(cursor, 1);
  }
  // Bước 5: Trả về danh sách tất cả các ca học đã mở rộng thỏa mãn quy tắc lặp.
  return sessions;
}
