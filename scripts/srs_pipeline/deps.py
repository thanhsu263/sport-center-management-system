import os, re, collections, sys

SRC = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "src"))


def pkg(p):
    if p.startswith("routes/"): return "routes"
    if p.startswith("components/ui"): return "components/ui"
    if p.startswith("components/"): return "components"
    if p.startswith("lib/arena3/handlers/"): return "handlers"
    if p.startswith("lib/arena3/"): return "arena3"
    if p.startswith("lib/i18n"): return "i18n"
    if p.startswith("lib/auth/"): return "auth"
    if p.startswith("lib/app-data/"): return "app-data"
    if p.startswith("lib/multiplayer"): return "multiplayer"
    if p == "lib/db.ts" or p == "lib/db": return "db"
    if p.startswith("lib/"): return "lib-misc:" + p
    return "root:" + p


dep = collections.Counter()
for r, _, fs in os.walk(SRC):
    for f in fs:
        if not f.endswith((".ts", ".tsx")) or f.endswith(".test.ts"):
            continue
        full = os.path.join(r, f)
        rel = os.path.relpath(full, SRC).replace("\\", "/")
        a = pkg(rel)
        s = open(full, encoding="utf-8").read()
        for m in re.finditer(r'from\s+"(@/[^"]+|\.{1,2}/[^"]*)"', s):
            t = m.group(1)
            if t.startswith("@/"):
                tp = t[2:]
            else:
                tp = os.path.normpath(os.path.join(os.path.dirname(rel), t)).replace("\\", "/")
            b = pkg(tp + ".ts" if not tp.endswith(".ts") else tp)
            if tp.startswith("lib/arena3/handlers/") or tp == "lib/arena3/handlers":
                b = "handlers"
            if a != b:
                dep[(a, b)] += 1
for (a, b), n in sorted(dep.items()):
    if not a.startswith("root:") or a in ("root:router.tsx",):
        print(a, "->", b, n)
