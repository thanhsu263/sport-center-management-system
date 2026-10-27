"""Build the print HTML for the SRS PDF.

python make_html.py <out.html> [pages.json]
Without pages.json every heading carries an invisible marker so pass 1 can find its page.
"""

import glob
import html
import json
import os
import re
import sys

import fitz

SCRATCH = os.path.dirname(os.path.abspath(__file__))
SRS = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "docs", "diagrams", "srs"))

out_path = sys.argv[1]
pages = json.load(open(sys.argv[2], encoding="utf-8")) if len(sys.argv) > 2 else None

src = open(os.path.join(SCRATCH, "srs-export.html"), encoding="utf-8").read()

# Drop the doc title, date and byline: the cover page carries them.
src = re.sub(r"^<h1[^>]*>.*?</h1>\s*<p>.*?</p>", "", src, count=1, flags=re.S)

_png = {int(os.path.basename(f)[:2]): f for f in glob.glob(os.path.join(SRS, "*.png"))}
_tok = open(os.path.join(SCRATCH, "blobs.txt"), encoding="utf-8").read().split()
BLOB_PNG = {_tok[i + 1]: _png[int(_tok[i])] for i in range(0, len(_tok), 2)}

# Renumber figures in reading order and rewrite the text references to match.
order = [int(n) for n in re.findall(r'<img[^>]*alt="Figure (\d+)', src)]
renum = {old: i + 1 for i, old in enumerate(order)}


def fix_refs(text):
    return re.sub(r"Figure (\d+)", lambda m: f"Figure {renum.get(int(m.group(1)), m.group(1))}", text)


figures = []


def figure(m):
    alt = html.unescape(m.group(2))
    old = int(re.match(r"Figure (\d+)", alt).group(1))
    new = renum[old]
    title = re.sub(r"^Figure \d+\s*[—-]\s*", "", alt)
    png = BLOB_PNG[re.search(r"blob/([0-9a-f-]+)", m.group(1)).group(1)]
    pix = fitz.Pixmap(png)
    land = pix.width / pix.height >= 1.1
    url = "file:///" + png.replace("\\", "/").replace(" ", "%20")
    fid = f"fig{new}"
    figures.append((fid, new, title))
    mark = "" if pages else f'<span class="mk">@@{fid}@@</span>'
    cls = "land" if land else "port"
    cap = f"<figcaption><b>FIGNUM{new}.</b> {html.escape(title)}</figcaption>"
    return f'<figure class="{cls}" id="{fid}">{mark}<img src="{url}" alt="">{cap}</figure>'


src = re.sub(r'<p>\s*<img src="([^"]+)" alt="([^"]*)">\s*</p>', figure, src)
src = fix_refs(src).replace("FIGNUM", "Figure ")
_i = src.find("<th>Figure</th>")
_s, _e = src.rfind("<table", 0, _i), src.find("</table>", _i)
src = src[:_s] + re.sub(r"<td>(\d+)</td></tr>", lambda m: f"<td>{renum[int(m.group(1))]}</td></tr>", src[_s:_e]) + src[_e:]

INTRO_CHARS = 480


def lead_in(text, end):
    """Headings and short paragraphs right before a figure, so they print on the figure's page."""
    blocks, pos = [], end
    while True:
        head = text[:pos].rstrip()
        m = re.search(r"</(p|h[2-4])>$", head)
        if not m:
            break
        start = head.rfind(f"<{m.group(1)}")
        if start < 0:
            break
        blocks.append((start, m.group(1)))
        pos = start
        if len(blocks) > 5:
            break
    cut, used = end, 0
    for start, tag in blocks:
        used = len(re.sub(r"<[^>]+>", "", text[start:end]))
        if used > INTRO_CHARS:
            break
        if tag != "p":
            cut = start
    return cut


out, last = [], 0
for m in re.finditer(r'<figure class="(land|port)".*?</figure>', src, flags=re.S):
    cut = max(lead_in(src, m.start()), last)
    out.append(src[last:cut])
    out.append(f'<section class="figpage {m.group(1)}"><div class="intro">{src[cut:m.start()]}</div>'
               f"{m.group(0)}</section>")
    last = m.end()
out.append(src[last:])
src = "".join(out)
src = re.sub(r'<span data-atom="mention"[^>]*>[^<]*</span>', "Arena3 team", src)

heads = []


def heading(m):
    level, attrs, inner = int(m.group(1)), m.group(2), m.group(3)
    hid = f"h{len(heads)}"
    text = re.sub(r"<[^>]+>", "", inner)
    heads.append((hid, level, html.unescape(text)))
    mark = "" if pages else f'<span class="mk">@@{hid}@@</span>'
    return f'<h{level} id="{hid}">{mark}{inner}</h{level}>'


src = re.sub(r"<h([2-4])([^>]*)>(.*?)</h\1>", heading, src, flags=re.S)

# Long tables get a class so their rows stay whole across page breaks.
src = src.replace("<table><thead><tr><th>Field</th>", '<table class="t spec"><thead><tr><th>Field</th>')
src = src.replace("<table>", '<table class="t">')
src = re.sub(r"<tr><td>((?:(?!</td>).){1,12})</td>",
             lambda m: m.group(0) if "<" in re.sub(r"</?code>", "", m.group(1)) else f'<tr><td class="nw">{m.group(1)}</td>', src)


def pg(key):
    return str(pages[key] + 1) if pages else "00"


toc = ['<section class="front"><h1 class="fronth">Table of Contents</h1><div class="toc">']
for hid, level, text in heads:
    toc.append(f'<a class="l{level}" href="#{hid}"><span class="tx">{html.escape(text)}</span>'
               f'<span class="dots"></span><span class="pn">{pg(hid)}</span></a>')
toc.append("</div></section>")
lof = ['<section class="front"><h1 class="fronth">List of Figures</h1><div class="toc">']
for fid, n, title in figures:
    lof.append(f'<a class="l4" href="#{fid}"><span class="tx">Figure {n}. {html.escape(title)}</span>'
               f'<span class="dots"></span><span class="pn">{pg(fid)}</span></a>')
lof.append("</div></section>")

CSS = """
@page { size: A4; margin: 2.2cm 2cm 2.2cm 2.5cm; }
@page fig { size: A4; margin: 1.7cm 1.1cm 1.7cm 1.1cm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: "Times New Roman", Times, serif; font-size: 11.5pt; line-height: 1.42; color: #111; margin: 0; }
.mk { position: absolute; font-size: 2px; color: #fff; }
h1, h2, h3, h4 { font-weight: normal; color: #000; break-after: avoid; page-break-after: avoid; position: relative; }
.fronth { font-size: 24pt; margin: 0 0 14pt; }
h2 { font-size: 20pt; margin: 0 0 12pt; break-before: page; page-break-before: always; }
h3 { font-size: 15.5pt; margin: 18pt 0 8pt; }
h4 { font-size: 13pt; margin: 14pt 0 6pt; color: #333; }
p { margin: 0 0 8pt; text-align: justify; }
ul, ol { margin: 0 0 8pt; padding-left: 22pt; }
li p { margin: 0 0 2pt; text-align: left; }
code { font-family: Consolas, "Courier New", monospace; font-size: 9pt; background: #f1f5f9; padding: 0 2px; border-radius: 2px; }
table.t { width: 100%; border-collapse: collapse; margin: 4pt 0 12pt; font-family: Arial, Helvetica, sans-serif; font-size: 8.6pt; line-height: 1.3; }
table.t th, table.t td { border: 0.6pt solid #64748b; padding: 3pt 5pt; vertical-align: top; text-align: left; }
table.t th { background: #e2e8f0; font-weight: bold; }
table.t thead { display: table-header-group; }
table.t tr { break-inside: avoid; page-break-inside: avoid; }
table.t td p { margin: 0; text-align: left; }
table.t td.nw { white-space: nowrap; }
table.spec { table-layout: fixed; }
table.spec th:first-child { width: 3.6cm; }
table.t code { font-size: 8pt; }
.figpage { break-before: page; page-break-before: always; break-after: page; page-break-after: always;
  display: grid; grid-template-rows: auto minmax(0, 1fr); }
.figpage.port { height: 24.8cm; }
.figpage.land { page: fig; height: 25.8cm; }
.figpage .intro > :first-child { margin-top: 0; }
.figpage h2 { break-before: auto; page-break-before: auto; }
figure { margin: 0; position: relative; display: flex; flex-direction: column; min-height: 0; }
figure img { flex: 1 1 0; min-height: 0; width: 100%; object-fit: contain; }
figcaption { flex: none; text-align: center; font-size: 10.5pt; font-style: italic; margin-top: 6pt; }
figcaption b { font-style: normal; }
.front { break-after: page; page-break-after: always; }
.toc a { display: flex; align-items: baseline; color: #000; text-decoration: none; line-height: 1.55; }
.toc .dots { flex: 1; border-bottom: 1.2pt dotted #555; margin: 0 4pt; transform: translateY(-3pt); }
.toc .pn { min-width: 18pt; text-align: right; }
.toc .l2 { font-weight: bold; margin-top: 5pt; font-size: 11.5pt; }
.toc .l3 { padding-left: 16pt; font-size: 11pt; }
.toc .l4 { padding-left: 34pt; font-size: 10.5pt; }
"""

doc = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Arena 3 - Software Requirement Specification v2.2</title><style>{CSS}</style></head>
<body>{''.join(toc)}{''.join(lof)}<main>{src}</main>
</body></html>"""
open(out_path, "w", encoding="utf-8").write(doc)
print(f"{len(heads)} headings, {len(figures)} figures -> {out_path}")
