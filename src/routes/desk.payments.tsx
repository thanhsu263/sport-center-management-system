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


export const Route = createFileRoute("/desk/payments")({
  component: Page,
});

/* With one method in the list the icon was decoration; with four it is how you
   scan the column without reading every line. */
function MethodIcon({ method }: { method: string }) {
  const Icon =
    method === "cash" ? Banknote : method === "card" ? CreditCard : method === "quota" ? Ticket : Landmark;
  return <Icon className="size-4 shrink-0 text-muted" />;
}

function Page() {
  const {
    isManager, days, setDays, payMethod, setPayMethod, receiptQuery, setReceiptQuery,
    receiptPaging, onlineOn, shiftRead, method, setMethod, busy, setPromo, read, data, awaiting,
    orders, refunds, payouts, receiptPage, toCollect, canTake, noTill, refresh, dueOf,
    transferTarget, setTransferTarget, takePayment, decline, settleTransfer, confirmSeat,
    settleRefund, payOut,
  } = useDeskPayments();

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
            const settled = due === 0;
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
                              setPromo((m) => ({ ...m, [o.id]: q ? { code: q.code, discount_vnd: q.discount_vnd } : null }))
                            }
                          />
                        </div>
                      ) : null}

                      <div className="mt-4 flex flex-wrap items-center gap-2">
                        <Select
                          className="w-auto"
                          value={method[o.id] ?? "cash"}
                          onChange={(e) => setMethod((m) => ({ ...m, [o.id]: e.target.value }))}
                          aria-label={t("Payment method for {name}", { name: o.full_name })}
                        >
                          <option value="cash">{t("Cash")}</option>
                          <option value="transfer">{t("Bank transfer")}</option>
                          <option value="card">{t("Card")}</option>
                        </Select>
                        <StarBorder speed={4}>
                          <Button
                            disabled={busy === o.id || !canTake || settled}
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
                          disabled={busy === o.id || o.paid_vnd > 0}
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
            {t("The centre cancelled these classes. Mark a refund paid when the member has the cash.")} {canTake ? null : t("Open a till shift first.")}
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
                <Button disabled={!canTake || busy === r.id} onClick={() => void payOut(r)}>
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
                      disabled={!isManager || busy === r.id}
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
          code={transferTarget.member_code ?? transferTarget.id.slice(-6).toUpperCase()}
          buyerName={transferTarget.full_name}
          refType="subscription"
          refId={transferTarget.id}
          onConfirmManual={async () => {
            const target = transferTarget;
            setTransferTarget(null);
            await takePayment(target, "transfer");
          }}
          onPaid={refresh}
        />
      ) : null}
    </Shell>
  );
}
