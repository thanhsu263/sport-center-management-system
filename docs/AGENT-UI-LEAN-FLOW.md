# Instruction: leaner screens, clearer flows, same glow

This is the binding spec for the agent. The short prompt that points here is in section 8.
Paths were checked on `main` at commit `93e232e`. If something has moved, find it with
`DO_NOT_TRACK=1 npx graft grep "<symbol>"`. Do not guess.

The product owner's request, in their words: upgrade the site and make the flows clear; make the
interface lean while it still looks dazzling. That is two jobs, in this order:

1. **Flow clarity.** On every screen a first-time user knows where they are, what the one main action
   is, and what happens next.
2. **Lean but luminous.** Fewer things on screen, each one better finished. The glow comes from the
   existing effect library pointed at things that matter, not from more decoration.

---

## 0. Read first, in this order

1. `CLAUDE.md`, `AGENTS.md`. They win over this file.
2. `docs/UI-REDESIGN.md`, `docs/SCREENS.md`. (`PRODUCT.md` and `DESIGN.md` are named in `CLAUDE.md` but
   are not in the repo at this commit. If they exist when you start, read them and they win over
   `UI-REDESIGN.md`. If they do not, say so in your report and carry on.)
3. `src/client/components/shell.tsx` (navigation for every role), `page-hero.tsx`, `section.tsx`,
   `empty-state.tsx`, `stat-strip.tsx`, `ui/index.tsx`.
4. `src/client/components/fx.tsx`, `gl.tsx`, `motion.tsx` (the effect library) and `src/styles.css`
   (tokens).
5. The route files of the flow you are working on, in `src/routes/`.

## 1. Hard constraints (breaking one means the work is rejected)

1. **Client only.** No change under `src/server/`, `migrations/`, seed data, `src/routeTree.gen.ts` or
   `.claude/launch.json`. No route is renamed or removed. No business rule changes. If a flow cannot be
   made clear without a server change, stop on that item and write it in the report.
2. **Landing page (`src/routes/index.tsx`, `src/client/components/landing/*`) is out of scope.** List
   what you would change there in the report and wait for approval.
3. **The effect library stays.** Never remove or flatten an effect to make a screen calmer; tune its
   strength, opacity or speed. A new effect must mark something real (a free hour, a hold countdown, a
   confirmed payment, the next session). No effect over the court-grid cells.
4. **Motion.** `motion` for in-app transitions. GSAP only in `src/client/lib/gsap.ts`,
   `components/landing/*` and `components/moments/*`, through `useScene()`. Never both in one
   component. Everything honours `prefers-reduced-motion`, read after mount
   (`useReducedMotionAfterMount`).
5. **Existing components and tokens only.** Build from `ui/index.tsx`, `fx.tsx`, `motion.tsx` and the
   tokens in `src/styles.css`. No new npm dependency, no hard-coded colours, no one-off spacing values.
6. **i18n.** Every new or changed user-facing string goes through `t()` / `tk()` in English, with a
   Vietnamese entry in the matching file under `src/client/lib/i18n/`. `node scripts/i18n-check.mjs`
   reports no new missing key.
7. **Git.** Do not commit, push, stash or reset. The working tree already holds uncommitted work that
   is not yours; edit only the files your task needs and leave the result for review.

## 2. Order of priorities (the owner's standing rule)

Work each screen through these four passes, in this order, and stop a pass when it stops adding value:

1. **Minimal and clean.** Remove, merge or demote before you add.
2. **Hover.** Every clickable thing answers the pointer; nothing that is not clickable does.
3. **Interaction.** Press, focus, loading, success and error states are all visible and consistent.
4. **Glass.** Last, and only on surfaces that sit above content (header, sheets, floating bars), never
   where it lowers text contrast, never over court-grid cells.

## 3. Job A: flow clarity

Audit these flows end to end as the role that uses them, at 375 px and 1280 px. Use the seeded
accounts documented in the project; do not create data outside the app's own UI.

| Role | Flow | Routes |
|---|---|---|
| Visitor | register, sign in, forgot password | `register`, `login`, `forgot` |
| Member | home → book a court → hold → pay → pass and QR → check-in | `app.index`, `app.book`, `pay.return`, `app.pass` |
| Member | find a class → enrol → pay → see it in training | `app.classes`, `app.train`, `app.plans` |
| Desk | gate check-in, walk-in booking, take a payment, look up a member | `desk.gate`, `desk.courts`, `desk.payments`, `desk.member.$id` |
| Coach | today's classes → attendance → earnings | `coach.index`, `coach.classes`, `coach.attendance`, `coach.earnings` |
| Manager | dashboard → the screen that fixes what the dashboard shows | `manager.index` and its children |

For each screen in a flow, make these true:

- **A1. One primary action.** Exactly one filled, high-emphasis button per view. Everything else is
  secondary or lives in a menu.
- **A2. You are here.** The active nav item, the page title and the browser title agree. Multi-step
  flows (booking, enrolment, payment) show the step you are on and how many remain.
- **A3. What happens next.** After every completed action the screen names the result and offers the
  next step as a button (booked → "Pay now"; paid → "Show pass"; checked in → back to the queue).
  No dead ends, no silent success.
- **A4. Empty, loading, error.** Every list and panel has all three. An empty state says why it is
  empty and gives the action that fills it. Errors say what to do, not only what failed.
- **A5. Back is predictable.** Detail screens have a visible way back to the list they came from, and
  it keeps the list's filters and scroll position where the router already allows it.
- **A6. Same word, same thing.** One label per concept across nav, titles, buttons and toasts, in both
  languages. Fix the mismatches you find.
- **A7. Time-bound states are loud.** A hold countdown, an unpaid booking or an expiring plan is the
  most visible thing on the screen while it is live.

## 4. Job B: lean but luminous

- **B1. Cut.** Per screen: remove duplicated information, merge cards that describe the same object,
  move rarely used controls into a menu or a collapsed section, shorten copy to what the user needs to
  decide. Target at least a quarter fewer visible elements above the fold on the busiest screens
  (`desk.index`, `desk.member.$id`, `manager.index`, `app.index`, `account`).
- **B2. Hierarchy.** One clear focal point per screen. Consistent type scale and spacing rhythm from
  the tokens. Numbers that matter are large; labels are quiet.
- **B3. Concentrate the glow.** Count the effects on each screen. Keep the full-strength treatment for
  the one or two elements that carry meaning (the next session, the live hold, the confirmed payment,
  the primary action) and turn the rest down, not off. A screen where everything shines reads as
  noise.
- **B4. Finish.** Aligned edges, consistent radii and borders, no layout shift on load, skeletons that
  match the final layout, focus rings on every interactive element, WCAG AA contrast in light and dark.
- **B5. Consistency.** The same pattern looks and behaves the same in every role's area: page header,
  section header, table row actions, filters, dialogs, toasts.

## 5. How to work

1. Run the Impeccable skill: `critique` and `audit` on one flow at a time. One design lead; do not
   bring in other design skills.
2. Write down the findings for that flow as a short list (screen, problem, fix) before editing.
3. Locate code with graft (`graft grep "<Name"` for JSX usage; `graft callers` misses JSX and
   namespace calls).
4. Fix shared components first when a problem repeats across screens, then the screens.
5. Finish one flow (edits, gates, screenshots) before starting the next. Order: Member booking,
   Member classes, Desk, Coach, Manager, Visitor.

## 6. Gates (all must pass before you report)

1. `npm run typecheck`
2. `npm run lint`
3. `npm run build:dev` (plain `npm run build` also runs the database migration; do not use it here)
4. `node scripts/i18n-check.mjs`: no new missing key
5. Impeccable `detect --json <changed files>`, once, after the UI edits
6. In the running app, for every changed screen: no console errors; screenshots before and after at
   375 px and 1280 px, in light and dark; one pass with reduced motion on
7. Walk each flow in section 3 start to finish once more and confirm A1 to A7 by using it

## 7. Report

Save screenshots under `docs/design-compare/lean-flow/` and reply with:

- per flow: what was unclear, what changed, before and after screenshot paths
- shared components changed and which screens they affect
- effects tuned (which, where, from what to what)
- anything skipped and why, including items that need a server change
- proposals for the landing page, not implemented
- gate results, with the real output of any gate that failed

## 8. The short prompt

> Read `docs/AGENT-UI-LEAN-FLOW.md` completely and follow it. Goal: every flow in section 3 is obvious
> to a first-time user, and every screen is leaner while keeping the house effects, concentrated on
> what matters. Client only, landing page untouched, no commit. Work one flow at a time in the order
> given, pass every gate in section 6, then report as section 7 describes.
