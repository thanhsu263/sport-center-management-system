# Final pass — "can a first-time viewer understand each page without reading?"

Method: every page shot with all text blurred (scripts/ui-squint.mjs), judged on icons, pictures, layout and colour only.
Reviewers: Claude (own review of ~12 pages), Grok (all 31 desktop pages, see council-grok.md). Antigravity returned no usable answer.

Result (Grok): 12 pages scored 5/4 at a glance, most others 3-4; the 5 weakest were
member Train (empty), desk Classes (no pictures), manager Staff (chart picture), manager Attendance, manager Audit.

Fixed in this pass
- Staff page now shows a people picture instead of a bar chart.
- Coach attendance: Present/Late/Absent/Excused each have an icon and a colour (green tick, amber clock, red cross, dark note).
- Member header: Assistant / Notifications pages no longer light up the "Schedule" tab.
- Vietnamese: money uses 8.580.000đ, hero headline keeps its diacritics, nav buttons no longer wrap, "Pass" tab = "Mã QR".
- Build fix: i18n file vi.server.ts renamed vi.srv.ts (Vite refused to bundle *.server.* files for the browser).

Left as is (data-dependent, not layout): empty states on Train / Attendance / Audit when there is no data; desk Classes has no sport photos.
