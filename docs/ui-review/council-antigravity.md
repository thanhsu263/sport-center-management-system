### 1. Verdict Scores (out of 10)

* **Clarity of purpose per section: 6/10** — Section icon badges and subtitles help hierarchy, but English-only phrasing and self-evident hints (e.g. *"Shortcuts to the things you do most"*) add visual noise rather than domain clarity.
* **Illustration quality & usefulness: 5/10** — Empty-state SVGs ([`EmptyState`](file:///D:/learning%20material/Arena%203/src/components/ui/index.tsx#L259-L280)) communicate purpose well, but header-card spot art ([`Spot`](file:///D:/learning%20material/Arena%203/src/components/illustrations.tsx#L251-L264)) is purely decorative and consumes excessive vertical screen real estate.
* **Long-list handling: 6.5/10** — Transitioning 1,000 members into a structured table with counts and pagination is a major structural win, but 25 items per page pushes controls far below the fold.
* **Mobile ergonomics: 4/10** — Pervasive vertical crowding: giant headers, photo banners, and filter chips consume over 50% of the viewport, while the floating bottom dock obscures critical form actions.
* **Accessibility: 5/10** — Spot SVGs are hidden from screen readers properly, but mobile attendance buttons fail 44px touch-target standards and lack `aria-pressed` semantic state.
* **Consistency: 6/10** — Visual design tokens and card styling are cohesive, but language mixing (Vietnamese names/currency vs. English-only chrome) and uneven filter chip features create friction.

---

### 2. Top 8 Problems (Ranked by Severity)

1. **[CRITICAL] Mobile Viewport Cannibalized by Decorative Headers & Filter Stacks**
   * **Where:** [`src/components/shell.tsx:466-480`](file:///D:/learning%20material/Arena%203/src/components/shell.tsx#L466-L480), [`src/routes/manager.index.tsx:182-240`](file:///D:/learning%20material/Arena%203/src/routes/manager.index.tsx#L182-L240) (`manager-manager-mobile.png`, `member-app-book-mobile.png`).
   * **What:** The 160px+ header card with SVG spot art, photo banners, and multi-line date pickers consume 55–65% of the mobile viewport (390×844), forcing actual reports, court grids, and member lists completely below the fold.
   * **Concrete fix:** On mobile (`<md`), hide the SVG illustration, strip the photo banner, compact the header into a single line, and place secondary filters into a collapsible drawer.

2. **[CRITICAL] Language & Mental Model Barrier for Vietnamese Staff (Nielsen H2)**
   * **Where:** [`src/components/section.tsx:35-62`](file:///D:/learning%20material/Arena%203/src/components/section.tsx#L35-L62), [`src/components/shell.tsx:57-97`](file:///D:/learning%20material/Arena%203/src/components/shell.tsx#L57-L97) (`receptionist-desk-desktop.png`, `coach-coach-attendance-desktop.png`).
   * **What:** While names and currency are Vietnamese, all system labels, hints, and navigation are English (*"At risk"*, *"Close the books"*, *"Through the gate today"*, *"Excused"*). A non-technical front-desk worker cannot parse these in 5 seconds.
   * **Concrete fix:** Replace hardcoded English strings with standard Vietnamese sports management terms (*"Hội viên vắng/nguy cơ"*, *"Chốt sổ ca"*, *"Check-in vào cổng"*, *"Có phép"*).

3. **[MAJOR] Attendance Buttons Fail Touch Targets & Missing States (WCAG 2.2 SC 2.5.8 & 4.1.2)**
   * **Where:** [`src/routes/coach.attendance.tsx:190-211`](file:///D:/learning%20material/Arena%203/src/routes/coach.attendance.tsx#L190-L211) (`coach-coach-attendance-mobile.png`).
   * **What:** Four status buttons (`Present`, `Late`, `Absent`, `Excused`) sit in a tight 36px-high container (`min-h-9`, `px-2`), with "Late" measuring ~41px wide, risking frequent mis-taps during active floor coaching. Buttons also lack `aria-pressed`.
   * **Concrete fix:** Increase target size to `min-h-11` (44px min height), add `aria-pressed={marks[u.id] === r.v}`, and style them as a clear segmented control with distinct color accents.

4. **[MAJOR] Floating Bottom Dock Obscures Page Action Buttons**
   * **Where:** [`src/components/shell.tsx:487-541`](file:///D:/learning%20material/Arena%203/src/components/shell.tsx#L487-L541) (`receptionist-desk-mobile.png`, `member-app-pass-mobile.png`).
   * **What:** The fixed floating dock + `GradualBlur` (5.5rem height) floats over bottom content, obscuring the "Create profile" button on `/desk` and the "Check yourself in" button on `/app/pass`.
   * **Concrete fix:** Add explicit bottom padding (`pb-28`) to main container elements when `showNav` is active, and ensure form submit actions remain above the dock boundary.

5. **[MAJOR] Redundant "Quick Actions" Cluttering Member Home (Nielsen H8)**
   * **Where:** [`src/components/section.tsx:36`](file:///D:/learning%20material/Arena%203/src/components/section.tsx#L36), [`src/routes/app.index.tsx`](file:///D:/learning%20material/Arena%203/src/routes/app.index.tsx) (`member-app-mobile.png`).
   * **What:** The 2×2 "Quick actions" grid (`Book a court`, `Classes`, `Plans`, `Ask AI`) exactly mirrors the dock items directly below it, displacing the user's actual daily schedule.
   * **Concrete fix:** Remove the "Quick actions" grid from the member index; highlight immediate context instead (e.g. today's scheduled court or quick gate QR pass).

6. **[MAJOR] Member Pagination Buried Under 25 Rows**
   * **Where:** [`src/routes/manager.members.tsx:26, 158`](file:///D:/learning%20material/Arena%203/src/routes/manager.members.tsx#L26) (`manager-manager-members-desktop.png`).
   * **What:** `PAGE = 25` generates an ~1,800px vertical list. Users must scroll through multiple viewport heights just to navigate between pages.
   * **Concrete fix:** Lower default `PAGE` to 10 or 15 on mobile/compact viewports, or affix the pagination toolbar to the bottom of the table card.

7. **[MINOR] Ambiguous Adjacent Filter Groups on Payments**
   * **Where:** [`src/routes/desk.payments.tsx`](file:///D:/learning%20material/Arena%203/src/routes/desk.payments.tsx) (`receptionist-desk-payments-desktop.png`).
   * **What:** Payment method filters (`All Cash Card...`) and timeframe filters (`7 days 14 days...`) sit side-by-side using identical pill styling without category labels, causing visual ambiguity.
   * **Concrete fix:** Separate into distinct rows or provide explicit group kickers: *"Phương thức"* and *"Thời gian"*.

8. **[MINOR] Inconsistent Filter Chip Counts**
   * **Where:** [`src/routes/manager.members.tsx:69-83`](file:///D:/learning%20material/Arena%203/src/routes/manager.members.tsx#L69-L83) vs [`src/components/attendance-panels.tsx:280-287`](file:///D:/learning%20material/Arena%203/src/components/attendance-panels.tsx#L280-L287).
   * **What:** At-risk chips display live item counters (`To call 169`), whereas member plan chips display labels only, failing to give managers high-level distribution metrics.
   * **Concrete fix:** Pass summary counts from `/directory/members` into `FilterChip` on the manager members screen.

---

### 3. What Is Genuinely Good

* **Table Structure on Members List:** Replacing unbounded floating cards with a single unified table card ([`manager-manager-members-desktop.png`](file:///D:/learning%20material/Arena%203/docs/ui-review/v3/manager-manager-members-desktop.png)) with explicit column headers and status badges dramatically improves scannability.
* **Contextual Empty States:** Empty states ([`src/components/ui/index.tsx:259`](file:///D:/learning%20material/Arena%203/src/components/ui/index.tsx#L259)) feature route-appropriate SVG art and actionable recovery buttons (e.g. *"Browse plans"*, *"Show everyone"*) rather than dead ends.
* **Informative KPI Cards:** KPI stats ([`src/components/ui/index.tsx:509`](file:///D:/learning%20material/Arena%203/src/components/ui/index.tsx#L509), [`manager-manager-desktop.png`](file:///D:/learning%20material/Arena%203/docs/ui-review/v3/manager-manager-desktop.png)) cleanly combine high-contrast values, semantic delta arrows, and plain-language definitions (*"Payments taken, minus refunds"*).
* **Lightweight SVG Architecture:** All illustrations in [`src/components/illustrations.tsx`](file:///D:/learning%20material/Arena%203/src/components/illustrations.tsx) use lightweight, inline vector code tied to CSS variables with no external image requests and proper screen-reader hiding (`aria-hidden="true"`).

---

### 4. Recommendation & Next Step

**Do NOT ship yet.** The single most valuable next change is to **localize all front-desk, coach, and member UI copy into Vietnamese and collapse decorative header cards on mobile viewports** so staff and members can immediately read and interact with operational data without scrolling.
