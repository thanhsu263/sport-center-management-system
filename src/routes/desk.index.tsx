import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Dumbbell, Repeat, UserMinus, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SectionTitle } from "@/client/components/section";
import { Shell, money, when } from "@/client/components/shell";
import { PageHero } from "@/client/components/page-hero";
import { SportBadge } from "@/client/components/sports-ui";
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  Field,
  Input,
  LoadError,
  Modal,
  MoneyInput,
  Seg,
  Select,
  ShowMore,
  Skeleton,
  StatusBadge,
  Pagination,
} from "@/client/components/ui";
import { CountUp, Reveal, Stagger, StaggerItem, motion } from "@/client/components/motion";
import { GLBackground, SpotlightCard, StarBorder } from "@/client/components/fx";
import { freeHours, useNowMinute, type Court, type OccSlot } from "@/client/components/court-grid";
import { apiGet, apiPost, openInvoice } from "@/client/arena3/client";
import type { PaymentCreateResponse } from "@/shared/arena3/contracts";
import { todayISO, monthsLabel } from "@/shared/arena3/labels";
import { ageYears } from "@/shared/arena3/time";
import { UserAvatar } from "@/client/components/user-avatar";
import { t, tData, tServer } from "@/client/lib/i18n";
import { lastPageOffset } from "@/client/lib/paging";
import { usePageState } from "@/client/lib/use-page-state";
import { readError, useRead } from "@/client/lib/use-read";
import { useLimits } from "@/client/lib/use-centre";

export const Route = createFileRoute("/desk/")({
  component: Page,
});

type Hit = {
  id: string;
  full_name: string;
  phone: string;
  member_code: string | null;
  status: string;
  date_of_birth?: string | null;
  avatar_url?: string | null;
};

type Plan = {
  id: string;
  name: string;
  price_vnd: number;
  duration_days: number | null;
  duration_months: number | null;
};

type Ticket = {
  id: string;
  body: string;
  full_name: string | null;
  phone: string | null;
  created_at: string;
  // Only ever non-null under "All": the open queue is by definition unanswered.
  status: string;
  reply: string | null;
  replied_at: string | null;
  replied_by_name: string | null;
};
type ShiftNow = { shift: { id: string; opened_at: string } | null; totals?: { cash: number } | null };

/**
 * With a physical keyboard the desk can start typing the moment the page opens. On a phone or
 * tablet that would pop the on-screen keyboard up over the list before anyone touched anything.
 */
const hasKeyboard = () => typeof window !== "undefined" && window.matchMedia?.("(pointer: fine)").matches === true;

function Page() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Hit[]>([]);
  // Which text the list on screen is the answer to, so "no match" is only said about a search that came back.
  const [answered, setAnswered] = useState<string | null>(null);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [searchTry, setSearchTry] = useState(0);
  // `optional`: no open till is an ordinary answer here, not an error for the console.
  const shiftRead = useRead<ShiftNow>("/shifts/current?optional=1");
  // undefined = not known (still asking, or the question failed); null = asked, and no till is open.
  const shift =
    shiftRead.data === null
      ? undefined
      : shiftRead.data.shift
        ? { shift: shiftRead.data.shift, totals: shiftRead.data.totals ?? undefined }
        : null;
  const [form, setForm] = useState({ full_name: "", phone: "" });
  const [closeOpen, setCloseOpen] = useState(false);
  const [cash, setCash] = useState("");
  const ticketPage = usePageState("desk.tickets", 10);
  // The open queue is the day's work; "All" is for reading back what the desk
  // told somebody last week. The server has always supported `?status=all` —
  // nothing here asked for it, so answered requests were unreachable.
  const [ticketScope, setTicketScope] = useState<"open" | "all">("open");
  const ticketsRead = useRead<{ items: Ticket[]; total: number }>(
    `/tickets?limit=${ticketPage.pageSize}&offset=${ticketPage.offset}${ticketScope === "all" ? "&status=all" : ""}`,
    { keepPrevious: true },
  );
  // Straight from the server, with no local copy to drop rows from.
  //
  // Answering or closing used to splice the row out here as well as refetching.
  // That read as instant, but it lied twice: under "All" the request the desk
  // had just answered vanished from a list whose whole purpose is to show
  // answered requests, and an emptied page showed "the queue is clear" while
  // the paging effect below still saw the pre-refetch rows and stayed put.
  // `keepPrevious` already holds the old page on screen while the new one
  // loads, so nothing flashes.
  const tickets = ticketsRead.data?.items ?? [];
  const { offset: ticketOffset, pageSize: ticketSize, setOffset: setTicketOffset } = ticketPage;
  // Answering the last request on page three used to leave the desk on an empty
  // page with the pagination gone — the whole section was hidden when the list
  // ran out, so there was no way back. Follow the list down as it shrinks.
  useEffect(() => {
    const data = ticketsRead.data;
    if (!data || data.items.length > 0 || ticketOffset === 0) return;
    setTicketOffset(lastPageOffset(data.total, ticketSize));
  }, [ticketsRead.data, ticketOffset, ticketSize, setTicketOffset]);
  // Which request the desk is writing an answer to, and the answer so far. One
  // at a time: the box opens on the row being answered rather than sitting
  // under all of them, so it is obvious whose complaint is being replied to.
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);
  const plansRead = useRead<{ items: Plan[] }>("/plans");
  const plans = plansRead.data?.items ?? [];
  // Just the count — the queue itself lives one screen over, but a receptionist
  // has to be able to see from here that somebody is owed attention. A hint only: if it cannot
  // be read, the queue itself says why.
  const waiting = useRead<{ waiting: number }>("/payments/pending?brief=1").data?.waiting ?? 0;
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [newUser, setNewUser] = useState<{
    id: string;
    full_name: string;
    member_code?: string | null;
    temp_password?: string;
  } | null>(null);
  const [picked, setPicked] = useState<Plan | null>(null);
  const [subId, setSubId] = useState<string | null>(null);
  const [method, setMethod] = useState("cash");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSearchErr(null);
    if (q.trim().length < 3) {
      setItems([]);
      setAnswered(null);
      return;
    }
    // A reply to text that has since been changed must not land on the newer list.
    let stale = false;
    const timer = setTimeout(() => {
      apiGet<{ items: Hit[] }>(`/members?q=${encodeURIComponent(q)}`).then(
        (r) => {
          if (stale) return;
          setItems(r.items);
          setAnswered(q);
        },
        (e: unknown) => {
          if (stale) return;
          setItems([]);
          setAnswered(null);
          setSearchErr(readError(e).message);
        },
      );
    }, 180);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [q, searchTry]);

  function resetWizard() {
    setStep(1);
    setNewUser(null);
    setPicked(null);
    setForm({ full_name: "", phone: "" });
    setMethod("cash");
    setSubId(null);
  }

  return (
    <Shell role="receptionist">
      <PageHero
        slot="banner.gate"
        title={t("Front desk")}
        subtitle={t("Find a member, sell a plan, take payment.")}
      />
      {/* Kept well under the text: this console is stared at all shift, so the
          field is a texture, not a feature. */}
      <GLBackground
        variant="dotgrid"
        position="fixed"
        className="-z-[1]"
        color="#1e4fd8"
        gap={32}
        dot={1.5}
        radius={130}
        opacity={0.22}
      />
      <Reveal className="mb-5 flex flex-wrap items-center gap-2 rounded-[var(--radius-lg)] bg-surface p-3 shadow-[var(--shadow-border)]" from="down">
        {shiftRead.error ? (
          // Not "no till is open": the screen does not know, and saying so would send the desk to open a second one.
          <div className="w-full">
            <LoadError
              message={shiftRead.error.message}
              onRetry={shiftRead.error.refused ? undefined : shiftRead.reload}
            />
          </div>
        ) : shift === undefined ? (
          <Skeleton className="h-9 w-44" />
        ) : shift ? (
          <Badge tone="accent">{t("Shift open · cash {amount}", { amount: money(shift.totals?.cash ?? 0) })}</Badge>
        ) : (
          <Button
            onClick={async () => {
              try {
                await apiPost("/shifts/open");
                shiftRead.reload();
                toast.success(t("Shift opened"));
              } catch (e) {
                toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
              }
            }}
          >
            {/*
              An imperative, because this is the thing to press. Labelled
              "Shift open" it read as a status line, so reception saw the
              words "shift open" on screen, believed one was, and then met
              "Open a shift first" on the payment button with no idea where
              to go.
            */}
            {t("Open shift")}
          </Button>
        )}
        {shift === null ? (
          <span className="text-sm text-muted">{t("Open your cash shift first. Payments can’t be taken without one.")}</span>
        ) : null}
        {shift ? (
          <Button
            variant="outline"
            onClick={() => {
              setCash(String(shift.totals?.cash ?? 0));
              setCloseOpen(true);
            }}
          >
            {t("Close shift")}
          </Button>
        ) : null}
        <ButtonLink to="/desk/payments" variant="outline" className="ml-auto">
          {t("Payments")}
          {waiting ? (
            <span className="rounded-full bg-hold px-2 py-0.5 text-2xs font-semibold tabular-nums text-bg">
              {waiting}
            </span>
          ) : null}
        </ButtonLink>
        <ButtonLink to="/desk/courts" variant="outline">
          {t("Court map")}
        </ButtonLink>
      </Reveal>



      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_21rem]">
        <div className="min-w-0">
      <Field label={t("Find a member")} tone="muted">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("Name, phone or member code")}
          autoFocus={hasKeyboard()}
        />
      </Field>
      <div className="mt-3 grid gap-2">
        {q.trim().length > 0 && q.trim().length < 3 ? (
          <p className="text-sm text-muted">{t("Type at least 3 characters.")}</p>
        ) : null}
        {searchErr ? <LoadError message={searchErr} onRetry={() => setSearchTry((n) => n + 1)} /> : null}
        {answered === q && q.trim().length >= 3 && items.length === 0 ? (
          <p className="text-sm text-muted">{t("No members match")}</p>
        ) : null}
        {items.map((m, i) => (
          <motion.button
            key={m.id}
            type="button"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: Math.min(i, 6) * 0.03, ease: [0.16, 1, 0.3, 1] }}
            onClick={() => navigate({ to: "/desk/member/$id", params: { id: m.id } })}
            className="flex min-h-14 items-center justify-between gap-3 rounded-[var(--radius-lg)] bg-surface px-4 py-3 text-left shadow-[var(--shadow-border)] transition-[background-color,transform] duration-200 hover:-translate-y-0.5 hover:bg-wood"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="size-8 shrink-0">
                <UserAvatar name={m.full_name} url={m.avatar_url} />
              </div>
              <div className="min-w-0">
                <div className="font-medium">{m.full_name}</div>
                <div className="text-xs tabular-nums text-muted">
                  {m.member_code} · {m.phone}
                  {m.date_of_birth ? ` · ${t("{age} yrs", { age: ageYears(m.date_of_birth) })}` : ""}
                </div>
              </div>
            </div>
            <StatusBadge status={m.status} />
          </motion.button>
        ))}
      </div>

      <SectionTitle text={t("New member")} className="mt-8 font-display text-2xl" />
      <p className="mt-1 text-sm text-muted">{t("Three steps: profile → plan → payment.")}</p>
      <ol className="mt-3 flex gap-2 text-2xs font-medium">
        {[
          [1, t("Profile")],
          [2, t("Plan")],
          [3, t("Payment")],
        ].map(([n, l]) => (
          <li key={n} className="relative rounded-full px-3 py-1">
            {step === n ? (
              <motion.span
                layoutId="desk-wizard-step"
                className="absolute inset-0 rounded-full bg-accent"
                transition={{ type: "spring", stiffness: 380, damping: 32 }}
              />
            ) : (
              <span className="absolute inset-0 rounded-full bg-wood" />
            )}
            <span className={`relative ${step === n ? "text-accent-fg" : "text-muted"}`}>
              {n}. {l}
            </span>
          </li>
        ))}
      </ol>
      <SpotlightCard className="mt-3 rounded-[var(--radius-xl)]" size={420} strength={0.09}>
      <Card className="relative z-[2]">
        {step === 1 ? (
          <div className="grid gap-3 md:grid-cols-3">
            <Field label={t("Full name")}>
              <Input
                value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                placeholder={t("e.g. Trần Minh Anh")}
              />
            </Field>
            <Field label={t("Phone number")}>
              <Input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="0901 234 567"
                inputMode="tel"
              />
            </Field>
            <div className="flex items-end">
              <Button
                className="w-full"
                disabled={busy || !form.full_name.trim() || !form.phone.trim()}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const res = await apiPost<{
                      user: { id: string; full_name: string; member_code?: string | null };
                      existing?: boolean;
                      temp_password?: string;
                    }>("/members", { ...form, pii_consent: true });
                    setNewUser({ ...res.user, temp_password: res.temp_password });
                    setStep(2);
                    toast.success(
                      res.existing
                        ? t("This person already has a profile. Pick a plan or stop here.")
                        : res.user.member_code
                          ? t("Created {code}. Temporary password: {password}", {
                              code: res.user.member_code,
                              password: res.temp_password ?? "",
                            })
                          : t("Created the profile. Temporary password: {password}", { password: res.temp_password ?? "" }),
                    );
                  } catch (e) {
                    toast.error(e instanceof Error ? tServer(e.message) : t("Could not create the account"));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t("Create profile")}
              </Button>
            </div>
          </div>
        ) : null}
        {step === 2 && newUser ? (
          <div>
            <p className="mb-3 text-sm">
              {newUser.full_name}
              {newUser.member_code ? ` · ${newUser.member_code}` : ""}
            </p>
            {newUser.temp_password ? (
              <Card className="mb-4 border border-hold/30 bg-hold/5 p-4">
                <p className="text-2xs text-muted">{t("Temporary password: hand this to the member so they can sign in")}</p>
                <p className="mt-1 font-mono text-lg font-semibold tracking-wide">{newUser.temp_password}</p>
                <p className="mt-1 text-xs text-muted">{t("They change it after the first sign-in.")}</p>
              </Card>
            ) : null}
            {plansRead.error ? (
              <LoadError
                message={plansRead.error.message}
                onRetry={plansRead.error.refused ? undefined : plansRead.reload}
              />
            ) : !plansRead.data ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
              </div>
            ) : !plans.length ? (
              <EmptyState title={t("No plans on sale right now")} />
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {plans.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPicked(p)}
                    className={`rounded-[var(--radius-lg)] border px-4 py-3 text-left transition-[background-color,border-color,transform] duration-200 active:scale-[0.98] ${
                      picked?.id === p.id ? "border-accent bg-accent/10" : "border-line hover:bg-wood"
                    }`}
                  >
                    <p className="font-medium">{tData(p.name)}</p>
                    <p className="text-sm tabular-nums text-muted">
                      {money(p.price_vnd)}
                      {p.duration_months ? ` · ${monthsLabel(p.duration_months)}` : p.duration_days ? ` · ${t("{n} days", { n: p.duration_days })}` : ""}
                    </p>
                  </button>
                ))}
              </div>
            )}
            <div className="mt-4 flex gap-2">
              <Button variant="ghost" onClick={() => setStep(1)}>
                {t("Back")}
              </Button>
              <Button
                disabled={!picked || busy}
                onClick={async () => {
                  if (!picked || !newUser) return;
                  setBusy(true);
                  try {
                    const res = await apiPost<{ subscription: { id: string } }>("/subscriptions", {
                      plan_id: picked.id,
                      user_id: newUser.id,
                    });
                    setSubId(res.subscription.id);
                    setStep(3);
                  } catch (e) {
                    toast.error(e instanceof Error ? tServer(e.message) : t("Could not start the plan"));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t("Next: take payment")}
              </Button>
            </div>
          </div>
        ) : null}
        {step === 3 && newUser && picked ? (
          <div className="grid gap-3 md:grid-cols-3">
            <div className="md:col-span-3 text-sm">
              {newUser.full_name} · {picked.name} · {money(picked.price_vnd)}
            </div>
            <Field label={t("Payment method")}>
              <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="cash">{t("Cash")}</option>
                <option value="transfer">{t("Bank transfer")}</option>
                <option value="card">{t("Card")}</option>
              </Select>
            </Field>
            <div className="flex items-end gap-2 md:col-span-2">
              <StarBorder speed={4}>
              <Button
                disabled={busy || !shift}
                onClick={async () => {
                  if (!subId) return;
                  setBusy(true);
                  try {
                    const res = await apiPost<PaymentCreateResponse>(
                      "/payments",
                      {
                        ref_type: "subscription",
                        ref_id: subId,
                        method,
                        amount_vnd: picked.price_vnd,
                      },
                      true,
                    );
                    toast.success(t("Paid, receipt opened"));
                    // Clear the wizard before printing. The payment is already
                    // posted; if the receipt fails to open, leaving step 3 on
                    // screen would offer to take the same money again.
                    const uid = newUser.id;
                    resetWizard();
                    navigate({ to: "/desk/member/$id", params: { id: uid } });
                    if (res.invoice?.id) {
                      try {
                        await openInvoice(res.invoice.id);
                      } catch {
                        toast.warning(t("Paid, but the receipt did not open. Reprint it from the profile."));
                      }
                    }
                  } catch (e) {
                    toast.error(e instanceof Error ? tServer(e.message) : t("Payment did not go through"));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {shift === null ? t("Open a shift first") : t("Take payment & print")}
              </Button>
              </StarBorder>
              <Button variant="ghost" onClick={() => setStep(2)}>
                {t("Back")}
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
      </SpotlightCard>
          <DeskArrivingTimeline />
          <DeskRecentCheckins />
        </div>
        <aside className="grid content-start gap-6">
          <DeskNow />
      {/* The tab row only has room for the busiest pages, and on a tablet or phone the rest sit behind "More". */}
      <nav aria-label={t("Quick links")} className="grid grid-cols-2 gap-2">
        {(
          [
            { to: "/desk/series" as const, label: t("Fixed bookings"), Icon: Repeat },
            { to: "/desk/gear" as const, label: t("Gear"), Icon: Dumbbell },
            { to: "/desk/maintenance" as const, label: t("Maintenance"), Icon: Wrench },
            { to: "/desk/at-risk" as const, label: t("At risk"), Icon: UserMinus },
          ] as const
        ).map((a) => (
          <ButtonLink key={a.to} to={a.to} variant="outline" size="sm" className="justify-start">
            <a.Icon aria-hidden="true" className="size-4 text-muted" strokeWidth={1.75} />
            {a.label}
          </ButtonLink>
        ))}
      </nav>
      {ticketsRead.error ? (
        <div>
          <SectionTitle text={t("Requests from the app")} className="font-display text-xl" />
          <div className="mt-3">
            <LoadError
              message={ticketsRead.error.message}
              onRetry={ticketsRead.error.refused ? undefined : ticketsRead.reload}
            />
          </div>
        </div>
      ) : (
        <div>
          <SectionTitle text={t("Requests from the app")} className="font-display text-xl" />
          <div className="mt-3">
            <Seg
              value={ticketScope}
              onChange={(v) => {
                setTicketScope(v as "open" | "all");
                // A different list is a different set of pages: staying on page
                // four of the open queue would land on an empty page of "All".
                setTicketOffset(0);
              }}
              options={[
                { value: "open", label: t("Open queue") },
                { value: "all", label: t("All requests") },
              ]}
            />
          </div>
          {!tickets.length ? (
            <div className="mt-3">
              <EmptyState
                title={ticketScope === "all" ? t("Nothing here yet") : t("The queue is clear")}
                hint={
                  ticketScope === "all"
                    ? t("Requests from the app show up here with their replies.")
                    : t("Everything the app has sent in has been answered or closed.")
                }
              />
            </div>
          ) : null}
          <Stagger className="mt-3 grid gap-2" gap={0.05}>
            {tickets.map((ticket) => (
              <StaggerItem key={ticket.id}>
              <Card className="p-4">
                <div className="grid gap-3">
                  <div className="min-w-0">
                    {/* A member's own words, so they may contain a long run
                        with nothing to wrap on — without this it pushes the
                        Reply and Close buttons off the side of the card. */}
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm">{ticket.body}</p>
                      {/* Under "All" open and finished rows sit together; the badge is what tells them apart. */}
                      <Badge tone={ticket.reply ? "accent" : ticket.status === "closed" ? "muted" : "hold"} className="shrink-0">
                        {ticket.reply ? t("Answered") : ticket.status === "closed" ? t("Closed") : t("Waiting")}
                      </Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      {ticket.full_name} · {ticket.phone}
                    </p>
                    {/* Under "All" the answer is the point of the row: reading
                        back what somebody was told is the whole reason the
                        desk opens this filter. */}
                    {ticket.reply ? (
                      <div className="mt-2 rounded-[var(--radius-md)] bg-accent/5 p-2.5 ring-1 ring-inset ring-accent/15">
                        <p className="text-2xs font-semibold text-accent-2">
                          {ticket.replied_by_name ?? t("Reception")}
                          {ticket.replied_at ? (
                            <span className="font-normal text-muted"> · {when(ticket.replied_at)}</span>
                          ) : null}
                        </p>
                        <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm">{ticket.reply}</p>
                      </div>
                    ) : ticket.status === "closed" ? (
                      <p className="mt-2 text-xs text-muted">{t("Closed without a reply.")}</p>
                    ) : null}
                  </div>
                  <div className="flex gap-2">
                    {/* One request carries one answer: the server refuses a
                        second with a 409, so under "All" a Reply button on an
                        answered row would be a button that cannot work. */}
                    {ticket.reply ? null : (
                      <Button
                        size="sm"
                        onClick={() => {
                          setReplyTo(replyTo === ticket.id ? null : ticket.id);
                          setReply("");
                        }}
                      >
                        {replyTo === ticket.id ? t("Cancel") : t("Reply")}
                      </Button>
                    )}
                    {/* Closing without answering is still allowed — a duplicate,
                        or something dealt with at the counter in person — but it
                        is no longer the only thing the desk can do. Already
                        closed rows show up under "All" and have nothing to do. */}
                    {ticket.status === "closed" ? null : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        try {
                          await apiPost(`/tickets/${ticket.id}/close`);
                          ticketsRead.reload();
                          toast.success(t("Request closed"));
                        } catch (e) {
                          toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
                        }
                      }}
                    >
                      {t("Close")}
                    </Button>
                    )}
                  </div>
                </div>
                {replyTo === ticket.id ? (
                  <form
                    className="mt-3 flex flex-wrap gap-2"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (reply.trim().length < 2 || replying) return;
                      setReplying(true);
                      try {
                        await apiPost(`/tickets/${ticket.id}/reply`, { reply: reply.trim() });
                        ticketsRead.reload();
                        setReplyTo(null);
                        setReply("");
                        toast.success(t("Replied: the member has been notified"));
                      } catch (err) {
                        toast.error(err instanceof Error ? tServer(err.message) : t("Something went wrong"));
                      } finally {
                        setReplying(false);
                      }
                    }}
                  >
                    <Input
                      className="min-w-0 flex-1"
                      autoFocus
                      maxLength={2000}
                      placeholder={t("What should we tell them?")}
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                    />
                    <Button type="submit" disabled={replying || reply.trim().length < 2}>
                      {t("Send")}
                    </Button>
                  </form>
                ) : null}
              </Card>
              </StaggerItem>
            ))}
          </Stagger>
          <Pagination
            offset={ticketPage.offset}
            total={ticketsRead.data?.total ?? 0}
            pageSize={ticketPage.pageSize}
            onChange={ticketPage.setOffset}
            onPageSizeChange={ticketPage.setPageSize}
            label={t("Request pages")}
          />
        </div>
      )}
        </aside>
      </div>

      <Modal
        open={closeOpen}
        onClose={() => setCloseOpen(false)}
        title={t("Close shift")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCloseOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button
              onClick={async () => {
                if (!shift) return;
                try {
                  await apiPost(`/shifts/${shift.shift.id}/close`, { cash_declared_vnd: Number(cash) });
                  toast.success(t("Shift closed"));
                  setCloseOpen(false);
                  shiftRead.reload();
                } catch (e) {
                  toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
                }
              }}
            >
              {t("Reconcile & close")}
            </Button>
          </>
        }
      >
        <Field label={t("Cash counted (VND)")}>
          <MoneyInput value={cash} onChange={setCash} />
        </Field>
        <p className="mt-2 text-sm text-muted">{t("Expected from the books: {amount}", { amount: money(shift?.totals?.cash ?? 0) })}</p>
      </Modal>

    </Shell>
  );
}

/**
 * What the hall is doing right now, from the same occupancy the court map draws: who is on court,
 * who walks in within the hour, and how many courts are still free this hour. The desk sees it
 * without opening the map.
 */
function DeskNow() {
  const today = todayISO();
  const { data, error } = useRead<{ courts: Court[]; slots: OccSlot[] }>(`/occupancy?date=${today}`);
  const now = useNowMinute();
  if (error) return null;
  if (!data || !now) return <Skeleton className="h-40" />;
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", hour12: false }).format(new Date(now)),
  );
  const live = (s: OccSlot) => s.kind === "booking" || s.kind === "session";
  const playing = data.slots.filter((s) => live(s) && Date.parse(s.start) <= now && Date.parse(s.end) > now);
  const soon = data.slots.filter((s) => live(s) && Date.parse(s.start) > now && Date.parse(s.start) <= now + 3_600_000);
  const freeNow = freeHours(data.courts, data.slots, today, now).filter((f) => f.hour === hour).length;
  return (
    <SpotlightCard className="rounded-[var(--radius-xl)]" size={260} strength={0.1}>
    <Card className="relative z-[2] p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-display text-xl">{t("Right now")}</h2>
        <Link to="/desk/courts" className="hit inline-flex items-center gap-1 text-sm font-medium text-accent-2 hover:underline">
          {t("Court map")}
          <ArrowRight aria-hidden className="size-3.5" />
        </Link>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2">
        {[
          { label: t("On court"), value: playing.length },
          { label: t("Arriving within the hour"), value: soon.length },
          { label: t("Courts free this hour"), value: freeNow },
        ].map((x) => (
          <div key={x.label} className="rounded-[var(--radius-md)] bg-wood/70 px-3 py-2.5">
            <dd className="figure text-2xl">
              <CountUp to={x.value} duration={0.9} />
            </dd>
            <dt className="mt-1 text-xs leading-snug text-muted">{x.label}</dt>
          </div>
        ))}
      </dl>
    </Card>
    </SpotlightCard>
  );
}

const ARRIVING_STEP = 6;

function DeskArrivingTimeline() {
  const today = todayISO();
  const { data, reload } = useRead<{ courts: Court[]; slots: OccSlot[] }>(`/occupancy?date=${today}`);
  const now = useNowMinute();
  const [checking, setChecking] = useState<string | null>(null);
  // A busy evening is two dozen rows; the desk needs the next few, the rest on demand.
  const [shown, setShown] = useState(ARRIVING_STEP);

  if (!data || !now) return null;
  const live = (s: OccSlot) => s.kind === "booking" || s.kind === "session";
  const arriving = data.slots
    .filter((s) => live(s) && Date.parse(s.start) > now && Date.parse(s.start) <= now + 7_200_000)
    .sort((a, b) => a.start.localeCompare(b.start));

  const hhmm = (iso: string) =>
    new Date(iso).toLocaleTimeString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit" });

  return (
    <div className="mt-8">
      <div className="flex items-baseline justify-between gap-2">
        <SectionTitle text={t("Arriving next 2 hours")} className="font-display text-xl" />
        <span className="text-xs text-muted tabular-nums">
          {arriving.length} {t("arrivals")}
        </span>
      </div>
      {arriving.length === 0 ? (
        <Card className="mt-3 p-4 text-center text-sm text-muted">
          {t("No arrivals in the next 2 hours")}
        </Card>
      ) : (
        <div className="mt-3 grid gap-2">
          {arriving.slice(0, shown).map((s) => {
            const court = data.courts.find((c) => c.id === s.court_id);
            const key = `${s.court_id}-${s.start}`;
            return (
              <Card key={key} className="flex flex-wrap items-center justify-between gap-3 p-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="figure text-sm font-semibold tabular-nums text-muted">
                    {hhmm(s.start)} - {hhmm(s.end)}
                  </span>
                  {court ? <SportBadge sport={court.sport} className="text-xs" /> : null}
                  <div className="min-w-0">
                    <p className="font-medium text-sm">
                      {court?.court_code ? `${t("Court")} ${court.court_code}` : t("Court")}
                    </p>
                    <p className="text-xs text-muted">
                      {s.kind === "session" ? t("Class") : t("Booking")}
                    </p>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={checking === key}
                  onClick={async () => {
                    setChecking(key);
                    try {
                      if (s.kind === "booking" && s.ref) {
                        await apiPost(`/bookings/${s.ref}/check-in`);
                      } else {
                        await apiPost("/desk/gate-checkin", { reason: "forgot" });
                      }
                      toast.success(t("Checked in"));
                      reload();
                    } catch (e) {
                      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
                    } finally {
                      setChecking(null);
                    }
                  }}
                >
                  {t("Check in")}
                </Button>
              </Card>
            );
          })}
          <ShowMore shown={shown} total={arriving.length} step={ARRIVING_STEP} onMore={() => setShown((n) => n + ARRIVING_STEP)} />
        </div>
      )}
    </div>
  );
}

function DeskRecentCheckins() {
  const { desk_checkins } = useLimits();
  const read = useRead<{ items: Array<{ id: string; full_name: string; member_code: string | null; method: string | null; at: string; avatar_url?: string | null }>; total: number }>(`/desk/gate-checkins?limit=${desk_checkins}`);
  const items = read.data?.items ?? [];

  return (
    <div className="mt-8">
      <SectionTitle text={t("Recent check-ins")} className="font-display text-xl" />
      {items.length === 0 ? (
        <Card className="mt-3 p-4 text-center text-sm text-muted">
          {t("No check-ins yet today")}
        </Card>
      ) : (
        <div className="mt-3 grid gap-2">
          {items.map((it) => (
            <Card key={it.id} className="flex items-center justify-between gap-3 p-3 text-sm">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="size-8 shrink-0">
                  <UserAvatar name={it.full_name} url={it.avatar_url} />
                </div>
                <div className="min-w-0">
                  <p className="font-medium">{it.full_name}</p>
                  <p className="text-xs text-muted tabular-nums">
                    {it.member_code ? `${it.member_code} · ` : ""}{when(it.at)}
                  </p>
                </div>
              </div>
              <Badge tone="accent">{it.method ? it.method.toUpperCase() : "QR"}</Badge>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
