# Arena3 — Software Requirements Specification

**Version 1.1 · 2026-10-04 · Status: as-built (through Phase 4C)**

This document describes what the Arena3 system does, for whom, and under which
rules. It is written *as-built*: every requirement below is implemented in this
repository, and each one names the endpoint, rule code or table that carries it
so the claim can be checked rather than believed. Where the system deliberately
does *not* do something, that is recorded too — a requirements document that
only lists the pleasant parts is a sales brochure.

**Changes from v1.0.** Version 1.1 adds what Phases 1–4C delivered: staff
accounts (§6.2), court-time rescheduling and the month calendar (§4.2),
payOS online payment (§5.7), class lifecycle and the manager member list
(§6.2), Excel/PDF report export, the capacity heatmap and the members and
enrolment report (§6.2), and the training module (§6.3, §4.8). Corrections:
the attendance lock is BR-53 and closes 2 hours after the session (FR-K03);
a switched-off module answers `403` with BR-62; SMS is no longer a feature
flag; online payment is no longer listed as out of scope.

The companion document [SDD.md](SDD.md) explains *how* these requirements are
implemented. This one stops at *what*.

---

## 1. Purpose and scope

### 1.1 The problem

A single-site sports centre runs four businesses that share one set of courts:
casual court hire, coached classes, memberships, and the front counter that
takes money for all three. Run on paper or on a spreadsheet, these four collide
in predictable ways: a court is sold twice, a class is taught on a court someone
has booked, a member pays and has nothing to prove it, and at the end of the
month nobody can say what was earned.

Arena3 is one schedule and one ledger for all four.

### 1.2 In scope

- Court availability, holds, bookings, check-in and cancellation.
- Classes: timetable generation, enrolment, waitlists, attendance, and the
  class lifecycle (cancel or move a session, change coach, close or cancel a
  class).
- Training (feature flag F4): session results, training plans, homework,
  student levels and reviews, absence-streak alerts, gate check-in.
- Memberships: plans, orders, activation, freezing, quota consumption.
- The front desk: till shifts, payments (including payOS QR), refunds,
  receipts, walk-ins, equipment.
- Management: pricing, opening rules, staff accounts, the member list, revenue,
  capacity and members reports with Excel/PDF export, audit.
- Customer care: a member can ask the desk something and read the answer.
- An in-app assistant that answers from the centre's own data.

### 1.3 Out of scope

Deliberately, and recorded so nobody plans around them:

- **Multi-site.** One centre per deployment. `center_settings` is a single row
  with a `CHECK (id = 1)`.
- **Card acquiring and bank APIs.** The one online channel is payOS (§5.7): a
  QR/transfer link whose result Arena3 confirms by polling payOS or verifying a
  webhook signature. There is no card acquirer and no other bank integration.
  `method` on a payment records how money was taken; a manual bank transfer is
  still reconciled by a human reading a statement (§5.4).
- **Outbound SMS/email.** SMS was removed (migration `0016`). The `outbox`
  table and its dispatcher exist and are exercised; the email transport is a
  stub. In-app notification is the channel that actually reaches members today.
- **Accounting integration.** Invoices are issued and printable; they are not
  exported to any accounting package.
- **Medical or fitness advice.** The assistant refuses this explicitly.

### 1.4 Definitions

| Term | Meaning |
| --- | --- |
| **Slot** | One bookable unit of court time. `slot_minutes`, default 60. |
| **Hold** | A slot reserved but not yet paid for. Expires automatically. |
| **Occupancy** | The row that makes a court busy. Courts are booked *through* occupancies, never directly (see SDD §4.2). |
| **Quota** | Court hours or class sessions included in a membership plan. |
| **Till shift** | A period during which one receptionist takes money. Opened and closed; cash is counted at close. |
| **ICT** | Indochina Time, UTC+7. Every business date in the system is an ICT date. |
| **BR-nn** | A numbered business rule. Returned to the client in the error body so a refusal can be traced to a rule. |

---

## 2. Actors

| Actor | Who they are | Where they work |
| --- | --- | --- |
| **Guest / Khách vãng lai** | Potential customer without an account or not signed in. Browses courts/plans, registers with Mail OTP. | `/`, `/plans`, `/v1/auth/register` |
| **Member / Hội viên** | A registered customer of the centre, with or without a membership plan. | `/app/*`, `/account`, `/alerts`, `/pay/return` |
| **Receptionist / Lễ tân** | Front-desk staff. Takes money, opens tills, reconciles transfers, checks members in at the gate, answers requests. | `/desk/*`, `/account`, `/alerts` |
| **Coach / Huấn luyện viên** | Teaches classes. Sees assigned classes, timetable, marks attendance, records results, writes training plans and homework, reviews students. | `/coach/*`, `/coach/classes`, `/account`, `/alerts` |
| **Manager / Quản lý** | Runs the centre. Everything a receptionist can do, plus pricing, plans, settings, staff accounts, member list, class lifecycle, reports/exports, and refund sign-off. | `/manager/*`, `/desk/*`, `/coach/*` |
| **AI Assistant / Trợ lý AI** | Intelligent assistant responding to member inquiries, court recommendations, operational data analysis. | `/assistant`, API |
| **Mail System / Hệ thống Email** | External messaging transport delivering registration OTPs, booking confirmations, notifications, and electronic invoices. | SMTP / Resend / Queue Worker |
| **Scheduler / Tiến trình lập lịch** | Automated job loop expiring holds, marking no-shows, generating sessions, and sending reminders. | Background Worker |

Roles are exclusive — a user has exactly one — and are enforced server-side on
every request (`requireRole`). The UI hides what a role cannot do; that is a
convenience, not the control.

*Detailed system architecture diagrams (Use Case Diagram, Noun-based Context Diagram, and Registration Swimlane Diagram) are formally documented in [SRS-diagrams.md](SRS-diagrams.md).*


---

## 3. Assumptions and dependencies

- **A1.** One centre, one timezone (`Asia/Ho_Chi_Minh`), one currency (VND).
- **A2.** Prices are whole dong. Money is never stored as a float; every amount
  is an integer VND column, rounded to `round_vnd` (default 1,000).
- **A3.** A member has a Vietnamese mobile number, and it is unique. The phone
  number is the login identity.
- **A4.** Staff are trusted within their role. This system protects against
  mistakes and against members acting outside their rights; it does not defend
  the till against the person standing at it. It records who did what instead
  (§7.5).
- **A5.** PostgreSQL 16 or compatible. The schema relies on `btree_gist`
  exclusion constraints, `jsonb`, and PL/pgSQL. This is not portable to MySQL.
- **A6.** The assistant requires a Gemini API key. Without one it falls back to
  in-house rule-based answers rather than failing (§9.3).

---

## 4. Functional requirements — Member

### 4.1 Identity

| ID | Requirement | Enforced by |
| --- | --- | --- |
| FR-M01 | A person registers with name, phone, date of birth and a password. | `POST /v1/auth/register` |
| FR-M02 | A phone number may hold exactly one account. | **BR-01** |
| FR-M03 | A password is at least 8 characters and mixes letters and digits. Registration and change both require it typed twice. | **BR-02** |
| FR-M04 | A member under `minor_age` (default 16) cannot register without guardian name and phone. | **BR-07** |
| FR-M05 | Registration requires explicit acceptance of the terms and the data-privacy notice. | **BR-08** |
| FR-M06 | Registration is confirmed by an OTP. | `POST /v1/auth/otp/verify` |
| FR-M07 | A member may edit their own name and health notes, and change their own password. Neither can be done for another user. | `PATCH /v1/me`, `POST /v1/me/password` |
| FR-M08 | A member session lasts 7 days; a staff session lasts 12 hours. | `issueSession` |
| FR-M09 | A member who forgot their password can reset it with an OTP. | `POST /v1/auth/password/forgot` |
| FR-M10 | A member reads their notifications, opens one to see its content, and marks one or all as read. The bell shows the unread count. | `GET /v1/me/notifications`, `POST /v1/me/notifications/read`, `outbox.read_at` |
| FR-M11 | A staff account created by a manager signs in with a temporary password and must change it on first sign-in. | `POST /v1/staff`, `POST /v1/staff/:id/reset-password` |

> **Known deviation.** The registration and password-reset OTP is displayed on
> screen rather than sent, because there is no SMS transport (§1.3). The echo
> is on by default in development and off in production (`OTP_ECHO`,
> `NODE_ENV`); the one-tap demo sign-in is off in production unless
> `VITE_DEMO_LOGINS=on` (NFR-22). A deployment holding real customer accounts
> must still replace the OTP channel with a real transport.

### 4.2 Booking a court

| ID | Requirement | Enforced by |
| --- | --- | --- |
| FR-B01 | A member sees live availability per court and day, including which slots are held by others. | `GET /v1/occupancy` |
| FR-B02 | Booking a slot creates a **hold**, not a booking. The hold lasts `hold_minutes` (default 5). | `POST /v1/bookings` |
| FR-B03 | Two members cannot hold the same court-time. The second attempt is refused, not queued. | Court row lock + overlap trigger → `409 CONFLICT_SLOT` |
| FR-B04 | A slot in the past cannot be booked. | **BR-66** |
| FR-B05 | A slot outside `open_time`–`close_time` cannot be booked. | **BR-35** |
| FR-B06 | A member may book at most `book_ahead_days` (default 7) days ahead. | **BR-32** |
| FR-B07 | A member may hold at most `max_slots_per_day` (default 2) slots for any one day. | **BR-32** |
| FR-B08 | *(Removed in v2.4 — no debt in the system; see BR-19.)* | — |
| FR-B09 | A court not in `ready` status cannot be booked. | **BR-35** |
| FR-B10 | An unpaid hold is released automatically when its clock runs out, and the slot returns to sale. | `expireHolds` job |
| FR-B11 | Paying converts the hold to a confirmed booking, posts a payment and issues a receipt — atomically. Either all of it happens or none of it does. | `POST /v1/bookings/:id/confirm` |
| FR-B12 | A member with court hours left on their plan may pay with quota instead of money. One hour is consumed. | **BR-17** |
| FR-B13 | Paying by bank transfer does **not** confirm the booking (§5.4). | `POST /v1/bookings/:id/confirm` → `202` |
| FR-B14 | A member may cancel their own court up to `cancel_court_hours` (default 2) before it starts. | `POST /v1/bookings/:id/cancel` |
| FR-B15 | A member may check in from `checkin_before_minutes` (default 15) before the start. | `POST /v1/bookings/:id/check-in` |
| FR-B16 | A booking nobody checks into is marked a no-show after `noshow_grace_minutes`, and is not refunded. | `markNoshow` job |
| FR-B17 | A member sees, for up to 62 days at once, how many slots are free each day, in a week strip and a month grid. Days in the past or beyond `book_ahead_days` are shown but cannot be chosen. | `GET /v1/availability?from&days&sport` (one read; `400` with `field` on bad input) |
| FR-B18 | A member may move a confirmed court booking to another slot, but only **outside** the cancellation window. The move and the occupancy change are one transaction; a lost race returns `409 CONFLICT_SLOT` and the booking stays where it was. | `POST /v1/bookings/:id/reschedule`, **BR-32**, **BR-35**, **BR-66** |
| FR-B19 | A reschedule that would change the price is refused (`409`, with `paid_vnd` and `new_price_vnd`); the member cancels and books again. A booking paid with quota has no price difference. | `POST /v1/bookings/:id/reschedule` |
| FR-B20 | Staff can click any booked, held, class or maintenance cell on the court grid and see who holds it (member or walk-in, name and phone), the code, the time, the amount and the status. A member never sees this. | `GET /v1/occupancy/detail` (staff only) |

### 4.3 Classes

| ID | Requirement | Enforced by |
| --- | --- | --- |
| FR-C01 | A member sees the published timetable with remaining places. | `GET /v1/classes` |
| FR-C02 | Enrolling requires an active plan covering that sport. | **BR-12** |
| FR-C03 | A plan with a session quota must have sessions left. | **BR-18** |
| FR-C04 | A member cannot enrol in a class that clashes with one they are already in. | **BR-24** |
| FR-C05 | A member cannot enrol twice in the same class. | **BR-24** |
| FR-C06 | A class that is not `open` cannot be enrolled in. | **BR-67** |
| FR-C07 | When a class is full, enrolling joins a first-come waitlist with a visible position. | `enrollment_waitlist` |
| FR-C08 | When a place frees, the first person on the waitlist is offered it. The offer stands for `waitlist_offer_hours` (default 2), then passes to the next person. | `waitlistExpire` job |
| FR-C09 | An expired offer cannot be accepted. | **BR-25** |
| FR-C10 | A class that filled between the offer and the acceptance refuses the acceptance rather than overfilling. | **BR-22** |
| FR-C11 | A member may leave a class up to `cancel_class_hours` (default 4) before the next session. | **BR-20** |
| FR-C12 | A member sees their own attendance per session — Present, Late, Absent, Excused — with totals; a session not yet marked reads "Not marked yet". Nobody else's attendance is readable. | `GET /v1/me/attendance` (own rows only; staff `403`) |
| FR-C13 | When the centre cancels a session or a whole class, a member on a per-session plan gets the session back, once; a time-based plan has nothing to give back. Members are notified. | `POST /v1/sessions/:id/cancel`, `PATCH /v1/classes/:id`, **BR-26** |
| FR-C14 | When a session is moved, members are told the new time. | `POST /v1/sessions/:id/reschedule`, **BR-28** |

### 4.4 Membership

| ID | Requirement | Enforced by |
| --- | --- | --- |
| FR-P01 | A member sees the plans currently on sale, with what each includes. | `GET /v1/plans` |
| FR-P02 | Ordering a plan creates a `pending` subscription. It is not active until paid for. | `POST /v1/subscriptions` |
| FR-P03 | A plan withdrawn from sale cannot be ordered by a member. | **BR-65** |
| FR-P04 | A member with a frozen plan cannot buy another until they unfreeze it. | **BR-14** |
| FR-P05 | Plan orders are rate limited: 3 per minute and 10 per hour per member. | `RULES.planRequest*` |
| FR-P06 | A subscription activates when enough has been paid — in full, or `deposit_pct_activates` if the centre allows deposits. | `activateSubscription` |
| FR-P07 | A member may freeze an active plan, up to `freeze_max_days_year` days a year. | **BR-14** |

### 4.5 Money, from the member's side

| ID | Requirement | Enforced by |
| --- | --- | --- |
| FR-R01 | Every payment a member makes issues an invoice with line detail. | `invoices`, `invoice_lines` |
| FR-R02 | A member can see every receipt Arena3 has ever issued them and open each as a PDF. | `GET /v1/invoices`, `/account` › Receipts |
| FR-R03 | **Every payment, by any method, notifies the payer with the amount and a link to the receipt.** | `enqueueReceipt` |
| FR-R04 | A refunded payment is shown as refunded wherever it appears. | `payments.status` |
| FR-R05 | A member may pay their own held court online: Arena3 raises a payOS link with a QR code, and the booking is confirmed only when payOS reports the money moved (§5.7). Landing on the return page proves nothing. A plan order is paid through the desk, which may raise the same link. | `POST /v1/payments/online`, `POST /v1/payments/online/:id/verify`, `/pay/return` |

### 4.6 Customer care

| ID | Requirement | Enforced by |
| --- | --- | --- |
| FR-S01 | A member can send the front desk a question or complaint, from the assistant (`ticket: …`) or from Account › Support. | `POST /v1/tickets` |
| FR-S02 | Repeated `ticket:` prefixes are stripped; the desk reads the message, not the instruction. | `ticketBody` |
| FR-S03 | A request with no content is refused rather than opened blank. | `ticketsCreate` |
| FR-S04 | **A member can see every request they have sent and the reply to each.** | `GET /v1/tickets/mine` |
| FR-S05 | A member is notified when the desk replies. | `ticket_replied` notification |

### 4.7 The assistant

| ID | Requirement | Enforced by |
| --- | --- | --- |
| FR-A01 | The assistant answers about opening hours, prices, plans, coaches, classes, booking, cancelling and waitlists, from the centre's live data — not from general knowledge. | `assistantChat` |
| FR-A02 | A question is at most 800 characters. The composer stops there and says so. | `MAX_CHARS` |
| FR-A03 | At most 20 questions a minute per member. | `RULES.assistant` |
| FR-A04 | The assistant gives no medical advice. | System prompt and fallback text |
| FR-A05 | With no model key configured, the assistant answers from rules rather than failing. The answer is labelled with its source. | `generateAssistantReply` |
| FR-A06 | The assistant can open a support request but can never take money, book, cancel or change anything. | No mutating tools are exposed to it |

### 4.8 Training (member side, feature flag F4)

When F4 is off every endpoint in this section answers `403 FORBIDDEN` with
`br: "BR-62"`, and the Progress tab is not shown. Nothing here takes money or
touches a membership balance (**BR-56**).

| ID | Requirement | Enforced by |
| --- | --- | --- |
| FR-TRN-M01 | The **Progress** tab shows the member's training goal, level per sport, their next 3 sessions with the published plan for each, results of the last 10 sessions (plan %, metrics, coach's note), the coach's last 10 reviews (technique, fitness, attitude, 1–5) and homework still open. | `GET /v1/me/training` |
| FR-TRN-M02 | A member sets one training goal: weight, technique, compete or fun. | `PUT /v1/me/training-goal`, `training_profiles` |
| FR-TRN-M03 | A member sees homework set for their class or for them personally, ticks the checklist items, and the homework is complete when every item is ticked. | `GET /v1/me/homework`, `PUT /v1/me/homework/:id`, `homework_recipients` |
| FR-TRN-M04 | A member is notified when a coach adds a review (`review_added`) or assigns homework (`homework_assigned`). | `studentReviewPost`, `homeworkCreate` |
| FR-TRN-M05 | Internal coach notes about a student are never returned to the member. | `coach_notes` read only in `GET /v1/students/:id/profile` (staff) |
| FR-TRN-M06 | Every role reads its notifications on `/alerts`, reached from the bell in the header. | `GET /v1/me/notifications` |

---

## 5. Functional requirements — Front desk

### 5.1 Till shifts

| ID | Requirement | Enforced by |
| --- | --- | --- |
| FR-D01 | A receptionist opens a till shift before taking money. | **BR-49** |
| FR-D02 | Only one shift per receptionist may be open at a time. | `shiftOpen` |
| FR-D03 | Closing a shift records counted cash against the books' expectation. | `POST /v1/shifts/:id/close` |
| FR-D04 | Every payment a receptionist takes is attached to their shift. | `payments.shift_id` |

### 5.2 Serving people

| ID | Requirement | Enforced by |
| --- | --- | --- |
| FR-D05 | A receptionist can find a member by name, phone or member code. | `GET /v1/members?q=` |
| FR-D06 | A receptionist can create a member at the counter and sell them a plan in one flow. | `POST /v1/members` |
| FR-D07 | A receptionist can sell a court to a walk-in with no account, taking name and phone only. | `POST /v1/walk-in` |
| FR-D08 | A walk-in may be sold into a slot already under way, provided at least 20 minutes remain. | **BR-66** |
| FR-D09 | A receptionist can lend and take back equipment, and stock is enforced. A loan goes to a member found by search, or to a guest by phone number; returning restores exactly the quantity on that loan and cannot be done twice (`409`). Rental fees do not create a payment row (see G-07 in §6.2). | **BR-38**, `POST /v1/equipment/loans`, `POST /v1/equipment/loans/:id/return` |
| FR-D28 | Reception or a manager can correct a member's name, phone, date of birth and guardian. A phone already held by another account is refused; the new number is normalised; the change is audited. | `PATCH /v1/members/:id`, **BR-01**, **BR-07** |
| FR-D29 | Reception sees every class with its sessions, court, coach, enrolment and roster (waitlist included). | `GET /v1/classes/:id`, `GET /v1/classes/:id/roster` |
| FR-D30 | Reception checks a member in at the gate by phone number or member code. The check-in is recorded once per 5 minutes, listed for today, and does **not** mark class attendance — the coach's register is the record of Present or Late. Requires F4. | `POST /v1/desk/gate-checkin`, `GET /v1/desk/gate-checkins`, **BR-54**, **BR-62** |

### 5.3 Taking money

| ID | Requirement | Enforced by |
| --- | --- | --- |
| FR-D10 | A payment records method, amount, VAT rate, what it was for, who took it and which shift. | `payments` |
| FR-D11 | Every payment issues an invoice. | `paymentsCreate` |
| FR-D12 | A repeated payment request with the same idempotency key returns the original payment instead of taking the money twice. | `withIdempotency` |
| FR-D13 | **Reception can see every payment taken in the last 7/14/30 days, by any method, with its receipt — filterable by method.** | `GET /v1/payments/pending` |

### 5.4 Bank transfers

The rule behind this section: *a bank transfer is a promise, not a payment.*

| ID | Requirement | Enforced by |
| --- | --- | --- |
| FR-D14 | Choosing "bank transfer" in the app posts **no payment** and confirms **no booking**. It returns `202`. | `bookingsConfirm` |
| FR-D15 | The slot stays held for `transfer_hold_minutes` (default 120) instead of `hold_minutes` — a banking app takes longer than a card reader. | `center_settings` |
| FR-D16 | Outstanding transfers appear as a desk queue, oldest first, with the member's phone. | `paymentsPending` |
| FR-D17 | Only a receptionist or manager can mark a transfer as received. A member cannot reconcile their own. | `requireRole` → **403** |
| FR-D18 | Reconciling a transfer produces exactly the same payment, invoice and member notification as any other method. | `settleHeldBooking` |
| FR-D19 | A transfer whose hold has expired cannot be reconciled — the court may already have been sold. | **HOLD_EXPIRED** |
| FR-D20 | Reception can reject a transfer that never arrived; the slot returns to sale and the member is told. | `transfer-reject` |

### 5.5 Refunds

| ID | Requirement | Enforced by |
| --- | --- | --- |
| FR-D21 | A refund above `refund_manager_vnd` (default 1,000,000đ) needs a manager's sign-off and waits in a queue. | `refund_pending` |
| FR-D22 | **The same payment cannot be refunded twice.** The guard reads the whole ledger for the booking, not one row. | `paymentsRefund` → **422** |
| FR-D23 | A manager can approve or reject a pending refund; both are audited. | `approve-refund`, `reject-refund` |

### 5.6 Customer care, desk side

| ID | Requirement | Enforced by |
| --- | --- | --- |
| FR-D24 | Open requests from members appear on the desk home. | `GET /v1/tickets` |
| FR-D25 | **The desk can reply in writing. Replying closes the request and notifies the member.** | `POST /v1/tickets/:id/reply` |
| FR-D26 | A request can still be closed without a reply (duplicate, or handled in person). | `POST /v1/tickets/:id/close` |
| FR-D27 | Replies are attributed to the member of staff who wrote them. | `tickets.replied_by` |

### 5.7 Online payment (payOS)

The rule behind this section: *money is posted when payOS says it moved, and at
no other moment.* The return URL can be opened by anybody in any order.

| ID | Requirement | Enforced by |
| --- | --- | --- |
| FR-D31 | Online payment is available only when payOS is configured; otherwise the request is refused with a message to take payment at the desk. | `onlineCreate` → `BR_VIOLATION` (`C-08`) |
| FR-D32 | Reception raises a payOS link for a held court or a `pending` plan order and shows the QR to the customer at the counter. A member may raise one only for their own held court. A held court whose clock has run out, or a plan not `pending`, is refused. | `POST /v1/payments/online` |
| FR-D33 | One live link exists per thing being paid for; pressing the button twice returns the same link. | `onlineCreate` (`reused: true`) |
| FR-D34 | The link outlives neither the court hold nor `transfer_hold_minutes`. | `expiresInSeconds` |
| FR-D35 | A payment becomes `posted` only after Arena3 has polled payOS (`verify`) or verified a signed webhook, and only if the amount paid is at least the amount due. A partial confirmation posts nothing. | `settleOnline`, `POST /v1/payments/online/:id/verify`, `POST /v1/payments/online/webhook` |
| FR-D36 | An online payment goes through the same settle path as cash: booking confirmed or plan activated, invoice issued, payer notified. It is marked `capture_mode = 'auto'` so the till can tell it from money taken by hand. Poll and webhook cannot post it twice. | `settleHeldBooking`, `activateSubscription` |
| FR-D37 | A cancelled or expired link marks the payment `failed` or `expired`; the slot follows the normal hold rules. | `onlineVerify` |
| FR-D38 | Issuing a link is audited (`online_link`). | `audit` |

---

## 6. Functional requirements — Coach and Manager

### 6.1 Coach

| ID | Requirement | Enforced by |
| --- | --- | --- |
| FR-K01 | A coach sees their own schedule and nobody else's, grouped by day, each session with its date, time, court, class code (for example `BAD-BEG-XXXX`), enrolment and level. Opening a session opens its register. | `GET /v1/coach/schedule` |
| FR-K02 | A coach marks attendance for a session they teach: Present, Late, Absent or Excused. A coach can read and write the register of their own classes only. | `GET/PUT /v1/sessions/:id/attendance`, **BR-59** |
| FR-K03 | The register closes 2 hours after the session ends, or when the session is marked done. After that a coach is refused (`422`, BR-53); only a manager can correct it, and must give a reason of at least 3 characters, which is audited. | **BR-53** |
| FR-K04 | A coach can only be assigned to a class in a sport they teach. | **BR-23** |
| FR-K05 | A coach cannot be scheduled into two places at once. | `coach_occupancies` overlap trigger, **BR-21** |
| FR-K06 | The coach screens share the same menu and header as every other role: Schedule, Attendance, Training, Profile. | `src/components/shell.tsx` |

### 6.2 Manager

| ID | Requirement | Enforced by |
| --- | --- | --- |
| FR-G01 | A manager creates and edits membership plans and can withdraw one from sale. | `POST/PATCH /v1/plans` |
| FR-G02 | A manager sets price rules per sport, court class, day type and hour band. | `PUT /v1/price-rules` |
| FR-G03 | A manager edits centre settings: opening hours, slot and hold length, cancellation windows, refund limits, VAT and rounding. | `PATCH /v1/settings` |
| FR-G04 | A manager changes a court's status — ready, maintenance, closed. A court out of service cannot be booked. | `PATCH /v1/courts/:id` |
| FR-G05 | A manager reads revenue for any period, broken down by source (court, plan, refunds) and by till shift, filterable by payment method (cash, transfer, card, gateway, quota; `from` ≤ `to`), **with the change against the preceding period of equal length shown in green when it is good news and red when it is not.** The response carries `prev`. | `GET /v1/reports/revenue` |
| FR-G06 | The direction of a change is not assumed to be good: revenue up is green, refunds up is red. | `delta(cur, prev, upIsGood)` |
| FR-G07 | A manager reads court occupancy for a period. | `GET /v1/reports/occupancy` |
| FR-G08 | A manager reads the audit log, filtered by actor, action, entity and date range. The default view is short with "Show more"; hiding a row is a UI choice and nothing deletes audit rows. | `GET /v1/audit` |
| FR-G09 | A manager creates classes (coach and court chosen from real data), assigns coaches and publishes timetables. | `POST /v1/classes`, `:id/publish` |
| FR-G10 | A manager toggles feature flags F4 (training), F5 and F6 without a deploy. | `PATCH /v1/flags` |
| FR-G11 | A manager opens a class: sessions, court, coach, enrolment, roster and waitlist. | `GET /v1/classes/:id`, `GET /v1/classes/:id/roster` |
| FR-G12 | A manager cancels a single session with a reason. Each enrolled member on a per-session plan gets one session back, once; a second cancel is refused (`409`). Members are notified and the action is audited. | `POST /v1/sessions/:id/cancel`, **BR-26** |
| FR-G13 | A manager moves a session to another time on the same court with the same coach. A clash is refused (`409 CONFLICT_SLOT`). A move less than 12 hours before the old time needs a reason (`422`). The original time is kept. | `POST /v1/sessions/:id/reschedule`, **BR-21**, **BR-28** |
| FR-G14 | A manager puts another coach on a class from now on. The coach must teach that sport and be free at every upcoming time. | `POST /v1/classes/:id/coach`, **BR-23**, **BR-21**, **BR-27** |
| FR-G15 | A manager edits a class — capacity, open/closed status — or cancels it. Capacity cannot go below the number already enrolled. Cancelling refunds one session per enrolled member once, cancels upcoming sessions and notifies members and the waitlist. | `PATCH /v1/classes/:id`, **BR-22**, **BR-67**, **BR-26** |
| FR-G16 | A manager issues staff accounts (receptionist or coach), locks and unlocks them, changes role between those two, resets a password (temporary, change forced at next sign-in) and revokes sessions. There is no public staff sign-up, no admin role, and a manager cannot lock or demote themselves. Every action is audited with who and when. | `GET/POST /v1/staff`, `PATCH /v1/staff/:id`, `POST /v1/staff/:id/reset-password`, `POST /v1/staff/:id/revoke-sessions` |
| FR-G17 | A manager approves or rejects pending refunds from a queue on the manager side (not only from the desk). | `approve-refund`, `reject-refund` |
| FR-G18 | A manager sees every member with filters, paging, plan and class count, and opens one. | `GET /v1/directory/members`, `/manager/members` |
| FR-G19 | A manager opens a plan to see price, duration, court hours or sessions, discount, sport scope, whether it is on sale, and how many members hold it. A plan cannot be hard-deleted; "Stop selling" withdraws it and members who hold it keep using it. | `GET /v1/plans/:id`, `PATCH /v1/plans/:id`, **BR-65** |
| FR-G20 | A manager reads a **capacity report** for up to 93 days: occupancy by court and by hour as a heatmap, peak against off-peak (from `price_rules.is_peak`), with court revenue kept apart from class fees. | `GET /v1/reports/capacity` (**FR-CRT-09**) |
| FR-G21 | A manager reads a **members and enrolment report**: new and renewing members (a renewal is a new plan within 30 days of the previous one ending), enrolment per class, and attendance %. Attendance % is hidden when F4 is off or nothing has been marked, rather than printed as 0%. | `GET /v1/reports/members` (**FR-PAY-06**), **BR-62** |
| FR-G22 | A manager exports the revenue, capacity and members reports as Excel (`xlsx`) or PDF. Money cells in the spreadsheet are numbers, not text. An unknown `format` is `400` with `field: "format"`; an unknown report is `404`; the PDF uses an embedded font so Vietnamese diacritics render. Receptionists and coaches are refused. | `GET /v1/reports/{revenue,capacity,members}/export?format=xlsx\|pdf` (manager only) |
| FR-G23 | Settings reject bad input rather than failing: each key is validated, a wrong field is `400 VALIDATION` with its `field`, the form marks that field, and closing time must be after opening time. `timezone` and `currency` are fixed by design (A1). | `PATCH /v1/settings` |

> **Known limit.** Class fees and equipment rental create no payment row, so
> they are zero in the revenue report; the screen says so rather than inventing
> a number. Splitting them out needs a product decision to record that income.

### 6.3 Training (coach and manager, feature flag F4)

When F4 is off these endpoints answer `403 FORBIDDEN` with `br: "BR-62"`. A coach
reaches only classes they lead or assist (**BR-59**); a manager reaches all. A
student's health notes leave this module only inside that scope (**BR-55**).
Nothing here charges money or changes a membership balance (**BR-56**).

| ID | Requirement | Enforced by |
| --- | --- | --- |
| FR-TRN-01 | Attendance results are Present, Late, Absent, Excused. Late is the coach's call, not derived from the gate (**BR-54**, **BR-57**). Saving a register checks each student's absence streak. | `PUT /v1/sessions/:id/attendance` |
| FR-TRN-02 | **Absence streak.** Three consecutive Absent marks in a class raise an `absent_streak` alert to the head coach, the assistant coach and every active manager. An Excused mark breaks the streak. The system never drops the enrolment by itself. | `checkAbsentStreaks`, **BR-58**, `ABSENT_STREAK_LIMIT = 3` |
| FR-TRN-03 | A coach opens a student's profile: goal, level per sport, attendance totals (present, late, absent, excused), session results, reviews, staff notes and homework, with the student's details limited to what the coach's scope allows. | `GET /v1/students/:id/profile`, **BR-55**, **BR-59** |
| FR-TRN-04 | **Session results.** For each student in the session a coach records a plan-completion % (0–100) and optional metrics — `smash_count` (≤ 1000), `freethrow_pct` (≤ 100), `serve_pct` (≤ 100) — and a note. Out-of-range values are `400` with the field. | `GET/PUT /v1/sessions/:id/results` |
| FR-TRN-05 | **Training plans.** A plan is up to 12 blocks (title ≤ 120 characters, 1–180 minutes, phase warm-up / technique / fitness / match / cool-down), attached to a class, a session or one student. A plan can be published or hidden. "Suggest" drafts one from sport, level and focus. A coach can copy last week's plans into the current week; the copies are **drafts** the coach must publish. | `GET/POST/PATCH /v1/training-plans`, `POST /v1/training-plans/suggest`, `POST /v1/classes/:id/plans/duplicate-week` |
| FR-TRN-06 | **Level and reviews.** A coach sets a student's level per sport (beginner, intermediate, advanced) and writes reviews for a 2- or 4-week period with technique, fitness and attitude scored 1–5. A review is append-only — it cannot be edited or deleted — and notifies the student. | `PUT /v1/students/:id/level`, `POST /v1/students/:id/reviews` (`progress_reviews` append-only trigger) |
| FR-TRN-07 | **Homework.** A coach assigns homework to a class or to one student (not both), with a checklist of at most 20 items of at most 120 characters and an optional due date. Recipients are notified. | `GET/POST /v1/homework`, `homework_recipients` |
| FR-TRN-08 | **Staff notes.** A coach records a note about a student visible to staff only. | `POST /v1/students/:id/notes`, `coach_notes` |
| FR-TRN-09 | Only a manager can correct a closed register, and must give a reason; the correction is audited. A coach asking gets `422`. | `PUT /v1/sessions/:id/attendance`, **BR-53** |

---

## 7. Non-functional requirements

### 7.1 Correctness of the schedule

**NFR-01.** It must be impossible for two bookings to own the same court-time,
under any concurrency. This is enforced in the database, not in the handler —
two requests arriving in the same millisecond on different instances must still
produce one winner and one `409`. Both booking paths take a row lock on the
court before attaching an occupancy, so they serialise; a trigger then rejects
any overlap. See SDD §4.2 for why this is a trigger rather than an `EXCLUDE`
constraint, and where the guarantee is weaker.

**NFR-02.** The same requirement holds for coaches: no coach may be scheduled
into two overlapping sessions.

**NFR-03.** Money and schedule must never disagree. A confirmed booking always
has its payment and its invoice; a payment for a booking always has a confirmed
booking. Both are written inside one transaction (SDD §4.1).

### 7.2 Performance

**NFR-04.** `GET /v1/me` is on the critical path of every sign-in and is
composed of seven independent reads; they are issued concurrently, so the
request costs one round trip rather than seven.

**NFR-05.** Read-only endpoints do not open a transaction. A `BEGIN/COMMIT`
around a pure `SELECT` costs two extra round trips to a remote database and
buys nothing.

**NFR-06.** The desk home asks for a badge count (`?brief=1`), which runs one
aggregate query — not the three joined queries the full queue screen needs.

**NFR-07.** The background job loop must not poll expensively. Jobs are
scheduled by due time; a pass with nothing to do costs approximately nothing.

### 7.3 Resilience

**NFR-08.** Any request that takes money or changes a schedule accepts an
`Idempotency-Key` and returns the original result on replay. A retried tap must
not charge twice.

**NFR-09.** With no `DATABASE_URL`, the application runs against an embedded
PGLite database and migrates and seeds itself, so a fresh clone works offline
with no setup.

**NFR-10.** Losing the assistant's upstream model degrades the assistant to
rule-based answers. It does not degrade anything else.

### 7.4 Usability

**NFR-11.** Every screen works at 375 px. The member app is a PWA and is
installable.

**NFR-12.** A refusal tells the member what to do instead. Error text is a
sentence, not a code — the code travels alongside it for support.

**NFR-13.** Type is set in three faces with one job each: Be Vietnam Pro for
running text (which must render Vietnamese diacritics correctly), Newsreader
for headings, Anton for figures. Currency is never uppercased — `1,500,000đ`,
never `1,500,000Đ`.

**NFR-14.** Motion is decorative and never load-bearing. Nothing is only
discoverable by animating.

### 7.5 Auditability

**NFR-15.** Every state change a member cannot make themselves — refunds,
transfer reconciliation, shift closes, settings edits, ticket replies, session
cancel and move, coach change, class edit or cancel, staff account actions,
attendance corrections, online payment links — writes an audit row naming the
actor, the action, the entity and the time. No endpoint deletes an audit row.

**NFR-16.** Document codes (member, payment, invoice) are allocated from a
counter table and are gapless per kind.

### 7.6 Security and privacy

**NFR-17.** Passwords are stored as salted hashes. No plaintext password is
written anywhere, including logs.

**NFR-18.** A session token is stored as a SHA-256 hash; the raw token exists
only on the client.

**NFR-19.** Authorisation is checked server-side on every request. Hiding a
button is not a control.

**NFR-20.** A member can read only their own bookings, receipts, tickets and
profile. Cross-member reads are `403`, not filtered-empty.

**NFR-21.** Health notes and guardian details are personal data, visible to the
member and to staff who need them, and are never sent to the assistant's
upstream model.

**NFR-22.** The demo password must not be printed on the sign-in page of a
deployment. In production the one-tap demo is off unless `VITE_DEMO_LOGINS=on`
is set explicitly, and the OTP is not echoed to the screen (`OTP_ECHO`).

**NFR-23.** A module behind a feature flag (F4 training) that is switched off
answers `403 FORBIDDEN` with `br: "BR-62"` on every route, so a screen can tell
"switched off" from "not allowed for you".

**NFR-24.** Report exports are generated on request from the same queries as
the screens, so a file and a screen for the same period always agree. Files are
not stored.

**NFR-25.** Online payment confirmations are trusted only when read from payOS
or carried by a verified webhook signature; an amount from outside is never
trusted without comparison to the amount due.

---

## 8. Business rules index

Rules are returned in the error body as `{ code: "BR_VIOLATION", br: "BR-nn",
message }`, so any refusal in the UI can be traced to the line that made it.

| Code | Rule |
| --- | --- |
| BR-01 | One account per phone number / email. |
| BR-02 | Password ≥ 8 characters, letters and digits. |
| BR-07 | A minor needs guardian details. |
| BR-08 | Terms and privacy notice must be accepted. |
| BR-12 | Class enrolment needs an active plan covering that sport. |
| BR-14 | Freeze rules: only an active plan; not while frozen. |
| BR-15 | Freeze allowance per year. |
| BR-17 | Quota payment needs court hours left. |
| BR-18 | Session quota must not be exhausted. |
| BR-20 | Class cancellation window. |
| BR-21 | No court or coach clash: moving a session or changing coach is refused when the court or coach is busy. |
| BR-22 | Cannot overfill a class; capacity cannot be set below the number enrolled. |
| BR-23 | Coach must teach that sport. |
| BR-24 | No clashing or duplicate enrolment. |
| BR-25 | A waitlist offer expires. |
| BR-26 | When the centre cancels a session or class, a per-session plan gets the session back once; a time-based plan has nothing to return. |
| BR-27 | Substitute coach: a class can be handed to another coach from now on. |
| BR-28 | A session moved less than 12 hours before its old time needs a reason. |
| BR-32 | Booking horizon and daily slot cap. |
| BR-35 | Opening hours; court must be ready. |
| BR-38 | Equipment stock. |
| BR-39 | Occupancy integrity. |
| BR-44 | Money may be taken at the desk only within the receptionist's open cashier shift. |
| BR-49 | An open till shift is required to take money. |
| BR-53 | The register closes 2 hours after the session ends or when it is done; only a manager, with a reason, can correct it. |
| BR-54 | The gate is not the class: gate check-in never fills class attendance. |
| BR-55 | A student's health notes are visible only within the viewer's scope. |
| BR-56 | Training (homework, results, reviews) never charges money or changes a plan's balance. |
| BR-57 | Late is the coach's mark in the register. |
| BR-58 | Three consecutive Absent marks raise an alert to the coach and managers; Excused breaks the streak; enrolment is never dropped automatically. |
| BR-59 | A coach works only the classes they lead or assist. |
| BR-62 | A switched-off feature flag (F4) answers `403 FORBIDDEN` with `br: "BR-62"`. |
| BR-65 | A withdrawn plan cannot be ordered. |
| BR-66 | No booking in the past; walk-in needs 20 minutes left. |
| BR-67 | A class must be open to enrol. |

The table above is as-built. Most codes are returned in the error body
(`br: "BR-nn"`). The Phase 4 rules differ in how they show up: BR-28, BR-53 and
BR-62 are returned as `br` codes; BR-21 appears in the text of the `409`
clash message; BR-26 and BR-27 are enforced in the class-lifecycle handlers
(session credit once, coach validation) and cited in their comments; BR-54 to
BR-59 are enforced by the training handlers' queries and scope checks. A
refusal under those rules is still a named, explained response; it just does
not always carry a `br` field.

Rules added in A3-SRS-001 v1.3.2 and v1.4 (with A3-SDD-001 v0.4) that the
running code does not emit yet, or only covers in part, are listed separately:

| Code | Rule | Status |
| --- | --- | --- |
| BR-19A | A plan grants benefits only while `start_on ≤ today ≤ end_on`. | Implemented — `memberDiscount` checks `start_on` and `end_on` |
| BR-34A | Plan discount percentages are integers in `[0, 100]`. | Enforced by the `court_discount_pct` CHECK on plans; the API does not emit `BR-34A` |
| BR-34B | No matching price rule ⇒ refuse to quote; never invent a default price. | Implemented — `lookupPrice` throws `BR-34B` when no rule matches or the matched price is outside `(0, 5,000,000]đ`; the same bound is enforced by `priceRulesPut` and a DB `CHECK` on `price_rules` |
| BR-39H | Replacing a hold validates the new hold first; any failure keeps the old hold. | Implemented — `bookingsHold` runs every check before `booking_replace_hold` in one transaction |
| BR-42A | One VAT display mode: prices include VAT (default) or exclude it. | Default mode only — no `prices_include_vat` setting yet |
| BR-43A | Order of money operations; round once, half up, after the discount (and VAT when prices exclude it). | Matches current behaviour in the default VAT mode |

---

## 9. External interfaces

### 9.1 API

A single JSON API under `/v1`. Bearer token in `authorization`. Errors are
`{ code, message, ... }` with these mappings:

| HTTP | Code | Meaning |
| --- | --- | --- |
| 401 | `UNAUTHENTICATED` | No session, or it expired. |
| 400 | `VALIDATION` | A form value was malformed. Carries `field` (and `index` for a row in a list) so the screen marks the right input. |
| 403 | `FORBIDDEN` | Wrong role, or somebody else's data. With `br: "BR-62"` and `flag`: the module is switched off. |
| 404 | `NOT_FOUND` | No such thing. |
| 409 | `CONFLICT_SLOT` | Somebody else got that court-time first. |
| 409 | `HOLD_EXPIRED` | The clock ran out. |
| 409 | `CONFLICT_STATE` | Right thing, wrong state. |
| 422 | `BR_VIOLATION` | A named business rule refused it. Carries `br`. |
| 422 | `VALIDATION` | The request was well-formed but not acceptable in the current state. |
| 429 | `RATE_LIMITED` | Too fast. |

The API is served inside the web application (`src/routes/v1.$.ts`, dispatch
in `src/lib/arena3/router.ts`); there is no separate backend service. Report
exports return a file (`xlsx` or `pdf`) rather than JSON.

### 9.2 payOS

Online payment uses payOS to create a payment link and QR, to read a link's
state, and to deliver a signed webhook. Credentials are server-side
environment variables; none reach the browser. Order codes come from the clock
and a recorded high-water mark (`provider_sequences`), so a code is never
reused. `GET /v1/payments/online/sequence` returns that counter and a note,
readable without signing in, and exposes no money or member data.

### 9.3 Gemini

The assistant calls Google Gemini with a system prompt and a context block
assembled from the centre's own settings, plans, classes and coaches. No
personal data of any member is included. Absence of a key, a network failure,
or a refusal all fall back to rule-based answers.

### 9.4 Storage

PostgreSQL 16 (Neon in production) or embedded PGLite in development. Schema
changes are forward-only numbered migrations in `migrations/`, applied in one
transaction and recorded in `_migrations`.

---

## 10. Acceptance

The system is accepted when `scripts/arena3-api-check.mjs` passes against a
running instance. That harness is the executable form of this document: it
drives real HTTP against a real database and asserts the requirements that are
cheap to get wrong — notably that a transfer does not confirm a booking
(FR-D14), that a member cannot reconcile their own (FR-D17), that reconciling
produces a receipt (FR-D18), and that the same payment cannot be refunded twice
(FR-D22).

```bash
npm run check:api
```

Each later phase has its own harness, run against an in-memory PGLite
database (set `DATABASE_URL=` empty so a dev server's `.env.local` does not
point it at a real database):

| Phase | Harness | Covers |
| --- | --- | --- |
| 1 | `scripts/arena3-fixes-check.mjs` | Settings validation, refund queue, walk-in invoices, occupancy detail, class detail, staff menu, member edit, gear, notifications |
| 2 | `scripts/arena3-phase2-check.mjs` | Staff accounts, plan payment rule, audit filters, revenue split |
| 3 | `scripts/arena3-phase3-check.mjs` | Availability calendar, booking reschedule, own attendance |
| 4A | `scripts/arena3-phase4-check.mjs` | Cancel and move session, change coach, edit and cancel class, member list |
| 4B | `scripts/arena3-phase4b-check.mjs` | Excel and PDF export, previous-period comparison, capacity, members report |
| 4C | `scripts/arena3-phase4c-check.mjs` | Attendance lock, results, plans, homework, absence streak, gate check-in, student profile |

Unit-level rules are covered by `src/lib/arena3/arena3.test.ts` via `npm test`.

### 10.1 Known limits at v1.1

- Class fees and equipment rental produce no payment row, so they show as zero
  in the revenue report (§6.2).
- A renewal is counted when a new plan starts within 30 days of the previous
  one ending; this threshold is a reporting convention, not a business rule.
- The 2-hour attendance lock is unit-tested for the time arithmetic; a
  register for a genuinely past session cannot be created on a dev database,
  so the full path is exercised with seeded times only.
- Own-attendance (FR-C12) with real rows is verified by response shape only,
  for the same reason.
- `timezone` and `currency` are deliberately not editable (A1).
- Product decisions still open: mid-term plan upgrade, member-initiated plan
  cancellation with refund rule, assessment tests and teaching documents,
  and the outbound channel for email.

## Revision history

| Version | Date | Description |
| --- | --- | --- |
| v2.4 | 2026-10-14 | Removed day pass (UC-23) and residual debt wording; corrected BR-44 to the open-shift rule. |

