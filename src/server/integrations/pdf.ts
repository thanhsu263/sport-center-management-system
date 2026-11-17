/**
 * Module kết xuất hóa đơn và chứng từ thanh toán ra định dạng file PDF.
 * Hỗ trợ 2 khổ in: A5 (in hóa đơn lưu trữ/văn phòng) và cuộn in nhiệt 80mm (in bill nhanh tại quầy lễ tân).
 * Nhúng trực tiếp font Roboto hỗ trợ đầy đủ tiếng Việt có dấu, định dạng theo chuẩn chứng từ bán hàng.
 */
import fontkit from "@pdf-lib/fontkit";
// `?inline` makes Vite hand back a base64 data URL, so the face travels inside
// the server bundle. Reading the .ttf off disk with `import.meta.url` works in
// dev and breaks on deploy: the build copies neither the file nor the folder
// into `.vercel/output/functions`, so every printed invoice would have been an
// ENOENT in production while looking perfect locally.
import robotoBoldUrl from "./fonts/Roboto-Bold.ttf?inline";
import robotoRegularUrl from "./fonts/Roboto-Regular.ttf?inline";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { vndInWords } from "../services/money-words";

/**
 * Invoice rendering.
 *
 * This used to hand-assemble a PDF byte string with the Helvetica base font,
 * which can only carry WinAnsi. Every line was pushed through the search
 * normaliser on the way out, so a receipt printed as "hoa don ... khach: vu van
 * mai" — lower-cased and stripped of its diacritics — and the one non-ASCII
 * character in the template (the "•" separator) came out as mojibake. Roboto is
 * embedded instead: it carries the full Vietnamese range, so the document can
 * simply say what it means.
 *
 * The layout follows the field order of a Vietnamese sales invoice so the
 * printout is recognisable to whoever files it, but this is NOT a legal
 * e-invoice: that requires the seller's digital signature and a tax-authority
 * code, both of which only a licensed provider can issue. `DISCLAIMER` says so
 * on the document itself rather than leaving the reader to assume otherwise.
 */

const DISCLAIMER = "Chứng từ thanh toán — chưa phải hóa đơn điện tử có mã của cơ quan thuế.";

/** Page geometry, in points. */
const SIZES = {
  a5: { width: 420, height: 595, margin: 30 },
  "80mm": { width: 226, height: 720, margin: 14 },
} as const;

export type InvoiceFormat = keyof typeof SIZES;

export type InvoiceLine = {
  description: string;
  unit: string | null;
  qty: number;
  unit_vnd: number;
  amount_vnd: number;
};

export type InvoiceDoc = {
  code: string;
  form_no: string | null;
  serial_no: string | null;
  issued_at: string;
  seller: { legal_name: string; tax_code: string | null; address: string | null };
  buyer: { name: string; phone?: string | null; tax_code: string | null; address: string | null };
  pay_code: string;
  method_label: string;
  lines: InvoiceLine[];
  subtotal_vnd: number;
  vat_rate: number;
  vat_vnd: number;
  total_vnd: number;
};

/** `data:font/ttf;base64,…` → the bytes pdf-lib embeds. */
/**
 * Làm gì: Giải mã chuỗi Data URL (base64) thành mảng byte nhị phân Uint8Array để thư viện pdf-lib có thể nạp font TTF.
 * Được gọi ở: Nội bộ file này trong hàm fontBytes().
 * @param url Chuỗi Data URL chứa nội dung font nhúng dạng base64 (data:font/ttf;base64,...).
 * @returns Mảng byte nhị phân (Uint8Array) của file font TTF.
 * @throws Error nếu chuỗi không phải định dạng Data URL hợp lệ (không chứa dấu phẩy phân cách).
 */
function decodeDataUrl(url: string): Uint8Array {
  const comma = url.indexOf(",");
  if (comma < 0) throw new Error("font asset is not a data URL");
  return new Uint8Array(Buffer.from(url.slice(comma + 1), "base64"));
}

/** The embedded face, decoded once per process rather than per invoice. */
let fontCache: { regular: Uint8Array; bold: Uint8Array } | null = null;
/**
 * Làm gì: Lấy dữ liệu nhị phân của font Roboto (gồm kiểu thường Regular và in đậm Bold), giải mã từ base64 và lưu vào bộ nhớ đệm fontCache của tiến trình để tái sử dụng cho mọi lần in hóa đơn.
 * Được gọi ở: Nội bộ file này trong hàm renderInvoicePdf().
 * @returns Đối tượng chứa mảng byte regular và bold của font Roboto.
 * @throws Error nếu giải mã font thất bại qua decodeDataUrl.
 */
function fontBytes() {
  // Khởi tạo bộ nhớ đệm fontCache nếu chưa có, tránh giải mã lại base64 mỗi khi in hóa đơn
  if (!fontCache) {
    fontCache = {
      regular: decodeDataUrl(robotoRegularUrl),
      bold: decodeDataUrl(robotoBoldUrl),
    };
  }
  return fontCache;
}

/**
 * Precomposed form, always.
 *
 * "ề" can be one code point or "e" plus a combining grave, and a PDF only draws
 * the glyphs the font is asked for — the decomposed form renders as a bare "e"
 * with the accent dropped or stacked in the wrong place. Everything reaching a
 * text-drawing call goes through here.
 */
/**
 * Làm gì: Chuẩn hóa chuỗi văn bản tiếng Việt sang dạng Unicode tiền dựng sẵn (NFC), đảm bảo các ký tự có dấu không bị tách rời khiến font PDF bị lỗi mất dấu hoặc lệch vị trí.
 * Được gọi ở: Nội bộ file này trong các phương thức của class Cursor (text, fit).
 * @param s Chuỗi văn bản tiếng Việt cần chuẩn hóa (cho phép null/undefined).
 * @returns Chuỗi văn bản đã chuẩn hóa NFC, hoặc chuỗi rỗng nếu đầu vào là null/undefined.
 * @throws Không ném lỗi.
 */
function nfc(s: string): string {
  return (s ?? "").normalize("NFC");
}

/**
 * Làm gì: Định dạng số tiền sang chuỗi hiển thị theo định dạng tiền tệ Việt Nam (vi-VN) có dấu chấm phân cách hàng nghìn và hậu tố 'đ' (ví dụ: 150000 -> "150.000đ").
 * Được gọi ở: Nội bộ file này trong các hàm drawLines() và drawTotals().
 * @param n Số tiền cần định dạng (VNĐ).
 * @returns Chuỗi số tiền đã định dạng kèm đơn vị 'đ'.
 * @throws Không ném lỗi.
 */
function money(n: number): string {
  return `${Math.round(n).toLocaleString("vi-VN")}đ`;
}

/** `2026-09-27T15:00:00+07:00` → `Ngày 27 tháng 09 năm 2026`. */
/**
 * Làm gì: Chuyển đổi chuỗi ngày giờ chuẩn ISO sang chuỗi ngày tháng năm đầy đủ bằng tiếng Việt ("Ngày DD tháng MM năm YYYY") để hiển thị trên hóa đơn.
 * Được gọi ở: Nội bộ file này trong hàm drawHead().
 * @param iso Chuỗi thời gian chuẩn ISO (ví dụ: "2026-09-27T15:00:00+07:00").
 * @returns Chuỗi ngày tháng tiếng Việt nếu khớp định dạng YYYY-MM-DD, hoặc giữ nguyên chuỗi iso ban đầu nếu không khớp.
 * @throws Không ném lỗi.
 */
function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `Ngày ${m[3]} tháng ${m[2]} năm ${m[1]}`;
}

/** A cursor that draws top-down and knows where the baseline got to. */
/**
 * Làm gì: Lớp điều khiển con trỏ vẽ nội dung trên trang PDF theo chiều từ trên xuống dưới (top-down), theo dõi tọa độ dòng y, quản lý lề, căn lề và khoảng cách dòng.
 * Được gọi ở: Nội bộ file này, được khởi tạo trong hàm renderInvoicePdf() và truyền vào các hàm vẽ drawHead, drawBuyer, drawLines, drawTotals, drawFoot.
 */
class Cursor {
  y: number;
  constructor(
    readonly page: PDFPage,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
    readonly left: number,
    readonly right: number,
    top: number,
  ) {
    this.y = top;
  }

  /**
   * Làm gì: Vẽ một đoạn văn bản lên trang PDF tại tọa độ y hiện tại, hỗ trợ tùy chọn font in đậm, kích thước, màu sắc và căn lề (trái, phải, giữa hoặc theo mép phải cố định).
   * Được gọi ở: Các phương thức nội bộ của Cursor (line) và các hàm vẽ drawLines, drawTotals, drawFoot.
   * @param value Nội dung văn bản cần vẽ.
   * @param opts Tùy chọn căn chỉnh: size (cỡ chữ), bold (in đậm), x (tọa độ x), xRight (căn mép phải), align (căn lề), grey (màu xám).
   * @returns void.
   * @throws Không ném lỗi.
   */
  text(
    value: string,
    opts: {
      size?: number;
      bold?: boolean;
      x?: number;
      /** Right edge to end the text at — for money columns. */
      xRight?: number;
      align?: "left" | "right" | "centre";
      grey?: boolean;
    } = {},
  ) {
    const size = opts.size ?? 8.5;
    const font = opts.bold ? this.bold : this.regular;
    const body = nfc(value);
    let x = opts.x ?? this.left;
    // Tính toán tọa độ x: nếu chỉ định xRight hoặc align="right", lùi sang trái đúng bằng chiều rộng chuỗi để mép phải thẳng hàng (rất quan trọng với cột tiền)
    if (opts.xRight != null) x = opts.xRight - font.widthOfTextAtSize(body, size);
    else if (opts.align === "right") x = this.right - font.widthOfTextAtSize(body, size);
    else if (opts.align === "centre") {
      x = this.left + (this.right - this.left - font.widthOfTextAtSize(body, size)) / 2;
    }
    this.page.drawText(body, {
      x,
      y: this.y,
      size,
      font,
      color: opts.grey ? rgb(0.42, 0.42, 0.42) : rgb(0, 0, 0),
    });
  }

  /** Draw a line of text and step down by its height. */
  line(value: string, opts: Parameters<Cursor["text"]>[1] = {}) {
    this.text(value, opts);
    this.y -= (opts.size ?? 8.5) + 4;
  }

  gap(n = 6) {
    this.y -= n;
  }

  /**
   * Làm gì: Vẽ một đường kẻ ngang phân cách (divider line) từ lề trái sang lề phải của trang và dịch chuyển con trỏ y xuống dưới.
   * Được gọi ở: Nội bộ file này trong các hàm drawHead(), drawLines(), drawFoot().
   * @param grey Độ sáng màu xám (từ 0.0 là đen đến 1.0 là trắng, mặc định 0.78).
   * @returns void.
   * @throws Không ném lỗi.
   */
  rule(grey = 0.78) {
    this.page.drawLine({
      start: { x: this.left, y: this.y + 6 },
      end: { x: this.right, y: this.y + 6 },
      thickness: 0.5,
      color: rgb(grey, grey, grey),
    });
    this.y -= 6;
  }

  /** Clip `value` to `width`, ending in an ellipsis when it does not fit. */
  /**
   * Làm gì: Cắt ngắn chuỗi văn bản và gắn thêm ký tự ba chấm ("…") nếu chuỗi vượt quá chiều rộng cho phép, đảm bảo tên mặt hàng dài không tràn sang cột bên cạnh.
   * Được gọi ở: Nội bộ file này trong hàm drawLines().
   * @param value Chuỗi văn bản gốc.
   * @param width Chiều rộng tối đa cho phép (points).
   * @param size Cỡ chữ hiển thị.
   * @param bold Sử dụng font in đậm hay thường để tính toán chính xác độ rộng ký tự.
   * @returns Chuỗi văn bản vừa vặn trong giới hạn chiều rộng.
   * @throws Không ném lỗi.
   */
  fit(value: string, width: number, size: number, bold = false): string {
    const font = bold ? this.bold : this.regular;
    let body = nfc(value);
    if (font.widthOfTextAtSize(body, size) <= width) return body;
    // Cắt bớt từng ký tự ở cuối cho đến khi chuỗi kèm dấu "…" vừa vặn trong chiều rộng cột
    while (body.length > 1 && font.widthOfTextAtSize(`${body}…`, size) > width) {
      body = body.slice(0, -1);
    }
    return `${body}…`;
  }
}

/** The seller block, invoice title and document numbers. */
/**
 * Làm gì: Vẽ phần đầu hóa đơn bao gồm thông tin đơn vị bán (tên trung tâm, địa chỉ, mã số thuế), tiêu đề "HÓA ĐƠN BÁN HÀNG", ngày phát hành và bộ ba số định danh hóa đơn (mẫu số, ký hiệu, số hóa đơn).
 * Được gọi ở: Nội bộ file này trong hàm renderInvoicePdf().
 * @param c Đối tượng Cursor quản lý vị trí vẽ trên trang PDF.
 * @param doc Dữ liệu hóa đơn chứa thông tin người bán và mã hóa đơn.
 * @param wide Cờ xác định khổ rộng A5 (true) hay khổ hẹp in nhiệt 80mm (false).
 * @returns void.
 * @throws Không ném lỗi.
 */
function drawHead(c: Cursor, doc: InvoiceDoc, wide: boolean) {
  // Bước 1: Vẽ khối thông tin người bán (tên pháp nhân in đậm, địa chỉ và mã số thuế)
  c.line(doc.seller.legal_name, { size: wide ? 12 : 10, bold: true });
  if (doc.seller.address) c.line(doc.seller.address, { size: 7.5, grey: true });
  c.line(`MST: ${doc.seller.tax_code ?? "-"}`, { size: 7.5, grey: true });
  c.gap(8);

  // Bước 2: Vẽ tiêu đề "HÓA ĐƠN BÁN HÀNG" căn giữa và ngày phát hành định dạng tiếng Việt
  c.line("HÓA ĐƠN BÁN HÀNG", { size: wide ? 14 : 11, bold: true, align: "centre" });
  c.line(longDate(doc.issued_at), { size: 8, align: "centre", grey: true });
  c.gap(2);

  // Bước 3: Ghép các thông tin định danh (Mẫu số, Ký hiệu, Số) và vẽ đường kẻ ngang kết thúc phần đầu
  // Mẫu số / ký hiệu / số — the three numbers that identify an invoice.
  const ident = [
    doc.form_no ? `Mẫu số: ${doc.form_no}` : null,
    doc.serial_no ? `Ký hiệu: ${doc.serial_no}` : null,
    `Số: ${doc.code}`,
  ]
    .filter(Boolean)
    .join("    ");
  c.line(ident, { size: 8, align: wide ? "right" : "centre", bold: true });
  c.rule();
  c.gap(4);
}

/** Buyer identity and how the money arrived. */
/**
 * Làm gì: Vẽ khối thông tin người mua (họ tên, số điện thoại, địa chỉ, mã số thuế) cùng hình thức thanh toán và mã chứng từ giao dịch gốc.
 * Được gọi ở: Nội bộ file này trong hàm renderInvoicePdf().
 * @param c Đối tượng Cursor quản lý vị trí vẽ trên trang PDF.
 * @param doc Dữ liệu hóa đơn chứa thông tin người mua, hình thức thanh toán và mã thanh toán.
 * @returns void.
 * @throws Không ném lỗi.
 */
function drawBuyer(c: Cursor, doc: InvoiceDoc) {
  // Bước 1: Vẽ lần lượt các thông tin cá nhân của người mua hàng và phương thức thanh toán
  c.line(`Họ tên người mua: ${doc.buyer.name}`, { size: 8.5 });
  if (doc.buyer.phone) c.line(`Điện thoại: ${doc.buyer.phone}`, { size: 8 });
  if (doc.buyer.address) c.line(`Địa chỉ: ${doc.buyer.address}`, { size: 8 });
  c.line(`MST người mua: ${doc.buyer.tax_code ?? "-"}`, { size: 8 });
  c.line(`Hình thức thanh toán: ${doc.method_label}    Chứng từ: ${doc.pay_code}`, { size: 8 });
  c.gap(6);
}

/**
 * The goods table.
 *
 * An invoice with no rows is not a formatting problem, it is a missing record,
 * so say that in the space where the rows would have been rather than printing
 * a heading over emptiness.
 */
/**
 * Làm gì: Vẽ bảng chi tiết danh sách hàng hóa/dịch vụ gồm các cột: số thứ tự (STT), tên mặt hàng, đơn vị tính (ĐVT), số lượng (SL), đơn giá (chỉ hiện trên khổ A5) và thành tiền.
 * Được gọi ở: Nội bộ file này trong hàm renderInvoicePdf().
 * @param c Đối tượng Cursor quản lý vị trí vẽ trên trang PDF.
 * @param doc Dữ liệu hóa đơn chứa danh sách các dòng hàng hóa lines.
 * @param wide Cờ xác định khổ rộng A5 (true, hiển thị cột Đơn giá) hay khổ in nhiệt 80mm (false, ẩn Đơn giá để tiết kiệm chiều ngang).
 * @returns void.
 * @throws Không ném lỗi.
 */
function drawLines(c: Cursor, doc: InvoiceDoc, wide: boolean) {
  const width = c.right - c.left;
  // Bước 1: Tính toán tọa độ x của từng cột theo chiều rộng trang giấy; hai cột tiền tệ được căn theo mép phải để các chữ số hàng nghìn thẳng hàng
  // STT · description · ĐVT · SL · đơn giá · thành tiền.
  // The two money columns are positioned by their RIGHT edge, the way a ledger
  // column is read; laying them out from the left made "đơn giá" run straight
  // into "thành tiền" as soon as both were six figures.
  const col = {
    no: c.left,
    desc: c.left + (wide ? 18 : 13),
    unit: c.left + width * (wide ? 0.5 : 0.46),
    qty: c.left + width * (wide ? 0.59 : 0.58),
    priceRight: c.left + width * 0.8,
    amountRight: c.right,
  };
  const descWidth = col.unit - col.desc - 6;

  // Bước 2: Vẽ tiêu đề các cột và đường kẻ ngang ngăn cách tiêu đề với dữ liệu
  c.text("STT", { size: 7, bold: true, x: col.no });
  c.text("Tên hàng hóa, dịch vụ", { size: 7, bold: true, x: col.desc });
  c.text("ĐVT", { size: 7, bold: true, x: col.unit });
  c.text("SL", { size: 7, bold: true, x: col.qty });
  if (wide) c.text("Đơn giá", { size: 7, bold: true, xRight: col.priceRight });
  c.text("Thành tiền", { size: 7, bold: true, xRight: col.amountRight });
  c.y -= 11;
  c.rule(0.85);
  c.gap(3);

  // Nếu hóa đơn không có dòng hàng nào, hiển thị ghi chú thay vì để trống bảng
  if (!doc.lines.length) {
    c.line("(không có dòng hàng nào được ghi cho chứng từ này)", { size: 7.5, grey: true });
  }

  // Bước 3: Lần lượt vẽ từng dòng hàng hóa; dùng c.fit() để cắt ngắn tên hàng nếu vượt quá độ rộng cột desc
  doc.lines.forEach((l, i) => {
    c.text(String(i + 1), { size: 7.5, x: col.no });
    c.text(c.fit(l.description, descWidth, 7.5), { size: 7.5, x: col.desc });
    c.text(l.unit ?? "-", { size: 7.5, x: col.unit });
    c.text(String(l.qty), { size: 7.5, x: col.qty });
    if (wide) c.text(money(l.unit_vnd), { size: 7.5, xRight: col.priceRight });
    c.text(money(l.amount_vnd), { size: 7.5, xRight: col.amountRight });
    c.y -= 12;
  });

  c.gap(2);
  c.rule();
  c.gap(4);
}

/** Subtotal, VAT and the payable total — the part an accountant reads first. */
/**
 * Làm gì: Vẽ phần tổng kết tài chính của hóa đơn gồm tiền hàng trước thuế (subtotal), thuế suất và tiền thuế GTGT, tổng tiền thanh toán và số tiền viết bằng chữ tiếng Việt.
 * Được gọi ở: Nội bộ file này trong hàm renderInvoicePdf().
 * @param c Đối tượng Cursor quản lý vị trí vẽ trên trang PDF.
 * @param doc Dữ liệu hóa đơn chứa subtotal_vnd, vat_rate, vat_vnd, total_vnd.
 * @returns void.
 * @throws Không ném lỗi.
 */
function drawTotals(c: Cursor, doc: InvoiceDoc) {
  // Hàm phụ vẽ một dòng tổng kết: nhãn bên trái, giá trị căn lề phải
  const row = (label: string, value: string, bold = false, size = 8.5) => {
    c.text(label, { size, bold, x: c.left });
    c.text(value, { size, bold, align: "right" });
    c.y -= size + 5;
  };
  // Bước 1: Vẽ tiền hàng trước thuế và thuế suất GTGT kèm tiền thuế tương ứng
  row("Cộng tiền hàng:", money(doc.subtotal_vnd));
  // A 0% rate is a real configuration, not a missing one; label it as such so
  // nobody reads the blank as "VAT was forgotten".
  row(
    `Thuế suất GTGT: ${doc.vat_rate > 0 ? `${doc.vat_rate}%` : "Không chịu thuế"}`,
    money(doc.vat_vnd),
  );
  c.gap(1);
  // Bước 2: Vẽ tổng cộng tiền thanh toán nổi bật với cỡ chữ 10pt in đậm
  row("TỔNG CỘNG TIỀN THANH TOÁN:", money(doc.total_vnd), true, 10);
  c.gap(2);
  // Bước 3: Chuyển đổi tổng tiền thanh toán thành chữ tiếng Việt qua hàm vndInWords
  c.line(`Số tiền bằng chữ: ${vndInWords(doc.total_vnd)}`, { size: 8 });
  c.gap(6);
}

/** Signature columns, then the disclaimer. */
/**
 * Làm gì: Vẽ phần chân hóa đơn gồm khu vực chữ ký (người mua và người bán với khổ A5; chỉ người bán với khổ 80mm), lời cảm ơn và dòng lưu ý pháp lý (chưa phải hóa đơn điện tử có mã thuế).
 * Được gọi ở: Nội bộ file này trong hàm renderInvoicePdf().
 * @param c Đối tượng Cursor quản lý vị trí vẽ trên trang PDF.
 * @param wide Cờ xác định khổ rộng A5 (true, 2 cột ký) hay khổ hẹp in nhiệt 80mm (false, 1 cột ký căn giữa).
 * @returns void.
 * @throws Không ném lỗi.
 */
function drawFoot(c: Cursor, wide: boolean) {
  // Bước 1: Vẽ phần chữ ký — khổ A5 hiển thị 2 cột (Người mua hàng & Người bán hàng), khổ 80mm chỉ hiển thị 1 cột người bán để tiết kiệm diện tích
  if (wide) {
    const mid = (c.left + c.right) / 2;
    c.text("Người mua hàng", { size: 8, x: c.left + 24, bold: true });
    c.text("Người bán hàng", { size: 8, x: mid + 34, bold: true });
    c.y -= 12;
    c.text("(Ký, ghi rõ họ tên)", { size: 6.5, x: c.left + 22, grey: true });
    c.text("(Ký, đóng dấu, ghi rõ họ tên)", { size: 6.5, x: mid + 16, grey: true });
    c.y -= 44;
  } else {
    c.line("Người bán hàng (Ký, ghi rõ họ tên)", { size: 7.5, align: "centre", grey: true });
    c.y -= 34;
  }
  // Bước 2: Kẻ đường phân cách, in lời cảm ơn và tuyên bố miễn trừ trách nhiệm pháp lý theo hằng số DISCLAIMER
  c.rule(0.85);
  c.gap(3);
  c.line("Cảm ơn quý khách.", { size: 8, align: "centre" });
  c.line(DISCLAIMER, { size: 6, align: "centre", grey: true });
}

/** Render one invoice. A5 for the office printer, 80mm for the till roll. */
/**
 * Làm gì: Kết xuất tài liệu hóa đơn thanh toán thành file PDF hoàn chỉnh dưới dạng mảng byte nhị phân (Uint8Array), hỗ trợ khổ giấy A5 hoặc cuộn in nhiệt 80mm, nhúng font tiếng Việt rút gọn để tối ưu dung lượng.
 * Được gọi ở: src/server/controllers/handlers/desk.ts (hàm invoicePdf phục vụ route GET /v1/invoices/:id.pdf).
 * @param doc Đối tượng chứa toàn bộ dữ liệu hóa đơn (người bán, người mua, danh sách hàng hóa/dịch vụ, thuế VAT, tổng tiền).
 * @param format Định dạng khổ in ("a5" cho văn phòng hoặc "80mm" cho máy in bill tại quầy, mặc định là "a5").
 * @returns Mảng byte nhị phân (Uint8Array) của file PDF đã tạo.
 * @throws Error nếu giải mã font TTF thất bại.
 */
export async function renderInvoicePdf(doc: InvoiceDoc, format: InvoiceFormat = "a5"): Promise<Uint8Array> {
  // Bước 1: Lấy thông số kích thước trang (chiều rộng, chiều cao, lề) dựa trên khổ in được yêu cầu
  const size = SIZES[format] ?? SIZES.a5;
  const wide = format === "a5";

  // Bước 2: Khởi tạo tài liệu PDF, đăng ký fontkit và nhúng font Roboto (Regular và Bold) với tùy chọn subsetting để giảm dung lượng file xuống khoảng 8KB
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const bytes = fontBytes();
  // Subsetting keeps a receipt around 8 KB instead of shipping 320 KB of face
  // with every print.
  const regular = await pdf.embedFont(bytes.regular, { subset: true });
  const bold = await pdf.embedFont(bytes.bold, { subset: true });

  // Bước 3: Thiết lập metadata tài liệu PDF (tiêu đề theo mã hóa đơn, người tạo Arena3)
  pdf.setTitle(`Hóa đơn ${doc.code}`);
  pdf.setProducer("Arena3");
  pdf.setCreator("Arena3");

  // Bước 4: Tạo trang PDF mới và khởi tạo đối tượng Cursor để vẽ nội dung từ trên xuống
  const page = pdf.addPage([size.width, size.height]);
  const c = new Cursor(page, regular, bold, size.margin, size.width - size.margin, size.height - size.margin - 10);

  // Bước 5: Lần lượt vẽ các khối nội dung: đầu hóa đơn, thông tin người mua, chi tiết hàng hóa, tổng kết tiền và chân trang
  drawHead(c, doc, wide);
  drawBuyer(c, doc);
  drawLines(c, doc, wide);
  drawTotals(c, doc);
  drawFoot(c, wide);

  // Bước 6: Lưu và xuất toàn bộ nội dung PDF ra mảng byte nhị phân Uint8Array
  return pdf.save();
}
