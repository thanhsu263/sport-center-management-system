/**
 * Quản lý thông tin tài khoản ngân hàng của trung tâm từ biến môi trường server.
 * Cung cấp dữ liệu để kiểm tra tính năng thanh toán chuyển khoản và tạo mã VietQR khi đặt sân hoặc thanh toán tại quầy.
 */
import { validBankAccount, type BankAccount } from "../../shared/vietqr";

/**
 * The centre's bank account for VietQR transfers, from the server environment:
 *   BANK_BIN           six-digit NAPAS bank id (970422 = MB, 970436 = Vietcombank, …)
 *   BANK_ACCOUNT_NO    the account number
 *   BANK_ACCOUNT_NAME  the holder's name as the bank prints it
 *   BANK_NAME          optional display name; known BINs are named without it
 *
 * Nothing here is a secret (a payer has to see all of it), but it is the centre's real account,
 * so it lives in the deploy's environment rather than in code. Unset or malformed means "not set
 * up": members are not offered a transfer and the desk box says so, instead of showing an account
 * that is not the centre's.
 */
export type CentreBank = BankAccount & { bankName: string; accountName: string };

// Bảng ánh xạ mã BIN 6 chữ số của NAPAS sang tên hiển thị của các ngân hàng phổ biến tại Việt Nam.
const KNOWN_BANKS: Record<string, string> = {
  "970422": "MB Bank",
  "970436": "Vietcombank",
  "970415": "VietinBank",
  "970418": "BIDV",
  "970405": "Agribank",
  "970407": "Techcombank",
  "970416": "ACB",
  "970432": "VPBank",
  "970423": "TPBank",
  "970403": "Sacombank",
  "970441": "VIB",
  "970443": "SHB",
  "970448": "OCB",
  "970437": "HDBank",
};

/**
 * Làm gì: Đọc và chuẩn hóa thông tin tài khoản ngân hàng của trung tâm từ biến môi trường server (BANK_BIN, BANK_ACCOUNT_NO, BANK_ACCOUNT_NAME, BANK_NAME). Trả về null nếu chưa cấu hình hoặc sai định dạng.
 * Được gọi ở: src/server/controllers/handlers/ops.ts (hàm flagsGet cho route GET /flags, hàm bankTransferGet cho route GET /bank-transfer)
 * @returns {CentreBank | null} Thông tin tài khoản ngân hàng hoàn chỉnh hoặc null nếu cấu hình không hợp lệ
 */
export function centreBank(): CentreBank | null {
  // Bước 1: Lấy các biến môi trường cấu hình tài khoản (an toàn khi chạy ngoài Node.js)
  const env = typeof process !== "undefined" ? process.env : {};
  const bin = (env.BANK_BIN ?? "").trim();
  // Xóa mọi khoảng trắng để tránh lỗi khi người quản trị nhập số tài khoản có dấu cách phân cách nhóm số
  const accountNo = (env.BANK_ACCOUNT_NO ?? "").replace(/\s+/g, "");
  const accountName = (env.BANK_ACCOUNT_NAME ?? "").trim().toUpperCase();
  // Bước 2: Kiểm tra định dạng tài khoản ngân hàng theo chuẩn VietQR
  // Trả về null nếu thiếu tên tài khoản hoặc mã BIN/số tài khoản sai định dạng, giúp giao diện ẩn phương thức chuyển khoản thay vì hiển thị thông tin lỗi
  if (!validBankAccount({ bin, accountNo }) || !accountName) return null;
  // Bước 3: Xác định tên ngân hàng hiển thị (ưu tiên BANK_NAME tùy chỉnh, tra cứu KNOWN_BANKS, hoặc dùng mã BIN) và trả về thông tin hoàn chỉnh
  const bankName = (env.BANK_NAME ?? "").trim() || KNOWN_BANKS[bin] || `BIN ${bin}`;
  return { bin, accountNo, accountName, bankName };
}
