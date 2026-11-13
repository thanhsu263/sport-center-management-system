# Sell courses, part 1: pay per class instead of a session plan

Date: 2026-10-26 · Branch: `working` · Status: draft for review

## Why

Members with an active court-hours plan and an active sessions plan could book courts but not enrol in classes. The cause is how plans work: each sessions plan covers one sport only, and the enrol check (`classPlan`, helpers.ts:407) needs a live plan for the class's sport with sessions left. Rather than patch this rule, we drop plans. A member buys a course (one class) directly.

This is part 1 of 2.

- **Part 1 (this spec):** sell classes. Enrolling no longer needs a plan. The member holds a seat, pays, and is confirmed.
- **Part 2 (later spec):** remove plans from court booking, the gate, the desk and reports. Plans and subscriptions stay in the database and the code until then. Part 1 only stops classes from depending on them.

## Decisions (from the user)

| Question | Decision |
|---|---|
| Plans | Remove them entirely. Part 1 covers classes; part 2 covers everything else. |
| How enrolling works | Enrolling creates a time-limited seat hold. The member is confirmed only after paying. |
| Joining after the course has started | Always pays the full price. |
| Refunds | None once paid. |
| Design | A: extend `enrollments` with a `hold` status; holds count toward `enrolled_count`. |

## Data (new migration `0044_sell_classes.sql`)

Existing migrations and seed data are not changed.

- `classes.price_vnd integer null check (price_vnd >= 0)`. Null means the class is not for sale yet.
- `alter type enroll_status add value 'hold'`.
- `enrollments.hold_until timestamptz null`: set while `status = 'hold'`, null otherwise.
- `enrollments.price_vnd integer null`: the price locked when the hold is created. The member pays this even if the manager changes the class price later.
- `center_settings.class_hold_minutes integer not null default 15`.
- Index: `enrollments (hold_until) where status = 'hold'`, used by the expiry job.
- New SQL function `enrollment_hold(class_id, user_id, minutes, price)`. It works like `enrollment_confirm` (0042): it locks the class, requires status `'open'` and a free seat, raises `CLASS_FULL` or `ALREADY_ENROLLED` the same way, and increments `enrolled_count`. The difference is that it writes `status = 'hold'`, `hold_until = now() + minutes`, and `price_vnd`. It reuses a cancelled row the same way `enrollment_confirm` does.

Enrolments that already exist stay `confirmed` and are not charged.

A hold takes a seat. So capacity, the waitlist, `assertNoClassClash` and the "class just filled" offer skipping all work unchanged.

## Enrol flow

`classesEnroll` (classes.ts:289):

1. Role check and class load stay the same. The class must be `'open'` (BR-18).
2. **New:** if `price_vnd` is null, fail with `BR-26` ("This class is not open for sale yet.").
3. **Removed:** the `classPlan` call.
4. `assertNoClassClash` stays. It must also count `hold` enrolments as taken (helpers.ts:553 and 574 filter on `'confirmed'`; change both to `in ('confirmed','hold')`).
5. Inside `savepoint sp_enroll`, call `enrollment_hold(...)` instead of `enrollment_confirm`. The response returns `{ status: 'hold', enrollment_id, hold_until, price_vnd }`.
6. `CLASS_FULL` still goes to `enrollment_waitlist`; `ALREADY_ENROLLED` still raises BR-22.

A price of 0 is allowed. In that case the hold is confirmed straight away, with no payment row.

**Accepting a waitlist offer** (`waitlistAccept`, ops.ts:147): drop `classPlan`. The enrolment moves from `waitlisted` to `hold`, not `confirmed`, with `hold_until` from `class_hold_minutes` and the current class price locked in. If the class has no price, fail with BR-26. The seat count increments as now.

## Payment

The new `payments.ref_type` value is `'enrollment'`, with `ref_id` set to the enrolment id. The column has no check constraint, so no schema change is needed.

**Online (payOS), `online.ts`:**

- When a link is created: allow `refType = 'enrollment'` for the member who owns it, or for staff. The enrolment must be `hold` with `hold_until > now()`, and the amount must equal `price_vnd`. Otherwise fail with `BR-28` ("Your seat hold has expired.").
- When the payment posts: run `settleEnrollment` (below), then issue the invoice and enqueue the receipt, as the booking branch does.
- `expireOnlineLinks` and its `expire_links` due probe (jobs.ts): also cancel pending links whose enrolment is no longer `hold` or whose hold has expired.

**Bank transfer:** a new endpoint `POST /enrollments/:id/transfer`, mirroring `bookingsConfirm` with method `transfer`. It extends `hold_until` to `now() + transfer_hold_minutes` and sets `transfer_requested_at`, so this needs a new nullable `enrollments.transfer_requested_at` column in 0044. The enrolment then appears in the desk's awaiting list.

**Desk:**

- `paymentsPending` (desk.ts:651) lists enrolments in `hold` that have `transfer_requested_at` set, next to booking holds.
- The record-payment handler accepts `ref_type = 'enrollment'`. It checks that the enrolment is `hold` and that the amount equals `price_vnd`, then runs `settleEnrollment`, `issueInvoice` and `enqueueReceipt`.
- Cash or card at the desk works the same way, with no transfer request needed.

**`settleEnrollment(sql, enrollmentId)`**, a new helper in classes.ts. It locks the enrolment.

- If it is `hold`: set it to `confirmed` and set `hold_until` to null.
- If it is already `confirmed`: do nothing, which makes it idempotent for payOS retries.
- If it is anything else (the hold expired and the seat was released): the payment still posts, because money arrived. The member is confirmed again only if a seat is free (`enrolled_count < capacity`, then increment). If no seat is free, the payment is flagged for the desk to handle by hand as an exception. This is a staff decision, not an automatic refund.

**Invoice line** (`describePayment`, desk.ts:206): "Course {sport} · {level}" (vi: "Khoá {sport} · {level}"), with the amount equal to `price_vnd`.

## Expiry job

`expireEnrollmentHolds()` in jobs.ts, with a matching `expire_enrollment_holds` clause in `DUE_PROBE` (the clause must mirror the job's `where`):

```sql
where status = 'hold' and hold_until < now()
```

For each row: set it to `cancelled` with `hold_until` null, decrement `enrolled_count` (floor 0), then call `inviteWaitlist(class_id)` so the freed seat goes to the next person.

## Attendance

`sessionAttendancePost` (ops.ts:422) stops charging `session_left` (the D3/D4 path via `session_charges`). Marking attendance only records attendance. The `session_charges` rows stay as history, and the table is not dropped.

## Leaving a class

`enrollmentDelete` (classes.ts:358):

- `hold`: cancel it at any time, free the seat (decrement), and call `inviteWaitlist`. Any pending payOS link for it is cancelled too.
- `confirmed`: BR-24 (the `cancel_class_hours` cutoff) stays. There is no refund. The `prepaid_sessions` return-to-plan branch stays for old enrolments only. New enrolments have `prepaid_sessions = 0`, so it is a no-op for them.
- `waitlisted`: unchanged.

## API and `/me`

- `/me` (auth.ts:361) drops `class_access`. Nothing replaces it, because the class list carries the price.
- The classes list and detail return `price_vnd`. For the current member they also return `my_enrollment: { id, status, hold_until, price_vnd } | null`.
- The manager's class create and edit endpoints accept `price_vnd`, either null or an integer ≥ 0. Changing it does not affect existing holds.

## UI

**Class card** (`src/routes/app.classes.tsx:312`):

- Remove "See plans" and "{n} sessions left".
- Show the price formatted in VND. The button reads "Enrol · {price}". A class with no price shows "Not open yet" and the button is disabled.
- In the hold state, show `HoldCountdown` (from `src/components/moments/hold-countdown.tsx`) counting down to `hold_until`, plus `PayOnlineButton` with `refType="enrollment"`, a "Pay by transfer" action, and "Release seat". When the countdown reaches zero, refetch the list.
- Once a transfer has been requested, show "Waiting for the desk to confirm your transfer" in place of the payment buttons.
- Confirmed: show "Enrolled", as now.
- `PayOnlineButton` (src/components/pay-online.tsx:43): widen `refType` to include `"enrollment"`.

**Manager:** add a price input (VND, may be empty) in the class create and edit form, in `ClassDetailModal` manage mode (src/components/class-detail.tsx).

**Desk:** the awaiting-payments list shows enrolment holds with the member, the class, the price and when the hold expires.

All copy is in English first with a Vietnamese string next to it, following the existing i18n pattern. Motion follows the house rules: the countdown is the existing moment, and nothing new is drawn over court-grid cells.

## Errors

| Code | When |
|---|---|
| BR-18 | The class is not open (unchanged). |
| BR-22 | Already enrolled or holding a seat (unchanged). |
| BR-26 | **New.** The class has no price set. |
| BR-28 | **New.** Paying for, or requesting a transfer on, a hold that has expired or is no longer a hold. |
| BR-19, BR-20 | Retired. `classPlan` loses its last callers (enrol, waitlist accept, attendance, `/me`) in part 1 and is deleted. |

## Tests (`src/lib/arena3/tx.test.ts`)

Rewrite the enrol and attendance tests. Cover:

1. Enrolling in a priced open class creates a hold, takes a seat and locks the price.
2. An unpriced class fails with BR-26.
3. A full class puts the member on the waitlist; accepting the offer gives a hold.
4. Paying online (payOS post) confirms the hold; a second post of the same payment is a no-op.
5. A transfer request extends the hold, and the desk then records the payment and confirms the member.
6. Paying a hold that has expired fails with BR-28.
7. The expiry job cancels the hold, frees the seat and sends a waitlist offer.
8. Releasing a hold frees the seat.
9. Leaving a confirmed class keeps the BR-24 cutoff and creates no refund.
10. Attendance no longer touches `session_left`.
11. A price of 0 confirms straight away.

Then run `npx tsc --noEmit` and `npm run build`, and take screenshots of the class card in each state (open, hold, transfer pending, enrolled, not open yet).

## Out of scope (part 2)

- Removing `membership_plans`, `subscriptions` and the plan pages, the court-hours quota for booking, gate and desk plan checks, plan sales in reports.
- Any refund flow.
