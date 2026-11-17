/**
 * File: src/client/components/member-certificates.tsx
 * Vai trò: Hiển thị danh sách chứng nhận hoàn thành khoá học của hội viên và tiến độ tham gia các lớp học.
 * Vị trí trong app: Được nhúng trong trang luyện tập của hội viên (/app/train - src/routes/app.train.tsx); tải dữ liệu từ API /me/certificates và liên kết tới trang xác minh chứng chỉ công khai /verify/:code.
 */
import { useState } from "react";
import { Award } from "lucide-react";
import { toast } from "sonner";
import { Badge, Button, ButtonAnchor, Card } from "@/client/components/ui";
import { SectionTitle } from "@/client/components/section";
import { apiPost } from "@/client/arena3/client";
import { formatDate, levelLabel, sportLabel } from "@/shared/arena3/labels";
import { t, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";

// Kiểu dữ liệu phản hồi từ API ghi nhận tiến độ tham gia lớp học và điều kiện cấp chứng chỉ của hội viên.
type Completion = {
  enrollment_id: string;
  sport: string;
  level: string;
  coach_name: string;
  start_on: string;
  end_on: string;
  sessions: number;
  attended: number;
  remaining: number;
  code: string | null;
  eligible: boolean;
};

/**
 * A member's completion certificates: one per finished class they attended enough of.
 * Classes still running show how far along the member is, so the bar is known before it ends.
 */
/**
 * Làm gì: Hiển thị phần chứng nhận hoàn thành khoá học của hội viên, tính toán tỷ lệ tham dự và cung cấp nút nhận/xem chứng chỉ số.
 * Được gọi ở: src/routes/app.train.tsx (component Page tại URL /app/train).
 * @returns Thẻ JSX <section> chứa danh sách chứng chỉ và tiến độ lớp học, hoặc null nếu hội viên chưa đăng ký lớp nào.
 */
export function CertificatesSection() {
  // Bước 1: Tải danh sách lớp học của hội viên cùng tiến độ tham dự và tỷ lệ chuyên cần yêu cầu từ API /me/certificates.
  const read = useRead<{ share: number; items: Completion[] }>("/me/certificates");
  // State lưu enrollment_id đang xử lý cấp chứng chỉ nhằm vô hiệu hóa nút bấm, tránh gửi yêu cầu trùng lặp.
  const [busy, setBusy] = useState<string | null>(null);
  const items = read.data?.items ?? [];
  // Bước 2: Nếu hội viên chưa từng đăng ký lớp học nào, ẩn hoàn toàn khu vực chứng nhận để giao diện gọn gàng.
  if (!items.length) return null;
  // Quy đổi tỷ lệ chuyên cần tối thiểu (mặc định 0.8 tức 80% nếu server chưa cấu hình share) thành số phần trăm nguyên để hiển thị.
  const pct = Math.round((read.data?.share ?? 0.8) * 100);

  /**
   * Làm gì: Gửi yêu cầu cấp chứng nhận hoàn thành khoá học lên server, làm mới dữ liệu và mở trang xác thực chứng chỉ trong tab mới.
   * Được gọi ở: src/client/components/member-certificates.tsx (trong sự kiện onClick của nút "Get certificate").
   * @param c Đối tượng khoá học (Completion) cần yêu cầu cấp chứng chỉ.
   * @returns Không trả về giá trị (thông báo kết quả hoặc lỗi qua toast).
   */
  async function claim(c: Completion) {
    // Bước 1: Đánh dấu enrollment_id đang được xử lý để vô hiệu hóa nút bấm tương ứng, tránh double click.
    setBusy(c.enrollment_id);
    try {
      // Bước 2: Gọi API POST /me/certificates/:enrollment_id để cấp chứng nhận, lưu vào database và nhận về mã code xác thực.
      const r = await apiPost<{ code: string }>(`/me/certificates/${c.enrollment_id}`);
      toast.success(t("Certificate issued"));
      // Bước 3: Tải lại danh sách chứng chỉ để cập nhật trạng thái có mã code và mở trang xác thực /verify/:code trong tab mới.
      read.reload();
      window.open(`/verify/${r.code}`, "_blank", "noopener");
    } catch (e) {
      // Bước 4: Bắt lỗi nếu chưa đủ điều kiện nhận chứng chỉ hoặc lỗi mạng, hiển thị thông báo lỗi đã dịch qua toast.
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      // Bước 5: Giải phóng trạng thái bận dù thành công hay thất bại để khôi phục hoạt động của nút bấm.
      setBusy(null);
    }
  }

  // Bước 3: Render giao diện khu vực chứng nhận gồm tiêu đề, quy định chuyên cần và các thẻ lớp học.
  return (
    <section>
      <SectionTitle text={t("Certificates")} className="font-display text-2xl" />
      <p className="mt-1 text-sm text-muted">
        {t("Attend at least {pct}% of a class's sessions to earn its certificate when it ends.", { pct })}
      </p>
      <div className="mt-3 grid gap-2">
        {items.map((c) => {
          // Khoá học đã kết thúc khi không còn buổi học nào còn lại (remaining === 0).
          const done = c.remaining === 0;
          return (
            <Card key={c.enrollment_id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="flex min-w-0 gap-3">
                <Award className={c.eligible || c.code ? "mt-0.5 size-5 shrink-0 text-accent-2" : "mt-0.5 size-5 shrink-0 text-muted"} aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {sportLabel(c.sport)} · {levelLabel(c.level)}
                  </p>
                  <p className="text-xs text-muted">
                    {formatDate(c.start_on)} – {formatDate(c.end_on)} · {c.coach_name}
                  </p>
                  <p className="mt-1 text-xs tabular-nums text-muted">
                    {t("Attended {a} of {n} sessions", { a: c.attended, n: c.sessions })}
                    {!done ? ` · ${t("{n} still to come", { n: c.remaining })}` : ""}
                  </p>
                </div>
              </div>
              {c.code ? (
                <ButtonAnchor size="sm" variant="outline" href={`/verify/${c.code}`} target="_blank" rel="noopener">
                  {t("View certificate")}
                </ButtonAnchor>
              ) : c.eligible ? (
                <Button size="sm" disabled={busy === c.enrollment_id} onClick={() => void claim(c)}>
                  {t("Get certificate")}
                </Button>
              ) : done ? (
                <Badge tone="muted">{t("Below {pct}% attendance", { pct })}</Badge>
              ) : (
                <Badge tone="muted">{t("Class still running")}</Badge>
              )}
            </Card>
          );
        })}
      </div>
    </section>
  );
}
