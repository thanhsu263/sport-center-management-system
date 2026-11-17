/**
 * Trang thông báo kết quả điều hướng trở về sau thanh toán trực tuyến qua cổng payOS (/pay/return).
 * Thuộc tầng web client (TanStack Router), tiếp nhận khách hàng sau khi thanh toán hoặc hủy giao dịch trên payOS.
 * Giao diện chỉ hiển thị kết quả chứ không tự quyết định trạng thái, mà luôn gọi API server để xác thực chéo với payOS.
 */
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { PaidMark } from "@/client/components/moments/paid";
import { useEffect, useState } from "react";
import { Shell, money } from "@/client/components/shell";
import { ButtonLink, Card, Skeleton } from "@/client/components/ui";
import { apiPost } from "@/client/arena3/client";
import { t } from "@/client/lib/i18n";

/**
 * Where payOS sends the customer back to.
 *
 * This page reports a result; it never decides one. Landing here is not
 * evidence of payment — the address is guessable, reachable out of order and
 * re-openable at will — so the first thing it does is ask the server, which
 * asks payOS. Until that answer comes back it says "checking", not "paid".
 *
 * The same page covers the cancel URL: payOS sends `cancel=true` and the wait
 * is pointless, but the server is still asked, because a customer can pay and
 * then press cancel on the way back.
 */

type Search = { pid?: string; cancelled?: string; status?: string };

/**
 * Làm gì: Định nghĩa route "/pay/return" trong TanStack Router, xác thực search params (pid, cancelled, status) từ URL chuyển hướng của cổng thanh toán.
 * Được gọi ở: URL "/pay/return" (cổng thanh toán payOS chuyển hướng khách hàng về theo returnUrl hoặc cancelUrl)
 * @returns Đối tượng cấu hình route của TanStack Router
 */
export const Route = createFileRoute("/pay/return")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    pid: typeof s.pid === "string" ? s.pid : undefined,
    cancelled: typeof s.cancelled === "string" ? s.cancelled : undefined,
    status: typeof s.status === "string" ? s.status : undefined,
  }),
  component: Page,
});

type Outcome = "checking" | "posted" | "pending" | "cancelled" | "unknown";

/** How long to keep asking before telling the customer to check their account. */
const ATTEMPTS = 8;
const GAP_MS = 2500;

/**
 * Làm gì: Component hiển thị trang kết quả thanh toán, thăm dò (polling) trạng thái từ máy chủ và hiển thị giao diện phù hợp với người dùng.
 * Được gọi ở: Route "/pay/return" (thuộc tính component của Route)
 * @returns JSX phần tử giao diện hiển thị trạng thái giao dịch (đang kiểm tra, đã thanh toán, đã hủy, chờ duyệt hoặc lỗi)
 */
function Page() {
  // Bước 1: Trích xuất search params từ URL và khởi tạo các state theo dõi giao dịch.
  const search = useSearch({ from: "/pay/return" });
  const paymentId = search.pid ?? null;
  const [outcome, setOutcome] = useState<Outcome>("checking");
  const [amount, setAmount] = useState<number | null>(null);

  // Bước 2: Kích hoạt hiệu ứng polling để liên tục kiểm tra kết quả thanh toán với máy chủ.
  useEffect(() => {
    // Nếu thiếu paymentId (người dùng tự truy cập URL mà không qua thanh toán) thì không thể đối soát.
    if (!paymentId) {
      setOutcome("unknown");
      return;
    }
    // Biến cờ alive giúp tránh memory leak khi component unmount; tries đếm số lần đã gọi polling.
    let alive = true;
    let tries = 0;

    /**
     * Làm gì: Gửi yêu cầu xác thực giao dịch lên máy chủ qua endpoint verify, cập nhật outcome và tự động lên lịch thăm dò lại nếu đang xử lý.
     * Được gọi ở: useEffect trong Page (gọi ngay lần đầu hoặc qua setTimeout)
     * @returns Promise<void>
     */
    async function ask() {
      // Bước 2.1: Tăng số lần thử và gọi API xác thực giao dịch.
      tries += 1;
      try {
        // The server asks payOS; the browser is told the answer. Ownership is
        // checked there — a member can only verify their own payment.
        const r = await apiPost<{ status: string; amount_vnd?: number }>(
          `/payments/online/${paymentId}/verify`,
        );
        // Nếu component đã unmount trong lúc chờ API phản hồi thì dừng lại ngay, không cập nhật state.
        if (!alive) return;
        if (typeof r.amount_vnd === "number") setAmount(r.amount_vnd);
        // Bước 2.2: Phân loại trạng thái giao dịch từ server để cập nhật UI.
        if (r.status === "posted") {
          // Trạng thái "posted": Tiền đã vào tài khoản, đặt sân hoặc gói tập đã được kích hoạt thành công.
          setOutcome("posted");
        } else if (r.status === "failed" || r.status === "expired") {
          // Trạng thái "failed" hoặc "expired": Khách hàng hủy thanh toán hoặc link thanh toán đã hết hạn.
          setOutcome("cancelled");
        } else if (tries < ATTEMPTS) {
          // A bank transfer can land a few seconds after the redirect.
          window.setTimeout(() => void ask(), GAP_MS);
        } else {
          // Đã hết 8 lần thử (khoảng 20s) mà ngân hàng chưa xác nhận: chuyển sang "pending" để nhắc khách không chuyển tiền đúp.
          setOutcome("pending");
        }
      } catch {
        // Lỗi kết nối hoặc máy chủ gặp sự cố: đánh dấu "unknown" để hướng dẫn khách xem biên nhận hoặc liên hệ lễ tân.
        if (alive) setOutcome("unknown");
      }
    }
    // Bước 2.3: Thực hiện lần thăm dò đầu tiên ngay khi render.
    void ask();
    // Cleanup function: Đánh dấu alive = false để hủy các cập nhật state nếu component unmount.
    return () => {
      alive = false;
    };
  }, [paymentId]);

  // Bước 3: Render giao diện thẻ trạng thái (Card) tương ứng với giá trị outcome.
  return (
    <Shell role="member" title={t("Payment")} subtitle={t("Back from the payment page.")}>
      <Card className="mx-auto max-w-md p-6 text-center" aria-live="polite" aria-busy={outcome === "checking"}>
        {outcome === "checking" ? (
          <div className="grid gap-3">
            <p className="font-display text-2xl">{t("Checking with the bank…")}</p>
            <p className="text-sm text-muted">
              {t("This takes a few seconds. Do not pay again: if the money has left your account it will land here.")}
            </p>
            <Skeleton className="mx-auto h-2 w-40" />
          </div>
        ) : null}

        {outcome === "posted" ? (
          <div className="grid justify-items-center gap-2">
            <PaidMark className="size-14" />
            <p className="font-display text-3xl">{t("Paid")}</p>
            {amount ? <p className="text-2xl tabular-nums">{money(amount)}</p> : null}
            <p className="text-sm text-muted">
              {t("Your court is confirmed and the receipt is in your account.")}
            </p>
            <div className="mt-2 flex justify-center gap-2">
              <ButtonLink to="/account" variant="outline">
                {t("See the receipt")}
              </ButtonLink>
              <ButtonLink to="/app">{t("My schedule")}</ButtonLink>
            </div>
          </div>
        ) : null}

        {outcome === "pending" ? (
          <div className="grid gap-2">
            <p className="font-display text-2xl">{t("Not confirmed yet")}</p>
            <p className="text-sm text-muted">
              {t("The bank has not told us about it. If the money has left your account it will post by itself and your receipt will appear in your account. Please do not pay twice.")}
            </p>
            <ButtonLink to="/account" variant="outline" className="mt-2">
              {t("Check my receipts")}
            </ButtonLink>
          </div>
        ) : null}

        {outcome === "cancelled" ? (
          <div className="grid gap-2">
            <p className="font-display text-2xl">{t("Payment cancelled")}</p>
            <p className="text-sm text-muted">
              {t("Nothing was taken. The court is released unless you booked it again.")}
            </p>
            <ButtonLink to="/app/book" className="mt-2">
              {t("Book again")}
            </ButtonLink>
          </div>
        ) : null}

        {outcome === "unknown" ? (
          <div className="grid gap-2">
            <p className="font-display text-2xl">{t("We could not find that payment")}</p>
            <p className="text-sm text-muted">
              {t("If money left your account, the front desk can look it up by the time and amount.")}
            </p>
            <ButtonLink to="/account" variant="outline" className="mt-2">
              {t("My receipts")}
            </ButtonLink>
          </div>
        ) : null}
      </Card>
    </Shell>
  );
}
