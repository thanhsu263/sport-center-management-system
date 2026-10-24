"""Read the real schema (tables, primary keys, foreign keys) from migrations/*.sql."""

import glob
import os
import re

MIGRATIONS = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "migrations"))


def _split_top(body):
    depth, cur, parts = 0, "", []
    for ch in body:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append(cur)
            cur = ""
        else:
            cur += ch
    parts.append(cur)
    return [" ".join(p.split()) for p in parts]


def _add(tabs, t, line):
    line = line.strip().rstrip(",")
    if not line:
        return
    m = re.match(r"primary key\s*\((.*?)\)", line, re.I)
    if m:
        tabs[t]["pk"] += [c.strip() for c in m.group(1).split(",")]
        return
    m = re.match(r"foreign key\s*\((.*?)\)\s*references\s+(\w+)", line, re.I)
    if m:
        tabs[t]["fk"][m.group(1).strip()] = dict(ref=m.group(2), null=True)
        return
    if re.match(r"(unique|check|constraint)", line, re.I):
        return
    name = line.split()[0].strip('"')
    if name in tabs[t]["cols"]:
        return
    tabs[t]["cols"][name] = line
    if re.search(r"primary key", line, re.I):
        tabs[t]["pk"].append(name)
    m = re.search(r"references\s+(\w+)", line, re.I)
    if m:
        tabs[t]["fk"][name] = dict(ref=m.group(1), null="not null" not in line.lower())


def load():
    tabs = {}
    for f in sorted(glob.glob(os.path.join(MIGRATIONS, "*.sql"))):
        s = re.sub(r"--.*", "", open(f, encoding="utf-8").read())
        for m in re.finditer(r"create table(?: if not exists)?\s+(\w+)\s*\((.*?)\n\)\s*;", s, flags=re.S | re.I):
            t = m.group(1)
            tabs.setdefault(t, dict(cols={}, pk=[], fk={}))
            for p in _split_top(m.group(2)):
                _add(tabs, t, p)
        for m in re.finditer(r"alter table\s+(?:if exists\s+)?(\w+)\s+(.*?);", s, flags=re.S | re.I):
            t = m.group(1)
            if t not in tabs:
                continue
            for a in re.finditer(r"add column(?: if not exists)?\s+([^,]+(?:\([^)]*\)[^,]*)*)", m.group(2), flags=re.I):
                _add(tabs, t, " ".join(a.group(1).split()))
    return tabs
