"""python merge.py <cover.pdf> <body.pdf> <out.pdf> <pages.json> <final.html>

Stamps the running header and page numbers, puts the cover first and adds PDF bookmarks.
"""

import html
import json
import re
import sys

import fitz

cover, body, out, pages_json, final_html = sys.argv[1:6]
FONT = r"C:/Windows/Fonts/times.ttf"
GREY = (0.28, 0.33, 0.41)
CM = 72 / 2.54
TITLE = "Arena 3 — Software Requirement Specification"
VER = "Version 2.2"

doc = fitz.open(body)
total = len(doc)
font = fitz.Font(fontfile=FONT)
lof_page = None
for i, page in enumerate(doc):
    if lof_page is None and i < 6 and "List of Figures" in page.get_text():
        lof_page = i + 1
    w, h = page.rect.width, page.rect.height
    land = w > h
    left = 2 * CM if land else 2.5 * CM
    right = w - 2 * CM
    top = (1.05 if land else 1.35) * CM
    page.insert_font(fontname="tnr", fontfile=FONT)
    page.insert_text((left, top), TITLE, fontname="tnr", fontsize=8.5, color=GREY)
    page.insert_text((right - font.text_length(VER, 8.5), top), VER, fontname="tnr", fontsize=8.5, color=GREY)
    page.draw_line((left, top + 4), (right, top + 4), color=(0.8, 0.84, 0.88), width=0.5)
    num = f"Page {i + 2} of {total + 1}"
    page.insert_text(((w - font.text_length(num, 9)) / 2, h - (1.0 if land else 1.2) * CM), num,
                     fontname="tnr", fontsize=9, color=GREY)

final = fitz.open(cover)
final.insert_pdf(doc)

pages = json.load(open(pages_json, encoding="utf-8"))
src = open(final_html, encoding="utf-8").read()


def plain(s):
    return html.unescape(re.sub(r"<[^>]+>", "", s)).strip()


outline = [[1, "Cover", 1], [1, "Table of Contents", 2], [1, "List of Figures", lof_page + 1]]
for fid, cap in re.findall(r'<figure class="\w+" id="(fig\d+)">.*?<figcaption>(.*?)</figcaption>', src, flags=re.S):
    outline.append([2, plain(cap), pages[fid] + 1])
for level, hid, inner in re.findall(r'<h([2-4]) id="(h\d+)">(.*?)</h\1>', src, flags=re.S):
    outline.append([int(level) - 1, plain(inner), pages[hid] + 1])
final.set_toc(outline)
final.set_metadata({"title": TITLE, "author": "Arena3 team", "subject": "SRS version 2.2", "creator": "Arena3 team"})
final.save(out, garbage=3, deflate=True)
print(f"{len(final)} pages, {len(outline)} bookmarks -> {out}")
