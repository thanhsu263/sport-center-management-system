/**
 * File: src/routes/manager.attendance.tsx
 * Vai trò: Định nghĩa route và component trang Quản lý điểm danh (/manager/attendance) dành cho vai trò Quản lý (Manager).
 * Vị trí trong app:
 * - Route URL /manager/attendance được quản lý bởi TanStack Router, nằm dưới route layout cha /manager (kiểm tra quyền manager).
 * - Được liên kết trực tiếp trên thanh điều hướng chính (dock menu) của vai trò manager (cấu hình tại src/shared/ui-config.ts).
 * - Cung cấp 2 bảng điều khiển chính từ src/client/components/attendance-panels.tsx:
 *   + AttendancePanel: Thống kê tỷ lệ điểm danh theo lớp, HLV, học viên kèm tính năng xuất file báo cáo (canExport).
 *   + AtRiskPanel: Cảnh báo danh sách học viên có nguy cơ bỏ tập và ghi nhận lịch sử liên hệ chăm sóc.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AtRiskPanel, AttendancePanel } from "@/client/components/attendance-panels";
import { Shell } from "@/client/components/shell";
import { Seg } from "@/client/components/ui";
import { t } from "@/client/lib/i18n";

/**
 * Làm gì: Định nghĩa route /manager/attendance trong TanStack Router, liên kết URL với component hiển thị Page.
 * Được gọi ở: URL /manager/attendance (TanStack Router quản lý; kích hoạt khi người dùng chọn mục Attendance trên thanh dock của manager).
 * @returns Đối tượng cấu hình route của TanStack Router cho đường dẫn /manager/attendance.
 */
export const Route = createFileRoute("/manager/attendance")({ component: Page });

/**
 * Làm gì: Component trang quản lý điểm danh của Manager, điều khiển chuyển đổi giữa tab tỷ lệ điểm danh và tab học viên có nguy cơ bỏ tập.
 * Được gọi ở: src/routes/manager.attendance.tsx (component của Route /manager/attendance).
 * @returns Element JSX hiển thị giao diện trang quản lý điểm danh bọc trong layout Shell.
 */
function Page() {
  // Bước 1: Khởi tạo state tab để lưu tab đang chọn, mặc định là "rate" (Tỷ lệ điểm danh).
  const [tab, setTab] = useState("rate");
  // Bước 2: Render giao diện trong khung Shell với bộ chuyển tab Seg; tab "rate" cho phép xuất báo cáo (canExport), tab "risk" hiển thị danh sách học viên có nguy cơ bỏ tập.
  return (
    <Shell
      role="manager"
      title={t("Attendance")}
      subtitle={t("How often members come, and who has stopped coming.")}
    >
      <div className="mb-4">
        <Seg
          value={tab}
          onChange={setTab}
          options={[
            { value: "rate", label: t("Attendance rate") },
            { value: "risk", label: t("At risk") },
          ]}
        />
      </div>
      {tab === "rate" ? <AttendancePanel canExport /> : <AtRiskPanel />}
    </Shell>
  );
}
