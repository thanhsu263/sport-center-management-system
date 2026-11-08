import type { Sql } from "@/lib/db";
import { err } from "../errors";
import { flagsMap, requireFlag, type FlagKey } from "../flags";
import { audit, classSubscription, enqueue, getSettings, pageOf, readJson, str } from "../helpers";
import { limit, RULES } from "../ratelimit";
import { requireRole, type PublicUser } from "../session";
import { generateAssistantReply, type ChatTurn } from "../gemini";
import { COACHES } from "../coaches";
import { ticketBody } from "../rules";
import { addDays, ictDateString } from "../time";
import { one } from "../tx";
import { payosConfigured } from "../payos";
import { centreBank } from "../bank";
import { pageParams, parseInteger } from "../validate";

export async function flagsGet(sql: Sql) {
  const settings = await getSettings(sql);
  return {
    status: 200,
    body: {
      // Opening hours and the hold length as the manager set them, for the copy and grids that
      // used to write "06:00-22:00" and "five minutes" in by hand. Not personal, not secret.
      venue: { open_time: settings.open_time, close_time: settings.close_time, hold_minutes: settings.hold_minutes },
      flags: await flagsMap(sql),
      /*
       * Whether online payment can be offered at all.
       *
       * Not a feature flag a manager toggles — it is simply whether the centre
       * has put payOS credentials in the environment. The screens need to know
       * so they can leave the button out rather than offer one that fails, and
       * only the answer crosses the wire; the keys themselves never leave the
       * server.
       */
      capabilities: { online_payment: payosConfigured(), bank_transfer: centreBank() !== null },
    },
  };
}
export async function flagsPatch(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["manager"]);
  const b = await readJson(request);
  for (const key of ["F4", "F5", "F6"] as FlagKey[]) {
    if (typeof b[key] === "boolean") {
      await sql.query(`insert into feature_flags (key, enabled) values ($1,$2)
        on conflict (key) do update set enabled = excluded.enabled`, [key, b[key]]);
    }
  }
  await audit(sql, user.id, "patch_flags", "flags", null, null, b);
  return flagsGet(sql);
}

export async function subscriptionFreeze(sql: Sql, id: string, request: Request, user: PublicUser) {
  requireRole(user, ["manager", "receptionist"]);
  const b = await readJson(request);
  const raw = b.days;
  let days: number;
  if (raw === undefined || raw === null || raw === "") {
    days = 7;
  } else {
    days = parseInteger("days", "Freeze length", raw, -Infinity, Infinity);
    if (days < 1 || days > 90) throw err.validation("Freeze length must be 1–90 days.");
  }
  const settings = await getSettings(sql);
  const sub = await one<{
    id: string;
    status: string;
    frozen_days: number;
    end_on: string;
    user_id: string;
  }>(sql, `select id, status, frozen_days, end_on::text, user_id from subscriptions where id = $1 for update`, [id]);
  if (!sub) throw err.notFound();
  if (sub.status !== "active") throw err.br("BR-14", "Only an active plan can be frozen.");
  if (sub.frozen_days + days > settings.freeze_max_days_year) {
    throw err.br("BR-15", `Over the limit of ${settings.freeze_max_days_year} freeze days a year.`);
  }
  const end = addDays(sub.end_on, days);
  await sql.query(
    `update subscriptions set status = 'frozen', frozen_days = frozen_days + $2, end_on = $3 where id = $1`,
    [id, days, end],
  );
  await audit(sql, user.id, "freeze_sub", "subscription", id, sub, { days, end });
  return { status: 200, body: await one(sql, `select id, user_id, plan_id, sport_scope, start_on::text, end_on::text, status, frozen_days, court_hours_left, session_left from subscriptions where id = $1`, [id]) };
}

export async function subscriptionUnfreeze(sql: Sql, id: string, user: PublicUser) {
  requireRole(user, ["manager", "receptionist"]);
  const sub = await one<{ id: string; status: string; end_on: string; frozen_days: number }>(
    sql,
    `select id, status, end_on::text, frozen_days from subscriptions where id = $1 for update`,
    [id],
  );
  if (!sub) throw err.notFound();
  if (sub.status !== "frozen") throw err.conflictState("That plan is not frozen.");

  const lastFreeze = await one<{ at: string; before: any; after: any }>(
    sql,
    `select at::text, before, after from audit_logs
      where action = 'freeze_sub' and entity = 'subscription' and entity_id = $1
      order by at desc limit 1`,
    [id],
  );

  let newEndOn = sub.end_on;
  if (lastFreeze && lastFreeze.before?.end_on && lastFreeze.after?.days) {
    const freezeDate = String(lastFreeze.at).slice(0, 10);
    const today = ictDateString();
    const dFreeze = new Date(freezeDate);
    const dToday = new Date(today);
    const maxDays = Number(lastFreeze.after.days) || 0;
    const actualDays = Math.min(maxDays, Math.max(0, Math.round((dToday.getTime() - dFreeze.getTime()) / (86400 * 1000))));
    const originalEndOn = String(lastFreeze.before.end_on).slice(0, 10);
    newEndOn = addDays(originalEndOn, actualDays);
  }

  await sql.query(`update subscriptions set status = 'active', end_on = $2 where id = $1`, [id, newEndOn]);
  await audit(sql, user.id, "unfreeze_sub", "subscription", id, sub, { end_on: newEndOn });
  return { status: 200, body: await one(sql, `select id, user_id, plan_id, sport_scope, start_on::text, end_on::text, status, frozen_days, court_hours_left, session_left from subscriptions where id = $1`, [id]) };
}

export async function waitlistAccept(sql: Sql, offerId: string, user: PublicUser) {
  requireRole(user, ["member"]);
  const offer = await one<{
    id: string;
    enrollment_id: string;
    status: string;
    expires_at: string;
  }>(sql, `select * from waitlist_offers where id = $1 for update`, [offerId]);
  if (!offer) throw err.notFound();
  if (offer.status !== "pending") throw err.conflictState();
  if (new Date(offer.expires_at) < new Date()) throw err.br("BR-23", "That offer has expired.");
  const enr = await one<{ id: string; class_id: string; user_id: string; status: string }>(
    sql,
    `select * from enrollments where id = $1 for update`,
    [offer.enrollment_id],
  );
  if (!enr || enr.user_id !== user.id) throw err.forbidden();
  const cl = await one<{ enrolled_count: number; capacity: number; sport: string }>(
    sql,
    `select enrolled_count, capacity, sport from classes where id = $1 for update`,
    [enr.class_id],
  );
  if (!cl) throw err.notFound();
  const found = await classSubscription(sql, user.id, cl.sport);
  if (!found) throw err.br("BR-19", "You need an active plan covering this sport.");
  const sub = await one<{ id: string; session_left: number | null }>(
    sql,
    `select id, session_left from subscriptions where id = $1 for update`,
    [found.id],
  );
  if (!sub) throw err.br("BR-19", "You need an active plan covering this sport.");
  if (sub.session_left != null && sub.session_left <= 0) {
    throw err.br("BR-20", "You have no sessions left.");
  }
  if (cl.enrolled_count >= cl.capacity) throw err.br("BR-21", "The class just filled up.");
  await sql.query(
    `update enrollments set status = 'confirmed', waitlist_pos = null where id = $1`,
    [enr.id],
  );
  await sql.query(
    `update classes set enrolled_count = enrolled_count + 1 where id = $1 and enrolled_count < capacity`,
    [enr.class_id],
  );
  await sql.query(`update waitlist_offers set status = 'accepted' where id = $1`, [offerId]);
  if (sub.session_left != null) {
    const took = await sql.query(
      `update subscriptions
          set session_left = session_left - 1
        where id = $1 and session_left > 0
       returning id`,
      [sub.id],
    );
    if (took.length === 0) {
      throw err.br("BR-20", "You have no sessions left.");
    }
  }
  return { status: 200, body: { ok: true } };
}

export async function inviteWaitlist(sql: Sql, classId: string) {
  const pending = await one(
    sql,
    `select o.id from waitlist_offers o
       join enrollments e on e.id = o.enrollment_id
      where e.class_id = $1 and o.status = 'pending' and o.expires_at > now()
      limit 1`,
    [classId],
  );
  if (pending) return;
  const next = await one<{ id: string; user_id: string }>(
    sql,
    `select id, user_id from enrollments
      where class_id = $1 and status = 'waitlisted'
      order by waitlist_pos nulls last, id
      limit 1`,
    [classId],
  );
  if (!next) return;
  const settings = await getSettings(sql);
  const hours = settings.waitlist_offer_hours || 2;
  const offer = await one<{ id: string }>(
    sql,
    `insert into waitlist_offers (enrollment_id, expires_at, status)
     values ($1, now() + ($2 * interval '1 hour'), 'pending')
     returning id`,
    [next.id, hours],
  );
  await enqueue(
    sql,
    "inapp",
    "waitlist_offer",
    next.user_id,
    { offer_id: offer!.id, class_id: classId },
    `wl|${offer!.id}`,
  );
}

export async function assistantChat(sql: Sql, request: Request, user: PublicUser) {
  await requireFlag(sql, "F6");
  const body = await readJson(request);
  const message = (str(body.message) ?? "").trim().slice(0, 800);
  if (message.length < 2) throw err.validation("Type a question first.");
  // Every turn that falls through to the model costs a call upstream.
  limit(`ai:${user.id}`, RULES.assistant, "questions");
  const q = message.toLowerCase();

  if (/ticket:|complaint|feedback|khiếu nại|góp ý/.test(q) || q.startsWith("ticket:")) {
    const note = ticketBody(message);
    // "ticket:" and nothing else. Opening a blank request would put a row at the
    // desk that nobody can answer, so ask for the rest before writing anything.
    if (note.length < 2) {
      return {
        status: 200,
        body: {
          reply: "Tell me what happened after «ticket:» and I'll pass it to the front desk.",
          source: "rules" as const,
        },
      };
    }
    const t = await one<{ id: string }>(
      sql,
      `insert into tickets (user_id, body) values ($1,$2) returning id`,
      [user.id, note],
    );
    await audit(sql, user.id, "assistant", "chat", user.id, null, { q: note.slice(0, 200), source: "ticket" });
    return {
      status: 200,
      body: {
        reply: `Opened request ${t!.id.slice(0, 8)} for the front desk. Reception replies during opening hours.`,
        source: "rules" as const,
      },
    };
  }

  const settings = await getSettings(sql);
  const plans = await sql.query<{ name: string; price_vnd: number; sport_scope: string; court_hours: number }>(
    `select name, price_vnd, sport_scope, court_hours from membership_plans where is_on_sale = true order by price_vnd`,
  );
  const classes = await sql.query<{
    sport: string;
    level: string;
    rrule: string;
    enrolled_count: number;
    capacity: number;
    coach_name: string | null;
  }>(
    `select cl.sport, cl.level, cl.rrule, cl.enrolled_count, cl.capacity, u.full_name as coach_name
       from classes cl
       left join users u on u.id = cl.coach_id
      where cl.status = 'open'`,
  );
  const subs = await sql.query<{ plan_name: string; status: string; end_on: string; court_hours_left: string | number }>(
    `select p.name as plan_name, s.status, s.end_on::text, s.court_hours_left
       from subscriptions s join membership_plans p on p.id = s.plan_id
      where s.user_id = $1 and s.status in ('active','frozen','pending')
      order by s.end_on desc limit 3`,
    [user.id],
  );
  const todayBookings = await sql.query<{ court_code: string; start_at: string; status: string }>(
    `select c.court_code, b.start_at::text, b.status
       from court_bookings b join courts c on c.id = b.court_id
      where b.user_id = $1
        and b.status in ('hold','confirmed')
        and b.start_at >= now() - interval '12 hours'
        and b.start_at < now() + interval '24 hours'
      order by b.start_at`,
    [user.id],
  );

  const facts = [
    `Centre: Arena3. Open ${settings.open_time.slice(0, 5)}–${settings.close_time.slice(0, 5)} ICT every day.`,
    `Court holds last ${settings.hold_minutes} minutes. Cancel a court at least ${settings.cancel_court_hours}h ahead, a class at least ${settings.cancel_class_hours}h ahead. No-shows are not refunded.`,
    `Waitlists are first-come; an offer stands for ${settings.waitlist_offer_hours}h. Under-${settings.minor_age}s cannot book or enrol on their own.`,
    `Plans on sale:\n${plans.map((p) => `• ${p.name} (${p.sport_scope}): ${p.price_vnd.toLocaleString("en-US")}đ · ${p.court_hours} court hours`).join("\n") || "—"}`,
    `Open classes:\n${classes.map((c) => `• ${c.sport} ${c.level} · coach ${c.coach_name ?? "—"} · ${c.enrolled_count}/${c.capacity}`).join("\n") || "No classes are open."}`,
    `Coaches:\n${COACHES.map((c) => `• ${c.name} — ${c.title}. ${c.blurb}`).join("\n")}`,
    `Member asking: ${user.full_name} (${user.member_code ?? "no member code yet"}).`,
    `Their plans:\n${subs.map((s) => `• ${s.plan_name} · ${s.status} · through ${s.end_on.slice(0, 10)} · ${s.court_hours_left} court hours left`).join("\n") || "No plan yet."}`,
    `Today / next 24h:\n${todayBookings.map((b) => `• ${b.court_code} ${b.start_at} (${b.status})`).join("\n") || "Nothing booked."}`,
  ].join("\n\n");

  const system = `You are the Arena3 front-desk assistant inside the member app. Answer in English, keep it short (2–8 sentences), and stay strictly inside the DATA BLOCK.
No medical advice, no discounts beyond the listed plans, never invent a free slot.
Only name coaches, plans and classes that appear in the data block.
If you do not know: tell them to ask the desk or type «ticket: …».
You can walk them through Book / Classes / Plans in the app. Payment is taken at the desk after they order in the app.

DATA BLOCK:
${facts}`;

  const history = parseHistory(body.history);
  const turns: ChatTurn[] = [...history, { role: "user", text: message }];

  const ai = await generateAssistantReply(system, turns);
  const reply = ai?.text ?? ruleReply(q, settings, plans, classes);
  const source = ai?.source ?? "rules";

  await audit(sql, user.id, "assistant", "chat", user.id, null, {
    q: message.slice(0, 200),
    source,
  });
  return { status: 200, body: { reply, source } };
}

function parseHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatTurn[] = [];
  for (const item of raw.slice(-8)) {
    if (!item || typeof item !== "object") continue;
    const rec = item as { role?: unknown; text?: unknown };
    const role =
      rec.role === "me" || rec.role === "user" ? "user" : rec.role === "bot" || rec.role === "model" ? "model" : null;
    const text = typeof rec.text === "string" ? rec.text.trim().slice(0, 800) : "";
    if (!role || text.length < 1) continue;
    out.push({ role, text });
  }
  return out;
}

function ruleReply(
  q: string,
  settings: Awaited<ReturnType<typeof getSettings>>,
  plans: Array<{ name: string; price_vnd: number }>,
  classes: Array<{ sport: string; level: string; enrolled_count: number; capacity: number }>,
): string {
  if (/price|cost|how much|plan|giá|gói/.test(q)) {
    return `Plans on sale:\n${plans.map((p) => `• ${p.name}: ${p.price_vnd.toLocaleString("en-US")}đ`).join("\n")}\nPay at the desk after you order in the app.`;
  }
  if (/hour|open|close|what time|giờ|mở cửa/.test(q)) {
    return `Arena3 is open ${settings.open_time.slice(0, 5)}–${settings.close_time.slice(0, 5)} every day (ICT). Court holds last ${settings.hold_minutes} minutes, and you can cancel a court up to ${settings.cancel_court_hours}h before.`;
  }
  if (/class|coach|lesson|lớp|hlv/.test(q)) {
    return classes.length
      ? `Open classes:\n${classes.map((c) => `• ${c.sport} ${c.level} (${c.enrolled_count}/${c.capacity})`).join("\n")}`
      : "No classes are open right now — ask the desk.";
  }
  if (/cancel|book|hold|hủy|đặt sân/.test(q)) {
    return `Book in the app and the slot is held for ${settings.hold_minutes} minutes. Cancel a court at least ${settings.cancel_court_hours}h before you play, a class at least ${settings.cancel_class_hours}h before. No-shows are not refunded.`;
  }
  if (/waitlist|full|queue|chờ|đầy/.test(q)) {
    return `When a class is full you join a first-come waitlist. If a seat frees up you get an offer that stands for ${settings.waitlist_offer_hours}h — claim it in the app.`;
  }
  return "I can help with the timetable, plans, coaches, booking and cancelling, and waitlists at Arena3. Type «ticket: …» to send a note to the desk. I do not give medical advice.";
}


export async function ticketsCreate(sql: Sql, request: Request, user: PublicUser) {
  // Same stripping as the assistant route: a member who typed "ticket:" into
  // the support box is repeating the habit the assistant taught them.
  const body = ticketBody(str((await readJson(request)).body) ?? "").slice(0, 2000);
  if (body.length < 2) throw err.validation("The message is empty.");
  const row = await one(sql, `insert into tickets (user_id, body) values ($1,$2) returning *`, [user.id, body]);
  return { status: 201, body: row };
}

/**
 * The member's own side of customer care.
 *
 * Closed tickets come back too. A request that has been answered is the most
 * useful row on this screen — it is the answer — and hiding it the moment the
 * desk replies would mean the reply is only ever seen if the member happens to
 * be looking when the notification lands.
 */
export async function ticketsMine(sql: Sql, request: Request, user: PublicUser) {
  const { limit: take, offset } = pageParams(request, { def: 50, max: 100 });
  const rows = await sql.query<{ total: number } & Record<string, unknown>>(
    `select t.id, t.body, t.status, t.created_at, t.reply, t.replied_at,
            s.full_name as replied_by_name, count(*) over ()::int as total
       from tickets t
       left join users s on s.id = t.replied_by
      where t.user_id = $1
      order by t.created_at desc
      limit $2 offset $3`,
    [user.id, take, offset],
  );
  const body = await pageOf(rows, { limit: take, offset }, async () =>
    ((await one<{ n: number }>(sql, `select count(*)::int as n from tickets where user_id = $1`, [user.id]))?.n ?? 0),
  );
  return { status: 200, body };
}

export async function ticketsList(sql: Sql, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  // The desk works the open queue, but wants to be able to read back what it
  // told somebody last week without opening the database.
  const all = new URL(request.url).searchParams.get("status") === "all";
  const { limit: take, offset } = pageParams(request, { def: 50, max: 100 });
  const rows = await sql.query<{ total: number } & Record<string, unknown>>(
    `select t.id, t.body, t.status, t.created_at, t.reply, t.replied_at,
            u.full_name, u.phone, u.member_code,
            s.full_name as replied_by_name, count(*) over ()::int as total
       from tickets t
       left join users u on u.id = t.user_id
       left join users s on s.id = t.replied_by
      where ($1::bool or t.status = 'open')
      order by t.status = 'open' desc, t.created_at desc
      limit $2 offset $3`,
    [all, take, offset],
  );
  const body = await pageOf(rows, { limit: take, offset }, async () =>
    ((await one<{ n: number }>(sql, `select count(*)::int as n from tickets where ($1::bool or status = 'open')`, [all]))?.n ?? 0),
  );
  return { status: 200, body };
}

/**
 * Reception answers, and the member is told there is an answer.
 *
 * Replying closes the ticket in the same statement rather than leaving that as
 * a second button: an answered request that stays in the open queue is one a
 * colleague will answer again. Reopening is the member's move — they send
 * another note — which is also the honest signal that the first answer did not
 * land.
 */
export async function ticketReply(sql: Sql, id: string, request: Request, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  const reply = (str((await readJson(request)).reply) ?? "").trim().slice(0, 2000);
  if (reply.length < 2) throw err.validation("Write a reply first.");
  const t = await one<{ id: string; user_id: string | null; status: string }>(
    sql,
    `select id, user_id, status from tickets where id = $1 for update`,
    [id],
  );
  if (!t) throw err.notFound();
  const row = await one(
    sql,
    `update tickets
        set reply = $2, replied_at = now(), replied_by = $3, status = 'closed'
      where id = $1
      returning *`,
    [id, reply, user.id],
  );
  // A ticket raised by a walk-in the desk typed in has nobody to notify.
  if (t.user_id) {
    await enqueue(
      sql,
      "inapp",
      "ticket_replied",
      t.user_id,
      { ticket_id: id, reply: reply.slice(0, 200) },
      // Keyed on the reply, not the ticket: if the desk answers again after the
      // member writes back, that second answer is its own notification.
      `ticket_replied|${id}|${Date.now()}`,
    );
  }
  await audit(sql, user.id, "ticket_reply", "ticket", id);
  return { status: 200, body: { ticket: row } };
}

export async function ticketClose(sql: Sql, id: string, user: PublicUser) {
  requireRole(user, ["receptionist", "manager"]);
  await sql.query(`update tickets set status = 'closed' where id = $1`, [id]);
  await audit(sql, user.id, "ticket_close", "ticket", id);
  return { status: 200, body: { ok: true } };
}
