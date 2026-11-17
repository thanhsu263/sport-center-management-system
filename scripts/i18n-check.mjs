/**
 * Mục đích file:
 * Script kiểm tra tính đầy đủ của bộ từ điển đa ngôn ngữ (i18n tiếng Việt) trong toàn bộ mã nguồn `src/`.
 * Đối chiếu tất cả các key gọi qua hàm t() hoặc tk() với các file từ điển `src/client/lib/i18n/vi.*.ts`,
 * đảm bảo không bị thiếu bản dịch giao diện hoặc tồn tại khóa từ điển thừa không sử dụng.
 *
 * Vị trí trong hệ thống:
 * Công cụ kiểm thử chất lượng mã nguồn (QA / CI) chạy qua CLI, đảm bảo 100% văn bản hiển thị
 * trên giao diện người dùng đều được bản địa hóa sang tiếng Việt trước khi xuất bản.
 */
// Every t("…") / tk("…") literal in src must have a Vietnamese entry.
//   node scripts/i18n-check.mjs            -> lists missing keys (exit 1 if any)
//   node scripts/i18n-check.mjs --unused   -> also lists dictionary keys no code uses
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Làm gì: Duyệt đệ quy cây thư mục trên đĩa để thu thập danh sách đường dẫn tất cả các tệp mã nguồn TypeScript (.ts, .tsx).
 * Được gọi ở: scripts/i18n-check.mjs (dòng 29, quét mã nguồn thư mục src để tìm các lệnh gọi hàm t và tk).
 * - Tham số d: Đường dẫn thư mục gốc cần bắt đầu duyệt đệ quy (ví dụ: "src").
 * - Trả về: Danh sách đường dẫn của tất cả các file .ts và .tsx tìm thấy.
 * - Lỗi có thể ném: Lỗi từ readdirSync hoặc statSync nếu đường dẫn không tồn tại hoặc thiếu quyền đọc.
 */
const walk = (d) =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    // Đệ quy nếu là thư mục con; nếu là file .ts/.tsx thì đưa vào danh sách kết quả, các file định dạng khác thì bỏ qua.
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) ? [p] : [];
  });

// Ký tự dấu gạch chéo ngược (backslash '\', mã ASCII 92), dùng để tạo biểu thức chính quy (regex) động mà không bị lỗi escape trong template string.
const BS = String.fromCharCode(92);
/**
 * Làm gì: Tạo chuỗi biểu thức chính quy (regex pattern) để khớp chuỗi ký tự trong dấu ngoặc kép hoặc ngoặc đơn, hỗ trợ ký tự escape và không chứa dòng mới thô.
 * Được gọi ở: scripts/i18n-check.mjs (tạo regex keyRe dòng 21 và callRe dòng 28).
 * - Tham số c: Ký tự dấu nháy bao quanh chuỗi (dấu nháy đơn ' hoặc nháy kép ").
 * - Trả về: Chuỗi regex pattern dùng để ghép vào đối tượng RegExp.
 */
const q = (c) => `${c}(?:[^${c}${BS}${BS}${BS}n]|${BS}${BS}.)*${c}`;
/**
 * Làm gì: Phân tích chuỗi literal (có dấu nháy bao quanh), loại bỏ cặp nháy đầu cuối và giải mã các ký tự escape (ví dụ: biến \n thành ký tự xuống dòng thực tế).
 * Được gọi ở: scripts/i18n-check.mjs (trích xuất key từ file từ điển dòng 24 và từ lệnh gọi t/tk dòng 32).
 * - Tham số lit: Chuỗi literal thô khớp được từ regex (bao gồm cả dấu nháy đơn hoặc nháy kép ở hai đầu).
 * - Trả về: Nội dung chuỗi bên trong sau khi đã giải mã ký tự escape.
 */
const parseLit = (lit) => {
  // Bước 1: Cắt bỏ cặp dấu nháy ở đầu và cuối chuỗi literal để lấy phần nội dung cốt lõi.
  const body = lit.slice(1, -1);
  // Bước 2: Giải mã các ký tự escape (\n thành ký tự xuống dòng thực, các ký tự escape khác như \', \" giữ nguyên ký tự phía sau dấu backslash).
  return body.replace(new RegExp(`${BS}${BS}(.)`, "g"), (_, c) => (c === "n" ? "\n" : c));
};

// Bảng ánh xạ từ điển: lưu trữ các cặp [translation_key, tên_file_từ_điển] đọc từ các file src/client/lib/i18n/vi.*.ts.
const dictKeys = new Map();
// Regex khớp dòng khai báo key trong object từ điển TypeScript: bắt đầu dòng, có key trong dấu nháy và theo sau là dấu hai chấm (:).
const keyRe = new RegExp(`^${BS}s*(${q('"')}|${q("'")})${BS}s*:${BS}s*`, "gm");
// Bước 1: Quét tất cả các file từ điển tiếng Việt (vi.*.ts) trong src/client/lib/i18n để nạp toàn bộ key hợp lệ vào dictKeys.
for (const f of readdirSync("src/client/lib/i18n").filter((f) => /^vi.(core|pub|public|member|desk|manager|ops|srv|redesign).ts$/.test(f))) {
  const src = readFileSync(join("src/client/lib/i18n", f), "utf8");
  for (const m of src.matchAll(keyRe)) dictKeys.set(parseLit(m[1]), f);
}

// Bảng lưu trữ các translation key thực tế được gọi trong mã nguồn: lưu cặp [translation_key, file_mã_nguồn_đầu_tiên_sử_dụng].
const used = new Map();
// Regex khớp lệnh gọi hàm t("...") hoặc tk("..."), dùng negative lookbehind (?<![\w.]) để tránh khớp nhầm thuộc tính object hoặc tên hàm khác kết thúc bằng t.
const callRe = new RegExp(`(?<![${BS}w.])(?:t|tk)${BS}(${BS}s*(${q('"')}|${q("'")})`, "g");
// Bước 2: Quét tất cả các file .ts/.tsx trong src (loại trừ thư mục i18n) để trích xuất các translation key đang được sử dụng.
for (const file of walk("src").filter((f) => !f.includes("i18n"))) {
  const src = readFileSync(file, "utf8");
  for (const m of src.matchAll(callRe)) {
    const key = parseLit(m[1]);
    if (!used.has(key)) used.set(key, file);
  }
}

// Bước 3: Lọc ra các key có trong mã nguồn nhưng chưa được định nghĩa trong bất kỳ file từ điển nào (missing keys).
const missing = [...used].filter(([k]) => !dictKeys.has(k));
console.log(`${used.size} keys used, ${dictKeys.size} in dictionary, ${missing.length} missing`);
for (const [k, f] of missing) console.log(`  MISSING [${f}] ${JSON.stringify(k)}`);
// Bước 4: Nếu có cờ --unused, kiểm tra các key trong từ điển nhưng không còn file mã nguồn nào sử dụng (hỗ trợ dọn dẹp mã nguồn thừa).
if (process.argv.includes("--unused")) {
  const unused = [...dictKeys].filter(([k]) => !used.has(k));
  console.log(`${unused.length} unused dictionary keys`);
  for (const [k, f] of unused.slice(0, 80)) console.log(`  UNUSED [${f}] ${JSON.stringify(k)}`);
}
// Bước 5: Thoát mã lỗi 1 nếu có key bị thiếu để chặn CI build / pre-commit; thoát 0 nếu toàn bộ từ điển đã đầy đủ.
process.exit(missing.length ? 1 : 0);
