/**
 * Module dịch vụ quản lý điểm thưởng tích lũy (loyalty points) và hạng thành viên.
 * Tính toán số dư điểm dựa trên chi tiêu thực tế, quản lý phân hạng (bronze/silver/gold),
 * và đối soát thu hồi voucher/điểm khi phát sinh hoàn tiền (refund).
 */
import type { Sql } from "@/server/data/db";
import { getSettings } from "../controllers/helpers";
import { one } from "../controllers/tx";

// Bảng phân hạng thành viên theo số điểm tích lũy trọn đời (lifetime points) tối thiểu: gold (>= 600), silver (>= 200), bronze (>= 0).
const TIERS = [
  { key: "gold", min: 600 },
  { key: "silver", min: 200 },
  { key: "bronze", min: 0 },
] as const;

/**
 * Làm gì: Tính toán số dư điểm thưởng (points), tổng điểm đã tích lũy (earned), tổng chi tiêu hợp lệ (spend_vnd), cùng hạng thành viên hiện tại (tier) và mốc điểm để lên hạng kế tiếp (next_tier).
 * Được gọi ở:
 * - src/server/controllers/handlers/extras.ts: hàm meLoyalty (GET /api/me/loyalty), memberLoyalty (GET /api/members/:id/loyalty), loyaltyRedeem (POST /api/me/loyalty/redeem), loyaltyAdjust (POST /api/members/:id/loyalty/adjust).
 * - src/server/services/loyalty.ts: hàm reconcileLoyaltyRefund.
 * - Test runner (node --test): src/server/services/business-gaps.test.ts.
 * @param sql Kết nối database hoặc transaction PostgreSQL đang thực thi.
 * @param userId ID của người dùng cần tính toán số dư điểm và hạng thành viên.
 * @param clamp Cờ khống chế số dư điểm không âm (mặc định là true). Đặt false khi đối soát hoàn tiền để phát hiện số dư âm cần bù trừ.
 * @returns Đối tượng chứa số dư điểm (points), điểm đã tích (earned), tổng tiền đã chi (spend_vnd), hạng hiện tại (tier), hạng kế tiếp (next_tier), cùng các tỷ lệ quy đổi điểm.
 */
export async function loyaltyBalance(sql: Sql, userId: string, clamp = true) {
  // Bước 1: Lấy cấu hình hệ thống về tỷ lệ tích điểm và đổi điểm (loyalty_earn_vnd, loyalty_redeem_vnd).
  const settings = await getSettings(sql);
  // Bước 2: Tính tổng tiền chi tiêu hợp lệ từ payments và tổng điểm điều chỉnh/đã dùng từ loyalty_adjustments.
  const row = await one<{ net: number; spent: number }>(
    sql,
    `select coalesce((select sum(amount_vnd) from payments
                       where user_id = $1 and status in ('posted','refund_pending')
                         -- 'day_pass' stays: day passes are no longer sold, but what a member already paid for them still counts toward loyalty.
                         and ref_type in ('booking','subscription','day_pass')), 0)::int as net,
            coalesce((select sum(points) from loyalty_adjustments where user_id = $1), 0)::int as spent`,
    [userId],
  );
  // Bước 3: Quy đổi tổng chi tiêu thành số điểm tích lũy và tính số dư điểm khả dụng.
  const earned = Math.floor((row?.net ?? 0) / settings.loyalty_earn_vnd);
  const adjust = row?.spent ?? 0;
  // Khi clamp = true thì giữ điểm >= 0 để hiển thị cho người dùng; khi clamp = false thì cho phép điểm âm để đối soát hoàn tiền.
  const points = clamp ? Math.max(0, earned + adjust) : earned + adjust;
  // Bước 4: Xác định hạng thành viên hiện tại và mốc điểm cần để thăng hạng kế tiếp (dựa trên điểm trọn đời lifetime).
  // Tier counts every point ever earned, so spending points never demotes a member.
  const lifetime = Math.max(0, earned) + Math.max(0, adjust);
  const tier = TIERS.find((t) => lifetime >= t.min)!;
  const idx = TIERS.indexOf(tier);
  const next = idx > 0 ? TIERS[idx - 1]! : null;
  // Bước 5: Trả về chi tiết số dư điểm, hạng thành viên và các thiết lập quy đổi.
  return {
    points,
    earned,
    spend_vnd: row?.net ?? 0,
    tier: tier.key,
    next_tier: next ? { key: next.key, need: Math.max(0, next.min - lifetime) } : null,
    earn_vnd: settings.loyalty_earn_vnd,
    redeem_vnd: settings.loyalty_redeem_vnd,
    // Mức điểm tối thiểu cho mỗi lần đổi voucher theo quy tắc nghiệp vụ BR-40.
    min_redeem: 50,
  };
}


/** Refund creation and redemption serialize on the same member, in their transaction. */
export async function reconcileLoyaltyRefund(sql: Sql, userId: string | null) {
  // Bước 1: Bỏ qua nếu không có userId (ví dụ khách vãng lai không có tài khoản hội viên).
  if (!userId) return;
  // Bước 2: Khóa dòng người dùng (for update) để tuần tự hóa các thao tác hoàn tiền và đổi điểm, tránh race condition.
  await sql.query(`select id from users where id = $1 for update`, [userId]);
  // Bước 3: Kiểm tra số dư điểm thực tế (clamp = false để phát hiện số dư bị âm sau khi hoàn tiền).
  let { points } = await loyaltyBalance(sql, userId, false);
  // Nếu điểm không bị âm thì không cần thu hồi voucher, kết thúc hàm.
  if (points >= 0) return;
  // Bước 4: Tìm các mã ưu đãi đổi từ điểm chưa dùng và chưa bị thu hồi, ưu tiên mã đổi gần nhất (mới nhất).
  const codes = await sql.query<{ id: string; code: string; points: number }>(
    `select p.id, p.code, la.points from loyalty_adjustments la
       join promotions p on p.id = la.promo_id
      where la.user_id = $1 and la.reason = 'redeem' and la.points < 0
        and not exists (select 1 from promotion_redemptions r where r.promo_id = p.id)
        and not exists (select 1 from loyalty_adjustments c
                         where c.promo_id = p.id and c.reason = 'correction')
      order by la.created_at desc, la.id desc for update of p`, [userId],
  );
  // Bước 5: Lần lượt vô hiệu hóa từng mã và hoàn điểm lại vào tài khoản cho đến khi số dư điểm không còn âm.
  for (const code of codes) {
    if (points >= 0) break;
    // Thu hồi mã ưu đãi bằng cách cập nhật thời hạn kết thúc về thời điểm hiện tại.
    await sql.query(`update promotions set ends_at = now() where id = $1`, [code.id]);
    // Ghi nhận bản ghi điều chỉnh (reason = 'correction') với số điểm dương để bù lại số điểm đã trừ khi đổi mã.
    await sql.query(
      `insert into loyalty_adjustments (user_id, points, reason, note, promo_id)
       values ($1,$2,'correction',$3,$4)`, [userId, -code.points, code.code, code.id],
    );
    // code.points mang giá trị âm (do điểm bị trừ lúc đổi voucher), nên trừ đi số âm sẽ làm tăng points dần về 0.
    points -= code.points;
  }
}
