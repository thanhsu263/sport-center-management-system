/**
 * Mục đích file:
 * Xuất dữ liệu báo cáo thống kê của trung tâm thể thao thành file Excel (.xlsx) và file PDF.
 * Tạo bảng tính Excel bằng XML thủ công và nén bằng fflate (không phụ thuộc thư viện nặng),
 * đồng thời kết xuất file PDF chuẩn xác bằng pdf-lib có nhúng font tiếng Việt Roboto.
 *
 * Vị trí trong hệ thống:
 * Thuộc tầng data/tiện ích xuất báo cáo của backend.
 * Được gọi bởi src/server/controllers/handlers/reports.ts (hàm reportsExport) để phục vụ endpoint GET /api/reports/:kind/export.
 */
import fontkit from "@pdf-lib/fontkit";
import { zipSync, strToU8 } from "fflate";
import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import robotoBoldUrl from "../integrations/fonts/Roboto-Bold.ttf?inline";
import robotoRegularUrl from "../integrations/fonts/Roboto-Regular.ttf?inline";

/**
 * Report files (FR-PAY-07): the same document as .xlsx and as .pdf.
 *
 * A report is built once as a `ReportDoc` — a title, the filters the manager
 * chose, and some tables — and the two writers only differ in how they lay it
 * out. That keeps the screen, the spreadsheet and the printout from drifting
 * apart, and puts the chosen filters in the header of every file (UC-22 step 4).
 *
 * The workbook is written by hand (a zip of a few XML parts, via `fflate`) so
 * there is no heavyweight spreadsheet library in the server bundle. Strings are
 * inline, numbers stay numbers, so Excel and Google Sheets can sum a column.
 */

export type Cell = string | number | null;

export type ReportSection = {
  name: string;
  columns: string[];
  rows: Cell[][];
  /** A last row of totals, drawn bold. */
  total?: Cell[];
  note?: string;
};

export type ReportDoc = {
  title: string;
  filters: [string, string][];
  generated_at: string;
  sections: ReportSection[];
};

const XML_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;
// Giới hạn số dòng tối đa được lấy mẫu để ước lượng độ rộng (width) cột trong Excel, tránh duyệt hết bảng nếu dữ liệu lớn.
const COLUMN_WIDTH_SAMPLE_SIZE = 200;

/**
 * Làm gì: Thoát (escape) các ký tự đặc biệt để tạo XML hợp lệ theo chuẩn XML 1.0, loại bỏ ký tự điều khiển và mã hóa &, <, >, ".
 * Được gọi ở: src/server/data/report-files.ts (hàm textCell, buildXlsx).
 * @param s Chuỗi văn bản thô cần làm sạch và mã hóa XML.
 * @returns Chuỗi văn bản đã được lọc ký tự cấm và mã hóa an toàn cho XML.
 */
function esc(s: string): string {
  // Control characters are not allowed in XML 1.0, tabs and line breaks aside.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Làm gì: Chuyển đổi chỉ số cột dạng số (0-indexed) thành tên cột chữ cái chuẩn của Excel (A, B, ..., Z, AA, AB, ...).
 * Được gọi ở: src/server/data/report-files.ts (hàm sheetXml).
 * @param index Chỉ số cột bắt đầu từ 0 (0 là A, 1 là B, 26 là AA).
 * @returns Tên cột dạng chữ cái viết hoa trong bảng tính Excel.
 */
function colName(index: number): string {
  let columnNumber = index + 1;
  let name = "";
  // Chuyển đổi sang hệ cơ số 26 (từ A-Z) từ phải sang trái để tính từng ký tự tên cột.
  while (columnNumber > 0) {
    const letterIndex = (columnNumber - 1) % 26;
    name = String.fromCharCode(65 + letterIndex) + name;
    columnNumber = Math.floor((columnNumber - 1) / 26);
  }
  return name;
}

/**
 * Làm gì: Chuẩn hóa và tạo danh sách tên trang tính (sheet) duy nhất cho Excel, tuân thủ giới hạn tối đa 31 ký tự và loại bỏ ký tự cấm.
 * Được gọi ở: src/server/data/report-files.ts (hàm buildXlsx).
 * @param sections Danh sách các phần (section) của báo cáo cần tạo sheet.
 * @returns Mảng các tên sheet hợp lệ, không trùng lặp (không phân biệt hoa thường).
 */
/** Sheet names: 31 characters, no `[]:*?/\`, unique. */
function sheetNames(sections: ReportSection[]): string[] {
  const seen = new Set<string>();
  return sections.map((s, i) => {
    // Loại bỏ các ký tự bị Excel cấm trong tên sheet: [ ] : * ? / \ và giới hạn tối đa 28 ký tự để chừa chỗ đánh số trùng lặp.
    const base = s.name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 28) || `Sheet${i + 1}`;
    let name = base;
    let n = 2;
    // Nếu tên sheet đã tồn tại (không phân biệt hoa thường), tự động thêm hậu tố " 2", " 3",... để đảm bảo tính duy nhất.
    while (seen.has(name.toLowerCase())) name = `${base.slice(0, 26)} ${n++}`;
    seen.add(name.toLowerCase());
    return name;
  });
}

/**
 * Làm gì: Tạo thẻ XML biểu diễn ô chứa văn bản (inlineStr) trong Excel kèm tọa độ ô và kiểu định dạng (style).
 * Được gọi ở: src/server/data/report-files.ts (hàm sheetXml, anyCell).
 * @param ref Tọa độ ô Excel (ví dụ: 'A1', 'B2').
 * @param v Chuỗi văn bản cần ghi vào ô.
 * @param style Mã định dạng kiểu ô (0: thường, 1: in đậm, 2: tiêu đề in đậm cỡ 14, 3: tiêu đề cột in đậm có nền).
 * @returns Chuỗi XML thẻ <c> định dạng inlineStr.
 */
// Style ids: 0 plain, 1 bold, 2 bold title, 3 header row (bold, filled).
function textCell(ref: string, v: string, style = 0): string {
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}
/**
 * Làm gì: Tạo thẻ XML biểu diễn ô chứa giá trị số trong Excel để người dùng có thể thực hiện tính toán và tính tổng (sum).
 * Được gọi ở: src/server/data/report-files.ts (hàm anyCell).
 * @param ref Tọa độ ô Excel (ví dụ: 'C5').
 * @param v Giá trị số ghi vào ô (nếu không phải số hữu hạn sẽ lưu là 0 để tránh lỗi XML).
 * @param style Mã định dạng kiểu ô (0: thường, 1: in đậm).
 * @returns Chuỗi XML thẻ <c> định dạng số với thẻ giá trị <v>.
 */
function numCell(ref: string, v: number, style = 0): string {
  return `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${Number.isFinite(v) ? v : 0}</v></c>`;
}
/**
 * Làm gì: Tạo thẻ XML cho ô dữ liệu bất kỳ, tự động phân biệt kiểu số hoặc kiểu chuỗi, bỏ qua ô rỗng/null.
 * Được gọi ở: src/server/data/report-files.ts (hàm sheetXml khi duyệt các hàng dữ liệu và dòng tổng cộng).
 * @param ref Tọa độ ô Excel (ví dụ: 'A5', 'D10').
 * @param v Giá trị ô (số, chuỗi hoặc null/undefined).
 * @param style Mã định dạng kiểu ô áp dụng.
 * @returns Chuỗi XML của ô tương ứng, hoặc chuỗi rỗng nếu ô không có dữ liệu.
 */
function anyCell(ref: string, v: Cell, style = 0): string {
  if (v === null || v === undefined || v === "") return "";
  return typeof v === "number" ? numCell(ref, v, style) : textCell(ref, String(v), style);
}

/**
 * Làm gì: Sinh nội dung XML của một trang tính (worksheet) bao gồm khối tiêu đề, bộ lọc, dữ liệu bảng và tính toán độ rộng cột.
 * Được gọi ở: src/server/data/report-files.ts (hàm buildXlsx cho từng section).
 * @param doc Tài liệu báo cáo chứa tiêu đề, bộ lọc và thời gian xuất.
 * @param s Phần nội dung báo cáo (section) chứa danh sách cột, các hàng dữ liệu và dòng tổng cộng.
 * @returns Chuỗi XML hoàn chỉnh của một worksheet theo chuẩn OpenXML SpreadsheetML.
 */
function sheetXml(doc: ReportDoc, s: ReportSection): string {
  // Bước 1: Khởi tạo mảng lưu các hàng XML và chỉ số hàng r (bắt đầu từ 1 trong Excel).
  const rows: string[] = [];
  let r = 1;
  const push = (cells: string[]) => rows.push(`<row r="${r++}">${cells.join("")}</row>`);
  // Bước 2: Ghi khối tiêu đề báo cáo, các tiêu chí lọc (filters), thời điểm tạo và ghi chú nếu có.
  push([textCell(`A${r}`, doc.title, 2)]);
  for (const [k, v] of doc.filters) push([textCell(`A${r}`, k, 1), textCell(`B${r}`, v)]);
  push([textCell(`A${r}`, "Generated", 1), textCell(`B${r}`, doc.generated_at)]);
  if (s.note) push([textCell(`A${r}`, s.note)]);
  r++; // blank line between the header block and the table
  // Bước 3: Ghi hàng tiêu đề cột (header row), các hàng dữ liệu và hàng tổng kết (total) nếu có.
  push(s.columns.map((c, i) => textCell(`${colName(i)}${r}`, c, 3)));
  for (const row of s.rows) push(row.map((v, i) => anyCell(`${colName(i)}${r}`, v)));
  if (s.total) push(s.total.map((v, i) => anyCell(`${colName(i)}${r}`, v, 1)));
  // Bước 4: Lấy mẫu dữ liệu tối đa 200 dòng để tính toán độ rộng cột tự động (tối thiểu 10, tối đa 48).
  const sampledRows = s.rows.slice(0, COLUMN_WIDTH_SAMPLE_SIZE);
  const widths = s.columns
    .map((c, i) => {
      const longest = Math.max(c.length, ...sampledRows.map((row) => String(row[i] ?? "").length));
      return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(48, Math.max(10, longest + 2))}" customWidth="1"/>`;
    })
    .join("");
  // Bước 5: Ghép thông tin độ rộng cột (<cols>) và dữ liệu các hàng (<sheetData>) vào thẻ gốc <worksheet>.
  return `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${widths}</cols><sheetData>${rows.join("")}</sheetData></worksheet>`;
}

// Định nghĩa sẵn bảng kiểu dáng (styles.xml): font Calibri (cỡ 11, in đậm, cỡ 14 in đậm), nền màu xanh nhạt #FFE4EEE8 cho header, và 4 kiểu ô.
const STYLES = `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE4EEE8"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/**
 * Làm gì: Đóng gói toàn bộ tài liệu báo cáo ReportDoc thành tệp bảng tính Excel (.xlsx) chuẩn OpenXML dạng Uint8Array bằng thư viện fflate.
 * Được gọi ở: src/server/controllers/handlers/reports.ts (hàm reportsExport phục vụ endpoint GET /api/reports/:kind/export?format=xlsx).
 * @param doc Dữ liệu tài liệu báo cáo gồm tiêu đề, bộ lọc và các phần (sections).
 * @returns Mảng byte Uint8Array chứa toàn bộ nội dung tệp .xlsx đã nén zip.
 */
export function buildXlsx(doc: ReportDoc): Uint8Array {
  // Bước 1: Chuẩn bị danh sách sections (mặc định ít nhất 1 section rỗng) và tạo tên sheet duy nhất.
  const sections = doc.sections.length ? doc.sections : [{ name: "Report", columns: [], rows: [] }];
  const names = sheetNames(sections);
  // Bước 2: Khởi tạo cấu trúc các tệp XML bắt buộc trong gói OpenXML ([Content_Types], rels, workbook, styles).
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sections
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join("")}</Types>`,
    ),
    "_rels/.rels": strToU8(
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    "xl/workbook.xml": strToU8(
      `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names
        .map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets></workbook>`,
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sections
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join("")}<Relationship Id="rId${sections.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    "xl/styles.xml": strToU8(STYLES),
  };
  // Bước 3: Biên dịch nội dung từng section thành tệp worksheet XML (sheet1.xml, sheet2.xml,...) tương ứng.
  sections.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(doc, s));
  });
  // Bước 4: Nén toàn bộ cấu trúc file thành tệp zip .xlsx bằng fflate với mức nén 6 (tối ưu giữa tốc độ và dung lượng).
  return zipSync(files, { level: 6 });
}

// ---- PDF -------------------------------------------------------------------

/**
 * Làm gì: Giải mã chuỗi Data URL base64 chứa asset font nhúng inline thành mảng byte Uint8Array.
 * Được gọi ở: src/server/data/report-files.ts (hàm buildReportPdf khi nhúng font Roboto).
 * @param url Chuỗi Data URL base64 chứa dữ liệu font.
 * @returns Mảng byte Uint8Array chứa dữ liệu nhị phân của font TTF.
 * @throws Error("font asset is not a data URL") nếu chuỗi không chứa dấu phẩy phân tách của Data URL.
 */
function decodeDataUrl(url: string): Uint8Array {
  const comma = url.indexOf(",");
  if (comma < 0) throw new Error("font asset is not a data URL");
  return new Uint8Array(Buffer.from(url.slice(comma + 1), "base64"));
}

/**
 * Làm gì: Chuẩn hóa chuỗi văn bản tiếng Việt sang dạng Unicode dựng sẵn NFC (Normalization Form C) để hiển thị dấu chính xác khi xuất PDF.
 * Được gọi ở: src/server/data/report-files.ts (hàm clip, buildReportPdf).
 * @param s Chuỗi văn bản tiếng Việt cần chuẩn hóa.
 * @returns Chuỗi văn bản đã được chuẩn hóa Unicode NFC.
 */
const nfc = (s: string) => (s ?? "").normalize("NFC");

/**
 * Làm gì: Định dạng giá trị ô (Cell) thành chuỗi hiển thị trên PDF, định dạng số theo chuẩn phân tách hàng nghìn của Việt Nam (vi-VN).
 * Được gọi ở: src/server/data/report-files.ts (hàm drawRow trong buildReportPdf).
 * @param v Giá trị ô (số, chuỗi hoặc null/undefined).
 * @returns Chuỗi văn bản đã được định dạng hiển thị, hoặc chuỗi rỗng nếu giá trị là null/undefined.
 */
function fmt(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("vi-VN") : v.toLocaleString("vi-VN", { maximumFractionDigits: 1 });
  return String(v);
}

/**
 * Làm gì: Cắt ngắn chuỗi văn bản và thêm dấu ba chấm "…" nếu độ rộng chữ vượt quá bề rộng cột trong PDF, tránh tràn chữ sang cột bên cạnh.
 * Được gọi ở: src/server/data/report-files.ts (hàm line và drawRow trong buildReportPdf).
 * @param font Font chữ pdf-lib đang dùng để tính toán độ rộng chữ.
 * @param text Chuỗi văn bản cần hiển thị.
 * @param size Cỡ chữ (pt).
 * @param width Độ rộng tối đa cho phép của cột (pt).
 * @returns Chuỗi văn bản vừa vặn trong cột, kèm "…" nếu bị cắt ngắn.
 */
/** Clip to a width, ending in "…", so a long name cannot run into the next column. */
function clip(font: PDFFont, text: string, size: number, width: number): string {
  let s = nfc(text);
  if (font.widthOfTextAtSize(s, size) <= width) return s;
  while (s.length > 1 && font.widthOfTextAtSize(`${s}…`, size) > width) s = s.slice(0, -1);
  return `${s}…`;
}

/**
 * Làm gì: Vẽ và kết xuất tài liệu báo cáo ReportDoc thành file PDF khổ A4, tự động ngắt trang, chia cột đều và nhúng font tiếng Việt Roboto.
 * Được gọi ở: src/server/controllers/handlers/reports.ts (hàm reportsExport phục vụ endpoint GET /api/reports/:kind/export?format=pdf).
 * @param doc Dữ liệu tài liệu báo cáo gồm tiêu đề, bộ lọc và các phần dữ liệu (sections).
 * @returns Promise chứa mảng byte Uint8Array của file PDF đã tạo sẵn sàng để gửi về client.
 */
export async function buildReportPdf(doc: ReportDoc): Promise<Uint8Array> {
  // Bước 1: Khởi tạo tài liệu PDF, tích hợp fontkit và nhúng bộ font tiếng Việt Roboto (Regular và Bold).
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(decodeDataUrl(robotoRegularUrl), { subset: true });
  const bold = await pdf.embedFont(decodeDataUrl(robotoBoldUrl), { subset: true });
  pdf.setTitle(nfc(doc.title));

  // Bước 2: Khai báo kích thước trang A4 (595x842 pt), lề 36 pt, các mã màu chuẩn và khởi tạo trang đầu tiên.
  const W = 595;
  const H = 842;
  const M = 36;
  const ink = rgb(0.1, 0.12, 0.11);
  const grey = rgb(0.4, 0.43, 0.41);
  const fill = rgb(0.89, 0.93, 0.91);
  let page = pdf.addPage([W, H]);
  let y = H - M;

  // Hàm trợ giúp kiểm tra khoảng trống còn lại theo chiều dọc; tự động thêm trang mới nếu không đủ chỗ.
  const ensure = (need: number) => {
    if (y - need >= M) return;
    page = pdf.addPage([W, H]);
    y = H - M;
  };
  // Hàm trợ giúp vẽ một dòng văn bản đơn, tự động căn chỉnh tọa độ y và chuyển trang khi cần.
  const line = (text: string, size: number, font: PDFFont, color = ink) => {
    ensure(size + 4);
    y -= size;
    page.drawText(clip(font, text, size, W - 2 * M), { x: M, y, size, font, color });
    y -= 4;
  };

  // Bước 3: Vẽ khối tiêu đề chính của báo cáo, các bộ lọc được áp dụng và thời điểm xuất báo cáo.
  line(doc.title, 16, bold);
  y -= 2;
  for (const [k, v] of doc.filters) line(`${k}: ${v}`, 9, regular, grey);
  line(`Generated: ${doc.generated_at}`, 9, regular, grey);
  y -= 6;

  // Bước 4: Duyệt qua từng section để tính toán độ rộng các cột và chuẩn bị vẽ bảng dữ liệu.
  for (const s of doc.sections) {
    ensure(60);
    line(s.name, 11.5, bold);
    if (s.note) line(s.note, 8.5, regular, grey);
    const cols = s.columns.length || 1;
    const usable = W - 2 * M;
    // First column takes what the numbers do not need; the rest share evenly.
    const firstW = cols === 1 ? usable : Math.min(usable * 0.38, Math.max(usable / cols, 90));
    const restW = cols > 1 ? (usable - firstW) / (cols - 1) : 0;
    const colX: number[] = [];
    const colW: number[] = [];
    let x = M;
    for (let i = 0; i < cols; i++) {
      const w = i === 0 ? firstW : restW;
      colX.push(x);
      colW.push(w);
      x += w;
    }
    // Tự động thu nhỏ cỡ chữ nếu bảng có nhiều cột (>6 cột: 7.5pt, >8 cột: 6.5pt) để không bị tràn lề trang A4.
    const size = cols > 8 ? 6.5 : cols > 6 ? 7.5 : 8.5;
    const rowH = size + 6;
    // Headers are strings, so align them with the numbers beneath them.
    const numeric = s.columns.map((_, i) => i > 0 && s.rows.some((r) => typeof r[i] === "number"));
    // Hàm vẽ một hàng dữ liệu: hỗ trợ tô màu nền (shade), căn phải cho cột số và căn trái cho cột văn bản.
    const drawRow = (cells: Cell[], font: PDFFont, shade: boolean) => {
      ensure(rowH + 2);
      if (shade) page.drawRectangle({ x: M, y: y - rowH + 3, width: usable, height: rowH, color: fill });
      cells.slice(0, cols).forEach((v, i) => {
        const text = clip(font, fmt(v), size, colW[i]! - 6);
        const right = numeric[i] === true && (typeof v === "number" || typeof v === "string");
        const tx = right ? colX[i]! + colW[i]! - 4 - font.widthOfTextAtSize(text, size) : colX[i]! + 3;
        page.drawText(text, { x: tx, y: y - size, size, font, color: ink });
      });
      y -= rowH;
    };
    // Bước 5: Lần lượt vẽ hàng tiêu đề cột, thông báo nếu không có dữ liệu, các hàng nội dung và hàng tổng kết (total).
    drawRow(s.columns, bold, true);
    if (!s.rows.length) line("No data for this period.", 8.5, regular, grey);
    for (const row of s.rows) drawRow(row, regular, false);
    if (s.total) drawRow(s.total, bold, true);
    y -= 10;
  }

  // Bước 6: Lưu và xuất toàn bộ nội dung PDF thành mảng byte Uint8Array.
  return pdf.save();
}
