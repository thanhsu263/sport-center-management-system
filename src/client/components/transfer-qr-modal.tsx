/**
 * File: src/client/components/transfer-qr-modal.tsx
 * Vai trò: Cung cấp các modal và component hiển thị mã QR chuyển khoản ngân hàng (VietQR và payOS).
 * Vị trí trong app: Phục vụ thanh toán chuyển khoản ở cả giao diện hội viên (đặt sân app.book.tsx) và nhân viên lễ tân (quầy thu ngân desk.payments.tsx, desk.member.$id.tsx), tự động chuẩn hóa mã VietQR theo chuẩn NAPAS hoặc tích hợp payOS.
 */
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button, Modal } from "./ui";
import { money } from "./shell";
import { apiPost } from "@/client/arena3/client";
import { t, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";
import { transferReference, vietQrPayload } from "@/shared/vietqr";

/** The centre's account as `/v1/bank-transfer` answers it. */
export type CentreBank = {
  configured: boolean;
  bin?: string;
  account_no?: string;
  account_name?: string;
  bank_name?: string;
};

/** The centre's bank account, or `configured: false` until the deploy sets BANK_* (see .env.example). */
/**
 * Làm gì: Hook truy vấn thông tin tài khoản ngân hàng của trung tâm từ API backend để phục vụ thanh toán chuyển khoản.
 * Được gọi ở: src/client/components/transfer-qr-modal.tsx (component TransferQrModal).
 * @returns Đối tượng chứa dữ liệu tài khoản ngân hàng trung tâm (bank) và thông tin lỗi nếu có (error).
 */
export function useCentreBank() {
  // Bước 1: Gửi yêu cầu GET đến endpoint /bank-transfer để lấy thông tin cấu hình tài khoản ngân hàng của trung tâm
  const read = useRead<CentreBank>("/bank-transfer");
  // Bước 2: Trả về thông tin tài khoản và đối tượng lỗi để component kiểm tra trạng thái configured
  return { bank: read.data, error: read.error };
}

// Cấu hình thông số render mã QR: kích thước 512px, mức sửa lỗi M (15%), viền 1 ô, màu xanh đen trên nền trắng
const QR_STYLE = { width: 512, margin: 1, errorCorrectionLevel: "M" as const, color: { dark: "#141c12", light: "#ffffff" } };

/**
 * Làm gì: Sao chép văn bản vào clipboard của người dùng và hiển thị thông báo toast thành công hoặc hướng dẫn sao chép thủ công khi bị lỗi.
 * Được gọi ở: src/client/components/transfer-qr-modal.tsx (các nút CopyButton trong VietQrPanel).
 * @param text Chuỗi văn bản cần sao chép (số tài khoản, nội dung chuyển khoản).
 * @param what Tên mục đang sao chép để hiển thị trong thông báo toast (ví dụ: "Account number", "Transfer reference").
 * @returns Promise<void>
 */
async function copy(text: string, what: string) {
  // Bước 1: Ghi văn bản vào bộ nhớ tạm (clipboard) của trình duyệt
  try {
    await navigator.clipboard.writeText(text);
    // Bước 2: Hiển thị toast thông báo đã sao chép thành công
    toast.success(t("{what} copied", { what }));
  // Bước 3: Fallback khi trình duyệt không cho phép truy cập clipboard; hướng dẫn người dùng bôi đen tự copy
  } catch {
    toast.error(t("Could not copy. Select the text and copy it instead."));
  }
}

/**
 * The QR and the details beside it, built from one payload, so what the banking app reads and
 * what the person types by hand are the same account, amount and reference.
 */
/**
 * Làm gì: Hiển thị mã VietQR kèm bảng chi tiết số tiền, tài khoản ngân hàng và nội dung chuyển khoản với các nút sao chép nhanh.
 * Được gọi ở:
 * - src/client/components/transfer-qr-modal.tsx (TransferQrModal dòng 233)
 * - src/client/components/transfer-qr-modal.tsx (MemberTransferModal dòng 295)
 * @param bank Thông tin tài khoản ngân hàng của trung tâm (bắt buộc đã cấu hình configured: true).
 * @param amountVnd Số tiền cần thanh toán bằng VNĐ.
 * @param reference Nội dung chuyển khoản gốc (sẽ được chuẩn hóa theo định dạng NAPAS).
 * @param buyerName Tên khách hàng (tùy chọn) để hiển thị đối soát.
 * @returns JSX.Element chứa ảnh mã VietQR và bảng chi tiết thông tin chuyển khoản.
 */
export function VietQrPanel({
  bank,
  amountVnd,
  reference,
  buyerName,
}: {
  bank: CentreBank & { configured: true };
  amountVnd: number;
  reference: string;
  buyerName?: string;
}) {
  // Bước 1: Chuẩn hóa nội dung chuyển khoản sang chữ hoa không dấu, loại bỏ ký tự đặc biệt theo quy chuẩn NAPAS
  const ref = transferReference(reference);
  // Bước 2: Quản lý đường dẫn DataURL của ảnh mã QR sau khi được thư viện QRCode tạo thành công
  const [src, setSrc] = useState<string | null>(null);
  // Bước 3: Effect tạo chuỗi payload chuẩn VietQR và chuyển đổi sang ảnh DataURL khi thông tin thanh toán thay đổi
  useEffect(() => {
    // Cờ kiểm soát tránh race condition và ngăn cập nhật state khi component đã unmount
    let live = true;
    // Xóa ảnh QR cũ trong khi chờ tạo mã mới để hiển thị placeholder đang tải
    setSrc(null);
    // Bước 4: Đóng gói payload EMVCo chứa BIN ngân hàng, số tài khoản, số tiền và nội dung rồi vẽ thành ảnh
    try {
      const payload = vietQrPayload({ bin: bank.bin!, accountNo: bank.account_no! }, amountVnd, ref);
      void QRCode.toDataURL(payload, QR_STYLE).then((url) => live && setSrc(url));
    } catch {
      // An account the builder refuses never reaches here: the server only reports a valid one.
    }
    // Dọn dẹp effect: hủy cờ live khi effect chạy lại hoặc component unmount
    return () => {
      live = false;
    };
  }, [bank.bin, bank.account_no, amountVnd, ref]);

  return (
    <div className="grid gap-4 text-center">
      {src ? (
        <div className="relative mx-auto size-64 overflow-hidden rounded-[var(--radius-lg)] border border-line bg-white p-2 shadow-sm">
          <img src={src} alt={t("VietQR payment code")} className="size-full object-contain" />
        </div>
      ) : (
        <div className="mx-auto grid size-64 place-items-center rounded-[var(--radius-lg)] border border-line bg-surface text-sm text-muted">
          {t("Generating QR…")}
        </div>
      )}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 rounded-[var(--radius-md)] bg-wood/50 p-3 text-left text-sm">
        <dt className="text-muted">{t("Amount due")}</dt>
        <dd className="figure text-lg font-bold text-accent-2 tabular-nums">{money(amountVnd)}</dd>
        <dt className="text-muted">{t("Bank")}</dt>
        <dd className="font-semibold">{bank.bank_name}</dd>
        <dt className="text-muted">{t("Account number")}</dt>
        <dd className="flex items-center gap-2">
          <span className="font-mono font-semibold tracking-wide">{bank.account_no}</span>
          <CopyButton label={t("Copy the account number")} onClick={() => void copy(bank.account_no!, t("Account number"))} />
        </dd>
        <dt className="text-muted">{t("Account name")}</dt>
        <dd className="font-semibold">{bank.account_name}</dd>
        <dt className="text-muted">{t("Transfer reference")}</dt>
        <dd className="flex items-center gap-2">
          <span className="font-mono font-bold text-accent-2">{ref}</span>
          <CopyButton label={t("Copy the reference")} onClick={() => void copy(ref, t("Transfer reference"))} />
        </dd>
        {buyerName ? (
          <>
            <dt className="text-muted">{t("Customer")}</dt>
            <dd>{buyerName}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

/**
 * Làm gì: Nút bấm icon nhỏ gọn kích hoạt thao tác sao chép thông tin vào clipboard, hỗ trợ kích thước chạm lớn trên mobile.
 * Được gọi ở: src/client/components/transfer-qr-modal.tsx (nội bộ component VietQrPanel dòng 88, 95).
 * @param label Nhãn văn bản mô tả hành động (dùng cho aria-label và tooltip title).
 * @param onClick Hàm callback xử lý sao chép khi người dùng bấm nút.
 * @returns JSX.Element nút bấm sao chép icon Copy.
 */
function CopyButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid size-11 shrink-0 place-items-center rounded-[var(--radius-sm)] text-muted transition-colors duration-150 hover:bg-wood hover:text-fg sm:size-8"
    >
      <Copy aria-hidden className="size-4" />
    </button>
  );
}

// Kiểu dữ liệu định nghĩa các props đầu vào của modal thanh toán chuyển khoản tại quầy TransferQrModal
type TransferQrModalProps = {
  open: boolean;
  onClose: () => void;
  amountVnd: number;
  code: string;
  title?: string;
  buyerName?: string;
  refType?: "booking" | "subscription";
  refId?: string;
  onConfirmManual: () => Promise<void>;
  onPaid?: () => void;
};

/**
 * The desk's QR box. A payOS code comes first when the centre has payOS (it confirms itself);
 * otherwise a VietQR for the centre's own account. With neither, it says the account is not
 * set up rather than showing one that is not the centre's.
 */
/**
 * Làm gì: Modal thanh toán chuyển khoản tại quầy lễ tân (desk), ưu tiên tạo mã payOS tự động đối soát, nếu không sẽ chuyển sang VietQR của trung tâm kèm nút xác nhận thủ công.
 * Được gọi ở:
 * - src/routes/desk.payments.tsx (quản lý và thu tiền đơn thanh toán tại quầy dòng 502)
 * - src/routes/desk.member.$id.tsx (thu tiền mua gói tập cho hội viên tại quầy dòng 1008)
 * @param open Trạng thái mở/đóng của modal.
 * @param onClose Hàm callback khi đóng modal.
 * @param amountVnd Số tiền cần thanh toán (VNĐ).
 * @param code Mã tham chiếu nghiệp vụ (mã đặt sân hoặc mã gói tập) để tạo nội dung chuyển khoản.
 * @param title Tiêu đề modal tùy chỉnh (mặc định hiển thị thông báo quét mã QR).
 * @param buyerName Tên khách hàng thanh toán để nhân viên đối chiếu.
 * @param refType Loại dịch vụ thanh toán ("booking" hoặc "subscription") để khởi tạo đơn payOS.
 * @param refId ID của đơn đặt sân hoặc gói tập để liên kết giao dịch trực tuyến.
 * @param onConfirmManual Hàm callback bất đồng bộ khi nhân viên xác nhận đã nhận đủ tiền để tạo hóa đơn và biên lai.
 * @returns JSX.Element hộp thoại modal thanh toán tại quầy.
 */
export function TransferQrModal({
  open,
  onClose,
  amountVnd,
  code,
  title,
  buyerName,
  refType,
  refId,
  onConfirmManual,
}: TransferQrModalProps) {
  // Bước 1: Khởi tạo dữ liệu tài khoản ngân hàng trung tâm và các state quản lý ảnh mã payOS, trạng thái thử payOS, cờ bận
  const { bank } = useCentreBank();
  const [payosSrc, setPayosSrc] = useState<string | null>(null);
  const [triedPayos, setTriedPayos] = useState(false);
  const [busy, setBusy] = useState(false);

  // Bước 2: Effect thử khởi tạo giao dịch payOS trực tuyến khi mở modal nếu có refType và refId
  useEffect(() => {
    // Đặt lại state về ban đầu khi modal đóng
    if (!open) {
      setPayosSrc(null);
      setTriedPayos(false);
      return;
    }
    let active = true;
    /**
     * Làm gì: Thử gọi API tạo link thanh toán payOS trực tuyến và chuyển mã QR nhận được thành ảnh DataURL.
     * Được gọi ở: useEffect nội bộ của TransferQrModal khi modal mở ra (dòng 178).
     * @returns Promise<void>
     */
    async function tryPayos() {
      // Chỉ tạo đơn payOS khi có đầy đủ phân loại dịch vụ và ID nghiệp vụ
      if (refType && refId) {
        try {
          // Gọi backend tạo giao dịch payOS mới; nếu thành công sẽ nhận chuỗi qr_code
          const res = await apiPost<{ qr_code: string; payment_id: string }>(
            "/payments/online",
            { ref_type: refType, ref_id: refId },
            true,
          );
          if (active && res.qr_code) setPayosSrc(await QRCode.toDataURL(res.qr_code, QR_STYLE));
        } catch {
          // payOS not set up or unavailable: the centre's own account below takes over.
        }
      }
      // Đánh dấu đã thử payOS xong để component quyết định render mã payOS hay VietQR của trung tâm
      if (active) setTriedPayos(true);
    }
    void tryPayos();
    // Dọn dẹp effect: đánh dấu inactive để tránh gán state nếu modal bị đóng sớm
    return () => {
      active = false;
    };
  }, [open, refType, refId]);

  /**
   * Làm gì: Xử lý khi nhân viên bấm xác nhận đã nhận được tiền chuyển khoản thủ công, ghi nhận thanh toán và in biên lai.
   * Được gọi ở: Sự kiện onClick của nút "Money received, confirm & print" ở footer modal (dòng 209).
   * @returns Promise<void>
   */
  async function handleConfirmManual() {
    // Bước 1: Kiểm tra cờ bận để chống người dùng click liên tiếp nhiều lần
    if (busy) return;
    setBusy(true);
    // Bước 2: Thực thi hàm callback xác nhận thanh toán thủ công từ component cha, thông báo thành công và đóng modal
    try {
      await onConfirmManual();
      toast.success(t("Payment confirmed and receipt generated"));
      onClose();
    // Bước 3: Báo lỗi lên giao diện nếu việc ghi nhận thanh toán hoặc in hóa đơn thất bại
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Could not confirm payment"));
    // Bước 4: Mở khóa cờ bận sau khi hoàn tất xử lý
    } finally {
      setBusy(false);
    }
  }

  // Bước 3: Ghép tiền tố quy định của trung tâm "LELONG" với mã đơn để tạo nội dung chuyển khoản dễ tra cứu
  const reference = `LELONG ${code}`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title ?? t("Scan QR to pay · Bank transfer")}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("Close")}
          </Button>
          <Button variant="primary" onClick={handleConfirmManual} disabled={busy}>
            {busy ? t("Recording…") : t("Money received, confirm & print")}
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 text-center">
        <p className="text-sm text-muted">{t("Ask the customer to scan this QR code with their banking app.")}</p>
        {payosSrc ? (
          <>
            <div className="relative mx-auto size-64 overflow-hidden rounded-[var(--radius-lg)] border border-line bg-white p-2 shadow-sm">
              <img src={payosSrc} alt={t("VietQR payment code")} className="size-full object-contain" />
            </div>
            <p className="text-sm">
              <span className="text-muted">{t("Amount due")}: </span>
              <span className="figure font-bold tabular-nums text-accent-2">{money(amountVnd)}</span>
            </p>
            <p className="text-xs text-muted">{t("This code comes from payOS: the bank details are inside it, and the payment confirms itself.")}</p>
          </>
        ) : !triedPayos || !bank ? (
          <div className="mx-auto grid size-64 place-items-center rounded-[var(--radius-lg)] border border-line bg-surface text-sm text-muted">
            {t("Generating QR…")}
          </div>
        ) : bank.configured ? (
          <VietQrPanel bank={bank as CentreBank & { configured: true }} amountVnd={amountVnd} reference={reference} buyerName={buyerName} />
        ) : (
          <div className="rounded-[var(--radius-md)] border border-hold/30 bg-hold/5 p-4 text-left text-sm">
            <p className="font-medium">{t("The centre's bank account is not set up")}</p>
            <p className="mt-1 text-muted">
              {t("Ask the manager to add it before taking transfers. Cash and card still work.")}
            </p>
          </div>
        )}
        <p className="text-xs text-muted">
          {t("Once the customer completes the transfer, click 'Money received, confirm & print' below to post the payment and print their receipt.")}
        </p>
      </div>
    </Modal>
  );
}

/**
 * The member's transfer step on a held court: the QR and details for the centre's account with
 * the booking code as the reference, then "I have transferred", which keeps the court held
 * while reception finds the money (the existing pending-transfer flow).
 */
/**
 * Làm gì: Modal thanh toán chuyển khoản dành cho hội viên tự đặt sân, hiển thị mã VietQR tài khoản trung tâm kèm nút "Tôi đã chuyển khoản" để giữ sân trong khi chờ xác nhận.
 * Được gọi ở:
 * - src/routes/app.book.tsx (màn hình đặt sân của hội viên, dòng 593 khi hold sân và dòng 607 khi xem lại pending transfer)
 * @param open Trạng thái mở/đóng của modal.
 * @param onClose Hàm callback khi đóng modal.
 * @param bank Thông tin tài khoản ngân hàng của trung tâm (bắt buộc đã cấu hình đầy đủ).
 * @param amountVnd Số tiền đặt sân cần thanh toán (VNĐ).
 * @param bookingCode Mã đặt sân dùng để tạo nội dung chuyển khoản "LELONG <bookingCode>".
 * @param busy Cờ trạng thái đang xử lý yêu cầu (vô hiệu hóa các nút tương tác).
 * @param onTransferred Hàm callback khi hội viên xác nhận đã chuyển tiền (vắng mặt khi chỉ xem lại thông tin).
 * @returns JSX.Element modal hướng dẫn hội viên chuyển khoản giữ sân.
 */
export function MemberTransferModal({
  open,
  onClose,
  bank,
  amountVnd,
  bookingCode,
  busy,
  onTransferred,
}: {
  open: boolean;
  onClose: () => void;
  bank: CentreBank & { configured: true };
  amountVnd: number;
  bookingCode: string;
  busy: boolean;
  /** Absent once the member has already said so: the box only shows the details again. */
  onTransferred?: () => void;
}) {
  // Bước 1: Render hộp thoại modal chứa panel mã VietQR theo cú pháp "LELONG <bookingCode>" và nút xác nhận đã chuyển tiền
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("Pay by bank transfer")}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t("Close")}
          </Button>
          {onTransferred ? (
            <Button onClick={onTransferred} disabled={busy}>
              {t("I have transferred")}
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="grid gap-4">
        <p className="text-sm text-muted">
          {t("Scan with your banking app, or type the details in by hand. Keep the reference exactly as it is, so reception can find your transfer.")}
        </p>
        <VietQrPanel bank={bank} amountVnd={amountVnd} reference={`LELONG ${bookingCode}`} />
        <p className="text-xs text-muted">
          {t("A transfer is not a payment until reception finds it in the bank. Your court stays held meanwhile.")}
        </p>
      </div>
    </Modal>
  );
}
