/**
 * Cầu nối dịch thuật (i18n bridge) cho tầng dùng chung (src/shared/arena3/).
 * Giúp các module dữ liệu dùng chung (như labels.ts) thực hiện dịch văn bản mà không bị phụ thuộc trực tiếp vào mã nguồn client React (tránh circular dependency). Client (src/client/lib/i18n.tsx) sẽ nạp hàm dịch thực tế qua registerTranslator.
 */
type Translator = (en: string, vars?: Record<string, string | number>) => string;

let activeTranslator: Translator = (s) => s;

/**
 * Làm gì: Đăng ký hàm dịch thuật từ phía client vào tầng dùng chung. Giúp các hằng số nhãn ở shared dùng được từ điển và trạng thái ngôn ngữ hiện tại của client mà không gây phụ thuộc vòng (circular dependency).
 * Được gọi ở: src/client/lib/i18n.tsx (khi khởi tạo module client i18n).
 * @param fn Hàm dịch nhận vào chuỗi tiếng Anh và các biến nội suy, trả về chuỗi văn bản đã dịch.
 * @returns Không trả về giá trị.
 */
export function registerTranslator(fn: Translator) {
  activeTranslator = fn;
}

/**
 * Làm gì: Dịch chuỗi tiếng Anh sang ngôn ngữ hiện tại thông qua hàm activeTranslator đã đăng ký.
 * Được gọi ở: src/shared/arena3/labels.ts (trong lazyLabels khi truy cập giá trị của các bảng nhãn SPORT_LABEL, ROLE_LABEL, STATUS_LABEL,...).
 * @param en Chuỗi tiếng Anh gốc cần dịch.
 * @param vars Đối tượng chứa các biến nội suy để chèn vào chuỗi (nếu có).
 * @returns Chuỗi văn bản đã được dịch theo ngôn ngữ đang chọn, hoặc chuỗi tiếng Anh gốc nếu chưa dịch.
 */
export function t(en: string, vars?: Record<string, string | number>): string {
  return activeTranslator(en, vars);
}

/**
 * Làm gì: Hàm định danh (identity function) trả về nguyên gốc chuỗi tiếng Anh được truyền vào. Dùng để đánh dấu các chuỗi tĩnh ở phạm vi module cho công cụ kiểm tra (scripts/i18n-check.mjs) nhận diện cần dịch, thay vì dịch ngay lập tức khi nạp file.
 * Được gọi ở: src/shared/arena3/labels.ts (khi khai báo các bảng tra nhãn như SPORT_LABEL, ROLE_LABEL, LEVEL_LABEL, STATUS_LABEL,...).
 * @param en Chuỗi tiếng Anh gốc cần đánh dấu.
 * @returns Chính chuỗi tiếng Anh được truyền vào (giữ nguyên kiểu literal S).
 */
export const tk = <S extends string>(en: S): S => en;
