#!/usr/bin/env node
/**
 * Grade docs/diagrams/*.drawio against the SRS section III shapes
 * and Learning UML 2.0 (see .grok/skills/uml2-oreilly/SKILL.md).
 * Exits 1 when a rule fails. Also fails when a word is wider than its box,
 * a connector cuts through a filled shape, two connectors cross, or a label
 * sits on a shape. Still look at the PNG for uneven gaps.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";

/**
 * Làm gì: Danh sách 7 tệp sơ đồ Draw.io của dự án Arena3 cần thẩm định quy chuẩn UML 2.0 và tài liệu SRS phần III.
 * Được gọi ở: scripts/uml2-review.mjs (vòng lặp thẩm định chính và kết xuất ảnh ở dòng 705).
 */
const FILES = [
  ["use-case", "docs/diagrams/use-case-diagram.drawio"],
  ["context", "docs/diagrams/context-diagram.drawio"],
  ["activity", "docs/diagrams/activity-diagram.drawio"],
  ["class", "docs/diagrams/class-diagram.drawio"],
  ["sequence", "docs/diagrams/sequence-diagram.drawio"],
  ["erd-logical", "docs/diagrams/erd-logical.drawio"],
  ["erd-physical", "docs/diagrams/erd-physical.drawio"],
];

/**
 * Làm gì: Kiểm tra điều kiện assertion; ném ngoại lệ dừng script nếu điều kiện không thỏa mãn.
 * Được gọi ở: scripts/uml2-review.mjs (các kiểm tra logic hình học ở dòng 36-38 và 315-319).
 * - Tham số cond: Biểu thức điều kiện cần kiểm tra (boolean).
 * - Tham số msg: Thông báo lỗi hiển thị khi assertion thất bại.
 * @throws {Error} Quăng ngoại lệ nếu điều kiện cond nhận giá trị falsy.
 */
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * Làm gì: Kiểm tra hai hình chữ nhật (bounding box) có giao nhau hay không theo thuật toán AABB.
 * Được gọi ở: scripts/uml2-review.mjs (hàm partialOverlap, gradeUseCase, gradeContext, gradePicture).
 * - Tham số a: Hình chữ nhật thứ nhất { x, y, w, h }.
 * - Tham số b: Hình chữ nhật thứ hai { x, y, w, h }.
 * @returns {boolean} True nếu hai hình chữ nhật có phần diện tích giao nhau.
 */
function intersects(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
/**
 * Làm gì: Kiểm tra hình chữ nhật inner có nằm trọn vẹn bên trong ranh giới của hình chữ nhật outer hay không.
 * Được gọi ở: scripts/uml2-review.mjs (hàm partialOverlap dòng 33, gradeUseCase dòng 170).
 * - Tham số outer: Hình chữ nhật bao ngoài { x, y, w, h }.
 * - Tham số inner: Hình chữ nhật cần kiểm tra { x, y, w, h }.
 * @returns {boolean} True nếu toàn bộ diện tích inner nằm trong ranh giới outer.
 */
function contains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}
/**
 * Làm gì: Kiểm tra hai khối hình có bị đè/cắt góc lên nhau một phần hay không (loại trừ trường hợp một hình chứa trọn hình kia).
 * Được gọi ở: scripts/uml2-review.mjs (smoke test dòng 36-38, hàm grade dòng 138).
 * - Tham số a: Khối hình thứ nhất { x, y, w, h }.
 * - Tham số b: Khối hình thứ hai { x, y, w, h }.
 * @returns {boolean} True nếu hai hình chồng lấn một phần gây lỗi bố cục sơ đồ.
 */
function partialOverlap(a, b) {
  return intersects(a, b) && !contains(a, b) && !contains(b, a);
}

// Bộ kiểm thử nhanh (smoke test) kiểm tra tính đúng đắn của logic va chạm hình học trước khi duyệt sơ đồ.
assert(!partialOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 2, y: 2, w: 2, h: 2 }), "containment is not a clash");
assert(partialOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 8, y: 8, w: 4, h: 4 }), "a corner clash is a clash");
assert(!partialOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 4, h: 4 }), "touching edges are not a clash");

/**
 * Làm gì: Giải mã các thực thể HTML/XML entities trong XML của Draw.io thành ký tự văn bản thuần túy.
 * Được gọi ở: scripts/uml2-review.mjs (hàm parse dòng 68 khi đọc thuộc tính thẻ).
 * - Tham số s: Chuỗi XML/HTML cần giải mã các ký tự đặc biệt.
 * @returns {string} Chuỗi văn bản đã giải mã các entity như <, >, ", xuống dòng, &.
 */
function decode(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&");
}

/**
 * Làm gì: Phân tích chuỗi thuộc tính style dạng key-value của cell trong Draw.io thành một object JavaScript.
 * Được gọi ở: scripts/uml2-review.mjs (hàm parse dòng 85 để trích xuất các cờ hiển thị như shape, ellipse, fillColor).
 * - Tham số style: Chuỗi style nguyên bản từ thuộc tính style của cell (ví dụ: "ellipse=1;fillColor=#111111").
 * @returns {Record<string, string>} Đối tượng ánh xạ tên thuộc tính sang giá trị tương ứng (mặc định "1" nếu là cờ boolean).
 */
function styleMap(style) {
  const m = {};
  // Tách các cặp thuộc tính ngăn cách bởi dấu chấm phẩy
  for (const part of (style || "").split(";")) {
    if (!part) continue;
    const i = part.indexOf("=");
    // Nếu thuộc tính dạng cờ không có dấu '=', mặc định gán giá trị bật "1"
    if (i < 0) m[part] = "1";
    else m[part.slice(0, i)] = part.slice(i + 1);
  }
  return m;
}

/**
 * Làm gì: Phân tích cú pháp XML của tệp Draw.io, trích xuất danh sách cell (nút, đường nối, nhãn) cùng kích thước trang.
 * Được gọi ở: scripts/uml2-review.mjs (hàm grade dòng 121, hàm toSvg dòng 679).
 * - Tham số xml: Chuỗi nội dung XML đọc từ tệp .drawio.
 * @returns {{ cells: Array<Object>, pageW: number, pageH: number }} Danh sách cell và kích thước trang canvas.
 */
function parse(xml) {
  // Bước 1: Quét tất cả thẻ <mxCell> trong XML bằng biểu thức chính quy Regex
  const cells = [];
  const re = /<mxCell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)/g;
  for (const match of xml.matchAll(re)) {
    const attr = match[1];
    const inner = match[2] || "";
    // Hàm tiện ích trích xuất và giải mã (decode) giá trị thuộc tính theo tên
    const take = (name) => {
      const found = attr.match(new RegExp(`\\b${name}="([^"]*)"`));
      return found ? decode(found[1]) : "";
    };
    // Trích xuất tọa độ và kích thước từ thẻ con <mxGeometry>
    const geo = inner.match(/<mxGeometry\b([^>]*)\/?>/) || inner.match(/<mxGeometry\b([^>]*)>/);
    const g = geo ? geo[1] : "";
    const num = (name, fallback) => {
      const found = g.match(new RegExp(`\\b${name}="([^"]+)"`));
      return found ? Number(found[1]) : fallback;
    };
    // Lấy danh sách điểm bẻ góc (waypoints) của đường nối (edge)
    const points = [...inner.matchAll(/<mxPoint\b(?![^>]*as=")([^>]*)\/?>/g)].map((p) => ({
      x: Number((p[1].match(/\bx="([^"]+)"/) || [])[1] || 0),
      y: Number((p[1].match(/\by="([^"]+)"/) || [])[1] || 0),
    }));
    const style = take("style");
    // Đóng gói dữ liệu cell gồm id, style, tọa độ và quan hệ nguồn/đích
    cells.push({
      id: take("id"),
      value: take("value"),
      style,
      sm: styleMap(style),
      vertex: /\bvertex="1"/.test(attr),
      edge: /\bedge="1"/.test(attr),
      parent: take("parent") || "1",
      source: take("source"),
      target: take("target"),
      x: num("x", 0),
      y: num("y", 0),
      w: num("width", 0),
      h: num("height", 0),
      relative: /\brelative="1"/.test(g),
      points,
    });
  }
  // Bước 2: Đọc kích thước trang (pageWidth, pageHeight) của canvas Draw.io
  const pageW = Number((xml.match(/pageWidth="([^"]+)"/) || [])[1] || 0);
  const pageH = Number((xml.match(/pageHeight="([^"]+)"/) || [])[1] || 0);
  return { cells, pageW, pageH };
}

/**
 * Làm gì: Xây dựng cấu trúc Map tra cứu nhanh các cell theo thuộc tính id với độ phức tạp O(1).
 * Được gọi ở: scripts/uml2-review.mjs (hàm grade dòng 125, hàm toSvg dòng 680).
 * - Tham số cells: Mảng các đối tượng cell đã trích xuất từ XML.
 * @returns {Map<string, Object>} Bảng tra cứu Map ánh xạ từ cell id sang đối tượng cell tương ứng.
 */
function byId(cells) {
  return new Map(cells.map((c) => [c.id, c]));
}

/**
 * Làm gì: Gỡ bỏ toàn bộ thẻ định dạng HTML (như <br>, <div>, <b>) để lấy nội dung văn bản thuần túy của cell.
 * Được gọi ở: scripts/uml2-review.mjs (các hàm gradeUseCase, gradeContext, gradeErd, gradeActivity, gradeClass, gradeSequence, gradePicture, toSvg).
 * - Tham số value: Chuỗi giá trị nhãn của cell có thể chứa các thẻ HTML.
 * @returns {string} Chuỗi văn bản thuần túy đã chuẩn hóa dòng và cắt bỏ khoảng trắng thừa.
 */
function plain(value) {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .trim();
}

/**
 * Làm gì: Điều phối kiểm tra và chấm điểm file sơ đồ Draw.io theo quy chuẩn UML 2.0 / SRS tương ứng với từng loại sơ đồ.
 * Được gọi ở: scripts/uml2-review.mjs (vòng lặp thẩm định chính dòng 707).
 * - Tham số kind: Thể loại sơ đồ ("use-case", "context", "activity", "class", "sequence", "erd-logical", "erd-physical").
 * - Tham số xml: Chuỗi nội dung XML của file Draw.io.
 * @returns {Array<{ rule: string, detail: string }>} Danh sách các lỗi vi phạm quy tắc (mảng rỗng nếu đạt chuẩn).
 */
function grade(kind, xml) {
  // Bước 1: Khởi tạo danh sách lỗi và helper kiểm tra quy tắc (check)
  const fails = [];
  const check = (rule, ok, detail = "") => {
    if (!ok) fails.push({ rule, detail });
  };
  // Quy chuẩn FPT SE: Cấm dùng comment XML vì parser của Draw.io có thể gặp lỗi cú pháp
  check("no XML comment", !xml.includes("<!--"));
  // Bước 2: Parse XML và thẩm định cấu trúc cơ sở (ID duy nhất, tồn tại cell gốc 0 và 1)
  const { cells, pageW, pageH } = parse(xml);
  const ids = cells.map((c) => c.id);
  check("ids are unique", new Set(ids).size === ids.length, ids.filter((id, i) => ids.indexOf(id) !== i).join(","));
  check("root cells 0 and 1", ids.includes("0") && ids.includes("1"));
  const map = byId(cells);
  // Mỗi cell hợp lệ phải có tọa độ; đường nối (edge) phải có source và target trỏ tới cell tồn tại
  for (const c of cells) {
    if (c.id === "0" || c.id === "1") continue;
    check(`${c.id} has geometry`, c.relative || c.w > 0 || c.h > 0 || c.edge, c.id);
    if (c.edge) {
      check(`${c.id} source exists`, map.has(c.source), c.source);
      check(`${c.id} target exists`, map.has(c.target), c.target);
    }
  }

  // Bước 3: Phát hiện lỗi bố cục sơ đồ (các khối hình bị đè/chồng lấn lên nhau một phần)
  const nodes = cells.filter((c) => c.vertex && c.parent === "1" && c.w > 2 && c.h > 2 && c.sm.opacity !== "0" && c.sm.fillColor !== "none");
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (partialOverlap(nodes[i], nodes[j])) {
        check("nodes do not partially overlap", false, `${nodes[i].id} × ${nodes[j].id}`);
      }
    }
  }
  // Bước 4: Kiểm tra không có phần tử nào bị vẽ tràn ra ngoài kích thước trang canvas
  const framed = cells.filter((c) => c.vertex && c.parent === "1" && c.w > 2 && c.h > 2 && c.sm.opacity !== "0");
  for (const c of framed) {
    check(`${c.id} stays on the page`, c.x >= 0 && c.y >= 0 && c.x + c.w <= pageW + 1 && c.y + c.h <= pageH + 1, `${c.x},${c.y} ${c.w}x${c.h}`);
  }

  // Bước 5: Gọi hàm thẩm định chuyên biệt tương ứng với từng loại sơ đồ UML / ERD
  if (kind === "use-case") gradeUseCase(check, cells);
  if (kind === "context") gradeContext(check, cells);
  if (kind === "activity") gradeActivity(check, cells);
  if (kind === "class") gradeClass(check, cells);
  if (kind === "sequence") gradeSequence(check, cells, map);
  if (kind === "erd-logical" || kind === "erd-physical") gradeErd(check, cells, kind);
  // Bước 6: Kiểm tra thẩm mỹ hình ảnh tổng quát (đường nối xuyên hình, nhãn chữ đè nhau)
  gradePicture(check, cells, map, pageW, pageH);
  return fails;
}

/**
 * Làm gì: Thẩm định Use Case Diagram theo chuẩn UML 2.0: ranh giới hệ thống, vị trí Actor, tên Use Case, quan hệ include/extend.
 * Được gọi ở: scripts/uml2-review.mjs (hàm grade dòng 148 khi kind === "use-case").
 * - Tham số check: Hàm callback ghi nhận lỗi thẩm định rule.
 * - Tham số cells: Danh sách các cell trong sơ đồ Use Case.
 * @returns {void}
 */
function gradeUseCase(check, cells) {
  // Bước 1: Lọc các thành phần cơ bản (Actor người que, oval Use Case, khung System Boundary)
  const actors = cells.filter((c) => c.sm.shape === "umlActor");
  const ovals = cells.filter((c) => c.sm.ellipse === "1" && c.vertex);
  const boundary = cells.find((c) => c.id === "sys");
  const blob = cells.map((c) => plain(c.value)).join("\n");
  // Bước 2: Kiểm tra System Boundary và các Actor bắt buộc phải đứng ngoài ranh giới hệ thống
  check("one system boundary", !!boundary && boundary.sm.fillColor === "none");
  check("stick actors stand outside it", !!boundary && actors.length >= 5 && actors.every((a) => !intersects(a, boundary)), String(actors.length));
  // 5 Actor cốt lõi theo SRS phải được khai báo đầy đủ trên sơ đồ
  for (const name of ["Guest", "Member", "Receptionist", "Coach", "Manager"]) {
    check(`actor ${name} is named`, blob.includes(name));
  }
  // Hệ thống ngoài (payOS, Mail delivery) không vẽ hình người que trên sơ đồ Use Case chính
  check("external systems are not drawn on the use case", !blob.includes("«actor»") && !blob.includes("payOS") && !blob.includes("Mail delivery"));
  check("no package frames", cells.filter((c) => c.id.startsWith("pkg")).length === 0);
  // Bước 3: Kiểm tra các Use Case (oval) phải nằm trong ranh giới và đặt tên theo mục tiêu (không dùng mã UC01, UC02)
  check("goal ovals sit inside the one boundary", !!boundary && ovals.length >= 31 && ovals.every((o) => contains(boundary, o)), String(ovals.length));
  check("use case names are goals, not UC codes", ovals.every((o) => !/^UC\d/.test(plain(o.value))));
  // Bước 4: Kiểm tra đường giao tiếp (Association line) giữa Actor và Use Case không được có mũi tên
  for (const e of cells.filter((c) => c.edge)) {
    const s = cells.find((c) => c.id === e.source);
    const t = cells.find((c) => c.id === e.target);
    const actorEnd = [s, t].some((n) => n && n.sm.shape === "umlActor");
    const ovalEnd = [s, t].some((n) => n && n.sm.ellipse === "1");
    if (actorEnd && ovalEnd) {
      check(`${e.id} communication line has no arrowhead`, e.sm.endArrow === "none" && e.sm.dashed !== "1");
    }
  }
  // Bước 5: Kiểm tra quan hệ «include» và «extend» phải là đường nét đứt với mũi tên hở (open arrow)
  const dashed = cells.filter((c) => c.edge && c.sm.dashed === "1");
  check("include and extend are open dashed arrows", dashed.length === 8 && dashed.every((e) => e.sm.endArrow === "open" && e.sm.endFill === "0"), String(dashed.length));
  // Bước 6: Kiểm tra chiều mũi tên của các cặp include/extend chuẩn nghiệp vụ (tail trỏ tới Use Case được tái sử dụng)
  const pair = (id, from, to) => {
    const e = cells.find((c) => c.id === id);
    const s = cells.find((c) => c.id === e?.source);
    const t = cells.find((c) => c.id === e?.target);
    check(`${id} points from the tail use case to the reused one`, !!s && !!t && plain(s.value).includes(from) && plain(t.value).includes(to), plain(e?.value || ""));
  };
  pair("inc_otp", "Register member", "Verify email");
  pair("inc_book", "Book a court", "Pay online");
  pair("inc_plan", "Buy or renew", "Pay online");
  pair("inc_att", "Record session", "Lock the");
  pair("inc_rep", "View revenue", "Export");
  pair("inc_gate", "Check in", "Display the QR");
  pair("ext_refund", "Refund the", "Cancel a court");
  pair("ext_move", "Reschedule", "Book a court");
}

/**
 * Làm gì: Thẩm định Context Diagram (sơ đồ ngữ cảnh) theo SRS: ranh giới hệ thống Arena3, 7 actor tương tác và đường giao tiếp.
 * Được gọi ở: scripts/uml2-review.mjs (hàm grade dòng 149 khi kind === "context").
 * - Tham số check: Hàm callback ghi nhận lỗi thẩm định rule.
 * - Tham số cells: Danh sách các cell trong sơ đồ Context.
 * @returns {void}
 */
function gradeContext(check, cells) {
  // Bước 1: Tìm khung ranh giới hệ thống Arena3 và kiểm tra không chứa Use Case oval nào
  const boundary = cells.find((c) => c.id === "sys");
  const name = plain(boundary?.value || "");
  const ovals = cells.filter((c) => c.vertex && c.sm.ellipse === "1");
  check("one system boundary", !!boundary && boundary.sm.fillColor === "none" && boundary.sm.ellipse !== "1" && /Arena3/.test(name) && !name.includes("0."), name);
  check("overview has no use cases", ovals.length === 0, String(ovals.length));
  // Bước 2: Kiểm tra 7 Actor (5 người dùng nội bộ + 2 hệ thống ngoài mang stereotype «actor») phải đứng ngoài boundary
  const actors = cells.filter((c) => c.sm.shape === "umlActor");
  check("seven sticks stand outside the system", !!boundary && actors.length === 7 && actors.every((a) => !intersects(a, boundary)), String(actors.length));
  const blob = cells.map((c) => plain(c.value)).join("\n");
  for (const who of ["Guest", "Member", "Receptionist", "Coach", "Manager", "payOS", "Mail delivery"]) {
    check(`actor ${who}`, blob.includes(who));
  }
  check("external systems wear «actor»", (blob.match(/«actor»/g) || []).length === 2);
  // Bước 3: Kiểm tra mỗi Actor có đúng một đường giao tiếp không mũi tên kèm nhãn mô tả hành động ngắn gọn
  const edges = cells.filter((c) => c.edge);
  check("one communication line per actor, no arrowhead", edges.length === 7 && edges.every((e) => e.sm.endArrow === "none" && plain(e.value).length > 0 && plain(e.value).length <= 24), edges.map((e) => plain(e.value)).join(" | "));
}

/**
 * Làm gì: Thẩm định sơ đồ ERD mức Logic (ký pháp Chen) hoặc ERD mức Physical (bảng CSDL có khóa chính PK, quan hệ khóa ngoại FK).
 * Được gọi ở: scripts/uml2-review.mjs (hàm grade dòng 153 khi kind === "erd-logical" hoặc "erd-physical").
 * - Tham số check: Hàm callback ghi nhận lỗi thẩm định rule.
 * - Tham số cells: Danh sách các cell trong sơ đồ ERD.
 * - Tham số kind: Phân loại ERD ("erd-logical" hoặc "erd-physical").
 * @returns {void}
 */
function gradeErd(check, cells, kind) {
  const blob = cells.map((c) => plain(c.value)).join("\n");
  const edges = cells.filter((c) => c.edge);
  // Nhánh 1: Thẩm định ERD Logical theo ký pháp Chen (Entity chữ nhật, Relationship hình thoi, đường nối không mũi tên)
  if (kind === "erd-logical") {
    const diamonds = cells.filter((c) => c.sm.rhombus === "1");
    const ents = cells.filter((c) => c.vertex && c.parent === "1" && c.sm.rhombus !== "1" && c.w >= 80 && c.sm.fillColor !== "none");
    check("Chen entity rectangles", ents.length >= 6, String(ents.length));
    check("relationship diamonds", diamonds.length >= 6, String(diamonds.length));
    for (const name of ["User", "CourtBooking", "Subscription", "Class"]) check(`entity ${name}`, blob.includes(name));
    check("Chen lines have no arrowhead", edges.length >= 8 && edges.every((e) => e.sm.endArrow === "none"));
  // Nhánh 2: Thẩm định ERD Physical (các bảng phải chỉ rõ khóa chính PK, quan hệ khóa ngoại FK)
  } else {
    const tables = cells.filter((c) => c.vertex && c.value.includes("PK "));
    check("tables list a primary key", tables.length >= 6, String(tables.length));
    for (const name of ["User", "Subscription", "CourtBooking", "Payment", "Class"]) check(`table ${name}`, blob.includes(name));
    check("foreign-key lines have no arrowhead", edges.length >= 4 && edges.every((e) => e.sm.endArrow === "none"));
  }
}

/**
 * Làm gì: Thẩm định Activity Diagram theo UML 2.0: điểm bắt đầu/kết thúc, phân làn (swimlanes), tín hiệu và điều kiện rẽ nhánh (guards).
 * Được gọi ở: scripts/uml2-review.mjs (hàm grade dòng 150 khi kind === "activity").
 * - Tham số check: Hàm callback ghi nhận lỗi thẩm định rule.
 * - Tham số cells: Danh sách các cell trong sơ đồ Activity.
 * @returns {void}
 */
function gradeActivity(check, cells) {
  // Bước 1: Lọc các nút trạng thái đặc biệt (Initial node, Activity final bullseye, Send signal, Swimlanes)
  const initials = cells.filter((c) => c.vertex && c.sm.ellipse === "1" && c.sm.fillColor === "#111111");
  const finals = cells.filter((c) => c.sm.shape === "endState");
  const signals = cells.filter((c) => c.sm.shape === "sendSignal");
  const lanes = cells.filter((c) => c.vertex && c.sm.fillColor === "#f8fafc" && c.w > 200);
  // Kiểm tra đúng 1 điểm bắt đầu (hình tròn đen), điểm kết thúc dạng hồng tâm (bullseye) và có tín hiệu gửi ra ngoài
  check("exactly one initial node", initials.length === 1, String(initials.length));
  check("activity final is a bullseye, not a second filled circle", finals.length >= 1, String(finals.length));
  check("a send signal leaves the system", signals.length >= 1);
  // Bước 2: Kiểm tra 5 phân làn Swimlane đại diện cho các tác nhân và tầng xử lý của Arena3
  check("five partitions", lanes.length === 5, lanes.map((l) => plain(l.value)).join(", "));
  const laneNames = lanes.map((l) => plain(l.value)).join("|");
  for (const name of ["Guest", "Web client", "Arena3 API", "Mail delivery", "Database"]) {
    check(`partition ${name}`, laneNames.includes(name));
  }
  // Bước 3: Kiểm tra các điều kiện rẽ nhánh (Guard condition) phải được bọc trong dấu ngoặc vuông [...]
  const guardText = cells.filter((c) => c.edge).map((c) => c.value);
  for (const guard of ["[Valid]", "[Invalid]", "[Duplicate]", "[Unique]", "[Verified]", "[Mismatch / Expired]"]) {
    check(`guard ${guard}`, guardText.includes(guard));
  }
  const outgoing = new Map();
  for (const e of cells.filter((c) => c.edge)) {
    const list = outgoing.get(e.source) || [];
    list.push(e);
    outgoing.set(e.source, list);
  }
  // Bước 4: Kiểm tra nút rẽ nhánh Decision (hình thoi) có ít nhất 2 nhánh ra có guard, hoặc nút Merge có 1 nhánh ra
  for (const d of cells.filter((c) => c.sm.rhombus === "1")) {
    const outs = outgoing.get(d.id) || [];
    if (outs.length >= 2) {
      check(`${d.id} decision guards are in brackets`, outs.every((e) => /^\[[^\]]+\]$/.test(e.value.trim())), outs.map((e) => e.value).join(" | "));
    } else {
      check(`${d.id} merge has one outgoing edge`, outs.length === 1, String(outs.length));
    }
  }
}

/**
 * Làm gì: Thẩm định Class Diagram theo UML 2.0: cấu trúc 3 ngăn (tên, thuộc tính, phương thức), visibility (+, -, #), kiểu dữ liệu và bản số.
 * Được gọi ở: scripts/uml2-review.mjs (hàm grade dòng 151 khi kind === "class").
 * - Tham số check: Hàm callback ghi nhận lỗi thẩm định rule.
 * - Tham số cells: Danh sách các cell trong sơ đồ Class.
 * @returns {void}
 */
function gradeClass(check, cells) {
  // Bước 1: Lấy các hộp lớp (class boxes) và regex kiểm tra bản số (multiplicity)
  const boxes = cells.filter((c) => c.vertex && c.style.includes("overflow=fill"));
  check("class boxes are present", boxes.length >= 6);
  const mult = /^(?:\*|0\.\.\*|1\.\.\*|0\.\.1|1|\d+)$/;
  // Bước 2: Kiểm tra quy chuẩn hình thức của từng lớp (góc vuông, không shadow, không nhầm sang bảng CSDL có PK/FK)
  for (const b of boxes) {
    check(`${b.id} has no rounded corner or shadow`, !b.style.includes("rounded=1") && !b.style.includes("shadow=1"));
    check(`${b.id} has no PK or FK marker`, !b.value.includes("[PK]") && !b.value.includes("[FK]"));
    // Mỗi lớp phải có đúng 3 ngăn ngăn cách bởi thẻ <hr>: Tên lớp, Thuộc tính, Phương thức
    const parts = b.value.split(/<hr\s*\/?>/i);
    check(`${b.id} has three compartments`, parts.length === 3, String(parts.length));
    const attrs = plain(parts[1] || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const ops = plain(parts[2] || "").split("\n").map((s) => s.trim()).filter(Boolean);
    // Kiểm tra cú pháp UML của thuộc tính: visibility name : Type [multiplicity]
    for (const a of attrs) {
      check(`${b.id} attribute "${a}"`, /^[+\-#~] [A-Za-z][A-Za-z0-9]* : [A-Za-z][A-Za-z0-9]*( \[[^\]]+\])?$/.test(a));
    }
    // Kiểm tra cú pháp UML của phương thức: visibility name(params) : ReturnType
    for (const o of ops) {
      check(`${b.id} operation "${o}"`, /^[+\-#~] [A-Za-z][A-Za-z0-9]*\([^)]*\) : [A-Za-z][A-Za-z0-9]*$/.test(o));
    }
  }
  // Bước 3: Kiểm tra các đường liên kết (Association) không có mũi tên và có bản số rõ ràng ở hai đầu (0..1, 1, 1..*, *)
  const assoc = cells.filter((c) => c.edge && c.sm.endArrow === "none");
  check("associations are drawn", assoc.length >= 4);
  for (const e of assoc) {
    const labels = cells.filter((c) => c.parent === e.id).map((c) => c.value);
    check(`${e.id} has a multiplicity at each end`, labels.length === 2 && labels.every((v) => mult.test(v)), labels.join(","));
  }
}

/**
 * Làm gì: Thẩm định Sequence Diagram theo UML 2.0: định dạng đối tượng name : Type, đường sinh mệnh nét đứt, thông điệp đồng bộ, activation bar và mũi tên ngang.
 * Được gọi ở: scripts/uml2-review.mjs (hàm grade dòng 152 khi kind === "sequence").
 * - Tham số check: Hàm callback ghi nhận lỗi thẩm định rule.
 * - Tham số cells: Danh sách các cell trong sơ đồ Sequence.
 * - Tham số map: Map tra cứu cell theo id.
 * @returns {void}
 */
function gradeSequence(check, cells, map) {
  // Bước 1: Kiểm tra các đối tượng tham gia (Lifeline heads) theo chuẩn name : Type và đường sống nét đứt
  const heads = cells.filter((c) => c.vertex && /:\s*\w+/.test(plain(c.value)) && c.w > 40);
  check("participants are name : Type", heads.length >= 4, heads.map((h) => plain(h.value)).join(" | "));
  const lifelines = cells.filter((c) => c.edge && c.sm.dashed === "1" && c.sm.endArrow === "none");
  check("dashed lifelines", lifelines.length >= 4, String(lifelines.length));
  // Bước 2: Kiểm tra loại mũi tên (gọi đồng bộ dùng mũi tên đặc block; phản hồi return hoặc tạo mới dùng nét đứt hở)
  const messages = cells.filter((c) => c.edge && (c.sm.endArrow === "block" || (c.sm.dashed === "1" && c.sm.endArrow === "open")));
  check("a synchronous call uses a filled arrow", messages.some((m) => m.sm.endArrow === "block" && m.sm.endFill === "1" && m.sm.dashed !== "1"));
  check("a return or create uses a dashed open arrow", messages.some((m) => m.sm.dashed === "1" && m.sm.endArrow === "open"));
  // Bước 3: Kiểm tra luồng nghiệp vụ tạo đơn đặt sân có stereotype «create», khung điều kiện rẽ nhánh «alt» và thanh kích hoạt (activation bar)
  check("the booking is created with «create»", messages.some((m) => m.value.includes("«create»")));
  check("an alt fragment covers the payment branch", cells.some((c) => c.vertex && plain(c.value) === "alt"));
  check("activation bars are drawn", cells.filter((c) => c.sm.fillColor === "#e2e8f0" && c.w <= 16).length >= 4);
  // Bước 4: Kiểm tra các thông điệp truyền đi phải nằm ngang tuyệt đối (chênh lệch trục Y <= 2px)
  for (const m of messages) {
    if (m.source === m.target) continue;
    const s = map.get(m.source);
    const t = map.get(m.target);
    if (!s || !t) continue;
    const y1 = s.y + Number(m.sm.exitY ?? 0.5) * s.h;
    const y2 = t.y + Number(m.sm.entryY ?? 0.5) * t.h;
    check(`${m.id} is horizontal`, Math.abs(y1 - y2) <= 2, `${y1} vs ${y2}`);
  }
}

// Smoke test tự kiểm tra thuật toán đường nối cắt qua hộp (crossesRect) và hai đường chéo nhau (properCross).
assert(crossesRect({ x: 0, y: 5 }, { x: 100, y: 5 }, { x: 40, y: 0, w: 20, h: 20 }), "a line through a box is a cut");
assert(!crossesRect({ x: 0, y: 5 }, { x: 20, y: 5 }, { x: 40, y: 0, w: 20, h: 20 }), "a line that misses is not a cut");
assert(!crossesRect({ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 0, y: 0, w: 20, h: 10 }), "running along the top edge is not a cut");
assert(properCross({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }), "an X is a crossing");
assert(!properCross({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }), "meeting at an end is not a crossing");

/**
 * Làm gì: Tính toán tọa độ điểm neo (connection port) trên chu vi của một khối hình (elip, hình thoi hoặc hình chữ nhật) theo tỷ lệ kết nối.
 * Được gọi ở: scripts/uml2-review.mjs (hàm edgePoints dòng 346, 347).
 * - Tham số cell: Đối tượng cell hình học chứa tọa độ x, y, kích thước w, h và thuộc tính style.
 * - Tham số px: Tỷ lệ tọa độ X trên cell (từ 0.0 đến 1.0, mặc định 0.5 ở tâm).
 * - Tham số py: Tỷ lệ tọa độ Y trên cell (từ 0.0 đến 1.0, mặc định 0.5 ở tâm).
 * @returns {{ x: number, y: number }} Tọa độ (x, y) của điểm neo trên viền hình.
 */
function port(cell, px, py) {
  const fx = Number(px ?? 0.5);
  const fy = Number(py ?? 0.5);
  // Nhánh 1: Tính điểm giao cắt trên chu vi đường cong elip (Use Case oval)
  if (cell.sm.ellipse === "1" && cell.sm.shape !== "endState") {
    const rx = cell.w / 2;
    const ry = cell.h / 2;
    let dx = (fx - 0.5) * cell.w;
    let dy = (fy - 0.5) * cell.h;
    if (dx === 0 && dy === 0) dx = rx;
    const t = 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
    return { x: cell.x + rx + dx * t, y: cell.y + ry + dy * t };
  }
  // Nhánh 2: Tính điểm neo trên cạnh hình thoi (Decision / Merge node)
  if (cell.sm.rhombus === "1") {
    const vx = (fx - 0.5) * cell.w;
    const vy = (fy - 0.5) * cell.h;
    const sum = 2 * (Math.abs(fx - 0.5) + Math.abs(fy - 0.5)) || 1;
    return { x: cell.x + cell.w / 2 + vx / sum, y: cell.y + cell.h / 2 + vy / sum };
  }
  // Nhánh 3: Khối chữ nhật thông thường: nhân trực tiếp tỷ lệ px, py với kích thước width, height
  return { x: cell.x + fx * cell.w, y: cell.y + fy * cell.h };
}

/**
 * Làm gì: Xác định toàn bộ danh sách tọa độ các điểm tạo nên đường nối (điểm bắt đầu ở source, các điểm gấp khúc trung gian, điểm kết thúc ở target).
 * Được gọi ở: scripts/uml2-review.mjs (hàm gradePicture dòng 481, hàm toSvg dòng 687, hàm drawEdge dòng 656).
 * - Tham số e: Đối tượng đường nối (edge) chứa thông tin source, target và danh sách waypoints.
 * - Tham số map: Map tra cứu cell theo id để xác định khối nguồn và khối đích.
 * @returns {Array<{ x: number, y: number }>} Mảng các điểm tọa độ từ đầu đến cuối của đường nối.
 */
function edgePoints(e, map) {
  const s = map.get(e.source);
  const t = map.get(e.target);
  // Bỏ qua nếu không tìm thấy cell nguồn hoặc cell đích trong sơ đồ
  if (!s || !t) return [];
  // Tính tọa độ điểm xuất phát ở source và điểm tiếp xúc ở target
  const start = e.sm.exitX != null ? port(s, e.sm.exitX, e.sm.exitY) : port(s, 0.5, 0.5);
  const end = e.sm.entryX != null ? port(t, e.sm.entryX, e.sm.entryY) : port(t, 0.5, 0.5);
  return [start, ...(e.points || []), end];
}

/**
 * Làm gì: Tính toán tọa độ của một điểm nằm trên đường gấp khúc đa đoạn (polyline) tương ứng với tỷ lệ khoảng cách t (0.0 đến 1.0).
 * Được gọi ở: scripts/uml2-review.mjs (hàm multBox dòng 392 để đặt nhãn bản số dọc theo đường liên kết).
 * - Tham số pts: Danh sách các điểm liên tiếp tạo nên đường nối.
 * - Tham số t: Tỷ lệ độ dài từ điểm đầu đến điểm cần lấy (0 là điểm đầu, 1 là điểm cuối).
 * @returns {{ x: number, y: number }} Tọa độ (x, y) tại vị trí tỷ lệ t dọc theo đường nối.
 */
function pointAlong(pts, t) {
  const lens = [];
  // Bước 1: Tính độ dài từng đoạn thẳng con và tổng chiều dài của cả đường nối
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    lens.push(d);
    total += d;
  }
  // Bước 2: Duyệt từng đoạn để tìm tọa độ tại vị trí tỷ lệ t dọc theo đường nối
  let left = t * total;
  for (let i = 0; i < lens.length; i++) {
    if (left <= lens[i] || i === lens.length - 1) {
      const u = lens[i] === 0 ? 0 : left / lens[i];
      return {
        x: pts[i].x + (pts[i + 1].x - pts[i].x) * u,
        y: pts[i].y + (pts[i + 1].y - pts[i].y) * u,
      };
    }
    left -= lens[i];
  }
  return pts[pts.length - 1];
}

/**
 * Làm gì: Tìm đoạn thẳng có độ dài lớn nhất trong tập các điểm uốn (polyline) của một đường nối.
 * Được gọi ở: scripts/uml2-review.mjs:labelBox
 * - Tham số pts: Mảng danh sách các điểm tọa độ {x, y} dọc theo đường nối
 * @returns {{ i: number, len: number }} Vị trí chỉ số đoạn dài nhất (i) và độ dài của nó (len)
 */
function longestSeg(pts) {
  let best = 0;
  let len = -1;
  // Duyệt qua từng cặp điểm liên tiếp để tìm đoạn thẳng dài nhất, dùng làm vị trí ưu tiên đặt nhãn
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    if (d > len) {
      len = d;
      best = i;
    }
  }
  return { i: best, len };
}

/**
 * Làm gì: Kiểm tra xem một cell trong file draw.io có phải là nhãn thuộc về đường nối (edge label) hay không.
 * Được gọi ở: scripts/uml2-review.mjs:gradePicture, scripts/uml2-review.mjs:toSvg
 * - Tham số c: Đối tượng cell cần kiểm tra (chứa styleMap sm, parent, vertex)
 * @returns {boolean} true nếu cell là nhãn của đường nối, ngược lại false
 */
function isEdgeLabel(c) {
  // Nhãn cạnh được đánh dấu rõ bằng edgeLabel=1 hoặc là một vertex con trực tiếp của đường nối (parent khác "0" và "1")
  return c.sm.edgeLabel === "1" || (c.vertex && c.parent !== "1" && c.parent !== "0");
}

/**
 * Làm gì: Tính toán bounding box (vị trí x, y, kích thước w, h) cho nhãn chỉ số bội (multiplicity) gần hai đầu đường nối.
 * Được gọi ở: scripts/uml2-review.mjs:gradePicture, scripts/uml2-review.mjs:toSvg
 * - Tham số text: Chuỗi văn bản nhãn bội số (ví dụ: "1", "0..*")
 * - Tham số pts: Mảng danh sách các điểm tọa độ {x, y} của đường nối
 * - Tham số t: Tỷ lệ vị trí tương đối dọc theo đường nối (từ 0 đến 1)
 * @returns {{ x: number, y: number, w: number, h: number, text: string }} Khung chữ nhật bao quanh nhãn bội số
 */
function multBox(text, pts, t) {
  // Bước 1: Xác định điểm mốc p (t < 0.5 là gần đầu nguồn u=0.24, ngược lại gần đầu đích u=0.76)
  const u = t < 0.5 ? 0.24 : 0.76;
  const p = pointAlong(pts, u);
  const a = pts[0];
  const b = pts[pts.length - 1];
  // Bước 2: Tính vector pháp tuyến (nx, ny) vuông góc với hướng nối a->b để dịch nhãn ra ngoài nét vẽ
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const n = Math.hypot(dx, dy) || 1;
  let nx = -dy / n;
  let ny = dx / n;
  if (nx < 0) {
    nx = -nx;
    ny = -ny;
  }
  // Bước 3: Ước lượng kích thước chữ (tw, th) và tính tọa độ tâm hộp nhãn (cx, cy)
  const tw = Math.max(16, text.length * 6.4 + 8);
  const th = 14;
  const cx = p.x + nx * (tw / 2 + 6);
  const cy = p.y + ny * 8;
  return { x: cx - tw / 2, y: cy - th / 2, w: tw, h: th, text };
}

/**
 * Làm gì: Tính toán bounding box cho nhãn văn bản chính của đường nối (tên quan hệ, tên thông điệp sequence).
 * Được gọi ở: scripts/uml2-review.mjs:gradePicture, scripts/uml2-review.mjs:toSvg
 * - Tham số text: Nội dung chuỗi văn bản của nhãn
 * - Tham số pts: Mảng danh sách các điểm tọa độ {x, y} của đường nối
 * - Tham số [size=11]: Cỡ chữ theo pixel (mặc định 11px)
 * @returns {{ x: number, y: number, w: number, h: number, text: string }} Khung chữ nhật bao quanh nhãn
 */
function labelBox(text, pts, size = 11) {
  // Bước 1: Xử lý đường tự gọi (self-call loop): Đặt nhãn lệch sang phải của đỉnh xa nhất ngoài cùng
  const self = pts.length > 2 && Math.abs(pts[0].x - pts[pts.length - 1].x) < 4 && Math.abs(pts[0].y - pts[pts.length - 1].y) < 40;
  if (self) {
    const tip = pts.reduce((m, p) => (p.x > m.x ? p : m), pts[0]);
    const tw = Math.max(14, text.length * size * 0.56 + 8);
    const th = size + 6;
    return { x: tip.x + 8, y: tip.y - th / 2, w: tw, h: th, text };
  }
  // Bước 2: Với đường thông thường, chọn đoạn thẳng dài nhất để đặt nhãn tránh bị gãy khúc
  const { i, len } = longestSeg(pts);
  const a = pts[i];
  const b = pts[i + 1] || a;
  const tw = Math.max(14, text.length * size * 0.56 + 8);
  const along = tw > len * 0.45 ? 0.5 : len > 280 ? 0.28 : 0.5;
  const mx = a.x + (b.x - a.x) * along;
  const my = a.y + (b.y - a.y) * along;
  // Bước 3: Xác định hướng đoạn thẳng (dọc hay ngang) và dịch chuyển nhãn ra ngoài nét vẽ để không bị che khuất
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const vertical = Math.abs(dx) < Math.abs(dy);
  let nx = 0;
  let ny = -1;
  if (vertical) {
    nx = mx < 700 ? 1 : -1;
    ny = 0;
  }
  const th = size + 6;
  const cx = mx + nx * (tw / 2 + 4);
  const cy = my + ny * (th / 2 + 3);
  return { x: cx - tw / 2, y: cy - th / 2, w: tw, h: th, text };
}

/**
 * Làm gì: Kiểm tra đoạn thẳng nối từ điểm p đến q có cắt xuyên qua vùng lõi của hình chữ nhật rect hay không.
 * Được gọi ở: scripts/uml2-review.mjs:assert (dòng 315-317), scripts/uml2-review.mjs:gradePicture
 * - Tham số p: Điểm đầu {x, y} của đoạn thẳng
 * - Tham số q: Điểm cuối {x, y} của đoạn thẳng
 * - Tham số rect: Khung chữ nhật {x, y, w, h} của phần tử cần kiểm tra va chạm
 * @returns {boolean} true nếu đoạn thẳng cắt xuyên qua bên trong hình chữ nhật, ngược lại false
 */
function crossesRect(p, q, rect) {
  // Thu hẹp biên 1.5px để không bắt nhầm các đường đi sát mép hoặc chỉ tiếp xúc cạnh ngoài
  const inside = (x, y) => x > rect.x + 1.5 && x < rect.x + rect.w - 1.5 && y > rect.y + 1.5 && y < rect.y + rect.h - 1.5;
  // Lấy mẫu 40 điểm nội suy dọc đoạn p->q để phát hiện nếu có bất kỳ điểm nào nằm lọt vào trong hình
  for (let i = 1; i < 40; i++) {
    const u = i / 40;
    if (inside(p.x + (q.x - p.x) * u, p.y + (q.y - p.y) * u)) return true;
  }
  return false;
}

/**
 * Làm gì: Tính tích có hướng (cross product) 2D để xác định hướng rẽ của bộ ba điểm a -> b -> c.
 * Được gọi ở: scripts/uml2-review.mjs:properCross
 * - Tham số a: Điểm gốc {x, y}
 * - Tham số b: Điểm thứ hai {x, y}
 * - Tham số c: Điểm thứ ba {x, y}
 * @returns {number} 0 nếu ba điểm thẳng hàng, 1 nếu rẽ phải, -1 nếu rẽ trái
 */
function orient(a, b, c) {
  // Công thức tích có hướng 2D: (b.x - a.x)*(c.y - a.y) - (b.y - a.y)*(c.x - a.x)
  const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(v) < 1) return 0;
  return Math.sign(v);
}

/**
 * Làm gì: Kiểm tra xem hai đoạn thẳng ab và cd có cắt chéo nhau thực sự (proper intersection) hay không.
 * Được gọi ở: scripts/uml2-review.mjs:assert (dòng 318-319), scripts/uml2-review.mjs:gradePicture
 * - Tham số a: Điểm đầu đoạn thẳng 1 {x, y}
 * - Tham số b: Điểm cuối đoạn thẳng 1 {x, y}
 * - Tham số c: Điểm đầu đoạn thẳng 2 {x, y}
 * - Tham số d: Điểm cuối đoạn thẳng 2 {x, y}
 * @returns {boolean} true nếu hai đoạn cắt chéo nhau qua thân (không tính chạm điểm mút)
 */
function properCross(a, b, c, d) {
  // Hai đoạn cắt nhau thực sự khi các điểm mút của mỗi đoạn nằm về hai phía đối lập của đoạn còn lại
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

/**
 * Làm gì: Kiểm tra hai đoạn thẳng nằm ngang hoặc thẳng đứng có chạy đè lên cùng một đường (collinear overlap > 8px) hay không.
 * Được gọi ở: scripts/uml2-review.mjs:gradePicture
 * - Tham số a: Điểm đầu đoạn thẳng 1 {x, y}
 * - Tham số b: Điểm cuối đoạn thẳng 1 {x, y}
 * - Tham số c: Điểm đầu đoạn thẳng 2 {x, y}
 * - Tham số d: Điểm cuối đoạn thẳng 2 {x, y}
 * @returns {boolean} true nếu hai đoạn chạy trùng đường với phần chồng lấn lớn hơn 8px
 */
function sameTrack(a, b, c, d) {
  const overlap = (a1, a2, b1, b2) => Math.min(a2, b2) - Math.max(a1, b1);
  // Kiểm tra hai đoạn cùng nằm ngang (chênh lệch y < 2px) và có phần chồng lấn > 8px
  if (Math.abs(a.y - b.y) < 2 && Math.abs(c.y - d.y) < 2 && Math.abs(a.y - c.y) < 2) {
    return overlap(Math.min(a.x, b.x), Math.max(a.x, b.x), Math.min(c.x, d.x), Math.max(c.x, d.x)) > 8;
  }
  // Kiểm tra hai đoạn cùng thẳng đứng (chênh lệch x < 2px) và có phần chồng lấn > 8px
  if (Math.abs(a.x - b.x) < 2 && Math.abs(c.x - d.x) < 2 && Math.abs(a.x - c.x) < 2) {
    return overlap(Math.min(a.y, b.y), Math.max(a.y, b.y), Math.min(c.y, d.y), Math.max(c.y, d.y)) > 8;
  }
  return false;
}

/**
 * Làm gì: Xác định một cell có phải là khối hình đặc có màu nền (solid body) để cấm đường vẽ cắt xuyên qua hay không.
 * Được gọi ở: scripts/uml2-review.mjs:gradePicture
 * - Tham số c: Đối tượng cell cần kiểm tra
 * @returns {boolean} true nếu là khối đặc ở tầng gốc (parent="1"), có màu nền hiển thị và kích thước hợp lệ
 */
function solid(c) {
  // Bỏ qua khung ranh giới hệ thống cỡ lớn (h >= 400) hoặc khối không màu nền/trong suốt
  return c.vertex && c.parent === "1" && c.w > 2 && c.h > 2 && c.h < 400 && c.sm.opacity !== "0" && c.sm.fillColor !== "none" && !c.style.includes("fillColor=none");
}

/**
 * Làm gì: Chấm điểm thẩm mỹ và bố cục hình học của sơ đồ (nhãn trong trang, không đè khối/chữ, không cắt xuyên hình, không cắt chéo đường, chữ vừa khung).
 * Được gọi ở: scripts/uml2-review.mjs:grade (dòng 154)
 * - Tham số check: Hàm callback ghi nhận kết quả kiểm tra: check(rule, passed, detail)
 * - Tham số cells: Mảng tất cả các cell mxCell được phân tích từ XML
 * - Tham số map: Bản đồ Map ánh xạ id -> cell để tra cứu nhanh phần tử
 * - Tham số pageW: Chiều rộng trang vẽ từ XML (pageWidth)
 * - Tham số pageH: Chiều cao trang vẽ từ XML (pageHeight)
 * @returns {void}
 */
function gradePicture(check, cells, map, pageW, pageH) {
  // Bước 1: Thu thập tất cả các đường nối hợp lệ và tính toán bounding box cho các nhãn (tên quan hệ và multiplicity)
  const drawn = cells.filter((c) => c.edge && map.has(c.source) && map.has(c.target));
  const polys = new Map(drawn.map((e) => [e.id, edgePoints(e, map)]));
  const labels = [];
  for (const e of drawn) {
    const pts = polys.get(e.id);
    if (e.value.trim()) labels.push([e.id, labelBox(plain(e.value), pts)]);
    for (const child of cells.filter((c) => c.parent === e.id && isEdgeLabel(c))) {
      const t = (Number(child.x) + 1) / 2;
      labels.push([child.id, multBox(child.value, pts, t)]);
    }
  }
  // Bước 2: Kiểm tra tất cả các nhãn phải nằm trọn vẹn trong trang giấy (không tràn ra ngoài biên)
  for (const [id, box] of labels) {
    check(`${id} label stays on the page`, box.x >= 1 && box.y >= 1 && box.x + box.w <= pageW - 1 && box.y + box.h <= pageH - 1, `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.w)}×${Math.round(box.h)}`);
  }
  // Bước 3: Lọc các khối đặc (solid bodies) và kiểm tra không nhãn nào được nằm đè lên thân khối
  const bodies = cells.filter(solid);
  for (const body of bodies) {
    for (const [id, box] of labels) {
      if (intersects(box, { x: body.x + 2, y: body.y + 2, w: body.w - 4, h: body.h - 4 })) {
        check(`${id} label is not on ${body.id}`, false);
      }
    }
  }
  // Bước 4: Kiểm tra không có hai nhãn nào bị đặt chồng lấn lên nhau gây khó đọc
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (intersects(labels[i][1], labels[j][1])) {
        check("labels do not cover each other", false, `${labels[i][0]} × ${labels[j][0]}`);
      }
    }
  }
  // Bước 5: Kiểm tra các đường nối không được đâm xuyên qua thân các khối đặc khác (trừ khối nguồn và khối đích)
  for (const e of drawn) {
    if (e.sm.dashed === "1" && e.sm.endArrow === "none") continue;
    const pts = polys.get(e.id);
    for (let i = 0; i < pts.length - 1; i++) {
      for (const body of bodies) {
        if (body.id === e.source || body.id === e.target) continue;
        if (crossesRect(pts[i], pts[i + 1], body)) {
          check(`${e.id} does not cut through ${body.id}`, false);
        }
      }
    }
  }
  // Bước 6: Kiểm tra các đường nối không được cắt chéo qua nhau hoặc chạy trùng vệt với nhau
  for (let i = 0; i < drawn.length; i++) {
    for (let j = i + 1; j < drawn.length; j++) {
      const a = drawn[i];
      const b = drawn[j];
      if (a.sm.dashed === "1" && a.sm.endArrow === "none") continue;
      if (b.sm.dashed === "1" && b.sm.endArrow === "none") continue;
      const pa = polys.get(a.id);
      const pb = polys.get(b.id);
      for (let s = 0; s < pa.length - 1; s++) {
        for (let t = 0; t < pb.length - 1; t++) {
          if (properCross(pa[s], pa[s + 1], pb[t], pb[t + 1]) || sameTrack(pa[s], pa[s + 1], pb[t], pb[t + 1])) {
            check(`${a.id} does not cross ${b.id}`, false);
          }
        }
      }
    }
  }
  // Bước 7: Với khối lớp (class box có thẻ <hr>), kiểm tra chiều rộng khối có đủ chứa từng dòng thuộc tính và phương thức
  for (const c of cells.filter((n) => n.vertex && n.parent === "1" && n.value.includes("<hr"))) {
    const parts = c.value.split(/<hr\s*\/?>/i).map((p) => plain(p));
    const lines = [...(parts[1] || "").split("\n"), ...(parts[2] || "").split("\n")].map((s) => s.trim()).filter(Boolean);
    for (const line of lines) {
      check(`${c.id} fits "${line}"`, line.length * 11 * 0.56 + 16 <= c.w - 18, `need ${Math.ceil(line.length * 11 * 0.56 + 34)}`);
    }
  }
  // Bước 8: Kiểm tra các hình khối đặc biệt (oval, rounded, sendSignal, actor) có đủ chiều rộng chứa văn bản
  for (const c of cells.filter((n) => n.vertex && n.parent === "1" && (n.sm.ellipse === "1" || n.sm.rounded === "1" || n.sm.shape === "sendSignal" || n.value.includes("«actor»")))) {
    for (const line of plain(c.value).split("\n").filter(Boolean)) {
      check(`${c.id} fits "${line}"`, line.length * 12 * 0.56 + 12 <= c.w - 8);
    }
  }
}

/**
 * Làm gì: Tạo chuỗi thẻ SVG <text> hỗ trợ văn bản nhiều dòng, tự động căn lề và mã hóa an toàn ký tự đặc biệt (&, <, >).
 * Được gọi ở: scripts/uml2-review.mjs:drawNode
 * - Tham số value: Chuỗi nội dung văn bản (có thể gồm nhiều dòng)
 * - Tham số x: Tọa độ X của vùng chứa văn bản
 * - Tham số y: Tọa độ Y của vùng chứa văn bản
 * - Tham số w: Chiều rộng của vùng chứa văn bản
 * - Tham số h: Chiều cao của vùng chứa văn bản
 * - Tham số [opt={}]: Tùy chọn căn chỉnh và định dạng font chữ (size, anchor, bold, top, pad)
 * @returns {string} Chuỗi mã SVG chứa một hoặc nhiều thẻ <text>
 */
function svgText(value, x, y, w, h, opt = {}) {
  // Bước 1: Tách văn bản thành từng dòng, tính toán chiều cao tổng và tọa độ dòng đầu tiên (ty)
  const lines = plain(value).split("\n");
  const size = opt.size || 12;
  const anchor = opt.anchor || "middle";
  const tx = anchor === "start" ? x : x + w / 2;
  const lineH = size + 3;
  const total = lines.length * lineH;
  let ty = y + (h - total) / 2 + size;
  if (opt.top) ty = y + size + (opt.pad ?? 4);
  // Bước 2: Escape các ký tự đặc biệt HTML và render từng dòng thành thẻ <text>
  return lines
    .map((line, i) => {
      const safe = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<text x="${tx}" y="${ty + i * lineH}" text-anchor="${anchor}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${opt.bold ? "700" : "400"}" fill="#1e293b">${safe}</text>`;
    })
    .join("");
}

/**
 * Làm gì: Chuyển đổi một phần tử đỉnh (vertex cell) trong draw.io thành mã SVG tương ứng với kiểu dáng của nó.
 * Được gọi ở: scripts/uml2-review.mjs:toSvg
 * - Tham số c: Đối tượng cell cần render (tọa độ x, y, w, h, kiểu shape, styleMap sm, nội dung value)
 * @returns {string} Chuỗi mã SVG biểu diễn khối hình học và nội dung chữ bên trong
 */
function drawNode(c) {
  const { x, y, w, h } = c;
  // Bỏ qua phần tử ẩn hoàn toàn (opacity=0)
  if (c.sm.opacity === "0") return "";
  // Trường hợp 1: Người que (UML Actor) cho Use Case diagram
  if (c.sm.shape === "umlActor") {
    const cx = x + w / 2;
    const headY = y + 2;
    return `<g>
      <circle cx="${cx}" cy="${headY + 8}" r="8" fill="#fff" stroke="#1e293b" stroke-width="1.4"/>
      <line x1="${cx}" y1="${headY + 16}" x2="${cx}" y2="${y + 42}" stroke="#1e293b" stroke-width="1.4"/>
      <line x1="${cx - 12}" y1="${y + 28}" x2="${cx + 12}" y2="${y + 28}" stroke="#1e293b" stroke-width="1.4"/>
      <line x1="${cx}" y1="${y + 42}" x2="${cx - 12}" y2="${y + 62}" stroke="#1e293b" stroke-width="1.4"/>
      <line x1="${cx}" y1="${y + 42}" x2="${cx + 12}" y2="${y + 62}" stroke="#1e293b" stroke-width="1.4"/>
      ${svgText(c.value, x - 40, y + h, w + 80, 18, { size: 12 })}
    </g>`;
  }
  // Trường hợp 2: Trạng thái kết thúc (endState) gồm vòng tròn bao ngoài và chấm tròn đặc bên trong
  if (c.sm.shape === "endState") {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const r = Math.min(w, h) / 2;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" stroke="#111" stroke-width="1.6"/><circle cx="${cx}" cy="${cy}" r="${r * 0.55}" fill="#111"/>`;
  }
  // Trường hợp 3: Điểm khởi đầu (initial state / black circle)
  if (c.sm.ellipse === "1" && c.sm.fillColor === "#111111") {
    return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="#111"/>`;
  }
  // Trường hợp 4: Hình bầu dục tiêu chuẩn (Use Case oval hoặc Activity action state)
  if (c.sm.ellipse === "1") {
    return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="#fff" stroke="#1e293b" stroke-width="1.4"/>${svgText(c.value, x + 8, y, w - 16, h)}`;
  }
  // Trường hợp 5: Hình quả trám (Rhombus - điểm rẽ nhánh quyết định Decision node)
  if (c.sm.rhombus === "1") {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const verb = plain(c.value);
    const text = verb ? svgText(verb, x, y, w, h, { size: 11 }) : "";
    return `<polygon points="${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}" fill="#fff" stroke="#1e293b" stroke-width="1.4"/>${text}`;
  }
  // Trường hợp 6: Hình mũi tên phát tín hiệu (sendSignal)
  if (c.sm.shape === "sendSignal") {
    const nose = 16;
    return `<polygon points="${x},${y} ${x + w - nose},${y} ${x + w},${y + h / 2} ${x + w - nose},${y + h} ${x},${y + h}" fill="#fff" stroke="#1e293b" stroke-width="1.4"/>${svgText(c.value, x + 4, y, w - nose - 4, h, { size: 11 })}`;
  }
  // Trường hợp 7: Khối lớp UML (Class box 3 ngăn tách bởi thẻ <hr>: Tên lớp, Thuộc tính, Phương thức)
  if (c.value.includes("<hr")) {
    const parts = c.value.split(/<hr\s*\/?>/i).map((p) => plain(p));
    const name = parts[0] || "";
    const attrs = (parts[1] || "").split("\n").filter(Boolean);
    const ops = (parts[2] || "").split("\n").filter(Boolean);
    let yy = y;
    const nameH = 26;
    const row = 16;
    const attrH = Math.max(attrs.length, 1) * row + 8;
    const chunks = [
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#f8fafc" stroke="#475569" stroke-width="1.3"/>`,
      `<line x1="${x}" y1="${y + nameH}" x2="${x + w}" y2="${y + nameH}" stroke="#475569"/>`,
      `<line x1="${x}" y1="${y + nameH + attrH}" x2="${x + w}" y2="${y + nameH + attrH}" stroke="#475569"/>`,
      svgText(name, x, y + 2, w, nameH, { bold: true, size: 13 }),
    ];
    attrs.forEach((line, i) => chunks.push(svgText(line, x + 10, y + nameH + 2 + i * row, w - 20, row, { size: 11, anchor: "start", top: true, pad: 1 })));
    ops.forEach((line, i) => chunks.push(svgText(line, x + 10, y + nameH + attrH + 2 + i * row, w - 20, row, { size: 11, anchor: "start", top: true, pad: 1 })));
    yy = y;
    return `<defs><clipPath id="clip-${c.id}"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></clipPath></defs><g clip-path="url(#clip-${c.id})">${chunks.join("")}</g>`;
  }
  // Trường hợp 8: Khung chứa rỗng không nền (system boundary hoặc ghi chú)
  if (c.sm.fillColor === "none" || c.style.includes("fillColor=none")) {
    const label = plain(c.value);
    const stroke = c.sm.strokeColor === "none" ? "none" : "#1e293b";
    const rect = stroke === "none" ? "" : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${stroke}" stroke-width="1.4"/>`;
    const text = label ? svgText(label, x + 4, y, w - 8, 22, { top: true, bold: c.sm.fontStyle === "1", size: 13 }) : "";
    return rect + text;
  }
  // Trường hợp 9: Khối chữ nhật màu xám nhạt (thanh kích hoạt activation bar)
  if (c.sm.fillColor === "#e2e8f0") {
    const label = plain(c.value);
    const text = label ? svgText(label, x + 4, y, w - 8, h, { bold: true, size: 12 }) : "";
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#e2e8f0" stroke="#1e293b" stroke-width="1"/>${text}`;
  }
  // Trường hợp 10: Thanh phân nhánh/hội tụ đồng bộ (fork/join bar trong Activity diagram, h <= 2px)
  if (c.h <= 2) {
    return `<rect x="${x}" y="${y}" width="${w}" height="${Math.max(h, 1)}" fill="#1e293b"/>`;
  }
  // Trường hợp 11: Khung chữ nhật mặc định (bo góc rounded hoặc góc vuông)
  const rounded = c.sm.rounded === "1";
  const fill = c.sm.fillColor || "#ffffff";
  const stroke = c.sm.strokeColor === "none" ? "none" : c.sm.strokeColor || "#1e293b";
  const top = c.sm.verticalAlign === "top";
  const anchor = c.sm.align === "left" ? "start" : "middle";
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rounded ? 8 : 0}" fill="${fill}" stroke="${stroke}" stroke-width="1.3"/>${svgText(c.value, x + 6, y, w - 12, h, { size: 12, bold: c.sm.fontStyle === "1", top, anchor })}`;
}

/**
 * Làm gì: Render nhãn chữ kèm hình chữ nhật nền trắng (plate) để đè lên đường nối, giúp chữ không bị nét vẽ cắt ngang.
 * Được gọi ở: scripts/uml2-review.mjs:toSvg
 * - Tham số box: Khung chữ nhật bao quanh nhãn {x, y, w, h, text}
 * @returns {string} Chuỗi mã SVG gồm thẻ <rect> nền trắng và thẻ <text> nằm trên
 */
function plate(box) {
  const safe = box.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="#ffffff"/><text x="${box.x + box.w / 2}" y="${box.y + box.h - 3}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#1e293b">${safe}</text>`;
}

/**
 * Làm gì: Chuyển đổi một cạnh nối (edge cell) thành thẻ SVG path kèm đầu mũi tên phù hợp (block hoặc open arrow).
 * Được gọi ở: scripts/uml2-review.mjs:toSvg
 * - Tham số e: Đối tượng edge cell chứa styleMap và danh sách điểm nối
 * - Tham số map: Bản đồ Map ánh xạ id -> cell để xác định vị trí node nguồn và node đích
 * @returns {string} Chuỗi mã SVG biểu diễn đường nối và đầu mũi tên (nếu có)
 */
function drawEdge(e, map) {
  // Bước 1: Tính toán tọa độ chuỗi điểm uốn dọc theo đường nối từ cổng nguồn sang cổng đích
  const pts = edgePoints(e, map);
  if (pts.length < 2) return "";
  // Bước 2: Tạo đường dẫn SVG path (lệnh M, L) và thiết lập nét đứt (stroke-dasharray) nếu có
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const dashed = e.sm.dashed === "1" ? `stroke-dasharray="5 4"` : "";
  // Bước 3: Tính góc xoay (ang) tại điểm cuối để vẽ đầu mũi tên (tam giác đặc hoặc mũi tên mở)
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const ang = Math.atan2(last.y - prev.y, last.x - prev.x);
  let marker = "";
  if (e.sm.endArrow === "block" && e.sm.endFill === "1") {
    const s1 = 8;
    const p1 = { x: last.x - s1 * Math.cos(ang) - 4 * Math.sin(ang), y: last.y - s1 * Math.sin(ang) + 4 * Math.cos(ang) };
    const p2 = { x: last.x - s1 * Math.cos(ang) + 4 * Math.sin(ang), y: last.y - s1 * Math.sin(ang) - 4 * Math.cos(ang) };
    marker = `<polygon points="${last.x},${last.y} ${p1.x},${p1.y} ${p2.x},${p2.y}" fill="#1e293b"/>`;
  } else if (e.sm.endArrow === "open") {
    const s1 = 9;
    const p1 = { x: last.x - s1 * Math.cos(ang) - 4 * Math.sin(ang), y: last.y - s1 * Math.sin(ang) + 4 * Math.cos(ang) };
    const p2 = { x: last.x - s1 * Math.cos(ang) + 4 * Math.sin(ang), y: last.y - s1 * Math.sin(ang) - 4 * Math.cos(ang) };
    marker = `<polyline points="${p1.x},${p1.y} ${last.x},${last.y} ${p2.x},${p2.y}" fill="none" stroke="#1e293b" stroke-width="1.3"/>`;
  }
  return `<path d="${d}" fill="none" stroke="#1e293b" stroke-width="1.3" ${dashed}/>${marker}`;
}

/**
 * Làm gì: Chuyển đổi toàn bộ nội dung XML của file draw.io thành tài liệu ảnh vector SVG hoàn chỉnh theo từng lớp vẽ.
 * Được gọi ở: scripts/uml2-review.mjs:vòng lặp chính (dòng 710)
 * - Tham số xml: Chuỗi mã nguồn XML của file .drawio
 * @returns {string} Toàn bộ tài liệu SVG hoàn chỉnh chứa tất cả các phần tử
 */
function toSvg(xml) {
  // Bước 1: Phân tích cú pháp XML, tạo map tra cứu và tách các khối nền lớn (back) với khối phía trước (front)
  const { cells, pageW, pageH } = parse(xml);
  const map = byId(cells);
  const nodes = cells.filter((c) => c.vertex && c.parent === "1");
  const edges = cells.filter((c) => c.edge);
  const back = nodes.filter((c) => c.w > 200 && (c.sm.fillColor === "#f8fafc" || c.sm.fillColor === "none"));
  const front = nodes.filter((c) => !back.includes(c));
  // Bước 2: Tính toán và tạo bounding box cho tất cả nhãn chữ trên các đường nối
  const labels = [];
  for (const e of edges) {
    const pts = edgePoints(e, map);
    if (pts.length < 2) continue;
    if (e.value.trim()) labels.push(labelBox(plain(e.value), pts));
    for (const child of cells.filter((c) => c.parent === e.id && isEdgeLabel(c))) {
      const t = (Number(child.x) + 1) / 2;
      labels.push(multBox(child.value, pts, t));
    }
  }
  // Bước 3: Ghép các lớp SVG theo đúng thứ tự hiển thị: Khung nền -> Đường nối -> Khối phía trước -> Nhãn chữ
  const body = [...back.map(drawNode), ...edges.map((e) => drawEdge(e, map)), ...front.map(drawNode), ...labels.map(plate)].join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${pageW}" height="${pageH}" viewBox="0 0 ${pageW} ${pageH}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  ${body}
</svg>`;
}

// ============================================================================
// LUỒNG CHẠY CHÍNH (CLI Execution Flow):
// Bước 1: Đọc và chấm điểm từng file sơ đồ .drawio trong danh sách FILES, xuất ra file .svg
// Bước 2: Dùng Playwright chụp ảnh SVG thành file .png sắc nét với độ phân giải cao
// Bước 3: Ghi báo cáo tổng hợp ra uml2-review.json và kết thúc tiến trình (exit 0 nếu pass hết)
// ============================================================================
const report = [];
let failed = 0;
// Bước 1: Lặp qua từng sơ đồ, chấm điểm các quy tắc UML và xuất file SVG tương ứng
for (const [kind, path] of FILES) {
  const xml = readFileSync(path, "utf8");
  const fails = grade(kind, xml);
  const svgPath = path.replace(/\.drawio$/, ".svg");
  const pngPath = path.replace(/\.drawio$/, ".png");
  writeFileSync(svgPath, toSvg(xml));
  failed += fails.length;
  report.push({ kind, path, png: pngPath, fails });
  console.log(`\n${kind}: ${fails.length === 0 ? "PASS" : "FAIL"}`);
  for (const f of fails) console.log(`  - ${f.rule}${f.detail ? ` (${f.detail})` : ""}`);
}

// Tạo thư mục docs/diagrams nếu chưa có để sẵn sàng lưu ảnh PNG chụp từ trình duyệt
mkdirSync("docs/diagrams", { recursive: true });
// Bước 2: Khởi chạy Chromium thông qua Playwright để render SVG và chụp ảnh màn hình ra file PNG (scale x2)
const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
for (const item of report) {
  const svg = readFileSync(item.path.replace(/\.drawio$/, ".svg"), "utf8");
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><body style="margin:0;background:#fff">${svg}</body>`, { waitUntil: "load" });
  const box = await page.locator("svg").boundingBox();
  await page.setViewportSize({ width: Math.ceil(box.width), height: Math.ceil(box.height) });
  await page.locator("svg").screenshot({ path: item.png });
  await page.close();
  console.log("shot", item.png);
}
await browser.close();

// Bước 3: Lưu toàn bộ kết quả đánh giá vào file JSON và trả mã thoát tiến trình (0: thành công, 1: có lỗi)
writeFileSync(
  "docs/diagrams/uml2-review.json",
  JSON.stringify({ at: new Date().toISOString(), book: "Learning UML 2.0, Miles & Hamilton, O'Reilly 2006", failed, report }, null, 2),
);
console.log(`\n${failed === 0 ? "ALL RULES PASSED" : failed + " rule failures"}. Wrote docs/diagrams/uml2-review.json`);
process.exit(failed === 0 ? 0 : 1);
