"""Sequence diagrams (UML 2.0 interactions, Learning UML 2.0 ch. 7).

Lifelines are named `name : Type`. A synchronous call has a solid line and a filled
arrowhead, an asynchronous signal a solid line and an open arrowhead, and a reply a
dashed line and an open arrowhead. Execution occurrences (activation bars) start when a
lifeline receives a message and end when it replies. alt and par fragments carry their
guards in square brackets, one per operand.
"""

from lib import Diagram, LINE, INK, CHAR_W

HEAD = 40
LIFELINE = ("shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;container=1;dropTarget=0;"
            "collapsible=0;recursiveResize=0;outlineConnect=0;portConstraint=eastwest;size=40;"
            "fillColor=#eef2ff;strokeColor=#334155;strokeWidth=1.2;fontFamily=Helvetica;fontSize=12;"
            "fontColor=#1e293b;")
BAR = ("html=1;points=[];perimeter=orthogonalPerimeter;outlineConnect=0;targetShapes=umlLifeline;"
       "portConstraint=eastwest;fillColor=#ffffff;strokeColor=#334155;strokeWidth=1.2;")
_MSG = ("html=1;rounded=0;edgeStyle=none;strokeColor=" + LINE + ";strokeWidth=1.2;fontFamily=Helvetica;"
        "fontSize=11;fontColor=" + INK + ";labelBackgroundColor=#ffffff;endSize=8;")
CALL = _MSG + "endArrow=block;endFill=1;"
SIGNAL = _MSG + "endArrow=open;endFill=0;"
REPLY = _MSG + "endArrow=open;endFill=0;dashed=1;"
FRAME = ("shape=umlFrame;whiteSpace=wrap;html=1;pointerEvents=0;width=50;height=22;fillColor=#e2e8f0;"
         "swimlaneFillColor=none;strokeColor=#334155;strokeWidth=1.2;fontFamily=Helvetica;fontSize=12;"
         "fontStyle=1;fontColor=#1e293b;")
SEPARATOR = "line;strokeWidth=1.2;dashed=1;dashPattern=6 4;html=1;strokeColor=#334155;fillColor=none;"
GUARD = ("text;html=1;align=left;verticalAlign=middle;whiteSpace=nowrap;fontFamily=Helvetica;fontSize=11;"
         "fontColor=#1e293b;")

LL_Y = 30
LL_W = 170
TOP = 110
PITCH = 33
BAR_W = 12
LOOP = 30


def text_w(text, size=11):
    return len(text) * CHAR_W * size / 12 + 8


class Seq:
    """Write the interaction top to bottom; bars and geometry are worked out in finish()."""

    def __init__(self, name, parts, xs=None):
        self.name = name
        self.parts = parts
        n = len(parts)
        self.cx = {}
        for i, (pid, _) in enumerate(parts):
            self.cx[pid] = xs[i] if xs else 120 + i * (1360 / (n - 1))
        self.y = TOP
        self.active = {}
        self.bars = []
        self.msgs = []
        self.frames = []
        self.open_frames = []
        self.num = 0

    # ---------- activation bookkeeping ----------

    def _open(self, pid, y):
        if pid not in self.active:
            self.active[pid] = y - 7

    def _close(self, pid, y):
        if pid in self.active:
            self.bars.append([pid, self.active.pop(pid), y + 7])

    def _label(self, text):
        return text

    def _msg(self, kind, a, b, text, shift=0):
        self.msgs.append(dict(kind=kind, a=a, b=b, y=self.y, text=self._label(text), shift=shift))

    # ---------- messages ----------

    def call(self, a, b, text, shift=0):
        """Synchronous call; `b` stays active until it replies."""
        self._open(a, self.y)
        self._open(b, self.y)
        self._msg("call", a, b, text, shift)
        self.y += PITCH

    def query(self, a, b, text, shift=0):
        """Synchronous call whose reply is left implicit (a short bar on `b`)."""
        self._open(a, self.y)
        self._msg("call", a, b, text, shift)
        if b not in self.active:
            self.bars.append([b, self.y - 7, self.y + 12])
        self.y += PITCH

    def signal(self, a, b, text, keep=True, shift=0):
        """Asynchronous message; `b` becomes active unless keep is False."""
        self._open(a, self.y)
        self._msg("signal", a, b, text, shift)
        if keep:
            self._open(b, self.y)
        elif b not in self.active:
            self.bars.append([b, self.y - 7, self.y + 12])
        self.y += PITCH

    def reply(self, b, a, text, shift=0):
        self._open(b, self.y)
        self._open(a, self.y)
        self._msg("reply", b, a, text, shift)
        self._close(b, self.y)
        self.y += PITCH

    def self_call(self, p, text):
        self._open(p, self.y)
        self.msgs.append(dict(kind="self", a=p, b=p, y=self.y, text=self._label(text), shift=0))
        self.y += 50

    def done(self, p):
        """End an execution without a drawn reply (an actor that has finished, say)."""
        self._close(p, self.y - PITCH + 8)

    # ---------- combined fragments ----------

    def frame(self, op, guard, left, right, pad_left=95, pad_right=95):
        f = dict(op=op, left=left, right=right, top=self.y - 18, pad_left=pad_left, pad_right=pad_right,
                 guards=[(self.y - 3, guard)], seps=[], before=set(self.active))
        self.open_frames.append(f)
        self.y += 30

    def sep(self, guard):
        f = self.open_frames[-1]
        line = self.y - 14
        # every operand starts from the state the fragment was entered with
        for pid in list(self.active):
            if pid not in f["before"]:
                self._close(pid, line - 10)
        for pid in f["before"]:
            if pid not in self.active:
                self.active[pid] = line + 4
        f["seps"].append(line)
        f["guards"].append((self.y + 4, guard))
        self.y += 33

    def end(self):
        f = self.open_frames.pop()
        f["bottom"] = self.y - 14
        self.frames.append(f)
        self.y += 14

    # ---------- drawing ----------

    def finish(self):
        for pid in list(self.active):
            self._close(pid, self.y - PITCH + 14)
        d = Diagram(self.name)
        bottom = max(b[2] for b in self.bars) + 24
        for pid, label in self.parts:
            x = self.cx[pid] - LL_W / 2
            d.vertex(label, LIFELINE, x, LL_Y, LL_W, bottom - LL_Y, id=pid, role="lifeline", head=HEAD)
        bar_ids = []
        for k, (pid, y0, y1) in enumerate(sorted(self.bars, key=lambda b: (b[0], b[1]))):
            bid = f"{pid}_x{k}"
            d.vertex("", BAR, LL_W / 2 - BAR_W / 2, y0 - LL_Y, BAR_W, y1 - y0, id=bid, parent=pid, role="part")
            bar_ids.append((pid, y0, y1, bid))

        def bar_at(pid, y):
            for p, y0, y1, bid in bar_ids:
                if p == pid and y0 <= y <= y1:
                    return bid, y0, y1
            raise ValueError(f"{self.name}: no execution on {pid} at y={y}")

        for f in self.frames:
            fx = self.cx[f["left"]] - f["pad_left"]
            fw = self.cx[f["right"]] + f["pad_right"] - fx
            fid = d.vertex(f["op"], FRAME, fx, f["top"], fw, f["bottom"] - f["top"], role="frame")
            d.keepout(fx, f["top"], 50, 22, fid + " operator")
            for k, sy in enumerate(f["seps"]):
                d.vertex("", SEPARATOR, fx, sy - 5, fw, 10, id=f"{fid}_s{k}", role="frame")
            for k, (gy, text) in enumerate(f["guards"]):
                gx = self.cx[f["left"]] + BAR_W / 2 + 8
                d.vertex(text, GUARD, gx, gy - 9, text_w(text) + 12, 18, id=f"{fid}_g{k}", role="label")

        for k, m in enumerate(self.msgs):
            y = m["y"]
            style = {"call": CALL, "signal": SIGNAL, "reply": REPLY, "self": CALL}[m["kind"]]
            if m["kind"] == "self":
                bid, y0, y1 = bar_at(m["a"], y)
                bx = self.cx[m["a"]] + BAR_W / 2
                y2 = y + 16
                w = text_w(m["text"])
                d.edge(bid, bid, m["text"], style, id=f"m{k + 1}",
                       exit=(1, (y - y0) / (y1 - y0)), entry=(1, (y2 - y0) / (y1 - y0)),
                       points=[(bx + LOOP, y), (bx + LOOP, y2)],
                       label_x=0, label_offset=(w / 2 + 6, 0))
                continue
            sa, a0, a1 = bar_at(m["a"], y)
            sb, b0, b1 = bar_at(m["b"], y)
            right = self.cx[m["b"]] > self.cx[m["a"]]
            d.edge(sa, sb, m["text"], style, id=f"m{k + 1}",
                   exit=(1 if right else 0, (y - a0) / (a1 - a0)),
                   entry=(0 if right else 1, (y - b0) / (b1 - b0)),
                   label_x=m["shift"], label_offset=(0, -10))
        return d


PAY = [("member", "member : Member"), ("app", "app : Web App"), ("api", "api : Arena3 API"),
       ("db", "db : Database"), ("gw", "gw : payOS")]


def register():
    s = Seq("15-sd-register", [("guest", "guest : Guest"), ("app", "app : Web App"),
                               ("api", "api : Arena3 API"), ("db", "db : Database"),
                               ("mail", "mail : Mail Delivery")])
    s.call("guest", "app", "enter the details and give consent")
    s.call("app", "api", "POST /v1/auth/register")
    s.self_call("api", "validate (BR-01, BR-02, BR-03, BR-04)")
    s.frame("alt", "[details invalid]", "guest", "mail")
    s.reply("api", "app", "error with the field to correct")
    s.reply("app", "guest", "show what to correct")
    s.sep("[details valid]")
    s.query("api", "db", "save the hashed code, valid 5 minutes")
    s.signal("api", "mail", "send the one-time code", keep=False)
    s.reply("api", "app", "202 Accepted")
    s.reply("app", "guest", "ask for the code")
    s.end()
    s.signal("mail", "guest", "email with the code", keep=False)
    s.call("guest", "app", "enter the code")
    s.call("app", "api", "POST /v1/auth/otp/verify")
    s.query("api", "db", "read the challenge and count the try")
    s.frame("alt", "[code correct]", "guest", "mail")
    s.query("api", "db", "create the member, drop the code, audit")
    s.reply("api", "app", "200 session token")
    s.reply("app", "guest", "open the member home page")
    s.sep("[code wrong, expired, or 5 tries used]")
    s.reply("api", "app", "error: wrong, expired or locked 15 min")
    s.reply("app", "guest", "show the error")
    s.end()
    return s.finish()


def book_and_pay():
    s = Seq("16-sd-book-and-pay", PAY)
    s.call("member", "app", "choose court, date and time slot")
    s.call("app", "api", "POST /v1/bookings")
    s.query("api", "db", "check the rules and conflicts, insert the hold")
    s.reply("api", "app", "201 held for 5 minutes")
    s.reply("app", "member", "show the payment options")
    s.call("member", "app", "choose payOS QR and press Pay")
    s.call("app", "api", "POST /v1/payments/online")
    s.query("api", "db", "insert the pending payment")
    s.call("api", "gw", "create the payment link (order code, amount, expiry)")
    s.reply("gw", "api", "checkout URL and VietQR code")
    s.reply("api", "app", "201 VietQR code and checkout link")
    s.reply("app", "member", "show the QR in the Scan to pay dialog")
    s.signal("member", "gw", "scan and pay with a banking app")
    s.frame("par", "[payOS confirms by webhook]", "member", "gw", pad_right=85)
    s.signal("gw", "api", "POST /v1/payments/online/webhook")
    s.self_call("api", "verify the signature and the amount")
    s.query("api", "db", "settle: post, confirm, invoice, notify")
    s.reply("api", "gw", "200 received")
    s.sep("[the dialog polls every 3 seconds]")
    s.call("app", "api", "POST /v1/payments/online/{id}/verify")
    s.query("api", "db", "read the payment")
    s.call("api", "gw", "read the link status (if not yet posted)")
    s.reply("gw", "api", "PAID")
    s.query("api", "db", "settle (skipped if already posted)")
    s.reply("api", "app", "status: posted")
    s.end()
    s.reply("app", "member", "show the confirmed booking and receipt")
    return s.finish()


def gate():
    s = Seq("17-sd-gate-checkin", [("member", "member : Member"), ("rec", "rec : Receptionist"),
                                   ("ui", "ui : Gate Page"), ("api", "api : Arena3 API"),
                                   ("db", "db : Database")])
    s.signal("member", "rec", "show the gate pass QR code")
    s.call("rec", "ui", "scan the QR code")
    s.call("ui", "api", "POST /v1/desk/scan (token)")
    s.self_call("api", "verify the signed token")
    s.frame("alt", "[code invalid or already used]", "rec", "db")
    s.reply("api", "ui", "error BR-30")
    s.reply("ui", "rec", "ask the member to refresh the code")
    s.sep("[code valid]")
    s.query("api", "db", "load today's plans, bookings and classes")
    s.frame("alt", "[member entitled]", "rec", "db", pad_left=80, pad_right=80)
    s.query("api", "db", "spend the code, record the visit, audit")
    s.reply("api", "ui", "allowed, check-in time, warnings")
    s.reply("ui", "rec", "show a green pass")
    s.sep("[not entitled]")
    s.reply("api", "ui", "needs an override, with the reasons")
    s.reply("ui", "rec", "show the reasons")
    s.call("rec", "ui", "choose an override reason")
    s.call("ui", "api", "POST /v1/desk/scan (override)")
    s.query("api", "db", "spend the code, record a flagged visit")
    s.reply("api", "ui", "allowed, flagged")
    s.reply("ui", "rec", "show an amber pass")
    s.end()
    s.end()
    s.signal("rec", "member", "let the member in", keep=False)
    return s.finish()


def refund():
    s = Seq("18-sd-refund", [("rec", "rec : Receptionist"), ("mgr", "mgr : Manager"),
                             ("ui", "ui : Payments Page"), ("api", "api : Arena3 API"),
                             ("db", "db : Database")])
    s.call("rec", "ui", "enter the refund amount and reason", shift=0.15)
    s.call("ui", "api", "POST /v1/payments/{id}/refund")
    s.query("api", "db", "lock the payment, total what is refundable")
    s.frame("alt", "[amount above what is refundable]", "rec", "db")
    s.reply("api", "ui", "error: refund too large")
    s.reply("ui", "rec", "show the error", shift=0.15)
    s.sep("[under 1,000,000 VND, or raised by a manager]")
    s.query("api", "db", "post the refund, restore the promo")
    s.reply("api", "ui", "201 refund posted")
    s.reply("ui", "rec", "show the refund receipt", shift=0.15)
    s.sep("[1,000,000 VND or more]")
    s.query("api", "db", "save the refund as pending approval")
    s.reply("api", "ui", "201 pending approval")
    s.reply("ui", "rec", "show the pending refund", shift=0.15)
    s.call("mgr", "ui", "approve the waiting refund")
    s.call("ui", "api", "POST /v1/payments/{id}/approve-refund")
    s.self_call("api", "check the approver did not raise it")
    s.query("api", "db", "post the refund, restore the promo, audit")
    s.signal("api", "db", "notify the member in the app", keep=False)
    s.reply("api", "ui", "200 posted")
    s.reply("ui", "mgr", "show the decision")
    s.end()
    return s.finish()


def enrol():
    s = Seq("36-sd-enrol-class", [("member", "member : Member"), ("app", "app : Web App"),
                                  ("api", "api : Arena3 API"), ("db", "db : Database")])
    s.call("member", "app", "choose a class and press Enrol")
    s.call("app", "api", "POST /v1/classes/{id}/enroll")
    s.query("api", "db", "read the class, the plan and clashing sessions")
    s.frame("alt", "[class not open, no plan, no sessions left, or clash]", "member", "db")
    s.reply("api", "app", "error BR-18, BR-19, BR-20 or BR-22")
    s.reply("app", "member", "show the reason")
    s.sep("[all checks pass]")
    s.query("api", "db", "confirm the seat (enrollment_confirm)")
    s.frame("alt", "[a seat is free]", "member", "db", pad_left=80, pad_right=80)
    s.query("api", "db", "use one plan session, save the enrolment")
    s.reply("api", "app", "201 enrolment confirmed")
    s.reply("app", "member", "show the class in my schedule")
    s.sep("[class is full (CLASS_FULL)]")
    s.query("api", "db", "queue the member on the waitlist")
    s.reply("api", "app", "201 waitlisted")
    s.reply("app", "member", "show the waitlist position")
    s.end()
    s.end()
    return s.finish()


def attendance():
    s = Seq("37-sd-take-attendance", [("coach", "coach : Coach"), ("ui", "ui : Attendance Page"),
                                      ("api", "api : Arena3 API"), ("db", "db : Database")])
    s.call("coach", "ui", "open the register of a session")
    s.call("ui", "api", "GET /v1/sessions/{id}/attendance")
    s.query("api", "db", "check the coach owns the class, read the roster")
    s.reply("api", "ui", "200 roster and lock time")
    s.reply("ui", "coach", "show the students to mark")
    s.call("coach", "ui", "mark present, late, absent or excused")
    s.call("ui", "api", "POST /v1/sessions/{id}/attendance")
    s.query("api", "db", "check each student is enrolled")
    s.frame("alt", "[register closed 2 hours after the session]", "coach", "db")
    s.reply("api", "ui", "error BR-35: ask a manager")
    s.reply("ui", "coach", "show that the register is closed")
    s.sep("[register open]")
    s.query("api", "db", "replace the marks, write the audit")
    s.query("api", "db", "count fresh absences and flag a streak (BR-36)")
    s.reply("api", "ui", "200 saved roster")
    s.reply("ui", "coach", "show the saved marks")
    s.end()
    return s.finish()


def build():
    return [register(), book_and_pay(), gate(), refund(), enrol(), attendance()]
