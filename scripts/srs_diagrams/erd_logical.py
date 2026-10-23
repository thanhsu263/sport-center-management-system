"""Logical ERD (crow's foot) generated from migrations/*.sql.

Every table of the schema appears in exactly one part (users, courts, occupancies and promotions are
repeated where a part needs them). A box lists the primary key and the foreign keys, as UML 2.0 / R7 do;
foreign keys whose parent is not in the same part stay in the box as `FK column -> table`.
The layout is searched once (simulated annealing, fixed seed) and cached in erd_logical_layout.json.
"""

import json
import math
import os
import random

from lib import Diagram, LINE, check
import dbschema

W = 250
GAPX = 110
GAPY = 56
MARGIN = 30
HEAD_H = 40
ROW_H = 16

BOX = ("verticalAlign=top;align=left;overflow=fill;fontSize=12;fontFamily=Helvetica;html=1;whiteSpace=wrap;"
       "fillColor=#f8fafc;strokeColor=#475569;spacingLeft=6;")
REL = "html=1;rounded=0;edgeStyle=none;strokeColor=" + LINE + ";strokeWidth=1.2;endSize=12;startSize=12;"

CACHE = os.path.join(os.path.dirname(__file__), "erd_logical_layout.json")

PARTS = [
    ("31-erd-logical-1-accounts", "Accounts and Platform", 3,
     ["users", "sessions_auth", "otp_challenges", "checkin_tokens", "coach_sports", "contact_log", "tickets",
      "outbox", "audit_logs", "center_settings", "feature_flags", "code_counters", "idempotency_keys",
      "provider_sequences"]),
    ("32-erd-logical-2-courts", "Courts and Bookings", 3,
     ["courts", "price_rules", "occupancies", "work_orders", "booking_series", "court_bookings",
      "equipment_items", "equipment_loans"]),
    ("33-erd-logical-3-payments", "Payments, Plans and Promotions", 3,
     ["cashier_shifts", "payments", "invoices", "invoice_lines", "promotions", "promotion_redemptions",
      "membership_plans", "subscriptions", "loyalty_adjustments"]),
    ("34-erd-logical-4-classes", "Classes, Attendance and Training", 3,
     ["classes", "sessions", "enrollments", "waitlist_offers", "attendance",
      "session_results", "training_plans", "training_plan_versions", "homework", "homework_recipients"]),
    ("35-erd-logical-5-coaching", "Coaching Records and Pay", 3,
     ["users", "progress_reviews", "training_profiles", "member_levels", "coach_notes", "coach_occupancies",
      "coach_rates", "coach_payouts"]),
]


def rows_of(tab):
    rows = []
    for c in tab["pk"]:
        if c in tab["fk"]:
            rows.append((c, f"PK, FK {c} → {tab['fk'][c]['ref']}"))
        else:
            rows.append((c, f"PK {c}"))
    for c, f in tab["fk"].items():
        if c not in tab["pk"]:
            rows.append((c, f"FK {c} → {f['ref']}"))
    return rows


HUB_MIN = {"users": 150}


def box_height(tab, name=None):
    return max(HEAD_H + ROW_H * len(rows_of(tab)), HUB_MIN.get(name, 0))


def edges_of(schema, names):
    out = []
    for t in names:
        for col, f in schema[t]["fk"].items():
            if f["ref"] in names and f["ref"] != t:
                out.append(dict(child=t, parent=f["ref"], col=col, null=f["null"], opt=f["ref"] == "users"))
    return out


# ---------- layout search ----------

def place(cols, schema, ncols):
    pos = {}
    height = 0
    for c, stack in enumerate(cols):
        y = MARGIN
        for t in stack:
            h = box_height(schema[t], t)
            pos[t] = (MARGIN + c * (W + GAPX), y, W, h)
            y += h + GAPY
        height = max(height, y)
    return pos, height


def anchors(pos, schema, e):
    cx, cy, cw, ch = pos[e["child"]]
    px, py, pw, ph = pos[e["parent"]]
    crow = [r[0] for r in rows_of(schema[e["child"]])].index(e["col"])
    cy_row = cy + HEAD_H - 4 + ROW_H * crow + ROW_H / 2
    prow_y = py + HEAD_H - 4 + ROW_H / 2
    if cx == px:  # same column: stack neighbours join top to bottom
        if cy < py:
            return (cx + cw / 2, cy + ch), (px + pw / 2, py), ("b", "t")
        return (cx + cw / 2, cy), (px + pw / 2, py + ph), ("t", "b")
    if cx < px:
        return (cx + cw, cy_row), (px, prow_y), ("r", "l")
    return (cx, cy_row), (px + pw, prow_y), ("l", "r")


def seg_rect(p, q, r):
    """True when the segment p-q passes through the inside of rectangle r."""
    x0, y0, w, h = r
    x0 += 2
    y0 += 2
    w -= 4
    h -= 4
    t0, t1 = 0.0, 1.0
    dx, dy = q[0] - p[0], q[1] - p[1]
    for pp, qq in ((-dx, p[0] - x0), (dx, x0 + w - p[0]), (-dy, p[1] - y0), (dy, y0 + h - p[1])):
        if pp == 0:
            if qq < 0:
                return False
        else:
            t = qq / pp
            if pp < 0:
                t0 = max(t0, t)
            else:
                t1 = min(t1, t)
            if t0 > t1:
                return False
    return True


def cross(p1, p2, p3, p4):
    def o(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    return o(p3, p4, p1) * o(p3, p4, p2) < -1e-6 and o(p1, p2, p3) * o(p1, p2, p4) < -1e-6


def cost(cols, schema, edges, ncols):
    pos, height = place(cols, schema, ncols)
    segs = []
    c = 0.0
    for e in edges:
        a, b, _ = anchors(pos, schema, e)
        segs.append((a, b, e))
        w = 300 if e["opt"] else 1000
        for t, r in pos.items():
            if t in (e["child"], e["parent"]):
                continue
            if seg_rect(a, b, r):
                c += w
        c += math.hypot(b[0] - a[0], b[1] - a[1]) * 0.05 + abs(b[1] - a[1]) * 0.3
    for i, (a, b, e) in enumerate(segs):
        for a2, b2, e2 in segs[i + 1:]:
            if cross(a, b, a2, b2):
                c += 300 if (e["opt"] or e2["opt"]) else 1000
    return c + height * 0.05


def search(schema, names, edges, ncols, seed=7, iters=12000):
    rnd = random.Random(seed)
    cols = [[] for _ in range(ncols)]
    for i, t in enumerate(names):
        cols[i % ncols].append(t)
    cur = cost(cols, schema, edges, ncols)
    best, best_cols = cur, [list(c) for c in cols]
    temp = 200.0
    for it in range(iters):
        temp = 200.0 * (1 - it / iters) + 1
        new = [list(c) for c in cols]
        if rnd.random() < 0.5:
            t = rnd.choice(names)
            for c in new:
                if t in c:
                    c.remove(t)
            c = rnd.randrange(ncols)
            new[c].insert(rnd.randint(0, len(new[c])), t)
        else:
            a, b = rnd.sample(names, 2)
            ia = next((i, c.index(a)) for i, c in enumerate(new) if a in c)
            ib = next((i, c.index(b)) for i, c in enumerate(new) if b in c)
            new[ia[0]][ia[1]], new[ib[0]][ib[1]] = b, a
        nc = cost(new, schema, edges, ncols)
        if nc < cur or rnd.random() < math.exp((cur - nc) / temp):
            cols, cur = new, nc
            if cur < best:
                best, best_cols = cur, [list(c) for c in cols]
    return best_cols, best


def load_cache():
    try:
        return json.load(open(CACHE, encoding="utf-8"))
    except (OSError, ValueError):
        return {}


# ---------- drawing ----------

ENDS = {  # (nullable child side?, nullable parent side?) -> arrows
    "child_many_opt": "ERzeroToMany",
    "child_many_req": "ERoneToMany",
    "parent_one_opt": "ERzeroToOne",
    "parent_one_req": "ERmandOne",
}


def draw(name, title, ncols, names, schema, cols, drop=()):
    pos, height = place(cols, schema, ncols)
    width = MARGIN * 2 + ncols * W + (ncols - 1) * GAPX
    d = Diagram(name, w=width, h=int(height + MARGIN))
    for t in names:
        x, y, w, h = pos[t]
        t_label = t
        body = ('<div style="padding:2px 10px 0 10px"><b>' + t_label + "</b></div><hr>"
                + '<div style="padding:0 10px">' + "<br>".join(txt for _, txt in rows_of(schema[t])) + "</div>")
        d.vertex(body, BOX, x, y, w, h, id=t)
    edges = [e for e in edges_of(schema, names) if (e["child"], e["col"]) not in drop]
    seen = set()
    fan = {}
    for e in edges:
        if pos[e["child"]][0] != pos[e["parent"]][0]:
            side = "r" if pos[e["child"]][0] > pos[e["parent"]][0] else "l"
            fan.setdefault((e["parent"], side), []).append(e)
    for n, e in enumerate(edges):
        a, b, sides = anchors(pos, schema, e)
        side = "r" if pos[e["child"]][0] > pos[e["parent"]][0] else "l"
        group = fan.get((e["parent"], side), [])
        if len(group) > 1 and pos[e["child"]][0] != pos[e["parent"]][0]:
            # order by the child's height so the fanned lines do not cross
            group = sorted(group, key=lambda g: pos[g["child"]][1])
            k = group.index(e)
            py_, ph_ = pos[e["parent"]][1], pos[e["parent"]][3]
            b = (b[0], py_ + 22 + (ph_ - 34) * (k + 0.5) / len(group))
        if pos[e["child"]][0] == pos[e["parent"]][0]:
            if (e["child"], e["parent"]) in seen:
                continue
            seen.add((e["child"], e["parent"]))
        cx, cy, cw, ch = pos[e["child"]]
        px, py, pw, ph = pos[e["parent"]]
        exit = ((a[0] - cx) / cw, (a[1] - cy) / ch)
        entry = ((b[0] - px) / pw, (b[1] - py) / ph)
        start = ENDS["child_many_opt" if e["null"] else "child_many_req"]
        end = ENDS["parent_one_opt" if e["null"] else "parent_one_req"]
        style = REL + f"startArrow={start};endArrow={end};startFill=0;endFill=0;"
        d.edge(e["child"], e["parent"], "", style, exit=exit, entry=entry, id=f"fk{n}_{e['child']}_{e['col']}")
    return d


def build():
    schema = dbschema.load()
    cache = load_cache()
    out = []
    changed = False
    for name, title, ncols, names in PARTS:
        edges = edges_of(schema, names)
        for seed in range(7, 40):
            if name not in cache:
                cache[name], _ = search(schema, names, edges, ncols, seed=seed)
                changed = True
            cols = cache[name]
            # drop optional edges that still break the drawing rules, one at a time
            drop = []
            for _ in range(len(edges)):
                d = draw(name, title, ncols, names, schema, cols, drop)
                bad = check(d)
                if not bad:
                    break
                culprit = None
                for msg in bad:
                    for e in edges:
                        if (e["child"], e["col"]) not in drop and e["opt"] and f"_{e['child']}_{e['col']}" in msg:
                            culprit = (e["child"], e["col"])
                            break
                    if culprit:
                        break
                if not culprit:
                    break
                drop.append(culprit)
            if not bad:
                break
            del cache[name]
        d.erd_dropped = drop
        out.append(d)
    if changed:
        json.dump(cache, open(CACHE, "w", encoding="utf-8"), indent=1)
    return out
