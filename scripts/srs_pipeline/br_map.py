"""Old SRS business rule IDs -> new sequential IDs. python br_map.py [--write]"""
import pathlib, re, sys
MAP = {"01":"01","02":"02","07":"03","08":"04","32":"05","35":"06","66":"07","39":"08","39C":"09","39H":"10",
"39B":"11","19A":"12","17":"13","14":"14","15":"15","65":"16","34A":"17","67":"18","12":"19","18":"20",
"22":"21","24":"22","25":"23","20":"24","23":"25","21":"26","28":"27","27":"28","26":"29","71":"30",
"72":"31","73":"32","54":"33","57":"34","53":"35","58":"36","34B":"37","42A":"38","43A":"39","44":"40",
"45":"41","46":"42","70":"43","49":"44","59":"45","55":"46","56":"47","75":"48","74":"49","38":"50",
"62":"52","61":"53"}
assert len(set(MAP.values())) == len(MAP)
ROOT = pathlib.Path(".")
files = [p for g in ("src/**/*.ts", "src/**/*.tsx", "scripts/*.mjs", "scripts/tests/**/*.mjs", "scripts/srs_diagrams/*.py")
         for p in ROOT.glob(g) if "routeTree" not in p.name and not p.name.startswith("build_")]
SKIP = re.compile(r'Court BR-0|program on BR-0|sân BR-0|Sân BR-0|codes?: "BR-0')
PAT = re.compile(r"\bBR-(\d+[A-Z]?)\b")
unknown, changed = set(), 0
for p in files:
    text = p.read_text(encoding="utf-8")
    out = []
    for line in text.split("\n"):
        if SKIP.search(line):
            out.append(line); continue
        line = line.replace("BR-44..46, BR-70", "BR-40..43")
        def sub(m):
            k = m.group(1)
            if k not in MAP:
                unknown.add((str(p), k)); return m.group(0)
            return "BR-" + MAP[k]
        out.append(PAT.sub(sub, line))
    new = "\n".join(out)
    if new != text:
        changed += 1
        if "--write" in sys.argv:
            p.write_text(new, encoding="utf-8", newline="")
print("files changed:", changed, "unknown:", sorted(unknown))
