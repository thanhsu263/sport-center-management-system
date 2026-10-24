"""Generates academic-grade UML 2.0 diagrams for Arena3 as Draw.io files.
Conforming strictly to FPT University Software Engineering (SWR302 / SWP391 / SEP490) standards:
1. Use Case Diagram (8 Actors, 6 Subsystem Packages, <<include>>, <<extend>>)
2. Context Diagram (DFD Level 0, 7 External Entities, 100% Noun-based Data Flows)
3. Swimlane Activity Diagram (5 Partitions: Guest, Frontend, Backend, Mail Service, Database)

Outputs:
- docs/drawio/Arena3-UseCase-UML2.drawio
- docs/drawio/Arena3-Context-DFD0.drawio
- docs/drawio/Arena3-Swimlane-Register-OTP.drawio
- docs/drawio/Arena3-SRS-Diagrams-UML2.drawio (Multi-page tabs)
"""

import os
from xml.sax.saxutils import escape, quoteattr

HERE = os.path.dirname(os.path.abspath(__file__))
DRAWIO_DIR = os.path.join(HERE, "..", "docs", "drawio")
os.makedirs(DRAWIO_DIR, exist_ok=True)

# -------------------------------------------------------------
# XML Helper Functions
# -------------------------------------------------------------
def wrap_diagram(pid, name, width, height, cells_xml):
    return (
        f'<diagram id="{pid}" name={quoteattr(name)}>'
        f'<mxGraphModel dx="{width}" dy="{height}" grid="1" gridSize="10" guides="1" '
        f'tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" '
        f'pageWidth="{width}" pageHeight="{height}" math="0" shadow="0">'
        f'<root><mxCell id="0"/><mxCell id="1" parent="0"/>\n'
        f'{cells_xml}\n'
        f'</root></mxGraphModel></diagram>'
    )

def wrap_mxfile(diagrams):
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<mxfile host="app.diagrams.net">\n' +
        "\n".join(diagrams) +
        '\n</mxfile>\n'
    )

def cell(cid, val, style, x, y, w, h, parent="1"):
    val_esc = escape(val).replace("\n", "&#xa;")
    return (
        f'<mxCell id={quoteattr(cid)} value={quoteattr(val_esc)} style={quoteattr(style)} '
        f'vertex="1" parent={quoteattr(parent)}>'
        f'<mxGeometry x="{x}" y="{y}" width="{w}" height="{h}" as="geometry"/>'
        f'</mxCell>'
    )

def edge(eid, val, style, src, tgt, pts=None, parent="1"):
    val_esc = escape(val).replace("\n", "&#xa;")
    pts_xml = ""
    if pts:
        pts_xml = '<Array as="points">' + "".join(f'<mxPoint x="{px}" y="{py}"/>' for px, py in pts) + '</Array>'
    return (
        f'<mxCell id={quoteattr(eid)} value={quoteattr(val_esc)} style={quoteattr(style)} '
        f'edge="1" parent={quoteattr(parent)} source={quoteattr(src)} target={quoteattr(tgt)}>'
        f'<mxGeometry relative="1" as="geometry">{pts_xml}</mxGeometry>'
        f'</mxCell>'
    )

# -------------------------------------------------------------
# 1. USE CASE DIAGRAM (UML 2.0)
# -------------------------------------------------------------
def build_use_case_diagram():
    cells = []
    W, H = 1680, 1180

    # Header / Title Banner
    cells.append(cell(
        "title",
        "HỆ THỐNG QUẢN LÝ KHU PHỨC HỢP THỂ THAO ARENA3 — SƠ ĐỒ USE CASE TỔNG THỂ (UML 2.0)\n"
        "Đặc tả kiến trúc 8 Tác nhân (Actors) · 6 Phân hệ chức năng chính (Subsystems) · Quan hệ <<include>> và <<extend>>",
        "text;html=1;align=center;verticalAlign=middle;fontSize=14;fontStyle=1;fontColor=#0f172a;"
        "fillColor=#f8fafc;strokeColor=#cbd5e1;strokeWidth=1.5;rounded=1;shadow=1;",
        40, 20, 1600, 50
    ))

    # System Boundary Box
    cells.append(cell(
        "boundary",
        "System: Nền tảng Điều hành Trung tâm Thể thao Arena3 (Sports Complex Management Platform)",
        "shape=rect;rounded=1;arcSize=2;fillColor=#ffffff;strokeColor=#0284c7;strokeWidth=2.5;verticalAlign=top;align=left;"
        "spacingLeft=20;spacingTop=12;fontStyle=1;fontSize=13;fontColor=#0369a1;shadow=1;",
        240, 90, 1200, 1050
    ))

    # --- PRIMARY ACTORS (LEFT) ---
    actors_left = [
        ("act_guest", "Khách vãng lai\n(Guest)", 60, 140),
        ("act_member", "Hội viên\n(Member)", 60, 340),
        ("act_receptionist", "Lễ tân\n(Receptionist)", 60, 560),
        ("act_coach", "Huấn luyện viên\n(Coach)", 60, 770),
        ("act_manager", "Quản lý\n(Manager)", 60, 970),
    ]
    actor_style = (
        "shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;"
        "fillColor=#e0f2fe;strokeColor=#0284c7;strokeWidth=2;fontStyle=1;fontSize=11;fontColor=#0f172a;"
    )
    for aid, lbl, ax, ay in actors_left:
        cells.append(cell(aid, lbl, actor_style, ax, ay, 50, 90))

    # --- SECONDARY / SYSTEM ACTORS (RIGHT) ---
    actors_right = [
        ("act_ai", "<<service>>\nTrợ lý AI\n(AI Assistant)", 1490, 190),
        ("act_mail", "<<service>>\nEmail OTP\n(Mail System)", 1490, 390),
        ("act_payos", "<<gateway>>\nCổng VietQR\n(payOS)", 1490, 610),
        ("act_scheduler", "<<system>>\nTiến trình Cron\n(Scheduler)", 1490, 840),
    ]
    sys_actor_style = (
        "shape=rect;rounded=1;arcSize=10;whiteSpace=wrap;html=1;fillColor=#f1f5f9;strokeColor=#475569;"
        "strokeWidth=2;fontStyle=1;fontSize=11;fontColor=#0f172a;align=center;verticalAlign=middle;shadow=1;"
    )
    for aid, lbl, ax, ay in actors_right:
        cells.append(cell(aid, lbl, sys_actor_style, ax, ay, 120, 75))

    # --- 6 SUBSYSTEM PACKAGES (INSIDE BOUNDARY) ---
    pkg_style = (
        "shape=rect;rounded=1;arcSize=4;fillColor=#f8fafc;strokeColor=#94a3b8;strokeWidth=1;dashed=1;"
        "verticalAlign=top;align=left;spacingLeft=12;spacingTop=6;fontStyle=1;fontSize=11;fontColor=#475569;"
    )
    # Pkg 1: Auth & Account
    cells.append(cell("pkg_auth", "Phân hệ 1: Xác thực & Tài khoản (Auth & Identity)", pkg_style, 270, 130, 540, 190))
    # Pkg 2: Booking & Courts
    cells.append(cell("pkg_book", "Phân hệ 2: Đặt sân & Lịch thi đấu (Court Booking)", pkg_style, 840, 130, 560, 250))
    # Pkg 3: Plans & Membership
    cells.append(cell("pkg_plan", "Phân hệ 3: Gói tập & Quyền lợi (Membership Plans)", pkg_style, 270, 350, 540, 170))
    # Pkg 4: Classes & Training
    cells.append(cell("pkg_class", "Phân hệ 4: Lớp học & Đào tạo (Classes & Training)", pkg_style, 840, 410, 560, 260))
    # Pkg 5: Front Desk & Gate
    cells.append(cell("pkg_desk", "Phân hệ 5: Quầy Lễ tân, Thu ngân & Gate POS", pkg_style, 270, 550, 540, 260))
    # Pkg 6: Admin, Reports & Ops
    cells.append(cell("pkg_admin", "Phân hệ 6: Quản trị, AI & Báo cáo (Management & Ops)", pkg_style, 270, 840, 1130, 270))

    # --- USE CASES (ELLIPSES) ---
    uc_style = (
        "ellipse;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#059669;strokeWidth=1.5;"
        "fontFamily=Arial;fontSize=11;fontColor=#064e3b;fontStyle=1;align=center;shadow=1;"
    )
    uc_ext_style = (
        "ellipse;whiteSpace=wrap;html=1;fillColor=#fffbeb;strokeColor=#d97706;strokeWidth=1.5;"
        "fontFamily=Arial;fontSize=10.5;fontColor=#78350f;fontStyle=0;align=center;shadow=1;"
    )
    uc_inc_style = (
        "ellipse;whiteSpace=wrap;html=1;fillColor=#eff6ff;strokeColor=#2563eb;strokeWidth=1.5;"
        "fontFamily=Arial;fontSize=10.5;fontColor=#1e3a8a;fontStyle=0;align=center;shadow=1;"
    )

    # UCs Pkg 1
    cells.append(cell("uc_reg", "UC01: Đăng ký tài khoản\n(Register)", uc_style, 290, 170, 140, 55))
    cells.append(cell("uc_otp", "UC02: Xác thực mã\nMail OTP", uc_inc_style, 460, 170, 130, 50))
    cells.append(cell("uc_login", "UC03: Đăng nhập &\nQuên mật khẩu", uc_style, 290, 245, 140, 55))
    cells.append(cell("uc_pass", "UC04: Thẻ hội viên\nDynamic QR Pass", uc_style, 460, 245, 140, 55))

    # UCs Pkg 2
    cells.append(cell("uc_lookup_crt", "UC05: Tra cứu lịch sân\n& Giá công khai", uc_style, 860, 160, 140, 50))
    cells.append(cell("uc_book_crt", "UC06: Đặt sân & Giữ chỗ\n(Court Hold)", uc_style, 1030, 160, 145, 55))
    cells.append(cell("uc_cancel_crt", "UC07: Hủy lịch đặt sân\n(Cancel Booking)", uc_style, 860, 235, 140, 50))
    cells.append(cell("uc_refund", "UC08: Xử lý hoàn tiền\n(Refund Tier)", uc_ext_style, 1030, 235, 135, 50))
    cells.append(cell("uc_resched", "UC09: Đổi lịch chơi sân\n(Reschedule)", uc_ext_style, 1200, 195, 135, 50))
    cells.append(cell("uc_crtmap", "UC10: Sơ đồ sân trực quan\n(Court Map Visual)", uc_style, 1030, 310, 150, 50))

    # UCs Pkg 3
    cells.append(cell("uc_buy_plan", "UC11: Mua & Gia hạn gói tập\n(Buy / Renew Plan)", uc_style, 290, 390, 160, 55))
    cells.append(cell("uc_freeze_plan", "UC12: Đóng băng / Quản lý gói\n(Freeze / Manage)", uc_style, 480, 390, 160, 55))
    cells.append(cell("uc_pay_online", "UC13: Thanh toán trực tuyến\n(VietQR payOS Link)", uc_inc_style, 380, 455, 160, 50))

    # UCs Pkg 4
    cells.append(cell("uc_join_class", "UC14: Đăng ký học lớp\n(Class Enrolment)", uc_style, 860, 445, 140, 50))
    cells.append(cell("uc_coach_sched", "UC15: Xem lịch dạy HLV\n(Coach Schedule)", uc_style, 1030, 445, 140, 50))
    cells.append(cell("uc_att", "UC16: Điểm danh buổi học\n(Attendance Register)", uc_style, 860, 515, 150, 55))
    cells.append(cell("uc_lock_att", "UC17: Khóa sổ điểm danh\n(Lock sau 2h)", uc_inc_style, 1035, 515, 140, 50))
    cells.append(cell("uc_eval", "UC18: Đánh giá & Bài tập\n(Results & Homework)", uc_style, 1205, 515, 145, 55))
    cells.append(cell("uc_class_life", "UC19: Vòng đời lớp học\n(Đổi HLV/Hủy buổi)", uc_style, 950, 600, 155, 55))

    # UCs Pkg 5
    cells.append(cell("uc_shift", "UC20: Quản lý ca trực thu ngân\n(Open/Close Till Shift)", uc_style, 290, 595, 165, 55))
    cells.append(cell("uc_checkin_gate", "UC21: Check-in cửa tự động\n(Scan QR / Nhập Mã)", uc_style, 485, 595, 155, 55))
    cells.append(cell("uc_pos_desk", "UC22: Thu tiền quầy Lễ tân\n(Tiền mặt / VietQR)", uc_style, 290, 675, 160, 55))
    cells.append(cell("uc_gear", "UC23: Thuê đồ & Khách vãng lai\n(Gear Rental & Walk-in)", uc_style, 480, 675, 165, 55))
    cells.append(cell("uc_reconcile", "UC24: Đối soát CK ngân hàng\n(Reconcile Transfer)", uc_style, 380, 745, 165, 50))

    # UCs Pkg 6
    cells.append(cell("uc_prices", "UC25: Cấu hình giá, giờ & Khuyến mãi\n(Prices, Slots, Promos)", uc_style, 300, 890, 175, 55))
    cells.append(cell("uc_staff", "UC26: Phân quyền & Nhân sự\n(Staff Accounts & Roles)", uc_style, 505, 890, 165, 55))
    cells.append(cell("uc_reports", "UC27: Báo cáo Doanh thu & Lấp đầy\n(Revenue & Heatmap)", uc_style, 700, 890, 175, 55))
    cells.append(cell("uc_export", "UC28: Xuất báo cáo\n(Excel / PDF Export)", uc_inc_style, 905, 890, 140, 50))
    cells.append(cell("uc_audit", "UC29: Nhật ký kiểm toán\n(Audit Logs)", uc_style, 1075, 890, 140, 50))
    cells.append(cell("uc_ai_chat", "UC30: Hỏi đáp trợ lý ảo AI\n(Ask AI Assistant)", uc_style, 600, 970, 165, 55))
    cells.append(cell("uc_cron_jobs", "UC31: Quét giữ chỗ & Nhắc lịch\n(Expire Holds, Cron Sweep)", uc_style, 840, 970, 185, 55))

    # --- ASSOCIATIONS (ACTOR -> USE CASE) ---
    assoc_style = "endArrow=none;html=1;strokeColor=#475569;strokeWidth=1.5;rounded=0;"
    
    # Guest links
    cells.append(edge("e_g_reg", "", assoc_style, "act_guest", "uc_reg"))
    cells.append(edge("e_g_look", "", assoc_style, "act_guest", "uc_lookup_crt"))
    cells.append(edge("e_g_log", "", assoc_style, "act_guest", "uc_login"))

    # Member links
    cells.append(edge("e_m_log", "", assoc_style, "act_member", "uc_login"))
    cells.append(edge("e_m_pass", "", assoc_style, "act_member", "uc_pass"))
    cells.append(edge("e_m_book", "", assoc_style, "act_member", "uc_book_crt"))
    cells.append(edge("e_m_cancel", "", assoc_style, "act_member", "uc_cancel_crt"))
    cells.append(edge("e_m_plan", "", assoc_style, "act_member", "uc_buy_plan"))
    cells.append(edge("e_m_cls", "", assoc_style, "act_member", "uc_join_class"))
    cells.append(edge("e_m_ai", "", assoc_style, "act_member", "uc_ai_chat"))

    # Receptionist links
    cells.append(edge("e_r_shift", "", assoc_style, "act_receptionist", "uc_shift"))
    cells.append(edge("e_r_gate", "", assoc_style, "act_receptionist", "uc_checkin_gate"))
    cells.append(edge("e_r_pos", "", assoc_style, "act_receptionist", "uc_pos_desk"))
    cells.append(edge("e_r_gear", "", assoc_style, "act_receptionist", "uc_gear"))
    cells.append(edge("e_r_recon", "", assoc_style, "act_receptionist", "uc_reconcile"))
    cells.append(edge("e_r_map", "", assoc_style, "act_receptionist", "uc_crtmap"))

    # Coach links
    cells.append(edge("e_c_sched", "", assoc_style, "act_coach", "uc_coach_sched"))
    cells.append(edge("e_c_att", "", assoc_style, "act_coach", "uc_att"))
    cells.append(edge("e_c_eval", "", assoc_style, "act_coach", "uc_eval"))

    # Manager links
    cells.append(edge("e_mgr_prices", "", assoc_style, "act_manager", "uc_prices"))
    cells.append(edge("e_mgr_staff", "", assoc_style, "act_manager", "uc_staff"))
    cells.append(edge("e_mgr_rep", "", assoc_style, "act_manager", "uc_reports"))
    cells.append(edge("e_mgr_audit", "", assoc_style, "act_manager", "uc_audit"))
    cells.append(edge("e_mgr_life", "", assoc_style, "act_manager", "uc_class_life"))
    cells.append(edge("e_mgr_shift", "", assoc_style, "act_manager", "uc_shift"))

    # External systems links
    cells.append(edge("e_sys_mail_otp", "", assoc_style, "uc_otp", "act_mail"))
    cells.append(edge("e_sys_pay_link", "", assoc_style, "uc_pay_online", "act_payos"))
    cells.append(edge("e_sys_ai_resp", "", assoc_style, "uc_ai_chat", "act_ai"))
    cells.append(edge("e_sys_cron_work", "", assoc_style, "uc_cron_jobs", "act_scheduler"))

    # --- INCLUDES & EXTENDS (UML 2.0 NOTATION) ---
    inc_style = (
        "edgeStyle=orthogonalEdgeStyle;rounded=1;dashed=1;endArrow=open;endSize=10;html=1;"
        "strokeColor=#2563eb;strokeWidth=1.5;fontStyle=2;fontSize=10;fontColor=#1e40af;align=center;"
    )
    ext_style = (
        "edgeStyle=orthogonalEdgeStyle;rounded=1;dashed=1;endArrow=open;endSize=10;html=1;"
        "strokeColor=#d97706;strokeWidth=1.5;fontStyle=2;fontSize=10;fontColor=#92400e;align=center;"
    )

    # <<include>>: Base -> Included
    cells.append(edge("inc_reg_otp", "<<include>>", inc_style, "uc_reg", "uc_otp"))
    cells.append(edge("inc_book_pay", "<<include>>", inc_style, "uc_book_crt", "uc_pay_online"))
    cells.append(edge("inc_plan_pay", "<<include>>", inc_style, "uc_buy_plan", "uc_pay_online"))
    cells.append(edge("inc_att_lock", "<<include>>", inc_style, "uc_att", "uc_lock_att"))
    cells.append(edge("inc_rep_exp", "<<include>>", inc_style, "uc_reports", "uc_export"))
    cells.append(edge("inc_gate_pass", "<<include>>", inc_style, "uc_checkin_gate", "uc_pass"))

    # <<extend>>: Extension -> Base
    cells.append(edge("ext_ref_cancel", "<<extend>>", ext_style, "uc_refund", "uc_cancel_crt"))
    cells.append(edge("ext_resched_book", "<<extend>>", ext_style, "uc_resched", "uc_book_crt"))

    return wrap_diagram("page_usecase", "1. Use Case Diagram (UML 2.0)", W, H, "\n".join(cells))


# -------------------------------------------------------------
# 2. CONTEXT DIAGRAM (DFD LEVEL 0 - 100% NOUN FLOWS)
# -------------------------------------------------------------
def build_context_diagram():
    cells = []
    W, H = 1600, 1100

    # Header
    cells.append(cell(
        "dfd_title",
        "HỆ THỐNG QUẢN LÝ KHU PHỨC HỢP THỂ THAO ARENA3 — SƠ ĐỒ NGỮ CẢNH (DFD CẤP 0)\n"
        "Quy chuẩn kiểm thử FPT: 7 Thực thể ngoài (External Entities) · 100% Luồng dữ liệu là CỤM DANH TỪ (Noun Phrases)",
        "text;html=1;align=center;verticalAlign=middle;fontSize=14;fontStyle=1;fontColor=#0f172a;"
        "fillColor=#f8fafc;strokeColor=#cbd5e1;strokeWidth=1.5;rounded=1;shadow=1;",
        40, 20, 1520, 50
    ))

    # Central Process 0
    proc_style = (
        "shape=rect;rounded=1;arcSize=25;whiteSpace=wrap;html=1;fillColor=#ecfdf5;strokeColor=#059669;strokeWidth=3;"
        "fontStyle=1;fontSize=13;fontColor=#064e3b;align=center;verticalAlign=middle;shadow=1;"
    )
    cells.append(cell(
        "proc_0",
        "0\n\nHỆ THỐNG QUẢN LÝ\nKHU PHỨC HỢP THỂ THAO\nARENA3\n\n(Arena3 Sports Operations Platform)",
        proc_style,
        610, 390, 380, 260
    ))

    # External Entities
    ent_style = (
        "shape=rect;whiteSpace=wrap;html=1;fillColor=#f8fafc;strokeColor=#1e293b;strokeWidth=2;"
        "fontStyle=1;fontSize=12;fontColor=#0f172a;align=center;verticalAlign=middle;shadow=1;"
    )

    entities = [
        ("ent_guest", "KHÁCH VÃNG LAI\n(Guest)", 80, 130, 220, 90),
        ("ent_member", "HỘI VIÊN\n(Member)", 80, 460, 220, 100),
        ("ent_receptionist", "LỄ TÂN / THU NGÂN\n(Receptionist)", 80, 800, 220, 100),
        ("ent_coach", "HUẤN LUYỆN VIÊN\n(Coach)", 1280, 130, 230, 100),
        ("ent_manager", "QUẢN LÝ TRUNG TÂM\n(Manager)", 1280, 460, 230, 110),
        ("ent_payos", "CỔNG VIETQR ONLINE\n(payOS Gateway)", 1280, 800, 230, 95),
        ("ent_mail", "DỊCH VỤ EMAIL\n(Mail Transport Service)", 690, 930, 220, 80),
    ]
    for eid, lbl, ex, ey, ew, eh in entities:
        cells.append(cell(eid, lbl, ent_style, ex, ey, ew, eh))

    # Data Flows (Strictly Noun Phrases)
    flow_style = (
        "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#0f766e;strokeWidth=1.5;"
        "fontSize=10;fontColor=#0f172a;labelBackgroundColor=#ffffff;align=center;"
    )
    flow_back_style = (
        "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#0369a1;strokeWidth=1.5;"
        "fontSize=10;fontColor=#0f172a;labelBackgroundColor=#ffffff;align=center;"
    )

    # 1. Guest <-> System
    cells.append(edge("f_g_in", "Thông tin đăng ký tài khoản & Yêu cầu tra cứu sân", flow_style, "ent_guest", "proc_0",
                      [(420, 175), (420, 440)]))
    cells.append(edge("f_g_out", "Lịch biểu công khai, Biểu phí & Thông báo trạng thái", flow_back_style, "proc_0", "ent_guest",
                      [(460, 460), (460, 205)]))

    # 2. Member <-> System
    cells.append(edge("f_m_in", "Yêu cầu đặt sân, Mua gói tập & Câu hỏi trợ lý AI", flow_style, "ent_member", "proc_0",
                      [(420, 495), (420, 510)]))
    cells.append(edge("f_m_out", "Thẻ QR hội viên, Biên lai xác nhận & Câu trả lời tư vấn", flow_back_style, "proc_0", "ent_member",
                      [(440, 540), (440, 545)]))

    # 3. Receptionist <-> System
    cells.append(edge("f_r_in", "Dữ liệu ca trực, Mã check-in & Giao dịch thanh toán quầy", flow_style, "ent_receptionist", "proc_0",
                      [(420, 840), (420, 590)]))
    cells.append(edge("f_r_out", "Trạng thái ca trực, Xác nhận vào cổng & Biên lai thu tiền", flow_back_style, "proc_0", "ent_receptionist",
                      [(460, 620), (460, 870)]))

    # 4. Coach <-> System
    cells.append(edge("f_c_in", "Bảng điểm danh buổi học & Đánh giá kết quả học viên", flow_style, "ent_coach", "proc_0",
                      [(1180, 180), (1180, 440)]))
    cells.append(edge("f_c_out", "Lịch dạy phân công, Hồ sơ chuyên cần & Báo cáo thù lao", flow_back_style, "proc_0", "ent_coach",
                      [(1140, 460), (1140, 205)]))

    # 5. Manager <-> System
    cells.append(edge("f_mgr_in", "Biểu giá sân, Gói tập, Tài khoản nhân sự & Lệnh hoàn tiền", flow_style, "ent_manager", "proc_0",
                      [(1180, 495), (1180, 510)]))
    cells.append(edge("f_mgr_out", "Báo cáo doanh thu, Tỷ lệ lấp đầy & Nhật ký kiểm toán", flow_back_style, "proc_0", "ent_manager",
                      [(1140, 540), (1140, 545)]))

    # 6. payOS <-> System
    cells.append(edge("f_p_in", "Yêu cầu khởi tạo liên kết VietQR & Số tiền thanh toán", flow_style, "proc_0", "ent_payos",
                      [(1140, 600), (1140, 830)]))
    cells.append(edge("f_p_out", "Dữ liệu Webhook ký số & Trạng thái thanh toán thành công", flow_back_style, "ent_payos", "proc_0",
                      [(1180, 865), (1180, 625)]))

    # 7. Mail System <-> System
    cells.append(edge("f_mail_out", "Yêu cầu gửi email (Mã OTP xác thực, Hóa đơn VAT, Thông báo)", flow_style, "proc_0", "ent_mail",
                      [(760, 650), (760, 930)]))
    cells.append(edge("f_mail_in", "Trạng thái chuyển phát thông điệp (Thành công / Thất bại)", flow_back_style, "ent_mail", "proc_0",
                      [(840, 930), (840, 650)]))

    return wrap_diagram("page_context", "2. Context Diagram DFD Level 0 (Noun Flows)", W, H, "\n".join(cells))


# -------------------------------------------------------------
# 3. SWIMLANE ACTIVITY DIAGRAM (UML 2.0 - 5 LANES)
# -------------------------------------------------------------
def build_swimlane_diagram():
    cells = []
    W, H = 1680, 1300

    # Header
    cells.append(cell(
        "act_title",
        "QUY TRÌNH ĐĂNG KÝ TÀI KHOẢN VÀ XÁC THỰC QUA EMAIL OTP — SƠ ĐỒ PHÂN LÀN (SWIMLANE ACTIVITY DIAGRAM - UML 2.0)\n"
        "Đặc tả tương tác luồng tuần tự qua 5 Làn: Khách vãng lai · Giao diện Web · Máy chủ API · Dịch vụ Email · Cơ sở dữ liệu",
        "text;html=1;align=center;verticalAlign=middle;fontSize=14;fontStyle=1;fontColor=#0f172a;"
        "fillColor=#f8fafc;strokeColor=#cbd5e1;strokeWidth=1.5;rounded=1;shadow=1;",
        40, 20, 1600, 50
    ))

    # Main Pool Container
    cells.append(cell(
        "pool_main",
        "Quy trình Đăng ký tài khoản Hội viên có xác thực Mail OTP (Arena3 Member Registration Flow)",
        "swimlane;html=1;childLayout=stackLayout;resizeParent=1;resizeParentMax=0;startSize=30;horizontal=0;"
        "horizontalFlip=0;fillColor=#f1f5f9;strokeColor=#475569;strokeWidth=2;fontStyle=1;fontSize=13;fontColor=#1e293b;",
        40, 90, 1600, 1180
    ))

    # 5 Lanes
    lanes = [
        ("lane_guest", "Khách vãng lai (Guest)", "#f8fafc", 300),
        ("lane_fe", "Giao diện Webapp (Frontend)", "#f0fdf4", 320),
        ("lane_be", "Máy chủ Arena3 API (Backend)", "#eff6ff", 350),
        ("lane_mail", "Dịch vụ Email (Mail Service)", "#faf5ff", 290),
        ("lane_db", "Cơ sở dữ liệu (PostgreSQL DB)", "#fffbeb", 310),
    ]

    lane_x = 30
    for lid, lname, lcol, lw in lanes:
        cells.append(cell(
            lid, lname,
            f"swimlane;html=1;startSize=30;horizontal=1;fillColor={lcol};strokeColor=#94a3b8;strokeWidth=1.5;"
            f"fontStyle=1;fontSize=12;fontColor=#0f172a;align=center;",
            lane_x, 0, lw, 1180, parent="pool_main"
        ))
        lane_x += lw

    # --- ACTIVITY NODES INSIDE LANES ---
    # Styles
    st_start = "ellipse;fillColor=#000000;strokeColor=#000000;html=1;"
    st_end = "ellipse;shape=endState;fillColor=#000000;strokeColor=#ef4444;strokeWidth=2;html=1;"
    st_act = "rounded=1;arcSize=18;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#059669;strokeWidth=1.5;fontSize=11;fontColor=#0f172a;align=center;shadow=1;"
    st_act_err = "rounded=1;arcSize=18;whiteSpace=wrap;html=1;fillColor=#fef2f2;strokeColor=#ef4444;strokeWidth=1.5;fontSize=11;fontColor=#991b1b;align=center;shadow=1;"
    st_dec = "rhombus;whiteSpace=wrap;html=1;fillColor=#fef9c3;strokeColor=#ca8a04;strokeWidth=1.5;fontSize=10;fontColor=#854d0e;align=center;"
    st_obj = "shape=note;whiteSpace=wrap;html=1;size=12;verticalAlign=top;align=center;fillColor=#e0e7ff;strokeColor=#6366f1;strokeWidth=1.5;fontSize=10;fontColor=#3730a3;"

    # 1. Start Node (Guest)
    cells.append(cell("n_start", "", st_start, 135, 60, 30, 30, parent="lane_guest"))
    cells.append(cell("n_g_fill", "Điền thông tin đăng ký\n(Họ tên, SĐT, Email,\nMật khẩu, Ngày sinh)", st_act, 75, 120, 150, 65, parent="lane_guest"))

    # 2. Frontend Validation
    cells.append(cell("n_fe_val", "Kiểm tra định dạng Form\n(Regex SĐT, Mật khẩu >= 8 ký tự,\nĐộ tuổi >= 16 hoặc Người bảo hộ)", st_act, 75, 120, 170, 70, parent="lane_fe"))
    cells.append(cell("n_fe_dec1", "Dữ liệu\nhợp lệ?", st_dec, 115, 220, 90, 60, parent="lane_fe"))
    cells.append(cell("n_fe_err1", "Hiển thị lỗi Validation\nngay trên Form", st_act_err, 75, 310, 170, 45, parent="lane_fe"))

    # 3. Backend Check DB
    cells.append(cell("n_be_recv", "Tiếp nhận POST /v1/auth/register\n& Chuẩn hóa SĐT (E.164)", st_act, 90, 220, 170, 60, parent="lane_be"))
    cells.append(cell("n_db_chk", "Truy vấn kiểm tra tồn tại:\nSELECT id FROM users\nWHERE phone=$1 OR email=$2", st_act, 70, 220, 170, 60, parent="lane_db"))
    cells.append(cell("n_be_dec2", "Đã có\ntài khoản?", st_dec, 130, 310, 90, 60, parent="lane_be"))
    cells.append(cell("n_be_err2", "Trả về HTTP 400 (BR-01)\n'Phone or email already registered'", st_act_err, 90, 395, 170, 50, parent="lane_be"))

    # 4. Generate & Save OTP
    cells.append(cell("n_be_gen", "Sinh mã OTP ngẫu nhiên 6 chữ số\n& Băm mật mã SHA-256 mã OTP", st_act, 90, 470, 175, 60, parent="lane_be"))
    cells.append(cell("n_db_save_otp", "INSERT INTO otp_challenges\n(phone, purpose='register',\notp_hash, payload, expires_at=NOW()+5m)", st_act, 65, 470, 185, 65, parent="lane_db"))

    # 5. Dispatch Email & Return 202
    cells.append(cell("n_be_disp", "Gọi hàm deliverOtp(email, otp)\n& Trả về HTTP 202 Accepted", st_act, 90, 560, 175, 55, parent="lane_be"))
    cells.append(cell("n_mail_send", "Tạo Template Email OTP\n& Gửi mã đến hòm thư người dùng", st_act, 60, 560, 170, 55, parent="lane_mail"))
    cells.append(cell("n_fe_scr_otp", "Chuyển sang màn hình nhập OTP\n(Bắt đầu đếm ngược 5:00 phút)", st_act, 75, 640, 170, 55, parent="lane_fe"))

    # 6. Guest receives and enters OTP
    cells.append(cell("n_g_enter_otp", "Nhận email, lấy mã 6 chữ số\n& Nhập vào ô xác thực trên Web", st_act, 75, 640, 150, 60, parent="lane_guest"))
    cells.append(cell("n_fe_submit_otp", "Gửi POST /v1/auth/otp/verify\n(phone, otp, purpose='register')", st_act, 75, 730, 170, 55, parent="lane_fe"))

    # 7. Backend verify OTP
    cells.append(cell("n_be_verify", "So khớp mã băm SHA-256(otp)\nvới bản ghi otp_challenges", st_act, 90, 730, 175, 60, parent="lane_be"))
    cells.append(cell("n_be_dec3", "Mã đúng &\ncòn hạn?", st_dec, 130, 815, 95, 60, parent="lane_be"))
    cells.append(cell("n_be_err3", "Trả về HTTP 400 (BR-03/04)\n'Wrong code or expired OTP'", st_act_err, 90, 900, 170, 50, parent="lane_be"))

    # 8. Create User & Session
    cells.append(cell("n_db_insert_user", "INSERT INTO users (...)\n(role='member', status='active',\nmember_code=M-XXXXXX, pii_consent_at)", st_act, 65, 815, 185, 65, parent="lane_db"))
    cells.append(cell("n_db_del_otp", "DELETE FROM otp_challenges\nWHERE id=$1 (Hủy mã đã dùng)", st_act, 65, 900, 185, 50, parent="lane_db"))
    cells.append(cell("n_db_audit", "INSERT INTO audit_logs\n(action='register', entity='user')", st_act, 65, 970, 185, 45, parent="lane_db"))
    cells.append(cell("n_be_issue_jwt", "Cấp Token JWT & SessionUser\n(Trả về HTTP 200 OK)", st_act, 90, 970, 175, 55, parent="lane_be"))

    # 9. Frontend Complete & Final
    cells.append(cell("n_fe_success", "Lưu Token vào SessionStorage,\nThông báo chào mừng Sonner Toast\n& Chuyển hướng vào trang chủ /app", st_act, 75, 1050, 170, 65, parent="lane_fe"))
    cells.append(cell("n_end", "", st_end, 140, 1065, 32, 32, parent="lane_guest"))

    # --- EDGES (CONTROL FLOWS) ---
    e_flow = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#334155;strokeWidth=1.5;endArrow=block;endFill=1;"
    e_yes = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#16a34a;strokeWidth=1.5;endArrow=block;endFill=1;fontColor=#15803d;fontSize=10;"
    e_no = "edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeColor=#dc2626;strokeWidth=1.5;endArrow=block;endFill=1;fontColor=#b91c1c;fontSize=10;"

    cells.append(edge("e_start", "", e_flow, "n_start", "n_g_fill"))
    cells.append(edge("e_fill_val", "Submit Form", e_flow, "n_g_fill", "n_fe_val"))
    cells.append(edge("e_val_dec1", "", e_flow, "n_fe_val", "n_fe_dec1"))
    cells.append(edge("e_dec1_no", "[Không]", e_no, "n_fe_dec1", "n_fe_err1"))
    cells.append(edge("e_err1_back", "Sửa thông tin", e_flow, "n_fe_err1", "n_g_fill", [(160, 332), (30, 332), (30, 152), (75, 152)]))
    cells.append(edge("e_dec1_yes", "[Hợp lệ]", e_yes, "n_fe_dec1", "n_be_recv"))

    cells.append(edge("e_recv_db", "Kiểm tra trùng", e_flow, "n_be_recv", "n_db_chk"))
    cells.append(edge("e_db_chk_ret", "Kết quả truy vấn", e_flow, "n_db_chk", "n_be_dec2"))
    cells.append(edge("e_dec2_yes", "[Đã có]", e_no, "n_be_dec2", "n_be_err2"))
    cells.append(edge("e_err2_fe", "Thông báo lỗi", e_flow, "n_be_err2", "n_fe_err1"))
    cells.append(edge("e_dec2_no", "[Chưa có]", e_yes, "n_be_dec2", "n_be_gen"))

    cells.append(edge("e_gen_db", "Lưu Hash & Payload", e_flow, "n_be_gen", "n_db_save_otp"))
    cells.append(edge("e_gen_disp", "Gửi email", e_flow, "n_be_gen", "n_be_disp"))
    cells.append(edge("e_disp_mail", "Giao việc gửi thư", e_flow, "n_be_disp", "n_mail_send"))
    cells.append(edge("e_disp_fe", "202 Accepted", e_flow, "n_be_disp", "n_fe_scr_otp"))
    cells.append(edge("e_mail_g", "Nhận email chứa mã", e_flow, "n_mail_send", "n_g_enter_otp"))
    cells.append(edge("e_g_sub_otp", "Nhập OTP", e_flow, "n_g_enter_otp", "n_fe_submit_otp"))

    cells.append(edge("e_sub_ver", "POST verify", e_flow, "n_fe_submit_otp", "n_be_verify"))
    cells.append(edge("e_ver_dec3", "", e_flow, "n_be_verify", "n_be_dec3"))
    cells.append(edge("e_dec3_no", "[Sai/Quá hạn]", e_no, "n_be_dec3", "n_be_err3"))
    cells.append(edge("e_err3_fe", "Thông báo mã sai", e_flow, "n_be_err3", "n_fe_scr_otp"))
    cells.append(edge("e_dec3_yes", "[Chính xác]", e_yes, "n_be_dec3", "n_db_insert_user"))

    cells.append(edge("e_ins_del", "Hoàn tất user", e_flow, "n_db_insert_user", "n_db_del_otp"))
    cells.append(edge("e_del_aud", "", e_flow, "n_db_del_otp", "n_db_audit"))
    cells.append(edge("e_aud_jwt", "Cấp Token", e_flow, "n_db_audit", "n_be_issue_jwt"))
    cells.append(edge("e_jwt_fe", "200 OK + JWT", e_flow, "n_be_issue_jwt", "n_fe_success"))
    cells.append(edge("e_fe_end", "Đăng nhập thành công", e_flow, "n_fe_success", "n_end"))

    return wrap_diagram("page_swimlane", "3. Swimlane Activity Diagram (UML 2.0)", W, H, "\n".join(cells))


# -------------------------------------------------------------
# MAIN BUILD SCRIPT
# -------------------------------------------------------------
def main():
    print("Building Draw.io Diagrams according to UML 2.0 & FPT University SRS standards...")

    p1 = build_use_case_diagram()
    p2 = build_context_diagram()
    p3 = build_swimlane_diagram()

    # Individual files
    file_uc = os.path.join(DRAWIO_DIR, "Arena3-UseCase-UML2.drawio")
    with open(file_uc, "w", encoding="utf-8") as f:
        f.write(wrap_mxfile([p1]))
    print(f"Created: {file_uc}")

    file_ctx = os.path.join(DRAWIO_DIR, "Arena3-Context-DFD0.drawio")
    with open(file_ctx, "w", encoding="utf-8") as f:
        f.write(wrap_mxfile([p2]))
    print(f"Created: {file_ctx}")

    file_act = os.path.join(DRAWIO_DIR, "Arena3-Swimlane-Register-OTP.drawio")
    with open(file_act, "w", encoding="utf-8") as f:
        f.write(wrap_mxfile([p3]))
    print(f"Created: {file_act}")

    # Master Multi-tab Draw.io file
    file_all = os.path.join(DRAWIO_DIR, "Arena3-SRS-Diagrams-UML2.drawio")
    with open(file_all, "w", encoding="utf-8") as f:
        f.write(wrap_mxfile([p1, p2, p3]))
    print(f"Created Master multi-page file: {file_all}")

    print("Draw.io diagrams generation completed successfully!")

if __name__ == "__main__":
    main()
