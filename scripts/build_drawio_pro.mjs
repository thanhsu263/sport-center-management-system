import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import pako from "pako";

const DRAWIO_DIR = resolve("docs/drawio");
if (!existsSync(DRAWIO_DIR)) mkdirSync(DRAWIO_DIR, { recursive: true });

function escapeXml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\n/g, "&#xa;");
}

function compressData(data) {
  const encoded = encodeURIComponent(data);
  const compressed = pako.deflateRaw(encoded);
  return Buffer.from(compressed).toString("base64");
}

function generateDrawioUrl(xmlContent) {
  const compressed = compressData(xmlContent);
  const createObj = {
    type: "xml",
    compressed: true,
    data: compressed,
  };
  return "https://app.diagrams.net/?grid=1&pv=0#create=" + encodeURIComponent(JSON.stringify(createObj));
}

function wrapDiagram(pid, name, width, height, cellsXml) {
  return (
    `<diagram id="${pid}" name="${escapeXml(name)}">` +
    `<mxGraphModel dx="${width}" dy="${height}" grid="1" gridSize="10" guides="1" ` +
    `tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" ` +
    `pageWidth="${width}" pageHeight="${height}" math="0" shadow="0">` +
    `<root><mxCell id="0"/><mxCell id="1" parent="0"/>\n` +
    `${cellsXml}\n` +
    `</root></mxGraphModel></diagram>`
  );
}

function wrapMxFile(diagrams) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<mxfile host="app.diagrams.net">\n' +
    diagrams.join("\n") +
    "\n</mxfile>\n"
  );
}

function cell(cid, val, style, x, y, w, h, parent = "1") {
  return (
    `<mxCell id="${cid}" value="${escapeXml(val)}" style="${style}" vertex="1" parent="${parent}">` +
    `<mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/>` +
    `</mxCell>`
  );
}

function edge(eid, val, style, src, tgt, pts = null, parent = "1") {
  let ptsXml = "";
  if (pts && pts.length > 0) {
    ptsXml = `<Array as="points">` + pts.map(([px, py]) => `<mxPoint x="${px}" y="${py}"/>`).join("") + `</Array>`;
  }
  return (
    `<mxCell id="${eid}" value="${escapeXml(val)}" style="${style}" edge="1" parent="${parent}" source="${src}" target="${tgt}">` +
    `<mxGeometry relative="1" as="geometry">${ptsXml}</mxGeometry>` +
    `</mxCell>`
  );
}

// -------------------------------------------------------------------
// 1. USE CASE DIAGRAM (UML 2.0 - 100% Academic English)
// -------------------------------------------------------------------
function buildUseCaseDiagram() {
  const W = 1680, H = 1200;
  const cells = [];

  // Title Banner
  cells.push(cell(
    "title",
    "ARENA3 SPORTS COMPLEX MANAGEMENT PLATFORM — SYSTEM USE CASE DIAGRAM (UML 2.0)\n" +
    "FPT University Capstone / SWR302 Standard · 9 Actors (5 Primary Human Actors, 4 Supporting Systems) · 6 Subsystem Packages · <<include>> & <<extend>>",
    "text;html=1;align=center;verticalAlign=middle;fontSize=14;fontStyle=1;fontColor=#0f172a;fillColor=#f8fafc;strokeColor=#cbd5e1;strokeWidth=1.5;rounded=1;shadow=1;",
    40, 20, 1600, 50
  ));

  // System Boundary
  cells.push(cell(
    "boundary",
    "System: Arena3 Sports Complex Management Platform",
    "shape=rect;rounded=1;arcSize=2;fillColor=#ffffff;strokeColor=#0284c7;strokeWidth=2.5;verticalAlign=top;align=left;spacingLeft=20;spacingTop=12;fontStyle=1;fontSize=13;fontColor=#0369a1;shadow=1;",
    240, 90, 1200, 1070
  ));

  // Actors Left (Primary Human Actors)
  const actStyle = "shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;fillColor=#e0f2fe;strokeColor=#0284c7;strokeWidth=2;fontStyle=1;fontSize=11;fontColor=#0f172a;";
  cells.push(cell("act_guest", "Guest\n(Unregistered)", actStyle, 60, 140, 50, 90));
  cells.push(cell("act_member", "Member\n(Customer)", actStyle, 60, 350, 50, 90));
  cells.push(cell("act_receptionist", "Receptionist\n(Front Desk)", actStyle, 60, 580, 50, 90));
  cells.push(cell("act_coach", "Coach\n(Instructor)", actStyle, 60, 790, 50, 90));
  cells.push(cell("act_manager", "Center Manager\n(Admin/Ops)", actStyle, 60, 990, 50, 90));

  // Actors Right (Secondary System Actors)
  const sysStyle = "shape=rect;rounded=1;arcSize=10;whiteSpace=wrap;html=1;fillColor=#f1f5f9;strokeColor=#475569;strokeWidth=2;fontStyle=1;fontSize=11;fontColor=#0f172a;align=center;verticalAlign=middle;shadow=1;";
  cells.push(cell("act_ai", "<<service>>\nAI Assistant\n(Smart Concierge)", sysStyle, 1490, 180, 125, 75));
  cells.push(cell("act_mail", "<<service>>\nMail Delivery Service\n(OTP & Invoices)", sysStyle, 1490, 390, 125, 75));
  cells.push(cell("act_payos", "<<gateway>>\npayOS Gateway\n(VietQR Online)", sysStyle, 1490, 610, 125, 75));
  cells.push(cell("act_scheduler", "<<system>>\nBackground Scheduler\n(Cron Automation)", sysStyle, 1490, 840, 125, 75));

  // Packages (6 Subsystems)
  const pkgStyle = "shape=rect;rounded=1;arcSize=4;fillColor=#f8fafc;strokeColor=#94a3b8;strokeWidth=1;dashed=1;verticalAlign=top;align=left;spacingLeft=12;spacingTop=6;fontStyle=1;fontSize=11;fontColor=#475569;";
  cells.push(cell("pkg_auth", "Package 1: Authentication & Identity Subsystem", pkgStyle, 270, 130, 540, 190));
  cells.push(cell("pkg_book", "Package 2: Court Booking & Scheduling Subsystem", pkgStyle, 840, 130, 560, 250));
  cells.push(cell("pkg_plan", "Package 3: Membership Plans & Subscription Subsystem", pkgStyle, 270, 350, 540, 180));
  cells.push(cell("pkg_class", "Package 4: Sports Coaching, Classes & Attendance Subsystem", pkgStyle, 840, 410, 560, 260));
  cells.push(cell("pkg_desk", "Package 5: Reception Desk, Till Shifts & Gate POS Subsystem", pkgStyle, 270, 560, 540, 260));
  cells.push(cell("pkg_admin", "Package 6: Center Management, Operations & AI Analytics", pkgStyle, 270, 850, 1130, 280));

  // Use Case Ellipses
  const ucStyle = "ellipse;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#059669;strokeWidth=1.5;fontFamily=Arial;fontSize=11;fontColor=#064e3b;fontStyle=1;align=center;shadow=1;";
  const ucExtStyle = "ellipse;whiteSpace=wrap;html=1;fillColor=#fffbeb;strokeColor=#d97706;strokeWidth=1.5;fontFamily=Arial;fontSize=10.5;fontColor=#78350f;fontStyle=0;align=center;shadow=1;";
  const ucIncStyle = "ellipse;whiteSpace=wrap;html=1;fillColor=#eff6ff;strokeColor=#2563eb;strokeWidth=1.5;fontFamily=Arial;fontSize=10.5;fontColor=#1e3a8a;fontStyle=0;align=center;shadow=1;";

  // Pkg 1: Auth & Identity
  cells.push(cell("uc_reg", "UC01: Register Member\nAccount", ucStyle, 290, 170, 150, 55));
  cells.push(cell("uc_otp", "UC02: Verify Email\nOTP Code", ucIncStyle, 470, 170, 140, 50));
  cells.push(cell("uc_login", "UC03: Login & Reset\nPassword", ucStyle, 290, 245, 150, 55));
  cells.push(cell("uc_pass", "UC04: Display Dynamic\nQR Member Pass", ucStyle, 470, 245, 145, 55));

  // Pkg 2: Court Booking
  cells.push(cell("uc_lookup_crt", "UC05: Browse Court\nSchedule & Pricing", ucStyle, 860, 160, 145, 50));
  cells.push(cell("uc_book_crt", "UC06: Book Court &\nHold Slot", ucStyle, 1035, 160, 150, 55));
  cells.push(cell("uc_cancel_crt", "UC07: Cancel Court\nBooking", ucStyle, 860, 235, 145, 50));
  cells.push(cell("uc_refund", "UC08: Process Booking\nRefund", ucExtStyle, 1035, 235, 140, 50));
  cells.push(cell("uc_resched", "UC09: Reschedule Court\nBooking", ucExtStyle, 1205, 195, 145, 50));
  cells.push(cell("uc_crtmap", "UC10: View Visual\nCourt Matrix", ucStyle, 1035, 310, 155, 50));

  // Pkg 3: Membership Plans
  cells.push(cell("uc_buy_plan", "UC11: Purchase / Renew\nMembership Plan", ucStyle, 290, 395, 165, 55));
  cells.push(cell("uc_freeze_plan", "UC12: Freeze / Resume\nMembership Plan", ucStyle, 485, 395, 165, 55));
  cells.push(cell("uc_pay_online", "UC13: Process Online\nVietQR Payment", ucIncStyle, 380, 465, 165, 50));

  // Pkg 4: Coaching & Classes
  cells.push(cell("uc_join_class", "UC14: Enroll in\nTraining Class", ucStyle, 860, 445, 145, 50));
  cells.push(cell("uc_coach_sched", "UC15: View Assigned\nCoach Schedule", ucStyle, 1035, 445, 145, 50));
  cells.push(cell("uc_att", "UC16: Record Class\nSession Attendance", ucStyle, 860, 515, 155, 55));
  cells.push(cell("uc_lock_att", "UC17: Lock Attendance\nRegister (after 2h)", ucIncStyle, 1040, 515, 145, 50));
  cells.push(cell("uc_eval", "UC18: Evaluate Trainee\nPerformance & Drills", ucStyle, 1210, 515, 150, 55));
  cells.push(cell("uc_class_life", "UC19: Manage Class\nSession Lifecycle", ucStyle, 950, 600, 165, 55));

  // Pkg 5: Reception Desk & POS
  cells.push(cell("uc_shift", "UC20: Manage Cash\nTill Shift", ucStyle, 290, 600, 170, 55));
  cells.push(cell("uc_checkin_gate", "UC21: Process Turnstile\nQR Check-in", ucStyle, 490, 600, 160, 55));
  cells.push(cell("uc_pos_desk", "UC22: Process Front Desk\nPOS Sale", ucStyle, 290, 680, 165, 55));
  cells.push(cell("uc_gear", "UC23: Rent Equipment &\nWalk-in Sale", ucStyle, 485, 680, 170, 55));
  cells.push(cell("uc_reconcile", "UC24: Reconcile Bank\nTransfers", ucStyle, 380, 755, 170, 50));

  // Pkg 6: Center Management & AI
  cells.push(cell("uc_prices", "UC25: Configure Pricing,\nSlots & Promo Vouchers", ucStyle, 300, 895, 185, 55));
  cells.push(cell("uc_staff", "UC26: Manage Staff Accounts\n& Role Permissions", ucStyle, 515, 895, 175, 55));
  cells.push(cell("uc_reports", "UC27: View Revenue, Utilization\n& Heatmap Reports", ucStyle, 720, 895, 185, 55));
  cells.push(cell("uc_export", "UC28: Export Analytical\nReports (Excel / PDF)", ucIncStyle, 935, 895, 145, 50));
  cells.push(cell("uc_audit", "UC29: Inspect System\nAudit Logs", ucStyle, 1110, 895, 145, 50));
  cells.push(cell("uc_ai_chat", "UC30: Consult Virtual\nAI Assistant", ucStyle, 600, 980, 175, 55));
  cells.push(cell("uc_cron_jobs", "UC31: Trigger Automated\nCron Sweeps", ucStyle, 850, 980, 195, 55));

  // Associations
  const assocStyle = "endArrow=none;html=1;strokeColor=#475569;strokeWidth=1.5;rounded=0;";
  cells.push(edge("e_g_reg", "", assocStyle, "act_guest", "uc_reg"));
  cells.push(edge("e_g_look", "", assocStyle, "act_guest", "uc_lookup_crt"));
  cells.push(edge("e_g_log", "", assocStyle, "act_guest", "uc_login"));

  cells.push(edge("e_m_log", "", assocStyle, "act_member", "uc_login"));
  cells.push(edge("e_m_pass", "", assocStyle, "act_member", "uc_pass"));
  cells.push(edge("e_m_book", "", assocStyle, "act_member", "uc_book_crt"));
  cells.push(edge("e_m_cancel", "", assocStyle, "act_member", "uc_cancel_crt"));
  cells.push(edge("e_m_plan", "", assocStyle, "act_member", "uc_buy_plan"));
  cells.push(edge("e_m_cls", "", assocStyle, "act_member", "uc_join_class"));
  cells.push(edge("e_m_ai", "", assocStyle, "act_member", "uc_ai_chat"));

  cells.push(edge("e_r_shift", "", assocStyle, "act_receptionist", "uc_shift"));
  cells.push(edge("e_r_gate", "", assocStyle, "act_receptionist", "uc_checkin_gate"));
  cells.push(edge("e_r_pos", "", assocStyle, "act_receptionist", "uc_pos_desk"));
  cells.push(edge("e_r_gear", "", assocStyle, "act_receptionist", "uc_gear"));
  cells.push(edge("e_r_recon", "", assocStyle, "act_receptionist", "uc_reconcile"));
  cells.push(edge("e_r_map", "", assocStyle, "act_receptionist", "uc_crtmap"));

  cells.push(edge("e_c_sched", "", assocStyle, "act_coach", "uc_coach_sched"));
  cells.push(edge("e_c_att", "", assocStyle, "act_coach", "uc_att"));
  cells.push(edge("e_c_eval", "", assocStyle, "act_coach", "uc_eval"));

  cells.push(edge("e_mgr_prices", "", assocStyle, "act_manager", "uc_prices"));
  cells.push(edge("e_mgr_staff", "", assocStyle, "act_manager", "uc_staff"));
  cells.push(edge("e_mgr_rep", "", assocStyle, "act_manager", "uc_reports"));
  cells.push(edge("e_mgr_audit", "", assocStyle, "act_manager", "uc_audit"));
  cells.push(edge("e_mgr_life", "", assocStyle, "act_manager", "uc_class_life"));
  cells.push(edge("e_mgr_shift", "", assocStyle, "act_manager", "uc_shift"));

  cells.push(edge("e_sys_mail_otp", "", assocStyle, "uc_otp", "act_mail"));
  cells.push(edge("e_sys_pay_link", "", assocStyle, "uc_pay_online", "act_payos"));
  cells.push(edge("e_sys_ai_resp", "", assocStyle, "uc_ai_chat", "act_ai"));
  cells.push(edge("e_sys_cron_work", "", assocStyle, "uc_cron_jobs", "act_scheduler"));

  // Includes & Extends
  const incStyle = "edgeStyle=orthogonalEdgeStyle;rounded=1;dashed=1;endArrow=open;endSize=10;html=1;strokeColor=#2563eb;strokeWidth=1.5;fontStyle=2;fontSize=10;fontColor=#1e40af;align=center;";
  const extStyle = "edgeStyle=orthogonalEdgeStyle;rounded=1;dashed=1;endArrow=open;endSize=10;html=1;strokeColor=#d97706;strokeWidth=1.5;fontStyle=2;fontSize=10;fontColor=#92400e;align=center;";

  cells.push(edge("inc_reg_otp", "<<include>>", incStyle, "uc_reg", "uc_otp"));
  cells.push(edge("inc_book_pay", "<<include>>", incStyle, "uc_book_crt", "uc_pay_online"));
  cells.push(edge("inc_plan_pay", "<<include>>", incStyle, "uc_buy_plan", "uc_pay_online"));
  cells.push(edge("inc_att_lock", "<<include>>", incStyle, "uc_att", "uc_lock_att"));
  cells.push(edge("inc_rep_exp", "<<include>>", incStyle, "uc_reports", "uc_export"));
  cells.push(edge("inc_gate_pass", "<<include>>", incStyle, "uc_checkin_gate", "uc_pass"));

  cells.push(edge("ext_ref_cancel", "<<extend>>", extStyle, "uc_refund", "uc_cancel_crt"));
  cells.push(edge("ext_resched_book", "<<extend>>", extStyle, "uc_resched", "uc_book_crt"));

  return wrapDiagram("page_usecase", "1. Use Case Diagram (UML 2.0)", W, H, cells.join("\n"));
}

// -------------------------------------------------------------------
// 2. CONTEXT DIAGRAM (DFD LEVEL 0 - 100% Academic English Noun Flows)
// -------------------------------------------------------------------
function buildContextDiagram() {
  const W = 1600, H = 1100;
  const cells = [];

  cells.push(cell(
    "dfd_title",
    "ARENA3 SPORTS COMPLEX MANAGEMENT SYSTEM — CONTEXT DIAGRAM (DFD LEVEL 0)\n" +
    "FPT University Examination Compliance · 7 External Entities · 100% Data Flows Strictly Expressed as Noun Phrases",
    "text;html=1;align=center;verticalAlign=middle;fontSize=14;fontStyle=1;fontColor=#0f172a;fillColor=#f8fafc;strokeColor=#cbd5e1;strokeWidth=1.5;rounded=1;shadow=1;",
    40, 20, 1520, 50
  ));

  const procStyle = "shape=rect;rounded=1;arcSize=25;whiteSpace=wrap;html=1;fillColor=#ecfdf5;strokeColor=#059669;strokeWidth=3;fontStyle=1;fontSize=13;fontColor=#064e3b;align=center;verticalAlign=middle;shadow=1;";
  cells.push(cell(
    "proc_0",
    "0\n\nARENA3 SPORTS COMPLEX\nMANAGEMENT SYSTEM\n\n(Central Operational Hub)",
    procStyle,
    610, 390, 380, 260
  ));

  const entStyle = "shape=rect;whiteSpace=wrap;html=1;fillColor=#f8fafc;strokeColor=#1e293b;strokeWidth=2;fontStyle=1;fontSize=12;fontColor=#0f172a;align=center;verticalAlign=middle;shadow=1;";
  cells.push(cell("ent_guest", "GUEST\n(Unregistered Visitor)", entStyle, 80, 130, 230, 90));
  cells.push(cell("ent_member", "MEMBER\n(Registered Customer)", entStyle, 80, 460, 230, 100));
  cells.push(cell("ent_receptionist", "RECEPTIONIST / CASHIER\n(Front Desk Personnel)", entStyle, 80, 800, 230, 100));
  cells.push(cell("ent_coach", "SPORTS COACH\n(Instructor & Trainer)", entStyle, 1280, 130, 230, 100));
  cells.push(cell("ent_manager", "CENTER MANAGER\n(Administrative Executive)", entStyle, 1280, 460, 230, 110));
  cells.push(cell("ent_payos", "payOS PAYMENT GATEWAY\n(VietQR Banking Infrastructure)", entStyle, 1280, 800, 230, 95));
  cells.push(cell("ent_mail", "MAIL DELIVERY SERVICE\n(SMTP & Notification Transport)", entStyle, 680, 930, 240, 80));

  const flowStyle = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#0f766e;strokeWidth=1.5;fontSize=10;fontColor=#0f172a;labelBackgroundColor=#ffffff;align=center;";
  const flowBackStyle = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#0369a1;strokeWidth=1.5;fontSize=10;fontColor=#0f172a;labelBackgroundColor=#ffffff;align=center;";

  cells.push(edge("f_g_in", "Account Registration Data & Schedule Inquiries", flowStyle, "ent_guest", "proc_0", [[420, 175], [420, 440]]));
  cells.push(edge("f_g_out", "Public Schedules, Tariff Catalog & Verification Prompts", flowBackStyle, "proc_0", "ent_guest", [[460, 460], [460, 205]]));

  cells.push(edge("f_m_in", "Court Booking Requests, Plan Orders & AI Prompts", flowStyle, "ent_member", "proc_0", [[420, 495], [420, 510]]));
  cells.push(edge("f_m_out", "Dynamic QR Member Passes, Booking Receipts & AI Guidance", flowBackStyle, "proc_0", "ent_member", [[440, 540], [440, 545]]));

  cells.push(edge("f_r_in", "Till Shift Logs, Check-in Verification Scans & POS Desk Orders", flowStyle, "ent_receptionist", "proc_0", [[420, 840], [420, 590]]));
  cells.push(edge("f_r_out", "Shift Balance Summary, Gate Entry Authorizations & Sales Invoices", flowBackStyle, "proc_0", "ent_receptionist", [[460, 620], [460, 870]]));

  cells.push(edge("f_c_in", "Session Attendance Registers & Trainee Performance Assessments", flowStyle, "ent_coach", "proc_0", [[1180, 180], [1180, 440]]));
  cells.push(edge("f_c_out", "Assigned Teaching Timetables, Trainee Rosters & Compensation Reports", flowBackStyle, "proc_0", "ent_coach", [[1140, 460], [1140, 205]]));

  cells.push(edge("f_mgr_in", "Pricing Rate Rules, Staff Permissions & Refund Authorizations", flowStyle, "ent_manager", "proc_0", [[1180, 495], [1180, 510]]));
  cells.push(edge("f_mgr_out", "Revenue Heatmaps, Court Utilization Metrics & Audit Trail Logs", flowBackStyle, "proc_0", "ent_manager", [[1140, 540], [1140, 545]]));

  cells.push(edge("f_p_in", "Payment Initialization Requests & Transaction Metadata", flowStyle, "proc_0", "ent_payos", [[1140, 600], [1140, 830]]));
  cells.push(edge("f_p_out", "Signed Webhook Payloads & Transaction Settlement Status", flowBackStyle, "ent_payos", "proc_0", [[1180, 865], [1180, 625]]));

  cells.push(edge("f_mail_out", "Email Notification Dispatch Requests (OTP Codes, E-Invoices, Alerts)", flowStyle, "proc_0", "ent_mail", [[760, 650], [760, 930]]));
  cells.push(edge("f_mail_in", "Delivery Confirmation Receipts & Transmission Status Reports", flowBackStyle, "ent_mail", "proc_0", [[840, 930], [840, 650]]));

  return wrapDiagram("page_context", "2. Context Diagram DFD Level 0 (Noun Flows)", W, H, cells.join("\n"));
}

// -------------------------------------------------------------------
// 3. SWIMLANE ACTIVITY DIAGRAM (UML 2.0 - 100% Academic English)
// -------------------------------------------------------------------
function buildSwimlaneDiagram() {
  const W = 1680, H = 1300;
  const cells = [];

  cells.push(cell(
    "act_title",
    "MEMBER REGISTRATION & EMAIL OTP VERIFICATION PROCESS — SWIMLANE ACTIVITY DIAGRAM (UML 2.0)\n" +
    "FPT University Capstone / SWR302 Standard · 5 Partitions: Guest | Web Client | API Server | Mail Delivery | PostgreSQL DB",
    "text;html=1;align=center;verticalAlign=middle;fontSize=14;fontStyle=1;fontColor=#0f172a;fillColor=#f8fafc;strokeColor=#cbd5e1;strokeWidth=1.5;rounded=1;shadow=1;",
    40, 20, 1600, 50
  ));

  cells.push(cell(
    "pool_main",
    "Arena3 Member Onboarding & Verification Lifecycle",
    "swimlane;html=1;childLayout=stackLayout;resizeParent=1;resizeParentMax=0;startSize=30;horizontal=0;horizontalFlip=0;fillColor=#f1f5f9;strokeColor=#475569;strokeWidth=2;fontStyle=1;fontSize=13;fontColor=#1e293b;",
    40, 90, 1600, 1180
  ));

  const lanes = [
    ["lane_guest", "Guest (User)", "#f8fafc", 300],
    ["lane_fe", "Web Client (Frontend)", "#f0fdf4", 320],
    ["lane_be", "Arena3 API Server (Backend)", "#eff6ff", 350],
    ["lane_mail", "Mail Delivery Service", "#faf5ff", 290],
    ["lane_db", "Relational Database (PostgreSQL)", "#fffbeb", 310],
  ];

  let laneX = 30;
  for (const [lid, lname, lcol, lw] of lanes) {
    cells.push(cell(
      lid, lname,
      `swimlane;html=1;startSize=30;horizontal=1;fillColor=${lcol};strokeColor=#94a3b8;strokeWidth=1.5;fontStyle=1;fontSize=12;fontColor=#0f172a;align=center;`,
      laneX, 0, lw, 1180, "pool_main"
    ));
    laneX += lw;
  }

  const stStart = "ellipse;fillColor=#000000;strokeColor=#000000;html=1;";
  const stEnd = "ellipse;shape=endState;fillColor=#000000;strokeColor=#ef4444;strokeWidth=2;html=1;";
  const stAct = "rounded=1;arcSize=18;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#059669;strokeWidth=1.5;fontSize=11;fontColor=#0f172a;align=center;shadow=1;";
  const stActErr = "rounded=1;arcSize=18;whiteSpace=wrap;html=1;fillColor=#fef2f2;strokeColor=#ef4444;strokeWidth=1.5;fontSize=11;fontColor=#991b1b;align=center;shadow=1;";
  const stDec = "rhombus;whiteSpace=wrap;html=1;fillColor=#fef9c3;strokeColor=#ca8a04;strokeWidth=1.5;fontSize=10;fontColor=#854d0e;align=center;";

  cells.push(cell("n_start", "", stStart, 135, 60, 30, 30, "lane_guest"));
  cells.push(cell("n_g_fill", "Enter Registration Details\n(Full Name, Phone, Email,\nPassword, Date of Birth)", stAct, 75, 120, 150, 65, "lane_guest"));

  cells.push(cell("n_fe_val", "Validate Form Syntax\n(E.164 Phone Regex, Password >= 8 Chars,\nMinor Age & Guardian Consent Check)", stAct, 75, 120, 170, 70, "lane_fe"));
  cells.push(cell("n_fe_dec1", "Syntax\nValid?", stDec, 115, 220, 90, 60, "lane_fe"));
  cells.push(cell("n_fe_err1", "Display Inline Validation Errors\n& Highlight Erroneous Fields", stActErr, 75, 310, 170, 45, "lane_fe"));

  cells.push(cell("n_be_recv", "Receive POST /v1/auth/register\n& Normalize Phone to E.164 Standard", stAct, 90, 220, 170, 60, "lane_be"));
  cells.push(cell("n_db_chk", "Query Identity Uniqueness:\nSELECT id FROM users\nWHERE phone = $1 OR email = $2", stAct, 70, 220, 170, 60, "lane_db"));
  cells.push(cell("n_be_dec2", "Identity\nExists?", stDec, 130, 310, 90, 60, "lane_be"));
  cells.push(cell("n_be_err2", "Return HTTP 400 Bad Request (BR-01)\n'Phone or email already registered'", stActErr, 90, 395, 170, 50, "lane_be"));

  cells.push(cell("n_be_gen", "Generate 6-Digit Random OTP\n& Compute SHA-256 Hash", stAct, 90, 470, 175, 60, "lane_be"));
  cells.push(cell("n_db_save_otp", "INSERT INTO otp_challenges\n(phone, purpose='register', otp_hash,\npayload, expires_at = NOW() + 5m)", stAct, 65, 470, 185, 65, "lane_db"));

  cells.push(cell("n_be_disp", "Invoke deliverOtp(email, otp)\n& Return HTTP 202 Accepted", stAct, 90, 560, 175, 55, "lane_be"));
  cells.push(cell("n_mail_send", "Render HTML Email Template\n& Transmit Message via SMTP/SES", stAct, 60, 560, 170, 55, "lane_mail"));
  cells.push(cell("n_fe_scr_otp", "Switch to OTP Verification Screen\n& Initiate 5-Minute Countdown Timer", stAct, 75, 640, 170, 55, "lane_fe"));

  cells.push(cell("n_g_enter_otp", "Check Email Inbox, Copy 6-Digit OTP\n& Enter Code into Verification Input", stAct, 75, 640, 150, 60, "lane_guest"));
  cells.push(cell("n_fe_submit_otp", "Submit POST /v1/auth/otp/verify\n(phone, otp, purpose='register')", stAct, 75, 730, 170, 55, "lane_fe"));

  cells.push(cell("n_be_verify", "Validate SHA-256(otp) Hash Match\nagainst otp_challenges Record", stAct, 90, 730, 175, 60, "lane_be"));
  cells.push(cell("n_be_dec3", "Code Valid &\nUnexpired?", stDec, 130, 815, 95, 60, "lane_be"));
  cells.push(cell("n_be_err3", "Return HTTP 400 Bad Request (BR-03/04)\n'Invalid code or challenge expired'", stActErr, 90, 900, 170, 50, "lane_be"));

  cells.push(cell("n_db_insert_user", "INSERT INTO users (...)\n(role='member', status='active',\nmember_code='M-XXXXXX', pii_consent_at)", stAct, 65, 815, 185, 65, "lane_db"));
  cells.push(cell("n_db_del_otp", "DELETE FROM otp_challenges\nWHERE id = $1 (Invalidate Challenge)", stAct, 65, 900, 185, 50, "lane_db"));
  cells.push(cell("n_db_audit", "INSERT INTO audit_logs\n(action='register', entity='user', target_id)", stAct, 65, 970, 185, 45, "lane_db"));
  cells.push(cell("n_be_issue_jwt", "Issue Signed JWT Token & User Session\n& Return HTTP 200 OK", stAct, 90, 970, 175, 55, "lane_be"));

  cells.push(cell("n_fe_success", "Store JWT in Session Storage,\nTrigger Welcome Sonner Toast\n& Redirect to Member Portal (/app)", stAct, 75, 1050, 170, 65, "lane_fe"));
  cells.push(cell("n_end", "", stEnd, 140, 1065, 32, 32, "lane_guest"));

  const eFlow = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#334155;strokeWidth=1.5;endArrow=block;endFill=1;";
  const eYes = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#16a34a;strokeWidth=1.5;endArrow=block;endFill=1;fontColor=#15803d;fontSize=10;";
  const eNo = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#dc2626;strokeWidth=1.5;endArrow=block;endFill=1;fontColor=#b91c1c;fontSize=10;";

  cells.push(edge("e_start", "", eFlow, "n_start", "n_g_fill"));
  cells.push(edge("e_fill_val", "Submit Registration Form", eFlow, "n_g_fill", "n_fe_val"));
  cells.push(edge("e_val_dec1", "", eFlow, "n_fe_val", "n_fe_dec1"));
  cells.push(edge("e_dec1_no", "[Invalid]", eNo, "n_fe_dec1", "n_fe_err1"));
  cells.push(edge("e_err1_back", "Correct Form Inputs", eFlow, "n_fe_err1", "n_g_fill", [[160, 332], [30, 332], [30, 152], [75, 152]]));
  cells.push(edge("e_dec1_yes", "[Valid]", eYes, "n_fe_dec1", "n_be_recv"));

  cells.push(edge("e_recv_db", "Lookup Existing Users", eFlow, "n_be_recv", "n_db_chk"));
  cells.push(edge("e_db_chk_ret", "Query Result Set", eFlow, "n_db_chk", "n_be_dec2"));
  cells.push(edge("e_dec2_yes", "[Duplicate]", eNo, "n_be_dec2", "n_be_err2"));
  cells.push(edge("e_err2_fe", "HTTP 400 Conflict", eFlow, "n_be_err2", "n_fe_err1"));
  cells.push(edge("e_dec2_no", "[Unique]", eYes, "n_be_dec2", "n_be_gen"));

  cells.push(edge("e_gen_db", "Persist Challenge Hash", eFlow, "n_be_gen", "n_db_save_otp"));
  cells.push(edge("e_gen_disp", "Trigger Email Dispatch", eFlow, "n_be_gen", "n_be_disp"));
  cells.push(edge("e_disp_mail", "Async Dispatch Task", eFlow, "n_be_disp", "n_mail_send"));
  cells.push(edge("e_disp_fe", "HTTP 202 Accepted", eFlow, "n_be_disp", "n_fe_scr_otp"));
  cells.push(edge("e_mail_g", "Deliver Email with Code", eFlow, "n_mail_send", "n_g_enter_otp"));
  cells.push(edge("e_g_sub_otp", "Input OTP Code", eFlow, "n_g_enter_otp", "n_fe_submit_otp"));

  cells.push(edge("e_sub_ver", "POST /v1/auth/otp/verify", eFlow, "n_fe_submit_otp", "n_be_verify"));
  cells.push(edge("e_ver_dec3", "", eFlow, "n_be_verify", "n_be_dec3"));
  cells.push(edge("e_dec3_no", "[Mismatch / Expired]", eNo, "n_be_dec3", "n_be_err3"));
  cells.push(edge("e_err3_fe", "HTTP 400 Verification Error", eFlow, "n_be_err3", "n_fe_scr_otp"));
  cells.push(edge("e_dec3_yes", "[Verified]", eYes, "n_be_dec3", "n_db_insert_user"));

  cells.push(edge("e_ins_del", "Persist User Account", eFlow, "n_db_insert_user", "n_db_del_otp"));
  cells.push(edge("e_del_aud", "Invalidate Challenge", eFlow, "n_db_del_otp", "n_db_audit"));
  cells.push(edge("e_aud_jwt", "Log Audit Event", eFlow, "n_db_audit", "n_be_issue_jwt"));
  cells.push(edge("e_jwt_fe", "HTTP 200 OK + JWT Token", eFlow, "n_be_issue_jwt", "n_fe_success"));
  cells.push(edge("e_fe_end", "Redirect Authenticated User", eFlow, "n_fe_success", "n_end"));

  return wrapDiagram("page_swimlane", "3. Swimlane Activity Diagram (UML 2.0)", W, H, cells.join("\n"));
}

async function main() {
  console.log("Generating 100% Academic English UML 2.0 & DFD Level 0 Draw.io diagrams per FPT SE standard...");

  const d1 = buildUseCaseDiagram();
  const d2 = buildContextDiagram();
  const d3 = buildSwimlaneDiagram();

  const fileUc = join(DRAWIO_DIR, "Arena3-UseCase-UML2.drawio");
  const fileCtx = join(DRAWIO_DIR, "Arena3-Context-DFD0.drawio");
  const fileAct = join(DRAWIO_DIR, "Arena3-Swimlane-Register-OTP.drawio");
  const fileAll = join(DRAWIO_DIR, "Arena3-SRS-Diagrams-UML2.drawio");

  const xmlUc = wrapMxFile([d1]);
  const xmlCtx = wrapMxFile([d2]);
  const xmlAct = wrapMxFile([d3]);
  const xmlAll = wrapMxFile([d1, d2, d3]);

  writeFileSync(fileUc, xmlUc, "utf-8");
  writeFileSync(fileCtx, xmlCtx, "utf-8");
  writeFileSync(fileAct, xmlAct, "utf-8");
  writeFileSync(fileAll, xmlAll, "utf-8");

  const urlUc = generateDrawioUrl(xmlUc);
  const urlCtx = generateDrawioUrl(xmlCtx);
  const urlAct = generateDrawioUrl(xmlAct);
  const urlAll = generateDrawioUrl(xmlAll);

  const linksData = {
    useCase: {
      file: "docs/drawio/Arena3-UseCase-UML2.drawio",
      title: "Use Case Diagram (UML 2.0)",
      standard: "UML 2.0 (FPT University SE Standard / IEEE 830)",
      openInDrawioUrl: urlUc,
    },
    contextDfd: {
      file: "docs/drawio/Arena3-Context-DFD0.drawio",
      title: "Context Diagram (DFD Level 0)",
      standard: "DFD Level 0 (100% English Noun Phrase Data Flows)",
      openInDrawioUrl: urlCtx,
    },
    swimlaneRegister: {
      file: "docs/drawio/Arena3-Swimlane-Register-OTP.drawio",
      title: "Member Registration & OTP Swimlane Activity Diagram",
      standard: "UML 2.0 Activity Diagram (5 Partitions)",
      openInDrawioUrl: urlAct,
    },
    masterMultiTab: {
      file: "docs/drawio/Arena3-SRS-Diagrams-UML2.drawio",
      title: "Master Multi-tab SRS Architecture Diagrams",
      standard: "Draw.io Multi-Page Standard (3 Pages)",
      openInDrawioUrl: urlAll,
    },
  };

  writeFileSync(join(DRAWIO_DIR, "drawio-links.json"), JSON.stringify(linksData, null, 2), "utf-8");

  console.log("Draw.io files generated successfully!");
  console.log("Interactive Draw.io URLs generated in docs/drawio/drawio-links.json");
}

main().catch(err => {
  console.error("Error generating diagrams:", err);
  process.exit(1);
});
