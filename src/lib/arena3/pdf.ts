import fontkit from "@pdf-lib/fontkit";
// `?inline` makes Vite hand back a base64 data URL, so the face travels inside
// the server bundle. Reading the .ttf off disk with `import.meta.url` works in
// dev and breaks on deploy: the build copies neither the file nor the folder
// into `.vercel/output/functions`, so every printed invoice would have been an
// ENOENT in production while looking perfect locally.
import robotoBoldUrl from "./fonts/Roboto-Bold.ttf?inline";
import robotoRegularUrl from "./fonts/Roboto-Regular.ttf?inline";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { vndInWords } from "./money-words";

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
function decodeDataUrl(url: string): Uint8Array {
  const comma = url.indexOf(",");
  if (comma < 0) throw new Error("font asset is not a data URL");
  return new Uint8Array(Buffer.from(url.slice(comma + 1), "base64"));
}

/** The embedded face, decoded once per process rather than per invoice. */
let fontCache: { regular: Uint8Array; bold: Uint8Array } | null = null;
function fontBytes() {
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
function nfc(s: string): string {
  return (s ?? "").normalize("NFC");
}

function money(n: number): string {
  return `${Math.round(n).toLocaleString("vi-VN")}đ`;
}

/** `2026-09-27T15:00:00+07:00` → `Ngày 27 tháng 09 năm 2026`. */
function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `Ngày ${m[3]} tháng ${m[2]} năm ${m[1]}`;
}

/** A cursor that draws top-down and knows where the baseline got to. */
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
  fit(value: string, width: number, size: number, bold = false): string {
    const font = bold ? this.bold : this.regular;
    let body = nfc(value);
    if (font.widthOfTextAtSize(body, size) <= width) return body;
    while (body.length > 1 && font.widthOfTextAtSize(`${body}…`, size) > width) {
      body = body.slice(0, -1);
    }
    return `${body}…`;
  }
}

/** The seller block, invoice title and document numbers. */
function drawHead(c: Cursor, doc: InvoiceDoc, wide: boolean) {
  c.line(doc.seller.legal_name, { size: wide ? 12 : 10, bold: true });
  if (doc.seller.address) c.line(doc.seller.address, { size: 7.5, grey: true });
  c.line(`MST: ${doc.seller.tax_code ?? "-"}`, { size: 7.5, grey: true });
  c.gap(8);

  c.line("HÓA ĐƠN BÁN HÀNG", { size: wide ? 14 : 11, bold: true, align: "centre" });
  c.line(longDate(doc.issued_at), { size: 8, align: "centre", grey: true });
  c.gap(2);

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
function drawBuyer(c: Cursor, doc: InvoiceDoc) {
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
function drawLines(c: Cursor, doc: InvoiceDoc, wide: boolean) {
  const width = c.right - c.left;
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

  c.text("STT", { size: 7, bold: true, x: col.no });
  c.text("Tên hàng hóa, dịch vụ", { size: 7, bold: true, x: col.desc });
  c.text("ĐVT", { size: 7, bold: true, x: col.unit });
  c.text("SL", { size: 7, bold: true, x: col.qty });
  if (wide) c.text("Đơn giá", { size: 7, bold: true, xRight: col.priceRight });
  c.text("Thành tiền", { size: 7, bold: true, xRight: col.amountRight });
  c.y -= 11;
  c.rule(0.85);
  c.gap(3);

  if (!doc.lines.length) {
    c.line("(không có dòng hàng nào được ghi cho chứng từ này)", { size: 7.5, grey: true });
  }

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
function drawTotals(c: Cursor, doc: InvoiceDoc) {
  const row = (label: string, value: string, bold = false, size = 8.5) => {
    c.text(label, { size, bold, x: c.left });
    c.text(value, { size, bold, align: "right" });
    c.y -= size + 5;
  };
  row("Cộng tiền hàng:", money(doc.subtotal_vnd));
  // A 0% rate is a real configuration, not a missing one; label it as such so
  // nobody reads the blank as "VAT was forgotten".
  row(
    `Thuế suất GTGT: ${doc.vat_rate > 0 ? `${doc.vat_rate}%` : "Không chịu thuế"}`,
    money(doc.vat_vnd),
  );
  c.gap(1);
  row("TỔNG CỘNG TIỀN THANH TOÁN:", money(doc.total_vnd), true, 10);
  c.gap(2);
  c.line(`Số tiền bằng chữ: ${vndInWords(doc.total_vnd)}`, { size: 8 });
  c.gap(6);
}

/** Signature columns, then the disclaimer. */
function drawFoot(c: Cursor, wide: boolean) {
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
  c.rule(0.85);
  c.gap(3);
  c.line("Cảm ơn quý khách.", { size: 8, align: "centre" });
  c.line(DISCLAIMER, { size: 6, align: "centre", grey: true });
}

/** Render one invoice. A5 for the office printer, 80mm for the till roll. */
export async function renderInvoicePdf(doc: InvoiceDoc, format: InvoiceFormat = "a5"): Promise<Uint8Array> {
  const size = SIZES[format] ?? SIZES.a5;
  const wide = format === "a5";

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const bytes = fontBytes();
  // Subsetting keeps a receipt around 8 KB instead of shipping 320 KB of face
  // with every print.
  const regular = await pdf.embedFont(bytes.regular, { subset: true });
  const bold = await pdf.embedFont(bytes.bold, { subset: true });

  pdf.setTitle(`Hóa đơn ${doc.code}`);
  pdf.setProducer("Arena3");
  pdf.setCreator("Arena3");

  const page = pdf.addPage([size.width, size.height]);
  const c = new Cursor(page, regular, bold, size.margin, size.width - size.margin, size.height - size.margin - 10);

  drawHead(c, doc, wide);
  drawBuyer(c, doc);
  drawLines(c, doc, wide);
  drawTotals(c, doc);
  drawFoot(c, wide);

  return pdf.save();
}
