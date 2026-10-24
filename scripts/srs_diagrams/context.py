"""Context diagram (DFD level 0): one process, external entities, labelled data flows."""

import math

from lib import Diagram, FONT, LINE, INK

W, H = 1240, 900
CX, CY, RX, RY = 620, 450, 150, 390
ENT_W, ENT_H = 200, 100
LANE = 28

ENTITY = ("rounded=0;whiteSpace=wrap;html=1;fillColor=#f1f5f9;strokeColor=#334155;strokeWidth=1.5;"
          "fontFamily=Helvetica;fontSize=16;fontStyle=1;fontColor=#1e293b;")
PROCESS = ("ellipse;whiteSpace=wrap;html=1;fillColor=#eef2ff;strokeColor=#1e293b;strokeWidth=2;"
           "fontFamily=Helvetica;fontSize=22;fontStyle=1;fontColor=#1e293b;")
FLOW = ("endArrow=block;endFill=1;html=1;rounded=0;edgeStyle=none;strokeColor=" + LINE + ";strokeWidth=1.5;"
        "fontFamily=Helvetica;fontSize=14;fontColor=" + INK + ";labelBackgroundColor=#ffffff;")

# name, side, row centre y, flow into the system, flow out of the system
ENTITIES = [
    ("Guest", "left", 175, "Registration, OTP code", "Public info, OTP prompt"),
    ("Member", "left", 310, "Bookings, plans, payments", "Confirmations, QR pass"),
    ("Receptionist", "left", 450, "Walk-ins, counter payments", "Court map, receipts"),
    ("Coach", "left", 590, "Attendance, results, plans", "Schedule, rosters, earnings"),
    ("Manager", "left", 725, "Prices, staff, approvals", "Reports, audit log"),
    ("payOS<br>(payment gateway)", "right", 220, "Paid-status webhook", "Payment link request"),
    ("Mail server<br>(SMTP)", "right", 450, "Delivery result", "OTP codes, notices"),
    ("Gemini AI<br>(assistant)", "right", 680, "Assistant answer", "Member question"),
]


def rim_x(y, side):
    dx = RX * math.sqrt(1 - ((y - CY) / RY) ** 2)
    return CX - dx if side == "left" else CX + dx


def build():
    d = Diagram("01-context-diagram", w=W, h=H)
    proc = d.vertex("Arena3 Sports Centre<br>Management System", PROCESS, CX - RX, CY - RY, 2 * RX, 2 * RY,
                    id="process", shape="ellipse")
    for i, (name, side, row, inflow, outflow) in enumerate(ENTITIES):
        x = 20 if side == "left" else W - 20 - ENT_W
        top = row - ENT_H / 2
        ent = d.vertex(name, ENTITY, x, top, ENT_W, ENT_H, id=f"ent{i}")
        for k, (dy, text) in enumerate(((-LANE, inflow), (LANE, outflow))):
            y = row + dy
            ent_rel = (1 if side == "left" else 0, (y - top) / ENT_H)
            rim = ((rim_x(y, side) - (CX - RX)) / (2 * RX), (y - (CY - RY)) / (2 * RY))
            if k == 0:
                d.edge(ent, proc, text, FLOW, exit=ent_rel, entry=rim, id=f"f{i}{k}")
            else:
                d.edge(proc, ent, text, FLOW, exit=rim, entry=ent_rel, id=f"f{i}{k}")
    return d
