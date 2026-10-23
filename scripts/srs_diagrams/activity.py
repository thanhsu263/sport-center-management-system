"""Activity diagrams with swimlanes (UML 2.0 activity partitions).

Rules applied (Learning UML 2.0, ch. 3): one initial node, activity final nodes,
rounded action nodes named as verb phrases, decision and merge diamonds whose
outgoing flows carry [guards], and one partition per participant.
"""

import math

from lib import Diagram, LINE, INK

LANE = ("swimlane;startSize=40;horizontal=1;html=1;whiteSpace=wrap;fillColor=#e2e8f0;swimlaneFillColor=#ffffff;"
        "strokeColor=#334155;strokeWidth=1.5;fontFamily=Helvetica;fontSize=14;fontStyle=1;fontColor=#1e293b;")
ACTION = ("rounded=1;arcSize=40;whiteSpace=wrap;html=1;fillColor=#eef2ff;strokeColor=#334155;strokeWidth=1.2;"
          "fontFamily=Helvetica;fontSize=12;fontColor=#1e293b;")
DECISION = ("rhombus;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#334155;strokeWidth=1.2;"
            "fontFamily=Helvetica;fontSize=11;fontColor=#1e293b;")
START = "ellipse;html=1;shape=startState;fillColor=#1e293b;strokeColor=#1e293b;"
FINAL = "ellipse;html=1;shape=endState;fillColor=#1e293b;strokeColor=#1e293b;"
FLOW = ("endArrow=open;endSize=10;html=1;rounded=0;edgeStyle=none;strokeColor=" + LINE + ";strokeWidth=1.3;"
        "fontFamily=Helvetica;fontSize=11;fontColor=" + INK + ";labelBackgroundColor=#ffffff;")

LANE_X = (150, 550, 1070)
LANE_W = (400, 520, 380)
LANE_Y = 20
ROW0 = 110
PITCH = 80

SIDES = {"b": (0.5, 1), "t": (0.5, 0), "l": (0, 0.5), "r": (1, 0.5)}


def row_y(r):
    return ROW0 + r * PITCH


class Swimlanes:
    def __init__(self, name, lanes, rows):
        self.d = Diagram(name)
        self.geo = {}
        height = row_y(rows - 1) + 60 - LANE_Y
        self.lane_ids = []
        for i, title in enumerate(lanes):
            lid = f"lane{i}"
            self.d.vertex(title, LANE, LANE_X[i], LANE_Y, LANE_W[i], height, id=lid, role="container")
            self.lane_ids.append(lid)

    def cx(self, lane, dx=0):
        return LANE_X[lane] + LANE_W[lane] / 2 + dx

    def _place(self, cid, value, style, lane, row, dx, w, h, shape):
        cx, cy = self.cx(lane, dx), row_y(row)
        x, y = cx - w / 2, cy - h / 2
        self.d.vertex(value, style, x - LANE_X[lane], y - LANE_Y, w, h, id=cid, parent=self.lane_ids[lane],
                      shape=shape)
        self.geo[cid] = (x, y, w, h)
        return cid

    def start(self, cid, lane, row, dx=0):
        return self._place(cid, "", START, lane, row, dx, 28, 28, "ellipse")

    def final(self, cid, lane, row, dx=0):
        return self._place(cid, "", FINAL, lane, row, dx, 30, 30, "ellipse")

    def action(self, cid, text, lane, row, dx=0, w=220, h=52):
        return self._place(cid, text, ACTION, lane, row, dx, w, h, "rect")

    def decision(self, cid, lane, row, dx=0):
        return self._place(cid, "", DECISION, lane, row, dx, 36, 36, "rhombus")

    def merge(self, cid, lane, row, dx=0):
        return self._place(cid, "", DECISION, lane, row, dx, 36, 36, "rhombus")

    def anchor(self, cid, side):
        rel = SIDES[side] if isinstance(side, str) else side
        x, y, w, h = self.geo[cid]
        return rel, (x + rel[0] * w, y + rel[1] * h)

    def flow(self, a, b, guard="", out="b", into="t", via=None, at=None):
        """Orthogonal control flow from side `out` of a to side `into` of b.

        `via` lists bend points; without it one elbow is added when needed.
        `at` is the absolute centre wanted for the guard label.
        """
        ra, pa = self.anchor(a, out)
        rb, pb = self.anchor(b, into)
        if via is None:
            vert_out = ra[1] in (0, 1) and ra[0] not in (0, 1)
            vert_in = rb[1] in (0, 1) and rb[0] not in (0, 1)
            if abs(pa[0] - pb[0]) < 0.5 or abs(pa[1] - pb[1]) < 0.5:
                via = []
            elif vert_out and not vert_in:
                via = [(pa[0], pb[1])]
            elif not vert_out and vert_in:
                via = [(pb[0], pa[1])]
            elif vert_out:
                my = (pa[1] + pb[1]) / 2
                via = [(pa[0], my), (pb[0], my)]
            else:
                mx = (pa[0] + pb[0]) / 2
                via = [(mx, pa[1]), (mx, pb[1])]
        label = f"[{guard}]" if guard else ""
        lx = loff = None
        if label:
            pts = [pa] + list(via) + [pb]
            if at is None:
                seg = pts[0], pts[1]
                at = ((seg[0][0] + seg[1][0]) / 2, (seg[0][1] + seg[1][1]) / 2)
            lx, loff = rel_label(pts, at)
        return self.d.edge(a, b, label, FLOW, points=via, exit=ra, entry=rb, label_x=lx, label_offset=loff)


def rel_label(pts, at):
    """draw.io keeps an edge label at a relative spot along the path plus an offset."""
    lens = [math.hypot(q[0] - p[0], q[1] - p[1]) for p, q in zip(pts, pts[1:])]
    total = sum(lens) or 1
    best = None
    run = 0
    for (p, q), L in zip(zip(pts, pts[1:]), lens):
        if L == 0:
            continue
        t = max(0, min(1, ((at[0] - p[0]) * (q[0] - p[0]) + (at[1] - p[1]) * (q[1] - p[1])) / (L * L)))
        px, py = p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t
        dist = math.hypot(at[0] - px, at[1] - py)
        if best is None or dist < best[0]:
            best = (dist, run + t * L, px, py)
        run += L
    _, along, px, py = best
    return round(along / total * 2 - 1, 4), (round(at[0] - px), round(at[1] - py))


def register():
    s = Swimlanes("11-ad-register", ["Guest", "Arena3 System", "Mail delivery (SMTP)"], 13)
    G, S, M = 0, 1, 2
    s.start("st", G, 0)
    s.action("a1", "Open the sign-up page", G, 1)
    s.merge("m1", G, 2)
    s.action("a2", "Enter name, phone, email, password and consent", G, 3)
    s.action("a3", "Validate the details<br>(BR-01, BR-02, BR-03, BR-04)", S, 3, w=230)
    s.decision("d1", S, 4)
    s.action("a4", "Store a one-time code that expires in 5 minutes", S, 5, w=230)
    s.action("a5", "Deliver the code to the guest's inbox", M, 5, w=210)
    s.merge("m2", G, 6)
    s.action("a6", "Read the email and enter the code", G, 7)
    s.action("a7", "Check the code and count the attempt", S, 7, w=230)
    s.decision("d2", S, 8)
    s.action("a8", "Refuse the code: expired, or locked for 15 minutes", S, 9, dx=170, w=150, h=60)
    s.final("f1", S, 10, dx=170)
    s.action("a9", "Create the active member account with a new member code", S, 9, dx=-50, w=210, h=56)
    s.action("a10", "Delete the challenge, write the audit entry and sign the member in", S, 10, w=230, h=56)
    s.action("a11", "Open the member home page", G, 11)
    s.final("f2", G, 12)

    s.flow("st", "a1")
    s.flow("a1", "m1")
    s.flow("m1", "a2")
    s.flow("a2", "a3", out="r", into="l")
    s.flow("a3", "d1")
    s.flow("d1", "m1", "details invalid", out="l", into="l", via=[(200, row_y(4)), (200, row_y(2))],
           at=(640, row_y(4) - 14))
    s.flow("d1", "a4", "details valid", at=(s.cx(S) + 52, row_y(4) + 40))
    s.flow("a4", "a5", out="r", into="l")
    s.flow("a5", "m2", out="b", into="t")
    s.flow("m2", "a6")
    s.flow("a6", "a7", out="r", into="l")
    s.flow("a7", "d2")
    s.flow("d2", "m2", "wrong code, fewer than 5 attempts", out="l", into="l",
           via=[(200, row_y(8)), (200, row_y(6))], at=(560, row_y(8) - 14))
    s.flow("d2", "a8", "code expired or locked", out="r", into="t", at=(912, row_y(8) - 14))
    s.flow("a8", "f1")
    s.flow("d2", "a9", "code correct", out="b", into=(155 / 210, 0), at=(s.cx(S) + 48, row_y(8) + 36))
    s.flow("a9", "a10", out="b", into=(65 / 230, 0))
    s.flow("a10", "a11", out="b", into="r")
    s.flow("a11", "f2")
    return s.d


def booking():
    s = Swimlanes("12-ad-book-and-pay", ["Member", "Arena3 System", "payOS"], 14)
    M, S, P = 0, 1, 2
    s.start("st", M, 0)
    s.merge("m1", M, 1)
    s.action("a1", "Choose a sport, date, court and time slot", M, 2, w=280)
    s.action("a2", "Place a 5-minute hold<br>(BR-06, BR-05, BR-09)", S, 2, w=230)
    s.decision("d1", S, 3)
    s.action("a3", "See why the slot cannot be held", M, 3)
    s.action("a4", "Choose deposit or full amount, a promo code and the payment method", M, 4, w=220, h=58)
    s.decision("d2", M, 5)
    s.action("a5", "Create a payOS payment link", S, 5, dx=110, w=190)
    s.action("p1", "Show the VietQR checkout and take the member's payment", P, 5, w=220, h=58)
    s.action("p2", "Send the signed &quot;paid&quot; webhook", P, 6, w=220)
    s.action("a6", "Extend the hold to 120 minutes and flag the transfer", S, 6, dx=-130, w=200, h=56)
    s.action("a7", "Verify the signature and the amount paid", S, 7, dx=110, w=190)
    s.action("a8", "Transfer the amount from a banking app", M, 7)
    s.final("f1", M, 8)
    s.action("a9", "Use one hour of the active plan<br>(BR-13)", S, 9, dx=-130, w=210)
    s.merge("m2", S, 10)
    s.action("a10", "Confirm the booking, redeem the promo, issue the invoice and notify the member",
             S, 11, w=330, h=56)
    s.action("a11", "View the confirmed booking and receipt", M, 12)
    s.final("f2", M, 13)

    s.flow("st", "m1")
    s.flow("m1", "a1")
    s.flow("a1", "a2", out="r", into="l")
    s.flow("a2", "d1")
    s.flow("d1", "a3", "slot not available", out="l", into="r", at=(650, row_y(3) - 14))
    s.flow("a3", "m1", out="l", into="l", via=[(200, row_y(3)), (200, row_y(1))])
    s.flow("d1", "a4", "hold placed", out="b", into="r", at=(s.cx(S) + 44, row_y(3) + 34))
    s.flow("a4", "d2")
    s.flow("d2", "a5", "payOS QR", out="r", into="l", at=(640, row_y(5) - 14))
    s.flow("a5", "p1", out="r", into="l")
    s.flow("p1", "p2")
    s.flow("p2", "a7", out="b", into="r")
    s.flow("d2", "a6", "bank transfer", out="b", into="l", at=(s.cx(M) + 52, row_y(5) + 46))
    s.flow("a6", "a8", out="b", into="r")
    s.flow("a8", "f1")
    s.flow("d2", "a9", "plan hours", out="l", into="l", via=[(180, row_y(5)), (180, row_y(9))],
           at=(255, row_y(5) - 14))
    s.flow("a9", "m2", out="b", into="l")
    s.flow("a7", "m2", out="b", into="r")
    s.flow("m2", "a10")
    s.flow("a10", "a11", out="b", into="r")
    s.flow("a11", "f2")
    return s.d


def waitlist():
    s = Swimlanes("13-ad-enrol-waitlist", ["Member", "Arena3 System", "Scheduled job (every 15 s)"], 9)
    M, S, J = 0, 1, 2
    s.start("st", M, 0)
    s.action("a1", "Choose an open class and press Enrol", M, 1)
    s.action("a2", "Check the enrolment rules<br>(BR-18, BR-19, BR-20, BR-22)", S, 1, w=230)
    s.decision("d1", S, 2)
    s.action("a3", "See why the enrolment was refused", M, 2)
    s.final("f1", M, 3)
    s.decision("d2", S, 3)
    s.action("a4", "Confirm the enrolment", S, 3, dx=175, w=140)
    s.final("f2", S, 4, dx=175)
    s.action("a5", "Add the member to the class waitlist", S, 4, w=200)
    s.action("a6", "Offer the seat for 2 hours and notify the member", S, 5, w=200, h=56)
    s.decision("d3", S, 6)
    s.action("a7", "Accept the waitlist offer", M, 6)
    s.action("j1", "Expire the offer and cancel the waitlist place", J, 6, w=240, h=56)
    s.action("a8", "Confirm the enrolment and close the offer", S, 7, w=200)
    s.action("j2", "Offer the seat to the next member on the waitlist", J, 7, w=240, h=56)
    s.final("f3", S, 8)
    s.final("f4", J, 8)

    s.flow("st", "a1")
    s.flow("a1", "a2", out="r", into="l")
    s.flow("a2", "d1")
    s.flow("d1", "a3", "a rule is broken", out="l", into="r", at=(650, row_y(2) - 14))
    s.flow("a3", "f1")
    s.flow("d1", "d2", "rules met", at=(s.cx(S) + 40, row_y(2) + 40))
    s.flow("d2", "a4", "seat free", out="r", into="l", at=(s.cx(S) + 60, row_y(3) - 14))
    s.flow("a4", "f2")
    s.flow("d2", "a5", "class full", at=(s.cx(S) - 46, row_y(3) + 40))
    s.flow("a5", "a6", "a seat is freed", at=(s.cx(S) - 58, row_y(4.5)))
    s.flow("a6", "d3")
    s.flow("d3", "a7", "member accepts within 2 hours", out="l", into="r", at=(s.cx(S) - 150, row_y(6) - 14))
    s.flow("d3", "j1", "2 hours pass", out="r", into="l", at=(s.cx(S) + 120, row_y(6) - 14))
    s.flow("a7", "a8", out="b", into="l")
    s.flow("a8", "f3")
    s.flow("j1", "j2")
    s.flow("j2", "f4")
    return s.d


def refund():
    s = Swimlanes("14-ad-refund", ["Receptionist", "Arena3 System", "Manager"], 13)
    R, S, G = 0, 1, 2
    s.start("st", R, 0)
    s.action("a1", "Open the payment and choose Raise a refund", R, 1)
    s.merge("m1", R, 2)
    s.action("a2", "Enter the refund amount and the reason", R, 3)
    s.action("a3", "Check the amount against what is still refundable", S, 3, w=230)
    s.decision("d1", S, 4)
    s.decision("d2", S, 5)
    s.action("a4", "Post the refund and restore the promo if fully refunded", S, 6, dx=-130, w=200, h=56)
    s.final("f1", S, 7, dx=-130)
    s.action("a5", "Save the refund as pending approval", S, 6, dx=130, w=190)
    s.action("m2", "Review the pending refund (the raiser cannot decide it)", G, 7, w=220, h=56)
    s.decision("d3", G, 8)
    s.action("a6", "Post the refund and restore the promo if fully refunded", S, 8, dx=60, w=200, h=56)
    s.action("a7", "Mark the refund as rejected", S, 9, dx=60, w=200)
    s.merge("mg", S, 10, dx=-110)
    s.action("a8", "Write the audit entry and notify the member", S, 11, dx=-110, w=210)
    s.final("f2", S, 12, dx=-110)

    s.flow("st", "a1")
    s.flow("a1", "m1")
    s.flow("m1", "a2")
    s.flow("a2", "a3", out="r", into="l")
    s.flow("a3", "d1")
    s.flow("d1", "m1", "amount too large", out="l", into="l", via=[(200, row_y(4)), (200, row_y(2))],
           at=(640, row_y(4) - 14))
    s.flow("d1", "d2", "amount accepted", at=(s.cx(S) + 58, row_y(4) + 40))
    s.flow("d2", "a4", "below 1,000,000 VND", out="l", into="t", at=(s.cx(S) - 120, row_y(5) - 16))
    s.flow("d2", "a5", "1,000,000 VND or more", out="r", into="t", at=(s.cx(S) + 120, row_y(5) - 16))
    s.flow("a4", "f1")
    s.flow("a5", "m2", out="r", into="t")
    s.flow("m2", "d3")
    s.flow("d3", "a6", "approve", out="l", into="r", at=(1110, row_y(8) - 14))
    s.flow("d3", "a7", "reject", out="b", into="r", at=(1110, row_y(9) - 14))
    s.flow("a6", "mg", out="l", into="t")
    s.flow("a7", "mg", out="b", into="r")
    s.flow("mg", "a8")
    s.flow("a8", "f2")
    return s.d


def build():
    return [register(), booking(), waitlist(), refund()]
