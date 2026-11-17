/**
 * VietQR (NAPAS) bank-transfer payloads: the EMVCo merchant-presented QR that every Vietnamese
 * banking app reads.
 *
 * The string is a run of tag-length-value fields; tag 38 names the receiving account (the NAPAS
 * GUID A000000727, the bank's BIN, the account number, service QRIBFTTA = transfer to an account)
 * and tag 63 closes it with a CRC16-CCITT (0xFFFF start, polynomial 0x1021) over everything
 * before it, "6304" included. A payload without that checksum is the one banking apps refuse.
 *
 * Pure functions, no imports: the node test runner checks them directly, and the desk box and
 * the member's booking card build the same string.
 */

/**
 * Làm gì: Định nghĩa kiểu dữ liệu tài khoản ngân hàng thụ hưởng cho VietQR, bao gồm mã định danh ngân hàng (bin) và số tài khoản (accountNo).
 * Được gọi ở: src/server/integrations/bank.ts (type CentreBank), src/client/components/transfer-qr-modal.tsx, src/shared/vietqr.ts.
 */
export type BankAccount = {
  /** Six-digit NAPAS bank identifier, e.g. 970422 for MB. */
  bin: string;
  accountNo: string;
};

/**
 * Làm gì: Đóng gói một trường dữ liệu theo định dạng TLV (Tag-Length-Value) chuẩn EMVCo, gồm 2 chữ số mã tag (id), 2 chữ số độ dài (length) và chuỗi giá trị (value).
 * Được gọi ở: Hàm nội bộ được gọi bởi vietQrPayload (src/shared/vietqr.ts).
 * @param id Mã định danh trường dữ liệu (Tag) gồm 2 chữ số (ví dụ: "00", "01", "38").
 * @param value Chuỗi giá trị cần đóng gói vào trường dữ liệu.
 * @returns Chuỗi định dạng TLV: `${id}${length}${value}`.
 */
const tlv = (id: string, value: string) => `${id}${String(value.length).padStart(2, "0")}${value}`;

/** CRC16-CCITT-FALSE as four upper-case hex digits. */
/**
 * Làm gì: Tính mã kiểm tra CRC16-CCITT chuẩn (thuật toán CRC16-CCITT-FALSE, giá trị khởi tạo 0xFFFF, đa thức 0x1021) trên chuỗi đầu vào và trả về 4 ký tự hex in hoa.
 * Được gọi ở: src/shared/vietqr.ts (hàm vietQrPayload), src/server/services/arena3.test.ts ("test runner (node --test)").
 * @param input Chuỗi dữ liệu cần tính mã kiểm tra CRC16 (toàn bộ payload trước tag 63 cộng thêm "6304").
 * @returns Chuỗi 4 ký tự hex in hoa đại diện cho mã CRC16 (ví dụ: "29B1").
 */
export function crc16(input: string): string {
  // Bước 1: Khởi tạo giá trị thanh ghi CRC với 0xFFFF theo chuẩn CRC16-CCITT/FALSE quy định bởi EMVCo.
  let crc = 0xffff;
  // Bước 2: Duyệt từng ký tự, XOR byte ký tự vào byte cao của thanh ghi CRC và xử lý dịch từng bit.
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit++) {
      // Dịch trái 1 bit; nếu bit cao nhất (0x8000) là 1 thì XOR với đa thức 0x1021 của chuẩn CCITT, giữ trong phạm vi 16-bit.
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  // Bước 3: Chuyển đổi giá trị số 16-bit thành chuỗi 4 chữ số hex in hoa (pad 0 ở đầu nếu chưa đủ 4 ký tự).
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/**
 * The transfer reference ("nội dung chuyển khoản") as banks carry it: plain upper-case ASCII,
 * letters, digits and spaces, at most 25 characters (the NAPAS limit for tag 62-08).
 */
/**
 * Làm gì: Chuẩn hóa chuỗi nội dung chuyển khoản thành ký tự ASCII in hoa không dấu, loại bỏ ký tự đặc biệt và cắt tối đa 25 ký tự theo giới hạn của NAPAS (tag 62-08).
 * Được gọi ở: src/shared/vietqr.ts (hàm vietQrPayload), src/client/components/transfer-qr-modal.tsx (component VietQrPanel), src/server/services/arena3.test.ts ("test runner (node --test)").
 * @param text Chuỗi nội dung chuyển khoản gốc (có thể chứa tiếng Việt có dấu, khoảng trắng thừa hoặc ký tự đặc biệt).
 * @returns Chuỗi nội dung chuyển khoản đã được làm sạch, chỉ gồm chữ in hoa A-Z, chữ số 0-9 và dấu cách, dài tối đa 25 ký tự.
 */
export function transferReference(text: string): string {
  // Bước 1: Khử dấu tiếng Việt bằng NFD, chuyển 'đ/Đ' thành 'd/D', in hoa và thay thế ký tự đặc biệt bằng khoảng trắng để tránh lỗi font trên hệ thống ngân hàng.
  // Bước 2: Cắt gọn khoảng trắng thừa và giới hạn tối đa 25 ký tự theo đúng quy định NAPAS cho tag 62 sub-tag 08.
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 25)
    .trim();
}

/** Whether an account can go into a payload at all. */
/**
 * Làm gì: Kiểm tra tính hợp lệ của thông tin tài khoản ngân hàng (mã BIN đúng 6 chữ số, số tài khoản từ 4 đến 19 ký tự chữ và số) để đảm bảo có thể đóng gói vào VietQR.
 * Được gọi ở: src/server/integrations/bank.ts (hàm centreBank), src/shared/vietqr.ts (hàm vietQrPayload), src/server/services/arena3.test.ts ("test runner (node --test)").
 * @param a Đối tượng tài khoản ngân hàng cần kiểm tra (có thể khuyết trường, null hoặc undefined).
 * @returns true nếu tài khoản hợp lệ chuẩn BankAccount (BIN 6 chữ số, số tài khoản 4-19 ký tự), ngược lại false.
 */
export function validBankAccount(a: Partial<BankAccount> | null | undefined): a is BankAccount {
  // Kiểm tra theo chuẩn NAPAS: mã BIN ngân hàng phải đủ 6 chữ số và số tài khoản dài từ 4 đến 19 ký tự chữ/số.
  return !!a && /^\d{6}$/.test(a.bin ?? "") && /^[0-9A-Za-z]{4,19}$/.test(a.accountNo ?? "");
}

/**
 * A VietQR payload for a transfer of `amountVnd` (whole dong, omitted for an open amount) with
 * `reference` as its content. Throws on an account that cannot be encoded.
 */
/**
 * Làm gì: Tạo chuỗi payload VietQR chuẩn EMVCo hoàn chỉnh (kèm mã kiểm tra CRC16 ở cuối) phục vụ thanh toán chuyển khoản ngân hàng qua quét mã QR.
 * Được gọi ở: src/client/components/transfer-qr-modal.tsx (component VietQrPanel), src/server/services/arena3.test.ts ("test runner (node --test)").
 * @param account Thông tin tài khoản thụ hưởng gồm mã BIN 6 chữ số và số tài khoản ngân hàng.
 * @param amountVnd Số tiền thanh toán bằng VNĐ (số nguyên dương; nếu bỏ trống hoặc <= 0 thì mã QR sẽ để người chuyển tự nhập tiền).
 * @param reference Nội dung chuyển khoản (sẽ được chuẩn hóa thành ASCII in hoa không dấu, tối đa 25 ký tự).
 * @returns Chuỗi payload VietQR hợp lệ chuẩn EMVCo sẵn sàng chuyển thành hình ảnh mã QR.
 * @throws Error Nếu thông tin tài khoản ngân hàng không hợp lệ (mã BIN không đủ 6 chữ số hoặc số tài khoản không đúng định dạng).
 */
export function vietQrPayload(account: BankAccount, amountVnd?: number, reference?: string): string {
  // Bước 1: Kiểm tra tài khoản thụ hưởng; từ chối ngay nếu không đúng chuẩn để tránh tạo mã QR hỏng khiến người dùng quét lỗi.
  if (!validBankAccount(account)) throw new Error("A VietQR account needs a 6-digit BIN and an account number.");
  // Bước 2: Chuẩn hóa số tiền làm tròn đồng nguyên (nếu có) và làm sạch nội dung chuyển khoản theo chuẩn NAPAS.
  const amount = amountVnd != null && amountVnd > 0 ? String(Math.round(amountVnd)) : "";
  const note = reference ? transferReference(reference) : "";
  // Bước 3: Đóng gói thông tin tài khoản nhận tiền vào Tag 38: GUID NAPAS (A000000727), thông tin ngân hàng (BIN + STK), và mã dịch vụ chuyển nhanh (QRIBFTTA).
  const merchant = tlv("00", "A000000727") + tlv("01", tlv("00", account.bin) + tlv("01", account.accountNo)) + tlv("02", "QRIBFTTA");
  // Bước 4: Ghép toàn bộ các trường dữ liệu EMVCo: phiên bản (tag 00), phương thức (tag 01: 12 là động có số tiền cố định, 11 là tĩnh người trả tự nhập), thông tin nhận tiền (tag 38), đơn vị tiền tệ VNĐ (tag 53: 704), số tiền (tag 54 nếu có), quốc gia (tag 58: VN), nội dung (tag 62), và tag 63 với độ dài 04.
  const body =
    tlv("00", "01") +
    // 12 = dynamic (amount fixed for this one payment), 11 = static (the payer types it).
    tlv("01", amount ? "12" : "11") +
    tlv("38", merchant) +
    tlv("53", "704") +
    (amount ? tlv("54", amount) : "") +
    tlv("58", "VN") +
    (note ? tlv("62", tlv("08", note)) : "") +
    "6304";
  // Bước 5: Tính toán mã CRC16 trên toàn bộ chuỗi body (bao gồm cả "6304") và ghép vào cuối chuỗi để hoàn thiện payload chuẩn EMVCo.
  return body + crc16(body);
}

/** Split a payload back into its top-level fields (for tests and debugging). */
/**
 * Làm gì: Phân tích cú pháp (parse) chuỗi payload EMVCo ngược lại thành danh sách các cặp key-value ở cấp ngoài cùng (phục vụ viết test và kiểm tra lỗi).
 * Được gọi ở: src/server/services/arena3.test.ts ("test runner (node --test)").
 * @param payload Chuỗi dữ liệu TLV cần bóc tách.
 * @returns Object chứa các cặp [mã Tag]: [Giá trị Value] tương ứng.
 */
export function readTlv(payload: string): Record<string, string> {
  // Bước 1: Khởi tạo đối tượng lưu trữ các trường dữ liệu và con trỏ đọc chuỗi.
  const out: Record<string, string> = {};
  let i = 0;
  // Bước 2: Lặp khi chuỗi còn đủ ít nhất 4 ký tự (2 ký tự mã Tag ID + 2 ký tự độ dài Length).
  while (i + 4 <= payload.length) {
    const id = payload.slice(i, i + 2);
    const len = Number(payload.slice(i + 2, i + 4));
    // Dừng phân tích nếu độ dài không phải số hợp lệ để tránh vòng lặp vô hạn khi payload bị lỗi cấu trúc.
    if (!Number.isInteger(len)) break;
    // Bước 3: Trích xuất phần giá trị (Value) theo độ dài đã đọc và di chuyển con trỏ qua trường tiếp theo.
    out[id] = payload.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  // Bước 4: Trả về bảng ánh xạ các trường TLV đã phân tích.
  return out;
}
