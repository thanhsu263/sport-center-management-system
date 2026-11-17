/**
 * File: src/routes/desk.payments.tsx
 * Vai trò: Trang quản lý thanh toán, chuyển khoản, hoàn tiền và tra cứu biên lai tại quầy thu ngân (Front Desk) và cho Quản lý (Manager).
 * Vị trí trong app: Route "/desk/payments", phục vụ nhân viên quầy thu tiền gói tập, xác nhận chuyển khoản giữ chỗ sân/lớp, chi trả/duyệt hoàn tiền và theo dõi dòng tiền qua biên lai.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { SectionTitle } from "@/client/components/section";
import { ArrowUpRight, Banknote, Clock3, CreditCard, Landmark, Ticket, Undo2 } from "lucide-react";
import { HoldTimer } from "@/client/components/media";
import { PayOnlineButton } from "@/client/components/pay-online";
import { TransferQrModal } from "@/client/components/transfer-qr-modal";
import { Shell, money, when } from "@/client/components/shell";
import { PageHero } from "@/client/components/page-hero";
import { Badge, Button, ButtonLink, Card, EmptyState, Input, LoadError, Pagination, Seg, Select, Skeleton } from "@/client/components/ui";
import { Lift, Reveal, Stagger, StaggerItem, motion } from "@/client/components/motion";
import { GLBackground, SpotlightCard, StarBorder } from "@/client/components/fx";
import { PromoInput } from "@/client/components/promo-input";
import { openInvoice } from "@/client/arena3/client";
import { levelLabel, refTypeLabel, sportLabel } from "@/shared/arena3/labels";
import { t, tData } from "@/client/lib/i18n";
import { useDeskPayments, METHODS, methodLabel, daysWaiting } from "@/client/lib/pages/desk.payments";


/**
 * Làm gì: Định nghĩa route "/desk/payments" trong TanStack Router, liên kết URL với component hiển thị Page.
 * Được gọi ở: TanStack Router qua URL "/desk/payments" (được đăng ký trong src/routeTree.gen.ts).
 * @returns Đối tượng cấu hình route của TanStack Router liên kết với component Page.
 */
export const Route = createFileRoute("/desk/payments")({
  component: Page,
});

/* With one method in the list the icon was decoration; with four it is how you
   scan the column without reading every line. */
/**
 * Làm gì: Hiển thị icon tương ứng với từng phương thức thanh toán (tiền mặt, thẻ, vé lượt hoặc chuyển khoản ngân hàng) để nhận diện nhanh trong danh sách biên lai.
 * Được gọi ở: src/routes/desk.payments.tsx (bên trong danh sách biên lai receiptPage của component Page).
 * @param method Tên phương thức thanh toán ("cash", "card", "quota", hoặc chuyển khoản).
 * @returns Element React chứa icon Lucide tương ứng.
 */
function MethodIcon({ method }: { method: string }) {
  // Chọn icon biểu diễn trực quan: Banknote (tiền mặt), CreditCard (thẻ), Ticket (vé lượt), Landmark (chuyển khoản)
  const Icon =
    method === "cash" ? Banknote : method === "card" ? CreditCard : method === "quota" ? Ticket : Landmark;
  return <Icon className="size-4 shrink-0 text-muted" />;
}

/**
 * Làm gì: Component trang quản lý thanh toán tại quầy lễ tân ("/desk/payments"), xử lý các đơn đặt gói tập chờ thu tiền, duyệt chuyển khoản giữ chỗ sân/lớp, duyệt hoàn tiền và tra cứu biên lai.
 * Được gọi ở: TanStack Router khi người dùng truy cập URL "/desk/payments".
 * @returns Giao diện React hiển thị toàn bộ nghiệp vụ thanh toán quầy thu ngân.
 */
function Page() {
  // Bước 1: Lấy toàn bộ dữ liệu nghiệp vụ thanh toán và các hàm xử lý từ custom hook useDeskPayments
  const {
    isManager, days, setDays, payMethod, setPayMethod, receiptQuery, setReceiptQuery,
    receiptPaging, onlineOn, shiftRead, method, setMethod, busy, setPromo, read, data, awaiting,
    orders, refunds, payouts, receiptPage, toCollect, canTake, noTill, refresh, dueOf,
    transferTarget, setTransferTarget, takePayment, decline, settleTransfer, confirmSeat,
    settleRefund, payOut,
  } = useDeskPayments();

  // Bước 2: Render giao diện quản lý thanh toán trong khung Shell (phân quyền manager/receptionist) gồm banner, thống kê, cảnh báo ca trực, các danh sách chờ xử lý và bảng biên lai
  return (
    <Shell role={isManager ? "manager" : "receptionist"}>
      <PageHero
        slot="banner.gate"
        title={t("Payments & refunds")}
        subtitle={t("Orders waiting for payment, posted receipts, and audit trail.")}
      />
      <GLBackground
        variant="dotgrid"
        position="fixed"
        className="-z-[1]"
        color="#3f7d20"
        gap={32}
        dot={1.5}
        radius={130}
        opacity={0.22}
      />

      <Reveal
        className="mb-6 flex flex-wrap items-center gap-2 rounded-[var(--radius-lg)] bg-surface p-3 shadow-[var(--shadow-border)]"
        from="down"
      >
        {/* "0 waiting · 0đ to collect" is a claim; until the queue has answered there is nothing to claim. */}
        {data ? (
          <Badge tone={orders.length ? "accent" : "muted"}>
            {t("{n} waiting · {amount} to collect", { n: orders.length, amount: money(toCollect) })}
          </Badge>
        ) : read.error ? null : (
          <Skeleton className="h-6 w-40" />
        )}
        {awaiting.length ? (
          <Badge tone="hold">{t("{n} transfers to check", { n: awaiting.length })}</Badge>
        ) : null}
        {refunds.length ? <Badge tone="danger">{t("{n} refunds to sign off", { n: refunds.length })}</Badge> : null}
        {/*
          Point at the button rather than describing where it lives. The hint
          used to say "open a shift at the desk" and then leave the reader to
          find it.
        */}
        {noTill ? (
          <Link to="/desk" className="hit">
            <Badge tone="hold">{t("No shift open. Open one to take payment.")}</Badge>
          </Link>
        ) : null}
        {/* A manager came here from the manager menu, so "back" is their own
            home — `/desk` is the receptionist's counter, with a till they do not run. */}
        <ButtonLink to={isManager ? "/manager" : "/desk"} variant="outline" className="ml-auto">
          {isManager ? t("Back to reports") : t("Back to the desk")}
        </ButtonLink>
      </Reveal>

      {/* The till could not be looked up, so "take payment" stays off until it can be — said here, not by a button that is silently dead. */}
      {shiftRead.error ? (
        <div className="mb-6">
          <LoadError
            message={shiftRead.error.message}
            onRetry={shiftRead.error.refused ? undefined : shiftRead.reload}
          />
        </div>
      ) : null}

      {/* One alert for the whole queue: the transfers, orders, refunds and receipts all come from the same answer. */}
      {read.error ? (
        <div className="mb-6">
          <LoadError message={read.error.message} onRetry={read.error.refused ? undefined : read.reload} />
        </div>
      ) : null}

      {awaiting.length ? (
        <div className="mb-10">
          <SectionTitle text={t("Transfers to check")} className="font-display text-2xl" />
          <p className="mt-1 text-sm text-muted">
            {t("A member said they would transfer, and their court or class seat is being held for them. Find the money on the statement before you confirm. Nothing has been posted yet.")}
          </p>
          <Stagger className="mt-3 grid gap-3" gap={0.05}>
            {awaiting.map((a) =>
              "kind" in a ? (
                <StaggerItem key={a.id}>
                  <Lift>
                    <SpotlightCard className="rounded-[var(--radius-xl)]" size={420} strength={0.1}>
                      <Card className="relative z-[2] border border-hold/30 p-5">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="flex flex-wrap items-center gap-2">
                              <Clock3 className="size-4 text-hold" />
                              <h3 className="font-display text-xl">{a.member_name ?? t("Walk-in")}</h3>
                              <Badge tone="hold">
                                <HoldTimer until={a.hold_until} onExpire={refresh} /> {t("left")}
                              </Badge>
                            </div>
                            <p className="mt-1 text-xs tabular-nums text-muted">
                              {a.member_code ?? t("No code yet")}
                              {a.phone ? ` · ${a.phone}` : ""} · {t("asked {time}", { time: when(a.transfer_requested_at) })}
                            </p>
                            <p className="mt-2 text-sm">
                              {t("Class seat")} · {sportLabel(a.sport)} · {levelLabel(a.level)}
                            </p>
                          </div>
                          <p className="font-display text-2xl tabular-nums">{money(a.amount_vnd)}</p>
                        </div>
                        <div className="mt-4 flex flex-wrap items-center gap-2">
                          <Select
                            className="w-auto"
                            value={method[a.id] ?? "transfer"}
                            onChange={(e) => setMethod((m) => ({ ...m, [a.id]: e.target.value }))}
                            aria-label={t("Payment method for {name}", { name: a.member_name ?? t("Walk-in") })}
                          >
                            <option value="transfer">{t("Bank transfer")}</option>
                            <option value="cash">{t("Cash")}</option>
                            <option value="card">{t("Card")}</option>
                          </Select>
                          <StarBorder speed={4}>
                            <Button disabled={busy === a.id || !canTake} onClick={() => void confirmSeat(a)}>
                              {t("Money received: confirm")}
                            </Button>
                          </StarBorder>
                        </div>
                      </Card>
                    </SpotlightCard>
                  </Lift>
                </StaggerItem>
              ) : (
              <StaggerItem key={a.id}>
                <Lift>
                  <SpotlightCard className="rounded-[var(--radius-xl)]" size={420} strength={0.1}>
                    <Card className="relative z-[2] border border-hold/30 p-5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <Clock3 className="size-4 text-hold" />
                            <h3 className="font-display text-xl">{a.member_name ?? t("Walk-in")}</h3>
                            <Badge tone="hold">
                              <HoldTimer until={a.hold_until} onExpire={refresh} /> {t("left")}
                            </Badge>
                          </div>
                          <p className="mt-1 text-xs tabular-nums text-muted">
                            {a.member_code ?? t("No code yet")}
                            {a.phone ? ` · ${a.phone}` : ""} · {t("asked {time}", { time: when(a.transfer_requested_at) })}
                          </p>
                          <p className="mt-2 text-sm">
                            {a.code} · {a.court_code} · {sportLabel(a.sport)} ·{" "}
                            {when(a.start_at)}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-display text-2xl tabular-nums">
                            {money(a.price_vnd)}
                          </p>
                          {a.deposit_vnd > 0 && a.deposit_vnd < a.price_vnd ? (
                            <p className="text-xs text-muted">
                              {t("Deposit (of {total})", { total: money(a.price_vnd) })}
                            </p>
                          ) : null}
                        </div>
                      </div>
                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <StarBorder speed={4}>
                          <Button disabled={busy === a.id} onClick={() => void settleTransfer(a, true)}>
                            {t("Money received: confirm")}
                          </Button>
                        </StarBorder>
                        <Button
                          variant="outline"
                          disabled={busy === a.id}
                          onClick={() => void settleTransfer(a, false)}
                        >
                          {t("Not found: release")}
                        </Button>
                      </div>
                    </Card>
                  </SpotlightCard>
                </Lift>
              </StaggerItem>
              ),
            )}
          </Stagger>
        </div>
      ) : null}

      <SectionTitle text={t("Waiting for payment")} className="font-display text-2xl" />
      <p className="mt-1 text-sm text-muted">
        {t("A member picked a plan in the app and still owes for it. Taking payment here activates the plan and prints the receipt.")}
      </p>
      {read.error ? null : !data ? (
        <div className="mt-3 grid gap-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
      ) : orders.length ? (
        <Stagger className="mt-3 grid gap-3" gap={0.06}>
          {orders.map((o) => {
            // Floored at zero. An order can only reach this state through a
            // part payment plus a price change, or a refund posted back against
            // it — rare, but a negative balance would render "Take -200,000đ"
            // and then ask the server to take a negative payment.
            const due = Math.max(0, dueOf(o) - o.paid_vnd);
            // Đơn hàng đã tất toán đủ tiền (due = 0) thì nút thu tiền sẽ bị vô hiệu hóa và hiển thị yêu cầu báo quản lý
            const settled = due === 0;
            // Tính số ngày hội viên chờ thanh toán từ ngày đặt trên app; nếu từ 3 ngày trở lên sẽ hiển thị huy hiệu cảnh báo tone="hold"
            const waited = daysWaiting(o.ordered_on);
            return (
              <StaggerItem key={o.id}>
                <Lift>
                  <SpotlightCard className="rounded-[var(--radius-xl)]" size={420} strength={0.1}>
                    <Card className="relative z-[2] p-5">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-display text-xl">{o.full_name}</h3>
                            {waited >= 3 ? (
                              <Badge tone="hold">{t("Waiting {n} days", { n: waited })}</Badge>
                            ) : null}
                          </div>
                          <p className="mt-1 text-xs tabular-nums text-muted">
                            {o.member_code ?? t("No code yet")} · {o.phone}
                          </p>
                          <p className="mt-2 text-sm">
                            {tData(o.plan_name)} · {t("runs to {date}", { date: o.end_on })}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-display text-2xl tabular-nums">{money(due)}</p>
                          {o.paid_vnd > 0 ? (
                            <p className="text-xs tabular-nums text-muted">
                              {t("{paid} of {total} already taken", { paid: money(o.paid_vnd), total: money(o.price_vnd) })}
                            </p>
                          ) : (
                            <p className="text-xs text-muted">{t("Ordered {date}", { date: o.ordered_on })}</p>
                          )}
                        </div>
                      </div>

                      {o.promo_code ? (
                        <p className="mt-2 text-xs text-accent">
                          {t("{code} already applied: −{amount}", { code: o.promo_code, amount: money(o.promo_discount_vnd) })}
                        </p>
                      ) : o.paid_vnd === 0 ? (
                        <div className="mt-3 max-w-xs">
                          <PromoInput
                            scope="plan"
                            compact
                            target={{ plan_id: o.plan_id, user_id: o.user_id }}
                            onChange={(q) =>
                              // Lưu mã giảm giá và số tiền chiết khấu theo từng đơn hàng vào state promo để trừ vào số tiền phải thu
                              setPromo((m) => ({ ...m, [o.id]: q ? { code: q.code, discount_vnd: q.discount_vnd } : null }))
                            }
                          />
                        </div>
                      ) : null}

                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <Select
                          className="w-auto"
                          value={method[o.id] ?? "cash"}
                          // Cập nhật phương thức thanh toán nhân viên chọn (tiền mặt, chuyển khoản, thẻ) riêng cho từng đơn hàng
                          onChange={(e) => setMethod((m) => ({ ...m, [o.id]: e.target.value }))}
                          aria-label={t("Payment method for {name}", { name: o.full_name })}
                        >
                          <option value="cash">{t("Cash")}</option>
                          <option value="transfer">{t("Bank transfer")}</option>
                          <option value="card">{t("Card")}</option>
                        </Select>
                        <StarBorder speed={4}>
                          <Button
                            // Vô hiệu hóa nút nếu đang xử lý đơn, quầy lễ tân chưa mở ca trực két tiền, hoặc đơn đã thanh toán xong
                            disabled={busy === o.id || !canTake || settled}
                            // Thu tiền: nếu chọn chuyển khoản sẽ mở modal QR VietQR; nếu là tiền mặt/thẻ sẽ ghi nhận thanh toán và in biên lai
                            onClick={() => void takePayment(o)}
                          >
                            {settled
                              ? t("Paid in full: ask a manager")
                              : noTill
                                ? t("Open a shift first")
                                : (method[o.id] === "transfer"
                                    ? t("Show transfer QR · {amount}", { amount: money(due) })
                                    : t("Take {amount} & print", { amount: money(due) }))}
                          </Button>
                        </StarBorder>
                        <ButtonLink to="/desk/member/$id" params={{ id: o.user_id }} variant="outline">
                          {t("Profile")} <ArrowUpRight className="ml-1 size-4" />
                        </ButtonLink>
                        {onlineOn && !settled && due > 0 ? (
                          <PayOnlineButton
                            // Nút gửi liên kết thanh toán online (payOS) cho hội viên khi hệ thống đã cấu hình cổng thanh toán và đơn chưa trả đủ
                            refType="subscription"
                            refId={o.id}
                            label={t("Online link")}
                            size="sm"
                            variant="ghost"
                            onPaid={refresh}
                          />
                        ) : null}
                        <Button
                          variant="ghost"
                          className="ml-auto"
                          // Quy tắc nghiệp vụ: Chỉ cho phép xóa đơn khỏi hàng đợi nếu chưa thanh toán đồng nào (paid_vnd === 0)
                          disabled={busy === o.id || o.paid_vnd > 0}
                          // Từ chối và hủy đơn mua gói tập qua API /subscriptions/:id/decline rồi xóa khỏi hàng đợi thu ngân
                          onClick={() => void decline(o)}
                        >
                          {t("Clear")}
                        </Button>
                      </div>
                    </Card>
                  </SpotlightCard>
                </Lift>
              </StaggerItem>
            );
          })}
        </Stagger>
      ) : (
        <div className="mt-3">
          <EmptyState title={t("Nothing to collect")} hint={t("Every plan ordered in the app has been paid for.")} />
        </div>
      )}

      {payouts.length ? (
        <div className="mt-10">
          <SectionTitle text={t("Cash to hand back")} className="font-display text-2xl" />
          <p className="mt-1 text-sm text-muted">
            {t("Hand refunds back in cash at the front desk. Mark paid only after handing over the cash.")} {canTake ? null : t("Open a till shift first.")}
          </p>
          <div className="mt-3 grid gap-3">
            {payouts.map((r) => (
              <Card key={r.id} className="flex flex-wrap items-center justify-between gap-3 p-5">
                <div>
                  <div className="flex items-center gap-2">
                    <Undo2 className="size-4 text-muted" />
                    <span className="font-medium">{r.member_name ?? t("Walk-in")}</span>
                    <Badge tone="danger">{money(Math.abs(r.amount_vnd))}</Badge>
                  </div>
                  <p className="mt-1 text-xs tabular-nums text-muted">
                    {r.code} · {refTypeLabel(r.ref_type)} · {when(r.created_at)}
                  </p>
                </div>
                <Button disabled={!canTake || isManager || busy === r.id} onClick={() => void payOut(r)}>
                  {t("Mark as paid")}
                </Button>
              </Card>
            ))}
          </div>
        </div>
      ) : null}

      {refunds.length ? (
        <div className="mt-10">
          <SectionTitle text={t("Refunds waiting for a manager")} className="font-display text-2xl" />
          <p className="mt-1 text-sm text-muted">
            {t("Raised at the desk above the receptionist limit.")} {isManager ? t("Sign them off here.") : t("A manager has to sign these off.")}
          </p>
          <Stagger className="mt-3 grid gap-3" gap={0.05}>
            {refunds.map((r) => (
              <StaggerItem key={r.id}>
                <Card className="flex flex-wrap items-center justify-between gap-3 p-5">
                  <div>
                    <div className="flex items-center gap-2">
                      <Undo2 className="size-4 text-muted" />
                      <span className="font-medium">{r.member_name ?? t("Walk-in")}</span>
                      <Badge tone="danger">{money(Math.abs(r.amount_vnd))}</Badge>
                    </div>
                    <p className="mt-1 text-xs tabular-nums text-muted">
                      {r.code} · {refTypeLabel(r.ref_type)} · {t("raised by {name}", { name: r.raised_by ?? "-" })} · {when(r.created_at)}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      // Chỉ Quản lý (Manager) mới có quyền từ chối hoàn tiền; không thể từ chối nếu đây là khoản trung tâm nợ hội viên (centre_owed)
                      disabled={!isManager || r.centre_owed || busy === r.id}
                      // Quản lý từ chối yêu cầu hoàn tiền qua API reject-refund
                      onClick={() => void settleRefund(r, false)}
                    >
                      {t("Reject")}
                    </Button>
                    <Button disabled={!isManager || busy === r.id} onClick={() => void settleRefund(r, true)}>
                      {t("Approve")}
                    </Button>
                  </div>
                </Card>
              </StaggerItem>
            ))}
          </Stagger>
        </div>
      ) : null}

      <div className="mt-10">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SectionTitle text={t("Receipts")} className="font-display text-2xl" />
          <div className="flex flex-wrap items-center gap-2">
            <span className="kicker text-2xs text-muted">{t("Paid by")}</span>
            <Seg value={payMethod} onChange={setPayMethod} options={METHODS.map((m) => ({ value: m.value, label: t(m.label) }))} />
            <span className="kicker ml-1 text-2xs text-muted">{t("Last")}</span>
            <Seg
              // Lọc biên lai theo khoảng thời gian gần nhất (7, 14 hoặc 30 ngày)
              value={days}
              onChange={setDays}
              options={[
                { value: "7", label: t("7 days") },
                { value: "14", label: t("14 days") },
                { value: "30", label: t("30 days") },
              ]}
            />
          </div>
        </div>
        <p className="mt-1 text-sm text-muted">
          {t("Every payment the centre has taken, however it was paid: cash at the counter, a card, a transfer off the statement, or a court settled in the app. Each one has its receipt here.")}
        </p>
        <Input
          className="mt-3 sm:max-w-sm"
          placeholder={t("Search name, phone or receipt no.")}
          value={receiptQuery}
          // Tìm kiếm biên lai theo tên, số điện thoại hoặc mã biên lai (tự động debounce 250ms trong hook useDeskPayments)
          onChange={(e) => setReceiptQuery(e.target.value)}
          aria-label={t("Search receipts")}
        />
        {read.error ? null : !data ? (
          <Skeleton className="mt-3 h-24" />
        ) : receiptPage.length ? (
          <Stagger key={receiptPaging.offset} className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-2" gap={0.04}>
            {receiptPage.map((rc) => (
              <StaggerItem key={rc.id}>
                <motion.div
                  className="flex flex-wrap items-center gap-3 rounded-[var(--radius-lg)] bg-surface px-4 py-3 shadow-[var(--shadow-border)]"
                  // Hiệu ứng dịch nhẹ sang phải khi di chuột qua hàng biên lai để tạo phản hồi thị giác
                  whileHover={{ x: 2 }}
                  transition={{ type: "spring", stiffness: 320, damping: 26 }}
                >
                  <MethodIcon method={rc.method} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium [overflow-wrap:anywhere]">{rc.member_name ?? t("Walk-in")}</p>
                    <p className="text-xs tabular-nums text-muted [overflow-wrap:anywhere]">
                      {rc.code} · {methodLabel(rc.method)} · {refTypeLabel(rc.ref_type)} · {when(rc.created_at)}
                      {rc.buyer_phone && !rc.member_code ? ` · ${rc.buyer_phone}` : ""}
                      {rc.taken_by ? ` · ${rc.taken_by}` : ""}
                    </p>
                  </div>
                  {/*
                    Who says this money arrived. "Manual" is a member of staff's
                    word — cash counted, a card slip, a statement read by eye.
                    "Auto" was confirmed by the payment provider's own API with
                    nobody asserting anything. A till that cannot tell the two
                    apart cannot be reconciled honestly, so the distinction is
                    on the row rather than buried in the record.
                  */}
                  <Badge tone={rc.capture_mode === "auto" ? "accent" : "muted"}>
                    {rc.capture_mode === "auto" ? t("Auto") : t("Manual")}
                  </Badge>
                  <span className="ml-auto font-medium tabular-nums">{money(rc.amount_vnd)}</span>
                  {rc.invoice_id ? (
                    <Button size="sm" variant="ghost" onClick={() => void openInvoice(rc.invoice_id!)}>
                      {t("Receipt")}
                    </Button>
                  ) : null}
                </motion.div>
              </StaggerItem>
            ))}
          </Stagger>
        ) : (
          <div className="mt-3">
            <EmptyState
              title={payMethod === "all" ? t("Nothing taken in this window") : t("No {method} in this window", { method: methodLabel(payMethod).toLowerCase() })}
              hint={t("Widen the range, or try another method.")}
            />
          </div>
        )}
        <Pagination
          // Phân trang danh sách biên lai phía client/server dựa theo tổng số bản ghi và kích thước trang đã chọn
          offset={receiptPaging.offset}
          total={data?.receipts_total ?? 0}
          pageSize={receiptPaging.pageSize}
          onChange={receiptPaging.setOffset}
          onPageSizeChange={receiptPaging.setPageSize}
          label={t("Receipt pages")}
        />
      </div>

      {transferTarget ? (
        <TransferQrModal
          open={!!transferTarget}
          onClose={() => setTransferTarget(null)}
          amountVnd={dueOf(transferTarget)}
          // Cú pháp nội dung chuyển khoản: ưu tiên dùng mã hội viên (member_code), nếu chưa có thì lấy 6 ký tự cuối của id đơn hàng viết hoa
          code={transferTarget.member_code ?? transferTarget.id.slice(-6).toUpperCase()}
          buyerName={transferTarget.full_name}
          refType="subscription"
          refId={transferTarget.id}
          // Xác nhận thanh toán chuyển khoản thủ công khi lễ tân đã kiểm tra thấy tiền vào tài khoản trên sao kê ngân hàng
          onConfirmManual={async () => {
            // Bước 1: Lưu tạm tham chiếu đơn hàng cần thanh toán trước khi reset state để tránh mất dữ liệu
            const target = transferTarget;
            // Bước 2: Đóng modal hiển thị mã QR bằng cách gán state transferTarget về null
            setTransferTarget(null);
            // Bước 3: Gửi yêu cầu thanh toán với phương thức "transfer" để hoàn tất ghi nhận giao dịch và in biên lai
            await takePayment(target, "transfer");
          }}
          onPaid={refresh}
        />
      ) : null}
    </Shell>
  );
}
