I'll evaluate the real screenshots and the section/illustration source, read-only, and score hierarchy, density, and whether a front-desk worker can scan each page in a few seconds.## 1. Scores

| Criterion | Score | Why |
|---|---|---|
| Clarity of purpose per section | **6/10** | Headers and one-line hints say what a screen is, then say it again. A Vietnamese desk worker still meets English such as "At risk" and "Close the books". |
| Illustration quality & usefulness | **5/10** | The flat SVG set matches the green/amber palette, and almost none of it teaches the task. Photos repeat and push real controls down. |
| Long-list handling | **6/10** | 1,051 members is now a 25-row table with chips. Class, plan, price and coach lists are still long pages (`heights.json`: classes mobile 5545px, prices mobile 4136px, coach attendance mobile 6904px). |
| Mobile | **5/10** | Desk and coach docks are usable. Member titles break, chips clip, and the reports number sits under a photo and a broken filter row. |
| Accessibility | **7/10** | Ink `#2c3429` on cream `#fffaf2` is strong, and `:focus-visible` is global (`src/styles.css:259`). Chips and segments are 36px (`min-h-9`), under a 44px touch target. Dock labels are 10px. |
| Consistency | **6/10** | One header card, one chip, one palette. Counts, pagination, money grouping and photo-vs-spot usage change from page to page. |

## 2. Top 8 problems

1. **Critical** — `member-app-plans-mobile.png`, `shell.tsx:466-478`, `fx.tsx:371-379`. The page title is split into characters (`splitBy="chars"`) and placed beside an 80px spot, so "Membership plans" paints as "Members / hip plans". Split titles by word, and on a phone put the spot under the title or remove it.

2. **Major** — `manager-manager-mobile.png`, `manager.index.tsx:182-196`. The new header card is stacked on the hall photo that was already there. Today / 7 days / This month / Custom / From / To / All methods break into separate rows, and 8,580,000đ is the last thing above the dock. Keep one compact filter row and one picture.

3. **Major** — `desk.payments.tsx:318`, reports KPI notes, desk search helper on `receptionist-desk-desktop.png`, `section.tsx:35-61`. The fix restates one fact three times (subtitle, banner, section paragraph). The search box already says "Name, phone or member code", then a sentence repeats it. Keep a single line per block.

4. **Major** — `app.classes.tsx:121` (`h-36` photo per class), `coach.index.tsx:78`, `manager.prices` (2546px desktop). Pagination exists only for members (`PAGE = 25`), at-risk (20) and receipts (15). The same smash photo is repeated on every card of that sport, so catalogues got taller. Use one photo per sport and a compact row for rates and classes.

5. **Major** — `member-app-classes-mobile.png`, `manager-manager-settings-mobile.png`, `manager-manager-members-mobile.png`, `receptionist-desk-at-risk-mobile.png`. "Volleyball" drops onto its own line inside the pill. "Ends this week" and "Everyone" are cut off with no scroll cue (`manager.members.tsx:79`, `overflow-x-auto`). Keep filters on one scrolling row with a fade.

6. **Major** — `shell.tsx:57-63` and `:502`. The member dock shows all six tabs at `text-[10px] uppercase tracking-wider`. The comment above that list already says seven tabs were too small to read. Use four items plus More, as the manager shell does.

7. **Major** — `labels.ts` and every route subtitle, against `receptionist-desk-at-risk-mobile.png` and `manager-manager-settings-mobile.png`. The working language is English ("At risk", "Plan hours used", "F4 · Register & session plans", "Gemini") while names, phones and "6tr" are Vietnamese. Amounts use US commas plus "đ" (`8,580,000đ`). Desk and manager copy should be Vietnamese, with `vi-VN` grouping.

8. **Minor** — `illustrations.tsx:267-297` and `ui/index.tsx:274`. `/desk`, members, account and student share one "people" drawing. `/app` and Book a court share the court drawing, and Book adds a photo too. Empty states reuse the page spot, so Gate shows the phone twice (`receptionist-desk-gate-desktop.png`). The receipt spot's ₫ reads as a Latin "d". Use the `empty` tray for empty states, and one distinct spot per job.

## 3. What is good

- Members is a real fix: chips, a column table, "1,051 members", 25 per page (`manager.members.tsx:26-158`), versus the old full-width cards in `before/manager-manager-members-desktop.png`.
- At risk is the clearest operational screen: "To call 169", "Already contacted 0", one status, one "Log a contact" (`receptionist-desk-at-risk-mobile.png`).
- The coach register is task-shaped: session, "Present 10 · Late 0 · Absent 0 · Excused 0", and a red minor warning (`coach-coach-attendance-mobile.png`).
- Cream, ink and green hold together, buttons are pills, and the focus ring is one system (`styles.css:259`).

## 4. Ship?

Do not ship the phone layout yet. The single most valuable next change is to let page titles wrap by word and move the header spot out of the title line, then delete every hint that repeats the subtitle.
