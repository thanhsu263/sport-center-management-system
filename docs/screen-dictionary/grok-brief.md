You are a ruthless, independent reviewer. READ-ONLY: do not edit, create or delete any file; only read and answer.

Review the "screen dictionary" for the Arena3 sports-centre app (manager / receptionist / coach / member).
Files:
- docs/screen-dictionary/index.html  (the document source: Vietnamese descriptions per screen are in scripts/screen-dictionary.mjs, the array `S`)
- docs/screen-dictionary/img/Sxx-d.jpg (desktop shot) and Sxx-m.jpg (mobile shot), S01..S35
- docs/Arena3-Screen-Dictionary.pdf (final PDF, 37 pages)
- the real app routes are under src/routes/*.tsx — use them to FACT-CHECK every description.

The reader is a non-technical boss ("low tech") who must understand every screen from the picture + the text.

Do all of this:
1. LOOK at every screenshot (all 70). For each, flag: blank/skeleton/half-loaded state, mid-animation text, wrong page (redirect, login wall, 404), clipped/overflowing UI, English leftovers in a Vietnamese shot, empty states that make the screen look useless, or a shot that does not show what the description claims.
2. FACT-CHECK each Vietnamese description against the source route file: any button, tab, filter, feature or navigation path ("Tab …", "Menu avatar", "Tab Thêm → …") that does not exist or is named differently in the real UI. Quote the real label.
3. Check the document itself: missing screens (compare against all routes in src/routes), wasted space on pages, layout/typography problems, anything a first-time reader would not understand (jargon like "Mã thô", "đối soát").
4. Suggest concrete improvements (what to add: e.g. annotated callouts, a flow diagram, glossary, per-role walkthrough).

Output in Vietnamese, plain language. Format:
## Điểm (1-10) cho: độ chính xác, độ rõ cho người không biết kỹ thuật, bố cục, độ đầy đủ
## Lỗi (đánh số, mức Critical/High/Medium/Low) — mỗi lỗi: mã màn hình Sxx, bằng chứng (file/dòng hoặc tên ảnh), cách sửa cụ thể
## Màn hình thiếu
## Đề xuất cải thiện (top 8, theo thứ tự ưu tiên)
Be specific and cite evidence; no generic praise.
