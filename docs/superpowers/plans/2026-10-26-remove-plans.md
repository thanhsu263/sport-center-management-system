# Remove Plans (Sell Courses, Part 2) Implementation Plan

> **For agentic workers:** Execute ONE task (the one you were given). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Nothing in the app sells, reads or spends a membership plan any more. Courts are paid per booking, classes are bought one by one (part 1), and the gate admits whoever has a booking or a class today.

**Architecture:** Delete plan code paths in the server handlers and the client screens. Keep the `membership_plans` and `subscriptions` tables, the `payments.ref_type = 'subscription'` value and the old `court_bookings.quota_hours` column untouched, because they hold history. No migration, no seed change.

**Tech Stack:** TanStack Router + React, Postgres (PGlite in tests), node:test via tsx.

**Spec:** this document (decisions below) plus part 1: `docs/superpowers/specs/2026-10-26-sell-courses-design.md`, section "Out of scope (part 2)".

## Decisions (the user delegated these: "chọn lựa chọn tối ưu nhất")

| Question | Decision |
|---|---|
| Court booking without plan hours | Every booking is paid at the slot price (promos still apply). No plan discount, no "use plan hours". |
| Gate | Entitled = has a confirmed court booking or a class session today. No membership warnings (`no_plan`, `frozen`, `expired`, `scheduled`, `expiring`, `no_sessions`) any more. |
| Members holding a live plan | The plan stops granting anything now. No refund, no conversion. |
| Data | Keep tables and columns. Old payments, audit rows and reports of past money stay readable (labels for `subscription` stay). |

## Global Constraints

- Do not edit `migrations/*` or seed data.
- `npx tsx --test src/lib/arena3/tx.test.ts` and `npm test` stay green after every task. A task that breaks an existing test because plans are gone deletes or rewrites that test in the same task.
- `npx tsc --noEmit` clean after every task.
- English copy first; when you remove an English UI string, remove its Vietnamese entry in `src/lib/i18n/vi.*.ts` if no other code uses it (grep first).
- Never mix GSAP and `motion` in one component; do not touch `fx.tsx`, `gl.tsx`, `motion.tsx`.
- Commit with `git add <your files by path>` only. Never stage `.claude/launch.json`. Commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Do not push.
- Old API routes that are removed simply fall through to the router's existing 404.

## Review Focus

1. A member who still has an `active` subscription row books a court: they pay the full slot price; nothing reads or decrements `court_hours_left`.
2. Cancelling an OLD booking that was paid with plan hours (`quota_hours > 0`): the cancel succeeds, no money refund is created, nothing writes to `subscriptions`.
3. `POST /v1/payments` with `ref_type: "subscription"` is refused with a 422 field error on `ref_type`; payOS webhook for an old subscription link does not crash (it is recorded as unmatched/ignored by the existing generic path or simply posts nothing).
4. Gate scan of a member with no booking and no class today: not entitled, and no plan warning text.
5. Members report: `active_members` counts members with a confirmed booking or confirmed enrolment in the range; it never queries `subscriptions`.

---

### Task 1: Courts without plans (server)

**Files:**
- Modify: `src/lib/arena3/pricing.ts` (delete `memberDiscount`)
- Modify: `src/lib/arena3/handlers/bookings.ts` (every `memberDiscount` call; `method === "quota"`; `plan_hours_left` in the hold response; the cancel branch for `quota_hours`; the "last court" close guard near line 460)
- Modify: `src/lib/arena3/handlers/courts.ts` (retire guard near line 160: drop the subscriptions part, keep the open-classes part)
- Modify: `src/lib/arena3/contracts.ts` (drop `plan_hours_left`)
- Modify: `src/lib/arena3/tx.test.ts`, `src/lib/arena3/arena3.test.ts` (tests that seed plans for court booking)

- [ ] Step 1: Write failing tests in `tx.test.ts`, new `describe("Remove plans: courts")`:
  - `RP-full-price`: seed a member WITH an active subscription row (court_discount_pct 20, court_hours_left 5), create a court hold; assert response `price === list_price` and body has no `plan_hours_left`; after confirming by desk/cash the subscription's `court_hours_left` is still 5.
  - `RP-no-quota`: confirming a hold with `method: "quota"` is rejected with status 422.
  - `RP-old-quota-cancel`: insert a confirmed booking with `quota_hours = 1`, `paid_vnd = 0` for a member with a subscription (court_hours_left 0); cancel it well ahead; assert success, no new row in `payments` for it, `court_hours_left` still 0.
- [ ] Step 2: Run `npx tsx --test src/lib/arena3/tx.test.ts` — new tests fail.
- [ ] Step 3: Implement. Price = list price (then promo) wherever `disc.pct` was applied. `quota` is no longer an accepted method: reject it the same way an unknown method is rejected (field error on `method`). Cancel: when `quota_hours > 0`, `refund = null` (comment: plan hours are history; plans no longer exist). Close/retire guards: only open classes block.
- [ ] Step 4: Delete or rewrite every existing test that relied on plan discount / plan hours for courts. Run full `npx tsx --test src/lib/arena3/tx.test.ts` and `npm test`: green. `npx tsc --noEmit`: clean (client files that read `plan_hours_left` may now fail tsc — if so, remove that read in `src/routes/app.book.tsx` minimally, e.g. treat hours as 0 / delete the "use plan hours" button, and include the file).
- [ ] Step 5: Commit "Charge every court booking at the slot price".

### Task 2: Stop selling plans (server)

**Files:**
- Delete: `src/lib/arena3/handlers/plans.ts`
- Modify: `src/lib/arena3/router.ts` (remove `/plans*`, `POST /subscriptions`, `/subscriptions/:id/freeze|unfreeze|decline` routes and the `planH` import)
- Modify: `src/lib/arena3/handlers/ops.ts` (delete `subscriptionFreeze`, `subscriptionUnfreeze`)
- Modify: `src/lib/arena3/handlers/desk.ts` (subscription activation helper(s) near lines 100–220; `paymentsCreate` subscription branch → `ref_type` must be `booking` or `enrollment`, message "ref_type must be booking or enrollment."; the pending plan orders list and `orders` count in `paymentsPending`/summary; `subscriptionDecline`)
- Modify: `src/lib/arena3/handlers/online.ts` (subscription branches: creating a link for `subscription` is refused like any unknown ref_type; settling an old paid subscription link: post nothing, return as ignored)
- Modify: `src/lib/arena3/handlers/promos.ts`, `src/lib/arena3/promos.ts` (no plan targeting: drop `plan_id` validation against `membership_plans` and the plan quote branch near line 258; `plan_id` in input is ignored; keep reading the column for old rows)
- Modify: `src/lib/arena3/jobs.ts` (remove `subscriptionStatus` and its due check)
- Modify: `src/lib/arena3/catalog.ts` (remove plan catalog reads, if only used by plan screens/landing — keep exports that Task 4 removes? No: remove here only if no remaining importer; otherwise leave for Task 4)
- Modify: `src/lib/arena3/helpers.ts` + `src/lib/arena3/handlers/classes.ts` (delete `returnPrepaidSession` and the `keepPrepaid` / prepaid-session return paths that use it)
- Modify: tests in `tx.test.ts` / `arena3.test.ts`

- [ ] Step 1: Failing tests, `describe("Remove plans: sales")`: `RP-no-sub-payment` (`paymentsCreate` with `ref_type: "subscription"` → 422 with field `ref_type`); `RP-no-plan-route` (router `POST /v1/subscriptions` → 404; use the existing router test helper pattern in the file, or call the router function directly the way other router tests do).
- [ ] Step 2: Run, see them fail.
- [ ] Step 3: Implement the deletions above. Grep `subscription` and `membership_plans` in `src/lib/arena3` afterwards; what remains may only be: history reads Task 3 owns (`auth.ts`, `members.ts`, `checkin.ts`, `attendance.ts`, `reports.ts`, `ops.ts` assistant text, `sports.ts`), labels, and the `extras.ts` net sum.
- [ ] Step 4: Remove plan-sale tests (subscriptions create/freeze/decline/activation/promos-for-plans/subscription jobs). Full suites green, tsc clean (fix client compile errors only by minimal removal; Task 4 does the real UI work).
- [ ] Step 5: Commit "Stop selling and running plans on the server".

### Task 3: Gate, profiles, reports and assistant without plans (server)

**Files:**
- Modify: `src/lib/arena3/handlers/checkin.ts` (`memberToday`: no plans query, no plan warnings; `entitled = bookings.length > 0 || sessions.length > 0`; keep the response shape but return `plans: []` only if the client needs the key — prefer removing the key and fixing the client in Task 4)
- Modify: `src/lib/arena3/handlers/auth.ts` (`/me`: drop the subscriptions query and key)
- Modify: `src/lib/arena3/handlers/members.ts` (member detail: drop subscriptions; line ~401 query: replace the plan join with the class/booking based meaning, read the surrounding code)
- Modify: `src/lib/arena3/handlers/attendance.ts` (~line 234 roster: members with a confirmed enrolment in a class whose status is `open`, instead of an active subscription; drop `end_on`/`start_on` fields if they only came from the plan, keep the rest)
- Modify: `src/lib/arena3/handlers/reports.ts` `membersReportBody`: `active_members` = distinct members with a confirmed/in_use/completed court booking starting in [from, to] or a confirmed enrolment in a class whose sport matches (sport filter applies to the court sport / class sport); remove `expiring`, `renewed`, `ended`; trend `plans_started` → `classes_joined` (confirmed enrolments created that month, sport filter on class sport)
- Modify: `src/lib/arena3/handlers/ops.ts` assistant context (~600–655 and ~700–715): replace "Plans on sale" with "Classes on sale" (open classes with a non-null `price_vnd`: sport, level, price) and drop "Their plans"
- Modify: `src/lib/arena3/handlers/sports.ts`: drop the "plans on sale" count check (~line 307); keep the history guards at ~366 (tables still hold rows)
- Modify: `src/lib/arena3/labels.ts` (delete the subscription-benefits helper near line 116 if unused after Task 4 — if still imported by client, leave it for Task 4)
- Modify: tests

- [ ] Step 1: Failing tests, `describe("Remove plans: reads")`: `RP-gate-no-plan` (member with no booking/class today and an active subscription row → not entitled, warnings contain no plan kinds); `RP-gate-booking` (member with a confirmed booking today → entitled); `RP-report-active` (one member with a booking in range, one with only a subscription → `active_members === 1`).
- [ ] Step 2: Run, fail.
- [ ] Step 3: Implement.
- [ ] Step 4: Update/remove tests that asserted plan warnings, plan-based roster or plan report numbers. Suites green, tsc clean (minimal client fixes allowed).
- [ ] Step 5: Commit "Read gate, roster and reports from bookings and classes, not plans".

### Task 4: Remove plans from every screen (client)

**Files:**
- Delete: `src/routes/app.plans.tsx`, `src/routes/manager.plans.tsx`
- Modify: `src/routeTree.gen.ts` (regenerated by `npm run build`; commit it)
- Modify: `src/components/shell.tsx` (nav entries for `/app/plans`, `/manager/plans`)
- Modify: `src/components/landing/plans.tsx` + `src/routes/index.tsx` (remove `PlansScene` and the plans loader data; keep `ClassesScene`)
- Modify: `src/routes/app.book.tsx` (plan hours card / "use plan hours"), `src/routes/app.index.tsx` (plan cards), `src/components/cancel-booking.tsx` (only if it shows plan-hour refund copy)
- Modify: `src/routes/desk.index.tsx` (sell-a-plan panel), `src/routes/desk.member.$id.tsx` (subscriptions section, freeze/unfreeze, sell plan, transfer for subscription), `src/routes/desk.payments.tsx` (plan orders), `src/routes/desk.gate.tsx` (plan list / plan warnings)
- Modify: `src/routes/manager.prices.tsx` (plan list), `src/routes/manager.promos.tsx` (plan picker + `applies_to` plan option), manager reports screen for the members report (remove expiring/renewed/ended tiles; rename plans_started series to "Classes joined")
- Modify: `src/components/pay-online.tsx`, `src/components/transfer-qr-modal.tsx` (drop `"subscription"` from `refType` unions if no caller remains)
- Modify: `src/lib/i18n/vi.*.ts` (remove orphaned keys; add Vietnamese for new English strings, e.g. "Classes joined": "Lượt vào lớp")
- Keep: `manager.audit.tsx` labels for old `freeze_sub`, `subscription`, `membership_plan` rows (history), `labels.ts` `subscription: tk("Plan")` payment source label (history).

- [ ] Step 1: Make the edits. `grep -rn "subscription\|/plans\|plan_hours\|court_hours_left" src/routes src/components` afterwards: only history labels remain.
- [ ] Step 2: `npm run build` (regenerates routeTree), `npx tsc --noEmit`, `npm test`, `npx tsx --test src/lib/arena3/tx.test.ts`: all green.
- [ ] Step 3: Commit "Remove plans from every screen".
