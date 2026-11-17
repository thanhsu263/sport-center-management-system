/**
 * An "Add to Google Calendar" link: Google's own event template, filled in.
 * Nothing is sent from here and no Google account is linked; the member's
 * browser opens Google Calendar with the event ready to save.
 */
export type CalendarEvent = {
  title: string;
  start: string | Date;
  end: string | Date;
  details?: string;
  location?: string;
};

// Google wants UTC in the basic form: 20261029T120000Z.
/**
 * Làm gì: Chuyển đổi mốc thời gian (Date hoặc chuỗi ngày tháng) sang định dạng UTC rút gọn chuẩn của Google Calendar (YYYYMMDDTHHmmssZ).
 * Được gọi ở: src/client/arena3/gcal.ts (trong hàm googleCalendarUrl).
 * @param at Thời điểm bắt đầu hoặc kết thúc sự kiện (chuỗi ISO hoặc đối tượng Date).
 * @returns Chuỗi timestamp định dạng UTC chuẩn YYYYMMDDTHHmmssZ (ví dụ: 20261029T120000Z).
 * @throws RangeError nếu giá trị thời gian không hợp lệ khi gọi toISOString.
 */
function utcStamp(at: string | Date): string {
  return new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/**
 * Làm gì: Tạo đường link URL mở trang tạo sự kiện của Google Calendar với các thông tin sự kiện được điền sẵn (tiêu đề, thời gian, mô tả, địa điểm).
 * Được gọi ở: src/client/components/class-extras.tsx (component AddToCalendar).
 * @param e Đối tượng CalendarEvent chứa thông tin sự kiện cần thêm vào lịch.
 * @returns Chuỗi URL trỏ đến giao diện thêm sự kiện của Google Calendar.
 */
export function googleCalendarUrl(e: CalendarEvent): string {
  // Bước 1: Khởi tạo các query params cơ bản (action: "TEMPLATE" để mở mẫu tạo sự kiện, text là tiêu đề, dates là dải thời gian UTC bắt đầu/kết thúc).
  const q = new URLSearchParams({
    action: "TEMPLATE",
    text: e.title,
    dates: `${utcStamp(e.start)}/${utcStamp(e.end)}`,
  });
  // Bước 2: Bổ sung thông tin mô tả chi tiết (details) và địa điểm (location) vào query params nếu có.
  if (e.details) q.set("details", e.details);
  if (e.location) q.set("location", e.location);
  // Bước 3: Ghép các tham số query vào URL render của Google Calendar và trả về liên kết hoàn chỉnh.
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}
