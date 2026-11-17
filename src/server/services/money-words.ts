/**
 * File: src/server/services/money-words.ts
 * Vai trò: Chuyển đổi số tiền VND dạng số thành chữ tiếng Việt chuẩn quy cách kế toán và hóa đơn tài chính ("số tiền bằng chữ").
 * Vị trí trong app: Chạy ở tầng server, được sử dụng khi render hóa đơn PDF (src/server/integrations/pdf.ts) và kiểm thử qua test suite (src/server/services/arena3.test.ts).
 */
/**
 * Read a VND amount out in Vietnamese words.
 *
 * A Vietnamese invoice is not complete without "số tiền bằng chữ": the figure
 * spelled out is what settles a dispute when the digits are smudged, altered
 * or misread, so it is a required field rather than a courtesy.
 *
 * The rules that are easy to get wrong, and that the tests pin down:
 *   - 1 after a tens digit of 2..9 is "mốt", not "một"  (21 → hai mươi mốt)
 *   - 5 after any tens digit is "lăm", not "năm"        (15 → mười lăm)
 *   - a tens digit of 1 is "mười", not "một mươi"       (15 → mười lăm)
 *   - a zero in the tens column is spoken as "linh"     (105 → một trăm linh năm)
 *   - an interior group with no hundreds still says "không trăm"
 *     (1_005 → một nghìn không trăm linh năm), because dropping it would read
 *     back as 1_050.
 */

const DIGITS = ["không", "một", "hai", "ba", "bốn", "năm", "sáu", "bảy", "tám", "chín"];

/** Group scales, smallest first. An INT column tops out inside "tỷ". */
const SCALES = ["", "nghìn", "triệu", "tỷ", "nghìn tỷ", "triệu tỷ"];

/**
 * Spell one 3-digit group.
 *
 * `withLeadingHundreds` is set for every group except the most significant
 * one, where "không trăm" would be noise rather than a place-holder.
 */
/**
 * Làm gì: Đọc một nhóm 3 chữ số (từ 0 đến 999) thành chữ tiếng Việt theo đúng quy tắc ngữ pháp (xử lý hàng trăm, mươi/mười, mốt, lăm, linh).
 * Được gọi ở: Nội bộ file src/server/services/money-words.ts (hàm numberToVietnamese).
 * @param n Số nguyên từ 0 đến 999 cần đọc thành lời.
 * @param withLeadingHundreds Cờ xác định có đọc "không trăm" hay không khi hàng trăm bằng 0 (áp dụng cho các nhóm đứng sau nhóm cao nhất).
 * @returns Chuỗi từ tiếng Việt biểu diễn giá trị của nhóm 3 chữ số.
 */
function readGroup(n: number, withLeadingHundreds: boolean): string {
  // Bước 1: Tách số thành 3 thành phần: hàng trăm, hàng chục và hàng đơn vị
  const hundreds = Math.floor(n / 100);
  const tens = Math.floor((n % 100) / 10);
  const units = n % 10;
  const out: string[] = [];

  // Bước 2: Đọc chữ số hàng trăm; nếu hàng trăm bằng 0 ở nhóm giữa thì đọc "không trăm" để giữ hàng số
  if (hundreds > 0) {
    out.push(DIGITS[hundreds]!, "trăm");
  } else if (withLeadingHundreds && (tens > 0 || units > 0)) {
    out.push("không", "trăm");
  }

  // Bước 3: Đọc chữ số hàng chục và hàng đơn vị theo các quy tắc chính tả đặc thù trong tiếng Việt
  if (tens > 1) {
    out.push(DIGITS[tens]!, "mươi");
    // Hàng chục >= 2: số 1 đọc là "mốt" (21 -> hai mươi mốt), số 5 đọc là "lăm" (25 -> hai mươi lăm)
    if (units === 1) out.push("mốt");
    else if (units === 5) out.push("lăm");
    else if (units > 0) out.push(DIGITS[units]!);
  } else if (tens === 1) {
    // Hàng chục là 1 đọc là "mười": số 5 đọc là "lăm" (15 -> mười lăm), số 1 giữ nguyên "một" (11 -> mười một)
    out.push("mười");
    if (units === 5) out.push("lăm");
    else if (units > 0) out.push(DIGITS[units]!);
  } else if (units > 0) {
    // Hàng chục bằng 0 nhưng có hàng đơn vị: chèn từ "linh" nếu có hàng trăm phía trước (ví dụ: 105 -> một trăm linh năm)
    if (hundreds > 0 || withLeadingHundreds) out.push("linh");
    out.push(DIGITS[units]!);
  }

  // Bước 4: Nối các từ lại thành chuỗi hoàn chỉnh phân tách bằng dấu cách
  return out.join(" ");
}

/** Spell a non-negative integer. `0` is "không". */
/**
 * Làm gì: Chuyển đổi một số nguyên không âm thành chuỗi chữ tiếng Việt đầy đủ theo các lớp đơn vị (nghìn, triệu, tỷ...).
 * Được gọi ở: src/server/services/money-words.ts (hàm vndInWords); test runner (node --test trong src/server/services/arena3.test.ts).
 * @param value Giá trị số cần đọc thành chữ (tự động lấy trị tuyệt đối và làm tròn thành số nguyên).
 * @returns Chuỗi đọc số bằng chữ tiếng Việt (ví dụ: "một triệu hai trăm nghìn").
 */
export function numberToVietnamese(value: number): string {
  // Bước 1: Chuẩn hóa số đầu vào thành số nguyên không âm; nếu bằng 0 trả về "không"
  const n = Math.floor(Math.abs(value));
  if (n === 0) return "không";

  // Split into 3-digit groups, least significant first.
  // Bước 2: Tách số thành từng nhóm 3 chữ số từ hàng thấp đến cao (lưu vào mảng groups)
  const groups: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 1000)) {
    groups.push(rest % 1000);
  }
  if (groups.length > SCALES.length) {
    // Beyond what a VND invoice can hold; fall back to digits rather than
    // inventing a scale name.
    return n.toLocaleString("vi-VN");
  }

  // Bước 3: Đọc lần lượt từng nhóm 3 chữ số từ hàng cao nhất xuống thấp và ghép với tên đơn vị (tỷ, triệu, nghìn)
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const group = groups[i]!;
    // A zero group carries no words, but its scale must not be spoken either.
    if (group === 0) continue;
    // Nhóm cao nhất không đọc "không trăm", các nhóm phía sau nếu hàng trăm bằng 0 thì phải đọc "không trăm"
    const words = readGroup(group, i !== groups.length - 1);
    parts.push(SCALES[i] ? `${words} ${SCALES[i]}` : words);
  }
  // Bước 4: Ghép các cụm từ lại thành chuỗi hoàn chỉnh ngăn cách bởi khoảng trắng
  return parts.join(" ");
}

/**
 * The "số tiền bằng chữ" line: capitalised, in đồng, closed with a full stop.
 *
 * The trailing "./." is the convention on Vietnamese invoices — it marks the
 * end of the amount so nothing can be appended to it after the fact.
 */
/**
 * Làm gì: Chuyển đổi số tiền VND sang câu chữ tiếng Việt chuẩn quy cách hóa đơn tài chính (viết hoa chữ đầu, thêm đơn vị "đồng", kết thúc bằng "./.").
 * Được gọi ở: src/server/integrations/pdf.ts (hàm drawTotals khi in hóa đơn PDF); test runner (node --test trong src/server/services/arena3.test.ts).
 * @param amountVnd Số tiền bằng đồng Việt Nam (VND), hỗ trợ cả số âm (thêm tiền tố "âm").
 * @returns Chuỗi "số tiền bằng chữ" chuẩn hóa đơn (ví dụ: "Chín trăm nghìn đồng./.").
 */
export function vndInWords(amountVnd: number): string {
  // Assemble the whole sentence before capitalising: prefixing "âm" afterwards
  // would leave the capital stranded mid-line ("Âm Năm mươi nghìn đồng").
  // Bước 1: Tạo chuỗi đọc số hoàn chỉnh kèm tiền tố số âm (nếu có) và hậu tố đơn vị "đồng"
  const sentence = `${amountVnd < 0 ? "âm " : ""}${numberToVietnamese(amountVnd)} đồng`;
  // Bước 2: Viết hoa ký tự đầu tiên và đóng đuôi "./." theo quy chuẩn hóa đơn tài chính
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}./.`;
}
