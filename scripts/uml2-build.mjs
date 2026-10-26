#!/usr/bin/env node
/**
 * Draw Arena 3 SRS section III figures, plus the UML class, sequence,
 * and registration activity. Rules: .grok/skills/uml2-oreilly/SKILL.md.
 */
import { writeFileSync } from "node:fs";

const STROKE = "#1e293b";
const FONT = "fontFamily=Helvetica;";

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function model(pageW, pageH, cells) {
  const body = cells.map(cellXml).join("\n");
  return `<mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${pageW}" pageHeight="${pageH}" background="#ffffff">
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
${body}
  </root>
</mxGraphModel>
`;
}

function cellXml(c) {
  const attrs = [
    `id="${c.id}"`,
    `value="${esc(c.value || "")}"`,
    `style="${c.style}"`,
    c.vertex ? `vertex="1"` : `edge="1"`,
    `parent="${c.parent || "1"}"`,
  ];
  if (c.source) attrs.push(`source="${c.source}"`);
  if (c.target) attrs.push(`target="${c.target}"`);
  const pts = (c.points || [])
    .map((p) => `<mxPoint x="${p.x}" y="${p.y}"/>`)
    .join("");
  const arr = pts ? `<Array as="points">${pts}</Array>` : "";
  const geom = c.edgeLabel
    ? `x="${c.x}" y="0" relative="1"`
    : c.vertex
      ? `x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}"`
      : `relative="1"`;
  const offset = c.edgeLabel ? `<mxPoint y="-12" as="offset"/>` : "";
  return `    <mxCell ${attrs.join(" ")}>
      <mxGeometry ${geom} as="geometry">${offset}${arr}</mxGeometry>
    </mxCell>`;
}

function box(cells, id, value, style, x, y, w, h) {
  cells.push({ id, value, style, vertex: true, x, y, w, h });
  return id;
}

function link(cells, id, value, style, source, target, points, ports) {
  let st = style;
  if (ports) {
    st += `exitX=${ports.sx};exitY=${ports.sy};entryX=${ports.tx};entryY=${ports.ty};`;
  }
  cells.push({ id, value, style: st, edge: true, source, target, points });
  return id;
}

function mult(cells, edgeId, value, at) {
  cells.push({
    id: `${edgeId}_${at}`,
    value,
    style: `edgeLabel;html=1;align=center;verticalAlign=middle;resizable=0;fontSize=11;${FONT}fontColor=${STROKE};`,
    vertex: true,
    edgeLabel: true,
    parent: edgeId,
    x: at === "src" ? -0.75 : 0.75,
    y: 0,
    w: 0,
    h: 0,
  });
}

const line = `endArrow=none;html=1;strokeColor=${STROKE};fontSize=11;${FONT}fontColor=${STROKE};`;
const comm = line;
const include = `endArrow=open;endFill=0;dashed=1;html=1;strokeColor=${STROKE};fontSize=11;${FONT}fontColor=${STROKE};`;
const sync = `endArrow=block;endFill=1;html=1;strokeColor=${STROKE};fontSize=11;${FONT}fontColor=${STROKE};`;
const ret = `endArrow=open;endFill=0;dashed=1;html=1;strokeColor=${STROKE};fontSize=11;${FONT}fontColor=${STROKE};`;
const flow = `endArrow=block;endFill=1;html=1;strokeColor=${STROKE};fontSize=11;${FONT}fontColor=${STROKE};`;
const actorStyle = `shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;fillColor=#ffffff;strokeColor=${STROKE};fontSize=12;${FONT}`;
const oval = `ellipse;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=${STROKE};fontSize=12;${FONT}fontColor=${STROKE};`;
const boundary = `rounded=0;whiteSpace=wrap;html=1;fillColor=none;strokeColor=${STROKE};verticalAlign=top;fontStyle=1;fontSize=14;align=center;spacingTop=6;${FONT}`;
const CLASS = `verticalAlign=top;align=left;overflow=fill;fontSize=12;fontFamily=Helvetica;html=1;whiteSpace=wrap;fillColor=#f8fafc;strokeColor=#475569;`;
const action = `rounded=1;whiteSpace=wrap;html=1;arcSize=12;fillColor=#ffffff;strokeColor=${STROKE};fontSize=12;${FONT}`;
const diamond = `rhombus;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=${STROKE};`;
const initial = `ellipse;html=1;fillColor=#111111;strokeColor=#111111;`;
const final = `ellipse;html=1;shape=endState;fillColor=#000000;strokeColor=#000000;`;
const signal = `shape=sendSignal;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=${STROKE};fontSize=12;${FONT}`;
const lane = `rounded=0;whiteSpace=wrap;html=1;fillColor=#f8fafc;strokeColor=#94a3b8;verticalAlign=top;fontStyle=1;align=center;spacingTop=6;fontSize=13;${FONT}`;
const head = `rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=${STROKE};fontSize=12;${FONT}`;
const bar = `rounded=0;html=1;fillColor=#e2e8f0;strokeColor=${STROKE};`;
const frame = `rounded=0;whiteSpace=wrap;html=1;fillColor=none;strokeColor=${STROKE};verticalAlign=top;align=left;spacingLeft=8;spacingTop=2;fontStyle=1;fontSize=12;${FONT}`;
const caption = `text;html=1;strokeColor=none;fillColor=none;align=left;fontSize=14;fontStyle=1;${FONT}fontColor=${STROKE};`;
const actorBox = `rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=${STROKE};fontSize=12;align=center;${FONT}`;
const guard = `text;html=1;strokeColor=none;fillColor=#ffffff;align=left;fontSize=12;fontStyle=1;${FONT}fontColor=${STROKE};`;

function classValue(name, attrs, ops) {
  const a = attrs.join("<br>");
  const o = ops.join("<br>");
  return `<div style="text-align:center"><b>${name}</b></div><hr/>${a}<hr/>${o}`;
}

function classHeight(attrs, ops) {
  return 36 + attrs.length * 16 + Math.max(ops.length, 1) * 16 + 14;
}

function textBox(lines, size) {
  const n = Math.max(...lines.map((s) => s.length), 1);
  return Math.ceil(n * size * 0.64 + 44);
}

function useCase(cells) {
  // One boundary, goal ovals, sticks outside. A second stick is drawn only
  // when that actor also reaches a row owned by someone else.
  const OW = 176;
  const OH = 50;
  const ROW = 88;
  const y0 = 64;
  const Y = (r) => y0 + r * ROW;
  const C = [240, 530];
  const goals = [
    ["uc01", "Register member<br>account", 0, 0],
    ["uc02", "Verify email<br>OTP code", 1, 0],
    ["uc03", "Log in and<br>reset password", 0, 1],
    ["uc05", "Browse the<br>court schedule", 0, 2],
    ["uc10", "View the<br>court matrix", 0, 3],
    ["uc20", "Run a till<br>shift", 0, 4],
    ["uc22", "Sell at the<br>front desk", 0, 5],
    ["uc23", "Rent gear<br>and walk-ins", 0, 6],
    ["uc24", "Reconcile<br>bank transfers", 0, 7],
    ["uc21", "Check in<br>at the gate", 0, 8],
    ["uc04", "Display the QR<br>member pass", 1, 8],
    ["uc15", "View the assigned<br>coach schedule", 0, 9],
    ["uc16", "Record session<br>attendance", 0, 10],
    ["uc17", "Lock the<br>attendance book", 1, 10],
    ["uc18", "Assess a<br>trainee", 0, 11],
    ["uc09", "Reschedule<br>the booking", 0, 12],
    ["uc06", "Book a court and<br>hold the slot", 1, 12],
    ["uc13", "Pay online<br>by VietQR", 1, 13],
    ["uc11", "Buy or renew<br>a membership", 1, 14],
    ["uc08", "Refund the<br>court booking", 0, 15],
    ["uc07", "Cancel a court<br>booking", 1, 15],
    ["uc12", "Freeze or resume<br>a membership", 1, 16],
    ["uc14", "Enroll in a<br>training class", 1, 17],
    ["uc30", "Ask the<br>AI assistant", 1, 18],
    ["uc19", "Manage class<br>sessions", 1, 19],
    ["uc25", "Set prices<br>and vouchers", 1, 20],
    ["uc26", "Manage staff<br>accounts", 1, 21],
    ["uc27", "View revenue<br>and utilization", 1, 22],
    ["uc28", "Export<br>a report", 0, 22],
    ["uc29", "Read the<br>audit log", 1, 23],
    ["uc31", "Run scheduled<br>jobs", 1, 24],
  ];
  for (const [id, text, col, row] of goals) box(cells, id, text, oval, C[col], Y(row), OW, OH);
  const at = (id) => cells.find((c) => c.id === id);
  const left = C[0] - 40;
  const right = C[1] + OW + 36;
  const top = Y(0) - 28;
  const bot = Y(24) + OH + 20;
  box(cells, "sys", "Arena3 Sports Complex", boundary, left, top, right - left, bot - top);

  const stick = (id, name, r0, r1, side) => {
    const y = (Y(r0) + Y(r1)) / 2 + OH / 2 - 40;
    box(cells, id, name, actorStyle, side === "left" ? 24 : 820, y, 40, 80);
  };
  stick("a_guest", "Guest", 0, 2, "left");
  stick("a_rec", "Receptionist", 3, 8, "left");
  stick("a_coach", "Coach", 9, 11, "left");
  stick("a_member_in", "Member", 1, 2, "right");
  stick("a_member_pass", "Member", 8, 8, "right");
  stick("a_member", "Member", 12, 18, "right");
  stick("a_mgr_till", "Manager", 4, 4, "right");
  stick("a_mgr", "Manager", 19, 24, "right");

  const fan = (actor, ids) => {
    const a = at(actor);
    const side = a.x < left ? "left" : "right";
    const items = ids.map(at).sort((p, q) => p.y - q.y);
    items.forEach((o, i) => {
      link(cells, `c_${actor}_${o.id}`, "", comm, actor, o.id, undefined, {
        sx: side === "left" ? 1 : 0,
        sy: (i + 1) / (items.length + 1),
        tx: side === "left" ? 0 : 1,
        ty: 0.5,
      });
    });
  };
  fan("a_guest", ["uc01", "uc03", "uc05"]);
  fan("a_rec", ["uc10", "uc20", "uc22", "uc23", "uc24", "uc21"]);
  fan("a_coach", ["uc15", "uc16", "uc18"]);
  fan("a_member_in", ["uc03", "uc05"]);
  fan("a_member_pass", ["uc04"]);
  fan("a_member", ["uc06", "uc11", "uc07", "uc12", "uc14", "uc30"]);
  fan("a_mgr_till", ["uc20"]);
  fan("a_mgr", ["uc19", "uc25", "uc26", "uc27", "uc29", "uc31"]);

  const reuse = (id, from, to, word, ports) => {
    link(cells, id, word, include, from, to, undefined, ports);
  };
  const beside = { sx: 1, sy: 0.5, tx: 0, ty: 0.5 };
  const back = { sx: 0, sy: 0.5, tx: 1, ty: 0.5 };
  reuse("inc_otp", "uc01", "uc02", "«include»", beside);
  reuse("inc_gate", "uc21", "uc04", "«include»", beside);
  reuse("inc_att", "uc16", "uc17", "«include»", beside);
  reuse("ext_move", "uc09", "uc06", "«extend»", beside);
  reuse("ext_refund", "uc08", "uc07", "«extend»", beside);
  reuse("inc_rep", "uc27", "uc28", "«include»", back);
  reuse("inc_book", "uc06", "uc13", "«include»", { sx: 0.5, sy: 1, tx: 0.5, ty: 0 });
  reuse("inc_plan", "uc11", "uc13", "«include»", { sx: 0.5, sy: 0, tx: 0.5, ty: 1 });
  return model(940, bot + 28, cells);
}

function context(cells) {
  // Use case overview (Learning UML 2.0, ch. 2): the system and its actors.
  // No goal ovals. External systems wear «actor».
  box(cells, "title", "Use case overview — Arena3 sports complex", caption, 24, 12, 420, 22);
  const sys = { x: 340, y: 250, w: 560, h: 200 };
  box(cells, "sys", "Arena3 Sports Complex", boundary, sys.x, sys.y, sys.w, sys.h);
  const people = [
    ["a_guest", "Guest", 420, 36],
    ["a_pay", "payOS", 640, 36],
    ["a_member", "Member", 36, 300],
    ["a_mail", "Mail delivery", 1020, 340],
    ["a_desk", "Receptionist", 400, 540],
    ["a_coach", "Coach", 580, 540],
    ["a_mgr", "Manager", 820, 540],
  ];
  for (const [id, name, x, y] of people) box(cells, id, name, actorStyle, x, y, 40, 80);
  const note = `text;html=1;strokeColor=none;fillColor=none;align=center;fontSize=12;${FONT}fontColor=${STROKE};`;
  box(cells, "pay_kind", "«actor»", note, 600, 14, 120, 18);
  box(cells, "mail_kind", "«actor»", note, 980, 318, 120, 18);
  const at = (id) => cells.find((c) => c.id === id);
  const join = (id, actor, label) => {
    const a = at(actor);
    const ax = a.x + a.w / 2;
    const ay = a.y + a.h / 2;
    const above = ay < sys.y;
    const below = ay > sys.y + sys.h;
    const sx = above || below ? 0.5 : ax < sys.x ? 1 : 0;
    const sy = above ? 1 : below ? 0 : 0.5;
    const tx = above || below ? (ax - sys.x) / sys.w : ax < sys.x ? 0 : 1;
    const ty = above ? 0 : below ? 1 : (ay - sys.y) / sys.h;
    link(cells, id, label, comm, actor, "sys", undefined, { sx, sy, tx, ty });
  };
  join("l_guest", "a_guest", "Sign up");
  join("l_pay", "a_pay", "Take payment");
  join("l_member", "a_member", "Book a court");
  join("l_mail", "a_mail", "Send the OTP");
  join("l_desk", "a_desk", "Open the gate");
  join("l_coach", "a_coach", "Mark attendance");
  join("l_mgr", "a_mgr", "Set prices");
  return model(1160, 700, cells);
}

function activity(cells) {
  box(cells, "title", "Activity — register and confirm the email code", caption, 24, 8, 620, 22);
  const lanes = [
    ["lane_g", "Guest", 180],
    ["lane_w", "Web client", 450],
    ["lane_a", "Arena3 API", 720],
    ["lane_m", "Mail delivery", 990],
    ["lane_d", "Database", 1260],
  ];
  for (const [id, name, x] of lanes) box(cells, id, name, lane, x, 44, 270, 1140);
  const X = [200, 470, 740, 1010, 1280];
  const W = 210;
  const act = (id, text, lane, y, kind = action) => box(cells, id, text, kind, X[lane], y, W, 46);
  const dia = (id, lane, y) => box(cells, id, "", diamond, X[lane] + (W - 40) / 2, y, 40, 40);
  const dot = (id, lane, y, kind) => box(cells, id, "", kind, X[lane] + (W - 18) / 2, y, 18, 18);

  dot("init", 0, 72, initial);
  dia("merge_f", 0, 112);
  act("fill", "Fill in the form", 0, 176);
  act("check", "Check the form", 1, 176);
  dia("dec_f", 1, 260);
  act("take", "Check the phone", 2, 257);
  act("look", "Look up the phone", 4, 257);
  dia("dec_p", 0, 370);
  dot("end_dup", 0, 470, final);
  act("create", "Create the one-time code", 2, 430);
  act("save", "Store the pending account", 4, 430);
  act("send", "Send the one-time code", 2, 530, signal);
  act("deliver", "Deliver the one-time code", 3, 640);
  dia("merge_c", 0, 760);
  act("type", "Type the one-time code", 0, 830);
  dia("dec_c", 0, 910);
  act("store", "Store the member", 4, 907);
  act("issue", "Issue the session", 2, 1020);
  act("home", "Open the home page", 1, 1020);
  dot("end_ok", 1, 1110, final);
  dot("end_lock", 0, 1110, final);

  const at = (id) => cells.find((c) => c.id === id);
  const cx = (id) => at(id).x + at(id).w / 2;
  const cy = (id) => at(id).y + at(id).h / 2;
  const down = (id, a, b) => link(cells, id, "", flow, a, b, undefined, { sx: 0.5, sy: 1, tx: 0.5, ty: 0 });
  down("f1", "init", "merge_f");
  down("f2", "merge_f", "fill");
  link(cells, "f3", "", flow, "fill", "check", undefined, { sx: 1, sy: 0.5, tx: 0, ty: 0.5 });
  down("f4", "check", "dec_f");
  link(cells, "f5", "[Invalid]", flow, "dec_f", "merge_f", [
    { x: 16, y: cy("dec_f") },
    { x: 16, y: cy("merge_f") },
  ], { sx: 0, sy: 0.5, tx: 0, ty: 0.5 });
  link(cells, "f6", "[Valid]", flow, "dec_f", "take", undefined, { sx: 1, sy: 0.5, tx: 0, ty: 0.5 });
  link(cells, "f7", "", flow, "take", "look", undefined, { sx: 1, sy: 0.5, tx: 0, ty: 0.5 });
  link(cells, "f8", "", flow, "look", "dec_p", [
    { x: cx("look"), y: 350 },
    { x: cx("dec_p"), y: 350 },
  ], { sx: 0.5, sy: 1, tx: 0.5, ty: 0 });
  link(cells, "f9", "[Duplicate]", flow, "dec_p", "end_dup", undefined, { sx: 0.5, sy: 1, tx: 0.5, ty: 0 });
  link(cells, "f10", "[Unique]", flow, "dec_p", "create", [
    { x: 430, y: cy("dec_p") },
    { x: 430, y: cy("create") },
  ], { sx: 1, sy: 0.5, tx: 0, ty: 0.5 });
  link(cells, "f22", "", flow, "create", "save", undefined, { sx: 1, sy: 0.5, tx: 0, ty: 0.5 });
  link(cells, "f11", "", flow, "save", "send", [
    { x: cx("save"), y: cy("send") },
  ], { sx: 0.5, sy: 1, tx: 1, ty: 0.5 });
  link(cells, "f12", "", flow, "send", "deliver", [
    { x: cx("send"), y: cy("deliver") },
  ], { sx: 0.5, sy: 1, tx: 0, ty: 0.5 });
  link(cells, "f13", "", flow, "deliver", "merge_c", [
    { x: cx("deliver"), y: 730 },
    { x: cx("merge_c"), y: 730 },
  ], { sx: 0.5, sy: 1, tx: 0.5, ty: 0 });
  down("f14", "merge_c", "type");
  down("f15", "type", "dec_c");
  link(cells, "f16", "[Verified]", flow, "dec_c", "store", undefined, { sx: 1, sy: 0.5, tx: 0, ty: 0.5 });
  link(cells, "f17", "[Mismatch / Expired]", flow, "dec_c", "merge_c", [
    { x: 16, y: cy("dec_c") },
    { x: 16, y: cy("merge_c") },
  ], { sx: 0, sy: 0.5, tx: 0, ty: 0.5 });
  link(cells, "f18", "[no attempts left]", flow, "dec_c", "end_lock", [
    { x: cx("dec_c"), y: 980 },
    { x: 48, y: 980 },
    { x: 48, y: 1096 },
    { x: cx("end_lock"), y: 1096 },
  ], { sx: 0.5, sy: 1, tx: 0.5, ty: 0 });
  link(cells, "f19", "", flow, "store", "issue", [
    { x: cx("store"), y: cy("issue") },
  ], { sx: 0.5, sy: 1, tx: 1, ty: 0.5 });
  link(cells, "f20", "", flow, "issue", "home", undefined, { sx: 0, sy: 0.5, tx: 1, ty: 0.5 });
  down("f21", "home", "end_ok");
  return model(1560, 1220, cells);
}

function classes(cells) {
  const specs = [
    ["user", "User", ["- memberCode : String", "- fullName : String", "- phone : String", "- role : UserRole", "- status : AccountStatus"], ["+ register(phone : String, name : String) : void", "+ signIn(phone : String, password : String) : void"]],
    ["plan", "MembershipPlan", ["- name : String", "- sportScope : SportKind", "- durationDays : Integer", "- priceVnd : Integer", "- onSale : Boolean"], []],
    ["court", "Court", ["- courtCode : String", "- sport : SportKind", "- status : CourtStatus"], ["+ holds(start : DateTime, end : DateTime) : Boolean"]],
    ["sub", "Subscription", ["- startOn : Date", "- endOn : Date", "- status : SubStatus", "- courtHoursLeft : Decimal", "- sessionLeft : Integer"], ["+ activate() : void"]],
    ["book", "CourtBooking", ["- code : String", "- member : User [0..1]", "- startAt : DateTime", "- endAt : DateTime", "- status : BookingStatus", "- priceVnd : Integer"], ["+ confirm() : void", "+ cancel() : Integer"]],
    ["promo", "Promotion", ["- code : String", "- kind : PromoKind", "- value : Integer", "- maxUses : Integer"], ["+ discountFor(orderVnd : Integer) : Integer"]],
    ["pay", "Payment", ["- code : String", "- method : PayMethod", "- amountVnd : Integer", "- status : PayStatus", "- shift : CashierShift [0..1]"], ["+ post(amountVnd : Integer, method : PayMethod) : void", "+ refund(reason : String) : void"]],
  ];
  const rect = {};
  for (const [id, name, attrs, ops] of specs) {
    rect[id] = { name, attrs, ops, w: textBox([...attrs, ...ops], 11), h: classHeight(attrs, ops) };
  }
  const gapX = 48;
  const y0 = 44;
  rect.user.x = 24;
  rect.user.y = y0;
  rect.plan.x = rect.user.x + rect.user.w + gapX;
  rect.plan.y = y0;
  rect.court.x = rect.plan.x + rect.plan.w + gapX;
  rect.court.y = y0;
  const row2 = y0 + Math.max(rect.user.h, rect.plan.h, rect.court.h) + 72;
  rect.sub.x = rect.user.x;
  rect.sub.y = row2;
  rect.book.x = rect.court.x;
  rect.book.y = row2;
  rect.book.w = Math.max(rect.book.w, rect.court.w);
  const row3 = row2 + Math.max(rect.sub.h, rect.book.h) + 72;
  rect.promo.x = rect.user.x;
  rect.promo.y = row3;
  rect.pay.x = rect.book.x;
  rect.pay.y = row3;
  rect.pay.w = Math.max(rect.pay.w, rect.book.w);

  box(cells, "title", "Class diagram — booking and membership", caption, 24, 8, 440, 22);
  for (const [id] of specs) {
    const s = rect[id];
    box(cells, id, classValue(s.name, s.attrs, s.ops), CLASS, s.x, s.y, s.w, s.h);
  }

  const assoc = (id, a, b, label, ports, via) => {
    link(cells, id, label, line, a, b, via, ports);
  };
  assoc("e_user_sub", "user", "sub", "", { sx: 0.5, sy: 1, tx: 0.5, ty: 0 });
  mult(cells, "e_user_sub", "1", "src");
  mult(cells, "e_user_sub", "0..*", "dst");

  const planCx = rect.plan.x + rect.plan.w * 0.5;
  assoc("e_plan_sub", "plan", "sub", "", { sx: 0.5, sy: 1, tx: 0.82, ty: 0 }, [
    { x: planCx, y: rect.sub.y - 28 },
  ]);
  mult(cells, "e_plan_sub", "1", "src");
  mult(cells, "e_plan_sub", "0..*", "dst");

  assoc("e_court_book", "court", "book", "", { sx: 0.5, sy: 1, tx: 0.5, ty: 0 });
  mult(cells, "e_court_book", "1", "src");
  mult(cells, "e_court_book", "0..*", "dst");

  assoc("e_book_pay", "book", "pay", "settles", { sx: 0.42, sy: 1, tx: 0.42, ty: 0 });
  mult(cells, "e_book_pay", "0..1", "src");
  mult(cells, "e_book_pay", "0..*", "dst");

  const band = Math.max(rect.promo.y + 36, rect.pay.y + 36);
  const promoSy = (band - rect.promo.y) / rect.promo.h;
  const payTy = (band - rect.pay.y) / rect.pay.h;
  assoc("e_promo_pay", "promo", "pay", "", { sx: 1, sy: promoSy, tx: 0, ty: payTy });
  mult(cells, "e_promo_pay", "0..1", "src");
  mult(cells, "e_promo_pay", "0..*", "dst");

  const bottom = Math.max(...Object.values(rect).map((s) => s.y + s.h));
  const right = Math.max(...Object.values(rect).map((s) => s.x + s.w));
  return model(right + 28, bottom + 28, cells);
}

function sequence(cells) {
  const life = `endArrow=none;dashed=1;html=1;strokeColor=#64748b;exitX=0.5;exitY=1;entryX=0.5;entryY=0;`;
  box(cells, "title", "Sequence — Book a court", caption, 24, 6, 300, 22);
  const heads = [
    ["h_member", "member : Member", 24, 36, 150, 36],
    ["h_page", "page : BookingPage", 230, 36, 170, 36],
    ["h_api", "api : BookingService", 460, 36, 180, 36],
    ["h_payos", "payos : PayOS", 900, 36, 150, 36],
  ];
  for (const [id, label, x, y, w, h] of heads) box(cells, id, label, head, x, y, w, h);
  box(cells, "h_book", "booking : CourtBooking", head, 680, 160, 180, 36);

  for (const [id, x] of [["d_member", 99], ["d_page", 315], ["d_api", 550], ["d_book", 770], ["d_payos", 975]]) {
    box(cells, id, "", "opacity=0;html=1;", x, 740, 2, 2);
  }
  link(cells, "l_member", "", life, "h_member", "d_member");
  link(cells, "l_page", "", life, "h_page", "d_page");
  link(cells, "l_api", "", life, "h_api", "d_api");
  link(cells, "l_book", "", life, "h_book", "d_book");
  link(cells, "l_payos", "", life, "h_payos", "d_payos");

  const act = (id, x, y, h) => box(cells, id, "", bar, x, y, 14, h);
  act("b_member1", 92, 88, 200);
  act("b_page1", 308, 88, 200);
  act("b_api1", 543, 130, 120);
  act("b_member2", 92, 340, 330);
  act("b_page2", 308, 340, 330);
  act("b_api2", 543, 390, 270);
  act("b_payos", 968, 456, 64);
  act("b_book", 763, 600, 40);

  function msg(id, label, kind, from, to, y, points) {
    const style = kind === "sync" ? sync : ret;
    const right = from.cx <= to.cx;
    const exitX = from.id === to.id ? 1 : right ? 1 : 0;
    const entryX = from.id === to.id ? 1 : right ? 0 : 1;
    const exitY = ((y - from.y) / from.h).toFixed(3);
    const entryY = ((y + (from.id === to.id ? 16 : 0) - to.y) / to.h).toFixed(3);
    link(cells, id, label, `${style}exitX=${exitX};exitY=${exitY};entryX=${entryX};entryY=${entryY};`, from.id, to.id, points);
  }
  const M1 = { id: "b_member1", cx: 99, y: 88, h: 200 };
  const P1 = { id: "b_page1", cx: 315, y: 88, h: 200 };
  const A1 = { id: "b_api1", cx: 550, y: 130, h: 120 };
  const M2 = { id: "b_member2", cx: 99, y: 340, h: 330 };
  const P2 = { id: "b_page2", cx: 315, y: 340, h: 330 };
  const A2 = { id: "b_api2", cx: 550, y: 390, h: 270 };
  const OS = { id: "b_payos", cx: 975, y: 456, h: 64 };
  const BK = { id: "b_book", cx: 770, y: 600, h: 40 };
  const HEAD = { id: "h_book", cx: 770, y: 160, h: 36 };

  msg("m1", "selectSlot(court, start)", "sync", M1, P1, 112);
  msg("m2", "hold(court, start, end)", "sync", P1, A1, 156);
  msg("m3", "«create»", "return", A1, HEAD, 178);
  msg("m4", "held", "return", A1, P1, 228);
  msg("m5", "total", "return", P1, M1, 268);
  msg("m6", "pay(method, code)", "sync", M2, P2, 364);
  msg("m7", "pay(code, method)", "sync", P2, A2, 412);

  box(cells, "alt", "alt", frame, 500, 444, 570, 156);
  box(cells, "g_online", "[method = payOS]", guard, 620, 450, 150, 18);
  box(cells, "g_else", "[otherwise]", guard, 620, 552, 110, 16);
  box(cells, "alt_div", "", `rounded=0;fillColor=${STROKE};strokeColor=none;html=1;`, 500, 544, 570, 1);

  msg("m8", "createLink(amount)", "sync", A2, OS, 492);
  msg("m9", "url", "return", OS, A2, 524);
  msg("m10", "postCash", "sync", A2, A2, 578, [
    { x: 660, y: 578 },
    { x: 660, y: 594 },
  ]);
  msg("m11", "confirm()", "sync", A2, BK, 620);
  msg("m12", "receipt", "return", P2, M2, 656);
  return model(1100, 780, cells);
}

function erdLogical(cells) {
  box(cells, "title", "Logical ERD — Arena3 sports complex", caption, 24, 8, 460, 22);
  const ent = (id, name, x, y) => box(cells, id, name, actorBox, x, y, 140, 40);
  const rel = (id, name, x, y) => box(cells, id, name, diamond, x, y, 78, 44);
  ent("user", "User", 40, 48);
  rel("r_holds", "holds", 240, 46);
  ent("sub", "Subscription", 380, 48);
  rel("r_of", "of", 580, 46);
  ent("plan", "Plan", 720, 48);
  rel("r_books", "books", 71, 140);
  ent("book", "CourtBooking", 40, 230);
  rel("r_on", "on", 250, 228);
  ent("court", "Court", 390, 230);
  rel("r_pays", "settles", 71, 320);
  ent("pay", "Payment", 40, 410);
  ent("klass", "Class", 390, 410);
  rel("r_runs", "runs", 590, 408);
  ent("sess", "Session", 730, 410);
  rel("r_lists", "lists", 421, 500);
  ent("enr", "Enrollment", 390, 590);
  const bare = `endArrow=none;html=1;strokeColor=${STROKE};${FONT}`;
  const join = (id, a, b) => link(cells, id, "", bare, a, b, undefined, { sx: 0.5, sy: 0.5, tx: 0.5, ty: 0.5 });
  join("l1", "user", "r_holds");
  join("l2", "r_holds", "sub");
  join("l3", "sub", "r_of");
  join("l4", "r_of", "plan");
  join("l5", "user", "r_books");
  join("l6", "r_books", "book");
  join("l7", "book", "r_on");
  join("l8", "r_on", "court");
  join("l9", "book", "r_pays");
  join("l10", "r_pays", "pay");
  join("l13", "klass", "r_runs");
  join("l14", "r_runs", "sess");
  join("l15", "klass", "r_lists");
  join("l16", "r_lists", "enr");
  const card = (id, text, x, y) => box(cells, id, text, guard, x, y, 36, 16);
  card("c1", "1", 196, 30);
  card("c2", "N", 348, 30);
  card("c3", "N", 540, 30);
  card("c4", "1", 688, 30);
  card("c5", "1", 124, 106);
  card("c6", "N", 124, 198);
  card("c7", "N", 210, 210);
  card("c8", "1", 360, 210);
  card("c9", "1", 124, 286);
  card("c10", "N", 124, 378);
  card("c13", "1", 548, 392);
  card("c14", "N", 700, 392);
  card("c15", "1", 400, 478);
  card("c16", "N", 400, 568);
  return model(920, 660, cells);
}

function erdPhysical(cells) {
  box(cells, "title", "Physical ERD — Arena3 sports complex", caption, 24, 8, 480, 22);
  const head = `rounded=0;whiteSpace=wrap;html=1;fillColor=#e2e8f0;strokeColor=${STROKE};fontStyle=1;align=center;fontSize=12;${FONT}`;
  const body = `rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=${STROKE};align=left;verticalAlign=top;spacingLeft=8;spacingTop=4;fontSize=12;${FONT}`;
  const table = (id, name, cols, x, y) => {
    box(cells, `${id}_h`, name, head, x, y, 200, 24);
    box(cells, id, cols.join("<br>"), body, x, y + 24, 200, 8 + cols.length * 16);
  };
  table("user", "User", ["PK id", "phone", "role", "status"], 36, 48);
  table("sub", "Subscription", ["PK id", "FK user_id", "FK plan_id", "status"], 360, 48);
  table("plan", "MembershipPlan", ["PK id", "name", "price_vnd"], 684, 48);
  table("book", "CourtBooking", ["PK id", "FK court_id", "FK user_id", "status"], 36, 230);
  table("court", "Court", ["PK id", "court_code", "sport"], 360, 230);
  table("pay", "Payment", ["PK id", "FK user_id", "amount_vnd", "status"], 684, 230);
  table("klass", "Class", ["PK id", "FK coach_id", "FK court_id"], 36, 400);
  table("sess", "Session", ["PK id", "FK class_id", "start_at"], 360, 400);
  table("enr", "Enrollment", ["PK id", "FK class_id", "FK user_id"], 684, 400);
  const bare = `endArrow=none;html=1;strokeColor=${STROKE};${FONT}`;
  const at = (id) => cells.find((c) => c.id === id);
  const sy = (id) => (28 / at(id).h).toFixed(3);
  const join = (id, a, b) => link(cells, id, "", bare, a, b, undefined, { sx: 1, sy: sy(a), tx: 0, ty: sy(b) });
  join("p1", "user", "sub");
  join("p2", "sub", "plan");
  join("p3", "book", "court");
  join("p5", "klass", "sess");
  join("p6", "sess", "enr");
  link(cells, "p7", "", bare, "user", "book_h", undefined, { sx: 0.5, sy: 1, tx: 0.5, ty: 0 });
  return model(940, 540, cells);
}

const out = {
  "docs/diagrams/use-case-diagram.drawio": useCase([]),
  "docs/diagrams/context-diagram.drawio": context([]),
  "docs/diagrams/activity-diagram.drawio": activity([]),
  "docs/diagrams/class-diagram.drawio": classes([]),
  "docs/diagrams/sequence-diagram.drawio": sequence([]),
  "docs/diagrams/erd-logical.drawio": erdLogical([]),
  "docs/diagrams/erd-physical.drawio": erdPhysical([]),
};
for (const [path, xml] of Object.entries(out)) {
  writeFileSync(path, xml);
  console.log("wrote", path);
}
