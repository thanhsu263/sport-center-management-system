"""Generates the Arena3 screen-flow diagrams as draw.io files.

Run:  python build_drawio.py
Output: one .drawio per actor + Arena3-ScreensFlow-ALL.drawio (5 pages).
Edit the SPECS below and re-run, or just edit the .drawio files in draw.io.
"""
import os
import re
from xml.sax.saxutils import escape, quoteattr

HERE = os.path.dirname(os.path.abspath(__file__))
LEAF_W, LEAF_H = 130, 40
PAD, GAP, HEAD = 14, 10, 32
COL_GAP, ROW_GAP = 90, 18


def N(id, label, kids=None, cols=None):
    # reference style: screen names only, no route paths (paths live in the description tables)
    label = re.sub(r'\s*\n?\(/[^)]*\)', '', label).strip()
    return dict(id=id, label=label, kids=kids or [], cols=cols)


def measure(n):
    if not n["kids"]:
        n["w"], n["h"] = LEAF_W, LEAF_H
        return
    for k in n["kids"]:
        measure(k)
    c = n["cols"] or (1 if len(n["kids"]) == 1 else 2)
    n["_c"] = c
    rows = [n["kids"][i:i + c] for i in range(0, len(n["kids"]), c)]
    cw = max(k["w"] for k in n["kids"])
    n["_cw"] = cw
    n["_rh"] = [max(k["h"] for k in r) for r in rows]
    n["w"] = PAD * 2 + c * cw + (c - 1) * GAP
    n["h"] = HEAD + PAD + sum(n["_rh"]) + (len(rows) - 1) * GAP + PAD


POS = {}


def emit(n, parent, x, y, out, ox=0, oy=0):
    POS[n["id"]] = (ox + x, oy + y, n["w"], n["h"])
    leaf = not n["kids"]
    label = escape(n["label"]).replace("\n", "&lt;br&gt;")
    if leaf:
        style = ("rounded=1;arcSize=5;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#555555;"
                 "strokeWidth=1;fontSize=11;fontFamily=Arial;shadow=0;")
    else:
        style = ("rounded=1;arcSize=2;container=1;collapsible=0;recursiveResize=0;whiteSpace=wrap;html=1;"
                 "fillColor=#ffffff;strokeColor=#555555;strokeWidth=1;verticalAlign=top;align=center;"
                 "spacingTop=6;fontStyle=0;fontSize=11;fontFamily=Arial;")
    out.append(
        f'<mxCell id={quoteattr(n["id"])} value="{label}" style={quoteattr(style)} vertex="1" parent={quoteattr(parent)}>'
        f'<mxGeometry x="{x}" y="{y}" width="{n["w"]}" height="{n["h"]}" as="geometry"/></mxCell>')
    if leaf:
        return
    c, cw = n["_c"], n["_cw"]
    cy = HEAD + PAD
    for ri, rh in enumerate(n["_rh"]):
        for ci, k in enumerate(n["kids"][ri * c:(ri + 1) * c]):
            emit(k, n["id"], PAD + ci * (cw + GAP), cy + (rh - k["h"]) // 2, out, ox + x, oy + y)
        cy += rh + GAP


def E(src, tgt, label=None, dashed=False, route="auto", f=0.5, ey=0.5):
    return dict(src=src, tgt=tgt, label=label, dashed=dashed, route=route, f=f, ey=ey)


def build_page(spec):
    POS.clear()
    cols = spec["cols"]
    center = spec.get("center", set())
    for col in cols:
        for n in col:
            measure(n)
    colw = [max(n["w"] for n in col) for col in cols]
    rg = spec.get("rowgap", ROW_GAP)
    colh = [sum(n["h"] for n in col) + rg * (len(col) - 1) for col in cols]
    H = max(colh)
    out, x = [], 40
    colx, owner = [], {}

    def own(n, ci):
        owner[n["id"]] = ci
        for k in n["kids"]:
            own(k, ci)

    for ci, (col, cwid, ch) in enumerate(zip(cols, colw, colh)):
        colx.append(x)
        y = 40 + (H - ch) // 2
        for n in col:
            nx = x + ((cwid - n["w"]) // 2 if ci in center else 0)
            emit(n, "1", nx, y, out)
            own(n, ci)
            y += n["h"] + rg
        x += cwid + COL_GAP
    loop_y = 40 + H + 22
    lanes = {}
    for i, e in enumerate(spec["edges"]):
        sx, sy, sw, sh = POS[e["src"]]
        tx, ty, tw, th = POS[e["tgt"]]
        cs, ct = owner[e["src"]], owner[e["tgt"]]
        con, pts, lx = "", [], None
        r = e["route"]
        if r == "plain":
            pass
        elif r == "v":
            if ty > sy:
                con = f"exitX={e['f']};exitY=1;entryX={e['f']};entryY=0;"
            else:
                con = f"exitX={e['f']};exitY=0;entryX={e['f']};entryY=1;"
        elif r == "vx":  # straight vertical line through the centre of the narrower box
            xc = sx + sw / 2 if sw <= tw else tx + tw / 2
            fs, ft = (xc - sx) / sw, (xc - tx) / tw
            if ty > sy:
                con = f"exitX={fs};exitY=1;entryX={ft};entryY=0;"
            else:
                con = f"exitX={fs};exitY=0;entryX={ft};entryY=1;"
        elif r == "loop":
            con = "exitX=0.5;exitY=1;entryX=0.5;entryY=1;"
            pts = [(sx + sw // 2, loop_y), (tx + tw // 2, loop_y)]
        elif r == "back":
            g = min(cs, ct)
            lane = lanes.setdefault((g, e["src"]), len([k for k in lanes if k[0] == g]))
            gx = colx[g] + colw[g] + 30 + lane * 20
            con = "exitX=0;exitY=0.5;entryX=1;entryY=0.5;"
            pts = [(gx, sy + sh // 2), (gx, ty + th // 2)]
        else:  # auto: forward, bus in the gutter right of the source column
            g = cs
            lane = lanes.setdefault((g, e["src"]), len([k for k in lanes if k[0] == g]))
            gx = colx[g] + colw[g] + 30 + lane * 20
            ey = e["ey"]
            con = f"exitX=1;exitY=0.5;entryX=0;entryY={ey};"
            pts = [(gx, sy + sh // 2), (gx, int(ty + th * ey))]
            lx = 0.8
        label = ""  # reference style: unlabeled arrows
        style = ("edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;endSize=5;strokeColor=#555555;strokeWidth=1;"
                 "fontSize=11;fontFamily=Arial;labelBackgroundColor=#ffffff;" + con + ("dashed=1;" if e["dashed"] else ""))
        arr = ""
        if pts:
            arr = '<Array as="points">' + "".join(f'<mxPoint x="{px}" y="{py}"/>' for px, py in pts) + "</Array>"
        xa = f' x="{lx}"' if (lx is not None and label) else ""
        out.append(f'<mxCell id="e{i}" value="{label}" style={quoteattr(style)} edge="1" parent="1" '
                   f'source={quoteattr(e["src"])} target={quoteattr(e["tgt"])}><mxGeometry relative="1"{xa} as="geometry">{arr}</mxGeometry></mxCell>')
    return x - COL_GAP + 80, H + 120, "\n".join(out)


def page_xml(name, spec, pid):
    w, h, body = build_page(spec)
    return (f'<diagram id="{pid}" name={quoteattr(name)}><mxGraphModel dx="{w}" dy="{h}" grid="1" gridSize="10" guides="1" '
            f'tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="{w}" pageHeight="{h}" '
            f'math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>\n{body}\n</root></mxGraphModel></diagram>')


def mx(pages):
    return '<?xml version="1.0" encoding="UTF-8"?>\n<mxfile host="app.diagrams.net">\n' + "\n".join(pages) + "\n</mxfile>\n"


SPECS = {}

SPECS["01-Public-Auth"] = dict(name="Public and Authentication", center={1}, rowgap=36, cols=[
    [N("LAND", "Landing Page (/)", [N("L_COACH", "Coach Profile Modal")])],
    [N("REG", "Register Screen (/register)", [N("R_FORM", "Registration Form"), N("R_OTP", "OTP Verification Step")], cols=2),
     N("LOGIN", "Login Screen\n(/login)"),
     N("FORGOT", "Forgot Password Screen (/forgot)", [N("F_REQ", "Request Code Step"), N("F_RESET", "Code + New Password Step")], cols=2)],
    [N("MEMBER", "Member Home Screen\n(/app)"), N("DESK", "Desk Home Screen\n(/desk)"),
     N("COACH", "Coach Schedule Screen\n(/coach)"), N("MANAGER", "Manager Reports Screen\n(/manager)"),
     N("ACCOUNT", "Account Settings Screen\n(/account)")],
], edges=[
    E("LAND", "LOGIN"),
    E("LOGIN", "REG", route="vx"), E("LOGIN", "FORGOT", route="vx"),
    E("R_FORM", "R_OTP", route="plain"), E("F_REQ", "F_RESET", route="plain"),
    E("R_OTP", "MEMBER", ey=0.2),
    E("LOGIN", "MEMBER", "member"), E("LOGIN", "DESK", "receptionist"),
    E("LOGIN", "COACH", "coach"), E("LOGIN", "MANAGER", "manager"),
    E("LOGIN", "ACCOUNT"),
])

SPECS["02-Member"] = dict(name="Member", cols=[
    [N("LOGIN", "Login Screen")],
    [N("HOME", "Member Home Screen (/app)", [N("H_OFFER", "Waitlist Offer Card"), N("H_PAY", "Scan-to-Pay Modal")], cols=1)],
    [N("BOOK", "Book Court Screen (/app/book)", [
        N("B_MONTH", "Month Calendar View"), N("B_HOLD", "Hold Panel\n(5-minute timer)"),
        N("B_CLASH", "Clash Confirmation"), N("B_ALT", "Alternative Slots"),
        N("B_MOVE", "Change Time Mode"), N("B_PAY", "Scan-to-Pay Modal")]),
     N("CLASSES", "Classes Screen (/app/classes)", [N("C_OFFER", "Waitlist Offer Card"), N("C_ATT", "My Attendance Panel")]),
     N("PLANS", "Plans Screen\n(/app/plans)"), N("TRAIN", "Progress Screen\n(/app/train)"),
     N("ASSIST", "Assistant Screen\n(/app/assistant)"),
     N("NOTIF", "Notifications Screen (/app/notifications)", [N("N_DETAIL", "Notification Detail Modal")]),
     N("ACCOUNT", "Account Settings Screen (/account)", [
         N("A_PROFILE", "Profile Tab"), N("A_REC", "Receipts Tab"), N("A_SEC", "Security Tab"), N("A_SUP", "Support Tab")])],
    [N("PAYRET", "Payment Return Screen\n(/pay/return)"), N("RECEIPT", "Receipt PDF\n(new tab)")],
], edges=[E("LOGIN", "HOME")] + [E("HOME", t) for t in ("BOOK", "CLASSES", "PLANS", "TRAIN", "ASSIST", "NOTIF", "ACCOUNT")] + [
    E("B_PAY", "PAYRET"), E("A_REC", "RECEIPT"),
])

SPECS["03-Receptionist-Desk"] = dict(name="Receptionist (Desk)", cols=[
    [N("LOGIN", "Login Screen")],
    [N("HOME", "Desk Home Screen (/desk)", [N("H_SHIFT", "Close Shift Modal"), N("H_NEW", "New Member Wizard\nProfile > Plan > Payment"),
                                            N("H_TICKET", "Support Request Reply")], cols=1)],
    [N("GATE", "Gate Check-in Screen\n(/desk/gate)"),
     N("COURTS", "Court Map Screen (/desk/courts)", [N("C_OCC", "Occupancy Detail Modal"), N("C_WALK", "Walk-in Payment Form"),
                                                     N("C_MERGE", "Merge BR + BC Mode")]),
     N("CLASSES", "Classes Screen (/desk/classes)", [N("CL_DETAIL", "Class Detail Modal\n(read-only)")]),
     N("PAY", "Payments Screen (/desk/payments)", [N("P_TRANS", "Transfers to Check"), N("P_WAIT", "Waiting for Payment"),
                                                   N("P_REF", "Refund Queue"), N("P_REC", "Receipts List"), N("P_QR", "Scan-to-Pay Modal")]),
     N("GEAR", "Gear Screen\n(/desk/gear)"), N("ALERTS", "Alerts Screen\n(/alerts)"),
     N("ACCOUNT", "Account Settings Screen\n(/account)")],
    [N("MEMBER", "Member Profile Screen (/desk/member/:id)", [N("M_EDIT", "Edit Profile Modal"), N("M_REFUND", "Raise Refund Modal")]),
     N("RECEIPT", "Receipt PDF\n(new tab)")],
], edges=[E("LOGIN", "HOME")] + [E("HOME", t) for t in ("GATE", "COURTS", "CLASSES", "PAY", "GEAR", "ALERTS", "ACCOUNT")] + [
    E("GATE", "MEMBER"), E("PAY", "MEMBER"), E("P_REC", "RECEIPT"),
])

SPECS["04-Coach"] = dict(name="Coach", cols=[
    [N("LOGIN", "Login Screen")],
    [N("SCHEDULE", "Coach Schedule Screen\n(/coach)")],
    [N("ATT", "Attendance Screen (/coach/attendance)", [N("A_RES", "Results Panel"), N("A_REG", "Session Register"),
                                                        N("A_PLAN", "Session Plan Panel"), N("A_HW", "Homework Panel")]),
     N("ALERTS", "Alerts Screen\n(/alerts)"), N("ACCOUNT", "Account Settings Screen\n(/account)")],
    [N("STUDENT", "Student Profile Screen (/coach/student/:id)", [N("S_LEVEL", "Level"), N("S_REVIEW", "Progress Review"),
                                                                 N("S_NOTES", "Coach Notes"), N("S_HW", "Homework History")])],
], edges=[E("LOGIN", "SCHEDULE"), E("SCHEDULE", "ATT"), E("SCHEDULE", "ALERTS"), E("SCHEDULE", "ACCOUNT"),
          E("A_REG", "STUDENT")])

SPECS["05-Manager"] = dict(name="Manager", cols=[
    [N("LOGIN", "Login Screen")],
    [N("REPORTS", "Reports Screen (/manager)", [N("R_REV", "Revenue and Occupancy Summary"), N("R_CAP", "Capacity Heatmap Panel"),
                                                N("R_MEM", "Members and Enrolment Panel"), N("R_EXP", "Export\n(XLSX / PDF / CSV)")], cols=1)],
    [N("CLASSES", "Classes Screen (/manager/classes)", [
        N("C_CREATE", "Create Class Form"),
        N("C_DETAIL", "Class Detail Modal (manage)", [N("CD_SESSION", "Cancel / Move Session Form"), N("CD_COACH", "Change Coach Form"),
                                                       N("CD_CAP", "Edit Capacity Form"), N("CD_CANCEL", "Cancel Class Form")])], cols=1),
     N("MEMBERS", "Members Screen\n(/manager/members)"),
     N("PLANS", "Plans Screen (/manager/plans)", [N("PL_NEW", "New Plan Modal"), N("PL_DETAIL", "Plan Detail Modal")]),
     N("PAYMENTS", "Payments Screen (/desk/payments)"),
     N("STAFF", "Staff Screen (/manager/staff)", [N("ST_ADD", "Add Staff Modal"), N("ST_ROLE", "Role Modal"),
                                                  N("ST_PASS", "Hand-over Password Modal")]),
     N("PRICES", "Pricing Screen\n(/manager/prices)"), N("AUDIT", "Audit Screen\n(/manager/audit)"),
     N("SETTINGS", "Settings Screen (/manager/settings)"),
     N("ALERTS", "Alerts Screen\n(/alerts)"), N("ACCOUNT", "Account Settings Screen\n(/account)")],
    [N("MPROFILE", "Member Profile Screen\n(/desk/member/:id)")],
], edges=[E("LOGIN", "REPORTS")] + [E("REPORTS", t) for t in ("CLASSES", "MEMBERS", "PLANS", "PAYMENTS", "STAFF", "PRICES", "AUDIT", "SETTINGS", "ALERTS", "ACCOUNT")] + [
    E("MEMBERS", "MPROFILE")])

if __name__ == "__main__":
    pages = []
    for i, (fname, spec) in enumerate(SPECS.items()):
        pages.append(page_xml(spec["name"], spec, f"p{i}"))
        with open(os.path.join(HERE, fname + ".drawio"), "w", encoding="utf8") as f:
            f.write(mx([pages[-1]]))
    with open(os.path.join(HERE, "Arena3-ScreensFlow-ALL.drawio"), "w", encoding="utf8") as f:
        f.write(mx(pages))
    print("written", len(SPECS) + 1, "files to", HERE)
