"""Screen flows in the FPT template's 3.1.1 style: one tree per portal, left to right from sign-in."""

from lib import Diagram, FONT, LINE

BW, BH = 190, 44
GAP = 56
PITCH = 58
LEFT, TOP = 20, 20

BASE = "whiteSpace=wrap;html=1;" + FONT
STYLE = {
    "entry": "rounded=1;arcSize=18;fillColor=#1e293b;strokeColor=#1e293b;strokeWidth=1.5;" + BASE + "fontColor=#ffffff;",
    "screen": "rounded=0;fillColor=#f8fafc;strokeColor=#334155;strokeWidth=1.3;" + BASE,
    "dialog": "rounded=1;arcSize=14;dashed=1;dashPattern=6 3;fillColor=#ffffff;strokeColor=#475569;strokeWidth=1.2;" + BASE,
    "portal": "rounded=0;fillColor=#e2e8f0;strokeColor=#334155;strokeWidth=2.2;" + BASE,
}
SUB = {"entry": "#cbd5e1", "screen": "#64748b", "dialog": "#64748b", "portal": "#475569"}
KEY = {"entry": ("Entry point", "route"), "screen": ("Screen", "route"),
       "dialog": ("Dialog or in-page step", "opens over its screen"), "portal": ("Portal home", "drawn in its own flow")}
ARROW = "html=1;rounded=0;edgeStyle=none;endArrow=block;endFill=1;endSize=6;strokeColor=" + LINE + ";strokeWidth=1.2;"
KEY_TEXT = "text;html=1;align=left;verticalAlign=middle;" + FONT + "fontStyle=1;"


def node(kind, name, sub, kids):
    return dict(kind=kind, name=name, sub=sub, kids=list(kids))


def E(name, sub, *kids):
    return node("entry", name, sub, kids)


def S(name, sub, *kids):
    return node("screen", name, sub, kids)


def D(name, sub="dialog", *kids):
    return node("dialog", name, sub, kids)


def P(name, sub, *kids):
    return node("portal", name, sub, kids)


def label(n):
    out = f"<b>{n['name']}</b>"
    if n["sub"]:
        out += f'<br><font style="font-size:11px" color="{SUB[n["kind"]]}">{n["sub"]}</font>'
    return out


def flow(name, tree):
    rows = []

    def place(n, depth):
        n["depth"] = depth
        if n["kids"]:
            for k in n["kids"]:
                place(k, depth + 1)
            n["cy"] = (n["kids"][0]["cy"] + n["kids"][-1]["cy"]) / 2
        else:
            n["cy"] = TOP + BH / 2 + len(rows) * PITCH
            rows.append(n)

    place(tree, 0)
    bottom = TOP + len(rows) * PITCH
    d = Diagram(name, h=max(1100, bottom + 120))
    kinds = []

    def draw(n):
        x = LEFT + n["depth"] * (BW + GAP)
        n["id"] = d.vertex(label(n), STYLE[n["kind"]], x, n["cy"] - BH / 2, BW, BH, id=f"n{len(d.cells)}")
        if n["kind"] not in kinds:
            kinds.append(n["kind"])
        bus = x + BW + GAP / 2
        for k in n["kids"]:
            draw(k)
            pts = [] if k["cy"] == n["cy"] else [(bus, n["cy"]), (bus, k["cy"])]
            d.edge(n["id"], k["id"], style=ARROW, points=pts, exit=(1, 0.5), entry=(0, 0.5),
                   id=f"a{len(d.cells)}")

    draw(tree)

    y = bottom + 30
    d.vertex("Key", KEY_TEXT, LEFT, y + 7, 40, 30, id="key")
    x = LEFT + 50
    for kind in ("entry", "screen", "dialog", "portal"):
        if kind not in kinds:
            continue
        title, sub = KEY[kind]
        d.vertex(label(dict(kind=kind, name=title, sub=sub)), STYLE[kind], x, y, BW, BH, id=f"key_{kind}")
        x += BW + 20
    return d


PUBLIC = E("Landing page", "/",
           E("Sign in", "/login",
             S("Forgot password", "/forgot", D("Verify reset code", "in-page step")),
             P("Member portal", "/app · My schedule"),
             P("Receptionist portal", "/desk · Front desk"),
             P("Coach portal", "/coach · Schedule"),
             P("Manager portal", "/manager · Reports")),
           S("Create an account", "/register", D("Verify the emailed code", "in-page step")),
           D("Coach profile", "dialog"))

MEMBER = E("Sign in", "/login",
           S("My schedule", "/app",
             S("Book a court", "/app/book",
               D("Slot hold", "in-page step · 5 minutes",
                 D("Scan to pay", "dialog · payOS",
                   S("Payment result", "/pay/return")))),
             D("Claim waitlist seat", "in-page step"),
             S("Classes", "/app/classes"),
             S("My progress", "/app/train"),
             S("Membership plans", "/app/plans"),
             S("My points", "/app/points"),
             S("Gate pass", "/app/pass"),
             S("AI assistant", "/app/assistant"),
             S("Notifications", "/app/notifications"),
             S("Account settings", "/account")))

RECEPTION = E("Sign in", "/login",
              S("Front desk", "/desk",
                S("Member profile", "/desk/member/$id",
                  D("Edit profile"),
                  D("Raise a refund"),
                  D("Reset password", "dialog", D("Hand this over now")),
                  D("Scan to pay", "dialog · payOS")),
                D("Close shift"),
                S("Gate", "/desk/gate"),
                S("Court map", "/desk/courts", D("Walk-in payment", "in-page step")),
                S("Classes", "/desk/classes"),
                S("Payments", "/desk/payments",
                  D("Scan to pay", "dialog · payOS"),
                  D("Bank transfer QR")),
                S("Fixed bookings", "/desk/series", D("Stop this fixed booking?")),
                S("At risk", "/desk/at-risk"),
                S("Gear", "/desk/gear"),
                S("Maintenance", "/desk/maintenance"),
                S("Alerts", "/alerts")))

COACH = E("Sign in", "/login",
          S("Schedule", "/coach",
            S("Attendance", "/coach/attendance",
              S("Student progress", "/coach/student/$id")),
            S("Classes", "/coach/classes"),
            S("My earnings", "/coach/earnings"),
            S("Profile", "/account")))

MANAGER = E("Sign in", "/login",
            S("Reports", "/manager",
              S("Classes", "/manager/classes"),
              S("Members", "/manager/members", S("Member profile", "/desk/member/$id")),
              S("Membership plans", "/manager/plans",
                D("New membership plan"),
                D("Plan details")),
              S("Promo codes", "/manager/promos",
                D("New promo code"),
                D("Code history")),
              S("Attendance", "/manager/attendance"),
              S("Refund sign-off", "/desk/payments"),
              S("Staff", "/manager/staff",
                D("Add staff", "dialog", D("Hand this over now")),
                D("Role and access")),
              S("Pricing", "/manager/prices"),
              S("Fixed bookings", "/desk/series"),
              S("Coach commission", "/manager/commission"),
              S("E-invoice export", "/manager/invoices"),
              S("Maintenance", "/desk/maintenance"),
              S("Audit log", "/manager/audit"),
              S("Centre settings", "/manager/settings")))


def build():
    return [
        flow("24-sf-public", PUBLIC),
        flow("25-sf-member", MEMBER),
        flow("26-sf-receptionist", RECEPTION),
        flow("27-sf-coach", COACH),
        flow("28-sf-manager", MANAGER),
    ]
