import fontkit from "@pdf-lib/fontkit";
import { zipSync, strToU8 } from "fflate";
import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import robotoBoldUrl from "./fonts/Roboto-Bold.ttf?inline";
import robotoRegularUrl from "./fonts/Roboto-Regular.ttf?inline";

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

function esc(s: string): string {
  // Control characters are not allowed in XML 1.0, tabs and line breaks aside.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function colName(i: number): string {
  let n = i + 1;
  let out = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Sheet names: 31 characters, no `[]:*?/\`, unique. */
function sheetNames(sections: ReportSection[]): string[] {
  const seen = new Set<string>();
  return sections.map((s, i) => {
    const base = s.name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 28) || `Sheet${i + 1}`;
    let name = base;
    let n = 2;
    while (seen.has(name.toLowerCase())) name = `${base.slice(0, 26)} ${n++}`;
    seen.add(name.toLowerCase());
    return name;
  });
}

// Style ids: 0 plain, 1 bold, 2 bold title, 3 header row (bold, filled).
function textCell(ref: string, v: string, style = 0): string {
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}
function numCell(ref: string, v: number, style = 0): string {
  return `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${Number.isFinite(v) ? v : 0}</v></c>`;
}
function anyCell(ref: string, v: Cell, style = 0): string {
  if (v === null || v === undefined || v === "") return "";
  return typeof v === "number" ? numCell(ref, v, style) : textCell(ref, String(v), style);
}

function sheetXml(doc: ReportDoc, s: ReportSection): string {
  const rows: string[] = [];
  let r = 1;
  const push = (cells: string[]) => rows.push(`<row r="${r++}">${cells.join("")}</row>`);
  push([textCell(`A${r}`, doc.title, 2)]);
  for (const [k, v] of doc.filters) push([textCell(`A${r}`, k, 1), textCell(`B${r}`, v)]);
  push([textCell(`A${r}`, "Generated", 1), textCell(`B${r}`, doc.generated_at)]);
  if (s.note) push([textCell(`A${r}`, s.note)]);
  r++; // blank line between the header block and the table
  push(s.columns.map((c, i) => textCell(`${colName(i)}${r}`, c, 3)));
  for (const row of s.rows) push(row.map((v, i) => anyCell(`${colName(i)}${r}`, v)));
  if (s.total) push(s.total.map((v, i) => anyCell(`${colName(i)}${r}`, v, 1)));
  const widths = s.columns
    .map((c, i) => {
      const longest = Math.max(c.length, ...s.rows.slice(0, 200).map((row) => String(row[i] ?? "").length));
      return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(48, Math.max(10, longest + 2))}" customWidth="1"/>`;
    })
    .join("");
  return `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${widths}</cols><sheetData>${rows.join("")}</sheetData></worksheet>`;
}

const STYLES = `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE4EEE8"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

export function buildXlsx(doc: ReportDoc): Uint8Array {
  const sections = doc.sections.length ? doc.sections : [{ name: "Report", columns: [], rows: [] }];
  const names = sheetNames(sections);
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
  sections.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(doc, s));
  });
  return zipSync(files, { level: 6 });
}

// ---- PDF -------------------------------------------------------------------

function decodeDataUrl(url: string): Uint8Array {
  const comma = url.indexOf(",");
  if (comma < 0) throw new Error("font asset is not a data URL");
  return new Uint8Array(Buffer.from(url.slice(comma + 1), "base64"));
}

const nfc = (s: string) => (s ?? "").normalize("NFC");

function fmt(v: Cell): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("vi-VN") : v.toLocaleString("vi-VN", { maximumFractionDigits: 1 });
  return String(v);
}

/** Clip to a width, ending in "…", so a long name cannot run into the next column. */
function clip(font: PDFFont, text: string, size: number, width: number): string {
  let s = nfc(text);
  if (font.widthOfTextAtSize(s, size) <= width) return s;
  while (s.length > 1 && font.widthOfTextAtSize(`${s}…`, size) > width) s = s.slice(0, -1);
  return `${s}…`;
}

export async function buildReportPdf(doc: ReportDoc): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const regular = await pdf.embedFont(decodeDataUrl(robotoRegularUrl), { subset: true });
  const bold = await pdf.embedFont(decodeDataUrl(robotoBoldUrl), { subset: true });
  pdf.setTitle(nfc(doc.title));

  const W = 595;
  const H = 842;
  const M = 36;
  const ink = rgb(0.1, 0.12, 0.11);
  const grey = rgb(0.4, 0.43, 0.41);
  const fill = rgb(0.89, 0.93, 0.91);
  let page = pdf.addPage([W, H]);
  let y = H - M;

  const ensure = (need: number) => {
    if (y - need >= M) return;
    page = pdf.addPage([W, H]);
    y = H - M;
  };
  const line = (text: string, size: number, font: PDFFont, color = ink) => {
    ensure(size + 4);
    y -= size;
    page.drawText(clip(font, text, size, W - 2 * M), { x: M, y, size, font, color });
    y -= 4;
  };

  line(doc.title, 16, bold);
  y -= 2;
  for (const [k, v] of doc.filters) line(`${k}: ${v}`, 9, regular, grey);
  line(`Generated: ${doc.generated_at}`, 9, regular, grey);
  y -= 6;

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
    const size = cols > 8 ? 6.5 : cols > 6 ? 7.5 : 8.5;
    const rowH = size + 6;
    // Headers are strings, so align them with the numbers beneath them.
    const numeric = s.columns.map((_, i) => i > 0 && s.rows.some((r) => typeof r[i] === "number"));
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
    drawRow(s.columns, bold, true);
    if (!s.rows.length) line("No data for this period.", 8.5, regular, grey);
    for (const row of s.rows) drawRow(row, regular, false);
    if (s.total) drawRow(s.total, bold, true);
    y -= 10;
  }

  return pdf.save();
}
