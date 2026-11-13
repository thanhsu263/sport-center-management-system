# Sell Courses (Part 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Members buy a class directly. Enrolling holds a seat for a limited time, and paying confirms it. Classes no longer depend on session plans.

**Architecture:** `enrollments` gains a `hold` status, which counts toward `enrolled_count`, so capacity, waitlist and clash rules are reused. A new `ref_type 'enrollment'` flows through the existing payOS, transfer and desk payment paths into one idempotent `settleEnrollment`. A job expires stale holds and offers the seat to the waitlist.

**Tech Stack:** TanStack Router + React, Postgres (Neon; PGlite in tests), plain SQL migrations, `node:test` via `npx tsx --test`.

**Spec:** `docs/superpowers/specs/2026-10-26-sell-courses-design.md`

## Global Constraints

- Do not edit existing migrations or seed data. Add only `migrations/0044_enroll_hold_status.sql` and `migrations/0045_sell_classes.sql`.
- `scripts/migrate.mjs` runs each file in one transaction. A new enum value cannot be used in the transaction that adds it, so `alter type enroll_status add value 'hold'` is the only statement in 0044.
- `class_hold_minutes` default is `15`. A transfer extends the hold to `now() + transfer_hold_minutes`.
- New error codes: `BR-26` "This class is not open for sale yet."; `BR-28` "Your seat hold has expired."
- Invoice line: `Khoá {sport} · {level}`, unit `khoá`. This matches the Vietnamese strings `describePayment` already uses.
- UI copy is English first; follow the i18n pattern already in `app.classes.tsx`.
- GSAP stays in `src/components/moments/*`. Reuse `HoldCountdown`; do not add new motion. Honour reduced motion.
- No refunds anywhere in this feature.
- Plans and subscriptions stay in place (part 2). Only class enrolment and attendance stop using them.
- Commit on branch `working`. Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Test command for one block: `npx tsx --test --test-name-pattern="<pattern>" src/lib/arena3/tx.test.ts`. Full suite: `npm test`.

## Review Focus

1. **Paying twice for the same hold** (a payOS webhook retry, or the desk plus payOS). Expected: one confirmation, no second seat taken. Pinned in Task 3 (`SC-settle-idempotent`).
2. **Payment arrives after the hold expired and the seat went to someone else.** Expected: the payment posts, the enrolment stays cancelled, `enrolled_count` does not exceed capacity, and the payment is flagged for the desk. Pinned in Task 3 (`SC-settle-late-full`).
3. **The manager changes the price while a member is holding.** Expected: the member pays the locked `enrollments.price_vnd`, and a desk payment for the new price is refused. Pinned in Task 3 (`SC-locked-price`).
4. **A member holds one class and enrols in another at the same time.** Expected: the clash check treats the hold as taken and refuses the second. Pinned in Task 2 (`SC-clash-hold`).
5. **A member releases a hold that has an open payOS link.** Expected: the seat is freed and the link is cancelled, so a late scan cannot confirm. Pinned in Task 5 (`SC-release-cancels-link`).

---

## File map

| File | Change |
|---|---|
| `migrations/0044_enroll_hold_status.sql` | Create: the enum value only |
| `migrations/0045_sell_classes.sql` | Create: columns, setting, index, `enrollment_hold()` |
| `src/lib/arena3/helpers.ts` | `Settings.class_hold_minutes`; clash queries count `hold`; delete `classPlan` (Task 6) |
| `src/lib/arena3/handlers/classes.ts` | enrol → hold; price in create/patch/list/detail; `settleEnrollment`; `enrollmentTransfer`; `enrollmentDelete` for holds |
| `src/lib/arena3/handlers/desk.ts` | `describePayment`, record payment, `paymentsPending` for `enrollment` |
| `src/lib/arena3/handlers/online.ts` | `refType 'enrollment'` on create and settle; `expireOnlineLinks` |
| `src/lib/arena3/handlers/ops.ts` | `waitlistAccept` → hold; attendance stops charging |
| `src/lib/arena3/handlers/auth.ts` | drop `class_access` from `/me` |
| `src/lib/arena3/jobs.ts` | `expireEnrollmentHolds` + `DUE_PROBE` clause + `runDueJobs` wiring |
| `src/lib/arena3/router.ts` | `POST /enrollments/:id/transfer` |
| `src/lib/arena3/tx.test.ts` | new `describe("Sell classes")`; remove or rewrite plan-based enrol and attendance tests |
| `src/components/pay-online.tsx` | `refType` includes `"enrollment"` |
| `src/routes/app.classes.tsx` | price, hold state, payment actions |
| `src/components/class-detail.tsx` | manager price input |
| desk awaiting-payments screen (`graft grep "payments/pending"`) | show enrolment holds |

Shared test fixtures: put these at the top of the new `describe("Sell classes")` block in `tx.test.ts`.

- `seedClass({ price, capacity })` returns `classId`. It inserts an `'open'` badminton class on `validCourtId`, using the coach id the F-26 test uses (`...0011`), with a level unique per call so classes never clash.
- `seedMember(n)` returns a member `PublicUser`, using the `users` insert pattern from the F-26 test. Ids are `00000000-0000-0000-0000-0000000005NN`.

---

### Task 1: Migrations and settings

**Files:**
- Create: `migrations/0044_enroll_hold_status.sql`, `migrations/0045_sell_classes.sql`
- Modify: `src/lib/arena3/helpers.ts:16-60` (`Settings` type and `getSettings` select)
- Test: `src/lib/arena3/tx.test.ts` (new block `Sell classes: schema`)

**Interfaces:**
- Produces, in SQL:
  - `classes.price_vnd int null check (price_vnd >= 0)`
  - `enrollments.hold_until timestamptz null`
  - `enrollments.price_vnd int null`
  - `enrollments.transfer_requested_at timestamptz null`
  - `center_settings.class_hold_minutes int not null default 15 check (class_hold_minutes between 1 and 240)`
  - index `enrollments_hold_until_idx on enrollments (hold_until) where status = 'hold'`
  - `enrollment_hold(p_class uuid, p_user uuid, p_minutes int, p_price int) returns uuid`
- Produces, in TS: `Settings.class_hold_minutes: number`.

- [ ] **Step 1: Write the failing tests** `SC-schema-hold` and `SC-schema-errors`.
  - `SC-schema-hold`: `seedClass({price: 300000, capacity: 1})`. Then `select enrollment_hold($1,$2,15,300000)` for member 1. The row has `status = 'hold'`, `price_vnd = 300000`, and `hold_until` between now+14m and now+16m. `classes.enrolled_count` is 1.
  - `SC-schema-errors`: calling it again for member 1 rejects with a message containing `ALREADY_ENROLLED`. Calling it for member 2 rejects with `CLASS_FULL`. `getSettings(sql).class_hold_minutes === 15`.
- [ ] **Step 2: Run** `npx tsx --test --test-name-pattern="Sell classes: schema" src/lib/arena3/tx.test.ts`. Expected: FAIL (function `enrollment_hold` does not exist).
- [ ] **Step 3: Write the two migrations.**
  - 0044 contains only `alter type enroll_status add value if not exists 'hold';`.
  - 0045 adds the columns, setting and index above, plus `enrollment_hold`. Copy `enrollment_confirm` from `0042_waitlist_order.sql:16-41` with three changes:
    - Raise `ALREADY_ENROLLED` when the existing status is `'confirmed'` or `'hold'`.
    - Write `status = 'hold'`, `hold_until = now() + p_minutes * interval '1 minute'`, `price_vnd = p_price` and `transfer_requested_at = null`, on both the reuse and the insert paths.
    - Keep the `waitlist_compact` calls.
  - Also in 0045: `create or replace` `enrollment_waitlist` so that a `'hold'` row raises `ALREADY_ENROLLED`, the same as `'confirmed'`. Copy the body from 0042 and widen only that check.
  - In `getSettings`, add `class_hold_minutes` to the select and to the type.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `git add migrations/0044_enroll_hold_status.sql migrations/0045_sell_classes.sql src/lib/arena3/helpers.ts src/lib/arena3/tx.test.ts` then `git commit -m "Add a hold status, class price and enrollment_hold for selling classes"`.

---

### Task 2: Class price and enrol creates a hold

**Files:**
- Modify: `src/lib/arena3/handlers/classes.ts`:
  - `classesList` (15-38), `classesCreate` (44), `classesPatch` (813), `classDetail` (464)
  - `classesEnroll` (289-356)
- Modify: `src/lib/arena3/helpers.ts:553,574` (`e.status = 'confirmed'` → `e.status in ('confirmed','hold')`)
- Test: `tx.test.ts` block `Sell classes: enrol`

**Interfaces:**
- Consumes: `enrollment_hold`, `Settings.class_hold_minutes` (Task 1).
- Produces:
  - `classesEnroll` keeps its signature. Its 201 body is `{ enrollment: { id, status: 'hold'|'confirmed'|'waitlisted', hold_until: string|null, price_vnd: number|null } }`. This keeps the existing `body.enrollment` shape; the spec's flat field list maps onto it.
  - Each item from `classesList` and `classDetail` gains `price_vnd: number|null` and `my_enrollment: { id, status, hold_until, price_vnd, transfer_requested_at } | null`. `my_enrollment` is null when there is no user or for staff. Cancelled rows count as null.
  - `classesCreate` and `classesPatch` accept `price_vnd`: null, or an integer from 0 to 100_000_000. Anything else fails with `err.field("price_vnd", "Price must be a whole number of dong, or empty.")`.

- [ ] **Step 1: Write the failing tests:**
  - `SC-enrol-hold`: with price 300000, enrolling gives 201, `enrollment.status === 'hold'`, `price_vnd === 300000`, and `enrolled_count === 1`. No subscription is seeded for the member.
  - `SC-enrol-unpriced`: with price null, `assert.rejects` with `e.extra?.br === "BR-26"`.
  - `SC-enrol-free`: with price 0, the status is `'confirmed'`, `hold_until` is null, and there is no `payments` row with `ref_id` = the enrolment id.
  - `SC-enrol-full`: with capacity 1, the first member holds and the second gets `'waitlisted'`.
  - `SC-clash-hold`: two classes with the same weekly slot on different courts. The member holds class A; enrolling in B rejects with the clash error that `assertNoClassClash` already raises.
  - `SC-price-patch`: a manager patches `price_vnd: 250000` and the class shows 250000; patching `-1` or `"abc"` gives a field error on `price_vnd`. An existing hold keeps 300000.
  - `SC-list-mine`: `classesList` for the holding member shows `my_enrollment.status === 'hold'`; for another member it is null.
- [ ] **Step 2: Run** `--test-name-pattern="Sell classes: enrol"`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - In `classesEnroll`, delete the `classPlan` call. After the BR-18 check, if `price_vnd` is null, throw `err.br("BR-26", "This class is not open for sale yet.")`.
  - Inside `sp_enroll`, call `enrollment_hold(id, user.id, settings.class_hold_minutes, price)`. When the price is 0, immediately set `status='confirmed', hold_until=null` on that row.
  - Keep the CLASS_FULL → `enrollment_waitlist` and ALREADY_ENROLLED → BR-22 mapping.
  - Add `price_vnd` to the list and detail selects, and add `my_enrollment` with a `left join lateral` on `enrollments` filtered by `user_id = $3` and `status <> 'cancelled'`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `"Enrolling in a priced class holds a seat instead of checking a plan"`.

---

### Task 3: Settle a payment, transfer request, desk payment

**Files:**
- Modify: `src/lib/arena3/handlers/classes.ts` (new exports)
- Modify: `src/lib/arena3/handlers/desk.ts`:
  - `describePayment` (~206)
  - record payment: guard at 257, branches at 301 and 388
  - `paymentsPending` (651-774)
- Modify: `src/lib/arena3/router.ts`, next to the `DELETE enrollments` route at line 394
- Test: `tx.test.ts` block `Sell classes: pay`

**Interfaces:**
- Produces:
  - `settleEnrollment(sql: Sql, enrollmentId: string): Promise<{ outcome: 'confirmed' | 'already' | 'late_confirmed' | 'late_no_seat' }>`. It locks the enrolment and then its class.
    - `hold` → `confirmed`, with `hold_until` and `transfer_requested_at` set to null. Outcome `confirmed`.
    - `confirmed` → no change. Outcome `already`.
    - Anything else: if `enrolled_count < capacity`, increment the count and set `confirmed` (outcome `late_confirmed`). Otherwise leave it unchanged and `audit(sql, null, "enrollment_paid_no_seat", "enrollment", id)` (outcome `late_no_seat`).
  - `enrollmentTransfer(sql: Sql, id: string, user: PublicUser)`. Owner only, `status = 'hold'`, `hold_until > now()`, otherwise BR-28. It sets `hold_until = now() + transfer_hold_minutes` and `transfer_requested_at = now()`. Returns 200 `{ enrollment }`.
  - Route: `POST /enrollments/:id/transfer` → `authed((sql,user) => classH.enrollmentTransfer(sql, p1, user))`.
  - The desk record payment accepts `ref_type: "enrollment"`. The enrolment must be `hold`, otherwise BR-28. `amount_vnd` must equal `enrollments.price_vnd`, otherwise `err.field("amount_vnd", ...)` in the same style as the booking branch. After inserting the payment it calls `settleEnrollment`, then `issueInvoice` and `enqueueReceipt`, as the other branches do.
  - `describePayment("enrollment", id)` returns `{ description: "Khoá {sport} · {level}", unit: "khoá" }`.
  - Each `paymentsPending` row for an enrolment has `kind: "enrollment"`, `id`, `member_name`, `class_label`, `amount_vnd`, `hold_until` and `transfer_requested_at`. Follow the row shape of the booking-hold rows in that function.

- [ ] **Step 1: Write the failing tests:**
  - `SC-transfer`: hold → `enrollmentTransfer` → `hold_until` ≈ now+120m and `transfer_requested_at` is set. `paymentsPending` as manager contains a row with `kind === "enrollment"`.
  - `SC-desk-pay`: the manager records cash 300000 for `ref_type: "enrollment"` → status `confirmed`, one posted payment, and one invoice line whose description starts with `Khoá badminton`.
  - `SC-settle-idempotent`: `settleEnrollment` twice gives `confirmed` then `already`, and `enrolled_count` stays 1.
  - `SC-settle-late-full`: capacity 1; member 1 holds; force `hold_until = now() - 1m`; run `expireEnrollmentHolds` from Task 5. If Task 5 is not done yet, set `status='cancelled'` and decrement the count by hand. Member 2 then holds, and `settleEnrollment(member1Enrollment)` gives `late_no_seat` with `enrolled_count === 1`.
  - `SC-locked-price`: hold at 300000, the manager patches the price to 250000, and a desk payment of 250000 is rejected on `amount_vnd`.
  - `SC-expired-transfer`: `hold_until` in the past → `enrollmentTransfer` rejects with BR-28.
- [ ] **Step 2: Run** `--test-name-pattern="Sell classes: pay"`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above. Mirror the booking branches in desk.ts; do not refactor them.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit:** `"Take payment for a class seat by transfer or at the desk"`.

---

### Task 4: Online payment (payOS)

**Files:**
- Modify: `src/lib/arena3/handlers/online.ts`:
  - `settleOnline` (70-150): new branch after line 118
  - `onlineCreate` (208-262): new branch
  - `expireOnlineLinks` (508-531)
- Modify: `src/lib/arena3/jobs.ts`, the `expire_links` clause in `DUE_PROBE`
- Test: `tx.test.ts` block `Sell classes: online`

**Interfaces:**
- Consumes: `settleEnrollment` and `describePayment` (Task 3).
- Produces:
  - `onlineCreate` with `ref_type: "enrollment"`: the owner member or staff may create it; otherwise `err.forbidden()`. The enrolment must be `hold` with `hold_until > now()`, otherwise BR-28. `amount = price_vnd`, `payerId = user_id`, `label = "class"`.
  - `settleOnline` with `pay.ref_type === "enrollment"`: calls `settleEnrollment`, then issues the invoice and receipt the same way the booking branch does.
  - `expireOnlineLinks` and `DUE_PROBE.expire_links` both treat a pending payOS payment as stale when its `ref_type = 'enrollment'` row is missing, is not `hold`, or has `hold_until < now()`. Keep the job's `where` and the probe clause identical.

- [ ] **Step 1: Write the failing tests.** Use `setOverridePaymentLinkCreator` exactly as the existing `onlineCreate` tests do.
  - `SC-online-create`: the member creates a link for their hold and the payment amount equals 300000. Another member gets 403. An expired hold gives BR-28.
  - `SC-online-expire`: with a link pending, set `hold_until` to the past; `expireOnlineLinks` cancels the pending payment.
  - `SC-online-settle`: drive the post path the same way the existing payOS settle test does (search `tx.test.ts` for `onlineVerify` or `settleOnline` usage and copy its setup). The enrolment becomes `confirmed`.
- [ ] **Step 2: Run** `--test-name-pattern="Sell classes: online"`. Expected: FAIL.
- [ ] **Step 3: Implement** the branches.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit:** `"Pay for a class seat online with payOS"`.

---

### Task 5: Waitlist accept, release, expiry job

**Files:**
- Modify: `src/lib/arena3/handlers/ops.ts:147-185` (`waitlistAccept`)
- Modify: `src/lib/arena3/handlers/classes.ts:358-411` (`enrollmentDelete`)
- Modify: `src/lib/arena3/jobs.ts`: new `expireEnrollmentHolds`, a `DUE_PROBE` clause `expire_enrollment_holds`, and the entry in `runDueJobs`
- Test: `tx.test.ts` block `Sell classes: lifecycle`

**Interfaces:**
- Produces:
  - `waitlistAccept`: no `classPlan`. A null class price gives BR-26. The enrolment is set to `status='hold', waitlist_pos=null, hold_until=now()+class_hold_minutes, price_vnd=<class price>`. The rest (seat increment, offer accepted, compact) stays as it is.
  - `enrollmentDelete` with `status = 'hold'`: set `cancelled` with `hold_until` null, decrement the count, cancel pending payOS payments for it (`update payments set status='cancelled' where ref_type='enrollment' and ref_id=$1 and status::text='pending'`; use the same status value `expireOnlineLinks` writes), then `inviteWaitlist`. There is no BR-24 check for holds.
  - `expireEnrollmentHolds(): Promise<number>` uses `withTx`. It selects with `where status = 'hold' and hold_until < now()` and `for update skip locked`. For each row: cancel it, decrement the count (floor 0), and `inviteWaitlist(sql, class_id)`. The `DUE_PROBE` clause uses the identical `where`.

- [ ] **Step 1: Write the failing tests:**
  - `SC-waitlist-hold`: capacity 1; A holds; B is waitlisted; A releases → B gets an offer; B accepts → B is `hold` with `price_vnd` set. No subscriptions are seeded.
  - `SC-release`: releasing a hold frees the seat (count 0) and does not raise BR-24, even when the next session is within `cancel_class_hours`.
  - `SC-release-cancels-link`: hold, then an online link (Task 4 setup), then release → the pending payment is cancelled.
  - `SC-expire-job`: capacity 1; A holds with `hold_until` in the past; B is waitlisted → `expireEnrollmentHolds()` returns ≥ 1, A is `cancelled`, the count is 0, and B has a pending offer.
  - `SC-leave-confirmed`: a confirmed enrolment inside the cutoff still gets BR-24, and no refund payment row is created.
- [ ] **Step 2: Run** `--test-name-pattern="Sell classes: lifecycle"`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit:** `"Expire unpaid class holds and pass the seat to the waitlist"`.

---

### Task 6: Stop plan charging for classes, retire `classPlan`

**Files:**
- Modify: `src/lib/arena3/handlers/ops.ts:422-596` (`sessionAttendancePost`)
- Modify: `src/lib/arena3/handlers/auth.ts:361-379` (`/me`)
- Modify: `src/lib/arena3/helpers.ts:407-495` (delete `classPlan`), and its type import in `src/lib/arena3/types.ts` if one exists
- Modify: `src/lib/arena3/tx.test.ts`:
  - delete `describe("Task A1: waitlistAccept session deduction")` (2622)
  - delete `describe("Task P: class plan eligibility and session charging")` (3523)
  - in the F-26 (1200) and W-1 (3386) tests, drop the subscription seeding and set `price_vnd` on the class; their `'confirmed'` expectations become `'hold'`
- Any client code that reads `class_access` (`graft grep "class_access"`)
- Test: `tx.test.ts` block `Sell classes: attendance`

**Interfaces:**
- Produces:
  - `sessionAttendancePost` still records attendance. It no longer reads or writes `subscriptions.session_left` or `enrollments.prepaid_sessions`, and it no longer inserts into `session_charges`.
  - `/me` no longer has `class_access`.
  - After the change, `graft grep "classPlan"` returns nothing.

- [ ] **Step 1: Write the failing test** `SC-attendance-no-charge`. Seed a member with an active badminton session plan with `session_left = 3` and a confirmed enrolment in a started session. Post `present` → `session_left` is still 3, and `session_charges` has no row for that session and user.
- [ ] **Step 2: Run** `--test-name-pattern="Sell classes: attendance"`. Expected: FAIL (`session_left` is 2).
- [ ] **Step 3: Implement.**
  - Remove the D3/D4 charging block from `sessionAttendancePost`. Keep validation, upsert and audit.
  - Remove `class_access` from `/me`.
  - Delete `classPlan` and fix every compile error `npx tsc --noEmit` reports.
  - Remove and rewrite the old tests listed above.
  - Leave `enrollmentDelete`'s `returnPrepaidSession` branch in place for old rows.
- [ ] **Step 4: Run** `npx tsc --noEmit`, then `npx tsx --test src/lib/arena3/tx.test.ts`. Expected: no type errors and every test passes.
- [ ] **Step 5: Commit:** `"Stop charging plan sessions for classes and retire classPlan"`.

---

### Task 7: UI: class card, manager price, desk queue

**Files:**
- Modify: `src/components/pay-online.tsx:43` (`refType: "booking" | "subscription" | "enrollment"`)
- Modify: `src/routes/app.classes.tsx:312-344` and its data types
- Modify: `src/components/class-detail.tsx` (manage-mode form)
- Modify: the desk awaiting-payments view (`graft grep "payments/pending"` to locate it)
- Verify with: the browser preview (`.claude/launch.json`)

**Interfaces:**
- Consumes:
  - `price_vnd` and `my_enrollment` from the list and detail (Task 2)
  - `POST /enrollments/:id/transfer` (Task 3)
  - `DELETE /enrollments/:id` (Task 5)
  - `PayOnlineButton` with `refType="enrollment"` and `refId = my_enrollment.id` (Task 4)
  - `HoldCountdown` from `src/components/moments/hold-countdown.tsx`; check its props with `graft skeleton`

Card states, decided by `my_enrollment?.status` and `price_vnd`:

| State | Shows |
|---|---|
| `price_vnd == null` | price "—", disabled button "Not open yet" |
| no enrolment | the price formatted as VND (reuse the app's existing VND formatter, found with `graft grep "vnd("` or `toLocaleString("vi-VN")`), button "Enrol · {price}" |
| `hold`, no transfer | `HoldCountdown` until `hold_until`, `PayOnlineButton`, "Pay by transfer" button, "Release seat" text button; refetch when the countdown ends |
| `hold` + `transfer_requested_at` | `HoldCountdown`, the line "Waiting for the desk to confirm your transfer", "Release seat" |
| `confirmed` | "Enrolled", as now |
| `waitlisted` | as now |

Remove the "See plans" link and the "{n} sessions left" line.

- [ ] **Step 1: Implement** the `PayOnlineButton` type, the card states, and the manager price input. The input is a numeric field "Price (VND)" that may be empty and sends `price_vnd: number|null` on create and patch.
- [ ] **Step 2: Implement** the desk queue rows for `kind === "enrollment"`: the member, `class_label`, amount, and hold expiry. The record-payment action posts `ref_type: "enrollment"`.
- [ ] **Step 3: Run** `npx tsc --noEmit` and `npm run build`. Expected: both exit 0.
- [ ] **Step 4: Verify in the preview.**
  - As a member: an unpriced class shows "Not open yet". Enrolling in a priced class shows the countdown, and "Pay by transfer" switches to the waiting line. "Release seat" returns the card to the open state.
  - As a manager: setting a price shows it on the card.
  - As the desk: the transfer appears in the awaiting list, and recording it turns the member's card to "Enrolled".
  - Screenshot each state, and check one of them with reduced motion.
- [ ] **Step 5: Run** the Impeccable `detect --json` on the changed UI files once and fix any errors it reports.
- [ ] **Step 6: Commit:** `"Show class prices and let members hold, pay for and release a seat"`.

---

### Task 8: Whole-branch check

- [ ] Run `npm test`. Expected: all suites pass.
- [ ] Run `npx tsc --noEmit` and `npm run build`. Expected: exit 0.
- [ ] Run `graft grep "classPlan"` and `graft grep "class_access"`. Expected: no hits outside the spec and plan docs.
- [ ] Walk the spec section by section and confirm each item has shipped. Note anything deferred to part 2.
