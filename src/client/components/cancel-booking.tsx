/**
 * File: src/client/components/cancel-booking.tsx
 * Vai trò: Hộp thoại (modal) xác nhận hủy lịch đặt sân dành cho hội viên và nhân viên tiếp tân.
 * Vị trí trong app: Tự động tải báo giá hủy (cancel-quote) để hiển thị minh bạch số tiền hoàn lại trước khi hủy; hỗ trợ nhân viên quầy miễn phí phạt (waive) kèm lý do khi trung tâm hủy lịch.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { money } from "@/client/components/shell";
import { Badge, Button, Check, Input, LoadError, Modal, Skeleton } from "@/client/components/ui";
import { apiGet, apiPost } from "@/client/arena3/client";
import type { CancelQuoteResponse as Quote } from "@/shared/arena3/contracts";
import { cn } from "@/client/lib/cn";
import { t, tServer } from "@/client/lib/i18n";
import { readError, type ReadError } from "@/client/lib/use-read";

/**
 * Cancel a court booking, with the price of doing it said out loud first.
 *
 * Members receive no refund. Staff can mark a centre cancellation with a reason;
 * the quoted refund is then owed in cash at the front desk.
 */
/**
 * Làm gì: Hiển thị hộp thoại (modal) xác nhận hủy lịch đặt sân, kèm báo giá hoàn tiền và chi phí hủy tính trước.
 *   Cho phép nhân viên tiếp tân (staff) chọn miễn phí hủy (waive) kèm lý do nếu lỗi do phía trung tâm.
 * Được gọi ở:
 *   - src/routes/app.book.tsx (màn hình đặt sân của hội viên / khách)
 *   - src/routes/app.index.tsx (trang chủ hội viên, danh sách lịch đặt sân sắp tới)
 *   - src/routes/desk.member.$id.tsx (trang chi tiết hội viên tại quầy tiếp tân)
 * @param bookingId Mã UUID của lịch đặt sân cần hủy (hoặc null khi modal đóng).
 * @param open Trạng thái mở/đóng của modal.
 * @param onClose Hàm callback khi người dùng đóng modal hoặc bấm giữ lại lịch.
 * @param onDone Hàm callback sau khi hủy thành công để màn hình cha tải lại dữ liệu.
 * @param staff Cờ xác định quyền nhân viên (mặc định false); khi bật sẽ cho phép miễn phí hủy.
 * @returns JSX.Element chứa Modal xác nhận hủy lịch.
 */
export function CancelBookingDialog({
  bookingId,
  open,
  onClose,
  onDone,
  staff = false,
}: {
  bookingId: string | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  staff?: boolean;
}) {
  // A quote is only good for the booking and the tick it was asked for; it stays on screen while the next one is on its way.
  // Bước 1: Khởi tạo các state quản lý dữ liệu báo giá, trạng thái tải và tùy chọn của nhân viên.
  const [asked, setAsked] = useState<{ booking: string; waive: boolean; quote: Quote } | null>(null);
  const [failure, setFailure] = useState<ReadError | null>(null);
  const [reason, setReason] = useState("");
  const [waive, setWaive] = useState(false);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);

  // Opening again starts from nothing: no old figures, no old tick.
  useEffect(() => {
    if (open) return;
    setAsked(null);
    setFailure(null);
    setWaive(false);
    setReason("");
  }, [open]);

  // Re-quotes when staff tick the waiver, so the figures on screen are the ones that will apply.
  // Bước 2: Tự động tải báo giá hủy từ server khi mở modal hoặc khi nhân viên thay đổi tùy chọn miễn phí phạt.
  useEffect(() => {
    if (!open || !bookingId) return;
    // Cờ live flag: chống race condition và ngăn cập nhật state nếu component đã unmount trước khi API trả về.
    let live = true;
    setFailure(null);
    // Gọi API lấy báo giá hủy: nếu là staff thì truyền cờ waive để server tính toán lại số tiền hoàn theo chính sách.
    apiGet<Quote>(`/bookings/${bookingId}/cancel-quote${staff ? `?waive=${waive ? 1 : 0}` : ""}`).then(
      (quote) => {
        if (live) setAsked({ booking: bookingId, waive, quote });
      },
      (e: unknown) => {
        if (live) setFailure(readError(e));
      },
    );
    // Dọn dẹp effect: đánh dấu live = false để hủy xử lý kết quả của request trước đó khi dependency thay đổi.
    return () => {
      live = false;
    };
  }, [open, bookingId, staff, waive, round]);

  // Bước 3: Kiểm tra tính hợp lệ của dữ liệu báo giá trước khi hiển thị.
  const current = asked && asked.booking === bookingId ? asked : null;
  const quote = current?.quote ?? null;
  // Cancelling is only offered against figures that match what is ticked right now.
  const fresh = current !== null && current.waive === waive && !failure;
  // Chỉ cho phép thử lại (tăng round) khi lỗi không phải do bị từ chối quyền (403 Forbidden).
  const retry = failure && !failure.refused ? () => setRound((n) => n + 1) : undefined;

  /**
   * Làm gì: Gửi yêu cầu hủy lịch đặt sân lên backend API (/bookings/:id/cancel), hiển thị thông báo và đóng modal.
   * Được gọi ở: Sự kiện onClick của nút "Yes, cancel" trong footer của Modal (dòng 97).
   * @returns Promise<void> Hoàn tất quy trình hủy lịch.
   */
  async function go() {
    // Bước 1: Kiểm tra an toàn: nếu không có bookingId hợp lệ thì dừng lại.
    if (!bookingId) return;
    // Bật cờ busy để khóa các nút bấm trên giao diện, ngăn người dùng click liên tục nhiều lần.
    setBusy(true);
    try {
      // Bước 2: Gửi request POST hủy lịch; nếu là nhân viên (staff) thì gửi kèm cờ miễn phạt (waive) và lý do (reason).
      await apiPost(`/bookings/${bookingId}/cancel`, staff ? { waive, reason } : {});
      // Bước 3: Thông báo hủy thành công và gọi callback onDone để màn hình cha tải lại dữ liệu mới nhất, sau đó đóng modal.
      toast.success(t("Booking cancelled"));
      onDone();
      onClose();
    } catch (e) {
      // Bước 4: Xử lý lỗi khi gọi API thất bại; dùng tServer để dịch thông điệp lỗi từ backend trả về.
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      // Bước 5: Luôn giải phóng trạng thái bận (busy = false) khi kết thúc request để mở lại các nút bấm.
      setBusy(false);
    }
  }


  // Bước 4: Render giao diện modal hiển thị chi tiết số tiền hoàn lại và các nút xác nhận.
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("Cancel this booking?")}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("Keep it")}
          </Button>
          <Button onClick={() => void go()} disabled={busy || !fresh || (staff && waive && !reason.trim())}>
            {busy ? t("Cancelling…") : t("Yes, cancel")}
          </Button>
        </>
      }
    >
      {!quote ? (
        failure ? (
          <LoadError message={failure.message} onRetry={retry} />
        ) : (
          <Skeleton className="h-28" />
        )
      ) : (
        <div className="grid gap-3 text-sm">
          {failure ? <LoadError message={failure.message} onRetry={retry} /> : null}
          <div
            aria-busy={!fresh && !failure}
            className={cn("grid gap-3 transition-opacity duration-150", !fresh && "opacity-60")}
          >
            {quote.paid_vnd === 0 ? (
              <p>{t("Nothing has been paid on this booking, so nothing is charged.")}</p>
            ) : quote.refund_vnd > 0 ? (
              <div className="rounded-[var(--radius-md)] bg-wood/60 p-3">
                <div className="flex items-center justify-between">
                  <span>{t("Refund")}</span>
                  <span className="font-display text-xl tabular-nums">{money(quote.refund_vnd)}</span>
                </div>
                <p>{t("Collect your refund in cash at the front desk.")}</p>
                {quote.waived ? <Badge tone="accent" className="mt-2">{t("Fee waived")}</Badge> : null}
              </div>
            ) : (
              <p className="rounded-[var(--radius-md)] bg-wood/60 p-3">
                {t("You paid {paid}. Cancelling gives no refund.", { paid: money(quote.paid_vnd) })}
              </p>
            )}
          </div>
          {staff && waive ? <Input aria-label={t("Reason")} placeholder={t("Reason")} value={reason} onChange={(e) => setReason(e.target.value)} /> : null}
          {staff ? (
            <Check
              checked={waive}
              onChange={(e) => setWaive(e.target.checked)}
              label={t("The centre is cancelling: refund in full")}
              hint={t("For cancellations that are not the customer's doing: centre closed, flood, accident.")}
            />
          ) : null}
        </div>
      )}
    </Modal>
  );
}
