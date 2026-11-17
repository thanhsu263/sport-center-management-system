/**
 * Mục đích file:
 * Tiện ích xử lý và chuẩn hóa chuỗi dữ liệu đầu vào (chuẩn hóa số điện thoại di động Việt Nam, bỏ dấu tiếng Việt để tìm kiếm, kiểm tra mật khẩu).
 *
 * Vị trí trong hệ thống:
 * Được gọi bởi các tầng nghiệp vụ (auth, members, bookings, staff, checkin, ops) để validate và làm sạch dữ liệu người dùng trước khi ghi vào database.
 */
/** Last 9 digits of a VN mobile, or null if the input is not a number. */
/**
 * Làm gì: Trích xuất 9 chữ số cuối của số điện thoại di động Việt Nam (bỏ mã quốc gia 84 và số 0 ở đầu).
 * Được gọi ở: src/server/services/phone.ts (normalizePhone), src/server/controllers/handlers/members.ts (membersSearch), src/server/services/arena3.test.ts.
 * @param raw Chuỗi số điện thoại thô do người dùng nhập hoặc từ khóa tìm kiếm (có thể lẫn khoảng trắng, dấu chấm, gạch nối hoặc tiền tố +84/0).
 * @returns Chuỗi 9 chữ số cuối nếu đúng định dạng số di động Việt Nam, hoặc null nếu không hợp lệ.
 * @throws Không chủ động ném lỗi.
 */
export function phoneLast9(raw: string): string | null {
  // Bước 1: Loại bỏ toàn bộ ký tự không phải chữ số (\D) như khoảng trắng, dấu chấm, gạch nối
  let d = raw.replace(/\D/g, "");
  // Bước 2: Cắt bỏ mã quốc gia 84 hoặc số 0 ở đầu nếu có để lấy 9 số thuê bao cốt lõi
  if (d.startsWith("84")) d = d.slice(2);
  if (d.startsWith("0")) d = d.slice(1);
  // Bước 3: Kiểm tra nếu còn đúng 9 chữ số (\d{9}) thì trả về chuỗi 9 số, ngược lại trả về null
  return /^\d{9}$/.test(d) ? d : null;
}

/**
 * Làm gì: Chuẩn hóa số điện thoại về định dạng chuẩn quốc tế E.164 (+84 kèm 9 chữ số cuối) để lưu trữ nhất quán trong database.
 * Được gọi ở: handlers/auth.ts (đăng ký, gửi/xác thực OTP, đăng nhập), handlers/members.ts (tạo/sửa hội viên), handlers/bookings.ts, handlers/staff.ts, handlers/checkin.ts.
 * @param raw Chuỗi số điện thoại thô do người dùng nhập vào.
 * @returns Chuỗi số điện thoại đã chuẩn hóa về định dạng +84... hoặc chuỗi đã dọn sạch ký tự phân cách nếu không lấy được 9 số cuối.
 * @throws Không chủ động ném lỗi.
 */
export function normalizePhone(raw: string): string {
  // Bước 1: Trích xuất 9 chữ số cuối của thuê bao di động qua hàm phoneLast9
  const tail = phoneLast9(raw);
  // Bước 2: Nếu lấy được 9 chữ số hợp lệ, ghép với tiền tố quốc gia +84 theo chuẩn E.164
  if (tail) return `+84${tail}`;
  // Bước 3: Nếu không khớp 9 chữ số, dọn sạch khoảng trắng và ký tự phân cách để trả về chuỗi sạch cho tầng sau validate
  return raw.trim().replace(/[\s.-]/g, "");
}

/**
 * Làm gì: Kiểm tra chuỗi số điện thoại có phải là số di động hợp lệ tại Việt Nam (đầu số 03, 05, 07, 08, 09) hay không.
 * Được gọi ở: handlers/auth.ts (validate SĐT khi đăng ký/đổi SĐT), handlers/members.ts (validate SĐT hội viên/giám hộ), handlers/bookings.ts (khách đặt sân), handlers/staff.ts, handlers/extras.ts.
 * @param p Chuỗi số điện thoại cần kiểm tra tính hợp lệ.
 * @returns true nếu là số di động Việt Nam hợp lệ sau khi chuẩn hóa, ngược lại false.
 * @throws Không chủ động ném lỗi.
 */
export function isValidVnPhone(p: string): boolean {
  // Chuẩn hóa về dạng +84 rồi đối soát regex ^\+84[3-9]\d{8}$: đầu số di động VN sau +84 phải từ 3 đến 9 (tương ứng 03x-09x) và theo sau đúng 8 chữ số
  return /^\+84[3-9]\d{8}$/.test(normalizePhone(p));
}

/**
 * Làm gì: Chuyển đổi chuỗi tiếng Việt có dấu thành không dấu, viết thường và chuẩn hóa khoảng trắng để lưu cột name_normalized phục vụ tìm kiếm.
 * Được gọi ở: handlers/auth.ts (lưu name_normalized của user), handlers/members.ts (tìm kiếm hội viên, tạo/sửa hồ sơ), handlers/staff.ts (tìm kiếm và tạo tài khoản staff).
 * @param s Chuỗi văn bản tiếng Việt có dấu cần loại bỏ dấu.
 * @returns Chuỗi ký tự không dấu viết thường, đã xóa dấu thanh và cắt tỉa khoảng trắng.
 * @throws Không chủ động ném lỗi.
 */
export function unaccentVi(s: string): string {
  // Chuẩn hóa chuỗi qua các bước:
  // 1. Dùng Unicode NFD để phân tách ký tự gốc và dấu thanh kết hợp
  // 2. Xóa toàn bộ ký tự dấu thanh trong dải Unicode \u0300-\u036f
  // 3. Thay thế chữ đ/Đ thành d/D (do chuẩn NFD không phân rã chữ đ tiếng Việt)
  // 4. Chuyển về chữ thường, gộp khoảng trắng liên tiếp và cắt tỉa hai đầu chuỗi
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Làm gì: Kiểm tra mật khẩu có đáp ứng chính sách bảo mật tối thiểu của hệ thống hay không (độ dài tối thiểu 8 ký tự, có cả chữ cái và chữ số).
 * Được gọi ở: handlers/auth.ts (authRegister, authResetPassword, authChangePassword), src/server/services/arena3.test.ts.
 * @param pw Chuỗi mật khẩu dạng plain text cần kiểm tra.
 * @returns true nếu mật khẩu thỏa mãn chính sách bảo mật (>= 8 ký tự, gồm cả chữ và số), ngược lại false.
 * @throws Không chủ động ném lỗi.
 */
export function passwordOk(pw: string): boolean {
  // Kiểm tra điều kiện chính sách mật khẩu: độ dài tối thiểu 8 ký tự, phải có ít nhất 1 chữ cái ([A-Za-z]) và ít nhất 1 chữ số (\d)
  return pw.length >= 8 && /[A-Za-z]/.test(pw) && /\d/.test(pw);
}
