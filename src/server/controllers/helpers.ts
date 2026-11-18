/**
 * File: src/server/controllers/helpers.ts
 * Vai trò: Tập hợp các hàm tiện ích (helper functions) dùng chung cho các controller backend của hệ thống Arena 3.
 * Cung cấp: đọc cấu hình trung tâm (center_settings), ghi audit_logs, sinh mã chứng từ/thanh toán, gửi thông báo outbox, lập hóa đơn invoices.
 */
import type { Sql } from "@/server/data/db";
import { sha256 } from "../services/crypto";
import { err } from "./errors";
import type { PublicUser } from "./session";
import type { CancelTier } from "../services/policy";
import { parseWeeklyRrule } from "../../shared/arena3/labels";
import { addDays } from "../../shared/arena3/time";
import { one } from "./tx";

export type Settings = {
  timezone: string;
  currency: string;
  open_time: string;
  close_time: string;
  slot_minutes: number;
  hold_minutes: number;
  /** How long a slot is held while the centre waits for a bank transfer. */
  transfer_hold_minutes: number;
  book_ahead_days: number;
  max_slots_per_day: number;
  cancel_court_hours: number;
  cancel_class_hours: number;
  noshow_grace_minutes: number;
  checkin_before_minutes: number;
  refund_manager_vnd: number;
  freeze_max_days_year: number;
  minor_age: number;
  vat_rate: string | number;
  round_vnd: number;
  waitlist_offer_hours: number;
  self_checkin_enabled: boolean;
  gate_dedup_minutes: number;
  at_risk_idle_days: number;
  tax_code: string | null;
  legal_name: string | null;
  address: string | null;
  deposit_pct: number;
  deposit_peak_only: boolean;
  cancel_tiers: CancelTier[];
  series_min_weeks: number;
  series_max_weeks: number;
  series_discount_pct: number;
  loyalty_earn_vnd: number;
  loyalty_redeem_vnd: number;
  /** How long a seat is held while a member pays for a class. */
  class_hold_minutes: number;
  max_active_classes: number;
  /** What a covered member pays per court hour, at every hour. */
  member_court_fee_vnd: number;
  /** What one extra membership day costs when a class outruns the plan. */
  member_day_rate_vnd: number;
  /** Menus and list lengths as the manager set them; read through `uiConfigFrom`. */
  ui_config: unknown;
};

/**
 * Làm gì: Lấy bản ghi cấu hình trung tâm từ bảng center_settings (dòng cố định id = 1). Chứa toàn bộ thiết lập về giờ hoạt động, đặt cọc, hủy lịch, hoàn tiền và chính sách hội viên.
 * Được gọi ở: src/server/controllers/handlers/attendance.ts, auth.ts, bookings.ts và hầu hết các handler xử lý nghiệp vụ trung tâm.
 * @param sql Đối tượng kết nối DB hoặc transaction để thực thi câu lệnh SQL.
 * @returns Đối tượng Settings chứa đầy đủ các thông số cấu hình hệ thống.
 * @throws Lỗi validation nếu bảng center_settings chưa được khởi tạo bản ghi id = 1.
 */
export async function getSettings(sql: Sql): Promise<Settings> {
  // Bước 1: Truy vấn dòng cấu hình mặc định (id = 1) từ bảng center_settings
  const row = await one<Settings>(
    sql,
    `select timezone, currency, open_time::text, close_time::text, slot_minutes, hold_minutes,
            transfer_hold_minutes,
            book_ahead_days, max_slots_per_day, cancel_court_hours, cancel_class_hours,
            noshow_grace_minutes, checkin_before_minutes, refund_manager_vnd,
            freeze_max_days_year, minor_age, vat_rate, round_vnd, waitlist_offer_hours,
            self_checkin_enabled, gate_dedup_minutes, at_risk_idle_days,
            tax_code, legal_name, address,
            deposit_pct, deposit_peak_only, cancel_tiers, series_min_weeks, series_max_weeks,
            series_discount_pct, loyalty_earn_vnd, loyalty_redeem_vnd,
            class_hold_minutes, max_active_classes, member_court_fee_vnd, member_day_rate_vnd, ui_config
       from center_settings where id = 1`,
  );
  // Bước 2: Kiểm tra dữ liệu cấu hình; bắt buộc phải tồn tại để toàn bộ hệ thống hoạt động bình thường
  if (!row) throw err.validation("center_settings is missing.");
  return row;
}

/**
 * Who a court booking's receipt is made out to.
 *
 * A walk-in's name and phone were typed at the counter and live on the booking,
 * not on any account; reading the receptionist's own name off the session (as
 * the till did) put the wrong person on the invoice. What was typed wins, then
 * the account, then a plain label.
 */
export async function bookingBuyer(
  sql: Sql,
  bookingId: string,
): Promise<{ name: string; phone: string | null; userId: string | null }> {
  // Bước 1: Lấy thông tin người đặt từ bảng court_bookings, kết hợp bảng users nếu có tài khoản
  const r = await one<{ user_id: string | null; guest_name: string | null; guest_phone: string | null; full_name: string | null }>(
    sql,
    `select b.user_id, b.guest_name, b.guest_phone, u.full_name
       from court_bookings b left join users u on u.id = b.user_id
      where b.id = $1`,
    [bookingId],
  );
  return {
    // Bước 2: Xác định tên người mua: ưu tiên guest_name nhập tại quầy, nếu không có thì lấy full_name của tài khoản, mặc định là "Khách lẻ"
    name: r?.guest_name || r?.full_name || "Khách lẻ",
    phone: r?.guest_phone ?? null,
    userId: r?.user_id ?? null,
  };
}

/**
 * Làm gì: Biểu thức chính quy (Regex) kiểm tra chuỗi có tuân theo định dạng chuẩn UUID v4 (8-4-4-4-12 ký tự hex) hay không.
 * Được gọi ở: src/server/controllers/helpers.ts (hàm isUuid, audit), handlers/attendance.ts, handlers/avatar.ts, handlers/checkin.ts.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Làm gì: Hàm type guard kiểm tra giá trị truyền vào có phải là một chuỗi định dạng UUID hợp lệ hay không.
 * Được gọi ở: src/server/controllers/handlers/certificates.ts, handlers/classes.ts, handlers/desk.ts.
 * @param v Giá trị bất kỳ cần kiểm tra.
 * @returns true nếu v là chuỗi UUID hợp lệ, ngược lại false.
 */
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/**
 * Làm gì: Ghi nhận lịch sử thao tác dữ liệu (audit log) vào bảng audit_logs để phục vụ tra soát và bảo mật hệ thống.
 * Được gọi ở: src/server/controllers/handlers/assets.ts, handlers/attendance.ts, handlers/auth.ts, handlers/bookings.ts.
 * @param sql Đối tượng kết nối DB hoặc transaction để thực thi câu lệnh SQL.
 * @param actor ID của người dùng thực hiện thao tác (user_id), hoặc null nếu do hệ thống tự động.
 * @param action Tên hành động nghiệp vụ được thực hiện (ví dụ: "login", "create_booking", "update_status").
 * @param entity Tên bảng hoặc đối tượng nghiệp vụ bị tác động (ví dụ: "user", "court_booking", "center_settings").
 * @param entityId Khóa chính của đối tượng bị tác động (nếu không phải định dạng UUID thì sẽ tự động gán null).
 * @param before Trạng thái hoặc dữ liệu của đối tượng trước khi thay đổi (chuyển sang JSONB).
 * @param after Trạng thái hoặc dữ liệu của đối tượng sau khi thay đổi (chuyển sang JSONB).
 * @returns Không trả về giá trị (Promise<void>).
 */
export async function audit(
  sql: Sql,
  actor: string | null,
  action: string,
  entity: string,
  entityId: string | null,
  before: unknown = null,
  after: unknown = null,
) {
  // Bước 1: Chuẩn hóa entityId về UUID hợp lệ trước khi lưu nhật ký
  // `entity_id` is a UUID column. A caller with a key that is not one (the
  // `center_settings` row is `id = 1`) used to fail the whole request with a
  // uuid syntax error, so the id is dropped to null rather than allowed to.
  const entityUuid = entityId && UUID_RE.test(entityId) ? entityId : null;
  // Bước 2: Chèn bản ghi nhật ký vào bảng audit_logs với dữ liệu before và after được ép kiểu sang JSONB
  await sql.query(
    `insert into audit_logs (actor_id, action, entity, entity_id, before, after)
     values ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
    [
      actor,
      action,
      entity,
      entityUuid,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
    ],
  );
}

/**
 * Làm gì: Sinh mã chứng từ nội bộ kế tiếp có dạng ${kind}-XXXX (ví dụ: INV-0001, BK-0001) qua hàm lưu trữ next_doc_code trong DB.
 * Được gọi ở: src/server/controllers/helpers.ts (hàm issueInvoice), handlers/bookings.ts, handlers/classes.ts.
 * @param sql Đối tượng kết nối DB hoặc transaction để thực thi câu lệnh SQL.
 * @param kind Loại chứng từ cần sinh mã (ví dụ: "INV", "BK", "SER").
 * @returns Mã chứng từ mới được sinh (hoặc fallback dạng ${kind}-0000 nếu DB không trả về).
 */
export async function nextCode(sql: Sql, kind: string): Promise<string> {
  // Bước 1: Gọi hàm SQL next_doc_code từ database để lấy mã chứng từ tự tăng kế tiếp theo loại
  const row = await one<{ next_doc_code: string }>(sql, `select next_doc_code($1) as next_doc_code`, [
    kind,
  ]);
  // Bước 2: Trả về mã chứng từ nhận được, hoặc fallback về định dạng ${kind}-0000 nếu kết quả null
  return row?.next_doc_code ?? `${kind}-0000`;
}

/**
 * The next order code to hand a payment provider.
 *
 * Deliberately NOT `next_doc_code`. A document number is this centre's own
 * bookkeeping and may legitimately restart — on a fresh install, a restored
 * backup, a wiped demo database. An order code is a promise to somebody else's
 * system: payOS remembers every code it has ever seen and rejects a repeat, so
 * a number that can move backwards is a payment feature that stops working
 * one day with no change to the code.
 *
 * Two sources, whichever is higher:
 *
 *  - **The clock**, in milliseconds. Monotonic across any database reset,
 *    because it does not come from the database at all.
 *  - **The recorded high-water mark**, which covers the case the clock cannot:
 *    a machine whose time is wrong, or a snapshot restored from the future.
 *
 * `GREATEST` in a single statement, so two requests racing cannot both read
 * the same previous value — the second one sees the first one's write.
 *
 * `provider_sequences` is the one piece of state here that cannot be rebuilt
 * from anything else, because the authority for it is the provider's records
 * rather than ours. Migration 0018 explains how to carry it to a new database.
 */
export async function nextOrderCode(sql: Sql, provider: string): Promise<number> {
  // Bước 1: Ghi nhận hoặc cập nhật số thứ tự trong bảng provider_sequences; GREATEST đảm bảo mã luôn tăng tịnh tiến ngay cả khi đồng hồ máy chủ bị sai
  const row = await one<{ last_order_code: string | number }>(
    sql,
    `insert into provider_sequences (provider, last_order_code, updated_at)
     values ($1, $2, now())
     on conflict (provider) do update
       set last_order_code = greatest(provider_sequences.last_order_code + 1, excluded.last_order_code),
           updated_at = now()
     returning last_order_code`,
    [provider, Date.now()],
  );
  // Bước 2: Ép kiểu mã đơn hàng sang kiểu Number
  const code = Number(row?.last_order_code ?? Date.now());
  // Bước 3: Đảm bảo mã đơn hàng nằm trong giới hạn an toàn của kiểu số nguyên JavaScript trước khi gửi sang cổng thanh toán
  if (!Number.isSafeInteger(code)) {
    throw err.validation(`Order code ${code} is outside the range the gateway accepts.`);
  }
  return code;
}

/**
 * Làm gì: Đưa thông báo vào hàng đợi bảng outbox (mô hình Transactional Outbox) để gửi thông báo in-app hoặc email, chống gửi trùng bằng dedupe_key.
 * Được gọi ở: src/server/controllers/helpers.ts (hàm enqueueReceipt), handlers/bookings.ts, handlers/chat.ts, handlers/classes.ts.
 * @param sql Đối tượng kết nối DB hoặc transaction để thực thi câu lệnh SQL.
 * @param channel Kênh gửi thông báo ("inapp" hoặc "email").
 * @param template Tên mẫu thông báo (ví dụ: "payment_receipt", "booking_confirmed").
 * @param userId ID người nhận trong bảng users (hoặc null nếu không gửi đích danh tài khoản).
 * @param payload Dữ liệu chi tiết gửi kèm thông báo (được lưu dạng JSONB).
 * @param dedupe Khóa chống gửi trùng lặp (dedupe_key); nếu đã tồn tại thì DB bỏ qua không tạo thêm bản ghi mới.
 * @returns Không trả về giá trị (Promise<void>).
 */
export async function enqueue(
  sql: Sql,
  channel: "inapp" | "email",
  template: string,
  userId: string | null,
  payload: unknown,
  dedupe: string,
) {
  // Bước 1: Lưu thông báo vào bảng outbox; ON CONFLICT DO NOTHING trên dedupe_key đảm bảo tính idempotent không gửi lặp
  await sql.query(
    `insert into outbox (channel, template, user_id, payload, dedupe_key, sent_at)
     values ($1,$2,$3,$4::jsonb,$5, now())
     on conflict (dedupe_key) do nothing`,
    [channel, template, userId, JSON.stringify(payload), dedupe],
  );
}

/**
 * Tell the payer their receipt exists, and where it is.
 *
 * Every route that takes money ends up here, which is the point: the till, a
 * member confirming a court, and reception reconciling a bank transfer hours
 * later all have to leave the same trace, because to the person who paid they
 * are the same event. Court bookings used to leave none at all — the invoice was
 * written and the member was told only that their booking was confirmed, so the
 * proof of payment existed but nobody was ever pointed at it.
 *
 * `invoice_id` and `amount_vnd` travel in the payload rather than being looked
 * up when the notification is read: the receipt is a record of what was paid at
 * the time, and a later refund or correction must not quietly restate it.
 *
 * Walk-ins have no account to notify, hence the null check.
 */
export async function enqueueReceipt(
  sql: Sql,
  userId: string | null,
  receipt: { payment_id: string; invoice_id: string; amount_vnd: number; method: string },
) {
  // Bước 1: Kiểm tra tài khoản nhận; nếu là khách lẻ vãng lai (không có userId) thì không tạo thông báo in-app
  if (!userId) return;
  // Bước 2: Đưa thông báo biên lai vào hàng đợi outbox với khóa dedupe_key theo payment_id để tránh trùng lặp
  await enqueue(sql, "inapp", "payment_receipt", userId, receipt, `payment_receipt|${receipt.payment_id}`);
}

/**
 * Write an invoice and its single goods line for a payment just taken.
 *
 * Three routes take money — the till, a member confirming a court, and a
 * walk-in at the desk — and each used to write its own `insert into invoices`
 * with a different set of columns. That is how the seller block and the tax
 * split came to be filled in on one path and left null on the other two, and
 * how two of the three ended up with unaccented goods lines. One writer means
 * an invoice carries the same fields regardless of which door the money came
 * through.
 *
 * Counter prices are tax-inclusive, so `amountVnd` IS the payable total and the
 * net is derived from it. Flooring the net and taking VAT as the remainder
 * keeps `subtotal + vat = total` exact, which reconciliation checks.
 */
export async function issueInvoice(
  sql: Sql,
  args: {
    paymentId: string;
    buyerName: string;
    /** A walk-in's phone. Null for a member, whose account identifies them. */
    buyerPhone?: string | null;
    amountVnd: number;
    vatRate: number;
    description: string;
    unit: string;
    /** Separate lines that add up to the amount, when one payment bought two things. */
    lines?: { description: string; unit: string; amount_vnd: number }[];
    settings: Pick<Settings, "legal_name" | "tax_code" | "address">;
  },
): Promise<string> {
  // Bước 1: Sinh mã hóa đơn mới tăng tự động với tiền tố "INV"
  const code = await nextCode(sql, "INV");
  // Bước 2: Tính tiền hàng trước thuế (subtotal). Giá bán đã gồm thuế nên dùng Math.floor để đảm bảo subtotal + vat = total chính xác tuyệt đối
  const subtotal = Math.floor(args.amountVnd / (1 + args.vatRate / 100));
  // Bước 3: Tạo bản ghi hóa đơn trong bảng invoices với thông tin thuế suất và bên mua/bên bán
  const inv = await one<{ id: string }>(
    sql,
    `insert into invoices
       (code, payment_id, buyer_name, buyer_phone, form_no, serial_no,
        seller_legal_name, seller_tax_code, seller_address,
        subtotal_vnd, vat_rate, vat_vnd, total_vnd)
     values ($1,$2,$3,$12,'1',$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
    [
      code,
      args.paymentId,
      args.buyerName,
      `A3${new Date().getFullYear().toString().slice(2)}E`,
      args.settings.legal_name,
      args.settings.tax_code,
      args.settings.address,
      subtotal,
      args.vatRate,
      args.amountVnd - subtotal,
      args.amountVnd,
      args.buyerPhone ?? null,
    ],
  );
  // Bước 4: Chuẩn bị danh sách dòng chi tiết hóa đơn (invoice_lines), mặc định tạo 1 dòng từ thông tin chung nếu không truyền mảng lines riêng
  const lines = args.lines ?? [{ description: args.description, unit: args.unit, amount_vnd: args.amountVnd }];
  for (const line of lines) {
    // Bước 5: Chèn từng dòng hàng hóa vào bảng invoice_lines liên kết với invoice_id vừa tạo
    await sql.query(
      `insert into invoice_lines (invoice_id, description, unit, qty, unit_vnd, amount_vnd)
       values ($1,$2,$3,1,$4,$4)`,
      [inv!.id, line.description, line.unit, line.amount_vnd],
    );
  }
  // Bước 6: Trả về ID của hóa đơn vừa tạo thành công
  return inv!.id;
}

/**
 * Write the adjustment invoice (hóa đơn điều chỉnh giảm) for a refund the desk
 * has just paid out.
 *
 * The original invoice is never edited: it states what was sold on the day.
 * The reduction is a second invoice, tied to the refund payment, that names the
 * invoice it adjusts and carries negative amounts, so a period's invoices add
 * up to the revenue the centre kept. The VAT rate is the original's, because
 * the refund row is often written with 0% and the tax being reversed is the
 * tax that was charged.
 *
 * Idempotent per refund payment: a second call returns the invoice already written.
 */
export async function issueAdjustmentInvoice(sql: Sql, refundPaymentId: string): Promise<string | null> {
  // Bước 1: Nếu khoản hoàn này đã có hóa đơn điều chỉnh thì trả lại luôn.
  const existing = await one<{ id: string }>(sql, `select id from invoices where payment_id = $1`, [refundPaymentId]);
  if (existing) return existing.id;
  const refund = await one<{ amount_vnd: number; vat_rate: string | number; ref_type: string; ref_id: string; user_id: string | null }>(
    sql,
    `select amount_vnd, vat_rate, ref_type, ref_id, user_id from payments where id = $1`,
    [refundPaymentId],
  );
  if (!refund || refund.amount_vnd >= 0) return null;
  // Bước 2: Tìm hóa đơn bán gốc của cùng đơn (đặt sân, ghi danh, gói), mới nhất trước.
  const orig = await one<{
    id: string; code: string; issued_at: string; buyer_name: string; buyer_phone: string | null;
    buyer_tax_code: string | null; buyer_address: string | null; vat_rate: string | number | null;
  }>(
    sql,
    `select i.id, i.code, i.issued_at::text as issued_at, i.buyer_name, i.buyer_phone, i.buyer_tax_code, i.buyer_address, i.vat_rate
       from invoices i join payments p on p.id = i.payment_id
      where p.ref_type = $1 and p.ref_id = $2 and p.amount_vnd > 0 and i.kind = 'sale'
      order by i.issued_at desc limit 1`,
    [refund.ref_type, refund.ref_id],
  );
  const firstLine = orig
    ? await one<{ description: string; unit: string | null }>(
        sql,
        `select description, unit from invoice_lines where invoice_id = $1 order by id limit 1`,
        [orig.id],
      )
    : undefined;
  const buyer = orig
    ? null
    : await one<{ full_name: string }>(sql, `select full_name from users where id = $1`, [refund.user_id]);
  const settings = await getSettings(sql);
  // Bước 3: Tính phần giảm. Giá đã gồm thuế, nên tiền hàng làm tròn về 0 và thuế là phần còn lại, để tiền hàng + thuế = tổng.
  const total = refund.amount_vnd;
  const rate = Number(orig?.vat_rate ?? refund.vat_rate ?? 0);
  const subtotal = Math.trunc(total / (1 + rate / 100));
  const code = await nextCode(sql, "INV");
  const inv = await one<{ id: string }>(
    sql,
    `insert into invoices
       (code, payment_id, kind, adjusts_invoice_id, buyer_name, buyer_phone, buyer_tax_code, buyer_address,
        form_no, serial_no, seller_legal_name, seller_tax_code, seller_address,
        subtotal_vnd, vat_rate, vat_vnd, total_vnd)
     values ($1,$2,'adjustment',$3,$4,$5,$6,$7,'1',$8,$9,$10,$11,$12,$13,$14,$15) returning id`,
    [
      code,
      refundPaymentId,
      orig?.id ?? null,
      orig?.buyer_name ?? buyer?.full_name ?? "Khách lẻ",
      orig?.buyer_phone ?? null,
      orig?.buyer_tax_code ?? null,
      orig?.buyer_address ?? null,
      `A3${new Date().getFullYear().toString().slice(2)}E`,
      settings.legal_name,
      settings.tax_code,
      settings.address,
      subtotal,
      rate,
      total - subtotal,
      total,
    ],
  );
  // Bước 4: Một dòng hàng ghi rõ điều chỉnh giảm cho hóa đơn nào, số tiền âm.
  const what = firstLine?.description ?? "Dịch vụ tại trung tâm";
  // The header of the PDF and the XML's TTHDLQuan block already name the invoice being reduced,
  // so the line says what was handed back, short enough to fit the column.
  const description = `Hoàn tiền ${what}`;
  await sql.query(
    `insert into invoice_lines (invoice_id, description, unit, qty, unit_vnd, amount_vnd)
     values ($1,$2,$3,1,$4,$4)`,
    [inv!.id, description, firstLine?.unit ?? "lượt", total],
  );
  return inv!.id;
}

type InFlightIdem = {
  hash: string;
  promise: Promise<{ status: number; body: unknown }>;
};
// Bảng ánh xạ trong bộ nhớ lưu các request đang xử lý (in-flight) theo khóa "userId:key" để ngăn chặn xử lý trùng lặp đồng thời (race condition)
const inFlightIdempotency = new Map<string, InFlightIdem>();

/**
 * Làm gì: Đảm bảo tính lũy kế (idempotency) cho các thao tác ghi dữ liệu, chống thanh toán hoặc tạo đơn trùng lặp khi client gửi nhiều lần.
 *   Nếu request đã xử lý thành công thì trả lại kết quả cũ; nếu đang xử lý thì chờ kết quả chung mà không gọi handler lần hai.
 * Được gọi ở: src/server/controllers/router.ts (tại middleware authed cho POST /api/bookings, /api/desk/payments) và src/server/controllers/tx.test.ts.
 * @param sql Đối tượng kết nối DB hoặc transaction để thực thi câu lệnh SQL.
 * @param request HTTP Request chứa header idempotency-key và dữ liệu cần xử lý.
 * @param userId ID của người dùng gọi API, null nếu là khách vãng lai chưa đăng nhập.
 * @param required Cờ xác định header idempotency-key có bắt buộc phải có hay không.
 * @param handler Hàm callback thực hiện nghiệp vụ chính, trả về status code và response body.
 * @returns Phản hồi gồm mã HTTP status, body dữ liệu và cờ replay (true nếu phát lại từ kết quả cũ).
 * @throws err.validation (422) nếu thiếu idempotency-key bắt buộc, hoặc key đã dùng cho request có nội dung khác.
 */
export async function withIdempotency(
  sql: Sql,
  request: Request,
  userId: string | null,
  required: boolean,
  handler: () => Promise<{ status: number; body: unknown }>,
): Promise<{ status: number; body: unknown; replay?: boolean }> {
  // Bước 1: Đọc header idempotency-key; nếu không bắt buộc và không có key thì thực thi handler trực tiếp
  const key = request.headers.get("idempotency-key");
  if (required && !key) throw err.validation("Idempotency-Key is required.");
  if (!key) return handler();
  // Bước 2: Tạo mã băm SHA-256 từ method, đường dẫn URL và body của request để phát hiện nếu dùng cùng key nhưng gửi nội dung khác
  const uid = userId ?? "00000000-0000-0000-0000-000000000000";
  const raw = await request.clone().text();
  const hash = sha256(`${request.method}:${new URL(request.url).pathname}:${raw}`);

  // Bước 3: Kiểm tra trong bộ nhớ xem có request nào cùng key đang được xử lý đồng thời (in-flight) hay không
  const flightKey = `${uid}:${key}`;
  const existingFlight = inFlightIdempotency.get(flightKey);
  if (existingFlight) {
    // Báo lỗi 422 nếu cùng một key nhưng nội dung request khác nhau
    if (existingFlight.hash !== hash) {
      throw err.validation("Idempotency-Key was already used for a different request.");
    }
    // Chờ request đang bay hoàn tất và trả về cùng kết quả (replay), tránh gọi handler hai lần song song
    const res = await existingFlight.promise;
    return { status: res.status, body: res.body, replay: true };
  }

  // Bước 4: Tra cứu database bảng idempotency_keys để xem request này đã từng thực hiện thành công chưa
  const existing = await one<{
    request_hash: string;
    response_code: number;
    response_body: unknown;
    expires_at: string;
  }>(
    sql,
    `select request_hash, response_code, response_body, expires_at::text
       from idempotency_keys where user_id = $1 and key = $2`,
    [uid, key],
  );
  // Nếu bản ghi cũ còn hạn sử dụng (trong vòng 24 giờ), kiểm tra hash và trả ngay kết quả đã lưu mà không chạy lại
  if (existing && new Date(existing.expires_at) > new Date()) {
    if (existing.request_hash !== hash) {
      throw err.validation("Idempotency-Key was already used for a different request.");
    }
    return { status: existing.response_code, body: existing.response_body, replay: true };
  }
  // Bước 5: Đóng gói việc thực thi handler và lưu kết quả vào database (hạn dùng 24 giờ) vào một Promise
  const promise = (async () => {
    const result = await handler();
    await sql.query(
      `insert into idempotency_keys
         (key, user_id, method, path, request_hash, response_code, response_body, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7::jsonb, now() + interval '24 hours')
       on conflict (user_id, key) do update
         set response_code = excluded.response_code,
             response_body = excluded.response_body,
             request_hash = excluded.request_hash`,
      [
        key,
        uid,
        request.method,
        new URL(request.url).pathname,
        hash,
        result.status,
        JSON.stringify(result.body),
      ],
    );
    return result;
  })();

  // Bước 6: Đưa Promise vào Map in-flight để các request đến sau có thể tái sử dụng, sau đó chờ hoàn thành
  inFlightIdempotency.set(flightKey, { hash, promise });
  try {
    return await promise;
  } finally {
    // Luôn dọn dẹp khỏi bộ nhớ trong khối finally khi request kết thúc (thành công hoặc thất bại)
    inFlightIdempotency.delete(flightKey);
  }
}

/**
 * Làm gì: Kiểm tra đệ quy chuỗi, mảng hoặc object để đảm bảo không chứa ký tự null byte (\u0000).
 *   Giúp ngăn ngừa lỗ hổng bảo mật null byte injection và tránh lỗi crash câu lệnh SQL của PostgreSQL.
 * Được gọi ở: Hàm readJson trong cùng file (trước khi trả về body JSON).
 * @param value Dữ liệu bất kỳ cần kiểm tra.
 * @returns Không trả về giá trị (void).
 * @throws err.validation (422) nếu chuỗi, key hoặc value của object chứa ký tự \u0000.
 */
function assertNoNul(value: unknown): void {
  // Bước 1: Kiểm tra chuỗi đơn lẻ; PostgreSQL không hỗ trợ ký tự null byte trong kiểu text
  if (typeof value === "string") {
    if (value.includes("\u0000")) {
      throw err.validation("Text must not contain NUL characters.");
    }
  } else if (Array.isArray(value)) {
    // Bước 2: Nếu là mảng thì đệ quy kiểm tra từng phần tử bên trong
    for (const item of value) {
      assertNoNul(item);
    }
  } else if (value !== null && typeof value === "object") {
    // Bước 3: Nếu là object thì đệ quy kiểm tra cả tên thuộc tính (key) lẫn giá trị (value)
    for (const [k, v] of Object.entries(value)) {
      if (k.includes("\u0000")) {
        throw err.validation("Text must not contain NUL characters.");
      }
      assertNoNul(v);
    }
  }
}

/**
 * Làm gì: Đọc và parse an toàn body của HTTP Request thành đối tượng JSON (Record<string, unknown>), đồng thời kiểm tra tính hợp lệ và lọc ký tự độc hại.
 * Được gọi ở: Hầu hết các controller handler trong src/server/controllers/handlers/*.ts (như bookings, auth, ops, classes...) và src/server/controllers/tx.test.ts.
 * @param request HTTP Request cần đọc nội dung JSON.
 * @returns Đối tượng chứa các trường dữ liệu được parse từ body, hoặc object rỗng {} nếu không có body.
 * @throws err.validation (422) nếu cú pháp JSON sai, body không phải là object hoặc chứa ký tự NUL byte.
 */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  // Bước 1: Đọc toàn bộ nội dung body dưới dạng chuỗi; nếu body rỗng thì trả về object trống {}
  const text = await request.text();
  if (!text) return {};
  // Bước 2: Parse chuỗi JSON và bắt lỗi cú pháp để trả mã lỗi 422 thân thiện thay vì làm sập server
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw err.validation("Invalid JSON body.");
  }
  // Bước 3: Đảm bảo dữ liệu cấp cao nhất phải là một JSON object, từ chối mảng hoặc các giá trị nguyên thủy
  if (data === null || typeof data !== "object") {
    throw err.validation("Request body must be a JSON object.");
  }
  // Bước 4: Kiểm tra đệ quy loại trừ ký tự NUL byte trước khi bàn giao cho các tầng xử lý nghiệp vụ
  assertNoNul(data);
  return data as Record<string, unknown>;
}

/**
 * Làm gì: Chuẩn hóa chuỗi bằng cách cắt tỉa khoảng trắng hai đầu (trim); trả về undefined nếu dữ liệu không phải kiểu string.
 * Được gọi ở: Rộng rãi trong các handler tại src/server/controllers/handlers/*.ts để xử lý an toàn input người dùng.
 * @param v Giá trị đầu vào bất kỳ chưa rõ kiểu.
 * @returns Chuỗi đã được trim nếu hợp lệ, ngược lại trả về undefined.
 */
export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v.trim() : undefined;
}
/**
 * Làm gì: Chuyển đổi an toàn giá trị bất kỳ thành số hữu hạn (finite number), chấp nhận cả kiểu number hoặc chuỗi số.
 * Được gọi ở: Các handler như bookings.ts, classes.ts, sports.ts để đọc giá tiền, số lượng hoặc tham số số học.
 * @param v Giá trị đầu vào bất kỳ (số, chuỗi số hoặc kiểu khác).
 * @returns Số hợp lệ dạng number, hoặc undefined nếu không phải số hoặc là NaN/Infinity.
 */
export function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
/**
 * Làm gì: Trích xuất giá trị boolean an toàn từ dữ liệu chưa rõ kiểu.
 * Được gọi ở: Các handler như plans.ts, promos.ts để đọc các cờ trạng thái (active, peak_only...).
 * @param v Giá trị đầu vào bất kỳ.
 * @returns Giá trị boolean nếu đúng kiểu boolean, ngược lại trả về undefined.
 */
export function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  return undefined;
}

export { ageYears } from "../../shared/arena3/time";

// Cấu trúc mẫu lịch lặp hàng tuần của lớp học gồm quy tắc lặp (rrule), thời lượng mỗi buổi và khoảng ngày bắt đầu/kết thúc
export type ClassPattern = { rrule: string; duration_min: number; start_on: string; end_on: string };

/** True when two weekly classes meet on at least one same date at overlapping hours. */
export function classPatternsClash(a: ClassPattern, b: ClassPattern) {
  // Bước 1: Xác định khoảng thời gian giao thoa giữa hai lớp học (từ ngày bắt đầu muộn hơn đến ngày kết thúc sớm hơn)
  const from = a.start_on > b.start_on ? a.start_on : b.start_on;
  const to = a.end_on < b.end_on ? a.end_on : b.end_on;
  if (from > to) return false;
  // Bước 2: Phân tích quy tắc lặp rrule của cả hai lớp để lấy giờ bắt đầu và danh sách các ngày trong tuần
  const pa = parseWeeklyRrule(a.rrule);
  const pb = parseWeeklyRrule(b.rrule);
  // Bước 3: Đổi giờ bắt đầu ra số phút trong ngày để kiểm tra xem khung giờ hai lớp có chồng lấn nhau không
  const aStart = pa.hour * 60;
  const bStart = pb.hour * 60;
  if (!(aStart < bStart + b.duration_min && bStart < aStart + a.duration_min)) return false;
  // Bước 4: Duyệt qua tối đa 7 ngày đầu của khoảng giao thoa để kiểm tra xem có ngày trong tuần nào cả hai lớp cùng diễn ra không
  const codes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  // Only weekdays that really fall inside the shared date range count.
  let day = from;
  for (let i = 0; i < 7 && day <= to; i++, day = addDays(day, 1)) {
    const code = codes[new Date(`${day}T00:00:00Z`).getUTCDay()]!;
    if (pa.days.includes(code) && pb.days.includes(code)) return true;
  }
  return false;
}

/** BR-63: a member may be in at most `max` classes at once (held or confirmed, class not over). */
export async function assertUnderClassLimit(sql: Sql, userId: string, classId: string, max: number) {
  // Bước 1: Đếm số lượng lớp học đang tham gia (trạng thái 'confirmed' hoặc 'hold') mà chưa kết thúc theo giờ Việt Nam
  const row = await one<{ n: number }>(
    sql,
    `select count(*)::int as n
       from enrollments e join classes c on c.id = e.class_id
      where e.user_id = $1 and e.class_id <> $2 and e.status in ('confirmed','hold')
        and c.end_on >= (now() at time zone 'Asia/Ho_Chi_Minh')::date`,
    [userId, classId],
  );
  // Bước 2: Áp dụng quy tắc BR-63, ném lỗi nếu học viên đã đạt hoặc vượt quá giới hạn số lớp tối đa được tham gia cùng lúc
  if ((row?.n ?? 0) >= max) {
    throw err.br("BR-63", `You are already in ${max} classes, the most at once. Leave one to join another.`);
  }
}

/**
 * Làm gì: Kiểm tra xung đột lịch học của học viên theo quy tắc BR-22 (cả trên các buổi sessions cụ thể đã lên lịch và mẫu lặp rrule dài hạn).
 * Được gọi ở: src/server/controllers/handlers/classes.ts (khi giữ chỗ hoặc xác nhận ghi danh lớp) và src/server/controllers/handlers/ops.ts (khi chuyển lớp).
 * @param sql Đối tượng kết nối DB hoặc transaction để thực thi câu lệnh SQL.
 * @param userId ID người dùng cần kiểm tra lịch học.
 * @param classId ID lớp học mà người dùng dự định đăng ký.
 * @returns Không trả về giá trị nếu không bị trùng lịch (void).
 * @throws err.br("BR-22") (409) nếu phát hiện trùng lịch với một lớp học khác mà người dùng đang theo học.
 */
export async function assertNoClassClash(sql: Sql, userId: string, classId: string) {
  // Bước 1: Kiểm tra va chạm khung giờ thực tế (toán tử && trên khoảng thời gian tstzrange) giữa các buổi học (sessions) đã sinh sẵn
  const overlap = await one(
    sql,
    `select 1
       from sessions s
       join enrollments e on e.class_id = s.class_id and e.user_id = $1 and e.status in ('confirmed','hold')
      where e.class_id <> $2
        and s.status = 'scheduled'
        and exists (
          select 1 from sessions s2
           where s2.class_id = $2 and s2.status = 'scheduled'
             and tstzrange(s.start_at, s.end_at, '[)') && tstzrange(s2.start_at, s2.end_at, '[)')
        )
      limit 1`,
    [userId, classId],
  );
  // Báo lỗi quy tắc BR-22 nếu phát hiện buổi học cụ thể bị trùng giờ
  if (overlap) throw err.br("BR-22", "This clashes with another class you are in.");
  // Sessions are only laid out two weeks ahead, so the weekly timetables are compared too.
  // Bước 2: Vì session chỉ được tạo trước 2 tuần, truy vấn thêm mẫu lặp tuần (rrule) của lớp đích và các lớp học viên đang tham gia để kiểm tra dài hạn
  const target = await one<ClassPattern>(
    sql,
    `select rrule, duration_min, start_on::text, end_on::text from classes where id = $1`,
    [classId],
  );
  const others = await sql.query<ClassPattern>(
    `select cl.rrule, cl.duration_min, cl.start_on::text, cl.end_on::text
       from classes cl
       join enrollments e on e.class_id = cl.id and e.user_id = $1 and e.status in ('confirmed','hold')
      where cl.id <> $2 and cl.status <> 'cancelled'`,
    [userId, classId],
  );
  // Bước 3: So sánh quy tắc lặp rrule của lớp cần đăng ký với tất cả các lớp khác đang theo học
  if (target && (others as ClassPattern[]).some((o) => classPatternsClash(target, o))) {
    throw err.br("BR-22", "This clashes with another class you are in.");
  }
}

// Định nghĩa kiểu ngữ cảnh request (Context) gồm kết nối DB sql, đối tượng Request và thông tin người dùng đã xác thực
export type Ctx = { sql: Sql; request: Request; user: PublicUser | null };

/**
 * Làm gì: Helper hỗ trợ xây dựng mệnh đề SET động cho các câu lệnh SQL UPDATE (chỉ cập nhật những cột có giá trị mới thay đổi).
 * Được gọi ở: src/server/controllers/handlers/promos.ts và src/server/controllers/handlers/training.ts.
 * @param params Mảng tham số SQL ban đầu (thường chứa sẵn ID điều kiện WHERE $1).
 * @returns Đối tượng gồm mảng mệnh đề sets (dạng "col = $N"), mảng params và hàm add để thêm cột cần cập nhật.
 */
export function sqlPatch(params: unknown[]) {
  // Bước 1: Khởi tạo mảng lưu danh sách các biểu thức gán giá trị cột (ví dụ: ["name = $2", "price = $3::int"])
  const sets: string[] = [];
  // Bước 2: Cung cấp hàm add để thêm một cột vào danh sách cập nhật, tự động đánh số thứ tự tham số $N theo độ dài mảng params
  function add(column: string, value: unknown, cast = "") {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  }
  // Bước 3: Trả về đối tượng chứa mảng sets, mảng params đã cập nhật và hàm add
  return { sets, params, add };
}

/**
 * Shape a paged query's rows (selected with `count(*) over ()::int as total`) into
 * `{ items, total, limit, offset }`. Past the last page there are no rows to read the total
 * from, so `recount` answers instead; the client then steps back to the real last page.
 */
export async function pageOf<T extends { total: number }>(
  rows: T[],
  page: { limit: number; offset: number },
  recount: () => Promise<number>,
): Promise<{ items: Omit<T, "total">[]; total: number; limit: number; offset: number }> {
  // Bước 1: Lấy tổng số dòng từ cột total của dòng đầu tiên; nếu vượt quá trang cuối (mảng rows rỗng) thì gọi hàm recount để đếm lại
  const total = rows.length ? Number(rows[0]!.total) : page.offset > 0 ? await recount() : 0;
  // Bước 2: Tách bỏ trường total tạm thời khỏi từng phần tử và trả về cấu trúc phân trang chuẩn { items, total, limit, offset }
  return {
    items: rows.map(({ total: _t, ...r }) => r),
    total,
    limit: page.limit,
    offset: page.offset,
  };
}
