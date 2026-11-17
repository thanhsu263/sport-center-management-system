/**
 * File: src/server/integrations/payos.ts
 * Vai trò: Module tích hợp cổng thanh toán trực tuyến payOS cho hệ thống Arena3.
 * Vị trí trong app: Chạy ở server backend, đóng gói SDK @payos/node để tạo link thanh toán VietQR, đọc trạng thái đơn hàng, hủy link giữ chỗ và xác thực chữ ký webhook.
 */
import { PayOS } from "@payos/node";
import type { Sql } from "@/server/data/db";

/**
 * The payOS gateway, wrapped so the rest of the app never talks to it directly.
 *
 * Three things this file exists to guarantee:
 *
 *  - **The app runs without credentials.** payOS is optional. An unconfigured
 *    install must behave exactly as it did before — cash, card and bank
 *    transfer at the desk — not crash on boot or hide the till behind an
 *    error. Nothing here throws at import time.
 *  - **Order codes are derived, never invented.** payOS wants a number, unique
 *    per merchant, inside the JS safe-integer range. The usual
 *    `Date.now()`-based guess collides when two customers pay in the same
 *    millisecond; this app already has a gapless counter, so the code comes
 *    from there.
 *  - **Secrets stay server-side.** `process.env` only — no `VITE_` prefix, so
 *    the checksum key can never reach a browser bundle.
 */

export type PayosStatus = "PENDING" | "PAID" | "CANCELLED" | "EXPIRED" | "PROCESSING" | string;

/** Everything the gateway needs, or `null` when the centre has not set it up. */
function credentials() {
  // Bước 1: Đọc bộ khóa từ process.env (không dùng tiền tố VITE_ để tránh lộ khóa bí mật sang client bundle)
  const clientId = process.env.PAYOS_CLIENT_ID?.trim();
  const apiKey = process.env.PAYOS_API_KEY?.trim();
  const checksumKey = process.env.PAYOS_CHECKSUM_KEY?.trim();
  // Bước 2: Kiểm tra nếu thiếu bất kỳ khóa nào thì trả về null để app vẫn chạy với thanh toán tại quầy
  if (!clientId || !apiKey || !checksumKey) return null;
  return { clientId, apiKey, checksumKey };
}

/**
 * Test switch: with `PAYOS_TEST_AMOUNT=2000` every online payment is charged
 * that much at the gateway while the order keeps its real price. Unset (the
 * default) it does nothing, and an amount at or above the price is ignored, so
 * it can only ever lower what a customer is asked to pay. Remove it before
 * taking real money.
 */
export function gatewayAmount(priceVnd: number): number {
  // Bước 1: Đọc số tiền thanh toán thử nghiệm từ biến môi trường PAYOS_TEST_AMOUNT
  const t = Number(process.env.PAYOS_TEST_AMOUNT?.trim());
  // Bước 2: payOS yêu cầu tối thiểu 1.000đ; chỉ áp dụng khi số tiền test nhỏ hơn giá gốc để thử nghiệm an toàn
  return Number.isInteger(t) && t >= 1000 && t < priceVnd ? t : priceVnd;
}

/** Whether online payment can be offered at all. */
export function payosConfigured(): boolean {
  // Kiểm tra trung tâm có thể nhận thanh toán online không (qua mock creator trong test hoặc credentials thật)
  return overridePaymentLinkCreator !== null || credentials() !== null;
}

let client: PayOS | null = null;
/**
 * Làm gì: Khởi tạo lười (lazy initialization) và trả về instance PayOS dùng chung (singleton). Tránh lỗi khi khởi động server nếu chưa cấu hình payOS.
 * Được gọi ở: Nội bộ file src/server/integrations/payos.ts (các hàm createPaymentLink, readPaymentLink, cancelPaymentLink, verifyWebhook, registerWebhook).
 * @returns Instance PayOS client đã cấu hình đầy đủ credentials.
 * @throws Error("payOS is not configured") nếu chưa cấu hình đủ bộ 3 biến môi trường.
 */
function payos(): PayOS {
  // Bước 1: Kiểm tra nếu client chưa khởi tạo thì tiến hành nạp credentials và khởi tạo instance mới
  if (!client) {
    const creds = credentials();
    // Ném lỗi ngay tại thời điểm gọi thay vì lúc nạp file để không làm sập ứng dụng khi chưa cấu hình payOS
    if (!creds) throw new Error("payOS is not configured");
    client = new PayOS(creds);
  }
  return client;
}

/**
 * The line that shows up on the bank statement, in nine characters.
 *
 * payOS caps the description at **9 characters** for a bank account that is
 * not itself linked to payOS, and silently truncating a longer string would
 * leave reception with a statement line that no longer identifies anything.
 * Vietnamese and punctuation are not accepted either.
 *
 * `PAY-20260927-0004` becomes `A3270004`: the centre, the day of the month and
 * the day's sequence number. That is unique within any month and short enough
 * to survive, and the full order code is still on the payOS record for
 * anything that needs the exact match.
 */
export function describeForGateway(paymentCode: string): string {
  // Bước 1: Phân tích mã thanh toán định dạng PAY-YYYYMMDD-NNNN thành ngày trong tháng (2 số) và số thứ tự
  const m = /^[A-Z]+-\d{6}(\d{2})-(\d+)$/.exec(paymentCode);
  // Bước 2: Ghép mã A3 + ngày + 4 số thứ tự (ví dụ: A3270004) để vừa đúng giới hạn 9 ký tự sao kê ngân hàng của payOS
  if (m) return `A3${m[1]}${m[2]!.padStart(4, "0")}`.slice(0, 9);
  // Bước 3: Dự phòng nếu mã không đúng định dạng chuẩn: lọc bỏ ký tự đặc biệt, lấy 9 ký tự in hoa
  return paymentCode.replace(/[^A-Za-z0-9]/g, "").slice(0, 9).toUpperCase();
}

export type CreatedLink = {
  orderCode: number;
  checkoutUrl: string;
  qrCode: string;
  paymentLinkId: string;
  expiredAt: number | null;
};

/**
 * Issue a payment link.
 *
 * `expiredAt` is seconds since the epoch, not milliseconds — a link created
 * with a millisecond value is accepted and then never expires, which would
 * leave a court held open indefinitely.
 */
let overridePaymentLinkCreator: ((args: Parameters<typeof createPaymentLink>[0]) => Promise<CreatedLink>) | null = null;
/** @internal test-only */
export function setOverridePaymentLinkCreator(fn: ((args: any) => Promise<CreatedLink>) | null): void {
  overridePaymentLinkCreator = fn;
}

/**
 * Làm gì: Tạo yêu cầu thanh toán trực tuyến qua cổng payOS, sinh link thanh toán và mã QR VietQR cho đơn hàng.
 * Được gọi ở: src/server/controllers/handlers/online.ts (hàm requestOnlineLink trong luồng tạo link thanh toán online).
 * @param args Object chứa orderCode (mã đơn số nguyên duy nhất), amountVnd (số tiền VNĐ), description (nội dung chuyển khoản tối đa 9 ký tự), returnUrl (URL chuyển hướng khi thành công), cancelUrl (URL chuyển hướng khi hủy), expiresInSeconds (thời gian giữ chỗ tính bằng giây).
 * @returns Object CreatedLink chứa orderCode, checkoutUrl (link mở cổng thanh toán), qrCode (chuỗi VietQR), paymentLinkId và expiredAt (thời điểm hết hạn tính theo giây epoch).
 * @throws Error nếu payOS chưa được cấu hình hoặc API payOS từ chối yêu cầu.
 */
export async function createPaymentLink(args: {
  orderCode: number;
  amountVnd: number;
  description: string;
  returnUrl: string;
  cancelUrl: string;
  expiresInSeconds?: number;
}): Promise<CreatedLink> {
  // Bước 1: Kiểm tra và ưu tiên gọi hàm mock nếu đang chạy trong môi trường kiểm thử (test)
  if (overridePaymentLinkCreator) {
    return overridePaymentLinkCreator(args);
  }
  // Bước 2: Tính thời điểm hết hạn (expiredAt) theo đơn vị GIÂY (epoch timestamp); dùng mili-giây sẽ khiến link không bao giờ hết hạn
  const expiredAt = args.expiresInSeconds
    ? Math.floor(Date.now() / 1000) + args.expiresInSeconds
    : undefined;
  // Bước 3: Gọi API payOS paymentRequests.create để tạo yêu cầu thanh toán và sinh mã VietQR
  const res = await payos().paymentRequests.create({
    orderCode: args.orderCode,
    amount: gatewayAmount(args.amountVnd),
    description: args.description,
    returnUrl: args.returnUrl,
    cancelUrl: args.cancelUrl,
    ...(expiredAt ? { expiredAt } : {}),
  });
  // Bước 4: Chuẩn hóa kết quả trả về cho client hiển thị trang thanh toán và quét mã QR
  return {
    orderCode: res.orderCode,
    checkoutUrl: res.checkoutUrl,
    qrCode: res.qrCode,
    paymentLinkId: res.paymentLinkId,
    expiredAt: res.expiredAt ?? null,
  };
}

export type LinkState = {
  status: PayosStatus;
  amountPaid: number;
  /** The bank's own reference for the transfer that settled this, if any. */
  transactionId: string | null;
};

/**
 * Ask payOS what actually happened.
 *
 * This is the only statement about a payment the app trusts. A customer
 * returning to `returnUrl` proves nothing — anyone can open that address — so
 * the decision to post money is always made from this answer or from a
 * signature-verified webhook, never from the browser coming back.
 */
export async function readPaymentLink(orderCode: number): Promise<LinkState> {
  // Bước 1: Truy vấn thông tin đơn thanh toán từ server payOS theo orderCode (chỉ tin dữ liệu từ payOS, không tin redirect trình duyệt)
  const info = await payos().paymentRequests.get(orderCode);
  // Bước 2: Lấy danh sách giao dịch chuyển khoản ngân hàng khớp với đơn hàng này
  const txns = (info.transactions ?? []) as Array<{ reference?: string; amount?: number }>;
  // Bước 3: Trả về trạng thái thanh toán, số tiền thực tế khách đã trả và mã tham chiếu giao dịch ngân hàng
  return {
    status: info.status,
    amountPaid: Number(info.amountPaid ?? 0),
    transactionId: txns[0]?.reference ?? null,
  };
}

let overridePaymentLinkCanceller: ((orderCode: number, reason: string) => Promise<void>) | null = null;
/** @internal test-only */
export function setOverridePaymentLinkCanceller(fn: ((orderCode: number, reason: string) => Promise<void>) | null): void {
  overridePaymentLinkCanceller = fn;
}

/** Withdraw a link whose hold has ended, so the customer cannot still pay it. */
export async function cancelPaymentLink(orderCode: number, reason: string): Promise<void> {
  // Bước 1: Ưu tiên gọi hàm mock nếu đang chạy kiểm thử
  if (overridePaymentLinkCanceller) return overridePaymentLinkCanceller(orderCode, reason);
  // Bước 2: Hủy link thanh toán trên payOS, cắt lý do tối đa 255 ký tự theo quy định của payOS API
  await payos().paymentRequests.cancel(orderCode, reason.slice(0, 255));
}

/**
 * Withdraw every pending payOS link in `rows` and mark them expired locally.
 *
 * A failure at payOS is swallowed (the link may already be cancelled or paid
 * there); the local row is still closed so nothing offers it again. The caller
 * must already hold the row locks, taken before any class or enrolment lock, so
 * this never inverts the payments → class → enrolment order `settleOnline` uses.
 */
export async function withdrawLinks(
  sql: Sql,
  rows: Array<{ id: string; provider_order_code: string | number | null }>,
  reason: string,
  providerStatus: string,
): Promise<void> {
  // Bước 1: Duyệt qua từng bản ghi payment cần hủy link (caller phải giữ row lock từ trước để tránh deadlock)
  for (const row of rows) {
    // Bước 2: Hủy link trên payOS nếu có provider_order_code; bỏ qua lỗi vì nếu payOS đã hủy/đã thanh toán thì local row vẫn cần đóng
    if (row.provider_order_code != null) {
      try {
        await cancelPaymentLink(Number(row.provider_order_code), reason);
      } catch {
        // Already cancelled or already paid at payOS: the local row closes either way.
      }
    }
    // Bước 3: Cập nhật bản ghi payments nội bộ sang status = 'expired' kèm provider_status tương ứng (RELEASED, CLASS_CANCELLED...)
    await sql.query(`update payments set status = 'expired', provider_status = $2 where id = $1`, [
      row.id,
      providerStatus,
    ]);
  }
}

/**
 * Lock the pending payOS links of these enrolments, before any class lock.
 *
 * `settleOnline` locks a payment row and then the class (through
 * `settleEnrollment`). Every path that both ends a seat hold and closes its link
 * takes the payment rows here first, so the two never wait on each other in
 * opposite orders.
 */
export async function lockEnrollmentLinks(
  sql: Sql,
  enrollmentIds: string[],
): Promise<Array<{ id: string; provider_order_code: string | number | null }>> {
  // Bước 1: Nếu mảng ID rỗng thì trả về ngay mảng rỗng để tránh chạy query vô ích
  if (!enrollmentIds.length) return [];
  // Bước 2: Khóa bi quan (FOR UPDATE) các dòng payments theo thứ tự ID tăng dần để chống deadlock với luồng settleOnline
  return sql.query<{ id: string; provider_order_code: string | number | null }>(
    `select id, provider_order_code from payments
      where ref_type = 'enrollment' and ref_id = any($1::uuid[])
        and status::text = 'pending' and provider = 'payos'
      order by id
      for update`,
    [enrollmentIds],
  );
}

export type VerifiedWebhook = {
  orderCode: number;
  amount: number;
  reference: string | null;
  code: string;
};

/**
 * Check a webhook body's signature and return its contents.
 *
 * Throws when the signature does not match, which is the only safe response: a
 * request that cannot be proved to come from payOS carries no information at
 * all, however plausible its contents look.
 */
export async function verifyWebhook(body: unknown): Promise<VerifiedWebhook> {
  // Bước 1: Xác thực chữ ký webhook qua SDK payOS; ném ngoại lệ nếu chữ ký không khớp để ngăn chặn giả mạo kết quả thanh toán
  const data = await payos().webhooks.verify(body as never);
  // Bước 2: Ép kiểu và chuẩn hóa dữ liệu webhook đã được bảo đảm an toàn
  return {
    orderCode: Number(data.orderCode),
    amount: Number(data.amount),
    reference: (data as { reference?: string }).reference ?? null,
    code: (data as { code?: string }).code ?? "",
  };
}

/** Register this deployment's webhook URL with payOS. Needs a public address. */
export async function registerWebhook(url: string): Promise<void> {
  // Bước 1: Gửi webhook URL công khai tới payOS để xác nhận địa chỉ nhận thông báo giao dịch
  await payos().webhooks.confirm(url);
}
