#!/usr/bin/env node
/**
 * Isolated demo snapshot. No dotenv loading and no network side effects (mail/payOS).
 * Preview: DATABASE_URL="" PGLITE_DATA_DIR=.cache/lively-demo node scripts/seed-lively.mjs --apply
 * PostgreSQL: DATABASE_URL=... node scripts/seed-lively.mjs (read-only impact plan).
 * Remote writes are blocked unless --replace-remote exactly names the target host.
 * Local writes require --apply. Only a fresh PGlite directory, or a database already
 * owned by this script, may be rebuilt. Existing users/logins and catalogues survive.
 * Re-running rebuilds the same deterministic snapshot relative to --as-of (or now).
 * Stop the app before reseeding its PGlite directory; then restart the app with it.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { pendingMigrations } from './migration-plan.mjs';
import { isMainModule } from './with-app-env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DAY = 86400000;
export const WINDOW_START = '2026-09-01';
const VERSION = 'lively-v1';
// Explicit list, never CASCADE: an unexpected new FK aborts the transaction.
export const ACTIVITY = ['membership_extensions', 'class_certificates', 'coach_certifications',
  'homework_recipients', 'homework', 'training_plan_versions', 'training_plans',
  'session_results', 'session_charges', 'progress_reviews', 'coach_notes', 'member_levels',
  'training_profiles', 'attendance', 'checkin_tokens', 'equipment_loans', 'waitlist_offers',
  'enrollments', 'coach_occupancies', 'sessions', 'court_bookings', 'occupancies', 'classes',
  'invoice_lines', 'invoices', 'promotion_redemptions', 'payments', 'cashier_shifts',
  'subscriptions', 'booking_series', 'coach_payouts', 'contact_log', 'loyalty_adjustments',
  'messages', 'conversations', 'tickets', 'outbox', 'audit_logs', 'work_orders',
  'sessions_auth', 'otp_challenges', 'idempotency_keys', 'rtc_signals', 'rtc_peers'];

export function id(key) {
  const h = createHash('sha256').update(`${VERSION}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
// Keyed draws keep a day's noise independent of iteration order and --as-of.
export function random(key) {
  return parseInt(createHash('sha256').update(id(key)).digest('hex').slice(0, 8), 16) / 0x100000000;
}

export function demand(date, hour) {
  const age = (Date.parse(date) - Date.parse(WINDOW_START)) / DAY;
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const evening = hour >= 17;
  const weekly = [1.65, 0.50, 0.55, 1.08, 1, evening ? 1.65 : 1.05, 1.65][weekday];
  const hourly = evening ? 0.68 : hour <= 8 ? 0.31 : 0.14;
  const event = date === '2026-09-02' ? 2.8 : date === '2026-10-20' ? 2.1
    : date >= '2026-10-12' && date <= '2026-10-18' ? 1.35
    : date >= '2026-10-26' && date <= '2026-11-01' ? 0.42 : 1;
  return Math.min(0.98, hourly * weekly * (0.72 + Math.min(age, 120) / 180)
    * (0.85 + random(`noise:${date}`) * 0.30) * event);
}
export function normalize(name) {
  return name.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}
export function protectedLogin(u) {
  return /@arena3\.local$/i.test(u.email || '') || /^\+8490000000[123]$/.test(u.phone);
}
export function suspiciousUser(u) {
  return !protectedLogin(u) && (/\b(coach|test|dummy|seed|check)\b/i.test(u.full_name)
    || /\d{4,}|[�ÃÄ]/u.test(u.full_name) || /^(Rô Văn Lộc|Nguyễn Văn Bát Môn)$/u.test(u.full_name));
}
export function writableTarget(databaseUrl, dataDir, replaceRemote) {
  if (databaseUrl && replaceRemote) {
    // Deliberate production reseed: the operator must type the exact host they mean.
    if (new URL(databaseUrl).hostname !== replaceRemote)
      throw new Error('--replace-remote must equal the DATABASE_URL hostname.');
    return;
  }
  if (databaseUrl) {
    const parsed = new URL(databaseUrl);
    if (['host', 'hostaddr', 'service'].some(k => parsed.searchParams.has(k)))
      throw new Error('Connection host overrides are blocked for seed writes.');
    const host = parsed.hostname;
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host))
      throw new Error('Remote PostgreSQL/Neon writes are blocked. Use the read-only plan and a backup branch.');
  } else if (!dataDir || dataDir === 'memory') {
    throw new Error('Set PGLITE_DATA_DIR to a fresh, dedicated local directory.');
  }
}

async function connect(databaseUrl, dataDir) {
  if (databaseUrl) {
    const { default: pg } = await import('pg');
    const db = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
    await db.connect();
    return { query: (s, p = []) => db.query(s, p), exec: s => db.query(s), close: () => db.end() };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite({ dataDir, parsers: { 1082: s => s, 20: Number } });
  await db.waitReady;
  return db;
}

// Windows may mark newly created directories ReadOnly. Emscripten's NODEFS
// interprets that attribute as Unix permissions and cannot reopen Postgres.
// Only touch this seed's explicitly validated, dedicated directory; no symlinks.
export async function prepareLocalDirectory(dataDir) {
  await mkdir(dataDir, { recursive: true });
  if (process.platform !== 'win32') return;
  const visit = async dir => {
    await chmod(dir, 0o700);
    for (const entry of await readdir(dir, { withFileTypes: true }))
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(resolve(dir, entry.name));
  };
  await visit(resolve(dataDir));
}

export async function migrate(db) {
  await db.exec('create table if not exists _migrations(name text primary key, applied_at timestamptz not null default now())');
  const applied = (await db.query('select name from _migrations')).rows.map(r => r.name);
  for (const { name } of pendingMigrations(await readdir(resolve(ROOT, 'migrations')), applied)) {
    await db.exec('begin');
    try {
      await db.exec(await readFile(resolve(ROOT, 'migrations', name), 'utf8'));
      await db.query('insert into _migrations(name) values ($1)', [name]);
      await db.exec('commit');
    } catch (err) { await db.exec('rollback'); throw new Error(`Migration ${name}: ${err.message}`); }
  }
}

async function impact(db) {
  const users = (await db.query('select id, full_name, role, email, phone from users order by role, full_name')).rows;
  const tables = (await db.query("select tablename from pg_tables where schemaname='public'")).rows.map(r => r.tablename);
  const existingActivity = {};
  for (const t of ACTIVITY.filter(t => tables.includes(t)))
    existingActivity[t] = Number((await db.query(`select count(*) as n from ${t}`)).rows[0].n);
  return { existingActivity, protectedLogins: users.filter(protectedLogin),
    reviewOnlyJunkCandidates: users.filter(suspiciousUser),
    deletionPolicy: 'No users are deleted. Activity replacement is local-only in an owned demo DB. Junk candidates require manual review on a Neon backup branch.' };
}

async function insertRows(db, table, rows) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  for (let offset = 0; offset < rows.length; offset += 150) {
    const params = [];
    const values = rows.slice(offset, offset + 150).map(row => `(${keys.map(k => {
      const v = row[k]; params.push(v != null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v);
      return `$${params.length}`;
    }).join(',')})`);
    await db.query(`insert into ${table} (${keys.map(k => `"${k}"`).join(',')}) values ${values.join(',')}`, params);
  }
}

export async function populate(db, asOf) {
  const now = new Date(asOf);
  if (!Number.isFinite(+now)) throw new Error('Invalid --as-of timestamp');
  const today = new Date(+now + 7 * 3600000).toISOString().slice(0, 10);
  const first = Math.round((Date.parse(WINDOW_START) - Date.parse(today)) / DAY);
  if (+now < +new Date(`${WINDOW_START}T00:00:00+07:00`)) throw new Error('--as-of precedes activity window');
  const day = n => new Date(Date.parse(`${today}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
  const at = (n, h, m = 0) => new Date(`${day(n)}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+07:00`);
  const rows = {};
  const add = (table, row) => { (rows[table] ??= []).push(row); return row; };
  const audit = (time, actor, action, entity, entityId, after = {}, before = null) =>
    add('audit_logs', { at: time, actor_id: actor.id, action, entity, entity_id: entityId,
      before, after: { source: VERSION, ...after } });
  const settings = (await db.query('select * from center_settings where id=1')).rows[0];
  const courts = (await db.query("select * from courts where status='ready' and retired_at is null order by court_code")).rows;
  const plans = (await db.query('select * from membership_plans where is_on_sale and duration_months in (1,3,6,12) order by duration_months')).rows;
  if (plans.length !== 4 || Number(settings.member_court_fee_vnd) !== 30000) throw new Error('Expected four current membership plans and 30,000 VND member court fee');
  const rules = (await db.query('select * from price_rules')).rows;
  const users = (await db.query("select * from users order by id")).rows;
  const manager = users.find(u => u.role === 'manager' && protectedLogin(u));
  const desk = users.find(u => u.role === 'receptionist' && protectedLogin(u));
  const coaches = users.filter(u => u.role === 'coach' && protectedLogin(u));
  if (!manager || !desk || !coaches.length || !courts.length) throw new Error('Missing demo staff/courts');
  const coachSports = (await db.query('select * from coach_sports')).rows;
  const surnames = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Võ', 'Đặng', 'Bùi', 'Đỗ', 'Hồ', 'Ngô', 'Dương'];
  const given = ['Minh Châu', 'Thu Trang', 'Quang Huy', 'Bảo Ngọc', 'Đức Duy', 'Thanh Trúc', 'Gia Hân', 'Tuấn Kiệt'];
  const hash = manager.password_hash;
  // Synthetic contact details only; existing protected accounts retain their credentials.
  for (let i = 0; i < 96; i++) {
    const uid = id(`member:${i}`);
    const joined = at(first + (i < 24 ? i % 10 : 11 + Math.floor(80 * Math.sqrt((i - 24) / 72))), 8);
    if (+joined > +now) continue;
    if (users.some(u => u.id === uid)) continue;
    const name = `${surnames[i % 12]} ${given[Math.floor(i / 12)]}`;
    const u = add('users', { id: uid, member_code: `LV-${String(i + 1).padStart(4, '0')}`,
      full_name: name, name_normalized: normalize(name), phone: `+84988${String(i).padStart(6, '0')}`,
      email: `lively.${i + 1}@example.invalid`, role: 'member', status: 'active', password_hash: hash,
      date_of_birth: `${1985 + i % 20}-${String(1 + i % 12).padStart(2, '0')}-15`,
      pii_consent_at: joined, created_at: joined });
    users.push(u);
  }
  const members = users.filter(u => u.role === 'member' && u.status === 'active' && !suspiciousUser(u)
    && +new Date(u.created_at) <= +now).sort((a,b) => a.id.localeCompare(b.id));
  const promoId = id('promo:october-2026');
  if (today >= '2026-10-12') await db.query(`insert into promotions
    (id,code,name,kind,value,max_per_member,applies_to,starts_at,ends_at,created_by,created_at,updated_at)
    values($1,'LV-OCT26','Tuần lễ tập luyện tháng 10','percent',10,100,ARRAY['plan'],
      '2026-10-12T00:00:00+07:00','2026-10-19T00:00:00+07:00',$2,
      '2026-10-12T00:00:00+07:00','2026-10-12T00:00:00+07:00') on conflict(id) do nothing`, [promoId, manager.id]);
  const subs = new Map();
  const shifts = new Map();
  let payN = 0;
  function payment(refType, refId, user, amount, time, label, status = 'posted', discount = 0, refundMethod = null) {
    if (+time > +now || +time < +at(first, 0)) throw new Error('Payment outside activity window');
    const n = ++payN;
    const localDay = new Date(+time + 7 * 3600000).toISOString().slice(0, 10);
    const shiftStart = new Date(`${localDay}T05:00:00+07:00`);
    const shiftEnd = new Date(`${localDay}T22:30:00+07:00`);
    const atDesk = +time >= +shiftStart && +time <= +shiftEnd;
    if (atDesk && !shifts.has(localDay)) shifts.set(localDay, add('cashier_shifts', {
      id: id(`shift:${localDay}`), receptionist_id: desk.id, opened_at: shiftStart,
      closed_at: +shiftEnd <= +now ? shiftEnd : null, cash_declared_vnd: 0 }));
    const shift = atDesk ? shifts.get(localDay) : null;
    const method = refundMethod || (shift ? ['cash', 'transfer', 'card', 'gateway'][n % 4] : 'transfer');
    if (shift && method === 'cash') shift.cash_declared_vnd += amount;
    const p = add('payments', { id: id(`payment:${n}`), code: `PAY-LV-${String(n).padStart(6, '0')}`,
      user_id: user?.id ?? null, shift_id: shift?.id ?? null, method, amount_vnd: amount,
      vat_rate: Number(settings.vat_rate), status, ref_type: refType, ref_id: refId,
      created_by: shift ? desk.id : manager.id, created_at: time, paid_at: status === 'posted' ? time : null,
      capture_mode: method === 'gateway' ? 'auto' : 'manual', provider: method === 'gateway' ? 'payos' : null,
      provider_txn_id: method === 'gateway' ? `LV-${n}` : null,
      promo_id: discount ? promoId : null, discount_vnd: discount });
    if (discount) add('promotion_redemptions', { id: id(`redemption:${p.id}`), promo_id: promoId,
      user_id: user.id, payment_id: p.id, discount_vnd: discount, status: 'applied', created_at: time });
    if (status !== 'posted') return p;
    const net = Math.floor(amount / (1 + Number(settings.vat_rate) / 100));
    const inv = add('invoices', { id: id(`invoice:${n}`), code: `INV-LV-${String(n).padStart(6, '0')}`,
      payment_id: p.id, buyer_name: user?.full_name ?? 'Khách vãng lai', issued_at: time,
      form_no: '1', serial_no: `A3${today.slice(2, 4)}E`, seller_legal_name: settings.legal_name,
      seller_tax_code: settings.tax_code, seller_address: settings.address,
      subtotal_vnd: net, vat_rate: Number(settings.vat_rate), vat_vnd: amount - net, total_vnd: amount });
    add('invoice_lines', { id: id(`line:${n}`), invoice_id: inv.id, description: label,
      qty: 1, unit: refType === 'booking' ? 'giờ' : 'gói', unit_vnd: amount, amount_vnd: amount });
    if (user && amount > 0) add('outbox', { id: id(`receipt:${p.id}`), channel: 'inapp', template: 'payment_receipt',
      user_id: user.id, payload: { payment_id: p.id, invoice_id: inv.id, amount_vnd: amount, method },
      dedupe_key: `lively:receipt:${p.id}`, created_at: time, sent_at: time,
      read_at: n % 5 && +time + 45 * 60000 <= +now ? new Date(+time + 45 * 60000) : null });
    audit(time, shift ? desk : manager, amount < 0 ? 'refund' : 'create_payment', 'payment', p.id,
      { ref_type: refType, amount_vnd: amount });
    return p;
  }
  for (const [i, user] of members.entries()) {
    const synthetic = Array.from({ length: 96 }, (_, j) => id(`member:${j}`)).indexOf(user.id);
    const joinOffset = synthetic >= 0 ? (synthetic < 24 ? synthetic % 10 : 11 + Math.floor(80 * Math.sqrt((synthetic - 24) / 72))) : i % 10;
    const plan = plans[synthetic >= 0 && synthetic < 24 ? 1 : i % 9 === 0 ? 2 : 0];
    let start = day(first + joinOffset), renewal = 0;
    while (+new Date(`${start}T08:00:00+07:00`) <= +now) {
      // Calendar months, clamped on short months, matching the product's duration model.
      const d = new Date(`${start}T00:00:00Z`);
      const targetMonth = d.getUTCMonth() + plan.duration_months;
      const last = new Date(Date.UTC(d.getUTCFullYear(), targetMonth + 1, 0)).getUTCDate();
      const end = new Date(Date.UTC(d.getUTCFullYear(), targetMonth, Math.min(d.getUTCDate(), last)) - DAY).toISOString().slice(0, 10);
      const discount = start >= '2026-10-12' && start <= '2026-10-18' ? Math.floor(plan.price_vnd * 0.1) : 0;
      const s = add('subscriptions', { id: id(`sub:${user.id}:${renewal}`), user_id: user.id, plan_id: plan.id,
        start_on: start, end_on: end, status: end < today ? 'expired' : 'active', price_vnd: plan.price_vnd,
        promo_id: discount ? promoId : null, promo_discount_vnd: discount });
      subs.set(user.id, s);
      const bought = new Date(`${start}T08:00:00+07:00`);
      payment('subscription', s.id, user, plan.price_vnd - discount, bought, `Hội viên ${plan.duration_months} tháng`, 'posted', discount);
      // These descriptive actions supplement flows that currently have no app audit call.
      audit(bought, user, renewal ? 'renew_subscription' : 'buy_subscription', 'subscription', s.id);
      start = new Date(Date.parse(end) + DAY).toISOString().slice(0, 10);
      renewal++;
      }
    if (subs.has(user.id)) add('training_profiles', { user_id: user.id, goal: ['technique', 'fun', 'weight', 'compete'][i % 4], updated_at: at(first + joinOffset, 8) });
  }
  const busy = new Set();
  const courtBusy = new Set();
  const userDays = new Map();
  const key = (who, date) => `${who}:${+date}`;
  const eligible = members.filter(u => rows.subscriptions?.some(s => s.user_id === u.id && s.end_on > '2026-11-12' && s.start_on <= '2026-09-10'));
  for (const [ci, coach] of coaches.entries()) {
    const sport = coachSports.find(s => s.user_id === coach.id)?.sport;
    const court = courts.find(c => c.sport === sport);
    if (!court) continue;
    for (let phase = 0; phase < 2; phase++) {
      const from = first + (phase ? 42 : 11);
      const to = from + 28;
      if (eligible.length < 8 || +at(from, 0) > +now) continue;
      const hour = 17 + ci % 3;
      const weekday = 1 + ci % 5;
      const klass = add('classes', { id: id(`class:${ci}:${phase}`), sport, level: phase ? 'intermediate' : 'beginner',
        coach_id: coach.id, court_id: court.id, capacity: 10, enrolled_count: 8,
        rrule: `FREQ=WEEKLY;BYDAY=${['SU','MO','TU','WE','TH','FR','SA'][weekday]};BYHOUR=${hour}`,
        duration_min: 60, start_on: day(from), end_on: day(to), status: day(to) < today ? 'closed' : 'open',
        price_vnd: 800000 + ci * 100000, min_enrolled: 4,
        description: 'Rèn kỹ thuật, phối hợp đồng đội và duy trì thói quen vận động cùng huấn luyện viên.',
        syllabus: 'Khởi động; kỹ thuật nền tảng; bài tập phối hợp; thi đấu thực hành; giãn cơ.',
        who_for: 'Hội viên muốn luyện tập đều đặn và cải thiện kỹ thuật.', bring: 'Giày thể thao, nước uống và khăn cá nhân.' });
      const roster = Array.from({ length: 8 }, (_, j) => eligible[(ci * 8 + j) % eligible.length]);
      for (const u of roster) {
        const e = add('enrollments', { id: id(`enroll:${klass.id}:${u.id}`), class_id: klass.id,
          user_id: u.id, status: 'confirmed', waitlist_pos: null, prepaid_sessions: 0, price_vnd: klass.price_vnd });
        const joined = rows.subscriptions.find(s => s.user_id === u.id).start_on;
        const joinDay = Math.round((Date.parse(joined) - Date.parse(today)) / DAY);
        const enrolled = at(Math.max(joinDay, from - 8 + roster.indexOf(u)), 9, ci * 3);
        payment('enrollment', e.id, u, klass.price_vnd, enrolled, `Học phí ${sport} — ${klass.level}`);
        audit(enrolled, u, 'enroll_class', 'enrollment', e.id, { class_id: klass.id });
      }
      for (let n = from; n <= to; n++) {
        if (new Date(`${day(n)}T12:00:00Z`).getUTCDay() !== weekday) continue;
        const start = at(n, hour), end = at(n, hour + 1);
        if (+end > +now) continue;
        const sid = id(`session:${klass.id}:${day(n)}`);
        courtBusy.add(key(court.id, start));
        for (const u of roster) busy.add(key(u.id, start));
        add('sessions', { id: sid, class_id: klass.id, court_id: court.id, start_at: start, end_at: end,
          status: 'done', occupancy_id: null });
        for (const [j, u] of roster.entries()) {
          const absent = (n + 100 + j) % 11 === 0;
          add('attendance', { id: id(`att:${sid}:${u.id}`), kind: 'session', user_id: u.id, session_id: sid,
            result: absent ? 'absent' : j % 7 === 0 ? 'late' : 'present', at: start, method: 'staff', checked_by: coach.id });
          if (!absent) add('session_results', { id: id(`result:${sid}:${u.id}`), session_id: sid, user_id: u.id,
            plan_pct: 70 + j * 3, metrics: { practice_minutes: 45 }, note: 'Di chuyển chủ động hơn, cần giữ nhịp thở đều.', recorded_by: coach.id, recorded_at: end });
        }
      }
      if (phase && first <= -3) {
        const hw = add('homework', { id: id(`hw:${ci}`), coach_id: coach.id, class_id: klass.id,
          title: 'Luyện bước chân và sức bền', body: 'Tập 3 hiệp bước chân, mỗi hiệp 5 phút. Giãn cơ sau tập.',
          checklist: ['Khởi động 5 phút', 'Tập bước chân', 'Giãn cơ'], due_on: day(5), created_at: at(-2, 9) });
        for (const u of roster) add('homework_recipients', { homework_id: hw.id, user_id: u.id, done_items: [] });
        add('coach_notes', { id: id(`note:${ci}`), user_id: roster[0].id, coach_id: coach.id, body: 'Thể lực tiến bộ, tiếp tục tăng cường độ từng bước.', created_at: at(-3, 10) });
        audit(at(-3, 10), coach, 'coach_note', 'user', roster[0].id, { note_id: id(`note:${ci}`) });
        add('progress_reviews', { id: id(`review:${ci}`), user_id: roster[0].id, sport, coach_id: coach.id,
          period_weeks: 4, technique: 4, fitness: 3, attitude: 5, comment: 'Duy trì lịch tập tốt, phối hợp đồng đội tiến bộ.', created_at: at(-1, 10) });
      }
    }
  }
  let bn = 0;
  const horizon = 0;
  for (let n = first; n <= horizon; n++) {
    for (const [ci, court] of courts.entries()) {
      for (let hour = 6; hour <= 21; hour++) {
        const start = at(n, hour), end = at(n, hour + 1);
        if (+end > +now) continue;
        if (courtBusy.has(key(court.id, start))) continue;
        // Quiet weekday mornings, busy evenings/weekends; deterministic gaps remain bookable.
        const weekend = [0, 6].includes(new Date(+start + 7 * 3600000).getUTCDay());
        if (random(`slot:${day(n)}:${ci}:${hour}`) >= demand(day(n), hour)) continue;
        let guest = (bn + 1) % 4 === 0 || !rows.subscriptions?.some(s => s.start_on <= day(n));
        const user = guest ? null : Array.from({ length: members.length }, (_, j) => members[(bn * 7 + j) % members.length])
          .find(candidate => rows.subscriptions?.some(s => s.user_id === candidate.id && s.start_on <= day(n))
            && +new Date(`${rows.subscriptions.find(s => s.user_id === candidate.id).start_on}T08:00:00+07:00`) <= +start - 15 * 60000
            && !busy.has(key(candidate.id, start)) && (userDays.get(`${candidate.id}:${day(n)}`) || 0) < 2);
        // Walk-ins fill demand beyond the young membership base, especially on 2/9.
        if (!user) guest = true;
        const sub = user && rows.subscriptions.find(s => s.user_id === user.id && s.start_on <= day(n) && s.end_on >= day(n));
        const covered = sub && sub.start_on <= day(n) && sub.end_on >= day(n);
        const dayKind = weekend ? 'weekend' : 'weekday';
        const rule = rules.filter(r => r.sport === court.sport && (!r.court_id || r.court_id === court.id)
          && r.day_kind === dayKind && r.start_min <= hour * 60 && r.end_min >= (hour + 1) * 60)
          .sort((a, b) => Number(Boolean(b.court_id)) - Number(Boolean(a.court_id)) || a.id.localeCompare(b.id))[0];
        if (!rule) throw new Error(`Missing price rule for ${court.court_code}/${dayKind}/${hour}`);
        const amount = covered ? Number(settings.member_court_fee_vnd) : rule.price_vnd;
        const number = ++bn, bid = id(`booking:${number}`);
        const status = number % 23 === 0 ? 'cancelled' : number % 29 === 0 ? 'no_show' : 'completed';
        add('court_bookings', { id: bid, code: `CRT-LV-${String(number).padStart(6, '0')}`, court_id: court.id,
          user_id: user?.id ?? null, guest_name: guest ? `${surnames[number % 12]} ${given[number % 8]}` : null,
          guest_phone: guest ? `+84977${String(number).padStart(6, '0')}` : null,
          start_at: start, end_at: end, status, channel: guest ? 'desk' : 'app', price_vnd: amount,
          vat_rate: Number(settings.vat_rate), occupancy_id: null, paid_vnd: amount, deposit_vnd: 0,
          cancel_refund_pct: status === 'cancelled' ? 100 : null, cancel_fee_vnd: status === 'cancelled' ? 0 : null });
        const paidAt = new Date(+start - 15 * 60000);
        const charge = payment('booking', bid, user, amount, paidAt, `Thuê sân ${court.court_code} — ${day(n)} ${hour}:00`);
        audit(paidAt, user || desk, guest ? 'walk_in' : 'create_booking', 'booking', bid, { start_at: start, court_id: court.id });
        if (status === 'cancelled') {
          const cancelled = new Date(+start - 5 * 60000);
          payment('booking', bid, user, -amount, cancelled, 'Hoàn tiền hủy sân', 'posted', 0, charge.method);
          audit(cancelled, user || desk, 'cancel_booking', 'booking', bid, { refund_pct: 100, reason: 'Đổi kế hoạch cá nhân' });
        } else if (number % 37 === 0) audit(new Date(+paidAt + 60000), user || desk, 'reschedule_booking', 'booking', bid,
          { start_at: start, court_id: court.id }, { start_at: end, court_id: court.id });
        if (user) {
          busy.add(key(user.id, start));
          const uk = `${user.id}:${day(n)}`; userDays.set(uk, (userDays.get(uk) || 0) + 1);
          if (status === 'completed' && number % 3 === 0) add('attendance', { id: id(`gate:${bid}`), kind: 'gate', user_id: user.id,
            session_id: null, result: null, at: start, method: 'staff', checked_by: desk.id });
        }
      }
    }
  }
  const ticketTexts = ['Nhờ kiểm tra đèn sân cầu lông buổi tối.', 'Tôi muốn đổi giờ tập sang cuối tuần, nhờ tư vấn.',
    'Xin hướng dẫn gia hạn hội viên trước khi hết hạn.', 'Nhờ hỗ trợ lấy lại hóa đơn buổi đặt sân hôm qua.',
    'Tôi muốn đăng ký lớp nâng cao vào tháng tới.'];
  // The product supports open/closed tickets, including closed requests without a reply.
  for (let i = 0; i < 180 && members.length; i++) {
    const user = members[i % members.length];
    const joined = rows.subscriptions?.find(s => s.user_id === user.id)?.start_on;
    if (!joined) continue;
    const earliest = Math.max(first, Math.round((Date.parse(joined) - Date.parse(today)) / DAY));
    const days = earliest + Math.floor(random(`ticket-day:${i}`) * (1 - earliest));
    const created = at(days, 8 + i % 12, i % 60);
    if (+created > +now) continue;
    const answered = new Date(+created + (20 + i % 160) * 60000);
    const closed = i % 5 !== 0 && +answered <= +now;
    const replied = closed && i % 9 !== 0;
    add('tickets', { id: id(`ticket:${i}`), user_id: user.id, body: ticketTexts[i % 5], status: closed ? 'closed' : 'open',
      created_at: created, reply: replied ? ['Đèn sân đã được thay, cảm ơn bạn đã báo nhé.',
        'Bạn nhắn giờ muốn đổi, lễ tân sẽ kiểm tra sân giúp bạn.', 'Bạn có thể gia hạn tại quầy hoặc trong mục Hội viên.',
        'Hóa đơn nằm trong mục Thanh toán, bạn kiểm tra lại giúp mình nhé.', 'Lễ tân đã gửi lịch lớp nâng cao cho bạn.'][i % 5] : null,
      replied_at: replied ? answered : null, replied_by: replied ? desk.id : null });
    if (closed) {
      audit(answered, desk, replied ? 'ticket_reply' : 'ticket_close', 'ticket', id(`ticket:${i}`));
      add('outbox', { id: id(`notice:${i}`), channel: 'inapp', template: replied ? 'ticket_reply' : 'ticket_closed', user_id: user.id,
        payload: { ticket_id: id(`ticket:${i}`), reply: replied ? 'Lễ tân đã trả lời yêu cầu của bạn.' : null },
        dedupe_key: `lively:notice:${i}`, sent_at: answered, created_at: answered,
        read_at: i % 4 && +answered + 30 * 60000 <= +now ? new Date(+answered + 30 * 60000) : null });
    }
  }
  // One conversation per member/staff pair (0038); class group chats aren't supported.
  const deskTopics = [
    ['Tối thứ sáu còn sân lúc 19h không ạ?', 'Mình còn khung 19h và 20h, bạn đi mấy người?', 'Nhóm mình bốn người, để mình chốt với mọi người nhé.', 'Dạ, bạn chọn giờ trên lịch rồi thanh toán giúp mình nhé.'],
    ['Mình muốn đổi buổi tập sang thứ bảy, cần làm gì ạ?', 'Bạn vào lịch đặt sân, chọn Đổi lịch để xem giờ trống nhé.', 'Nếu đổi sang buổi sáng thì có chênh lệch phí không?', 'Hệ thống sẽ hiện giá mới trước khi bạn xác nhận nha.'],
    ['Cho mình hỏi lấy hóa đơn ở đâu với ạ?', 'Bạn vào Thanh toán rồi mở giao dịch cần lấy hóa đơn nhé.', 'Mình tìm thấy rồi, có tải về được không?', 'Có nút tải ngay trong chi tiết hóa đơn đó bạn.'],
    ['Gói tháng của mình sắp hết, gia hạn thế nào ạ?', 'Bạn mở mục Hội viên, chọn gói và phương thức thanh toán nhé.', 'Mình chuyển khoản được chứ?', 'Được bạn nhé, lễ tân sẽ đối soát trong giờ làm việc.'],
    ['Trời mưa quá, sân trong nhà vẫn chơi được chứ ạ?', 'Sân trong nhà vẫn mở nhé, bạn đi đường cẩn thận.', 'Dạ mình sẽ đến sớm để khởi động.', 'Hẹn gặp bạn tại quầy lễ tân nha.'],
    ['Tuần này có ưu đãi gì cho hội viên mới không?', 'Bạn xem mã ưu đãi trong mục Hội viên giúp mình nhé.', 'Mình rủ thêm hai bạn đến chơi thử được không?', 'Được nha, bạn có thể đặt sân cho cả nhóm.'],
  ];
  const coachTopics = [
    ['Thầy ơi em hay đánh cầu ra ngoài khi đập, nên sửa gì ạ?', 'Em thử giảm lực, giữ điểm tiếp xúc phía trước người nhé.', 'Ở nhà em nên tập bài nào trước?', 'Tập vung vợt chậm 3 hiệp, mỗi hiệp 15 lần rồi giãn vai nhé.'],
    ['Em muốn cải thiện bước chân, tập thêm bao lâu là vừa?', 'Em tập bước chéo 10 phút, nghỉ giữa mỗi hiệp nhé.', 'Nếu hơi căng bắp chân thì có nên nghỉ không thầy?', 'Em nghỉ và giãn nhẹ, buổi tới mình kiểm tra lại động tác.'],
    ['Buổi tới mình tập giao cầu hay đánh đôi ạ?', 'Mình ôn giao cầu ngắn rồi tập phối hợp đánh đôi.', 'Em mang vợt cũ tập vẫn được chứ ạ?', 'Được em, nhớ mang giày phù hợp và nước uống nhé.'],
    ['Em xin nghỉ một buổi vì bận công việc ạ.', 'Thầy nhận được rồi, em xem lại bài tập trong mục lớp nhé.', 'Em sẽ tự ôn trước buổi sau, cảm ơn thầy.', 'Ừ, cứ tập chậm đúng kỹ thuật trước nha.'],
  ];
  for (const [mi, user] of members.entries()) {
    const joined = rows.subscriptions?.find(s => s.user_id === user.id)?.start_on;
    if (!joined) continue;
    const earliest = Math.max(first, Math.round((Date.parse(joined) - Date.parse(today)) / DAY));
    for (const [si, staff] of [desk, ...coaches.slice(0, 3)].entries()) {
      const cid = id(`conversation:${user.id}:${staff.id}`);
      let conversation;
      for (let turn = 0; turn < 4; turn++) {
        const n = earliest + Math.floor(random(`chat-day:${cid}:${turn}`) * (1 - earliest));
        const base = at(n, 8 + Math.floor(random(`chat-hour:${cid}:${turn}`) * 10), mi % 50);
        const topics = si === 0 ? deskTopics : coachTopics;
        const topic = topics[(mi + si + turn) % topics.length];
        let time = +base;
        for (let j = 0; j < topic.length; j++) {
          if (j) time += (5 + Math.floor(random(`reply:${cid}:${turn}:${j}`) * 65)) * 60000;
          if (time > +now) break;
          if (!conversation) conversation = add('conversations', { id: cid, member_id: user.id, staff_id: staff.id, created_at: new Date(time) });
          if (time < +conversation.created_at) conversation.created_at = new Date(time);
          const read = time + (2 + mi % 3) * 60000;
          add('messages', { id: id(`message:${cid}:${turn}:${j}`), conversation_id: cid,
            sender_id: j % 2 ? staff.id : user.id, body: topic[j], created_at: new Date(time),
            read_at: (turn !== 3 || j !== 3 || mi % 4 !== 0) && read <= +now ? new Date(read) : null });
        }
      }
    }
    for (let n = earliest; n <= 0; n += 3 + mi % 5) {
      const time = at(n, 9 + mi % 12, mi % 50);
      if (+time > +now) continue;
      audit(time, user, 'login', 'user', user.id);
      if ((n - earliest) % 19 === 0) audit(time, desk, 'update_member', 'user', user.id, { health_notes: 'Ưu tiên tập buổi tối' });
    }
  }
  for (const a of rows.attendance || []) if (a.kind === 'gate') audit(a.at, desk, 'gate_checkin', 'user', a.user_id, { method: 'staff' });
  for (let n = first + 7; n <= 0; n += 14) if (+at(n, 10) <= +now)
    audit(at(n, 10), manager, 'patch_settings', 'settings', null,
      { book_ahead_days: settings.book_ahead_days }, { book_ahead_days: settings.book_ahead_days === 7 ? 6 : 7 });
  // FK order, with deferred coach-session FK left enabled.
  const order = ['users', 'subscriptions', 'training_profiles', 'classes', 'enrollments', 'occupancies', 'sessions',
    'coach_occupancies', 'court_bookings', 'cashier_shifts', 'payments', 'promotion_redemptions', 'invoices', 'invoice_lines', 'attendance', 'session_results',
    'homework', 'homework_recipients', 'coach_notes', 'progress_reviews', 'conversations', 'messages', 'tickets', 'outbox', 'audit_logs'];
  for (const table of order) await insertRows(db, table, rows[table] || []);
  return { asOf: now.toISOString(), from: WINDOW_START, through: day(horizon),
    added: Object.fromEntries(order.map(t => [t, rows[t]?.length || 0])) };
}

export async function verify(db, asOf) {
  const failures = {};
  const checks = {
    staleBookings: "select count(*) n from court_bookings where status in ('hold','confirmed','in_use') and start_at <= $1",
    futureCompletedBookings: "select count(*) n from court_bookings where status in ('completed','no_show') and end_at > $1",
    staleSessions: "select count(*) n from sessions where status='scheduled' and start_at <= $1",
    duplicateLiveMemberships: "select count(*) n from (select user_id from subscriptions where status in ('active','frozen') group by user_id having count(*)>1) q",
    bookingOverlaps: "select count(*) n from court_bookings a join court_bookings b on a.id<b.id and a.court_id=b.court_id and a.start_at<b.end_at and b.start_at<a.end_at where a.status<>'cancelled' and b.status<>'cancelled'",
    coachOverlaps: "select count(*) n from sessions a join classes ca on ca.id=a.class_id join sessions b on a.id<b.id and a.start_at<b.end_at and b.start_at<a.end_at join classes cb on cb.id=b.class_id where ca.coach_id=cb.coach_id and a.status<>'cancelled' and b.status<>'cancelled'",
    courtSessionOverlaps: "select count(*) n from sessions s join court_bookings b on b.court_id=s.court_id and s.start_at<b.end_at and b.start_at<s.end_at where s.status<>'cancelled' and b.status<>'cancelled'",
    classCoverage: "select count(*) n from enrollments e join classes c on c.id=e.class_id where e.status='confirmed' and not exists(select 1 from subscriptions s where s.user_id=e.user_id and s.start_on<=c.start_on and s.end_on>c.end_on)",
    unpaidBookings: "select count(*) n from court_bookings b where b.paid_vnd<>b.price_vnd or not exists(select 1 from payments p where p.ref_type='booking' and p.ref_id=b.id and p.status='posted' and p.amount_vnd=b.price_vnd and p.paid_at<b.start_at)",
    unpaidEnrollments: "select count(*) n from enrollments e where e.status='confirmed' and not exists(select 1 from payments p where p.ref_type='enrollment' and p.ref_id=e.id and p.status='posted' and p.amount_vnd=e.price_vnd)",
    unpaidMemberships: "select count(*) n from subscriptions s where not exists(select 1 from payments p where p.ref_type='subscription' and p.ref_id=s.id and p.status='posted' and p.amount_vnd=s.price_vnd-s.promo_discount_vnd)",
    memberPricing: "select count(*) n from court_bookings b where exists(select 1 from subscriptions s where s.user_id=b.user_id and (b.start_at at time zone 'Asia/Ho_Chi_Minh')::date between s.start_on and s.end_on) and b.price_vnd<>30000",
    missingInvoices: "select count(*) n from payments p left join invoices i on i.payment_id=p.id where p.status='posted' and (i.id is null or i.total_vnd<>p.amount_vnd or i.subtotal_vnd+i.vat_vnd<>i.total_vnd)",
    missingLines: "select count(*) n from invoices i where i.total_vnd<>(select sum(l.amount_vnd) from invoice_lines l where l.invoice_id=i.id) or not exists(select 1 from invoice_lines l where l.invoice_id=i.id)",
    enrollmentCounts: "select count(*) n from classes c where c.enrolled_count<>(select count(*) from enrollments e where e.class_id=c.id and e.status in ('confirmed','hold'))",
    futurePayments: "select count(*) n from payments where created_at>$1",
    refundSigns: "select count(*) n from payments where (ref_type like 'refund_%' or status in ('refund_pending','refund_rejected')) and amount_vnd>=0",
    memberOverlaps: "select count(*) n from court_bookings a join court_bookings b on a.id<b.id and a.user_id=b.user_id and a.start_at<b.end_at and b.start_at<a.end_at where a.status<>'cancelled' and b.status<>'cancelled'",
    memberClassOverlaps: "select count(*) n from court_bookings b join enrollments e on e.user_id=b.user_id and e.status='confirmed' join sessions s on s.class_id=e.class_id and b.start_at<s.end_at and s.start_at<b.end_at where b.status<>'cancelled' and s.status<>'cancelled'",
    wrongOccupancies: "select count(*) n from court_bookings b left join occupancies o on o.id=b.occupancy_id where (b.status in ('confirmed','in_use','hold') and (o.id is null or o.ref_id<>b.id or o.court_id<>b.court_id or o.start_at<>b.start_at or o.end_at<>b.end_at)) or (b.status in ('completed','cancelled','no_show') and b.occupancy_id is not null)",
    wrongSessionOccupancies: "select count(*) n from sessions s left join occupancies o on o.id=s.occupancy_id where (s.status='scheduled' and (o.id is null or o.ref_id<>s.id or o.court_id<>s.court_id or o.start_at<>s.start_at or o.end_at<>s.end_at or not exists(select 1 from coach_occupancies co join classes c on c.id=s.class_id where co.session_id=s.id and co.coach_id=c.coach_id and co.start_at=s.start_at and co.end_at=s.end_at))) or (s.status<>'scheduled' and s.occupancy_id is not null)",
    listPricing: "select count(*) n from court_bookings b join courts c on c.id=b.court_id where not exists(select 1 from subscriptions s where s.user_id=b.user_id and (b.start_at at time zone 'Asia/Ho_Chi_Minh')::date between s.start_on and s.end_on) and not exists(select 1 from price_rules r where r.sport=c.sport and (r.court_id is null or r.court_id=c.id) and r.day_kind=case when extract(isodow from b.start_at at time zone 'Asia/Ho_Chi_Minh') in (6,7) then 'weekend' else 'weekday' end and r.start_local<=(b.start_at at time zone 'Asia/Ho_Chi_Minh')::time and r.end_local>=(b.end_at at time zone 'Asia/Ho_Chi_Minh')::time and r.price_vnd=b.price_vnd)",
    dailyLimit: "select count(*) n from (select user_id,(start_at at time zone 'Asia/Ho_Chi_Minh')::date from court_bookings where user_id is not null group by 1,2 having count(*)>2) q",
    refundBalances: "select count(*) n from court_bookings b where (select sum(p.amount_vnd) from payments p where p.ref_type='booking' and p.ref_id=b.id and p.status='posted')<>case when b.status='cancelled' then 0 else b.price_vnd end",
    shiftBalances: "select count(*) n from cashier_shifts s where s.cash_declared_vnd<>coalesce((select sum(p.amount_vnd) from payments p where p.shift_id=s.id and p.status='posted' and p.method='cash'),0)",
    bookingWindow: "select count(*) n from court_bookings where start_at<'2026-09-01T00:00:00+07:00' or end_at>$1",
    paymentWindow: "select count(*) n from payments where created_at<'2026-09-01T00:00:00+07:00' or paid_at>$1 or paid_at<created_at",
    auditWindow: "select count(*) n from audit_logs where at<'2026-09-01T00:00:00+07:00' or at>$1",
    auditActors: "select count(*) n from audit_logs a left join users u on u.id=a.actor_id where u.id is null or (a.action in ('create_payment','refund','update_member','gate_checkin','ticket_reply','ticket_close') and u.role not in ('receptionist','manager')) or (a.action='patch_settings' and u.role<>'manager') or (a.action='coach_note' and u.role<>'coach') or (a.action in ('buy_subscription','renew_subscription','enroll_class') and u.role<>'member')",
    conversationRoles: "select count(*) n from conversations c join users m on m.id=c.member_id join users s on s.id=c.staff_id where m.role<>'member' or s.role not in ('coach','receptionist','manager')",
    messageParticipants: "select count(*) n from messages m join conversations c on c.id=m.conversation_id where m.sender_id not in(c.member_id,c.staff_id)",
    messageWindow: "select count(*) n from messages m join conversations c on c.id=m.conversation_id where m.created_at<'2026-09-01T00:00:00+07:00' or m.created_at>$1 or m.created_at<c.created_at or m.read_at<m.created_at or m.read_at>$1 or extract(hour from m.created_at at time zone 'Asia/Ho_Chi_Minh') not between 6 and 22",
    emptyConversations: "select count(*) n from conversations c where not exists(select 1 from messages m where m.conversation_id=c.id)",
    ticketWindow: "select count(*) n from tickets where created_at<'2026-09-01T00:00:00+07:00' or created_at>$1 or replied_at<created_at or replied_at>$1 or (reply is not null and (replied_at is null or replied_by is null or status<>'closed'))",
    notificationWindow: "select count(*) n from outbox where created_at<'2026-09-01T00:00:00+07:00' or created_at>$1 or sent_at<created_at or sent_at>$1 or read_at<sent_at or read_at>$1",
    promotionConsistency: "select count(*) n from promotion_redemptions r join payments p on p.id=r.payment_id join promotions o on o.id=r.promo_id where r.promo_id is distinct from p.promo_id or r.user_id is distinct from p.user_id or r.discount_vnd<>p.discount_vnd or r.created_at<>p.paid_at or r.created_at<o.starts_at or r.created_at>=o.ends_at or r.discount_vnd<=0",
    missingRedemptions: "select count(*) n from payments p where p.discount_vnd>0 and not exists(select 1 from promotion_redemptions r where r.payment_id=p.id)",
    gatewayCapture: "select count(*) n from payments where method='gateway' and (capture_mode<>'auto' or provider is distinct from 'payos' or provider_txn_id is null)",
    refundMethods: "select count(*) n from payments r where r.amount_vnd<0 and not exists(select 1 from payments p where p.ref_type=r.ref_type and p.ref_id=r.ref_id and p.amount_vnd=-r.amount_vnd and p.method=r.method and p.paid_at<r.paid_at)",
  };
  for (const [name, sql] of Object.entries(checks)) {
    const n = Number((await db.query(sql, sql.includes('$1') ? [asOf] : [])).rows[0].n);
    if (n) failures[name] = n;
    if (n && process.env.SEED_DEBUG) console.error(name, JSON.stringify((await db.query(sql.replace(/^select count\(\*\) n from/, 'select * from').replace(/$/, ' limit 3'), sql.includes('$1') ? [asOf] : [])).rows));
  }
  if (Object.keys(failures).length) throw new Error(`Seed invariant violations: ${JSON.stringify(failures)}`);
  return { checks: Object.keys(checks).length, failures };
}

export async function replaceActivity(db, asOf) {
  await db.exec('begin');
  try {
    // FIRST statement after BEGIN: never acquire read locks before this bulk lock.
    await db.exec(`lock table ${ACTIVITY.join(', ')}, users in access exclusive mode`);
    const before = await impact(db);
    await db.exec(`truncate table ${ACTIVITY.join(', ')} restart identity`);
    const result = await populate(db, asOf);
    const verification = await verify(db, asOf);
    const counts = {};
    for (const table of ['users', 'promotions', ...ACTIVITY])
      counts[table] = Number((await db.query(`select count(*) n from ${table}`)).rows[0].n);
    const octoberRevenueByWeekday = (await db.query(`with days as (
      select d::date as date_key from generate_series('2026-10-01'::date,'2026-10-31'::date,interval '1 day') d
      where d::date<=($1::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date
    ), daily as (
      select d.date_key, coalesce(sum(p.amount_vnd),0) revenue_vnd from days d left join payments p
        on (p.paid_at at time zone 'Asia/Ho_Chi_Minh')::date=d.date_key and p.status='posted' and p.method<>'quota'
      group by d.date_key
    ) select extract(isodow from date_key)::int weekday, to_char(date_key,'Dy') label,
      count(*)::int days, sum(revenue_vnd)::bigint total_vnd, round(avg(revenue_vnd))::bigint average_vnd
      from daily group by 1,2 order by 1`, [asOf])).rows;
    await db.exec('create table if not exists _lively_seed_state(id int primary key check(id=1), as_of timestamptz not null)');
    await db.query('insert into _lively_seed_state values(1,$1) on conflict(id) do update set as_of=excluded.as_of', [asOf]);
    await db.exec('commit');
    return { ...result, counts, octoberRevenueByWeekday, verification,
      replacedLocalActivity: before.existingActivity, preservedUsers: true, deletedUsers: 0,
      junkCandidatesForManualReview: before.reviewOnlyJunkCandidates };
  } catch (err) { await db.exec('rollback'); throw err; }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { apply: { type: 'boolean', default: false },
    'as-of': { type: 'string' }, 'data-dir': { type: 'string' }, help: { type: 'boolean' }, 'replace-remote': { type: 'string' } } });
  if (values.help) { console.log('node scripts/seed-lively.mjs [--apply] [--data-dir FRESH_DIR] [--as-of ISO_TIMESTAMP] [--replace-remote EXACT_HOST]\nDATABASE_URL selects pg; otherwise PGLITE_DATA_DIR selects PGlite. Remote targets are read-only unless --apply --replace-remote EXACT_HOST is explicit.'); return; }
  const url = process.env.DATABASE_URL?.trim();
  const dataDir = values['data-dir'] || process.env.PGLITE_DATA_DIR;
  const asOf = values['as-of'] || new Date().toISOString();
  if (!Number.isFinite(+new Date(asOf))) throw new Error('Invalid --as-of timestamp');
  if (values.apply) writableTarget(url, dataDir, values['replace-remote']);
  if (!url && !dataDir) throw new Error('Supply a dedicated PGLITE_DATA_DIR or DATABASE_URL. No implicit .pglite or dotenv fallback.');
  if (values.apply && !url) {
    // Do not even open an unrelated PGlite database. Ownership is a sidecar file.
    const entries = await readdir(dataDir).catch(err => { if (err.code === 'ENOENT') return []; throw err; });
    if (entries.length && !entries.includes('.arena3-lively-owner')) throw new Error('Refusing existing PGlite directory without lively ownership marker. Choose a fresh directory.');
    await prepareLocalDirectory(dataDir);
  }
  const db = await connect(url, dataDir);
  try {
    if (!values.apply) {
      await db.exec('begin read only');
      try { console.log(JSON.stringify({ mode: 'read-only-plan', ...await impact(db), proposed: `Up to 96 synthetic Vietnamese member accounts; regenerate activity from ${WINDOW_START} through --as-of. No future bookings or payments.` }, null, 2)); }
      finally { await db.exec('rollback'); }
      return;
    }
    if (url) {
      const owned = (await db.query("select to_regclass('public._lively_seed_state') as t")).rows[0].t;
      if (!owned) {
        const tables = (await db.query("select count(*) n from pg_tables where schemaname='public'")).rows[0].n;
        if (Number(tables) && !values['replace-remote']) throw new Error('Refusing existing PostgreSQL database without lively ownership. Use an empty local database or a read-only plan.');
        await migrate(db);
      }
    } else {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(resolve(dataDir, '.arena3-lively-owner'), VERSION);
      await migrate(db);
    }
    const result = await replaceActivity(db, asOf);
    console.log(JSON.stringify({ mode: url ? 'postgres-demo-applied' : 'local-demo-applied',
      asOf: result.asOf, from: result.from, through: result.through, counts: result.counts,
      octoberRevenueByWeekday: result.octoberRevenueByWeekday, verification: result.verification,
      preservedUsers: result.preservedUsers, deletedUsers: result.deletedUsers,
      junkCandidatesForManualReview: result.junkCandidatesForManualReview }, null, 2));
  } finally { await db.close(); }
}
if (isMainModule(import.meta.url)) main().catch(err => { console.error(`[seed-lively] ${err.message}`); process.exitCode = 1; });
