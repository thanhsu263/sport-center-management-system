# Arena3 — Software Design Document

**Version 1.0 · 2026-09-20 · Status: as-built**

[SRS.md](SRS.md) says what the system does. This document says how, and — more
usefully — *why it was built this way rather than the obvious way*. Where a
design has a known weakness, it is written down here rather than left for
somebody to discover at 9pm on a Saturday.

---

## 1. Shape of the system

```
                    browser (PWA)
                          │
          ┌───────────────┴───────────────┐
          │                               │
   TanStack Router               fetch → /v1/*
   file-based screens                    │
   src/routes/*.tsx                      │
                                  src/routes/v1.$.ts
                                         │
                                 src/lib/arena3/router.ts
                                   (one dispatch table)
                                         │
                   ┌─────────────────────┼─────────────────────┐
              handlers/*.ts         helpers.ts              jobs.ts
           auth bookings classes   audit · enqueue      holds · no-shows
           desk members ops plans  idempotency          sessions · reminders
                   └─────────────────────┼─────────────────────┘
                                         │
                                      tx.ts
                             withTx (write) · getSql (read)
                                         │
                            PostgreSQL 16 (Neon)  ·  or PGLite
                     triggers · plpgsql functions · views · enums
```

One process. One database. No queue, no cache, no microservices. A single-site
sports centre generates a few thousand rows a month; anything more elaborate
would be infrastructure to maintain rather than a problem solved.

### 1.1 Stack

| Layer | Choice | Why this one |
| --- | --- | --- |
| Runtime | TanStack Start on Nitro 3 | One project serves both the React app and the API, with no separate backend to deploy or keep in version-sync. |
| Language | TypeScript 5.7, strict | The domain is full of near-identical identifiers — booking, occupancy, session, subscription. Types are what stop them being swapped. |
| UI | React 19, Tailwind v4, `motion` | — |
| Data | PostgreSQL 16 via `pg`; PGLite in development | The schedule's correctness lives in constraints and plpgsql. That rules out anything without real transactions. |
| Hosting | Vercel + Neon | — |

### 1.2 Directory map

| Path | Holds |
| --- | --- |
| `src/routes/` | Screens (file-based routing) plus `v1.$.ts`, the single API entry point. |
| `src/lib/arena3/router.ts` | The route table. Method + path segments → handler, with the auth and transaction decision made here. |
| `src/lib/arena3/handlers/` | One file per area. Every handler is `(sql, …args, user) => { status, body }`. |
| `src/lib/arena3/helpers.ts` | Cross-cutting writes: `audit`, `enqueue`, `enqueueReceipt`, `nextCode`, `withIdempotency`. |
| `src/lib/arena3/tx.ts` | `withTx` and the connection pool. |
| `src/lib/arena3/jobs.ts` | The scheduler. |
| `src/lib/arena3/errors.ts` | `ApiError`, the code→status map, and the single `handleError`. |
| `src/components/` | Shared UI: `shell`, `ui`, `motion`, `fx`, `gl`, `mark`, `media`. |
| `migrations/` | Numbered, forward-only SQL. |
| `scripts/` | Migration runner, seeds, and `arena3-api-check.mjs`. |

---

## 2. Request lifecycle

Every API request enters at `src/routes/v1.$.ts` and is dispatched by one
function. There is no middleware chain and no decorator metadata: the route
table is a list of `if` statements, read top to bottom, and the authentication
and transaction decisions are visible on the same line as the handler.

```ts
if (method === "POST" && p0 === "bookings" && p1 && p2 === "confirm") {
  return idem(user.id, () => authed((sql, u) => bookH.bookingsConfirm(sql, p1, request, u)));
}
```

Three wrappers do all the work:

| Wrapper | Opens a transaction | Use |
| --- | --- | --- |
| `authed` | yes | Anything that writes. |
| `authedRead` | **no** | Handlers that are pure `SELECT`s — verified one by one. |
| `idem` | yes | Writes that must survive a double tap. |

**Why `authedRead` exists.** A `BEGIN`/`COMMIT` around a read costs two extra
round trips to a database in another data centre and buys nothing — a single
statement is already atomic. On the read-heavy screens that difference is most
of the response time.

### 2.1 Errors

Handlers throw; they never build error responses. `handleError` maps
`ApiError.code` to a status and serialises `{ code, message, ...extra }`.
A refused business rule carries its `br` field, so the UI can show a sentence
and support can trace the exact line that refused.

Anything that is *not* an `ApiError` — a constraint violation, a bug — becomes
a 500 with a generic message. Internal detail does not reach the client.

### 2.2 Idempotency

`withIdempotency` stores `(key, user, response)` in `idempotency_keys` inside
the same transaction as the work. A replay of the same key returns the stored
response without re-executing. It is required (not optional) on the two
endpoints where a double tap costs real money: `POST /v1/payments` and
`POST /v1/bookings/:id/confirm`.

Because the record is written in the same transaction as the payment, there is
no window in which the key exists but the payment does not, or the reverse.

---

## 3. Authentication and authorisation

- Login verifies a salted password hash and issues a random token.
- `sessions_auth` stores **SHA-256 of the token**, never the token. A stolen
  database backup does not yield usable sessions.
- Lifetime: 7 days for members, 12 hours for staff — staff sessions live on
  machines that face the public counter.
- `authFromRequest` resolves the bearer token to a `PublicUser` on every
  request. There is no session cache: an account disabled at 14:00 stops
  working at 14:00.
- `requireRole(user, [...])` is called inside the handler, not the router. The
  check sits next to the logic it protects, where it is visible during review.

**Ownership is separate from role.** A member holding a valid session is still
`403` on another member's booking. The pattern is always: load the row, compare
`user_id`, refuse. Never a `WHERE user_id = $1` that silently returns empty —
an empty list and a refusal mean different things, and the difference matters
when somebody reports a bug.

---

## 4. The data model

### 4.1 Money and schedule in one transaction

`settleHeldBooking` is the only place a held court becomes a paid one, and it is
shared by the member confirming in the app and the desk reconciling a transfer
hours later. Inside one transaction it:

1. inserts the `payments` row,
2. promotes the occupancy from `hold` to `booking`,
3. updates the booking to `confirmed` and clears the hold clock,
4. issues the invoice and its line,
5. enqueues the confirmation **and the receipt**.

Sharing it is the point. Two code paths that each wrote "roughly the same"
rows would drift, and the drift would show up as a member with a court and no
proof of payment.

### 4.2 Occupancies: why courts are not booked directly

Four different things make a court busy: a booking, a hold, a class session,
and maintenance. If each owned its own table, "is this court free?" would be a
four-way join that every new feature would silently break.

Instead everything writes an `occupancies` row — `(court_id, start_at, end_at,
kind, ref_id)` — and availability is one query against one table. A hold and a
booking are the same row with a different `kind`; confirming a hold is an
`UPDATE` of one column, which is why it cannot lose the slot in between.

**Overlap enforcement.** The natural tool is `EXCLUDE USING gist`, which is
exactly this constraint expressed once, in the database, and immune to
concurrency. It is not used, because `btree_gist` is unavailable in PGLite and
the same schema has to run in development with no Postgres installed. The
constraint is therefore a `BEFORE INSERT OR UPDATE` trigger that raises
`CONFLICT_SLOT` with SQLSTATE `23P01` — the same error code an exclusion
constraint would raise, so application code is written against the real thing
and could be switched to it by editing one migration.

**Where this is weaker, stated plainly.** A trigger that runs a `SELECT` under
`READ COMMITTED` cannot see an uncommitted row in a concurrent transaction. On
its own it would let two simultaneous inserts through. Both booking paths
therefore go through `booking_replace_hold`, which takes `FOR UPDATE` on the
`courts` row first, so concurrent bookings of the same court serialise and the
trigger sees committed state. Publishing a class timetable
(`classes.ts` → `occupancy_attach`) does **not** take that lock: a manager
publishing a timetable at the exact moment a member books the same court could
in principle produce an overlap. It is a rare, staff-initiated action against a
court the timetable is claiming anyway, so it is accepted rather than fixed —
and recorded here so that switching to `EXCLUDE` (which would close it) is a
known improvement rather than a rediscovery.

### 4.3 Holds are a state, not a timer

A hold is a booking with `status = 'hold'` and a `hold_until` timestamp. Nothing
in the application counts down; a job sweeps expired holds. Consequences worth
knowing:

- The slot is genuinely blocked for the duration — the occupancy row exists.
- A crashed process loses nothing. The hold expires on schedule regardless.
- Every consumer must check `hold_until` itself. `settleHeldBooking`'s callers
  do, including the transfer path: a sweeper that has not yet run is not
  permission to confirm.

### 4.4 Bank transfers: no row for money you do not have

When a member chooses "bank transfer", the system writes **no payment row**.
The booking stays on `hold` with `transfer_requested_at` set and a longer clock
(`transfer_hold_minutes`, default 120 — five minutes is the right pressure on
somebody at a card reader and the wrong pressure on somebody opening a banking
app). The endpoint returns `202`, not `200`.

The alternative — a payment row with status `pending` — was rejected for a
specific reason: `pay_status` is a Postgres enum, and `ALTER TYPE … ADD VALUE`
cannot have its new value used in the same transaction, which makes it awkward
to migrate safely. But the stronger reason is semantic. A pending payment row
would be counted by the revenue report and the refundable-amount ledger, both
of which read `payments`. The centre's books
would show money that nobody has looked for yet. An unpaid transfer is not a
payment; it is a promise, and a promise belongs on the booking.

Reconciliation is staff-only (`requireRole`), which is the entire point of the
queue: a member confirming their own transfer is the fraud this design exists
to prevent.

### 4.5 The outbox and the `inbox` view

Notifications are rows in `outbox` with a `dedupe_key` and a unique index, so
`ON CONFLICT DO NOTHING` makes every enqueue idempotent — a retried job cannot
tell a member twice. `inbox` is a view over `outbox` filtered to the in-app
channel.

`enqueueReceipt` puts `invoice_id`, `amount_vnd` and `method` in the payload
rather than looking them up at read time. A receipt is a record of what was
paid *then*; a later refund must not quietly restate history. The member's
notification list renders that payload as a tappable row that opens the PDF —
and only that row is a button, because making all eight look tappable would
promise eight links and deliver one.

Rows written before the payload carried an invoice fall back to a plain
notification (`asReceipt` returns `null`), which is the right outcome: better a
flat row than a button that opens nothing.

### 4.6 Codes

Member, payment and invoice codes come from `next_doc_code` / `next_member_code`
against a `code_counters` table, inside the caller's transaction. Gapless per
kind. A code is allocated when the document is created and never reused.

### 4.7 Time

Every business date is an ICT date. `src/lib/arena3/time.ts` owns the
conversion, and no handler is allowed to call `new Date().toISOString()
.slice(0,10)` — at 23:30 in Ho Chi Minh City that is tomorrow in UTC, which
would put a booking on the wrong day and a payment in the wrong day's till.

---

## 5. Background jobs

`jobs.ts` runs a loop every 15 seconds in-process.

| Job | Does |
| --- | --- |
| `expireHolds` | Releases holds past `hold_until`, returning the slot to sale. |
| `markNoshow` | Flags bookings nobody checked into after the grace period. |
| `completeBookings` | Moves finished bookings to `completed`. |
| `subscriptionStatus` | Expires subscriptions past `end_on`. |
| `expiryReminders` | Warns members whose plan is running out. |
| `waitlistExpire` | Times out an unclaimed class offer and passes it on. |
| `lockAttendance` | Freezes attendance once a session is done. |
| `generateSessions` | Materialises class sessions from recurrence rules. |
| `notifyFlush` | Dispatches the outbox. |

**Why in-process.** A cron service or queue worker is a second deployment to
keep in sync with the schema for work measured in single-digit rows per pass.

**The cost that was measured.** Naively, each pass issued every job's queries
every 15 seconds: on Neon that is roughly 24 network round trips per pass, about
7 seconds of chatter, which every user request then queued behind. Jobs now
carry their own due times and a pass with nothing to do costs almost nothing.

**The trade-off, stated.** On serverless, jobs run only while an instance is
alive. An idle deployment does not sweep holds until the next request wakes it —
at which point the sweep runs before anything else, so no user ever *sees* a
stale hold. What is lost is punctuality, not correctness.

---

## 6. Rate limiting

`ratelimit.ts` is an in-memory sliding window keyed by user and action.
Deliberately not in Postgres: these limits exist to stop one impatient member
turning a double-tap into twenty rows, not to repel a botnet, and a shared store
would add a round trip to the happy path of every request.

| Action | Limit |
| --- | --- |
| Plan order | 3/min, 10/hour |
| Assistant | 20/min |
| Password change | 5/15 min |
| Profile edit | 10/5 min |

On serverless each instance keeps its own counters, so a burst spread across
lambdas gets a somewhat higher effective ceiling. Still far below the damage a
tight client loop does, which is the case actually observed.

---

## 7. The assistant

`handlers/ops.ts` → `assistantChat`, with `gemini.ts` as the transport.

1. Feature flag `F6` must be on.
2. The message is trimmed to **800 characters** and rate limited.
3. If it looks like a support request (`ticket:`, "complaint", "khiếu nại", …)
   it becomes a ticket and returns immediately — no model call.
4. Otherwise a context block is built from live settings, plans, classes and
   coaches, and sent to Gemini with a system prompt.
5. On any failure — no key, network, refusal — a rule-based answer is returned
   instead, labelled `rules`. The reply always carries its source.

**No mutating tools are exposed to the model.** It can read the centre's
catalogue and open a ticket. It cannot book, cancel, refund or change a
setting, so a prompt injection in a member's message has nothing to reach.

**The 800-character limit is the server's, and the composer enforces the same
number.** The server slices rather than refuses, which means a long question
used to be answered confidently from its first half. The only place a member
can be *told* about the boundary is the box they are typing in, so that is
where the cap and its counter live.

**`ticket:` prefixes are stripped before storage.** People type
"ticket: ticket: the lights in BC2" when the first attempt did not look like it
was heard, and the desk was reading the word "ticket" back to itself before
reaching the lights. The first prefix is the instruction that routed the message
and is consumed; repeats are the same instruction given again. Only *leading*
repeats are removed — "ticket:" inside a sentence is the member writing prose,
and cutting there would edit their complaint.

---

## 8. Customer care

Three pieces, added together because any two of them without the third is a
promise the system cannot keep:

1. `tickets.reply / replied_at / replied_by` (migration `0013`).
2. `POST /v1/tickets/:id/reply` — writes the reply, closes the ticket and
   notifies the member, in one transaction.
3. `GET /v1/tickets/mine` and Account › Support — where the member reads it.

**Why the reply lives on the ticket rather than in a messages table.** What this
desk does is answer a question once: "the lights are fixed", "your refund went
back on Tuesday". A thread schema would model a conversation nobody is having,
and every screen would then have to render an empty one. If two-way threads are
ever needed, this migration is a clean base to build them on.

**Why replying also closes.** An answered request left in the open queue is one
a colleague answers again. Reopening is the member's move — they write back —
which is also the honest signal that the first answer did not land.

---

## 9. Front end

### 9.1 Structure

File-based routes under `src/routes`. Screens are grouped by who uses them:
`app.*` (member), `desk.*` (reception), `manager.*`, `coach`, `account`, plus
the public landing, login and register.

> **Build note.** Adding a route file regenerates the route tree. Run
> `npx vite build` before `tsc --noEmit`, or the typecheck fails on a tree that
> does not yet mention the new file.

`src/lib/arena3/client.ts` is the only place that talks to the API: it attaches
the bearer token, de-duplicates in-flight GETs, and turns an error body back
into a thrown `Error` carrying the server's sentence.

### 9.2 Components

| Module | Holds |
| --- | --- |
| `shell.tsx` | Page frame, navigation, `money`, `when`, session hooks, `Guard`. |
| `ui.tsx` | Primitives: `Button`, `Card`, `Field`, `Input`, `Seg`, `Badge`, `Stat`. |
| `motion.tsx` | `Reveal`, `Stagger`, `Lift`, `CountUp`, `Parallax` — every animation the app uses. |
| `fx.tsx` / `gl.tsx` | Decorative effects, including WebGL backgrounds. |
| `mark.tsx` | Brand marks: `ArenaMark`, `AssistantMark`, `CourtBackdrop`. |

`AssistantMark` exists because a speech bubble is the glyph every chat widget on
the internet uses and says nothing about *this* assistant. It is the court from
the Arena3 mark with a spark over the open corner, drawn to lucide's geometry —
24px box, round joins, a `strokeWidth` prop — so it sits in a row of lucide
icons without looking pasted in.

### 9.3 Typography

Three faces, one job each: **Be Vietnam Pro** for running text (it renders
Vietnamese diacritics properly, which is not optional here), **Newsreader** for
headings, **Anton** for figures.

Decisions worth keeping:

- `.figure` is the block-caps voice with `text-transform` removed. The only
  letter in a VND figure is the currency mark, and uppercasing `1,500,000đ`
  gives `1,500,000Đ` — a letter Vietnamese does not use for money, in a heavy
  condensed face, at the top of every stat tile.
- Letter-spacing is a function of size, not of tag. `-0.028em` suits a 5rem
  headline and closes up the counters of a 1.125rem `h3` on a card, so each
  level gets the tightening its own size can carry.
- `font-synthesis-weight: none`. Only 400–700 are loaded; without it a
  `font-semibold` on a weight that never arrived is faked by smearing the 400.
- `preconnect` to both font hosts. The stylesheet and the font files come from
  different origins, and without it the second connection opens only after the
  first response is parsed — that gap is the flash of fallback type on a cold
  load.

### 9.4 Reading a number

`Stat` takes a `Trend { pct, label, good }` where **`good` is carried, not
derived from the sign**. Whether "up" is good news depends on what is being
counted: revenue climbing is a good week, refunds climbing is a bad one. The
three tiles on the reports page sit in a row and two of them mean opposite
things, so a colour rule keyed on the sign would paint a week of refunds green.
`delta(cur, prev, upIsGood)` at the call site is where that is decided.

---

## 10. Database and deployment

### 10.1 Two databases, one schema

`src/lib/db.ts` picks **Neon** when `DATABASE_URL` is set and embedded
**PGLite** otherwise. A fresh clone runs, migrates and seeds itself with no
Postgres installed.

> **Trap for the operator.** If `.env.local` sets `DATABASE_URL`, the local dev
> server writes to **production Neon**. This is useful and dangerous in equal
> measure. Check which one you are pointed at before testing anything
> destructive.

### 10.2 Migrations

Numbered, forward-only, in `migrations/`. `scripts/migrate.mjs` applies each
pending file **inside one transaction** and records it in `_migrations`. A
migration that fails halfway leaves nothing behind.

House style, followed by `0012` and `0013`: additive only — nullable columns,
defaults, `IF NOT EXISTS`, partial indexes. Nothing existing changes meaning,
so a migration is safe to run against live data during a deploy.

### 10.3 Deploy

`npm run build` is `vite build && npm run db:migrate`, so **every Vercel deploy
migrates production Neon**. A deploy that fails its migration fails its build,
and no half-migrated schema is ever served.

---

## 11. Testing

| Layer | What it covers | Command |
| --- | --- | --- |
| Unit | Pricing, phone normalisation, recurrence, time, business rules. | `npm test` |
| API | Live HTTP against a running instance and a real database. | `npm run check:api` |
| Types | Whole project, strict. | `npm run typecheck` |

`scripts/arena3-api-check.mjs` is the one that matters. It logs in as each role
and drives whole flows, asserting the negatives that are cheap to break and
expensive to discover: that a bank transfer does **not** confirm a booking and
posts **no** payment, that a member gets `403` reconciling their own transfer,
that reconciling produces a payment, an invoice and a receipt, and that the same
payment cannot be refunded twice.

> **Known gap on Windows.** The first half of `npm test`
> (`node --test 'scripts/**/*.test.mjs'`) does not expand its glob under Git
> Bash, so those files do not run in the normal flow. Run them by path.

---

## 12. Known limitations

Collected so they are findable, not scattered:

1. **Registration OTP is shown on screen**, because there is no SMS transport.
   Replace before real customer accounts exist.
2. **Class publishing can race a booking** (§4.2). Switching occupancy overlap
   to an `EXCLUDE USING gist` constraint closes it, at the cost of PGLite
   development.
3. **Rate limits are per-instance** (§6).
4. **Jobs run only while an instance is warm** (§5).
5. **The demo password ships in the client bundle** while one-tap demo login
   exists. It is no longer printed on the sign-in page, and it logs in as a demo
   account by design. `VITE_DEMO_LOGINS=off` removes both.
6. **No accounting export.** Invoices are printable, not exportable.
