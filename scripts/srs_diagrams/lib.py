"""Draw.io builder, rule checker and PNG export for the Arena 3 SRS figures.

Rules come from CLAUDE.md and .grok/skills/uml2-oreilly: plain mxGraphModel
root, no XML comments, geometry on every cell, vertex="1" / edge="1", unique
ids, real edge ends, and no shape, label or line sitting on another shape.
"""

import html
import math
import os
import re
import subprocess
import xml.etree.ElementTree as ET

DRAWIO = r"C:\Program Files\draw.io\draw.io.exe"
INK = "#1e293b"
LINE = "#334155"
MUTED = "#64748b"
FILL = "#ffffff"
SOFT = "#f8fafc"
HEAD = "#e2e8f0"
FONT = "fontFamily=Helvetica;fontSize=12;fontColor=#1e293b;"

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(ROOT, "docs", "diagrams", "srs")

SEE_THROUGH = ("lifeline", "frame")
# draw.io keeps cells in a plain JS object, so an id that names an Array/Object method breaks export
RESERVED_IDS = {"shift", "pop", "push", "map", "filter", "sort", "join", "concat", "reverse", "slice",
                "splice", "indexOf", "length", "constructor", "toString", "valueOf", "hasOwnProperty",
                "find", "fill", "keys", "values", "entries", "forEach", "some", "every", "reduce", "includes"}

CHAR_W = 6.6  # mean Helvetica 12px glyph width, a little generous
LINE_H = 15


def esc(s):
    return html.escape(str(s), quote=True)


def text_lines(text, width, size=12):
    """Rough line count for wrapped text in a box `width` wide."""
    cw = CHAR_W * size / 12
    plain = re.sub(r"<br\s*/?>", "\n", text)
    plain = re.sub(r"<hr\s*/?>", "\n", plain)
    plain = re.sub(r"<[^>]+>", "", plain)
    plain = html.unescape(plain)
    n = 0
    for para in plain.split("\n"):
        words = para.split(" ")
        cur = 0
        lines = 1
        for w in words:
            ww = len(w) * cw
            if cur == 0:
                cur = ww
            elif cur + cw + ww <= width:
                cur += cw + ww
            else:
                lines += 1
                cur = ww
        n += lines
    return n


class Diagram:
    def __init__(self, name, w=1600, h=1100):
        self.name = name
        self.w = w
        self.h = h
        self.cells = []
        self.by_id = {}
        self.seq = 0
        self.keepouts = []

    def _new_id(self, prefix):
        self.seq += 1
        return f"{prefix}{self.seq}"

    def abs_of(self, cid):
        c = self.by_id[cid]
        x, y = c["x"], c["y"]
        p = c["parent"]
        while p != "1":
            pc = self.by_id[p]
            x += pc["x"]
            y += pc["y"]
            p = pc["parent"]
        return x, y, c["w"], c["h"]

    def vertex(self, value, style, x, y, w, h, id=None, parent="1", role="shape", shape="rect", head=40):
        cid = id or self._new_id("v")
        assert cid not in self.by_id and cid not in RESERVED_IDS, cid
        c = dict(kind="v", id=cid, value=value, style=style, x=x, y=y, w=w, h=h,
                 parent=parent, role=role, shape=shape, head=head)
        self.cells.append(c)
        self.by_id[cid] = c
        return cid

    def keepout(self, x, y, w, h, name):
        """Area drawn by draw.io outside a cell (an actor's caption, say) that lines must avoid."""
        self.keepouts.append(dict(kind="v", id="ko:" + name, value="", style="", x=x, y=y, w=w, h=h,
                                  parent="1", role="label", shape="rect"))

    def label_rect(self, c, pts=None):
        """Approximate box of an edge label as draw.io places it."""
        if not c["value"]:
            return None
        pts = pts or self.path(c)
        lens = [math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(pts, pts[1:])]
        total = sum(lens) or 1
        t = ((c["label_x"] if c["label_x"] is not None else 0) + 1) / 2 * total
        px, py = pts[0]
        for (a, b), L in zip(zip(pts, pts[1:]), lens):
            if t <= L or L == lens[-1]:
                f = 0 if L == 0 else min(1, t / L)
                px, py = a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f
                break
            t -= L
        if c["label_offset"] is not None:
            px += c["label_offset"][0]
            py += c["label_offset"][1]
        m = re.search(r"fontSize=(\d+)", c["style"])
        size = int(m.group(1)) if m else 11
        lines = [strip(l) for l in re.split(r"<br\s*/?>", c["value"])]
        w = max(len(l) for l in lines) * CHAR_W * size / 12 + 6
        h = len(lines) * 14 * size / 11 + 2
        return (px - w / 2, py - h / 2, w, h)

    def edge(self, src, tgt, value="", style="", points=(), id=None, exit=None, entry=None,
             label_x=None, label_dy=None, label_offset=None):
        cid = id or self._new_id("e")
        assert cid not in self.by_id and cid not in RESERVED_IDS, cid
        st = style
        if exit is not None:
            st += f"exitX={exit[0]:.4f};exitY={exit[1]:.4f};exitDx=0;exitDy=0;exitPerimeter=0;"
        if entry is not None:
            st += f"entryX={entry[0]:.4f};entryY={entry[1]:.4f};entryDx=0;entryDy=0;entryPerimeter=0;"
        c = dict(kind="e", id=cid, value=value, style=st, src=src, tgt=tgt, points=list(points),
                 exit=exit, entry=entry, label_x=label_x, label_dy=label_dy, label_offset=label_offset,
                 parent="1")
        self.cells.append(c)
        self.by_id[cid] = c
        return cid

    def xml(self):
        out = [
            f'<mxGraphModel dx="1422" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" '
            f'arrows="1" fold="1" page="1" pageScale="1" pageWidth="{self.w}" pageHeight="{self.h}" '
            f'background="#ffffff">',
            "  <root>",
            '    <mxCell id="0"/>',
            '    <mxCell id="1" parent="0"/>',
        ]
        for c in self.cells:
            if c["kind"] == "v":
                out.append(
                    f'    <mxCell id="{c["id"]}" value="{esc(c["value"])}" style="{esc(c["style"])}" '
                    f'vertex="1" parent="{c["parent"]}">'
                    f'<mxGeometry x="{c["x"]:.0f}" y="{c["y"]:.0f}" width="{c["w"]:.0f}" '
                    f'height="{c["h"]:.0f}" as="geometry"/></mxCell>'
                )
            else:
                geo_attrs = ""
                if c["label_x"] is not None:
                    geo_attrs += f' x="{c["label_x"]}"'
                if c["label_dy"] is not None:
                    geo_attrs += f' y="{c["label_dy"]}"'
                inner = ""
                if c["points"]:
                    pts = "".join(f'<mxPoint x="{px:.0f}" y="{py:.0f}"/>' for px, py in c["points"])
                    inner += f'<Array as="points">{pts}</Array>'
                if c["label_offset"] is not None:
                    ox, oy = c["label_offset"]
                    inner += f'<mxPoint x="{ox:.0f}" y="{oy:.0f}" as="offset"/>'
                out.append(
                    f'    <mxCell id="{c["id"]}" value="{esc(c["value"])}" style="{esc(c["style"])}" '
                    f'edge="1" parent="1" source="{c["src"]}" target="{c["tgt"]}">'
                    f'<mxGeometry{geo_attrs} relative="1" as="geometry">{inner}</mxGeometry></mxCell>'
                )
        out += ["  </root>", "</mxGraphModel>", ""]
        return "\n".join(out)

    # ---------- geometry used by the checker ----------

    def _anchor(self, cid, rel):
        x, y, w, h = self.abs_of(cid)
        return (x + rel[0] * w, y + rel[1] * h)

    def _center(self, cid):
        x, y, w, h = self.abs_of(cid)
        return (x + w / 2, y + h / 2)

    def _clip(self, cid, frm, to):
        """Point where the line from `frm` (inside cid) toward `to` leaves cid's shape."""
        x, y, w, h = self.abs_of(cid)
        shape = self.by_id[cid]["shape"]
        lo, hi = 0.0, 1.0
        for _ in range(40):
            mid = (lo + hi) / 2
            px = frm[0] + (to[0] - frm[0]) * mid
            py = frm[1] + (to[1] - frm[1]) * mid
            if inside(shape, (x, y, w, h), (px, py), 0):
                lo = mid
            else:
                hi = mid
        return (frm[0] + (to[0] - frm[0]) * hi, frm[1] + (to[1] - frm[1]) * hi)

    def path(self, c):
        pts = c["points"]
        if c["exit"] is not None:
            a = self._anchor(c["src"], c["exit"])
        else:
            nxt = pts[0] if pts else (self._anchor(c["tgt"], c["entry"]) if c["entry"] else self._center(c["tgt"]))
            a = self._clip(c["src"], self._center(c["src"]), nxt)
        if c["entry"] is not None:
            b = self._anchor(c["tgt"], c["entry"])
        else:
            prv = pts[-1] if pts else a
            b = self._clip(c["tgt"], self._center(c["tgt"]), prv)
        return [a] + list(pts) + [b]


def inside(shape, rect, p, margin):
    x, y, w, h = rect
    x += margin
    y += margin
    w -= 2 * margin
    h -= 2 * margin
    if w <= 0 or h <= 0:
        return False
    px, py = p
    if shape == "ellipse":
        cx, cy = x + w / 2, y + h / 2
        return ((px - cx) / (w / 2)) ** 2 + ((py - cy) / (h / 2)) ** 2 < 1
    if shape == "rhombus":
        cx, cy = x + w / 2, y + h / 2
        return abs(px - cx) / (w / 2) + abs(py - cy) / (h / 2) < 1
    return x < px < x + w and y < py < y + h


def rect_hit(a, b, margin):
    return a[0] < b[0] + b[2] - margin and b[0] < a[0] + a[2] - margin and         a[1] < b[1] + b[3] - margin and b[1] < a[1] + a[3] - margin


def seg_hits_rect(p, q, r):
    L = math.hypot(q[0] - p[0], q[1] - p[1])
    n = max(2, int(L / 3))
    for k in range(n + 1):
        t = k / n
        x, y = p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t
        if r[0] + 1 < x < r[0] + r[2] - 1 and r[1] + 1 < y < r[1] + r[3] - 1:
            return True
    return False


def seg_cross(p1, p2, p3, p4):
    def orient(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    d1 = orient(p3, p4, p1)
    d2 = orient(p3, p4, p2)
    d3 = orient(p1, p2, p3)
    d4 = orient(p1, p2, p4)
    return (d1 * d2 < -1e-6) and (d3 * d4 < -1e-6)


def check(d):
    """Return a list of rule failures for one diagram."""
    fails = []
    xml = d.xml()
    if "<!--" in xml:
        fails.append("XML comment present")
    if "mermaid" in xml.lower():
        fails.append("Mermaid content present")
    root = ET.fromstring(xml)
    ids = [c.get("id") for c in root.iter("mxCell")]
    if len(ids) != len(set(ids)):
        fails.append("duplicate ids")
    verts = set()
    for c in root.iter("mxCell"):
        if c.get("id") in ("0", "1"):
            continue
        if c.find("mxGeometry") is None:
            fails.append(f"{c.get('id')} has no mxGeometry")
        if c.get("vertex") == "1":
            verts.add(c.get("id"))
        elif c.get("edge") != "1":
            fails.append(f"{c.get('id')} is neither vertex nor edge")
    for c in root.iter("mxCell"):
        if c.get("edge") == "1":
            if c.get("source") not in verts or c.get("target") not in verts:
                fails.append(f"edge {c.get('id')} has a dangling end")

    # a lifeline is solid only in its head box; its stem and any frame are see-through
    heads = [dict(kind="v", id="hd:" + c["id"], value=c["value"], style=c["style"], x=c["x"], y=c["y"],
                  w=c["w"], h=c["head"], parent=c["parent"], role="shape", shape="rect")
             for c in d.cells if c["kind"] == "v" and c["role"] == "lifeline"]
    vs = [c for c in d.cells if c["kind"] == "v"] + d.keepouts + heads
    es = [c for c in d.cells if c["kind"] == "e"]
    for k in d.keepouts + heads:
        d.by_id[k["id"]] = k

    def ancestors(cid):
        out = set()
        p = d.by_id[cid]["parent"]
        while p != "1":
            out.add(p)
            p = d.by_id[p]["parent"]
        return out

    # shapes and labels must not touch each other unless one contains the other
    for i, a in enumerate(vs):
        ra = d.abs_of(a["id"])
        for b in vs[i + 1:]:
            if a["role"] in SEE_THROUGH or b["role"] in SEE_THROUGH:
                continue
            if a["role"] == "container" and b["role"] == "container" and (
                a["id"] in ancestors(b["id"]) or b["id"] in ancestors(a["id"])
            ):
                continue
            rb = d.abs_of(b["id"])
            inter = ra[0] < rb[0] + rb[2] - 0.5 and rb[0] < ra[0] + ra[2] - 0.5 and \
                ra[1] < rb[1] + rb[3] - 0.5 and rb[1] < ra[1] + ra[3] - 0.5
            if not inter:
                continue
            a_in_b = ra[0] >= rb[0] and ra[1] >= rb[1] and ra[0] + ra[2] <= rb[0] + rb[2] and ra[1] + ra[3] <= rb[1] + rb[3]
            b_in_a = rb[0] >= ra[0] and rb[1] >= ra[1] and rb[0] + rb[2] <= ra[0] + ra[2] and rb[1] + rb[3] <= ra[1] + ra[3]
            if (a_in_b and b["role"] in ("container", "part")) or (b_in_a and a["role"] in ("container", "part")):
                continue
            if a["role"] == "part" or b["role"] == "part":
                if a["id"] in ancestors(b["id"]) or b["id"] in ancestors(a["id"]):
                    continue
            fails.append(f"overlap: {a['id']} [{strip(a['value'])[:24]}] / {b['id']} [{strip(b['value'])[:24]}]")

    # text must fit its box
    for v in vs:
        if not v["value"] or v["role"] in ("container",) + SEE_THROUGH or "overflow=fill" in v["style"]:
            continue
        m = re.search(r"fontSize=(\d+)", v["style"])
        size = int(m.group(1)) if m else 12
        pad = 14 if v["shape"] == "rect" else 30
        need = text_lines(v["value"], max(10, v["w"] - pad), size) * LINE_H * size / 12
        if v["role"] != "actor" and need > v["h"] + 2:
            fails.append(f"text too tall for {v['id']} [{strip(v['value'])[:30]}] need {need:.0f} > {v['h']}")

    # connectors must not run through a shape that is not one of their ends
    paths = {}
    for e in es:
        pts = d.path(e)
        paths[e["id"]] = pts
        ends = {e["src"], e["tgt"]} | ancestors(e["src"]) | ancestors(e["tgt"])
        for v in vs:
            if v["id"] in ends or v["role"] in ("container",) + SEE_THROUGH:
                continue
            r = d.abs_of(v["id"])
            hit = False
            for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
                L = math.hypot(x2 - x1, y2 - y1)
                n = max(2, int(L / 3))
                for k in range(1, n):
                    t = k / n
                    if inside(v["shape"], r, (x1 + (x2 - x1) * t, y1 + (y2 - y1) * t), 1.5):
                        hit = True
                        break
                if hit:
                    break
            if hit:
                fails.append(f"line {e['id']} ({e['src']}->{e['tgt']}) cuts {v['id']} [{strip(v['value'])[:24]}]")

    # edge labels must sit clear of shapes, other labels and other lines
    boxes = []
    for e in es:
        r = d.label_rect(e, paths[e["id"]])
        if r:
            boxes.append((e, r))
    for e, r in boxes:
        for v in vs:
            if v["role"] in ("container",) + SEE_THROUGH:
                continue
            rv = d.abs_of(v["id"])
            if rect_hit(r, rv, 1):
                fails.append(f"label of {e['id']} [{strip(e['value'])[:20]}] sits on {v['id']} [{strip(v['value'])[:20]}]")
        for e2 in es:
            if e2 is e:
                continue
            pts = paths[e2["id"]]
            if any(seg_hits_rect(a, b, r) for a, b in zip(pts, pts[1:])):
                fails.append(f"line {e2['id']} runs through the label of {e['id']} [{strip(e['value'])[:20]}]")
    for i, (e, r) in enumerate(boxes):
        for e2, r2 in boxes[i + 1:]:
            if rect_hit(r, r2, 0):
                fails.append(f"labels of {e['id']} and {e2['id']} overlap")

    # connectors should not cross each other
    eids = list(paths)
    for i, a in enumerate(eids):
        for b in eids[i + 1:]:
            pa, pb = paths[a], paths[b]
            done = False
            for s1 in zip(pa, pa[1:]):
                for s2 in zip(pb, pb[1:]):
                    if seg_cross(s1[0], s1[1], s2[0], s2[1]):
                        fails.append(f"lines cross: {a} / {b}")
                        done = True
                        break
                if done:
                    break
    for k in d.keepouts + heads:
        d.by_id.pop(k["id"], None)
    return fails


def strip(v):
    return re.sub(r"<[^>]+>", " ", html.unescape(v or "")).strip()


def save(d, export=True):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, d.name + ".drawio")
    with open(path, "w", encoding="utf-8") as f:
        f.write(d.xml())
    png = os.path.join(OUT, d.name + ".png")
    if export:
        # draw.io's exporter shrinks the drawing inside the canvas when the PNG is wider than ~3000 px
        scale = min(2, round(2800 / d.w, 2))
        subprocess.run([DRAWIO, "-x", "-f", "png", "-s", str(scale), "-b", "16", "-o", png, path],
                       check=True, capture_output=True, timeout=180)
    return path, png
