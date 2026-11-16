# Business-rule gaps found on production (2026-11-14)

A read-only walkthrough of `https://arena3-self.vercel.app` (Member and Manager demo accounts) plus a read of the
server handlers found the gaps below. Fix G0 to G7. Line numbers were checked on `main` at `fa591cb`; if a line
has moved, find it with `DO_NOT_TRACK=1 npx graft grep "<symbol>"` (or plain grep if graft will not start).

The short prompt to paste is at the end (section 11).

---

## 0. Hard rules

1. Create branch `fix/business-gaps` from `main`. Never push. Never commit on `main`. One commit per gap
   (G0 → G7), staged by path, English imperative subject.
2. **Out of scope, do not touch:** the demo accounts on `/login`, `VITE_DEMO_LOGINS`, `DEMO_PASSWORD` in
   `src/routes/login.tsx`. The owner keeps them on purpose so strangers can demo the app.
3. No new migration, no edit to an existing migration, no seed change. Every fix below is meant to work on the
   current schema. If you believe one needs a schema change, stop and report instead of writing it.
4. Do not touch `src/routeTree.gen.ts`, untracked folders or `docs/audit/*`.
5. Fix only what this file lists. Anything else goes under "Found, not fixed" in the report.
6. Every new user-facing string goes through i18n, English first, Vietnamese second (`src/client/lib/i18n/*`).
7. Each gap gets at least one test in the existing suites (`src/server/controllers/tx.test.ts`,
   `src/server/services/*.test.ts`). Tests must use their own court / class / users, never seed rows, and must
   not depend on the time of day.
8. Report only what you ran and saw. A failing test is pasted, not summarised.

## 1. The refund rule (applies to every gap)

**Rule A. Money goes back only when the centre cancels.** A member who cancels or leaves on their own gets
nothing back, at any time: not for a class seat, not for a court booking. The centre cancelling means: a
manager cancels a class, a manager cancels a session, the centre blocks a court for maintenance, or staff
cancel a booking for a reason on the centre's side. A refund raised by hand at the desk (`paymentsRefund`)
stays available as a staff decision with a reason.

**Rule B. Every refund is paid in cash at the front desk.** There is no refund to a card, a bank account or the
online gateway, whatever method the member paid with.

In code that means every refund row in `payments` is: `method = 'cash'`, negative `amount_vnd`,
`status = 'refund_pending'` when it is created, and it becomes `posted` only when the desk hands the cash over
through the existing pending-refund decision flow (`desk.ts`, around `PendingRefund`, line 515 onward), inside
an open till shift so the cash leaves a shift's drawer.

---

## 2. G0: court-cancel refunds are posted without any cash being handed over

**Seen.** `bookings.ts:1099-1110`. A refund below `settings.refund_manager_vnd` is inserted as `posted`
straight away, with no `shift_id`. The books say cash went out; nobody at the desk gave any.

Also, a member who cancels their own court gets 100 / 50 / 0% back by the tier table (`services/policy.ts:15-17`).
Rule A says they get nothing.

**Do.**
0. A member cancelling their own court booking refunds 0, whatever the tier table says. The cancel quote
   (`bookings.ts:1024`) and the cancel dialog must say "Nothing is refunded" before the member confirms. The
   refund branch at `bookings.ts:1099` then runs only when staff cancel for the centre (reason required), and
   that refund is 100%. Leave the tier setting in the schema and settings screen untouched if removing it needs
   a migration; just stop using it for member cancellations and say so in the report.
1. Insert every automatic refund as `refund_pending` (keep the manager-approval threshold as an extra condition
   on who may release it, not on the status at creation).
2. When the desk releases it, attach the payer's open shift (`shift_id`) so the cash total of that shift drops.
   Refuse with BR-44 when no shift is open.
3. Check every other place that inserts a negative payment (`grep -n "amount_vnd" ... -refund`, `desk.ts:430`
   `paymentsRefund`, `classes.ts:1298-1327`) and bring it in line with section 1.
4. Member-facing copy for a refund (cancel quote, notification, receipt) must say: collect it in cash at the
   front desk. Remove any wording that implies money goes back to the original method.

## 3. G1: loyalty points can be turned into a free code

**Seen.** `extras.ts:388-469`.
- Points are derived from net payments. A member pays, redeems all points for a `DIEM…` code, then cancels the
  court more than 24 hours ahead for a 100% refund. `points = Math.max(0, earned + adjust)` (line 402) clamps
  the resulting debt to zero and the code stays valid. G0 step 0 closes the member-cancel route, but the same
  thing still happens on any centre-side refund, so step 2 below stays.
- `loyaltyRedeem` reads the balance and inserts without a lock: two concurrent requests both pass.
- The code is not tied to the member who redeemed it; anyone can type it.

**Do.**
1. In `loyaltyRedeem`, take a per-user lock first (`select ... from users where id = $1 for update`, or
   `pg_advisory_xact_lock`) and compute the balance after it.
2. Whenever a refund for a member is created (G0 paths, desk refund, class refunds), recompute their balance
   without the clamp. If it is negative, void that member's **unused** redeemed codes, newest first, until the
   balance is no longer negative: end the promotion (`ends_at = now()`) and insert a compensating
   `loyalty_adjustments` row (`reason = 'correction'`, note naming the code). A code already used stays used;
   leave the remaining debt as a negative balance internally, shown as 0, that future earnings pay off first.
3. A redeemed code may only be used by the member who redeemed it. `loyalty_adjustments.promo_id` plus
   `user_id` already records the owner: in `quotePromo` (`services/promos.ts`) refuse the code for any other
   `userId` with the normal "code not valid" error.

## 4. G2: a certificate can be issued before the class ends

**Seen.** `certificates.ts:125-127`: `earned()` needs `remaining === 0`, but sessions are only generated two
weeks ahead. On production a member has "View certificate" for a class running until 17 Dec 2026.

**Do.** `earned()` also requires the class to be over: `end_on` earlier than today in `Asia/Ho_Chi_Minh`
(return that as a boolean from `COMPLETION_SQL`). Apply the same condition where the certificate is issued
(around line 150-170), not only in the list.

## 5. G3: cancelling one session gives members nothing

**Seen.** `classes.ts:976-998`, `const refunded = 0;`. Members pay full tuition however many sessions the
manager cancels.

**Do.**
1. When a session is cancelled by the centre, each confirmed member is owed one session's share of the tuition
   they actually paid for that seat: `floor(paid_tuition_vnd / planned_sessions)`, where `planned_sessions` is
   the number of occurrences of the class `rrule` between `start_on` and `end_on` (use `services/rrule.ts`),
   never less than 1. Cap the total returned for a seat at what was paid minus what was already returned (same
   cap as `classes.ts:1317`).
2. Create it as a refund row per section 1 (`ref_type = 'enrollment'`), return the real `refunded` count and
   amount, and put `refund_vnd` in the `session_cancelled` notification.
3. A session that is **moved** (`sessionMove`) is not a cancellation and refunds nothing.

## 6. G4: leaving a class does not say that nothing comes back

**Seen.** `classes.ts:731-754`. A member who leaves gets nothing back. That is the intended rule (Rule A); the
gap is that the screen does not say so before the member confirms.

**Do.**
1. Do not add any refund here. Keep the server behaviour.
2. The "Leave class…" confirmation states plainly, before the button: tuition already paid is not refunded,
   and the seat goes to the waitlist. Same sentence on the enrol/pay step ("Tuition is not refunded if you
   leave"), so the member knows before paying.

## 7. G5: the class minimum is display-only

**Seen.** `min_enrolled` is stored and shown ("2 more to reach the class minimum") but nothing acts on it. A
3/7 class is running on production.

**Do.**
1. In the scheduled jobs (`src/server/data/jobs.ts`), once per class, 24 hours before its first session: if
   confirmed seats are below `min_enrolled`, send the manager an in-app notification with the class code, the
   count and the minimum. Use an idempotency key so it is sent once.
2. Do **not** cancel automatically. The manager decides; cancelling a class already refunds through
   `classes.ts:1298` (check it against section 1 in G0).
3. On the manager's class list, mark a class that has started below its minimum.

## 8. G6: blocking a court for maintenance ignores what is already booked there

**Seen.** `extras.ts:664-676`, `syncCourtBlock` only flips `courts.status`. Court CL-01 is on maintenance on
production with a dozen classes still scheduled on it.

**Do.**
1. Creating or re-opening a work order with `blocks_court = true` first counts the confirmed/held bookings and
   scheduled sessions on that court from now on. If there are any and the request does not carry
   `confirm: true`, refuse with a conflict error whose details list them (count, first few start times).
2. With `confirm: true`: cancel each affected court booking with a **100%** refund regardless of the tier table
   (the centre cancelled, not the member), per section 1, and notify the member. Leave class sessions scheduled
   but notify the manager and the coach that those sessions need moving or cancelling; do not cancel sessions
   automatically.
3. The desk maintenance screen shows the affected list in the confirm dialog.

## 9. G7: a till shift can stay open for days

**Seen.** `desk.ts:74-104`. Only the receptionist who opened a shift can close it. A shift opened 10 Nov 16:31
is still open on 14 Nov. A cash difference is written to the audit log and nowhere else.

**Do.**
1. A manager may close any open shift (reason required, audited as `force_close_shift`), declaring the counted
   cash the same way.
2. A scheduled job notifies the manager once when a shift has been open longer than 16 hours.
3. On close, when declared cash differs from the cash total of the shift, notify the manager with both figures.

Also, small: the member Progress page shows "Completed sessions: 1" while the attendance list has 32 present.
Make the tile count sessions with result `present` or `late`, the same definition `certificates.ts:106` uses.

---

## 10. Checks before you report

```
npx tsc --noEmit
npx tsx --test src/server/controllers/tx.test.ts
npx tsx --test src/server/services/*.test.ts
npm run build
```

Report: per gap, the commit hash, files changed, the test added and its result; then "Found, not fixed".

## 11. Prompt to paste

> Read `docs/AGENT-BUSINESS-GAPS-FIX.md` and `CLAUDE.md`. Follow section 0 exactly: branch
> `fix/business-gaps`, no push, no migration, no seed change, leave the demo logins alone. Implement G0 to G7
> in order, one commit each, with the tests section 0 asks for. Refunds happen only when the centre cancels, and
> every refund is cash at the front desk
> (section 1). Run the checks in section 10 and report what you ran and saw.

---

## 12. G8: the number of managers is fixed by the seed

**Seen.** `staff.ts:24`, `const MANAGED_ROLES = ["receptionist", "coach"]`. A manager can only issue receptionist
and coach logins, so the centre has exactly the managers the seed created and can never add, replace or retire
one. (The class limit is *not* hard-coded: it is `center_settings.max_active_classes`, default 3, edited on
`manager.settings.tsx`. Leave it alone.)

**Do.**
1. A manager may create, edit, deactivate and reset the password of another **manager** account from the same
   staff screen and endpoints (`staff.ts`, the staff route under `src/routes/manager.*`). Add "Manager" to the
   role picker.
2. Guards, all server-side: a manager still cannot change their own account here; no change (role change or
   deactivation) may leave the centre with zero active managers, refuse it with a conflict error; demoting a
   manager to receptionist or coach follows the same rule. Take a lock so two concurrent requests cannot both
   pass the "at least one left" check.
3. Audit every one of these with the acting manager, as the existing staff actions do. No migration: `users.role`
   already allows `manager`.
4. Do not touch the demo logins. Tests: create a second manager, demote/deactivate the other, and the refusal
   when it would leave none.

## 13. G9: two tests in `tx.test.ts` depend on seed data

**Seen.**
- F-26 ("pending offer reserves seat against newcomer", around `tx.test.ts:1244` on main) fails on `main` too:
  the seed member it uses is already in `max_active_classes` (3) classes, so `assertUnderClassLimit` throws BR-63.
- F-09 ("validates phone and rejects conflicting slot with 409 in walkIn") fails about one run in four: it uses
  seed court `10000000-0000-0000-0000-000000000001` at a fixed `2026-11-20T09:00Z`, and migration
  `0011_scale_centre.sql` scatters seed bookings with `random()`, so that slot is sometimes already taken.

**Do.** Change the tests only, no handler change, no migration or seed change. Each test creates its own
member(s) / class / court (as section 0 rule 7 says) and uses a slot relative to now on its own court, on the
slot grid and inside opening hours at any time of day. Do not raise or bypass `max_active_classes` to make
F-26 pass. Run `npx tsx --test src/server/controllers/tx.test.ts` five times and report the five results.

## 14. G10: a bot can spam sign-up and password reset

**Why.** `/auth/register` and `/auth/forgot` are public, and each call writes an `otp_challenges` row and sends an email. The email OTP already exists (`auth.ts` `register`, `verifyOtp`, `forgot`; 6 digits, 5 minutes, 5 attempts) and there is a rate limiter (`../ratelimit`, `RULES`), but nothing proves a human is filling the form. A script can flood the inbox quota, the table and other people's mailboxes. The owner wants a captcha on member/guest sign-up and a tidier code entry.

**Do.**

1. Captcha: Cloudflare Turnstile, switched by env.
   - Server: a small `src/server/integrations/captcha.ts` with `verifyCaptcha(token, ip)` that POSTs to `https://challenges.cloudflare.com/turnstile/v0/siteverify` with `TURNSTILE_SECRET_KEY`. When the secret is not set, the check is off and returns ok (local dev, tests and the current demo keep working). When it is set, a missing or rejected token is a validation error with `field: "captcha"`; a network failure to Cloudflare is also a rejection, not a pass.
   - Call it first thing in `register` and `forgot`, before any query or email. Then list every other public, unauthenticated POST in `router.ts` that writes a row or sends a message, apply the same check where a guest can trigger it repeatedly, and name in your report the ones you left alone and why.
   - Client: render the widget on `register.tsx` and `forgot.tsx` only when `VITE_TURNSTILE_SITE_KEY` is set; send the token as `captcha_token`; reset the widget after a failed submit (tokens are single use). Load the Turnstile script only on those two routes. No new npm dependency unless it is clearly needed.
   - Do not put real keys anywhere. Add both names to the env example file with a one-line comment.
2. Cheap guards that work with no keys: a hidden honeypot field on both forms (a filled honeypot gets the same generic success answer, and nothing is written or sent), and confirm the rate-limit rules cover register, forgot, verify and resend per IP and per phone/email. Tighten only if a gap is real; say what the limits are in your report.
3. Resend: a "Didn't get a code? Resend" link on the code step with a 60-second cooldown shown as a countdown, enforced on the server too. A resend replaces the pending challenge instead of adding a row.
4. Code entry: one shared component (e.g. `src/client/components/otp-input.tsx`) used by both `register.tsx` and `forgot.tsx`, replacing the single text field. Six separate square boxes in a row, one digit each, same size and gap, centred, like the reference the owner gave (six rounded boxes, full-width primary button below, resend link under a divider). Behaviour: digits only, typing moves to the next box, Backspace on an empty box moves back, arrow keys move, pasting a 6-digit code fills all boxes, `inputMode="numeric"`, `autoComplete="one-time-code"` on the first box, one group label for screen readers, error state on all boxes when the server says the code is wrong, and the boxes must fit a 360px-wide phone. Take only the layout from the reference: colours, radius, type and focus ring come from `DESIGN.md` tokens, not its teal and serif. No GSAP here; `motion` only if needed, honouring reduced motion.

**Leave alone.** Demo logins and the demo OTP echo (`mayEchoOtp`, `OTP_ECHO`). No migration, no seed change. Login is not given a captcha in this gap (it already locks after 5 wrong passwords).

**Tests.** With the secret unset, register and forgot behave as before. With it set (stub `fetch`), a missing token and a rejected token are refused and no `otp_challenges` row is written; a valid token passes. Honeypot filled: no row, no email. Resend inside 60 seconds is refused, after it replaces the challenge. English copy first, Vietnamese added to the matching `vi.*.ts` files.

## 15. G11: the code boxes drop digits when several arrive at once

**Why.** In `src/client/components/otp-input.tsx`, `fill(index, text)` handles one character or exactly six. When 2 to 5 digits arrive in one change event (fast typing, IME, a partial paste, autofill into a later box) it keeps only the last digit, and `onPaste` ignores anything that is not exactly six digits.

**Do.** In `fill`, spread the digits of `text` across the boxes starting at `index` (strip non-digits first, stop at box 6), then focus the box after the last one filled. A paste goes through the same path from the focused box, so "123 456" or a 4-digit fragment also works. Replacing a digit in a filled box still replaces only that box. Keep the component's props and markup; touch no other file unless a test needs it.

**Tests.** If the repo has no component test setup, do not add one: extract the spreading logic as a small pure function in the same file and cover it in an existing `*.test.ts` under `src/server/services/` only if that is already where pure client helpers are tested; otherwise state in your report that it is covered by manual check only.
