/**
 * File: src/client/components/pay-online.tsx
 * Cung cấp nút bấm PayOnlineButton và modal thanh toán trực tuyến qua cổng payOS.
 * Thành phần này được dùng ở cả giao diện hội viên (đặt sân, mua gói, đăng ký lớp)
 * lẫn màn hình quầy lễ tân (desk), tự động xác nhận tiền về qua SSE và polling.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { toast } from "sonner";
import { Button, Modal } from "./ui";
import { money } from "./shell";
import { apiPost } from "@/client/arena3/client";
import { t, tServer } from "@/client/lib/i18n";
import { useLive } from "@/client/lib/use-live";

/**
 * Take an online payment through payOS.
 *
 * Built for the counter first, because that is how this centre actually works:
 * the customer is standing at the desk, reception raises the link, and the
 * customer scans the QR off reception's screen with their banking app. The same
 * component serves a member paying on their own phone — there the QR is beside
 * the point, so a "Open payment page" button is offered as well.
 *
 * Nothing here decides that money arrived. The dialog polls
 * `/payments/online/:id/verify`, which asks payOS, and only payOS's answer
 * posts the payment. Reception has no "received" button to press and no way to
 * mark this paid by hand — that is the whole difference between this and the
 * cash button beside it.
 */

type Raised = {
  payment_id: string;
  payment_code: string;
  order_code: number;
  amount_vnd: number;
  checkout_url: string;
  qr_code: string;
  expires_at: number | null;
  /** "desk" when reception raised it, "member" when the payer did. */
  raised_by?: "desk" | "member";
};

type Phase = "idle" | "raising" | "waiting" | "paid" | "failed";

/** How often to ask payOS. Fast enough to feel live at a counter queue. */
const POLL_MS = 3000;

/**
 * Làm gì: Nút bấm kích hoạt luồng thanh toán trực tuyến qua cổng payOS, hiển thị modal mã VietQR và link thanh toán.
 * Tự động đồng bộ trạng thái khi thanh toán thành công mà không cần nhân viên thao tác thủ công.
 * Được gọi ở:
 * - src/routes/app.book.tsx (đặt sân)
 * - src/routes/app.classes.tsx (đăng ký lớp học)
 * - src/routes/app.index.tsx (thanh toán đơn đặt sân ở trang chủ)
 * - src/routes/desk.member.$id.tsx (quản lý chi tiết hội viên tại quầy)
 * - src/routes/desk.payments.tsx (quản lý danh sách thanh toán quầy lễ tân)
 * @param refType Loại dịch vụ thanh toán ("booking" | "subscription" | "enrollment")
 * @param refId Mã định danh ID của dịch vụ cần thanh toán
 * @param label Nhãn chữ tùy chỉnh trên nút bấm (mặc định là "Pay online")
 * @param size Kích thước nút bấm ("sm" hoặc "md")
 * @param variant Kiểu nút bấm ("primary" | "outline" | "ghost")
 * @param onPaid Hàm gọi sau khi payOS xác nhận thanh toán thành công để reload dữ liệu
 * @returns JSX.Element nút bấm kèm modal thanh toán trực tuyến
 */
export function PayOnlineButton({
  refType,
  refId,
  label,
  size = "sm",
  variant = "outline",
  onPaid,
}: {
  refType: "booking" | "subscription" | "enrollment";
  refId: string;
  label?: string;
  size?: "sm" | "md";
  variant?: "primary" | "outline" | "ghost";
  /** Called once, after payOS confirms. Refresh the list from here. */
  onPaid?: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [raised, setRaised] = useState<Raised | null>(null);
  const [qrPng, setQrPng] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  /**
   * Làm gì: Dừng vòng lặp polling kiểm tra trạng thái thanh toán và dọn sạch timer ID.
   * Được gọi ở: Nội bộ PayOnlineButton (useEffect dọn dẹp, close, checkPayment khi có kết quả cuối).
   * @returns void
   */
  const stopPolling = useCallback(() => {
    if (timer.current !== null) {
      window.clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  // Dọn dẹp interval timer khi component unmount để tránh rò rỉ bộ nhớ
  useEffect(() => stopPolling, [stopPolling]);

  /**
   * Làm gì: Gửi yêu cầu khởi tạo giao dịch thanh toán payOS lên backend và chuyển mã VietQR thành ảnh PNG để hiển thị.
   * Được gọi ở: Sự kiện onClick của Button (dòng 154) trong PayOnlineButton.
   * @returns Promise<void>
   */
  async function raise() {
    // Bước 1: Khóa nút bấm sang trạng thái "raising" để ngăn người dùng click nhiều lần liên tiếp
    setPhase("raising");
    setNote(null);
    try {
      // Bước 2: Gọi API backend /payments/online tạo phiên thanh toán mới cho đơn tương ứng
      const res = await apiPost<Raised>("/payments/online", { ref_type: refType, ref_id: refId }, true);
      setRaised(res);
      // payOS hands back a VietQR payload string, not a picture. Rendering it
      // here keeps the payload out of the API response and off the network a
      // second time.
      // Bước 3: Render chuỗi VietQR nhận được thành ảnh DataURL PNG kích thước 512px để khách quét mã
      if (res.qr_code) {
        setQrPng(
          await QRCode.toDataURL(res.qr_code, {
            width: 512,
            margin: 1,
            errorCorrectionLevel: "M",
            color: { dark: "#141c12", light: "#fffaf2" },
          }),
        );
      }
      // Bước 4: Mở modal hiển thị mã QR và chuyển phase sang "waiting" để kích hoạt kiểm tra trạng thái
      setPhase("waiting");
    } catch (e) {
      // Khôi phục trạng thái về "idle" và hiển thị thông báo nếu tạo link thanh toán thất bại
      setPhase("idle");
      toast.error(e instanceof Error ? tServer(e.message) : t("Could not start the payment"));
    }
  }

  // Verify with payOS and update status
  /**
   * Làm gì: Truy vấn backend để đối soát trạng thái giao dịch thực tế từ payOS và cập nhật giao diện.
   * Được gọi ở: Nội bộ PayOnlineButton (khi có sự kiện SSE từ useLive hoặc định kỳ qua setInterval).
   * @returns Promise<void>
   */
  const checkPayment = useCallback(async () => {
    if (!raised) return;
    try {
      // Bước 1: Gọi endpoint verify để kiểm tra xem payOS đã xác nhận tiền vào tài khoản hay chưa
      const r = await apiPost<{ status: string; detail?: string }>(
        `/payments/online/${raised.payment_id}/verify`,
      );
      // Bước 2: Xử lý thành công (status "posted"): dừng polling, chuyển phase sang "paid" và gọi callback onPaid
      if (r.status === "posted") {
        stopPolling();
        setPhase("paid");
        onPaid?.();
      // Bước 3: Xử lý giao dịch hết hạn hoặc khách hủy: dừng polling, chuyển phase sang "failed" và hiển thị lý do
      } else if (r.status === "expired" || r.status === "failed") {
        stopPolling();
        setPhase("failed");
        setNote(r.status === "expired" ? t("The link expired.") : t("The customer cancelled."));
      // Bước 4: Xử lý khi khách hàng chuyển khoản thiếu số tiền yêu cầu (status "underpaid")
      } else if (r.status === "underpaid") {
        setNote(t("Not the full amount yet: {detail}", { detail: tServer(r.detail ?? "") }));
      }
    } catch {
      // A poll that fails is not a payment that failed; keep asking.
    }
  }, [raised, onPaid, stopPolling]);

  // Realtime SSE push triggers immediate verification
  useLive(phase === "waiting" && raised ? `payment:${raised.payment_id}` : null, () => {
    void checkPayment();
  });

  // Poll as fallback while the dialog is open and unpaid.
  useEffect(() => {
    if (phase !== "waiting" || !raised) return;
    // Cờ stopped bảo vệ tránh việc tick gọi checkPayment sau khi hook đã unmount
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      await checkPayment();
    };
    // Thiết lập interval kiểm tra định kỳ mỗi POLL_MS (3 giây) và gọi ngay một lần đầu tiên
    timer.current = window.setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => {
      stopped = true;
      stopPolling();
    };
  }, [phase, raised, checkPayment, stopPolling]);

  /**
   * Làm gì: Đóng modal thanh toán, hủy polling và đặt lại toàn bộ state về trạng thái ban đầu.
   * Được gọi ở: Thuộc tính onClose của Modal và sự kiện onClick của nút đóng modal (dòng 160, 163).
   * @returns void
   */
  function close() {
    // Dừng polling và xóa sạch dữ liệu thanh toán cũ
    stopPolling();
    setPhase("idle");
    setRaised(null);
    setQrPng(null);
    setNote(null);
  }

  return (
    <>
      <Button size={size} variant={variant} onClick={() => void raise()} disabled={phase === "raising"}>
        {phase === "raising" ? t("Starting…") : (label ?? t("Pay online"))}
      </Button>

      <Modal
        open={phase === "waiting" || phase === "paid" || phase === "failed"}
        onClose={close}
        title={phase === "paid" ? t("Paid") : phase === "failed" ? t("Not paid") : t("Scan to pay")}
        footer={
          <Button variant={phase === "paid" ? "primary" : "outline"} onClick={close}>
            {phase === "paid" ? t("Done") : t("Close")}
          </Button>
        }
      >
        {phase === "waiting" && raised ? (
          <div className="grid gap-3 text-center">
            {/*
              The same dialog serves the counter and a member's own phone, and
              the instruction is not the same in both. Reception is being told
              what to say to somebody standing in front of them; a member is
              being told what to do.
            */}
            <p className="text-sm text-muted">
              {raised.raised_by === "member"
                ? t("Scan this with your banking app, or open the payment page below.")
                : t("Ask the customer to scan this with their banking app.")}
            </p>
            {qrPng ? (
              <img
                src={qrPng}
                alt={t("Payment QR code")}
                className="mx-auto size-64 rounded-[var(--radius-md)] border border-line bg-surface"
              />
            ) : (
              <div className="mx-auto grid size-64 place-items-center rounded-[var(--radius-md)] border border-line text-sm text-muted">
                {t("No QR: use the payment page")}
              </div>
            )}
            <p className="font-display text-3xl tabular-nums">{money(raised.amount_vnd)}</p>
            <p className="text-2xs text-muted">{raised.payment_code}</p>
            <p className="text-sm text-muted">
              {raised.raised_by === "member"
                ? t("We are waiting for your bank. Do not pay twice: this confirms by itself.")
                : t("Waiting for the bank to confirm. This posts by itself. There is nothing to press.")}
            </p>
            {note ? <p className="text-sm text-hold">{note}</p> : null}
            <a
              href={raised.checkout_url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-sm underline underline-offset-4"
            >
              {t("Open the payment page instead")}
            </a>
          </div>
        ) : null}

        {phase === "paid" && raised ? (
          <div className="grid gap-2 text-center">
            <p className="font-display text-3xl tabular-nums">{money(raised.amount_vnd)}</p>
            <p className="text-sm text-muted">
              {raised.raised_by === "member"
                ? t("Paid. Your court is confirmed and the receipt is in your account.")
                : t("Confirmed by payOS and posted automatically. The receipt is on the member’s account.")}
            </p>
          </div>
        ) : null}

        {phase === "failed" ? (
          <div className="grid gap-2 text-center">
            <p className="text-sm">{note ?? t("The payment did not go through.")}</p>
            <p className="text-sm text-muted">{t("Nothing was taken. Try again, or take payment at the till.")}</p>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
