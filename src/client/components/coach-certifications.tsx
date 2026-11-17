/**
 * File: src/client/components/coach-certifications.tsx
 * Vai trò: Quản lý danh sách và thao tác thêm/xóa chứng chỉ chuyên môn của huấn luyện viên.
 * Vị trí trong app: Hiển thị dạng modal trên trang cá nhân HLV (src/routes/coach.index.tsx) và trang quản lý nhân sự của Quản lý (src/routes/manager.staff.tsx).
 */
import { useState } from "react";
import { Award, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge, Button, DateField, Field, Input, Modal, Skeleton } from "@/client/components/ui";
import { ApiClientError, apiDelete, apiPost } from "@/client/arena3/client";
import { formatDate } from "@/shared/arena3/labels";
import { t, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";

// Cấu trúc dữ liệu chứng chỉ của huấn luyện viên trả về từ API backend /coaches/:id/certifications.
export type Certification = {
  id: string;
  coach_id: string;
  name: string;
  issuer: string | null;
  issued_on: string | null;
  expires_on: string | null;
  expired?: boolean;
};

/** One line under a certification: who issued it and until when it holds. */
/**
 * Làm gì: Định dạng dòng thông tin tóm tắt của chứng chỉ gồm đơn vị cấp, ngày cấp và ngày hết hạn, nối với nhau bằng dấu chấm giữa ( · ).
 * Được gọi ở:
 *   - src/client/components/coach-certifications.tsx (danh sách chứng chỉ trong CertificationsModal)
 *   - src/client/components/landing/coaches.tsx (danh thiếp HLV trên landing page)
 * @param c Đối tượng chứng chỉ chứa thông tin issuer, issued_on, expires_on.
 * @returns Chuỗi văn bản tóm tắt thông tin chứng chỉ hoặc chuỗi rỗng nếu không có dữ liệu.
 */
export function certificationLine(c: Certification) {
  const parts: string[] = [];
  // Gom các thông tin hiện có: đơn vị cấp, ngày cấp và thời hạn hiệu lực.
  if (c.issuer) parts.push(c.issuer);
  if (c.issued_on) parts.push(formatDate(c.issued_on));
  if (c.expires_on) parts.push(t("valid until {date}", { date: formatDate(c.expires_on) }));
  return parts.join(" · ");
}

// Giá trị mặc định rỗng cho form nhập thông tin chứng chỉ mới.
const EMPTY = { name: "", issuer: "", issued_on: "", expires_on: "" };

/** A coach's certifications: the list, adding one, removing one. For the manager or the coach. */
/**
 * Làm gì: Modal hiển thị danh sách chứng chỉ chuyên môn của huấn luyện viên, hỗ trợ thêm chứng chỉ mới và xóa chứng chỉ hiện có.
 * Được gọi ở:
 *   - src/routes/coach.index.tsx (màn hình cá nhân của huấn luyện viên tại /coach)
 *   - src/routes/manager.staff.tsx (màn hình quản lý nhân sự tại /manager/staff)
 * @param coachId Mã UUID của HLV cần quản lý chứng chỉ (hoặc null nếu modal đang đóng).
 * @param coachName Tên huấn luyện viên hiển thị trên tiêu đề modal.
 * @param onClose Callback kích hoạt khi người dùng bấm hoàn tất hoặc đóng modal.
 * @returns JSX.Element chứa Modal quản lý chứng chỉ HLV.
 */
export function CertificationsModal({
  coachId,
  coachName,
  onClose,
}: {
  coachId: string | null;
  coachName: string;
  onClose: () => void;
}) {
  // Bước 1: Khởi tạo hook tải danh sách chứng chỉ từ API backend và các state quản lý form thêm mới.
  const read = useRead<{ items: Certification[] }>(coachId ? `/coaches/${coachId}/certifications` : null);
  // Dữ liệu người dùng nhập trong form thêm chứng chỉ (tên, đơn vị cấp, ngày cấp, ngày hết hạn).
  const [f, setF] = useState(EMPTY);
  // Lỗi validation trả về từ server để hiển thị gợi ý (hint) ngay dưới từng ô nhập liệu tương ứng.
  const [fe, setFe] = useState<{ field?: string; message: string } | null>(null);
  // Trạng thái đang gửi request thêm chứng chỉ để vô hiệu hóa nút bấm, tránh submit trùng lặp.
  const [busy, setBusy] = useState(false);

  /**
   * Làm gì: Gửi yêu cầu thêm chứng chỉ mới cho HLV qua API POST /coaches/:coachId/certifications, làm mới danh sách và xóa trắng form.
   * Được gọi ở: Sự kiện onClick của nút "Add" trong form thêm chứng chỉ (dòng 153).
   * @returns Promise không trả về giá trị (void).
   */
  async function add() {
    // Bước 1: Kiểm tra điều kiện an toàn; nếu không có coachId thì dừng lại ngay.
    if (!coachId) return;
    // Khóa nút bấm và xóa các thông báo lỗi cũ trước khi gửi request.
    setBusy(true);
    setFe(null);
    try {
      // Bước 2: Gọi API lưu chứng chỉ mới vào cơ sở dữ liệu; nếu thành công thì reset form, báo toast và tải lại danh sách.
      await apiPost(`/coaches/${coachId}/certifications`, f);
      setF(EMPTY);
      toast.success(t("Certification added"));
      read.reload();
    // Bước 3: Bắt lỗi trả về từ server; trích xuất lỗi theo từng ô nhập hoặc lỗi chung để hiển thị lên form.
    } catch (e) {
      setFe({
        field: e instanceof ApiClientError ? e.body.field : undefined,
        message: e instanceof Error ? tServer(e.message) : t("Something went wrong"),
      });
    // Luôn mở lại trạng thái nút bấm sau khi hoàn tất request (dù thành công hay thất bại).
    } finally {
      setBusy(false);
    }
  }

  /**
   * Làm gì: Xóa một chứng chỉ của huấn luyện viên qua API DELETE /certifications/:id và cập nhật lại danh sách hiển thị.
   * Được gọi ở: Sự kiện onClick của nút icon thùng rác (Trash2) ở từng dòng chứng chỉ (dòng 116).
   * @param c Đối tượng chứng chỉ cần xóa.
   * @returns Promise không trả về giá trị (void).
   */
  async function remove(c: Certification) {
    // Bước 1: Gửi request DELETE tới server để xóa bản ghi chứng chỉ khỏi hệ thống.
    try {
      await apiDelete(`/certifications/${c.id}`);
      // Bước 2: Thông báo thành công và kích hoạt reload để đồng bộ lại danh sách chứng chỉ mới nhất.
      toast.success(t("Certification removed"));
      read.reload();
    // Bước 3: Nếu xảy ra lỗi (mạng hoặc quyền hạn), hiển thị thông báo lỗi bằng toast.
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    }
  }

  // Trợ hàm trích xuất câu thông báo lỗi cho một trường cụ thể để truyền vào prop hint của Field.
  const hint = (field: string) => (fe?.field === field ? fe.message : undefined);
  // Trích xuất mảng danh sách chứng chỉ đã tải về từ kết quả useRead.
  const items = read.data?.items;

  // Bước 2: Render giao diện modal gồm danh sách chứng chỉ hiện có và form nhập thông tin để thêm chứng chỉ mới.
  return (
    <Modal
      open={!!coachId}
      onClose={onClose}
      title={t("Certifications · {name}", { name: coachName })}
      footer={
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            {t("Done")}
          </Button>
        </div>
      }
    >
      <div className="grid gap-4">
        {read.error ? (
          <p className="text-sm text-danger">{read.error.message}</p>
        ) : !items ? (
          <Skeleton className="h-16" />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted">{t("No certifications yet.")}</p>
        ) : (
          <ul className="grid gap-2">
            {items.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-3 rounded-lg border border-line p-3">
                <div className="flex min-w-0 gap-2.5">
                  <Award className="mt-0.5 size-4 shrink-0 text-accent-2" aria-hidden />
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {c.name}
                      {c.expired ? <Badge tone="danger">{t("Expired")}</Badge> : null}
                    </p>
                    {certificationLine(c) ? <p className="text-xs text-muted">{certificationLine(c)}</p> : null}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("Remove {name}", { name: c.name })}
                  onClick={() => void remove(c)}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-3 border-t border-line pt-4">
          <p className="text-sm font-medium">{t("Add a certification")}</p>
          <Field label={t("Name")} hint={hint("name")}>
            <Input
              value={f.name}
              maxLength={120}
              placeholder={t("e.g. BWF Level 1 Coach")}
              onChange={(e) => setF({ ...f, name: e.target.value })}
            />
          </Field>
          <Field label={t("Issued by")} hint={hint("issuer")}>
            <Input value={f.issuer} maxLength={120} onChange={(e) => setF({ ...f, issuer: e.target.value })} />
          </Field>
          <div className="grid items-start gap-3 sm:grid-cols-2">
            <Field label={t("Issued on")} hint={hint("issued_on")}>
              <DateField value={f.issued_on} onChange={(v) => setF({ ...f, issued_on: v })} invalid={!!hint("issued_on")} />
            </Field>
            <Field label={t("Expires on")} hint={hint("expires_on") ?? t("Leave empty if it does not expire.")} tone={hint("expires_on") ? "danger" : "muted"}>
              <DateField
                value={f.expires_on}
                min={f.issued_on || undefined}
                onChange={(v) => setF({ ...f, expires_on: v })}
                invalid={!!hint("expires_on")}
              />
            </Field>
          </div>
          {fe && !fe.field ? <p className="text-sm text-danger">{fe.message}</p> : null}
          <div className="flex justify-end">
            <Button disabled={busy || !f.name.trim()} onClick={() => void add()}>
              {t("Add")}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
