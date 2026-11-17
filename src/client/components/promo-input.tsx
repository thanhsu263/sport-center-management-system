/**
 * File: src/client/components/promo-input.tsx
 * Vai trò: Component ô nhập và áp dụng mã khuyến mãi (PromoInput) dùng chung trong hệ thống.
 * Vị trí trong app: Chạy ở client, gọi API /promotions/validate để kiểm tra tính hợp lệ và tính trước số tiền giảm giá mà không ghi dữ liệu vào cơ sở dữ liệu.
 */
import { useState } from "react";
import { Button, Input } from "@/client/components/ui";
import { apiPost } from "@/client/arena3/client";
import { locale, t, tServer } from "@/client/lib/i18n";

/**
 * Kiểu dữ liệu báo giá khuyến mãi (PromoQuote) trả về từ API /promotions/validate.
 * Chứa kết quả xác thực mã, tên chương trình, giá gốc (order_vnd), số tiền giảm (discount_vnd) và số tiền thanh toán cuối cùng (final_vnd).
 */
export type PromoQuote = {
  valid: boolean;
  code: string;
  name: string;
  order_vnd: number;
  discount_vnd: number;
  final_vnd: number;
};

/**
 * One code box for every order form. "Apply" asks the server what the code would
 * take off (nothing is written), so the price on screen is the price that gets
 * charged. The parent keeps the applied code and sends it with the order itself.
 */
/**
 * Làm gì: Component ô nhập mã khuyến mãi (PromoInput); gửi mã lên server kiểm tra tính hợp lệ và hiển thị ngay số tiền được giảm trước khi khách hàng thanh toán.
 * Được gọi ở: src/routes/desk.payments.tsx (quầy thu ngân xử lý thanh toán đơn mua gói tập hội viên, PaymentsDesk).
 * @param props Các thuộc tính giao diện:
 * - scope: Phạm vi áp dụng của mã ("plan" cho gói tập hoặc "court" cho đặt sân thể thao).
 * - target: Dữ liệu đối tượng tính giá (`{plan_id}` hoặc `{court_id, start_at}`), kèm `user_id` khi nhân viên áp mã cho hội viên.
 * - onChange: Callback nhận kết quả báo giá PromoQuote hợp lệ hoặc null khi xóa mã / xảy ra lỗi.
 * - compact: Cờ boolean thu nhỏ chiều cao ô nhập để phù hợp với giao diện bảng thanh toán.
 * @returns JSX.Element Giao diện ô nhập mã khuyến mãi hoàn chỉnh kèm trạng thái và dòng hiển thị chiết khấu.
 */
export function PromoInput({
  scope,
  target,
  onChange,
  compact = false,
}: {
  scope: "plan" | "court";
  /** The thing being priced: `{plan_id}` or `{court_id, start_at}`, plus `user_id` when staff order for a member. */
  target: Record<string, string | undefined>;
  onChange: (quote: PromoQuote | null) => void;
  compact?: boolean;
}) {
  // Bước 1: Khởi tạo state quản lý mã nhập vào, dữ liệu báo giá chiết khấu (quote), thông báo lỗi và cờ chờ xử lý (busy).
  const [code, setCode] = useState("");
  const [quote, setQuote] = useState<PromoQuote | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  /**
   * Làm gì: Gửi mã khuyến mãi lên backend để kiểm tra tính hợp lệ và lấy báo giá chiết khấu (quote) mà không ghi nhận đơn hàng.
   * Được gọi ở: Nút "Apply" (sự kiện onClick) và ô Input khi nhấn Enter (sự kiện onKeyDown) trong component PromoInput.
   * @returns Promise<void>
   */
  async function apply() {
    // Bước 1: Cắt bỏ khoảng trắng thừa ở hai đầu mã; nếu mã rỗng thì dừng lại, không gửi request.
    const c = code.trim();
    if (!c) return;
    // Bật cờ busy để vô hiệu hóa nút bấm và xóa thông báo lỗi cũ trước khi gọi API.
    setBusy(true);
    setError("");
    try {
      // Bước 2: Gửi request POST tới /promotions/validate kèm scope, mã code và target để lấy báo giá chiết khấu mà không tạo đơn hàng.
      const q = await apiPost<PromoQuote>("/promotions/validate", { scope, code: c, ...target });
      // Bước 3: Cập nhật state quote nội bộ và kích hoạt onChange để truyền thông tin chiết khấu cho component cha.
      setQuote(q);
      onChange(q);
    } catch (e) {
      // Bước 4: Xử lý khi mã không hợp lệ hoặc lỗi mạng: xóa quote, gửi null cho component cha và hiển thị thông báo lỗi thân thiện qua tServer.
      setQuote(null);
      onChange(null);
      setError(e instanceof Error ? tServer(e.message) : t("That code could not be applied."));
    } finally {
      // Bước 5: Luôn giải phóng cờ bận (busy = false) khi kết thúc request để người dùng có thể thao tác tiếp.
      setBusy(false);
    }
  }

  /**
   * Làm gì: Xóa mã khuyến mãi đã áp dụng, đặt lại toàn bộ state nội bộ và thông báo cho component cha hủy mức giảm giá.
   * Được gọi ở: Nút "Remove" trong component PromoInput (sự kiện onClick).
   * @returns void
   */
  function clear() {
    // Đặt lại mã code rỗng, xóa báo giá quote, xóa thông báo lỗi và gửi null lên component cha.
    setCode("");
    setQuote(null);
    setError("");
    onChange(null);
  }

  // Bước 2: Render giao diện gồm ô nhập mã (tự động chuyển chữ hoa), nút bấm Áp dụng/Gỡ bỏ và dòng hiển thị chiết khấu.
  return (
    <div className="grid gap-1.5">
      <div className="flex gap-2">
        <Input
          value={code}
          placeholder={t("Promo code")}
          aria-label={t("Promo code")}
          className={compact ? "h-11 sm:h-9" : undefined}
          disabled={quote !== null}
          autoCapitalize="characters"
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void apply();
            }
          }}
        />
        {quote ? (
          <Button type="button" variant="ghost" size="sm" onClick={clear}>
            {t("Remove")}
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" disabled={busy || !code.trim()} onClick={() => void apply()}>
            {busy ? t("Checking…") : t("Apply")}
          </Button>
        )}
      </div>
      {quote ? (
        <p className="text-xs text-accent">
          {t("{name}: −{discount} ₫ → pay {total} ₫", {
            name: quote.name,
            discount: quote.discount_vnd.toLocaleString(locale()),
            total: quote.final_vnd.toLocaleString(locale()),
          })}
        </p>
      ) : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
