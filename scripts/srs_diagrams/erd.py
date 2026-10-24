"""Conceptual ERD in the FPT template's Chen style: entities, verb diamonds, 1/N/M cardinality."""

from lib import Diagram, FONT, LINE

ENTITY = ("rounded=0;whiteSpace=wrap;html=1;fillColor=#f1f5f9;strokeColor=#334155;strokeWidth=1.5;"
          + FONT + "fontStyle=1;")
REL = ("rhombus;whiteSpace=wrap;html=1;fillColor=#ffffff;strokeColor=#334155;strokeWidth=1.2;" + FONT)
CARD = "text;html=1;align=center;verticalAlign=middle;" + FONT + "fontStyle=1;"
JOIN = "html=1;rounded=0;edgeStyle=none;endArrow=none;strokeColor=" + LINE + ";strokeWidth=1.2;"

EW, EH = 130, 44
RW, RH = 100, 56

# id: (label, centre x, centre y, width)
ENTITIES = {
    "invoice": ("Invoice", 380, 60, EW),
    "promo": ("Promotion", 590, 60, EW),
    "item": ("EquipmentItem", 820, 60, EW),
    "rule": ("PriceRule", 1350, 60, EW),
    "shiftc": ("CashierShift", 90, 290, EW),
    "pay": ("Payment", 420, 290, 150),
    "booking": ("CourtBooking", 820, 290, EW),
    "court": ("Court", 1350, 290, EW),
    "wo": ("WorkOrder", 1505, 425, EW),
    "review": ("ProgressReview", 1200, 430, EW),
    "plan": ("MembershipPlan", 90, 560, EW),
    "sub": ("Subscription", 420, 560, EW),
    "user": ("User", 800, 560, 240),
    "att": ("Attendance", 1200, 575, EW),
    "tplan": ("TrainingPlan", 390, 810, EW),
    "tclass": ("TrainingClass", 780, 810, 220),
    "csession": ("ClassSession", 1200, 810, EW),
}

# id: (verb, centre x, centre y)
RELATIONS = {
    "r_bills": ("bills", 380, 170),
    "r_disc": ("discounts", 590, 170),
    "r_rents": ("rents", 820, 170),
    "r_prices": ("prices", 1350, 170),
    "r_collects": ("collects", 245, 290),
    "r_settle_b": ("settles", 620, 290),
    "r_hosts_b": ("hosts", 1085, 290),
    "r_needs": ("needs", 1505, 290),
    "r_settle_s": ("settles", 390, 425),
    "r_pays": ("pays", 610, 425),
    "r_makes": ("makes", 860, 425),
    "r_reviews": ("receives", 1030, 430),
    "r_defines": ("defines", 245, 560),
    "r_holds": ("holds", 600, 560),
    "r_logs": ("logs", 1030, 575),
    "r_hosts_s": ("hosts", 1350, 560),
    "r_records": ("records", 1200, 690),
    "r_teaches": ("teaches", 720, 690),
    "r_enrols": ("enrols in", 840, 690),
    "r_follows": ("follows", 560, 810),
    "r_has": ("has", 1012, 810),
}

TIP = {"l": (0, 0.5), "r": (1, 0.5), "t": (0.5, 0), "b": (0.5, 1)}

# entity, relationship, cardinality on the entity side, point where the line leaves the entity,
# diamond tip it enters, bends, and which side of the line the cardinality sits on
JOINS = [
    ("invoice", "r_bills", "1", (380, 82), "t", (), False),
    ("pay", "r_bills", "1", (380, 268), "b", (), False),
    ("promo", "r_disc", "1", (590, 82), "t", (), False),
    ("pay", "r_disc", "N", (470, 268), "l", ((470, 170),), False),
    ("item", "r_rents", "N", (820, 82), "t", (), False),
    ("booking", "r_rents", "M", (820, 268), "b", (), False),
    ("rule", "r_prices", "N", (1350, 82), "t", (), False),
    ("court", "r_prices", "1", (1350, 268), "b", (), False),
    ("shiftc", "r_collects", "1", (155, 290), "l", (), False),
    ("pay", "r_collects", "N", (345, 290), "r", (), False),
    ("pay", "r_settle_b", "N", (495, 290), "l", (), False),
    ("booking", "r_settle_b", "1", (755, 290), "r", (), False),
    ("booking", "r_hosts_b", "N", (885, 290), "l", (), False),
    ("court", "r_hosts_b", "1", (1285, 290), "r", (), False),
    ("court", "r_needs", "1", (1415, 290), "l", (), False),
    ("wo", "r_needs", "N", (1505, 403), "b", (), True),
    ("pay", "r_settle_s", "N", (390, 312), "t", (), True),
    ("sub", "r_settle_s", "1", (390, 538), "b", (), True),
    ("pay", "r_pays", "N", (480, 312), "l", ((480, 425),), False),
    ("user", "r_pays", "1", (710, 535), "r", ((710, 425),), True),
    ("booking", "r_makes", "N", (860, 312), "t", (), False),
    ("user", "r_makes", "1", (860, 535), "b", (), False),
    ("user", "r_reviews", "1", (920, 545), "l", ((950, 545), (950, 430)), False),
    ("review", "r_reviews", "N", (1135, 430), "r", (), False),
    ("plan", "r_defines", "1", (155, 560), "l", (), False),
    ("sub", "r_defines", "N", (355, 560), "r", (), False),
    ("sub", "r_holds", "N", (485, 560), "l", (), False),
    ("user", "r_holds", "1", (680, 560), "r", (), False),
    ("user", "r_logs", "1", (920, 575), "l", (), True),
    ("att", "r_logs", "N", (1135, 575), "r", (), True),
    ("court", "r_hosts_s", "1", (1350, 312), "t", (), False),
    ("csession", "r_hosts_s", "N", (1265, 810), "b", ((1350, 810),), False),
    ("att", "r_records", "N", (1200, 597), "t", (), False),
    ("csession", "r_records", "1", (1200, 788), "b", (), False),
    ("user", "r_teaches", "1", (720, 585), "t", (), True),
    ("tclass", "r_teaches", "N", (720, 788), "b", (), True),
    ("user", "r_enrols", "M", (840, 585), "t", (), False),
    ("tclass", "r_enrols", "N", (840, 788), "b", (), False),
    ("tplan", "r_follows", "N", (455, 810), "l", (), False),
    ("tclass", "r_follows", "1", (670, 810), "r", (), False),
    ("tclass", "r_has", "1", (890, 810), "l", (), False),
    ("csession", "r_has", "N", (1135, 810), "r", (), False),
]


def build():
    d = Diagram("19-erd-conceptual")
    for eid, (name, cx, cy, w) in ENTITIES.items():
        d.vertex(name, ENTITY, cx - w / 2, cy - EH / 2, w, EH, id=eid)
    for rid, (verb, cx, cy) in RELATIONS.items():
        d.vertex(verb, REL, cx - RW / 2, cy - RH / 2, RW, RH, id=rid, shape="rhombus")

    for n, (eid, rid, card, start, tip, bends, flip) in enumerate(JOINS):
        ex, ey, ew, eh = d.abs_of(eid)
        exit = ((start[0] - ex) / ew, (start[1] - ey) / eh)
        d.edge(eid, rid, style=JOIN, points=bends, exit=exit, entry=TIP[tip], id=f"j{n}")
        nxt = bends[0] if bends else d._anchor(rid, TIP[tip])
        dx, dy = nxt[0] - start[0], nxt[1] - start[1]
        if abs(dy) > abs(dx):
            x = start[0] - 21 if flip else start[0] + 5
            y = start[1] + 3 if dy > 0 else start[1] - 19
        else:
            x = start[0] + 4 if dx > 0 else start[0] - 20
            y = start[1] + 3 if flip else start[1] - 19
        d.vertex(card, CARD, x, y, 16, 16, id=f"c{n}", role="label")
    return d
