/**
 * File: src/client/components/till-notice.tsx
 * Vai trò: Kiểm tra trạng thái ca thu ngân (till shift) và hiển thị cảnh báo yêu cầu tiếp tân mở ca trước khi thu tiền.
 * Vị trí trong app: Cung cấp hook useTillOpen và component TillNotice cho giao diện quầy lễ tân (như src/routes/desk.series.tsx), ngăn tiếp tân nhận thanh toán khi chưa mở ca trực.
 */
import { useEffect, useState } from "react";
import { ButtonLink, Card } from "@/client/components/ui";
import { apiGet } from "@/client/arena3/client";
import { t } from "@/client/lib/i18n";

/**
 * Whether this person can take money right now. A receptionist can only post a payment while their
 * own till shift is open; a manager is never held to that. While the answer is on its way, or if it
 * cannot be read, this says yes: the server enforces the rule either way, and a screen that greys
 * out on a slow network is worse than one that now and then shows the server's refusal.
 */
/**
 * Làm gì: Hook kiểm tra xem nhân viên tiếp tân hiện tại đã mở ca thu ngân (till shift) để nhận tiền hay chưa.
 * Được gọi ở: src/routes/desk.series.tsx (trang quản lý đặt lịch cố định hàng tuần tại quầy lễ tân).
 * @param isReceptionist Cờ boolean xác định người dùng hiện tại có vai trò tiếp tân (receptionist) hay không.
 * @returns boolean Trả về true nếu ca thu ngân đang mở (hoặc là manager, hoặc đang tải/lỗi mạng); false nếu tiếp tân chưa mở ca.
 * @throws Không ném lỗi (bắt lỗi ngầm và giữ nguyên trạng thái true để tránh chặn nhầm giao diện).
 */
export function useTillOpen(isReceptionist: boolean): boolean {
  // Bước 1: Khởi tạo mặc định ca thu ngân đang mở (true) theo cơ chế lạc quan (optimistic)
  // Giúp giao diện không bị khóa khi mạng chậm; server vẫn luôn kiểm tra và từ chối nếu không hợp lệ lúc gửi thanh toán
  const [open, setOpen] = useState(true);
  // Bước 2: Kích hoạt effect kiểm tra ca trực hiện tại từ backend khi người dùng mang vai trò tiếp tân
  useEffect(() => {
    // Quản lý (manager) luôn có quyền thu tiền mọi lúc mà không cần mở ca thu ngân, chỉ tiếp tân mới cần mở ca
    if (!isReceptionist) return;
    // Cờ live đánh dấu component còn mounted, tránh gọi setOpen gây rò rỉ bộ nhớ (memory leak) sau khi unmount
    let live = true;
    // Gọi API lấy ca trực với background: true để chạy ngầm và không hiển thị loading spinner toàn màn hình
    void apiGet<{ shift: unknown }>("/shifts/current?optional=1", { background: true })
      .then((r) => {
        if (live) setOpen(!!r.shift);
      })
      .catch(() => undefined);
    // Hủy hiệu lực effect khi unmount hoặc khi vai trò người dùng thay đổi
    return () => {
      live = false;
    };
  }, [isReceptionist]);
  // Bước 3: Trả về trạng thái ca thu ngân (true: được phép thu tiền, false: chưa mở ca)
  return open;
}

/** Why the pay button is off, and the one place that fixes it: the till is opened on the desk home. */
/**
 * Làm gì: Hiển thị khối thông báo nhắc nhở tiếp tân mở ca thu ngân trước khi thu tiền, kèm nút chuyển hướng về trang quầy (/desk).
 * Được gọi ở: src/routes/desk.series.tsx (hiển thị khi tillOpen = false trong trang đặt lịch cố định hàng tuần).
 * @returns JSX.Element Thẻ Card chứa lời nhắc mở ca trực và nút liên kết chuyển hướng.
 * @throws Không ném lỗi.
 */
export function TillNotice() {
  // Render thẻ Card viền màu hổ phách (hold) với thông điệp nhắc nhở và nút dẫn về /desk để mở ca trực
  return (
    <Card className="mb-4 flex flex-wrap items-center justify-between gap-3 border border-hold/30 bg-hold/5 p-4">
      <p className="text-sm">{t("Open your cash shift first. Payments can’t be taken without one.")}</p>
      <ButtonLink to="/desk" variant="outline" size="sm">
        {t("Open shift at the front desk")}
      </ButtonLink>
    </Card>
  );
}
