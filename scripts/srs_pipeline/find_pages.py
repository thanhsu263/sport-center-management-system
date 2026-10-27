"""python find_pages.py <pass1.pdf> <pages.json>: map every @@marker@@ to its page number."""

import json
import re
import sys

import fitz

doc = fitz.open(sys.argv[1])
pages = {}
for i, p in enumerate(doc):
    for key in re.findall(r"@@([a-z]+\d+)@@", p.get_text()):
        pages.setdefault(key, i + 1)
json.dump(pages, open(sys.argv[2], "w"), indent=0)
print(f"{len(pages)} markers over {len(doc)} pages")
