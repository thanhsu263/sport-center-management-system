#!/usr/bin/env node
/**
 * Grade docs/diagrams/*.drawio against the SRS section III shapes
 * and Learning UML 2.0 (see .grok/skills/uml2-oreilly/SKILL.md).
 * Exits 1 when a rule fails. Also fails when a word is wider than its box,
 * a connector cuts through a filled shape, two connectors cross, or a label
 * sits on a shape. Still look at the PNG for uneven gaps.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";

const FILES = [
  ["use-case", "docs/diagrams/use-case-diagram.drawio"],
  ["context", "docs/diagrams/context-diagram.drawio"],
  ["activity", "docs/diagrams/activity-diagram.drawio"],
  ["class", "docs/diagrams/class-diagram.drawio"],
  ["sequence", "docs/diagrams/sequence-diagram.drawio"],
  ["erd-logical", "docs/diagrams/erd-logical.drawio"],
  ["erd-physical", "docs/diagrams/erd-physical.drawio"],
];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function intersects(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
function contains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}
function partialOverlap(a, b) {
  return intersects(a, b) && !contains(a, b) && !contains(b, a);
}

assert(!partialOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 2, y: 2, w: 2, h: 2 }), "containment is not a clash");
assert(partialOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 8, y: 8, w: 4, h: 4 }), "a corner clash is a clash");
assert(!partialOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 4, h: 4 }), "touching edges are not a clash");

function decode(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#10;/g, "\n")
    .replace(/&amp;/g, "&");
}

function styleMap(style) {
  const m = {};
  for (const part of (style || "").split(";")) {
    if (!part) continue;
    const i = part.indexOf("=");
    if (i < 0) m[part] = "1";
    else m[part.slice(0, i)] = part.slice(i + 1);
  }
  return m;
}

function parse(xml) {
  const cells = [];
  const re = /<mxCell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)/g;
  for (const match of xml.matchAll(re)) {
    const attr = match[1];
    const inner = match[2] || "";
    const take = (name) => {
      const found = attr.match(new RegExp(`\\b${name}="([^"]*)"`));
      return found ? decode(found[1]) : "";
    };
    const geo = inner.match(/<mxGeometry\b([^>]*)\/?>/) || inner.match(/<mxGeometry\b([^>]*)>/);
    const g = geo ? geo[1] : "";
    const num = (name, fallback) => {
      const found = g.match(new RegExp(`\\b${name}="([^"]+)"`));
      return found ? Number(found[1]) : fallback;
    };
    const points = [...inner.matchAll(/<mxPoint\b(?![^>]*as=")([^>]*)\/?>/g)].map((p) => ({
      x: Number((p[1].match(/\bx="([^"]+)"/) || [])[1] || 0),
      y: Number((p[1].match(/\by="([^"]+)"/) || [])[1] || 0),
    }));
    const style = take("style");
    cells.push({
      id: take("id"),
      value: take("value"),
      style,
      sm: styleMap(style),
      vertex: /\bvertex="1"/.test(attr),
      edge: /\bedge="1"/.test(attr),
      parent: take("parent") || "1",
      source: take("source"),
      target: take("target"),
      x: num("x", 0),
      y: num("y", 0),
      w: num("width", 0),
      h: num("height", 0),
      relative: /\brelative="1"/.test(g),
      points,
    });
  }
  const pageW = Number((xml.match(/pageWidth="([^"]+)"/) || [])[1] || 0);
  const pageH = Number((xml.match(/pageHeight="([^"]+)"/) || [])[1] || 0);
  return { cells, pageW, pageH };
}

function byId(cells) {
  return new Map(cells.map((c) => [c.id, c]));
}

function plain(value) {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function grade(kind, xml) {
  const fails = [];
  const check = (rule, ok, detail = "") => {
    if (!ok) fails.push({ rule, detail });
  };
  check("no XML comment", !xml.includes("<!--"));
  const { cells, pageW, pageH } = parse(xml);
  const ids = cells.map((c) => c.id);
  check("ids are unique", new Set(ids).size === ids.length, ids.filter((id, i) => ids.indexOf(id) !== i).join(","));
  check("root cells 0 and 1", ids.includes("0") && ids.includes("1"));
  const map = byId(cells);
  for (const c of cells) {
    if (c.id === "0" || c.id === "1") continue;
    check(`${c.id} has geometry`, c.relative || c.w > 0 || c.h > 0 || c.edge, c.id);
    if (c.edge) {
      check(`${c.id} source exists`, map.has(c.source), c.source);
      check(`${c.id} target exists`, map.has(c.target), c.target);
    }
  }

  const nodes = cells.filter((c) => c.vertex && c.parent === "1" && c.w > 2 && c.h > 2 && c.sm.opacity !== "0" && c.sm.fillColor !== "none");
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (partialOverlap(nodes[i], nodes[j])) {
        check("nodes do not partially overlap", false, `${nodes[i].id} × ${nodes[j].id}`);
      }
    }
  }
  const framed = cells.filter((c) => c.vertex && c.parent === "1" && c.w > 2 && c.h > 2 && c.sm.opacity !== "0");
  for (const c of framed) {
    check(`${c.id} stays on the page`, c.x >= 0 && c.y >= 0 && c.x + c.w <= pageW + 1 && c.y + c.h <= pageH + 1, `${c.x},${c.y} ${c.w}x${c.h}`);
  }

  if (kind === "use-case") gradeUseCase(check, cells);
  if (kind === "context") gradeContext(check, cells);
  if (kind === "activity") gradeActivity(check, cells);
  if (kind === "class") gradeClass(check, cells);
  if (kind === "sequence") gradeSequence(check, cells, map);
  if (kind === "erd-logical" || kind === "erd-physical") gradeErd(check, cells, kind);
  gradePicture(check, cells, map, pageW, pageH);
  return fails;
}

function gradeUseCase(check, cells) {
  const actors = cells.filter((c) => c.sm.shape === "umlActor");
  const ovals = cells.filter((c) => c.sm.ellipse === "1" && c.vertex);
  const boundary = cells.find((c) => c.id === "sys");
  const blob = cells.map((c) => plain(c.value)).join("\n");
  check("one system boundary", !!boundary && boundary.sm.fillColor === "none");
  check("stick actors stand outside it", !!boundary && actors.length >= 5 && actors.every((a) => !intersects(a, boundary)), String(actors.length));
  for (const name of ["Guest", "Member", "Receptionist", "Coach", "Manager"]) {
    check(`actor ${name} is named`, blob.includes(name));
  }
  check("external systems are not drawn on the use case", !blob.includes("«actor»") && !blob.includes("payOS") && !blob.includes("Mail delivery"));
  check("no package frames", cells.filter((c) => c.id.startsWith("pkg")).length === 0);
  check("goal ovals sit inside the one boundary", !!boundary && ovals.length >= 31 && ovals.every((o) => contains(boundary, o)), String(ovals.length));
  check("use case names are goals, not UC codes", ovals.every((o) => !/^UC\d/.test(plain(o.value))));
  for (const e of cells.filter((c) => c.edge)) {
    const s = cells.find((c) => c.id === e.source);
    const t = cells.find((c) => c.id === e.target);
    const actorEnd = [s, t].some((n) => n && n.sm.shape === "umlActor");
    const ovalEnd = [s, t].some((n) => n && n.sm.ellipse === "1");
    if (actorEnd && ovalEnd) {
      check(`${e.id} communication line has no arrowhead`, e.sm.endArrow === "none" && e.sm.dashed !== "1");
    }
  }
  const dashed = cells.filter((c) => c.edge && c.sm.dashed === "1");
  check("include and extend are open dashed arrows", dashed.length === 8 && dashed.every((e) => e.sm.endArrow === "open" && e.sm.endFill === "0"), String(dashed.length));
  const pair = (id, from, to) => {
    const e = cells.find((c) => c.id === id);
    const s = cells.find((c) => c.id === e?.source);
    const t = cells.find((c) => c.id === e?.target);
    check(`${id} points from the tail use case to the reused one`, !!s && !!t && plain(s.value).includes(from) && plain(t.value).includes(to), plain(e?.value || ""));
  };
  pair("inc_otp", "Register member", "Verify email");
  pair("inc_book", "Book a court", "Pay online");
  pair("inc_plan", "Buy or renew", "Pay online");
  pair("inc_att", "Record session", "Lock the");
  pair("inc_rep", "View revenue", "Export");
  pair("inc_gate", "Check in", "Display the QR");
  pair("ext_refund", "Refund the", "Cancel a court");
  pair("ext_move", "Reschedule", "Book a court");
}

function gradeContext(check, cells) {
  const boundary = cells.find((c) => c.id === "sys");
  const name = plain(boundary?.value || "");
  const ovals = cells.filter((c) => c.vertex && c.sm.ellipse === "1");
  check("one system boundary", !!boundary && boundary.sm.fillColor === "none" && boundary.sm.ellipse !== "1" && /Arena3/.test(name) && !name.includes("0."), name);
  check("overview has no use cases", ovals.length === 0, String(ovals.length));
  const actors = cells.filter((c) => c.sm.shape === "umlActor");
  check("seven sticks stand outside the system", !!boundary && actors.length === 7 && actors.every((a) => !intersects(a, boundary)), String(actors.length));
  const blob = cells.map((c) => plain(c.value)).join("\n");
  for (const who of ["Guest", "Member", "Receptionist", "Coach", "Manager", "payOS", "Mail delivery"]) {
    check(`actor ${who}`, blob.includes(who));
  }
  check("external systems wear «actor»", (blob.match(/«actor»/g) || []).length === 2);
  const edges = cells.filter((c) => c.edge);
  check("one communication line per actor, no arrowhead", edges.length === 7 && edges.every((e) => e.sm.endArrow === "none" && plain(e.value).length > 0 && plain(e.value).length <= 24), edges.map((e) => plain(e.value)).join(" | "));
}

function gradeErd(check, cells, kind) {
  const blob = cells.map((c) => plain(c.value)).join("\n");
  const edges = cells.filter((c) => c.edge);
  if (kind === "erd-logical") {
    const diamonds = cells.filter((c) => c.sm.rhombus === "1");
    const ents = cells.filter((c) => c.vertex && c.parent === "1" && c.sm.rhombus !== "1" && c.w >= 80 && c.sm.fillColor !== "none");
    check("Chen entity rectangles", ents.length >= 6, String(ents.length));
    check("relationship diamonds", diamonds.length >= 6, String(diamonds.length));
    for (const name of ["User", "CourtBooking", "Subscription", "Class"]) check(`entity ${name}`, blob.includes(name));
    check("Chen lines have no arrowhead", edges.length >= 8 && edges.every((e) => e.sm.endArrow === "none"));
  } else {
    const tables = cells.filter((c) => c.vertex && c.value.includes("PK "));
    check("tables list a primary key", tables.length >= 6, String(tables.length));
    for (const name of ["User", "Subscription", "CourtBooking", "Payment", "Class"]) check(`table ${name}`, blob.includes(name));
    check("foreign-key lines have no arrowhead", edges.length >= 4 && edges.every((e) => e.sm.endArrow === "none"));
  }
}

function gradeActivity(check, cells) {
  const initials = cells.filter((c) => c.vertex && c.sm.ellipse === "1" && c.sm.fillColor === "#111111");
  const finals = cells.filter((c) => c.sm.shape === "endState");
  const signals = cells.filter((c) => c.sm.shape === "sendSignal");
  const lanes = cells.filter((c) => c.vertex && c.sm.fillColor === "#f8fafc" && c.w > 200);
  check("exactly one initial node", initials.length === 1, String(initials.length));
  check("activity final is a bullseye, not a second filled circle", finals.length >= 1, String(finals.length));
  check("a send signal leaves the system", signals.length >= 1);
  check("five partitions", lanes.length === 5, lanes.map((l) => plain(l.value)).join(", "));
  const laneNames = lanes.map((l) => plain(l.value)).join("|");
  for (const name of ["Guest", "Web client", "Arena3 API", "Mail delivery", "Database"]) {
    check(`partition ${name}`, laneNames.includes(name));
  }
  const guardText = cells.filter((c) => c.edge).map((c) => c.value);
  for (const guard of ["[Valid]", "[Invalid]", "[Duplicate]", "[Unique]", "[Verified]", "[Mismatch / Expired]"]) {
    check(`guard ${guard}`, guardText.includes(guard));
  }
  const outgoing = new Map();
  for (const e of cells.filter((c) => c.edge)) {
    const list = outgoing.get(e.source) || [];
    list.push(e);
    outgoing.set(e.source, list);
  }
  for (const d of cells.filter((c) => c.sm.rhombus === "1")) {
    const outs = outgoing.get(d.id) || [];
    if (outs.length >= 2) {
      check(`${d.id} decision guards are in brackets`, outs.every((e) => /^\[[^\]]+\]$/.test(e.value.trim())), outs.map((e) => e.value).join(" | "));
    } else {
      check(`${d.id} merge has one outgoing edge`, outs.length === 1, String(outs.length));
    }
  }
}

function gradeClass(check, cells) {
  const boxes = cells.filter((c) => c.vertex && c.style.includes("overflow=fill"));
  check("class boxes are present", boxes.length >= 6);
  const mult = /^(?:\*|0\.\.\*|1\.\.\*|0\.\.1|1|\d+)$/;
  for (const b of boxes) {
    check(`${b.id} has no rounded corner or shadow`, !b.style.includes("rounded=1") && !b.style.includes("shadow=1"));
    check(`${b.id} has no PK or FK marker`, !b.value.includes("[PK]") && !b.value.includes("[FK]"));
    const parts = b.value.split(/<hr\s*\/?>/i);
    check(`${b.id} has three compartments`, parts.length === 3, String(parts.length));
    const attrs = plain(parts[1] || "").split("\n").map((s) => s.trim()).filter(Boolean);
    const ops = plain(parts[2] || "").split("\n").map((s) => s.trim()).filter(Boolean);
    for (const a of attrs) {
      check(`${b.id} attribute "${a}"`, /^[+\-#~] [A-Za-z][A-Za-z0-9]* : [A-Za-z][A-Za-z0-9]*( \[[^\]]+\])?$/.test(a));
    }
    for (const o of ops) {
      check(`${b.id} operation "${o}"`, /^[+\-#~] [A-Za-z][A-Za-z0-9]*\([^)]*\) : [A-Za-z][A-Za-z0-9]*$/.test(o));
    }
  }
  const assoc = cells.filter((c) => c.edge && c.sm.endArrow === "none");
  check("associations are drawn", assoc.length >= 4);
  for (const e of assoc) {
    const labels = cells.filter((c) => c.parent === e.id).map((c) => c.value);
    check(`${e.id} has a multiplicity at each end`, labels.length === 2 && labels.every((v) => mult.test(v)), labels.join(","));
  }
}

function gradeSequence(check, cells, map) {
  const heads = cells.filter((c) => c.vertex && /:\s*\w+/.test(plain(c.value)) && c.w > 40);
  check("participants are name : Type", heads.length >= 4, heads.map((h) => plain(h.value)).join(" | "));
  const lifelines = cells.filter((c) => c.edge && c.sm.dashed === "1" && c.sm.endArrow === "none");
  check("dashed lifelines", lifelines.length >= 4, String(lifelines.length));
  const messages = cells.filter((c) => c.edge && (c.sm.endArrow === "block" || (c.sm.dashed === "1" && c.sm.endArrow === "open")));
  check("a synchronous call uses a filled arrow", messages.some((m) => m.sm.endArrow === "block" && m.sm.endFill === "1" && m.sm.dashed !== "1"));
  check("a return or create uses a dashed open arrow", messages.some((m) => m.sm.dashed === "1" && m.sm.endArrow === "open"));
  check("the booking is created with «create»", messages.some((m) => m.value.includes("«create»")));
  check("an alt fragment covers the payment branch", cells.some((c) => c.vertex && plain(c.value) === "alt"));
  check("activation bars are drawn", cells.filter((c) => c.sm.fillColor === "#e2e8f0" && c.w <= 16).length >= 4);
  for (const m of messages) {
    if (m.source === m.target) continue;
    const s = map.get(m.source);
    const t = map.get(m.target);
    if (!s || !t) continue;
    const y1 = s.y + Number(m.sm.exitY ?? 0.5) * s.h;
    const y2 = t.y + Number(m.sm.entryY ?? 0.5) * t.h;
    check(`${m.id} is horizontal`, Math.abs(y1 - y2) <= 2, `${y1} vs ${y2}`);
  }
}

assert(crossesRect({ x: 0, y: 5 }, { x: 100, y: 5 }, { x: 40, y: 0, w: 20, h: 20 }), "a line through a box is a cut");
assert(!crossesRect({ x: 0, y: 5 }, { x: 20, y: 5 }, { x: 40, y: 0, w: 20, h: 20 }), "a line that misses is not a cut");
assert(!crossesRect({ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 0, y: 0, w: 20, h: 10 }), "running along the top edge is not a cut");
assert(properCross({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 }), "an X is a crossing");
assert(!properCross({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }), "meeting at an end is not a crossing");

function port(cell, px, py) {
  const fx = Number(px ?? 0.5);
  const fy = Number(py ?? 0.5);
  if (cell.sm.ellipse === "1" && cell.sm.shape !== "endState") {
    const rx = cell.w / 2;
    const ry = cell.h / 2;
    let dx = (fx - 0.5) * cell.w;
    let dy = (fy - 0.5) * cell.h;
    if (dx === 0 && dy === 0) dx = rx;
    const t = 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
    return { x: cell.x + rx + dx * t, y: cell.y + ry + dy * t };
  }
  if (cell.sm.rhombus === "1") {
    const vx = (fx - 0.5) * cell.w;
    const vy = (fy - 0.5) * cell.h;
    const sum = 2 * (Math.abs(fx - 0.5) + Math.abs(fy - 0.5)) || 1;
    return { x: cell.x + cell.w / 2 + vx / sum, y: cell.y + cell.h / 2 + vy / sum };
  }
  return { x: cell.x + fx * cell.w, y: cell.y + fy * cell.h };
}

function edgePoints(e, map) {
  const s = map.get(e.source);
  const t = map.get(e.target);
  if (!s || !t) return [];
  const start = e.sm.exitX != null ? port(s, e.sm.exitX, e.sm.exitY) : port(s, 0.5, 0.5);
  const end = e.sm.entryX != null ? port(t, e.sm.entryX, e.sm.entryY) : port(t, 0.5, 0.5);
  return [start, ...(e.points || []), end];
}

function pointAlong(pts, t) {
  const lens = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    lens.push(d);
    total += d;
  }
  let left = t * total;
  for (let i = 0; i < lens.length; i++) {
    if (left <= lens[i] || i === lens.length - 1) {
      const u = lens[i] === 0 ? 0 : left / lens[i];
      return {
        x: pts[i].x + (pts[i + 1].x - pts[i].x) * u,
        y: pts[i].y + (pts[i + 1].y - pts[i].y) * u,
      };
    }
    left -= lens[i];
  }
  return pts[pts.length - 1];
}

function longestSeg(pts) {
  let best = 0;
  let len = -1;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
    if (d > len) {
      len = d;
      best = i;
    }
  }
  return { i: best, len };
}

function isEdgeLabel(c) {
  return c.sm.edgeLabel === "1" || (c.vertex && c.parent !== "1" && c.parent !== "0");
}

function multBox(text, pts, t) {
  const u = t < 0.5 ? 0.24 : 0.76;
  const p = pointAlong(pts, u);
  const a = pts[0];
  const b = pts[pts.length - 1];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const n = Math.hypot(dx, dy) || 1;
  let nx = -dy / n;
  let ny = dx / n;
  if (nx < 0) {
    nx = -nx;
    ny = -ny;
  }
  const tw = Math.max(16, text.length * 6.4 + 8);
  const th = 14;
  const cx = p.x + nx * (tw / 2 + 6);
  const cy = p.y + ny * 8;
  return { x: cx - tw / 2, y: cy - th / 2, w: tw, h: th, text };
}

function labelBox(text, pts, size = 11) {
  const self = pts.length > 2 && Math.abs(pts[0].x - pts[pts.length - 1].x) < 4 && Math.abs(pts[0].y - pts[pts.length - 1].y) < 40;
  if (self) {
    const tip = pts.reduce((m, p) => (p.x > m.x ? p : m), pts[0]);
    const tw = Math.max(14, text.length * size * 0.56 + 8);
    const th = size + 6;
    return { x: tip.x + 8, y: tip.y - th / 2, w: tw, h: th, text };
  }
  const { i, len } = longestSeg(pts);
  const a = pts[i];
  const b = pts[i + 1] || a;
  const tw = Math.max(14, text.length * size * 0.56 + 8);
  const along = tw > len * 0.45 ? 0.5 : len > 280 ? 0.28 : 0.5;
  const mx = a.x + (b.x - a.x) * along;
  const my = a.y + (b.y - a.y) * along;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const vertical = Math.abs(dx) < Math.abs(dy);
  let nx = 0;
  let ny = -1;
  if (vertical) {
    nx = mx < 700 ? 1 : -1;
    ny = 0;
  }
  const th = size + 6;
  const cx = mx + nx * (tw / 2 + 4);
  const cy = my + ny * (th / 2 + 3);
  return { x: cx - tw / 2, y: cy - th / 2, w: tw, h: th, text };
}

function crossesRect(p, q, rect) {
  const inside = (x, y) => x > rect.x + 1.5 && x < rect.x + rect.w - 1.5 && y > rect.y + 1.5 && y < rect.y + rect.h - 1.5;
  for (let i = 1; i < 40; i++) {
    const u = i / 40;
    if (inside(p.x + (q.x - p.x) * u, p.y + (q.y - p.y) * u)) return true;
  }
  return false;
}

function orient(a, b, c) {
  const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(v) < 1) return 0;
  return Math.sign(v);
}

function properCross(a, b, c, d) {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}

function sameTrack(a, b, c, d) {
  const overlap = (a1, a2, b1, b2) => Math.min(a2, b2) - Math.max(a1, b1);
  if (Math.abs(a.y - b.y) < 2 && Math.abs(c.y - d.y) < 2 && Math.abs(a.y - c.y) < 2) {
    return overlap(Math.min(a.x, b.x), Math.max(a.x, b.x), Math.min(c.x, d.x), Math.max(c.x, d.x)) > 8;
  }
  if (Math.abs(a.x - b.x) < 2 && Math.abs(c.x - d.x) < 2 && Math.abs(a.x - c.x) < 2) {
    return overlap(Math.min(a.y, b.y), Math.max(a.y, b.y), Math.min(c.y, d.y), Math.max(c.y, d.y)) > 8;
  }
  return false;
}

function solid(c) {
  return c.vertex && c.parent === "1" && c.w > 2 && c.h > 2 && c.h < 400 && c.sm.opacity !== "0" && c.sm.fillColor !== "none" && !c.style.includes("fillColor=none");
}

function gradePicture(check, cells, map, pageW, pageH) {
  const drawn = cells.filter((c) => c.edge && map.has(c.source) && map.has(c.target));
  const polys = new Map(drawn.map((e) => [e.id, edgePoints(e, map)]));
  const labels = [];
  for (const e of drawn) {
    const pts = polys.get(e.id);
    if (e.value.trim()) labels.push([e.id, labelBox(plain(e.value), pts)]);
    for (const child of cells.filter((c) => c.parent === e.id && isEdgeLabel(c))) {
      const t = (Number(child.x) + 1) / 2;
      labels.push([child.id, multBox(child.value, pts, t)]);
    }
  }
  for (const [id, box] of labels) {
    check(`${id} label stays on the page`, box.x >= 1 && box.y >= 1 && box.x + box.w <= pageW - 1 && box.y + box.h <= pageH - 1, `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.w)}×${Math.round(box.h)}`);
  }
  const bodies = cells.filter(solid);
  for (const body of bodies) {
    for (const [id, box] of labels) {
      if (intersects(box, { x: body.x + 2, y: body.y + 2, w: body.w - 4, h: body.h - 4 })) {
        check(`${id} label is not on ${body.id}`, false);
      }
    }
  }
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (intersects(labels[i][1], labels[j][1])) {
        check("labels do not cover each other", false, `${labels[i][0]} × ${labels[j][0]}`);
      }
    }
  }
  for (const e of drawn) {
    if (e.sm.dashed === "1" && e.sm.endArrow === "none") continue;
    const pts = polys.get(e.id);
    for (let i = 0; i < pts.length - 1; i++) {
      for (const body of bodies) {
        if (body.id === e.source || body.id === e.target) continue;
        if (crossesRect(pts[i], pts[i + 1], body)) {
          check(`${e.id} does not cut through ${body.id}`, false);
        }
      }
    }
  }
  for (let i = 0; i < drawn.length; i++) {
    for (let j = i + 1; j < drawn.length; j++) {
      const a = drawn[i];
      const b = drawn[j];
      if (a.sm.dashed === "1" && a.sm.endArrow === "none") continue;
      if (b.sm.dashed === "1" && b.sm.endArrow === "none") continue;
      const pa = polys.get(a.id);
      const pb = polys.get(b.id);
      for (let s = 0; s < pa.length - 1; s++) {
        for (let t = 0; t < pb.length - 1; t++) {
          if (properCross(pa[s], pa[s + 1], pb[t], pb[t + 1]) || sameTrack(pa[s], pa[s + 1], pb[t], pb[t + 1])) {
            check(`${a.id} does not cross ${b.id}`, false);
          }
        }
      }
    }
  }
  for (const c of cells.filter((n) => n.vertex && n.parent === "1" && n.value.includes("<hr"))) {
    const parts = c.value.split(/<hr\s*\/?>/i).map((p) => plain(p));
    const lines = [...(parts[1] || "").split("\n"), ...(parts[2] || "").split("\n")].map((s) => s.trim()).filter(Boolean);
    for (const line of lines) {
      check(`${c.id} fits "${line}"`, line.length * 11 * 0.56 + 16 <= c.w - 18, `need ${Math.ceil(line.length * 11 * 0.56 + 34)}`);
    }
  }
  for (const c of cells.filter((n) => n.vertex && n.parent === "1" && (n.sm.ellipse === "1" || n.sm.rounded === "1" || n.sm.shape === "sendSignal" || n.value.includes("«actor»")))) {
    for (const line of plain(c.value).split("\n").filter(Boolean)) {
      check(`${c.id} fits "${line}"`, line.length * 12 * 0.56 + 12 <= c.w - 8);
    }
  }
}

function svgText(value, x, y, w, h, opt = {}) {
  const lines = plain(value).split("\n");
  const size = opt.size || 12;
  const anchor = opt.anchor || "middle";
  const tx = anchor === "start" ? x : x + w / 2;
  const lineH = size + 3;
  const total = lines.length * lineH;
  let ty = y + (h - total) / 2 + size;
  if (opt.top) ty = y + size + (opt.pad ?? 4);
  return lines
    .map((line, i) => {
      const safe = line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<text x="${tx}" y="${ty + i * lineH}" text-anchor="${anchor}" font-family="Helvetica, Arial, sans-serif" font-size="${size}" font-weight="${opt.bold ? "700" : "400"}" fill="#1e293b">${safe}</text>`;
    })
    .join("");
}

function drawNode(c) {
  const { x, y, w, h } = c;
  if (c.sm.opacity === "0") return "";
  if (c.sm.shape === "umlActor") {
    const cx = x + w / 2;
    const headY = y + 2;
    return `<g>
      <circle cx="${cx}" cy="${headY + 8}" r="8" fill="#fff" stroke="#1e293b" stroke-width="1.4"/>
      <line x1="${cx}" y1="${headY + 16}" x2="${cx}" y2="${y + 42}" stroke="#1e293b" stroke-width="1.4"/>
      <line x1="${cx - 12}" y1="${y + 28}" x2="${cx + 12}" y2="${y + 28}" stroke="#1e293b" stroke-width="1.4"/>
      <line x1="${cx}" y1="${y + 42}" x2="${cx - 12}" y2="${y + 62}" stroke="#1e293b" stroke-width="1.4"/>
      <line x1="${cx}" y1="${y + 42}" x2="${cx + 12}" y2="${y + 62}" stroke="#1e293b" stroke-width="1.4"/>
      ${svgText(c.value, x - 40, y + h, w + 80, 18, { size: 12 })}
    </g>`;
  }
  if (c.sm.shape === "endState") {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const r = Math.min(w, h) / 2;
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff" stroke="#111" stroke-width="1.6"/><circle cx="${cx}" cy="${cy}" r="${r * 0.55}" fill="#111"/>`;
  }
  if (c.sm.ellipse === "1" && c.sm.fillColor === "#111111") {
    return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="#111"/>`;
  }
  if (c.sm.ellipse === "1") {
    return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="#fff" stroke="#1e293b" stroke-width="1.4"/>${svgText(c.value, x + 8, y, w - 16, h)}`;
  }
  if (c.sm.rhombus === "1") {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const verb = plain(c.value);
    const text = verb ? svgText(verb, x, y, w, h, { size: 11 }) : "";
    return `<polygon points="${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}" fill="#fff" stroke="#1e293b" stroke-width="1.4"/>${text}`;
  }
  if (c.sm.shape === "sendSignal") {
    const nose = 16;
    return `<polygon points="${x},${y} ${x + w - nose},${y} ${x + w},${y + h / 2} ${x + w - nose},${y + h} ${x},${y + h}" fill="#fff" stroke="#1e293b" stroke-width="1.4"/>${svgText(c.value, x + 4, y, w - nose - 4, h, { size: 11 })}`;
  }
  if (c.value.includes("<hr")) {
    const parts = c.value.split(/<hr\s*\/?>/i).map((p) => plain(p));
    const name = parts[0] || "";
    const attrs = (parts[1] || "").split("\n").filter(Boolean);
    const ops = (parts[2] || "").split("\n").filter(Boolean);
    let yy = y;
    const nameH = 26;
    const row = 16;
    const attrH = Math.max(attrs.length, 1) * row + 8;
    const chunks = [
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#f8fafc" stroke="#475569" stroke-width="1.3"/>`,
      `<line x1="${x}" y1="${y + nameH}" x2="${x + w}" y2="${y + nameH}" stroke="#475569"/>`,
      `<line x1="${x}" y1="${y + nameH + attrH}" x2="${x + w}" y2="${y + nameH + attrH}" stroke="#475569"/>`,
      svgText(name, x, y + 2, w, nameH, { bold: true, size: 13 }),
    ];
    attrs.forEach((line, i) => chunks.push(svgText(line, x + 10, y + nameH + 2 + i * row, w - 20, row, { size: 11, anchor: "start", top: true, pad: 1 })));
    ops.forEach((line, i) => chunks.push(svgText(line, x + 10, y + nameH + attrH + 2 + i * row, w - 20, row, { size: 11, anchor: "start", top: true, pad: 1 })));
    yy = y;
    return `<defs><clipPath id="clip-${c.id}"><rect x="${x}" y="${y}" width="${w}" height="${h}"/></clipPath></defs><g clip-path="url(#clip-${c.id})">${chunks.join("")}</g>`;
  }
  if (c.sm.fillColor === "none" || c.style.includes("fillColor=none")) {
    const label = plain(c.value);
    const stroke = c.sm.strokeColor === "none" ? "none" : "#1e293b";
    const rect = stroke === "none" ? "" : `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${stroke}" stroke-width="1.4"/>`;
    const text = label ? svgText(label, x + 4, y, w - 8, 22, { top: true, bold: c.sm.fontStyle === "1", size: 13 }) : "";
    return rect + text;
  }
  if (c.sm.fillColor === "#e2e8f0") {
    const label = plain(c.value);
    const text = label ? svgText(label, x + 4, y, w - 8, h, { bold: true, size: 12 }) : "";
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#e2e8f0" stroke="#1e293b" stroke-width="1"/>${text}`;
  }
  if (c.h <= 2) {
    return `<rect x="${x}" y="${y}" width="${w}" height="${Math.max(h, 1)}" fill="#1e293b"/>`;
  }
  const rounded = c.sm.rounded === "1";
  const fill = c.sm.fillColor || "#ffffff";
  const stroke = c.sm.strokeColor === "none" ? "none" : c.sm.strokeColor || "#1e293b";
  const top = c.sm.verticalAlign === "top";
  const anchor = c.sm.align === "left" ? "start" : "middle";
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rounded ? 8 : 0}" fill="${fill}" stroke="${stroke}" stroke-width="1.3"/>${svgText(c.value, x + 6, y, w - 12, h, { size: 12, bold: c.sm.fontStyle === "1", top, anchor })}`;
}

function plate(box) {
  const safe = box.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="#ffffff"/><text x="${box.x + box.w / 2}" y="${box.y + box.h - 3}" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="11" fill="#1e293b">${safe}</text>`;
}

function drawEdge(e, map) {
  const pts = edgePoints(e, map);
  if (pts.length < 2) return "";
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const dashed = e.sm.dashed === "1" ? `stroke-dasharray="5 4"` : "";
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  const ang = Math.atan2(last.y - prev.y, last.x - prev.x);
  let marker = "";
  if (e.sm.endArrow === "block" && e.sm.endFill === "1") {
    const s1 = 8;
    const p1 = { x: last.x - s1 * Math.cos(ang) - 4 * Math.sin(ang), y: last.y - s1 * Math.sin(ang) + 4 * Math.cos(ang) };
    const p2 = { x: last.x - s1 * Math.cos(ang) + 4 * Math.sin(ang), y: last.y - s1 * Math.sin(ang) - 4 * Math.cos(ang) };
    marker = `<polygon points="${last.x},${last.y} ${p1.x},${p1.y} ${p2.x},${p2.y}" fill="#1e293b"/>`;
  } else if (e.sm.endArrow === "open") {
    const s1 = 9;
    const p1 = { x: last.x - s1 * Math.cos(ang) - 4 * Math.sin(ang), y: last.y - s1 * Math.sin(ang) + 4 * Math.cos(ang) };
    const p2 = { x: last.x - s1 * Math.cos(ang) + 4 * Math.sin(ang), y: last.y - s1 * Math.sin(ang) - 4 * Math.cos(ang) };
    marker = `<polyline points="${p1.x},${p1.y} ${last.x},${last.y} ${p2.x},${p2.y}" fill="none" stroke="#1e293b" stroke-width="1.3"/>`;
  }
  return `<path d="${d}" fill="none" stroke="#1e293b" stroke-width="1.3" ${dashed}/>${marker}`;
}

function toSvg(xml) {
  const { cells, pageW, pageH } = parse(xml);
  const map = byId(cells);
  const nodes = cells.filter((c) => c.vertex && c.parent === "1");
  const edges = cells.filter((c) => c.edge);
  const back = nodes.filter((c) => c.w > 200 && (c.sm.fillColor === "#f8fafc" || c.sm.fillColor === "none"));
  const front = nodes.filter((c) => !back.includes(c));
  const labels = [];
  for (const e of edges) {
    const pts = edgePoints(e, map);
    if (pts.length < 2) continue;
    if (e.value.trim()) labels.push(labelBox(plain(e.value), pts));
    for (const child of cells.filter((c) => c.parent === e.id && isEdgeLabel(c))) {
      const t = (Number(child.x) + 1) / 2;
      labels.push(multBox(child.value, pts, t));
    }
  }
  const body = [...back.map(drawNode), ...edges.map((e) => drawEdge(e, map)), ...front.map(drawNode), ...labels.map(plate)].join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${pageW}" height="${pageH}" viewBox="0 0 ${pageW} ${pageH}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  ${body}
</svg>`;
}

const report = [];
let failed = 0;
for (const [kind, path] of FILES) {
  const xml = readFileSync(path, "utf8");
  const fails = grade(kind, xml);
  const svgPath = path.replace(/\.drawio$/, ".svg");
  const pngPath = path.replace(/\.drawio$/, ".png");
  writeFileSync(svgPath, toSvg(xml));
  failed += fails.length;
  report.push({ kind, path, png: pngPath, fails });
  console.log(`\n${kind}: ${fails.length === 0 ? "PASS" : "FAIL"}`);
  for (const f of fails) console.log(`  - ${f.rule}${f.detail ? ` (${f.detail})` : ""}`);
}

mkdirSync("docs/diagrams", { recursive: true });
const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
for (const item of report) {
  const svg = readFileSync(item.path.replace(/\.drawio$/, ".svg"), "utf8");
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><body style="margin:0;background:#fff">${svg}</body>`, { waitUntil: "load" });
  const box = await page.locator("svg").boundingBox();
  await page.setViewportSize({ width: Math.ceil(box.width), height: Math.ceil(box.height) });
  await page.locator("svg").screenshot({ path: item.png });
  await page.close();
  console.log("shot", item.png);
}
await browser.close();

writeFileSync(
  "docs/diagrams/uml2-review.json",
  JSON.stringify({ at: new Date().toISOString(), book: "Learning UML 2.0, Miles & Hamilton, O'Reilly 2006", failed, report }, null, 2),
);
console.log(`\n${failed === 0 ? "ALL RULES PASSED" : failed + " rule failures"}. Wrote docs/diagrams/uml2-review.json`);
process.exit(failed === 0 ? 0 : 1);
