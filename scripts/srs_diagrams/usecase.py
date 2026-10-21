"""Use case diagrams: one primary actor column, one system boundary, goal-phrase ovals.

UML 2.0 rules applied (Learning UML 2.0, ch. 2): actors stand outside the boundary,
associations have no arrowheads, <<include>> points from the base to the included
case, <<extend>> points from the extension to the base, and system actors carry
the <<actor>> keyword.
"""

from lib import Diagram, LINE, INK

ACTOR = ("shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;"
         "fillColor=#ffffff;strokeColor=#1e293b;strokeWidth=1.5;fontFamily=Helvetica;fontSize=13;"
         "fontStyle=1;fontColor=#1e293b;")
SYS_ACTOR = ("rounded=0;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#1e293b;strokeWidth=1.5;"
             "fontFamily=Helvetica;fontSize=12;fontColor=#1e293b;")
CASE = ("ellipse;whiteSpace=wrap;html=1;fillColor=#eef2ff;strokeColor=#334155;strokeWidth=1.2;"
        "fontFamily=Helvetica;fontSize=12;fontColor=#1e293b;")
CASE2 = ("ellipse;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#334155;strokeWidth=1.2;"
         "fontFamily=Helvetica;fontSize=12;fontColor=#1e293b;")
BOUNDARY = ("rounded=0;whiteSpace=wrap;html=1;fillColor=none;strokeColor=#1e293b;strokeWidth=1.5;"
            "verticalAlign=top;align=center;spacingTop=8;fontFamily=Helvetica;fontSize=14;fontStyle=1;"
            "fontColor=#1e293b;")
ASSOC = "endArrow=none;html=1;rounded=0;edgeStyle=none;strokeColor=" + LINE + ";strokeWidth=1.2;"
DEP = ("endArrow=open;endSize=10;dashed=1;html=1;rounded=0;edgeStyle=none;strokeColor=" + LINE + ";"
       "strokeWidth=1.2;fontFamily=Helvetica;fontSize=11;fontColor=" + INK + ";labelBackgroundColor=#ffffff;")
GEN = ("endArrow=block;endFill=0;endSize=14;html=1;rounded=0;edgeStyle=none;strokeColor=" + LINE + ";"
       "strokeWidth=1.2;")

SYSTEM = "Arena3 Sports Centre Management System"

C1X, C2X, CW, CH, PITCH, TOP = 330, 790, 260, 54, 70, 130


def row_y(r):
    return TOP + r * PITCH


def build_uc(name, left, rows, col2=(), right=(), boundary_title=SYSTEM):
    """left: [(id, label, [rows])]; rows: [label]; col2: [(id, label, row, [(kind, row)])];
    right: [(id, label, row, [targets])] where a target is a col2 id or an int col1 row."""
    d = Diagram(name)
    n = len(rows)
    has_c2 = bool(col2)
    bx = C1X - 50
    bright = (C2X + CW + 50) if has_c2 else (C1X + CW + 50)
    by = TOP - 80
    bh = (n - 1) * PITCH + CH + 120
    d.vertex(boundary_title, BOUNDARY, bx, by, bright - bx, bh, id="boundary", role="container")

    c1 = []
    for r, label in enumerate(rows):
        c1.append(d.vertex(label, CASE, C1X, row_y(r), CW, CH, id=f"uc{r}", shape="ellipse"))

    c2 = {}
    for cid, label, r, rels in col2:
        c2[cid] = d.vertex(label, CASE2, C2X, row_y(r), CW, CH, id=cid, shape="ellipse")
        for kind, base in rels:
            if kind == "include":
                d.edge(c1[base], c2[cid], "&laquo;include&raquo;", DEP, exit=(1, 0.5), entry=(0, 0.5),
                       label_x=-0.1, id=f"inc_{base}_{cid}")
            else:
                d.edge(c2[cid], c1[base], "&laquo;extend&raquo;", DEP, exit=(0, 0.5), entry=(1, 0.5),
                       label_x=0.1, id=f"ext_{cid}_{base}")

    for aid, label, arows in left:
        mid = sum(row_y(r) + CH / 2 for r in arows) / len(arows)
        ax, aw, ah = 80, 46, 90
        ay = mid - ah / 2 - 8
        d.vertex(label, ACTOR, ax, ay, aw, ah, id=aid, role="actor")
        lw = len(label) * 8 + 10
        d.keepout(ax + aw / 2 - lw / 2, ay + ah + 2, lw, 20, aid + " caption")
        for r in arows:
            d.edge(aid, c1[r], "", ASSOC, exit=(1, 0.45), entry=(0, 0.5), id=f"a_{aid}_{r}")

    rx = bright + 90
    for aid, label, r, targets in right:
        w, h = 170, 58
        y = row_y(r) + CH / 2 - h / 2
        d.vertex("&laquo;actor&raquo;<br><b>" + label + "</b>", SYS_ACTOR, rx, y, w, h, id=aid)
        for t in targets:
            src = c1[t] if isinstance(t, int) else c2[t]
            d.edge(src, aid, "", ASSOC, exit=(1, 0.5), entry=(0, 0.5), id=f"s_{aid}_{t}")
    return d


def actor_hierarchy():
    d = Diagram("02-actors", w=1160, h=560)
    W, H = 46, 90
    frame = ("swimlane;startSize=36;horizontal=1;html=1;whiteSpace=wrap;fillColor=#e2e8f0;"
             "swimlaneFillColor=#ffffff;strokeColor=#334155;strokeWidth=1.5;fontFamily=Helvetica;"
             "fontSize=14;fontStyle=1;fontColor=#1e293b;")
    side_actor = ACTOR.replace("verticalLabelPosition=bottom;verticalAlign=top;",
                               "labelPosition=right;verticalLabelPosition=middle;align=left;"
                               "verticalAlign=middle;spacingLeft=6;")
    gx, gy = 40, 40
    d.vertex("Human actors", frame, gx, gy, 700, 460, id="humans", role="container")
    d.vertex("External systems (secondary actors)", frame, 780, gy, 340, 460, id="externals", role="container")

    def note(title, text):
        return title + "<br><font style=\"font-size:11px;font-weight:normal\">" + text + "</font>"

    # Guest and Registered User share the top row; the four roles specialise Registered User
    d.vertex(note("Guest", "Browses and registers"), ACTOR, 60, 90, W, H, id="guest", parent="humans", role="actor")
    d.keepout(gx + 60 + W / 2 - 80, gy + 90 + H + 2, 160, 34, "guest caption")
    ru_x = 310
    d.vertex(note("Registered User", "Signed in, holds one of four roles"), side_actor, ru_x, 90, W, H,
             id="ru", parent="humans", role="actor")
    d.keepout(gx + ru_x + W + 2, gy + 90 + H / 2 - 20, 230, 40, "ru caption")
    subs = [("Member", "Books, pays and trains", 70), ("Receptionist", "Runs the front desk", 230),
            ("Coach", "Teaches classes", 390), ("Manager", "Sets up and oversees", 550)]
    bus_y = gy + 260
    for i, (label, text, x) in enumerate(subs):
        aid = f"sub{i}"
        d.vertex(note(label, text), ACTOR, x, 290, W, H, id=aid, parent="humans", role="actor")
        d.keepout(gx + x + W / 2 - 80, gy + 290 + H + 2, 160, 34, aid + " caption")
        d.edge(aid, "ru", "", GEN, exit=(0.5, 0), entry=(0.5, 1),
               points=[(gx + x + W / 2, bus_y), (gx + ru_x + W / 2, bus_y)])
    systems = [("payOS", "Payment gateway: payment links and paid-status webhooks"),
               ("Mail delivery (SMTP)", "Sends one-time codes, reminders and notices"),
               ("Gemini AI", "Answers member questions and drafts training plans")]
    for i, (label, text) in enumerate(systems):
        d.vertex("&laquo;actor&raquo;<br><b>" + label + "</b><br><font style=\"font-size:11px\">" + text + "</font>",
                 SYS_ACTOR, 20, 62 + i * 130, 300, 100, id=f"sys{i}", parent="externals")
    return d


def numbered(first, labels):
    return list(labels)


def build():
    out = []

    out.append(build_uc(
        "03-uc-account",
        left=[("guest", "Guest", [0, 1]), ("ru", "Registered User", [2, 3, 4, 5])],
        rows=numbered(1, ["Browse courts, classes and prices", "Register a member account",
                          "Sign in and sign out", "Reset a forgotten password",
                          "Manage the personal profile", "View notifications"]),
        right=[("mail", "Mail delivery (SMTP)", 2, [1, 3])],
    ))

    out.append(build_uc(
        "04-uc-member-booking",
        left=[("member", "Member", list(range(6)))],
        rows=numbered(7, ["View my schedule", "Book a court and pay", "Reschedule or cancel a booking",
                          "Order a membership plan", "View receipts and redeem points",
                          "Check in by self-service"]),
        right=[("gw", "payOS", 2, [1, 3])],
    ))

    out.append(build_uc(
        "05-uc-member-classes",
        left=[("member", "Member", list(range(5)))],
        rows=numbered(13, ["Enrol in a class", "Accept a waitlist offer", "Leave a class",
                           "Follow my training progress", "Get help from the AI assistant or staff"]),
        right=[("gemini", "Gemini AI", 4, [4])],
    ))

    out.append(build_uc(
        "06-uc-desk-sales",
        left=[("rec", "Receptionist", list(range(6)))],
        rows=numbered(18, ["Open and close a cashier shift", "Manage a member record at the desk",
                           "Manage a member plan at the desk", "Book a court at the desk",
                           "Settle pending payments", "Raise a refund"]),
    ))

    out.append(build_uc(
        "07-uc-desk-operations",
        left=[("rec", "Receptionist", list(range(5)))],
        rows=numbered(25, ["Check in a court booking", "Check a member in at the gate",
                           "Rent out gear and record its return", "Handle maintenance work orders",
                           "Reply to a support request"]),
    ))

    out.append(build_uc(
        "08-uc-coach",
        left=[("coach", "Coach", list(range(6)))],
        rows=numbered(30, ["View the teaching schedule and rosters", "Take session attendance",
                           "Plan a training session", "Record session results and homework",
                           "Assess a student's progress", "View monthly earnings"]),
        right=[("gemini", "Gemini AI", 2, [2])],
    ))

    out.append(build_uc(
        "09-uc-manager-setup",
        left=[("mgr", "Manager", list(range(5)))],
        rows=numbered(36, ["Manage user accounts", "Manage membership plans and prices",
                           "Manage promo codes", "Schedule classes and sessions", "Configure the centre"]),
    ))

    out.append(build_uc(
        "10-uc-manager-oversight",
        left=[("mgr", "Manager", list(range(5)))],
        rows=numbered(41, ["View reports and export data", "Approve or reject a refund",
                           "Close and pay coach commission", "Review the audit log"])
             + ["Handle maintenance work orders"],
    ))
    return out
