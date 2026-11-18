#!/usr/bin/env node
/**
 * Bộ dữ liệu mẫu đầy đủ cho cả trung tâm (dựng lại sạch từ đầu).
 *
 * Giữ: tài khoản gốc từ migration (id bắt đầu 00000000-0000-0000-0000-), gói tập, khuyến mãi,
 * cài đặt, ảnh trang. Xóa: mọi hoạt động và mọi tài khoản khác. Dựng lại: 6 môn, sân, bảng giá,
 * huấn luyện viên, lễ tân, ~32 lớp (6–9 học viên/lớp), hội viên, đặt sân, thanh toán, hóa đơn,
 * ca thu ngân, điểm danh, bảo trì sân, phiếu hỗ trợ, tin nhắn, nhật ký liên hệ, danh sách chờ, audit.
 * Hai lớp đang học có buổi sáng mai (07:00 và 08:00) để thử luồng điểm danh trực tiếp.
 *
 * Xem trước (chỉ đọc): DATABASE_URL=... node scripts/seed-fresh.mjs
 * PGlite mới:          node scripts/seed-fresh.mjs --apply --data-dir .cache/fresh
 * Neon (cố ý):         DATABASE_URL=... node scripts/seed-fresh.mjs --apply --replace-remote <host chính xác>
 * Dừng app trước khi seed thư mục PGlite của nó.
 */
import { createHash } from 'node:crypto';
import { readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ACTIVITY, migrate, normalize, prepareLocalDirectory, writableTarget } from './seed-lively.mjs';
import { isMainModule } from './with-app-env.mjs';

const DAY = 86400000;
const VERSION = 'arena3-fresh-v1';
export const WINDOW_START = '2026-08-01';
const KEEP = '00000000-0000-0000-0000-%';

export function id(key) {
  const h = createHash('sha256').update(`${VERSION}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function random(key) {
  return parseInt(createHash('sha256').update(id(key)).digest('hex').slice(0, 8), 16) / 0x100000000;
}
const pick = (list, key) => list[Math.floor(random(key) * list.length)];

async function connect(databaseUrl, dataDir) {
  if (databaseUrl) {
    const { default: pg } = await import('pg');
    const db = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 15000 });
    await db.connect();
    return { query: (s, p = []) => db.query(s, p), exec: s => db.query(s), close: () => db.end() };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite({ dataDir, parsers: { 1082: s => s, 20: Number } });
  await db.waitReady;
  return db;
}

async function insertRows(db, table, rows) {
  if (!rows.length) return;
  const keys = [...new Set(rows.flatMap(r => Object.keys(r)))];
  for (let offset = 0; offset < rows.length; offset += 150) {
    const params = [];
    const values = rows.slice(offset, offset + 150).map(row => `(${keys.map(k => {
      const v = row[k] === undefined ? null : row[k];
      params.push(v != null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v);
      return `$${params.length}`;
    }).join(',')})`);
    await db.query(`insert into ${table} (${keys.map(k => `"${k}"`).join(',')}) values ${values.join(',')}`, params);
  }
}

// ---------------------------------------------------------------- catalogue
const SPORTS = [
  { code: 'badminton', name_en: 'Badminton', name_vi: 'Cầu lông', prefix: 'CL', color: 'leaf', max: 4, courts: 12, prices: [80000, 140000], tuition: 1200000 },
  { code: 'basketball', name_en: 'Basketball', name_vi: 'Bóng rổ', prefix: 'BR', color: 'clay', max: 10, courts: 2, prices: [300000, 500000], tuition: 1500000 },
  { code: 'volleyball', name_en: 'Volleyball', name_vi: 'Bóng chuyền', prefix: 'BC', color: 'sun', max: 12, courts: 2, prices: [250000, 400000], tuition: 1400000 },
  { code: 'pickleball', name_en: 'Pickleball', name_vi: 'Pickleball', prefix: 'PB', color: 'sky', max: 4, courts: 4, prices: [120000, 180000], tuition: 1300000 },
  { code: 'tennis', name_en: 'Tennis', name_vi: 'Quần vợt', prefix: 'TN', color: 'plum', max: 4, courts: 3, prices: [200000, 300000], tuition: 1800000 },
  { code: 'table_tennis', name_en: 'Table tennis', name_vi: 'Bóng bàn', prefix: 'BB', color: 'moss', max: 4, courts: 6, prices: [50000, 80000], tuition: 900000 },
];
// Sân để trống lịch tương lai vì đang bảo trì.
const MAINTENANCE = ['CL-12', 'BB-06'];

const NEW_STAFF = [
  { key: 'tung', name: 'Võ Thanh Tùng', role: 'coach', email: 'tung.hlv@arena3.local', sport: 'basketball' },
  { key: 'giabao', name: 'Hoàng Gia Bảo', role: 'coach', email: 'giabao.hlv@arena3.local', sport: 'volleyball' },
  { key: 'phuong', name: 'Đặng Thu Phương', role: 'coach', email: 'phuong.hlv@arena3.local', sport: 'pickleball' },
  { key: 'nam', name: 'Bùi Hoàng Nam', role: 'coach', email: 'nam.hlv@arena3.local', sport: 'tennis' },
  { key: 'linh', name: 'Ngô Mỹ Linh', role: 'coach', email: 'linh.hlv@arena3.local', sport: 'tennis' },
  { key: 'hai', name: 'Trương Văn Hải', role: 'coach', email: 'hai.hlv@arena3.local', sport: 'table_tennis' },
  { key: 'han', name: 'Lý Ngọc Hân', role: 'coach', email: 'han.hlv@arena3.local', sport: 'table_tennis' },
  { key: 'mai', name: 'Phan Thị Mai', role: 'receptionist', email: 'mai.letan@arena3.local' },
];
// Huấn luyện viên có sẵn từ migration, theo số cuối của id.
const COACH_SPORT = { '011': 'badminton', '012': 'badminton', '013': 'basketball', '014': 'volleyball', '003': 'pickleball' };

const MALE = ['An', 'Bình', 'Cường', 'Duy', 'Đạt', 'Hiếu', 'Hùng', 'Huy', 'Khang', 'Khôi', 'Kiên', 'Lâm', 'Long', 'Lộc', 'Minh', 'Nam', 'Nghĩa', 'Phát', 'Phong', 'Quân', 'Sơn', 'Tài', 'Thắng', 'Thịnh', 'Toàn', 'Trí', 'Trung', 'Tuấn', 'Việt', 'Vinh'];
const FEMALE = ['Anh', 'Châu', 'Chi', 'Dung', 'Giang', 'Hà', 'Hạnh', 'Hằng', 'Hương', 'Lan', 'Linh', 'Mai', 'My', 'Ngân', 'Ngọc', 'Nhi', 'Nhung', 'Oanh', 'Phương', 'Quyên', 'Quỳnh', 'Tâm', 'Thảo', 'Thư', 'Trâm', 'Trang', 'Uyên', 'Vân', 'Vy', 'Yến'];
const MALE_MID = ['Văn', 'Minh', 'Đức', 'Quốc', 'Hoàng', 'Thanh', 'Gia', 'Hữu', 'Công', 'Tuấn'];
const FEMALE_MID = ['Thị', 'Ngọc', 'Thu', 'Thanh', 'Bảo', 'Minh', 'Phương', 'Kim', 'Hồng', 'Mỹ'];
const SURNAMES = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Huỳnh', 'Phan', 'Vũ', 'Võ', 'Đặng', 'Bùi', 'Đỗ', 'Hồ', 'Ngô', 'Dương', 'Lý', 'Trương', 'Đinh', 'Mai', 'Tạ'];

// Days, hour, opening date, weeks, level, audience/course title.
const COURSES = {
  badminton: [
    ['MO,WE', 19, '2026-08-03', 8, 'beginner', 'Người lớn nhập môn'],
    ['MO,WE,FR', 20, '2026-08-31', 16, 'advanced', 'Đội tuyển phong trào'],
    ['SA,SU', 9, '2026-09-19', 12, 'beginner', 'Gia đình cuối tuần'],
    ['TU,FR', 19, '2026-10-06', 12, 'intermediate', 'Đánh đôi công sở'],
    ['WE,SA', 18, '2026-11-04', 8, 'intermediate', 'Nữ phong trào'],
    ['TU,TH', 7, '2026-09-22', 16, 'beginner', 'Cầu lông ban mai'],
  ],
  basketball: [
    ['TU,TH', 17, '2026-08-04', 8, 'beginner', 'Thiếu nhi 9–12 tuổi'],
    ['MO,WE,FR', 18, '2026-08-24', 16, 'intermediate', 'Thiếu niên 13–16 tuổi'],
    ['SA,SU', 10, '2026-09-12', 12, 'beginner', 'Gia đình cùng bóng rổ'],
    ['TU,TH,SA', 19, '2026-10-13', 12, 'advanced', 'Chuẩn bị giải 3x3'],
    ['MO,FR', 17, '2026-11-23', 8, 'beginner', 'Thiếu nhi khóa mùa đông'],
  ],
  volleyball: [
    ['MO,TH', 20, '2026-08-10', 8, 'beginner', 'Công sở nhập môn'],
    ['TU,WE,FR', 19, '2026-08-25', 16, 'advanced', 'Đội tuyển doanh nghiệp'],
    ['WE,FR', 20, '2026-09-16', 12, 'intermediate', 'Bóng chuyền nữ'],
    ['SA,SU', 8, '2026-10-03', 8, 'beginner', 'Nhóm bạn cuối tuần'],
    ['TU,TH', 21, '2026-11-03', 12, 'intermediate', 'Phối hợp đội hình'],
  ],
  pickleball: [
    ['MO,WE,FR', 6, '2026-08-03', 8, 'beginner', 'Khởi động ngày mới'],
    ['TU,FR', 6, '2026-08-25', 16, 'intermediate', 'Đánh đôi buổi sớm'],
    ['SA,SU', 7, '2026-09-05', 12, 'beginner', 'Gia đình làm quen sân'],
    ['MO,TH', 18, '2026-09-28', 12, 'intermediate', 'Chiến thuật vùng bếp'],
    ['WE,FR,SU', 19, '2026-10-21', 8, 'advanced', 'Chuẩn bị giải đôi'],
    ['TU,TH', 20, '2026-12-01', 8, 'beginner', 'Công sở khóa tháng mười hai'],
  ],
  tennis: [
    ['MO,FR', 6, '2026-08-07', 8, 'beginner', 'Quần vợt người lớn'],
    ['WE,SA', 6, '2026-08-26', 16, 'intermediate', 'Giao bóng buổi sớm'],
    ['SA,SU', 9, '2026-09-26', 12, 'beginner', 'Gia đình cuối tuần'],
    ['MO,WE,FR', 19, '2026-10-05', 12, 'advanced', 'Luyện giải đơn'],
    ['TU,TH', 8, '2026-10-06', 12, 'beginner', 'Quần vợt ban mai'],
  ],
  table_tennis: [
    ['MO,WE', 17, '2026-08-03', 8, 'beginner', 'Thiếu nhi 8–11 tuổi'],
    ['TU,TH,FR', 18, '2026-08-25', 16, 'intermediate', 'Thiếu niên 12–16 tuổi'],
    ['SA,SU', 10, '2026-09-19', 12, 'beginner', 'Cha mẹ và con'],
    ['MO,WE,FR', 20, '2026-10-12', 12, 'advanced', 'Đội tuyển bóng bàn'],
    ['TU,SA', 17, '2026-11-03', 8, 'beginner', 'Thiếu nhi sau giờ học'],
  ],
};
const DOW = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const LEVEL_VI = { beginner: 'Cơ bản', intermediate: 'Trung cấp', advanced: 'Nâng cao' };

// ---------------------------------------------------------------- wipe
export async function wipe(db) {
  const keepIds = (await db.query(`select id from users where id::text like '${KEEP}'`)).rows.map(r => r.id);
  await db.exec(`truncate table ${ACTIVITY.join(', ')} restart identity`);
  // Mọi khóa ngoại khác trỏ tới users: cột cho phép null thì gỡ, không thì xóa dòng.
  const fks = (await db.query(`select c.conrelid::regclass::text as tbl, a.attname as col, a.attnotnull as notnull
    from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey)
    where c.contype='f' and c.confrelid='users'::regclass`)).rows;
  for (const fk of fks) {
    if (ACTIVITY.includes(fk.tbl) || fk.tbl === 'users') continue;
    const where = `"${fk.col}" is not null and "${fk.col}"::text not like '${KEEP}'`;
    if (fk.notnull) await db.exec(`delete from ${fk.tbl} where ${where}`);
    else await db.exec(`update ${fk.tbl} set "${fk.col}"=null where ${where}`);
  }
  await db.exec(`delete from users where id::text not like '${KEEP}'`);
  // Sân thử nghiệm và bảng giá riêng từng sân (giá thử 2.000đ) không thuộc bộ dữ liệu thật.
  const strayCourts = `select id from courts where court_code !~ '^(CL|BR|BC|PB|TN|BB)-[0-9]{2}$'`;
  const courtFks = (await db.query(`select c.conrelid::regclass::text as tbl, a.attname as col, a.attnotnull as notnull
    from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=any(c.conkey)
    where c.contype='f' and c.confrelid='courts'::regclass`)).rows;
  for (const fk of courtFks) {
    if (fk.notnull) await db.exec(`delete from ${fk.tbl} where "${fk.col}" in (${strayCourts})`);
    else await db.exec(`update ${fk.tbl} set "${fk.col}"=null where "${fk.col}" in (${strayCourts})`);
  }
  await db.exec(`delete from courts where id in (${strayCourts})`);
  await db.exec('delete from price_rules where court_id is not null');
  return keepIds.length;
}

// ---------------------------------------------------------------- populate
export async function populate(db, asOf) {
  const now = new Date(asOf);
  const today = new Date(+now + 7 * 3600000).toISOString().slice(0, 10);
  const day = n => new Date(Date.parse(`${today}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
  const off = date => Math.round((Date.parse(date) - Date.parse(today)) / DAY);
  const at = (n, h, m = 0) => new Date(`${day(n)}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+07:00`);
  const atDate = (date, h, m = 0) => new Date(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+07:00`);
  const localDate = t => new Date(+t + 7 * 3600000).toISOString().slice(0, 10);
  const ymd = t => localDate(t).replace(/-/g, '');
  const dow = date => new Date(`${date}T12:00:00Z`).getUTCDay();
  const first = off(WINDOW_START);
  if (first > -60) throw new Error('--as-of must be at least two months after the window start');

  const rows = {};
  const add = (table, row) => { (rows[table] ??= []).push(row); return row; };
  const audit = (time, actor, action, entity, entityId, after = {}, before = null) => {
    if (+time > +now) return;
    add('audit_logs', { at: time, actor_id: actor.id, action, entity, entity_id: entityId, before, after });
  };
  const counters = new Map();
  const code = (kind, time) => {
    const k = `${kind}:${ymd(time)}`;
    const n = (counters.get(k) || 0) + 1;
    counters.set(k, n);
    return `${kind}-${ymd(time)}-${String(n).padStart(4, '0')}`;
  };

  const settings = (await db.query('select * from center_settings where id=1')).rows[0];
  const vat = Number(settings.vat_rate);
  const memberFee = Number(settings.member_court_fee_vnd);
  const plans = Object.fromEntries((await db.query(
    'select * from membership_plans where is_on_sale and duration_months in (1,3,6,12)')).rows.map(p => [p.duration_months, p]));
  if (Object.keys(plans).length !== 4) throw new Error('Expected the four 1/3/6/12-month plans on sale');

  // ---- sports, courts, prices
  for (const [i, s] of SPORTS.entries()) {
    await db.query(`insert into sports (code,name_en,name_vi,court_prefix,color_key,glyph_key,is_scope_all,max_players,slot_duration_min,sort_order,enabled,retired_at)
      values ($1,$2,$3,$4,$5,$6,false,$7,60,$8,true,null)
      on conflict (code) do update set name_en=excluded.name_en, name_vi=excluded.name_vi, court_prefix=excluded.court_prefix,
        color_key=excluded.color_key, max_players=excluded.max_players, slot_duration_min=60, sort_order=excluded.sort_order, enabled=true, retired_at=null`,
      [s.code, s.name_en, s.name_vi, s.prefix, s.color, ['badminton', 'basketball', 'volleyball'].includes(s.code) ? s.code : 'generic', s.max, (i + 1) * 10]);
    for (let c = 1; c <= s.courts; c++) {
      const courtCode = `${s.prefix}-${String(c).padStart(2, '0')}`;
      await db.query(`insert into courts (id,court_code,sport,status,retired_at,sort_order) values ($1,$2,$3,'ready',null,$4)
        on conflict (court_code) do update set sport=excluded.sport, status='ready', retired_at=null, sort_order=excluded.sort_order`,
        [id(`court:${courtCode}`), courtCode, s.code, (i + 1) * 100 + c]);
    }
    await db.query('delete from price_rules where sport=$1', [s.code]);
    const [low, peak] = s.prices;
    for (const [kind, split] of [['weekday', '17:00'], ['weekend', '08:00'], ['holiday', '08:00']]) {
      await db.query(`insert into price_rules (sport,court_id,day_kind,start_local,end_local,price_vnd,is_peak) values
        ($1,null,$2,'06:00',$3,$4,false), ($1,null,$2,$3,'22:00',$5,true)`, [s.code, kind, split, low, peak]);
    }
  }
  const courts = (await db.query("select * from courts where retired_at is null and court_code ~ '^(CL|BR|BC|PB|TN|BB)-[0-9]{2}$' order by court_code")).rows;
  const courtBy = Object.fromEntries(courts.map(c => [c.court_code, c]));
  const rules = (await db.query('select * from price_rules where court_id is null')).rows;
  const listPrice = (court, start) => {
    const kind = [0, 6].includes(new Date(+start + 7 * 3600000).getUTCDay()) ? 'weekend' : 'weekday';
    const h = new Date(+start + 7 * 3600000).getUTCHours();
    const r = rules.find(x => x.sport === court.sport && x.day_kind === kind && x.start_min <= h * 60 && x.end_min >= (h + 1) * 60);
    if (!r) throw new Error(`No price for ${court.court_code} ${kind} ${h}h`);
    return r.price_vnd;
  };

  // ---- staff
  const users = (await db.query('select * from users order by id')).rows;
  const byTail = tail => users.find(u => u.id.endsWith(tail));
  const manager = byTail('0001');
  const coachHash = byTail('0003').password_hash;
  const deskHash = byTail('0002').password_hash;
  const memberHash = byTail('0004').password_hash;
  const staffCreated = atDate('2026-07-20', 9);
  for (const [i, s] of NEW_STAFF.entries()) {
    const u = add('users', { id: id(`staff:${s.key}`), full_name: s.name, name_normalized: normalize(s.name),
      phone: `+8490111${String(2100 + i).padStart(4, '0')}`, email: s.email, role: s.role, status: 'active',
      password_hash: s.role === 'coach' ? coachHash : deskHash, created_at: staffCreated, pii_consent_at: staffCreated,
      date_of_birth: `${1986 + i}-0${1 + i % 9}-1${i % 9}` });
    users.push({ ...u, sport: s.sport });
    audit(staffCreated, manager, 'create_staff', 'user', u.id, { role: s.role, full_name: s.name });
  }
  const desks = users.filter(u => u.role === 'receptionist').sort((a, b) => a.id.localeCompare(b.id));
  const coaches = users.filter(u => u.role === 'coach');
  for (const c of coaches) c.sport ??= COACH_SPORT[c.id.slice(-3)];
  const unassigned = coaches.filter(c => !c.sport);
  if (unassigned.length) throw new Error(`Coach without a sport: ${unassigned.map(c => c.full_name).join(', ')}`);
  const coachesOf = sport => coaches.filter(c => c.sport === sport).sort((a, b) => a.id.localeCompare(b.id));
  const findCoach = name => coaches.find(c => c.full_name === name);
  await db.exec('delete from coach_sports');
  await db.exec('delete from coach_rates');
  for (const c of coaches) {
    add('coach_sports', { user_id: c.id, sport: c.sport });
    add('coach_rates', { coach_id: c.id, per_session_vnd: 250000 + (c.id.charCodeAt(9) % 4) * 25000, per_student_vnd: 15000, updated_at: atDate('2026-08-01', 9) });
    audit(atDate('2026-08-01', 9), manager, 'set_coach_rate', 'user', c.id, { per_student_vnd: 15000 });
  }

  // ---- payments
  const shifts = new Map();
  let payN = 0;
  const saleInvoice = new Map();
  const deskFor = date => desks[Math.abs(off(date)) % desks.length];
  function payment(refType, refId, user, amount, time, label, { method = null, unit = 'gói' } = {}) {
    if (+time > +now) throw new Error(`Payment in the future: ${label}`);
    const n = ++payN;
    const date = localDate(time);
    const shiftStart = atDate(date, 5), shiftEnd = atDate(date, 22, 30);
    const atDesk = +time >= +shiftStart && +time <= +shiftEnd;
    const desk = deskFor(date);
    if (atDesk && !shifts.has(date)) shifts.set(date, add('cashier_shifts', { id: id(`shift:${date}`), receptionist_id: desk.id,
      opened_at: shiftStart, closed_at: +shiftEnd <= +now ? shiftEnd : null, cash_declared_vnd: 0 }));
    const shift = atDesk ? shifts.get(date) : null;
    const m = method || (shift ? ['cash', 'transfer', 'card', 'gateway', 'cash'][n % 5] : 'gateway');
    if (shift && m === 'cash') shift.cash_declared_vnd += amount;
    const pid = id(`payment:${n}`);
    const p = add('payments', { id: pid, code: code('PAY', time), user_id: user?.id ?? null, shift_id: shift?.id ?? null,
      method: m, amount_vnd: amount, vat_rate: vat, status: 'posted', ref_type: refType, ref_id: refId,
      created_by: m === 'gateway' && !shift ? null : desk.id, created_at: time, paid_at: time,
      capture_mode: m === 'gateway' ? 'auto' : 'manual', provider: m === 'gateway' ? 'payos' : null,
      provider_txn_id: m === 'gateway' ? `FT${ymd(time)}${String(n).padStart(6, '0')}` : null, discount_vnd: 0 });
    const net = Math.round(amount / (1 + vat / 100));
    // A refund gets an adjustment invoice (hóa đơn điều chỉnh giảm) tied to the sale it reduces, as the desk issues it.
    const adjusts = amount < 0 ? saleInvoice.get(`${refType}:${refId}`) ?? null : null;
    const inv = add('invoices', { id: id(`invoice:${n}`), code: code('INV', time), payment_id: pid,
      kind: amount < 0 ? 'adjustment' : 'sale', adjusts_invoice_id: adjusts,
      buyer_name: user?.full_name ?? label.guest ?? 'Khách lẻ', buyer_phone: user?.phone ?? null, issued_at: time, form_no: '1',
      serial_no: `C${String(new Date(time).getUTCFullYear()).slice(2)}TAA`, seller_legal_name: settings.legal_name,
      seller_tax_code: settings.tax_code, seller_address: settings.address,
      subtotal_vnd: net, vat_rate: vat, vat_vnd: amount - net, total_vnd: amount });
    if (amount > 0) saleInvoice.set(`${refType}:${refId}`, inv.id);
    add('invoice_lines', { id: id(`line:${n}`), invoice_id: inv.id, description: amount < 0 && !String(label.text ?? label).startsWith('Hoàn') ? `Hoàn tiền ${label.text ?? label}` : label.text ?? label, qty: 1, unit,
      unit_vnd: amount, amount_vnd: amount });
    if (user && amount > 0) add('outbox', { id: id(`receipt:${pid}`), channel: 'inapp', template: 'payment_receipt', user_id: user.id,
      payload: { payment_id: pid, invoice_id: inv.id, amount_vnd: amount, method: m }, dedupe_key: `receipt:${pid}`,
      created_at: time, sent_at: time, read_at: n % 4 && +time + 40 * 60000 <= +now ? new Date(+time + 40 * 60000) : null });
    const actor = shift ? desk : user || manager;
    if (shift || amount < 0) audit(time, shift ? desk : manager, amount < 0 ? 'refund' : 'create_payment', 'payment', pid, { ref_type: refType, amount_vnd: amount, method: m });
    else audit(time, actor, 'online_paid', 'payment', pid, { ref_type: refType, amount_vnd: amount, provider: 'payos' });
    if (m === 'transfer' && amount > 0) audit(new Date(+time + 60000), desk, 'transfer_confirm', 'payment', pid, { amount_vnd: amount });
    return p;
  }

  // ---- members
  const usedNames = new Set(users.map(u => u.full_name));
  const usedPhones = new Set(users.map(u => u.phone));
  let nameSeed = 0;
  const makeName = (femaleOnly = false) => {
    for (;;) {
      const k = nameSeed++;
      const female = femaleOnly || random(`gender:${k}`) < 0.5;
      const name = `${pick(SURNAMES, `sur:${k}`)} ${pick(female ? FEMALE_MID : MALE_MID, `mid:${k}`)} ${pick(female ? FEMALE : MALE, `given:${k}`)}`;
      if (!usedNames.has(name)) { usedNames.add(name); return name; }
    }
  };
  const emailOf = (name, n) => {
    const parts = normalize(name).split(' ');
    return `${parts.slice(1).join('')}.${parts[0]}${n % 97}@example.com`;
  };
  let memberN = 100;
  const newMember = (key, joined, femaleOnly = false) => {
    const name = makeName(femaleOnly);
    const n = ++memberN;
    let phone;
    for (let k = 0; ; k++) { phone = `+849${String(Math.floor(random(`phone:${key}:${k}`) * 1e8)).padStart(8, '0')}`; if (!usedPhones.has(phone)) break; }
    usedPhones.add(phone);
    const u = add('users', { id: id(`member:${key}`), member_code: `A3-2026-${String(n).padStart(4, '0')}`, full_name: name,
      name_normalized: normalize(name), phone, email: emailOf(name, n), role: 'member', status: 'active', password_hash: memberHash,
      date_of_birth: `${1978 + Math.floor(random(`dob:${key}`) * 28)}-${String(1 + Math.floor(random(`dobm:${key}`) * 12)).padStart(2, '0')}-${String(1 + Math.floor(random(`dobd:${key}`) * 28)).padStart(2, '0')}`,
      pii_consent_at: joined, created_at: joined });
    audit(joined, deskFor(localDate(joined)), 'create_member', 'user', u.id, { member_code: u.member_code });
    return u;
  };
  const existingMembers = users.filter(u => u.role === 'member').sort((a, b) => a.id.localeCompare(b.id));
  const subs = [];
  const endOf = (start, months) => {
    const d = new Date(`${start}T00:00:00Z`);
    const target = d.getUTCMonth() + months;
    const last = new Date(Date.UTC(d.getUTCFullYear(), target + 1, 0)).getUTCDate();
    return new Date(Date.UTC(d.getUTCFullYear(), target, Math.min(d.getUTCDate(), last)) - DAY).toISOString().slice(0, 10);
  };
  const buy = (user, months, start, hour = 9) => {
    const plan = plans[months];
    const end = endOf(start, months);
    const s = add('subscriptions', { id: id(`sub:${user.id}:${start}`), user_id: user.id, plan_id: plan.id, start_on: start, end_on: end,
      status: end < today ? 'expired' : 'active', price_vnd: plan.price_vnd, promo_discount_vnd: 0 });
    subs.push(s);
    const paidAt = atDate(start, hour, Math.floor(random(`buy:${s.id}`) * 50));
    payment('subscription', s.id, user, plan.price_vnd, +paidAt > +now ? new Date(+now - 3600000) : paidAt, `Gói hội viên ${months} tháng`);
    return s;
  };
  const covered = (userId, date) => subs.some(s => s.user_id === userId && s.start_on <= date && s.end_on >= date && s.status !== 'pending');

  // ---- classes
  const classes = [];
  const plan = [];
  for (const s of SPORTS) {
    const pool = courts.filter(c => c.sport === s.code && !MAINTENANCE.includes(c.court_code));
    for (const [k, [days, hour, start_on, weeks, level, title]] of COURSES[s.code].entries()) {
      const morning = (s.code === 'badminton' && hour === 7) || (s.code === 'tennis' && hour === 8);
      plan.push({ sport: s, k, slot: { days: days.split(','), hour },
        coach: morning ? findCoach(s.code === 'badminton' ? 'Trần Thị Lan' : 'Ngô Mỹ Linh') : coachesOf(s.code)[k % 2],
        court: morning ? courtBy[s.code === 'badminton' ? 'CL-05' : 'TN-01'] : pool[k % pool.length],
        level, title, start_on, end_on: day(off(start_on) + weeks * 7 - 1), fresh: start_on > today });
    }
  }
  if (plan.some(p => !p.coach || !p.court)) throw new Error('Class plan is missing a coach or a court');

  const busy = new Set();
  const courtBusy = new Set();
  const key = (who, t) => `${who}:${+t}`;
  const sessionsOf = new Map();
  let joinSeq = 0;
  let existingIdx = 0;
  const descriptions = {
    badminton: ['Cầm vợt, bước chân và các cú đánh cơ bản; cuối khóa đánh được đôi nam nữ.', 'Khởi động; cầm vợt; bước chân; phông cầu và đập cầu; thi đấu đôi; giãn cơ.'],
    basketball: ['Dẫn bóng, chuyền bóng và ném rổ; làm quen chiến thuật 3x3 và 5x5.', 'Khởi động; dẫn bóng; chuyền bắt; ném rổ tại chỗ và lên rổ; chiến thuật; đấu tập.'],
    volleyball: ['Đệm, chuyền, phát bóng và phối hợp đội hình sáu người.', 'Khởi động; đệm bóng; chuyền hai; phát bóng; đập bóng; đấu tập theo đội.'],
    pickleball: ['Luật chơi, giao bóng, cú dink ở vùng bếp và đánh đôi.', 'Khởi động; giao bóng; trả giao; dink; volley; đánh đôi có tính điểm.'],
    tennis: ['Thuận tay, trái tay, giao bóng và di chuyển trên sân cứng.', 'Khởi động; thuận tay; trái tay; giao bóng; lên lưới; đánh điểm.'],
    table_tennis: ['Cầm vợt, giật bóng thuận tay, phòng thủ và giao bóng xoáy.', 'Khởi động; cầm vợt; đánh thuận tay; trái tay; giao bóng xoáy; đấu tập.'],
  };
  for (const [ci, p] of plan.entries()) {
    const s = p.sport;
    const size = p.fresh ? 9 : 6 + Math.floor(random(`size:${ci}`) * 4);
    const full = ci === 2 || ci === 12;
    const nearlyFull = ci === 7;
    const capacity = full ? size : nearlyFull ? size + 1 : Math.max(10, size + 2);
    const price = s.tuition + (p.level === 'advanced' ? 300000 : p.level === 'intermediate' ? 150000 : 0);
    const cls = { id: id(`class:${s.code}:${p.k}`), sport: s.code, level: p.level, coach_id: p.coach.id, court_id: p.court.id,
      capacity, enrolled_count: size, rrule: `FREQ=WEEKLY;BYDAY=${p.slot.days.join(',')};BYHOUR=${p.slot.hour}`, duration_min: 60,
      start_on: p.start_on, end_on: p.end_on, status: p.end_on < today ? 'closed' : 'open', price_vnd: price, min_enrolled: 4,
      description: `${p.title}. ${descriptions[s.code][0]}`, syllabus: descriptions[s.code][1],
      who_for: `${p.title} — ${LEVEL_VI[p.level]}.`,
      bring: 'Giày thể thao đế mềm, nước uống, khăn; dụng cụ có thể thuê tại quầy.' };
    add('classes', cls);
    classes.push({ ...cls, plan: p, roster: [] });
    const created = at(Math.max(first - 10, Math.min(off(p.start_on) - 14, -12)), 10);
    audit(created, manager, 'create_class', 'class', cls.id, { sport: s.code, level: p.level, rrule: cls.rrule });
    const cl = classes[classes.length - 1];
    for (let j = 0; j < size; j++) {
      // Membership precedes the course; the last two students enrol during it.
      const start = day(Math.max(first, Math.min(off(p.start_on) - 3 - j % 7, -14 + j)));
      const enrolDay = day(Math.min(-1, p.fresh ? off(start) + Math.floor(j / 2) : Math.max(off(start), off(p.start_on) + (j >= size - 2 ? 7 + (j % 3) * 7 : -3 + j % 3))));
      const enrolAt = atDate(enrolDay, 10, 5 + j * 4);
      let u;
      if (existingIdx < existingMembers.length) {
        u = existingMembers[existingIdx++];
        u.created_at = atDate(start, 8, 30);
      } else u = newMember(`class:${joinSeq++}`, atDate(start, 8, j * 5), /nữ/i.test(p.title));
      if (/Thiếu nhi/.test(p.title)) u.date_of_birth = `${(s.code === 'table_tennis' ? 2015 : 2014) + j % 3}-05-12`;
      else if (/Thiếu niên/.test(p.title)) u.date_of_birth = `${2010 + j % 4}-09-08`;
      buy(u, random(`len:${u.id}`) < 0.35 ? 12 : 6, start);
      const dropout = !p.fresh && p.end_on >= today && off(p.start_on) < -42 && p.k === 1 && ['badminton', 'basketball', 'pickleball'].includes(s.code) && j === size - 1 && size > 6;
      const pending = p.fresh && j >= size - 2;
      const overdue = pending && j === size - 2;
      const leftAt = dropout ? at(-18, 12) : null;
      const e = add('enrollments', { id: id(`enroll:${cls.id}:${u.id}`), class_id: cls.id, user_id: u.id,
        status: dropout ? 'cancelled' : pending ? 'hold' : 'confirmed',
        hold_until: pending ? new Date(+now + (overdue ? -120 : 120) * 60000) : null,
        transfer_requested_at: pending ? new Date(+now - 20 * 60000) : null,
        prepaid_sessions: 0, price_vnd: price, extension_vnd: 0, promo_discount_vnd: 0 });
      if (dropout) { cls.enrolled_count--; cl.enrolled_count--; }
      if (!pending) payment('enrollment', e.id, u, price, enrolAt, `Học phí ${p.title} — ${s.name_vi}`, { unit: 'khóa' });
      audit(enrolAt, deskFor(enrolDay), 'enroll_class', 'enrollment', e.id, { class_id: cls.id, status: pending ? 'hold' : 'confirmed' });
      if (leftAt) audit(leftAt, deskFor(localDate(leftAt)), 'cancel_enrollment', 'enrollment', e.id, { reason: 'Đổi lịch làm việc, dừng học giữa khóa' });
      u.enrolledAt = enrolAt;
      u.leftAt = leftAt;
      u.pending = pending;
      add('member_levels', { user_id: u.id, sport: s.code, level: p.level, assessed_by: p.coach.id, updated_at: enrolAt });
      if (!rows.training_profiles?.some(t => t.user_id === u.id))
        add('training_profiles', { user_id: u.id, goal: ['technique', 'fun', 'weight', 'compete'][j % 4], updated_at: enrolAt });
      cl.roster.push(u);
    }
    // Lịch buổi học.
    const list = [];
    for (let n = off(p.start_on); n <= off(p.end_on); n++) {
      if (!p.slot.days.includes(DOW[dow(day(n))])) continue;
      const start = at(n, p.slot.hour), end = at(n, p.slot.hour + 1);
      const sid = id(`session:${cls.id}:${day(n)}`);
      const done = +end <= +now;
      if (+start <= +now && !done) continue;
      const ses = { id: sid, class_id: cls.id, court_id: p.court.id, start_at: start, end_at: end, status: done ? 'done' : 'scheduled', occupancy_id: null };
      if (!done) {
        const occ = add('occupancies', { id: id(`occ:${sid}`), court_id: p.court.id, start_at: start, end_at: end, kind: 'session', ref_id: sid });
        ses.occupancy_id = occ.id;
      }
      add('sessions', ses);
      add('coach_occupancies', { id: id(`coach-occ:${sid}`), coach_id: p.coach.id, session_id: sid, start_at: start, end_at: end });
      if (busy.has(key(p.coach.id, start))) throw new Error(`Coach clash ${p.coach.full_name} ${day(n)} ${p.slot.hour}h`);
      busy.add(key(p.coach.id, start));
      if (courtBusy.has(key(p.court.id, start))) throw new Error(`Court clash ${p.court.court_code} ${day(n)}`);
      courtBusy.add(key(p.court.id, start));
      // Reserve the whole course for confirmed members, matching verify() and app booking rules.
      for (const u of cl.roster) busy.add(key(u.id, start));
      list.push(ses);
    }
    sessionsOf.set(cls.id, list);
  }

  // ---- waitlist on the two full classes, an open offer on the nearly full one
  const courtOnly = [];
  for (let i = 0; i < 48; i++) {
    const start = day(first + 10 + Math.floor(random(`co:${i}`) * (-first - 12)));
    courtOnly.push({ user: newMember(`court:${i}`, atDate(start, 17, Math.floor(random(`com:${i}`) * 50))), start });
  }
  for (const [i, { user, start }] of courtOnly.entries()) {
    let s = start;
    const months = i % 6 === 0 ? 3 : 1;
    const stopAfter = i % 5 === 0 ? 1 : 9;
    for (let r = 0; r < stopAfter && s <= today; r++) {
      const sub = buy(user, months, s, 17);
      s = day(off(sub.end_on) + 1);
    }
  }
  const waitPool = courtOnly.map(c => c.user).filter(u => subs.some(s => s.user_id === u.id && s.status === 'active' && s.end_on > '2026-12-20'));
  let w = 0;
  for (const cl of classes.filter((c, i) => i === 2 || i === 12 || i === 7)) {
    const count = cl.capacity === cl.enrolled_count ? 2 : 1;
    for (let pos = 1; pos <= count && w < waitPool.length; pos++, w++) {
      const u = waitPool[w];
      const e = add('enrollments', { id: id(`wait:${cl.id}:${u.id}`), class_id: cl.id, user_id: u.id, status: 'waitlisted', waitlist_pos: pos,
        prepaid_sessions: 0, price_vnd: cl.price_vnd, extension_vnd: 0, promo_discount_vnd: 0 });
      if (cl.capacity > cl.enrolled_count) add('waitlist_offers', { id: id(`offer:${e.id}`), enrollment_id: e.id, expires_at: new Date(+now + 100 * 60000), status: 'pending' });
      else add('waitlist_offers', { id: id(`offer-old:${e.id}`), enrollment_id: e.id, expires_at: at(-9, 20), status: pos === 1 ? 'expired' : 'skipped' });
    }
  }

  // ---- attendance, results, at-risk members
  const regular = classes.filter(c => !c.plan.fresh && c.end_on >= today && off(c.start_on) < -42);
  const idleRisk = new Set(regular.slice(0, 5).map(c => c.roster.filter(u => !u.leftAt).at(-1).id));
  const streakRisk = new Set(regular.slice(5, 9).map(c => c.roster.filter(u => !u.leftAt).at(-1).id));
  const sessionNotes = ['Bước chân nhanh hơn, cần giữ trọng tâm thấp.', 'Kỹ thuật ổn định, tăng tốc độ ra đòn.', 'Cần khởi động kỹ hơn trước bài tốc độ.', 'Phối hợp tốt với bạn tập, giữ nhịp thở đều.'];
  const corrected = [];
  for (const cl of classes) {
    const coach = coaches.find(c => c.id === cl.coach_id);
    const prev = new Map();
    for (const ses of sessionsOf.get(cl.id).filter(s => s.status === 'done')) {
      const age = off(localDate(ses.start_at));
      for (const [j, u] of cl.roster.entries()) {
        if (u.pending || +ses.start_at < +u.enrolledAt || (u.leftAt && +ses.start_at >= +u.leftAt)) continue;
        let result;
        if ((idleRisk.has(u.id) && age >= -22) || (streakRisk.has(u.id) && age >= -12)) result = 'absent';
        else {
          const r = random(`att:${ses.id}:${u.id}`);
          result = r < 0.07 && prev.get(u.id) !== 'absent' ? 'absent' : r < 0.12 ? 'excused' : r < 0.2 ? 'late' : 'present';
        }
        prev.set(u.id, result);
        const row = add('attendance', { id: id(`att:${ses.id}:${u.id}`), kind: 'session', user_id: u.id, session_id: ses.id, result,
          at: result === 'late' ? new Date(+ses.start_at + 8 * 60000) : ses.start_at, method: 'staff', flagged: false, checked_by: coach.id,
          reason: result === 'excused' ? pick(['Bận công tác, đã báo trước', 'Ốm, có nhắn huấn luyện viên', 'Việc gia đình'], `why:${ses.id}:${u.id}`) : null });
        if (result === 'present' && age >= -10 && age <= -2 && j === 1 && corrected.length < 6) {
          row.checked_by = manager.id; row.reason = 'Quản lý sửa theo xác nhận của huấn luyện viên'; corrected.push(row);
        }
        if (result === 'present' || result === 'late') add('session_results', { id: id(`res:${ses.id}:${u.id}`), session_id: ses.id, user_id: u.id,
          plan_pct: Math.min(98, 50 + Math.floor((+ses.start_at - +u.enrolledAt) / DAY / 3) + Math.floor(random(`pct:${ses.id}:${u.id}`) * 18)), metrics: { practice_minutes: 45 + (j % 3) * 5 },
          note: pick(sessionNotes, `note:${ses.id}:${u.id}`), recorded_by: coach.id, recorded_at: ses.end_at });
      }
    }
  }
  for (const id_ of streakRisk) add('attendance', { id: id(`gate-streak:${id_}`), kind: 'gate', user_id: id_, session_id: null, result: null,
    at: at(-3, 18, 40), method: 'qr', flagged: false, checked_by: null });

  // ---- coaching content
  const hwTitles = [['Bước chân 4 góc', 'Tập bước chân 4 góc sân, 3 hiệp × 2 phút, nghỉ 1 phút.', ['Khởi động 5 phút', '3 hiệp bước chân', 'Giãn cơ 5 phút']],
    ['Sức bền nền', 'Chạy nhẹ 20 phút và nhảy dây 3 × 100 lần.', ['Chạy 20 phút', 'Nhảy dây 300 lần', 'Ghi lại nhịp tim']],
    ['Kỹ thuật cơ bản', 'Tập vung tay không bóng 3 × 20 lần trước gương, chú ý tư thế.', ['Quay video 1 lượt', '3 × 20 lần vung tay', 'Gửi video cho HLV']]];
  for (const [ci, cl] of classes.entries()) {
    if (cl.plan.fresh) continue;
    const coach = coaches.find(c => c.id === cl.coach_id);
    const [title, body, checklist] = hwTitles[ci % 3];
    const reviewDay = Math.min(-6, off(cl.end_on) - 6);
    const activeRoster = cl.roster.filter(u => !u.pending && !u.leftAt && +u.enrolledAt <= +at(reviewDay, 0));
    const hw = add('homework', { id: id(`hw:${cl.id}`), coach_id: coach.id, class_id: cl.id, title, body, checklist, due_on: day(reviewDay + 6), created_at: at(reviewDay, 21) });
    for (const [j, u] of activeRoster.entries()) {
      const done = j % 3 === 0;
      add('homework_recipients', { homework_id: hw.id, user_id: u.id, done_items: done ? checklist : j % 3 === 1 ? checklist.slice(0, 1) : [], completed_at: done ? at(reviewDay + 2, 20) : null });
    }
    const target = activeRoster[ci % activeRoster.length];
    add('coach_notes', { id: id(`cnote:${cl.id}`), user_id: target.id, coach_id: coach.id,
      body: pick(['Tiến bộ rõ ở bước chân, cần thêm sức bền cho hiệp cuối.', 'Hay vội khi bóng nhanh, nhắc giữ nhịp và nhìn bóng.', 'Thái độ tập tốt, có thể lên nhóm trung cấp sau khóa.'], `cn:${ci}`), created_at: at(reviewDay + 1, 20) });
    for (const [j, u] of activeRoster.slice(0, 3).entries()) {
      add('progress_reviews', { id: id(`review:${cl.id}:${u.id}`), user_id: u.id, sport: cl.sport, coach_id: coach.id, period_weeks: 4,
        technique: 2 + ((ci + j) % 4), fitness: 2 + ((ci + j + 1) % 4), attitude: 3 + ((ci + j) % 3),
        comment: pick(['Kỹ thuật ổn định hơn tháng trước.', 'Cần tập thêm thể lực ngoài giờ lớp.', 'Tham gia đều, phối hợp tốt với nhóm.'], `rv:${ci}:${j}`), created_at: at(reviewDay + j, 21) });
    }
    if (ci % 4 === 0) {
      const u = cl.roster[2];
      audit(at(reviewDay + 1, 21), coach, 'student_level', 'user', u.id, { sport: cl.sport, level: cl.level });
    }
  }

  // ---- contact log for at-risk members
  const outcomes = ['will_return', 'no_answer', 'reschedule', 'reached'];
  let ci2 = 0;
  for (const uid of [...idleRisk, ...streakRisk]) {
    const desk = desks[ci2 % desks.length];
    const n = -2 - (ci2 % 9);
    if (ci2 % 3 !== 2) {
      const row = add('contact_log', { id: id(`contact:${uid}`), user_id: uid, reason: idleRisk.has(uid) ? 'idle' : 'streak',
        channel: ['phone', 'zalo', 'sms'][ci2 % 3], outcome: outcomes[ci2 % 4],
        note: pick(['Hội viên bận công việc, hẹn quay lại tuần sau.', 'Gọi hai lần không nghe máy, sẽ nhắn Zalo.', 'Muốn đổi sang lớp buổi sáng.', 'Bị đau cổ chân, đang nghỉ hồi phục.'], `cl:${uid}`),
        created_by: desk.id, created_at: at(n, 10, 15) });
      audit(row.created_at, desk, 'contact_logged', 'user', uid, { reason: row.reason, outcome: row.outcome });
    }
    ci2++;
  }
  const expiring = subs.filter(s => s.status === 'active' && s.end_on >= today && s.end_on <= day(7));
  for (const [i, s] of expiring.slice(0, 4).entries()) {
    const desk = desks[i % desks.length];
    const row = add('contact_log', { id: id(`contact-exp:${s.id}`), user_id: s.user_id, reason: 'expiring', channel: i % 2 ? 'zalo' : 'phone',
      outcome: i % 2 ? 'will_return' : 'reached', note: 'Nhắc gói sắp hết hạn, hội viên sẽ gia hạn tại quầy.', created_by: desk.id, created_at: at(-1 - i, 15) });
    audit(row.created_at, desk, 'contact_logged', 'user', s.user_id, { reason: 'expiring' });
  }

  // ---- court bookings
  const members = [...existingMembers, ...rows.users.filter(u => u.role === 'member')];
  const perDay = new Map();
  const guestNames = () => makeName();
  let bn = 0;
  const bookingStart = first;
  for (let n = bookingStart; n <= 6; n++) {
    const date = day(n);
    const weekend = [0, 6].includes(dow(date));
    for (const court of courts) {
      for (let hour = 6; hour <= 21; hour++) {
        const start = at(n, hour), end = at(n, hour + 1);
        if (courtBusy.has(key(court.id, start))) continue;
        if (+start <= +now && +end > +now) continue;
        if (n >= -2 && MAINTENANCE.includes(court.court_code)) continue;
        const base = hour >= 17 ? 0.55 : weekend && hour <= 11 ? 0.42 : hour <= 7 ? 0.28 : 0.1;
        const load = base * (weekend ? 1.35 : 1) * (court.sport === 'badminton' || court.sport === 'pickleball' ? 1.1 : 0.7) * (n > 0 ? 0.55 : 1);
        if (random(`slot:${date}:${court.court_code}:${hour}`) >= load) continue;
        const future = +start > +now;
        const lead = (1 + Math.floor(random(`lead:${date}:${court.court_code}:${hour}`) * 60)) * 3600000;
        let paidAt = new Date(+start - lead);
        if (+paidAt > +now) paidAt = new Date(+now - (20 + Math.floor(random(`pn:${date}:${hour}`) * 200)) * 60000);
        if (localDate(paidAt) < WINDOW_START) continue;
        const wantsMember = random(`who:${date}:${court.court_code}:${hour}`) < 0.68;
        let user = null;
        if (wantsMember) {
          for (let t = 0; t < 12 && !user; t++) {
            const c = members[Math.floor(random(`m:${date}:${court.court_code}:${hour}:${t}`) * members.length)];
            const joined = subs.find(s => s.user_id === c.id)?.start_on;
            if (!joined || atDate(joined, 8) > paidAt) continue;
            if (idleRisk.has(c.id) && n >= -16) continue;
            if (busy.has(key(c.id, start)) || (perDay.get(`${c.id}:${date}`) || 0) >= 2) continue;
            user = c;
          }
        }
        const number = ++bn;
        const bid = id(`booking:${number}`);
        const price = user && covered(user.id, date) ? memberFee : listPrice(court, start);
        const status = future ? 'confirmed' : number % 19 === 0 ? 'cancelled' : user && number % 23 === 0 ? 'no_show' : 'completed';
        if (status === 'cancelled') paidAt = new Date(Math.min(+paidAt, +start - 50 * 3600000));
        if (localDate(paidAt) < WINDOW_START) { bn--; continue; }
        const guest = user ? null : guestNames();
        let occupancy = null;
        if (status === 'confirmed') occupancy = add('occupancies', { id: id(`occ:${bid}`), court_id: court.id, start_at: start, end_at: end, kind: 'booking', ref_id: bid });
        add('court_bookings', { id: bid, code: code('CRT', paidAt), court_id: court.id, user_id: user?.id ?? null, guest_name: guest,
          guest_phone: guest ? `+849${String(Math.floor(random(`gp:${number}`) * 1e8)).padStart(8, '0')}` : null,
          start_at: start, end_at: end, status, channel: user && number % 3 ? 'app' : 'desk', price_vnd: price, vat_rate: vat,
          occupancy_id: occupancy?.id ?? null, paid_vnd: price, deposit_vnd: 0, discount_pct: 0, promo_discount_vnd: 0,
          cancel_refund_pct: status === 'cancelled' ? 100 : null, cancel_fee_vnd: status === 'cancelled' ? 0 : null });
        const label = { text: `Thuê sân ${court.court_code} ${date} ${hour}:00–${hour + 1}:00`, guest };
        const charge = payment('booking', bid, user, price, paidAt, label, { unit: 'giờ', method: user && number % 3 ? 'gateway' : null });
        audit(paidAt, user && number % 3 ? user : deskFor(localDate(paidAt)), user ? 'create_booking' : 'walk_in', 'booking', bid, { court: court.court_code, start_at: start });
        if (status === 'cancelled') {
          const when = new Date(+start - 30 * 3600000);
          payment('booking', bid, user, -price, when, { text: `Hoàn tiền hủy sân ${court.court_code}`, guest }, { unit: 'giờ', method: charge.method });
          audit(when, user || deskFor(localDate(when)), 'cancel_booking', 'booking', bid, { refund_pct: 100, reason: 'Khách đổi kế hoạch' });
        }
        if (user) {
          busy.add(key(user.id, start));
          perDay.set(`${user.id}:${date}`, (perDay.get(`${user.id}:${date}`) || 0) + 1);
          if (status === 'completed' && !idleRisk.has(user.id) && random(`gate:${bid}`) < 0.6) {
            const g = add('attendance', { id: id(`gate:${bid}`), kind: 'gate', user_id: user.id, session_id: null, result: null,
              at: new Date(+start - 10 * 60000), method: number % 2 ? 'qr' : 'staff', flagged: false, checked_by: number % 2 ? null : deskFor(date).id });
            audit(g.at, deskFor(date), 'gate_checkin', 'user', user.id, { method: g.method });
          }
        }
      }
    }
  }
  // Hội viên "vắng lâu" không được có lượt vào cổng hay đặt sân gần đây.
  for (const b of rows.court_bookings) if (idleRisk.has(b.user_id) && +b.start_at > +at(-15, 0)) throw new Error('Idle at-risk member has a recent booking');

  // ---- equipment
  const items = (await db.query('select id, rent_vnd from equipment_items order by sku')).rows;
  const guestBookings = rows.court_bookings.filter(b => b.status === 'completed' && b.guest_phone).slice(-30);
  for (const [i, b] of guestBookings.entries()) {
    if (!items.length || i % 3) continue;
    const item = items[i % items.length];
    const out = add('equipment_loans', { id: id(`loan:${b.id}`), item_id: item.id, booking_id: b.id, phone: b.guest_phone, qty: 1 + (i % 2),
      status: 'returned', due_at: b.end_at, returned_at: new Date(+b.end_at - 5 * 60000) });
    audit(new Date(+b.start_at - 5 * 60000), deskFor(localDate(b.start_at)), 'loan_out', 'equipment_loan', out.id, { qty: out.qty });
    audit(out.returned_at, deskFor(localDate(b.start_at)), 'loan_return', 'equipment_loan', out.id, {});
  }

  // ---- maintenance
  const deskNow = deskFor(today);
  const orders = [
    { court: 'CL-12', title: 'Thảm sân bong mép gần lưới', description: 'Mép thảm phía lưới bị bong khoảng 40 cm, dễ vấp khi lùi về cuối sân.', priority: 'urgent', status: 'open', blocks: true, assignee: 'Đội kỹ thuật sân', n: -2, by: deskNow },
    { court: 'BB-06', title: 'Thay mặt bàn bị cong vênh', description: 'Mặt bàn số 6 cong ở góc trái, bóng nảy lệch. Đã đặt mặt bàn mới.', priority: 'normal', status: 'in_progress', blocks: true, assignee: 'Anh Thành – kỹ thuật', n: -4, by: findCoach('Trương Văn Hải') },
    { court: 'CL-03', title: 'Đèn LED khu sân 3 nhấp nháy', description: 'Hai bóng LED phía trên sân 3 nhấp nháy từ chiều.', priority: 'normal', status: 'done', blocks: false, assignee: 'Điện lạnh Phú Thịnh', n: -19, by: desks[0], cost: 1250000, resolution: 'Thay 2 bóng LED 150W và chấn lưu.', closedAfter: 1 },
    { court: 'PB-02', title: 'Lưới pickleball chùng', description: 'Lưới sân PB-02 thấp hơn chuẩn khoảng 3 cm.', priority: 'low', status: 'done', blocks: false, assignee: 'Đội kỹ thuật sân', n: -11, by: findCoach('Đặng Thu Phương'), cost: 0, resolution: 'Căng lại dây lưới, đo lại 86 cm giữa lưới.', closedAfter: 0 },
    { court: 'BR-01', title: 'Bảng rổ phía đông lỏng ốc', description: 'Bảng rổ rung mạnh khi úp rổ.', priority: 'urgent', status: 'done', blocks: true, assignee: 'Cơ khí Minh Tâm', n: -33, by: findCoach('Võ Thanh Tùng'), cost: 850000, resolution: 'Siết lại toàn bộ ốc, thay 4 bu lông.', closedAfter: 1 },
    { court: 'TN-02', title: 'Vạch biên sân mờ', description: 'Vạch biên dọc phía ngoài mờ, khó bắt bóng ra ngoài.', priority: 'low', status: 'open', blocks: false, assignee: null, n: -6, by: findCoach('Bùi Hoàng Nam') },
    { court: 'BC-02', title: 'Kiểm tra cột lưới bóng chuyền', description: 'Báo nhầm – cột đã được siết trong lần bảo trì định kỳ.', priority: 'normal', status: 'cancelled', blocks: false, assignee: null, n: -15, by: desks[1] },
  ];
  for (const o of orders) {
    const created = at(o.n, 9, 20);
    const wo = add('work_orders', { id: id(`wo:${o.court}:${o.n}`), code: code('WO', created), court_id: courtBy[o.court].id, title: o.title,
      description: o.description, priority: o.priority, status: o.status, blocks_court: o.blocks, assignee: o.assignee, cost_vnd: o.cost ?? 0,
      resolution: o.resolution ?? null, reported_by: o.by.id, created_at: created,
      closed_at: ['done', 'cancelled'].includes(o.status) ? at(o.n + (o.closedAfter ?? 0), 16) : null });
    audit(created, o.by, 'create_work_order', 'work_order', wo.id, { court: o.court, priority: o.priority, blocks_court: o.blocks });
    if (o.status !== 'open') audit(wo.closed_at ?? at(o.n, 14), manager, 'patch_work_order', 'work_order', wo.id, { status: o.status }, { status: 'open' });
    if (o.blocks && ['open', 'in_progress'].includes(o.status)) {
      await db.query("update courts set status='maintenance' where court_code=$1", [o.court]);
      audit(created, manager, 'patch_court', 'court', courtBy[o.court].id, { status: 'maintenance' }, { status: 'ready' });
    }
  }

  // ---- tickets
  const ticketTexts = [
    ['Đèn sân CL-07 tối thứ ba hơi tối, nhờ kiểm tra giúp.', 'Kỹ thuật đã thay bóng đèn sân CL-07, cảm ơn bạn đã báo.'],
    ['Mình muốn chuyển từ lớp tối thứ hai sang lớp cuối tuần được không?', 'Lớp cuối tuần còn chỗ, bạn ghé quầy để lễ tân chuyển giúp nhé.'],
    ['Cho mình xin hóa đơn VAT có mã số thuế công ty cho gói 6 tháng.', 'Lễ tân đã xuất lại hóa đơn có mã số thuế, bạn xem trong mục Thanh toán.'],
    ['Phòng thay đồ nữ hết giấy vệ sinh lúc 19h.', 'Đã bổ sung ngay, cảm ơn bạn.'],
    ['Mình quên mật khẩu, đổi số điện thoại mới thì làm sao?', 'Bạn mang CCCD ra quầy, lễ tân cập nhật số mới và đặt lại mật khẩu giúp bạn.'],
    ['Bãi giữ xe máy tối thứ sáu hơi chật, có chỗ gửi thêm không?', 'Trung tâm đã mở thêm khu gửi xe phía sau từ tuần này.'],
    ['Đặt sân online bị trừ tiền nhưng chưa thấy xác nhận.', 'Giao dịch đã được ghi nhận, sân của bạn đã xác nhận. Xin lỗi vì chậm trễ.'],
    ['Nhờ trung tâm mở thêm lớp pickleball buổi sáng.', null],
  ];
  const tUsers = members.filter(m => subs.some(s => s.user_id === m.id));
  for (let i = 0; i < 46; i++) {
    const u = tUsers[Math.floor(random(`tu:${i}`) * tUsers.length)];
    const joined = subs.find(s => s.user_id === u.id).start_on;
    const n = Math.max(off(joined) + 1, -45) + Math.floor(random(`td:${i}`) * (-Math.max(off(joined) + 1, -45)));
    const created = at(Math.min(n, 0), 8 + Math.floor(random(`th:${i}`) * 12), Math.floor(random(`tm:${i}`) * 59));
    if (+created > +now) continue;
    const [body, reply] = ticketTexts[i % ticketTexts.length];
    const repliedAt = new Date(+created + (25 + Math.floor(random(`tr:${i}`) * 240)) * 60000);
    const closed = reply && +repliedAt <= +now && i % 6 !== 0;
    const desk = deskFor(localDate(created));
    const tid = id(`ticket:${i}`);
    add('tickets', { id: tid, user_id: u.id, body, status: closed ? 'closed' : 'open', created_at: created,
      reply: closed ? reply : null, replied_at: closed ? repliedAt : null, replied_by: closed ? desk.id : null });
    if (closed) {
      audit(repliedAt, desk, 'ticket_reply', 'ticket', tid, {});
      add('outbox', { id: id(`ticket-note:${i}`), channel: 'inapp', template: 'ticket_reply', user_id: u.id, payload: { ticket_id: tid, reply },
        dedupe_key: `ticket_reply:${tid}`, created_at: repliedAt, sent_at: repliedAt, read_at: i % 3 && +repliedAt + 3600000 <= +now ? new Date(+repliedAt + 3600000) : null });
    }
  }

  // ---- conversations
  const deskTopics = [
    ['Chị ơi tối nay 19h còn sân cầu lông không ạ?', 'Còn CL-04 và CL-09 lúc 19h em nhé.', 'Em đặt CL-04 trên app luôn nha chị.', 'Ok em, nhớ mang giày đế mềm nhé.'],
    ['Gói của em sắp hết, gia hạn 3 tháng có ưu đãi gì không ạ?', 'Hiện có mã SUMMER50K giảm 50.000đ cho gói, em nhập khi thanh toán nhé.', 'Em thanh toán tại quầy được không chị?', 'Được em, ghé quầy là chị làm liền.'],
    ['Cho em hỏi thuê vợt bóng bàn giá bao nhiêu ạ?', 'Thuê vợt 20.000đ/lượt, bóng tập miễn phí em nhé.', 'Dạ cảm ơn chị.'],
    ['Mai em đến muộn 15 phút có bị huỷ sân không ạ?', 'Sân giữ cho em 10 phút đầu, em nhắn chị nếu trễ hơn nhé.', 'Dạ em sẽ cố đến đúng giờ.'],
    ['Em muốn xuất hoá đơn công ty cho buổi đặt sân hôm qua.', 'Em gửi chị tên công ty và mã số thuế nhé.', 'Công ty TNHH Minh Phát, MST 0315678912 ạ.', 'Chị xuất rồi, em xem trong mục Thanh toán nhé.'],
  ];
  const coachTopics = [
    ['Thầy ơi em bị đau cổ tay sau buổi hôm qua ạ.', 'Em chườm lạnh 15 phút và nghỉ cổ tay 2 ngày nhé.', 'Buổi tới em vẫn đến tập được không thầy?', 'Được, buổi tới em tập bước chân, chưa đánh mạnh.'],
    ['Cô ơi bài tập về nhà em làm xong rồi, em gửi video ở đâu ạ?', 'Em đánh dấu hoàn thành trong mục Bài tập, video gửi qua đây cho cô.', 'Dạ em gửi rồi ạ.', 'Cô xem rồi, tư thế tốt hơn nhiều, giữ nhé.'],
    ['Em xin nghỉ buổi thứ năm vì đi công tác ạ.', 'Ok em, cô ghi nhận. Em xem bài tập để tự ôn nhé.', 'Dạ cảm ơn cô.'],
    ['Thầy ơi em nên mua vợt loại nào cho người mới?', 'Em chọn vợt nhẹ, cân bằng, khoảng 1 triệu là đủ tập.', 'Em cảm ơn thầy ạ.'],
  ];
  let convN = 0;
  const writeConversation = (member, staff, topics, seedKey, earliest) => {
    const cid = id(`conv:${member.id}:${staff.id}`);
    let conv = null;
    const days = [0, 1].map(turn => earliest + Math.floor(random(`cd:${seedKey}:${turn}`) * (1 - earliest))).sort((a, b) => a - b);
    let lastTime = 0;
    for (let turn = 0; turn < 2; turn++) {
      const n = days[turn];
      const topic = topics[(convN + turn) % topics.length];
      let time = Math.max(lastTime + 3600000, +at(Math.min(n, 0), 8 + Math.floor(random(`ch:${seedKey}:${turn}`) * 11), Math.floor(random(`cm:${seedKey}:${turn}`) * 59)));
      for (let j = 0; j < topic.length; j++) {
        if (j) time += (3 + Math.floor(random(`cr:${seedKey}:${turn}:${j}`) * 40)) * 60000;
        if (time > +now || new Date(time + 7 * 3600000).getUTCHours() > 21 || new Date(time + 7 * 3600000).getUTCHours() < 6) break;
        lastTime = time;
        conv ??= add('conversations', { id: cid, member_id: member.id, staff_id: staff.id, created_at: new Date(time) });
        const read = time + 4 * 60000;
        const last = turn === 1 && j === topic.length - 1 && convN % 3 === 0;
        add('messages', { id: id(`msg:${cid}:${turn}:${j}`), conversation_id: cid, sender_id: j % 2 ? staff.id : member.id, body: topic[j],
          created_at: new Date(time), read_at: !last && read <= +now ? new Date(read) : null });
      }
    }
    convN++;
  };
  for (const [i, cl] of classes.entries()) {
    const coach = coaches.find(c => c.id === cl.coach_id);
    for (const u of cl.roster.slice(0, 3)) writeConversation(u, coach, coachTopics, `${cl.id}:${u.id}`, Math.max(off(localDate(u.enrolledAt)), -60));
    const u = cl.roster[3 + (i % 3)];
    if (u) writeConversation(u, desks[i % desks.length], deskTopics, `desk:${u.id}`, Math.max(off(localDate(u.enrolledAt)), -60));
  }
  for (const [i, { user }] of courtOnly.slice(0, 12).entries()) {
    const joined = off(subs.find(s => s.user_id === user.id).start_on);
    writeConversation(user, desks[i % desks.length], deskTopics, `desk-co:${user.id}`, Math.max(joined + 1, -40));
  }

  // ---- coach payouts for October
  for (const c of coaches) {
    const rate = rows.coach_rates.find(r => r.coach_id === c.id);
    const own = classes.filter(cl => cl.coach_id === c.id);
    const octSessions = own.flatMap(cl => sessionsOf.get(cl.id)).filter(s => s.status === 'done' && localDate(s.start_at).startsWith('2026-10'));
    if (!octSessions.length) continue;
    const ids = new Set(octSessions.map(s => s.id));
    const students = rows.attendance.filter(a => ids.has(a.session_id) && ['present', 'late'].includes(a.result)).length;
    const p = add('coach_payouts', { id: id(`payout:${c.id}:2026-10`), coach_id: c.id, period: '2026-10', sessions: octSessions.length, students,
      amount_vnd: octSessions.length * rate.per_session_vnd + students * rate.per_student_vnd, status: 'paid', closed_by: manager.id,
      closed_at: atDate('2026-11-02', 10), paid_at: atDate('2026-11-05', 15) });
    audit(p.closed_at, manager, 'close_commission', 'coach_payout', p.id, { period: '2026-10', amount_vnd: p.amount_vnd });
    audit(p.paid_at, manager, 'pay_commission', 'coach_payout', p.id, { period: '2026-10' });
  }

  // ---- misc audit
  for (const [i, u] of members.filter(m => subs.some(s => s.user_id === m.id)).entries()) {
    if (i % 9) continue;
    const joined = off(subs.find(s => s.user_id === u.id).start_on);
    audit(at(Math.min(joined + 20, -1), 11, i % 50), deskFor(day(Math.min(joined + 20, -1))), 'update_member', 'user', u.id, { health_notes: 'Đã cập nhật số điện thoại người thân' });
  }
  for (const n of [-60, -38, -17, -3]) audit(at(n, 8, 30), manager, 'patch_settings', 'settings', null, { book_ahead_days: 7 }, { book_ahead_days: 6 });
  for (const cl of classes.filter((c, i) => i % 7 === 3)) audit(at(Math.max(-20, Math.min(-1, off(cl.start_on))), 15), manager, 'edit_class', 'class', cl.id, { description: 'Cập nhật giáo trình' });

  // ---- write
  // Ngày tham gia của hội viên có sẵn.
  for (const u of existingMembers) if (u.created_at) await db.query('update users set created_at=$2, pii_consent_at=$2, date_of_birth=$3 where id=$1', [u.id, u.created_at, u.date_of_birth]);
  rows.users = rows.users.map(({ sport, enrolledAt, leftAt, pending, ...u }) => u);
  const order = ['users', 'coach_sports', 'coach_rates', 'subscriptions', 'training_profiles', 'member_levels', 'classes', 'enrollments',
    'waitlist_offers', 'occupancies', 'sessions', 'coach_occupancies', 'court_bookings', 'cashier_shifts', 'payments', 'invoices',
    'invoice_lines', 'attendance', 'session_results', 'homework', 'homework_recipients', 'coach_notes', 'progress_reviews', 'contact_log',
    'equipment_loans', 'work_orders', 'tickets', 'conversations', 'messages', 'coach_payouts', 'outbox', 'audit_logs'];
  for (const table of order) await insertRows(db, table, rows[table] || []);
  // Bộ đếm mã chứng từ: mã app sinh ra sau này không được trùng mã đã seed.
  for (const [k, n] of counters) {
    const [kind, yyyymmdd] = k.split(':');
    await db.query(`insert into code_counters (kind, yyyy, n) values ($1,$2,$3)
      on conflict (kind, yyyy) do update set n=greatest(code_counters.n, excluded.n)`, [kind, Number(yyyymmdd), n]);
  }
  await db.query(`insert into code_counters (kind, yyyy, n) values ('member', 2026, $1)
    on conflict (kind, yyyy) do update set n=greatest(code_counters.n, excluded.n)`, [memberN]);
  return { asOf: now.toISOString(), today, tomorrow: day(1), added: Object.fromEntries(order.map(t => [t, rows[t]?.length || 0])) };
}

// ---------------------------------------------------------------- verify
export async function verify(db, asOf) {
  const W = `'${WINDOW_START}T00:00:00+07:00'::timestamptz`;
  const checks = {
    staffCounts: "select case when count(*) filter(where role='manager')=1 and count(*) filter(where role='coach')=12 and count(*) filter(where role='receptionist')=3 then 0 else 1 end n from users",
    sportClassCounts: "select count(*) n from (select sport from classes group by sport having count(*) not between 5 and 6) q",
    durations: "select (select count(*) from classes where duration_min<>60) + (select count(*) from sports where enabled and slot_duration_min<>60) + (select count(*) from sessions where end_at-start_at<>interval '60 minutes') + (select count(*) from court_bookings where end_at-start_at<>interval '60 minutes') n",
    courseLengths: "select count(*) n from classes where end_on-start_on+1 not in (56,84,112)",
    sessionCourseWindow: "select count(*) n from sessions s join classes c on c.id=s.class_id where (s.start_at at time zone 'Asia/Ho_Chi_Minh')::date not between c.start_on and c.end_on",
    attendanceEnrollmentWindow: "select count(*) n from attendance a join sessions s on s.id=a.session_id join enrollments e on e.class_id=s.class_id and e.user_id=a.user_id where not exists(select 1 from audit_logs l where l.entity_id=e.id and l.action='enroll_class' and l.at<=s.start_at) or exists(select 1 from audit_logs l where l.entity_id=e.id and l.action='cancel_enrollment' and l.at<=s.start_at)",
    completedResults: "select count(*) n from attendance a join sessions s on s.id=a.session_id where s.status='done' and a.result in ('present','late') and not exists(select 1 from session_results r where r.session_id=s.id and r.user_id=a.user_id)",
    missingAttendance: "select count(*) n from sessions s join enrollments e on e.class_id=s.class_id where s.status='done' and e.status in ('confirmed','cancelled') and exists(select 1 from audit_logs l where l.entity_id=e.id and l.action='enroll_class' and l.at<=s.start_at) and not exists(select 1 from audit_logs l where l.entity_id=e.id and l.action='cancel_enrollment' and l.at<=s.start_at) and not exists(select 1 from attendance a where a.session_id=s.id and a.user_id=e.user_id)",
    morningHistory: "select count(*) n from classes c join users u on u.id=c.coach_id where ((c.sport='badminton' and u.full_name='Trần Thị Lan' and c.rrule='FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=7') or (c.sport='tennis' and u.full_name='Ngô Mỹ Linh' and c.rrule='FREQ=WEEKLY;BYDAY=TU,TH;BYHOUR=8')) and (not exists(select 1 from sessions s join attendance a on a.session_id=s.id join session_results r on r.session_id=s.id and r.user_id=a.user_id where s.class_id=c.id and s.status='done') or not exists(select 1 from progress_reviews r where r.coach_id=c.coach_id and r.sport=c.sport))",
    staleBookings: "select count(*) n from court_bookings where status in ('hold','confirmed','in_use') and start_at <= $1",
    futureCompletedBookings: "select count(*) n from court_bookings where status in ('completed','no_show') and end_at > $1",
    staleSessions: "select count(*) n from sessions where status='scheduled' and start_at <= $1",
    duplicateLiveMemberships: "select count(*) n from (select user_id from subscriptions where status in ('active','frozen') group by user_id having count(*)>1) q",
    bookingOverlaps: "select count(*) n from court_bookings a join court_bookings b on a.id<b.id and a.court_id=b.court_id and a.start_at<b.end_at and b.start_at<a.end_at where a.status<>'cancelled' and b.status<>'cancelled'",
    coachOverlaps: "select count(*) n from sessions a join classes ca on ca.id=a.class_id join sessions b on a.id<b.id and a.start_at<b.end_at and b.start_at<a.end_at join classes cb on cb.id=b.class_id where ca.coach_id=cb.coach_id and a.status<>'cancelled' and b.status<>'cancelled'",
    courtSessionOverlaps: "select count(*) n from sessions s join court_bookings b on b.court_id=s.court_id and s.start_at<b.end_at and b.start_at<s.end_at where s.status<>'cancelled' and b.status<>'cancelled'",
    sessionSessionOverlaps: "select count(*) n from sessions a join sessions b on a.id<b.id and a.court_id=b.court_id and a.start_at<b.end_at and b.start_at<a.end_at",
    classCoverage: "select count(*) n from enrollments e join classes c on c.id=e.class_id where e.status='confirmed' and not exists(select 1 from subscriptions s where s.user_id=e.user_id and s.start_on<=c.start_on and s.end_on>c.end_on)",
    unpaidBookings: "select count(*) n from court_bookings b where b.paid_vnd<>b.price_vnd or not exists(select 1 from payments p where p.ref_type='booking' and p.ref_id=b.id and p.status='posted' and p.amount_vnd=b.price_vnd and p.paid_at<b.start_at)",
    unpaidEnrollments: "select count(*) n from enrollments e where e.status='confirmed' and not exists(select 1 from payments p where p.ref_type='enrollment' and p.ref_id=e.id and p.status='posted' and p.amount_vnd=e.price_vnd)",
    unpaidMemberships: "select count(*) n from subscriptions s where not exists(select 1 from payments p where p.ref_type='subscription' and p.ref_id=s.id and p.status='posted' and p.amount_vnd=s.price_vnd-s.promo_discount_vnd)",
    memberPricing: "select count(*) n from court_bookings b where exists(select 1 from subscriptions s where s.user_id=b.user_id and (b.start_at at time zone 'Asia/Ho_Chi_Minh')::date between s.start_on and s.end_on) and b.price_vnd<>(select member_court_fee_vnd from center_settings limit 1)",
    listPricing: "select count(*) n from court_bookings b join courts c on c.id=b.court_id where not exists(select 1 from subscriptions s where s.user_id=b.user_id and (b.start_at at time zone 'Asia/Ho_Chi_Minh')::date between s.start_on and s.end_on) and not exists(select 1 from price_rules r where r.sport=c.sport and r.court_id is null and r.day_kind=case when extract(isodow from b.start_at at time zone 'Asia/Ho_Chi_Minh') in (6,7) then 'weekend' else 'weekday' end and r.start_local<=(b.start_at at time zone 'Asia/Ho_Chi_Minh')::time and r.end_local>=(b.end_at at time zone 'Asia/Ho_Chi_Minh')::time and r.price_vnd=b.price_vnd)",
    missingInvoices: "select count(*) n from payments p left join invoices i on i.payment_id=p.id where p.status='posted' and (i.id is null or i.total_vnd<>p.amount_vnd or i.subtotal_vnd+i.vat_vnd<>i.total_vnd)",
    adjustmentInvoices: "select count(*) n from invoices i join payments p on p.id=i.payment_id where (p.amount_vnd<0)<>(i.kind='adjustment') or (i.kind='adjustment' and i.adjusts_invoice_id is null)",
    missingLines: "select count(*) n from invoices i where i.total_vnd<>(select sum(l.amount_vnd) from invoice_lines l where l.invoice_id=i.id)",
    enrollmentCounts: "select count(*) n from classes c where c.enrolled_count<>(select count(*) from enrollments e where e.class_id=c.id and e.status in ('confirmed','hold')) or c.enrolled_count>c.capacity",
    rosterSize: "select count(*) n from classes c where c.enrolled_count not between 6 and 9",
    confirmedRosterSize: "select count(*) n from classes c where (select count(*) from enrollments e where e.class_id=c.id and e.status='confirmed') not between 6 and 9",
    futurePayments: "select count(*) n from payments where created_at>$1",
    memberOverlaps: "select count(*) n from court_bookings a join court_bookings b on a.id<b.id and a.user_id=b.user_id and a.start_at<b.end_at and b.start_at<a.end_at where a.status<>'cancelled' and b.status<>'cancelled'",
    memberClassOverlaps: "select count(*) n from court_bookings b join enrollments e on e.user_id=b.user_id and e.status='confirmed' join sessions s on s.class_id=e.class_id and b.start_at<s.end_at and s.start_at<b.end_at where b.status<>'cancelled' and s.status<>'cancelled'",
    wrongOccupancies: "select count(*) n from court_bookings b left join occupancies o on o.id=b.occupancy_id where (b.status in ('confirmed','in_use','hold') and (o.id is null or o.ref_id<>b.id or o.court_id<>b.court_id or o.start_at<>b.start_at or o.end_at<>b.end_at)) or (b.status in ('completed','cancelled','no_show') and b.occupancy_id is not null)",
    wrongSessionOccupancies: "select count(*) n from sessions s left join occupancies o on o.id=s.occupancy_id where (s.status='scheduled' and (o.id is null or o.ref_id<>s.id or o.court_id<>s.court_id or o.start_at<>s.start_at or o.end_at<>s.end_at or not exists(select 1 from coach_occupancies co join classes c on c.id=s.class_id where co.session_id=s.id and co.coach_id=c.coach_id))) or (s.status<>'scheduled' and s.occupancy_id is not null)",
    dailyLimit: "select count(*) n from (select user_id,(start_at at time zone 'Asia/Ho_Chi_Minh')::date from court_bookings where user_id is not null and status<>'cancelled' group by 1,2 having count(*)>2) q",
    refundBalances: "select count(*) n from court_bookings b where (select sum(p.amount_vnd) from payments p where p.ref_type='booking' and p.ref_id=b.id and p.status='posted')<>case when b.status='cancelled' then 0 else b.price_vnd end",
    refundMethods: "select count(*) n from payments r where r.amount_vnd<0 and not exists(select 1 from payments p where p.ref_type=r.ref_type and p.ref_id=r.ref_id and p.amount_vnd=-r.amount_vnd and p.method=r.method and p.paid_at<r.paid_at)",
    shiftBalances: "select count(*) n from cashier_shifts s where s.cash_declared_vnd<>coalesce((select sum(p.amount_vnd) from payments p where p.shift_id=s.id and p.status='posted' and p.method='cash'),0)",
    maintenanceFuture: "select count(*) n from courts c where c.status='maintenance' and (exists(select 1 from court_bookings b where b.court_id=c.id and b.status in ('confirmed','hold') ) or exists(select 1 from sessions s where s.court_id=c.id and s.status='scheduled'))",
    paymentWindow: `select count(*) n from payments where created_at<${W} or paid_at>$1 or paid_at<created_at`,
    auditWindow: `select count(*) n from audit_logs where at<${W} - interval '15 days' or at>$1`,
    auditActors: "select count(*) n from audit_logs a left join users u on u.id=a.actor_id where u.id is null or (a.action in ('create_payment','refund','update_member','gate_checkin','ticket_reply','transfer_confirm','contact_logged','create_member') and u.role not in ('receptionist','manager')) or (a.action in ('patch_settings','create_class','pay_commission') and u.role<>'manager')",
    conversationRoles: "select count(*) n from conversations c join users m on m.id=c.member_id join users s on s.id=c.staff_id where m.role<>'member' or s.role not in ('coach','receptionist','manager')",
    messageWindow: `select count(*) n from messages m join conversations c on c.id=m.conversation_id where m.created_at>$1 or m.created_at<c.created_at or m.read_at<m.created_at or m.read_at>$1 or extract(hour from m.created_at at time zone 'Asia/Ho_Chi_Minh') not between 6 and 22`,
    ticketWindow: "select count(*) n from tickets where created_at>$1 or replied_at<created_at or replied_at>$1",
    notificationWindow: "select count(*) n from outbox where created_at>$1 or sent_at<created_at or read_at<sent_at or read_at>$1",
    gatewayCapture: "select count(*) n from payments where method='gateway' and (capture_mode<>'auto' or provider is distinct from 'payos' or provider_txn_id is null)",
    duplicateCodes: "select (select count(*) from payments)-(select count(distinct code) from payments) + (select count(*) from court_bookings)-(select count(distinct code) from court_bookings) n",
    demoWords: "select count(*) n from users where full_name ~* '(demo|test|dummy|seed)' or email ~* '(demo|test|dummy|seed)'",
    morningClasses: "select case when count(*)=2 then 0 else 1 end n from sessions s where (s.start_at at time zone 'Asia/Ho_Chi_Minh')::date=(($1::timestamptz at time zone 'Asia/Ho_Chi_Minh')::date + 1) and extract(hour from s.start_at at time zone 'Asia/Ho_Chi_Minh') in (7,8) and s.status='scheduled'",
  };
  const failures = {};
  for (const [name, sql] of Object.entries(checks)) {
    const n = Number((await db.query(sql, sql.includes('$1') ? [asOf] : [])).rows[0].n);
    if (n) failures[name] = n;
  }
  if (Object.keys(failures).length) throw new Error(`Seed invariant violations: ${JSON.stringify(failures)}`);
  return { checks: Object.keys(checks).length };
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { apply: { type: 'boolean', default: false }, 'as-of': { type: 'string' },
    'data-dir': { type: 'string' }, 'replace-remote': { type: 'string' } } });
  const url = process.env.DATABASE_URL?.trim();
  const dataDir = values['data-dir'] || process.env.PGLITE_DATA_DIR;
  const asOf = values['as-of'] || new Date().toISOString();
  if (!Number.isFinite(+new Date(asOf))) throw new Error('Invalid --as-of timestamp');
  if (!url && !dataDir) throw new Error('Set DATABASE_URL or --data-dir.');
  if (values.apply) writableTarget(url, dataDir, values['replace-remote']);
  if (values.apply && !url) {
    const entries = await readdir(dataDir).catch(err => { if (err.code === 'ENOENT') return []; throw err; });
    if (entries.length && !entries.includes('.arena3-fresh-owner')) throw new Error('Refusing a PGlite directory this script did not create. Choose a fresh directory.');
    await prepareLocalDirectory(dataDir);
  }
  const db = await connect(url, dataDir);
  try {
    if (!url && values.apply) await writeFile(resolve(dataDir, '.arena3-fresh-owner'), VERSION);
    if (values.apply) await migrate(db);
    await db.exec('begin');
    try {
      const kept = await wipe(db);
      const result = await populate(db, asOf);
      const verification = await verify(db, asOf);
      const counts = {};
      for (const t of ['users', 'classes', 'sessions', 'enrollments', 'court_bookings', 'payments', 'messages', 'tickets', 'work_orders', 'contact_log', 'audit_logs'])
        counts[t] = Number((await db.query(`select count(*) n from ${t}`)).rows[0].n);
      await db.exec(values.apply ? 'commit' : 'rollback');
      console.log(JSON.stringify({ mode: values.apply ? 'applied' : 'dry-run (rolled back)', keptUsers: kept, ...result, counts, verification }, null, 2));
    } catch (err) { await db.exec('rollback'); throw err; }
  } finally { await db.close(); }
}
if (isMainModule(import.meta.url)) main().catch(err => { console.error(`[seed-fresh] ${err.stack || err.message}`); process.exitCode = 1; });
