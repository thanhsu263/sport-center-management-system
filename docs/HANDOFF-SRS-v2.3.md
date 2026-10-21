# HANDOFF — Restructure the Arena 3 SRS to the FPT template (v2.2 → v2.3)

> [!NOTE]
> Superseded in part by v2.4: day pass removed, BR-44 = open shift.

Read this file first, then `docs/SRS-FPT-Template-Rules.md` (403 lines, the binding spec) and `CLAUDE.md`.
Repo: `D:\learning material\Arena 3` (GitHub `facingshootingstar/Arena3`, branch `working`, merged to `main`). Date of handoff: 2026-10-12.

## 1. Task (from the user, Vietnamese)

"Nhiệm vụ: cấu trúc lại SRS Arena 3 cho đúng FPT template, tuân thủ TUYỆT ĐỐI file quy tắc `docs/SRS-FPT-Template-Rules.md`."
Targets: the Claude Docs project `ef2ef169-beab-4a4d-8c61-e3a8ad8ea5f8` (node `139b2b45-f82b`, engine `prose`) and the PDF `docs/Arena3-SRS-v2.3.pdf`.

### Group info (use exactly this, nothing else)
- Title: **Sport Center Management System**.
- Group Members in this order: Nguyễn Văn Trọng Hiếu; Đặng Trang Thanh Sử; Nguyễn Trọng Toàn; Phạm Duy Tân; Nguyễn Hoàng Phúc.
- Supervisor: Tôn Thất Hoàng Minh.
- NO MSSV, NO "(Leader)", NO Ext Supervisor, NO Capstone Project code. Keep Vietnamese diacritics.
- Cover bottom line: `- HCM, 10/2026 -`.
- The project name appears only on the cover and in the document title. The body keeps calling the system "Arena 3" (current text spells it "Arena3") and keeps the spelling "Centre".

### Order of work
1. Count baseline — DONE.
2. Build the 9 new figures and report each `.drawio` path — DONE (see §4).
3. Edit the doc per rules sections 1→2→3→4→5 and the section 3 mapping. **Only move, reformat or rename; never delete or rewrite business content.** — NOT STARTED (doc untouched, rev 30).
4. Add a Record of Changes row, version 2.2 → 2.3, e.g. "Restructured to the FPT SRS/SDD template", plus any business-content correction made to match the code.
5. Export the PDF to `docs/Arena3-SRS-v2.3.pdf`: A4 portrait, no rotation, footer "Page N of M"; update `cover.html`.
6. Run the rules §9 checklist, fix every FAIL, deliver only when all PASS.

### Prohibitions (verbatim)
- "Không bịa bất kỳ thông tin nào ngoài phần THÔNG TIN NHÓM ở trên."
- "Không xoay trang hoặc hình; không dùng Mermaid; không vẽ hình ngoài builder."
- "Không thêm thứ gì ngoài mục 10 'Mở rộng được phép' khi chưa hỏi tôi."
- "Không đăng nhập bằng mật khẩu thật lên arena3-self.vercel.app để chụp màn hình. Chụp từ bản chạy localhost với tài khoản seed; nếu không chụp được thì để placeholder và báo lại."
- "Không git commit / push trừ khi tôi yêu cầu."
- CLAUDE.md diagram rules: draw.io XML only, no XML comments, `mxGeometry` on every cell, `vertex="1"`/`edge="1"`, unique ids, valid edge source/target, no overlaps, academic English labels, always report the `.drawio` path.

### Final report to the user (Vietnamese, short)
- Counts before/after table.
- New figures with `.drawio` paths.
- Checklist PASS/FAIL per item.
- Remaining image placeholders.
- New PDF path.
- Deviations to mention:
  - Logical ERD is split into 5 figures for A4 readability.
  - The real schema is in `migrations/*.sql` (49 tables), not `src/lib/db.ts` as the rules say.
  - The prose says "Ten background jobs" but the table has 11 rows.
  - Figure count goes from 27 to 36.
  - 30 FKs are not drawn as lines, only listed in the boxes.
  - Bare error codes (VALIDATION etc.) in flows cite the 5.2 Error Responses code instead of a Message ID, because the message count must stay 21.

## 2. Current state

- Docs doc is **unchanged, rev 30**; the original content is intact. Everything is shared, so re-read with `{"kind":"view","sinceRev":N}` before editing.
- All source material was read. The plan below was designed but **no generator (`gen_srs.py`) exists yet**.
- Local artefacts (committed under `scripts/srs_pipeline/`): `doc-nb.txt` = markdown export of the old doc (rev 27, 1533 lines, 105 KB), `blobs.txt`, `make_html.py`, `merge.py`, `print.js`, `find_pages.py`, `cover.html`, `deps.py`, `br_map.py`, `outline.py`.
- Previous PDFs for reference: `docs/Arena3-SRS-v2.0/2.1/2.2.pdf`.

## 3. Docs tool facts (learned by testing)

- Project container `{"kind":"project","id":"ef2ef169-beab-4a4d-8c61-e3a8ad8ea5f8"}`; update/read `ref` = `{"object":"node","id":"139b2b45-f82b"}`; block-id prefix `mvjtsatwgd2`.
- `read`: `{"kind":"view","outline":true}`, `{"kind":"view","sinceRev":N}`, `{"kind":"view","parentId":…}`, `search`, `history`.
- `update` ops: `insert`, `replace`, `delete`, `move`, `set`. Max 64 ops per call. Whole-block replace/delete needs `ifHash` + `ifRev`; a multi-id delete takes `ifRev` alone. `guard_mismatch` = block changed, re-read, don't force.
- `insert`: `target {"kind":"root"}` + `side:"end"`, or `{"kind":"blocks","ids":[…]}` + `side:"after"`. Source `{"as":"markdown","from":{"kind":"inline","content":…}}`, or `as:"blocks"` with JSON nodes (`row`→`cell`→`paragraph`→`text`) for appending table rows. Content must be inline (no file input).
- Multi-line cell replace (confirmed): `{"op":"replace","target":{"kind":"cell","table":"<table id>","row":<int>,"col":<int>},"ifRev":<rev>,"with":{"as":"markdown","from":{"kind":"inline","content":"Sentence.\n\n- Primary Key: id\n- Foreign Key: None"}}}` (0-based; header = row 0; -1 = last). Emits a harmless `dropped_with` notice.
- Markdown quirks: pipe tables work (header cells `header='true'`, one paragraph per cell); `<br>` in a cell stays literal; a 4-space-indented line becomes a code block; inline code, bold, nested bullets work.
- Images: upload one per call with the Artifact tool (`asset:true`) onto `https://claude.ai/code/artifact/ef2ef169-beab-4a4d-8c61-e3a8ad8ea5f8`, then create a blob; cite as `![alt](blob/<id>)`. Never web-fetch doc links. A tab always keeps ≥1 block.
- `export` returns a huge JSON saved to a file; decode `data.bytes_b64` with Python.
- Set `PYTHONIOENCODING=utf-8` for Vietnamese output; write Python to files rather than Bash heredocs with backslashes.

## 4. Figures

Builder: `python scripts/srs_diagrams/build.py [filter] [--no-png]`, output `docs/diagrams/srs/`; `lib.py check()` must pass (all 36 do).

| Source file (docs/diagrams/srs/) | Becomes |
|---|---|
| 01-context-diagram | Fig 1 |
| 03..10-uc-* (8 files) | Figs 2–9 (2.2.1.1–8) |
| 24..28-sf-* (5 files) | Figs 10–14 screens flow (3.1.1.1–5) |
| 19-erd-conceptual | Fig 15 |
| 31..35-erd-logical-1..5 | Figs 16–20 |
| 11-ad-register, 12-ad-book-and-pay, 13-ad-enrol-waitlist, 14-ad-refund | Figs 21–24 inside UC-02, UC-08, UC-13, UC-24 |
| 38-system-architecture | Fig 25 |
| 39-package-diagram | Fig 26 |
| 20-cd-booking-payment | Fig 27 |
| 16-sd-book-and-pay, 18-sd-refund | Figs 28, 29 (II.3.1.2) |
| 21-cd-membership-classes | Fig 30 |
| 36-sd-enrol-class | Fig 31 (II.3.2.2) |
| 22-cd-coaching | Fig 32 |
| 37-sd-take-attendance | Fig 33 (II.3.3.2) |
| 23-cd-operations | Fig 34 |
| 15-sd-register, 17-sd-gate-checkin | Figs 35, 36 (II.3.4.2) |

Caption below, centred, `Figure N. Title`; continuous from 1; each figure mentioned in text before it appears; List of Figures matches. Old PNG→blob ids are in `scripts/srs_pipeline/blobs.txt` (27 old); the 9 new PNGs (`31`–`39`) still need upload + blob. Old blob ids: context `8ce143c9-2ad7`; activity `6c68d614-3729`, `aeaae399-8609`, `09cde083-8df1`, `173918d3-0af7`; UC `863394a5-8261`, `20eb16a8-7f6e`, `bd407701-78f0`, `35bcbef8-b4d1`, `810e856d-b2f6`, `8e53916e-65a1`, `445a9577-b114`, `d641d028-e2ce`; screens `c93173b7-5eb7`, `43e9031d-467e`, `0a5c2780-becb`, `79aa3c32-5dd8`, `c86dedfc-1269`; ERD `23bf0aeb-1913`; class `39193b4d-04c1`, `d85aa569-6679`, `3862f629-d030`, `3ba4b78a-b00d`; sequence `7bc1fa05-ef17`, `929915ee-935b`, `a351651f-9611`, `d186ec08-cb9e` (confirm mapping with `blobs.txt`).

## 5. Target structure (rules §2, Title Case)

Front matter: Cover, Record of Changes (+ footnote `*A – Added, M – Modified, D – Deleted`), generated TOC, generated List of Figures, Definition and Acronyms (`Acronym | Definition`; must include API, BR, ERD, NFR, OTP, QR, SDD, SRS, UC, UI, VND, SMTP, AI, JSON, HTTPS plus any others used). No Acknowledgement.

**Part I SRS**
- 1 Product Overview — opening paragraph, then context diagram + Portal table + external-entity table (no sub-heading), "Out of scope" paragraph last.
- 2 User Requirements — 2.1 Actors; 2.2 Use Cases: 2.2.1 Diagram(s) with 2.2.1.1–8 = Account and Access, Member Court Booking and Payment, Member Classes and Training, Front Desk Sales, Front Desk Operations, Coach, Manager Setup, Manager Oversight; 2.2.2 Descriptions.
- 3 Functional Requirements
  - 3.1 System Functional Overview: 3.1.1 Screens Flow (3.1.1.1–5: Public Site, Member Portal, Front Desk Portal, Coach Portal, Manager Portal); 3.1.2 Screen Descriptions (3.1.2.1–5, same order); 3.1.3 Screen Authorization; 3.1.4 Non-Screen Functions; 3.1.5 Entity Relationship Diagram (3.1.5.1 Conceptual, 3.1.5.2 Logical, unnumbered "Entities Description").
  - 3.2 Account and Access = UC-01..06 (3.2.1–6); 3.3 Member Court Booking and Payment = UC-07..12; 3.4 Member Classes and Training = UC-13..17; 3.5 Front Desk Sales = UC-18..24; 3.6 Front Desk Operations = UC-25..29; 3.7 Coach Teaching and Earnings = UC-30..35; 3.8 Manager Setup = UC-36..40; 3.9 Manager Oversight = UC-41..44.
  - 3.x.y heading = UC name in Title Case, no UC code. The name must match word for word in the diagram oval, the 2.2.2 table and the heading.
- 4 Non-Functional Requirements — 4.1 External Interfaces (4.1.1 User Interface, 4.1.2 Communications Interfaces); 4.2 Quality Attributes (4.2.1 Usability, 4.2.2 Reliability, 4.2.3 Performance, 4.2.4 Security, 4.2.5 Auditability, 4.2.6 Maintainability). Each section opens with a purpose sentence (Usability and Auditability have none now — write one).
- 5 Requirement Appendix — 5.1 Business Rules; 5.2 Common Requirements (with unnumbered "Error Responses" and "Configurable Settings"); 5.3 Application Messages List.

**Part II SDD**
- 1 System Design: 1.1 System Architecture (Fig 25); 1.2 Package Diagram (Fig 26) + unnumbered "Package Descriptions" (`No | Package Name | Description`, 7 rows from `scripts/srs_diagrams/architecture.py: package_rows()`).
- 2 Database Design + "Table Descriptions" (all 49 tables from `dbschema.load()`; format `# | Entity | Description` with "Store … (table `x`)." + `Primary Key:` + `Foreign Key:` bullets).
- 3 Detailed Design: 3.1 Booking and Payment; 3.2 Membership and Classes; 3.3 Coaching and Training; 3.4 Centre Operations — each with 3.x.1 Class Diagram and 3.x.2 Sequence Diagram.

## 6. Old → new mapping (rules §3)

- Context diagram + Portal table + external-entity table → I.1.
- 4 activity diagrams (Figs 2–5 + paragraphs) → Function Details of UC-02 (3.2.2), UC-08 (3.3.2), UC-13 (3.4.1), UC-24 (3.5.7).
- Class diagrams: booking & payment → II.3.1.1; membership & classes → II.3.2.1; coaching & training → II.3.3.1; centre operations → II.3.4.1 (with their "Figure N covers…" paragraphs).
- Sequence: Register → II.3.4.2; Book & pay → II.3.1.2; Refund → II.3.1.2; Gate check-in → II.3.4.2; new Enrol → II.3.2.2; new Attendance → II.3.3.2.
- IV.1.3 error codes → 5.2 "Error Responses"; V.2 settings → 5.2 "Configurable Settings"; V.3 common requirements → 5.2 (open with 2 bullets: User Login / User Authorization, then the table); the second authorization table (Action / Allowed roles / Refused with) → 5.2.
- IV.1.1 → 4.1.1; IV.1.2 → 4.1.2; IV.2.x → 4.2.x (Correctness and reliability → Reliability; Security and privacy → Security); keep NFR codes.
- Where the old doc lines are (`doc-nb.txt`): Part I L12–55; Part II (actors, UC diagrams, UC list) L56–134; Part III.1 (screens flow, screens table, authorization, non-screen, ERD, class diagrams) L135–255; 44 UC specs L256–1342 (UC-01 at 259, 02 at 282, 03 at 315, 04 at 341, 05 at 365, 06 at 389, 07 at 411, 08 at 434, 09 at 474, 10 at 502, 11 at 529, 12 at 553, 13 at 575, 14 at 602, 15 at 626, 16 at 646, 17 at 668, 18 at 690, 19 at 712, 20 at 739, 21 at 767, 22 at 795, 23 at 821, 24 at 846, 25 at 874, 26 at 898, 27 at 927, 28 at 954, 29 at 978, 30 at 1001, 31 at 1022, 32 at 1047, 33 at 1072, 34 at 1094, 35 at 1118, 36 at 1137, 37 at 1163, 38 at 1186, 39 at 1208, 40 at 1234, 41 at 1256, 42 at 1278, 43 at 1301, 44 at 1323); Part IV L1343–1419; Part V L1420–1533 (BR L1425–1477, settings L1481–1494, common reqs L1497–1509, messages L1513–1533).
- Known old block ids: Record-of-changes table `.181`, product overview paragraph `.865`, Portal table `.1101`, context paragraph `.126123`, external-entity table `.2139`, actors `.4533`, UC list `.53681`, screens `.10794`, authorization tables `.15396` and `.15963`, non-screen `.16760`, ERD table `.18366`, UC-01 heading `.67103` (prefix `mvjtsatwgd2`). Get the rest from an outline read.

## 7. Table formats (rules §4) and UC block (rules §5)

- General: bold shaded header, full borders, no empty cells (except the `x` matrix), no captions.
- Actors `# | Actor | Description` with kind first ("Abstract actor. …"); order Guest, Registered User, Member, Receptionist, Coach, Manager, payOS, Mail delivery (SMTP), Gemini AI.
- UC descriptions `ID | Use Case | Actors | Use Case Description` (44 rows; actors = primary + secondary).
- Screen Descriptions: 5 tables `# | Feature | Screen | Description`, route in the screen name e.g. `Book a court (/app/book)`, numbering restarts at 1.
- Screen Authorization `Screen | Guest | Member | Receptionist | Coach | Manager`, `<<Screen Name>>` header rows with indented function rows, lowercase `x`, blanks allowed only here, all 44 screens.
- Non-Screen `# | Feature | System Function | Description` (trigger goes in the first sentence; job-loop paragraph stays below).
- BR `ID | Rule Definition` (each BR cited by ≥1 UC "Business Rules" row; money formulas multi-line; 53 BR).
- Messages `Message ID | Message Text | Message Type | Context/Trigger`; ID `<PREFIX>_<AREA>_<NN>`; PREFIX ∈ MSG, ERR, INFO, WARN; AREA ∈ AUTH, PROF, BOOK, PAY, PLAN, CLASS, CHECKIN, GEAR, MAINT, SUPPORT, COACH, ADMIN, REPORT; type ∈ Success/Error/Validation/Information/Warning; context `<Screen> (<action>)` + "(was MSG01; BR-01)". All old codes in the body must be replaced; every Message ID cited by ≥1 flow; count stays 21.
- NFR `ID | Requirement` (26).
- **UC block, in this order:** `● Function Trigger`; `● Function Description` (Use Case ID, Actors incl. "Secondary: …", Purpose, Interface matching 3.1.2); `● Data Processing` (Data Collect / Data Computation / Data Storage, or Data Binding if read-only); `● Screen Layout` (screenshot with alt not starting "Figure", or `N/A – reason`); `● Function Details` = Field/Detail table (12 rows: ID and Name, Created By, Date Created, Primary Actor, Secondary Actors, Trigger, Description, Preconditions PRE-n, Postconditions POST-n, Priority, Frequency of Use, Business Rules) → Normal Flow `n.0` → Alternative Flows `n.1…` (each ends "Return to step k of the Normal Flow." or an explicit end) → Exceptions `n.0.E1…` (steps marked "(see n.0.E1)"); activity diagram for UC-02, UC-08, UC-13, UC-24. Errors cite Message IDs or BR codes. Keep the "Other information" rows of UC-06/11/26/29 somewhere.
- Style: short active sentences, "must" (no should/may), consistent actor names, one currency form (1,000,000đ), 24h time, YYYY-MM-DD dates.

### Message mapping (old → new)
MSG01 ERR_AUTH_01 · MSG02 ERR_AUTH_02 (Validation) · MSG03 ERR_AUTH_03 · MSG04 ERR_AUTH_04 · MSG05 ERR_BOOK_01 · MSG06 WARN_BOOK_01 (Warning, was "Confirmation") · MSG07 ERR_BOOK_02 · MSG08 ERR_BOOK_03 · MSG09 ERR_BOOK_04 · MSG10 ERR_PAY_01 · MSG11 ERR_CLASS_01 · MSG12 ERR_CLASS_02 · MSG13 ERR_PAY_02 · MSG14 ERR_CHECKIN_01 · MSG15 ERR_PAY_03 · MSG16 ERR_PAY_04 · MSG17 ERR_PAY_05 · MSG18 ERR_COACH_01 · MSG19 ERR_AUTH_05 (generic FORBIDDEN) · MSG20 ERR_AUTH_06 (generic RATE_LIMITED) · MSG21 ERR_GEAR_01.

### Message → flow citation plan
MSG01 → UC-02 3b, UC-19, UC-36 · MSG02 → UC-02 3c, UC-04, UC-05 · MSG03 → UC-02 6c, UC-04 · MSG04 → UC-03 2b · MSG05 → UC-08 2b · MSG06 → UC-08 2a · MSG07 → UC-08 3d / UC-21 3d · MSG08 → UC-08 8a · MSG09 → UC-08 3c / UC-21 3c · MSG10 → UC-08 4a / UC-10 3c · MSG11 → UC-13 2a · MSG12 → UC-14 3a · MSG13 → UC-20 3b / UC-21 4a / UC-22 3a (BR-44) · MSG14 → UC-26 3a / UC-12 3c · MSG15 → UC-24 3a · MSG16 → UC-42 3b · MSG17 → UC-42 3c · MSG18 → UC-31 1b · MSG19 → UC-03 2c and other FORBIDDEN cases · MSG20 → UC-17 2a / UC-10 3e · MSG21 → UC-27 3a.

## 8. Plan (what to do next)

1. Write `gen_srs.py` (scratch dir). It parses `scripts/srs_pipeline/doc-nb.txt` by the line ranges above, uses `dbschema.load()` for PK/FK and `architecture.package_rows()`, applies a hand-written per-UC extras table (Interface = screen from 3.1.2, Data Collect/Computation/Storage derived from each UC's flows, Screen Layout or `N/A – reason`), maps messages, splits Pre/Postconditions into PRE-n/POST-n, numbers flows `n.0` / `n.1…` / `n.0.E1…`, replaces bare codes (VALIDATION, UNAUTHENTICATED, FORBIDDEN, CONFLICT_STATE, CONFLICT_SLOT, HOLD_EXPIRED, RATE_LIMITED, "C-08 or C-09") with Message IDs / BR codes / the 5.2 Error Responses code, unifies secondary-actor names, and preserves "Other information" rows.
2. Validate: 9 actors, 44 UC, 53 BR, 26 NFR, 21 messages, 44 screens, 11 non-screen functions, ≥17 entities, 49 tables, 36 figures; every BR cited by a UC; every Message ID cited by a flow; figures mentioned before appearing; numbering continuous.
3. Emit markdown chunks of ~8–12 KB. Insert each at root end in order (Record of Changes table `.181` stays: append the footnote and a new row via `insert as:"blocks"` on the table id). Use single-paragraph fallbacks for multi-line cells ("PRE-1: … PRE-2: …"), then optionally upgrade with the cell-replace op.
4. Upload the 9 new PNGs (one per call) and create blobs; append to `blobs.txt`.
5. Delete the old blocks ("## I. Overall requirements" … end of old content) by id with a multi-id `delete` + `ifRev`.
6. PDF: export the doc to `srs-export.html`; `python make_html.py <out.html>` (pass 1); `node print.js <in.html> <out.pdf>`; `python find_pages.py <pass1.pdf> pages.json`; re-run `make_html.py <out.html> pages.json`; `node print.js … --plain`; `python merge.py <cover.pdf> <body.pdf> <out.pdf> pages.json final.html`. Needed edits: bump `Version 2.2` → `2.3` in `merge.py`, `print.js`, `make_html.py`; remove the `<th>Figure</th>` hack (~lines 62–64); handle h2–h5 (regex is `<h([2-4])`); parse alt `Figure N. Title`; do not treat Screen Layout images (alt not starting "Figure") as figures; adapt the doc-title/byline strip; rewrite `cover.html` (FPT logo from `docs/FPT template` R7 p.1, "MINISTRY OF EDUCATION AND TRAINING", "FPT UNIVERSITY", "Software Requirement Specification", "Sport Center Management System", a 2-row table Group Members / Supervisor, `- HCM, 10/2026 -`). Output `docs/Arena3-SRS-v2.3.pdf`.
7. Run rules §9, fix FAILs, then send the Vietnamese report (§1). Do **not** `git commit` / `git push` unless the user asks.

## 9. Facts about the real system (for correctness)

TanStack Start (SSR); `/v1/$` → `handleApi` in `src/lib/arena3/router.ts`; handlers in `src/lib/arena3/handlers/*`; Neon PostgreSQL or embedded PGlite (`src/lib/db.ts`); schema in `migrations/*.sql` (49 tables); `jobs.ts` runs every 15 s; `notify.ts` (SMTP); `payos.ts`; `gemini.ts`.

## 10. Open points

- Content of the Definition and Acronyms table.
- Screen Layout screenshots: take from localhost with seed accounts (never the real login on arena3-self.vercel.app); if not possible, `N/A – reason` or a placeholder and report it.
- Purpose sentences for 4.2.x sections that lack one.
- "Ten background jobs" vs 11 table rows (report, don't silently change).
