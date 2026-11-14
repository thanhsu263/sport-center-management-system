import { createFileRoute } from "@tanstack/react-router";
import { SectionTitle } from "@/client/components/section";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Shell, money } from "@/client/components/shell";
import { Button, Card, EmptyState, Field, Input, LoadError, Select, Skeleton } from "@/client/components/ui";
import { Lift, Reveal, Stagger, StaggerItem } from "@/client/components/motion";
import { SpotlightCard } from "@/client/components/fx";
import { ApiClientError, apiGet, apiPost } from "@/client/arena3/client";
import { sportLabel } from "@/shared/arena3/labels";
import { t, tServer, tData } from "@/client/lib/i18n";
import { readError, useRead } from "@/client/lib/use-read";

export const Route = createFileRoute("/desk/gear")({ component: Page });

type Item = { id: string; sku: string; name: string; sport: string | null; stock: number; rent_vnd: number };
type Loan = {
  id: string;
  name: string;
  sku: string;
  phone: string;
  qty: number;
  due_at: string;
  member_name: string | null;
  member_code: string | null;
};
type Hit = { id: string; member_code: string | null; full_name: string; phone: string };

function Page() {
  // null = not known yet (still asking, or the question failed) — never "nothing": an empty shelf and an
  // empty loan list are claims about the stock room, and a screen that has not heard back cannot make them.
  const equipmentRead = useRead<{ items: Item[] }>("/equipment");
  const loansRead = useRead<{ items: Loan[] }>("/equipment/loans");
  const items = equipmentRead.data?.items ?? null;
  const loans = loansRead.data?.items ?? null;
  const [itemId, setItemId] = useState("");
  const [qty, setQty] = useState(1);
  const [method, setMethod] = useState("cash");
  const [who, setWho] = useState<"member" | "guest">("member");
  const [phone, setPhone] = useState("");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  // The search text the list above was last answered for, so "no match" is said only about what was typed.
  const [answered, setAnswered] = useState<string | null>(null);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [searchTry, setSearchTry] = useState(0);
  const [member, setMember] = useState<Hit | null>(null);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const [returning, setReturning] = useState<string | null>(null);

  // Stock and loans both move when gear goes out or comes back, so every change re-asks for both.
  function reloadAll() {
    equipmentRead.reload();
    loansRead.reload();
  }

  // Start on something that can actually be rented, not on a line that is greyed out.
  useEffect(() => {
    if (items?.length) setItemId((cur) => cur || (items.find((i) => i.stock > 0) ?? items[0])?.id || "");
  }, [items]);

  useEffect(() => {
    setSearchErr(null);
    if (who !== "member" || member || q.trim().length < 3) {
      setHits([]);
      setAnswered(null);
      return;
    }
    let stale = false;
    const timer = setTimeout(() => {
      apiGet<{ items: Hit[] }>(`/members?q=${encodeURIComponent(q)}`).then(
        (r) => {
          if (stale) return;
          setHits(r.items);
          setAnswered(q);
        },
        (e: unknown) => {
          if (stale) return;
          setHits([]);
          setAnswered(null);
          setSearchErr(readError(e).message);
        },
      );
    }, 180);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [q, who, member, searchTry]);

  const item = items?.find((i) => i.id === itemId);
  const max = item?.stock ?? 0;
  // Keep the count inside what is on the shelf when the item (or its stock) changes.
  const shown = Math.max(1, Math.min(qty, Math.max(max, 1)));
  const canRent = !!item && max > 0 && (who === "member" ? !!member : phone.trim().length > 0);

  async function rent() {
    setFieldError(null);
    try {
      const r = await apiPost<{ rent_vnd: number }>("/equipment/loans", {
        item_id: itemId,
        qty: shown,
        method,
        ...(who === "member" ? { user_id: member?.id } : { phone }),
      });
      toast.success(t("Rented out · {amount}", { amount: money(r.rent_vnd) }));
      setQty(1);
      setPhone("");
      setMember(null);
      setQ("");
      reloadAll();
    } catch (e) {
      if (e instanceof ApiClientError && e.body.field) setFieldError({ field: e.body.field, message: tServer(e.message) });
      else toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
      reloadAll();
    }
  }

  async function takeBack(l: Loan) {
    setReturning(l.id);
    try {
      await apiPost(`/equipment/loans/${l.id}/return`);
      toast.success(t("Returned"));
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      setReturning(null);
      reloadAll();
    }
  }

  const phoneProblem = fieldError && (fieldError.field === "phone" || fieldError.field === "user_id") ? fieldError : null;

  return (
    <Shell
      role="receptionist"
      title={t("Gear")}
      subtitle={t("Rent to a member's account or to a guest by phone. The hire is charged to the till, stock comes down on the way out and back up on return.")}
    >
      {equipmentRead.error ? (
        <div className="mb-4">
          <LoadError
            message={equipmentRead.error.message}
            onRetry={equipmentRead.error.refused ? undefined : equipmentRead.reload}
          />
        </div>
      ) : !items ? (
        <Skeleton className="mb-4 h-32" />
      ) : !items.length ? (
        <div className="mb-4">
          <EmptyState title={t("No gear is listed yet")} />
        </div>
      ) : (
        <Reveal from="down">
          <Card className="mb-4 grid gap-3 md:grid-cols-[1.2fr_1.6fr_auto_auto_auto]">
            <Field label={t("Item")}>
              <Select
                value={itemId}
                onChange={(e) => {
                  setItemId(e.target.value);
                  setQty(1);
                }}
              >
                {items.map((i) => (
                  <option key={i.id} value={i.id} disabled={i.stock < 1}>
                    {tData(i.name)} · {i.stock ? t("{n} left", { n: i.stock }) : t("none left")} · {money(i.rent_vnd)}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="grid content-start gap-2">
              <div className="flex gap-1 text-sm" role="tablist" aria-label={t("Who is renting")}>
                {(["member", "guest"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={who === k}
                    onClick={() => {
                      setWho(k);
                      setFieldError(null);
                    }}
                    className={`min-h-11 rounded-full px-4 py-1 sm:min-h-9 ${who === k ? "bg-accent text-accent-fg" : "bg-wood text-muted"}`}
                  >
                    {k === "member" ? t("Member") : t("Guest")}
                  </button>
                ))}
              </div>
              {who === "member" ? (
                member ? (
                  <div className="flex items-center justify-between gap-2 rounded-[var(--radius-sm)] bg-wood/60 px-3 py-2 text-sm">
                    <span>
                      <span className="font-medium">{member.full_name}</span>{" "}
                      <span className="tabular-nums text-muted">
                        {member.member_code ?? ""} · {member.phone}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="text-muted underline"
                      onClick={() => {
                        setMember(null);
                        setFieldError(null);
                      }}
                    >
                      {t("Change")}
                    </button>
                  </div>
                ) : (
                  <div className="relative">
                    <Input
                      aria-label={t("Find a member")}
                      placeholder={t("Search name, phone or member code")}
                      value={q}
                      aria-invalid={phoneProblem ? true : undefined}
                      onChange={(e) => {
                        setQ(e.target.value);
                        setFieldError(null);
                      }}
                    />
                    {hits.length ? (
                      <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-[var(--radius-md)] border border-line bg-surface text-sm shadow-lg">
                        {hits.map((h) => (
                          <li key={h.id}>
                            <button
                              type="button"
                              className="flex w-full justify-between gap-2 px-3 py-2 text-left hover:bg-wood"
                              onClick={() => {
                                setMember(h);
                                setHits([]);
                              }}
                            >
                              <span className="font-medium">{h.full_name}</span>
                              <span className="tabular-nums text-muted">
                                {h.member_code ?? ""} · {h.phone}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {q.trim().length >= 3 && answered === q && !hits.length && !searchErr ? (
                      <p className="mt-1.5 text-sm text-muted">{t("No members match")}</p>
                    ) : null}
                  </div>
                )
              ) : (
                <Input
                  aria-label={t("Guest phone")}
                  inputMode="tel"
                  placeholder={t("Guest phone, e.g. 09xx xxx xxx")}
                  value={phone}
                  aria-invalid={phoneProblem ? true : undefined}
                  onChange={(e) => {
                    setPhone(e.target.value);
                    setFieldError(null);
                  }}
                />
              )}
              {searchErr && who === "member" && !member ? (
                <LoadError message={searchErr} onRetry={() => setSearchTry((n) => n + 1)} />
              ) : null}
              {phoneProblem ? (
                <p role="alert" className="text-sm text-danger">
                  {phoneProblem.message}
                </p>
              ) : null}
            </div>
            <Field label={t("Qty")}>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="min-w-11"
                  aria-label={t("One fewer")}
                  disabled={shown <= 1}
                  onClick={() => setQty(shown - 1)}
                >
                  −
                </Button>
                <span className="w-8 text-center tabular-nums" aria-live="polite">
                  {shown}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="min-w-11"
                  aria-label={t("One more")}
                  disabled={shown >= max}
                  onClick={() => setQty(shown + 1)}
                >
                  +
                </Button>
              </div>
            </Field>
            <Field label={t("Paid by")}>
              <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="cash">{t("Cash")}</option>
                <option value="card">{t("Card")}</option>
                <option value="transfer">{t("Bank transfer")}</option>
              </Select>
            </Field>
            <div className="flex items-end">
              <Button className="w-full" disabled={!canRent} onClick={() => void rent()}>
                {t("Rent out")}
              </Button>
            </div>
          </Card>
        </Reveal>
      )}
      {items?.length ? (
        <Stagger className="grid gap-3 md:grid-cols-2" gap={0.05}>
          {items.map((i) => (
            <StaggerItem key={i.id} className="h-full">
              <Lift className="h-full">
                <SpotlightCard className="h-full rounded-[var(--radius-xl)]" size={280} strength={0.1}>
                  <Card interactive className="relative z-[2] h-full p-4">
                    <p className="text-2xs text-muted">{i.sport ? sportLabel(i.sport) : t("General")}</p>
                    <p className="font-medium">{tData(i.name)}</p>
                    <p className="text-sm text-muted">
                      {t("{n} in stock · {amount} each", { n: i.stock, amount: money(i.rent_vnd) })}
                    </p>
                  </Card>
                </SpotlightCard>
              </Lift>
            </StaggerItem>
          ))}
        </Stagger>
      ) : null}
      <SectionTitle text={t("Out on loan")} className="mt-8 font-display text-2xl" />
      {loansRead.error ? (
        <div className="mt-3">
          <LoadError
            message={loansRead.error.message}
            onRetry={loansRead.error.refused ? undefined : loansRead.reload}
          />
        </div>
      ) : !loans ? (
        <Skeleton className="mt-3 h-16" />
      ) : (
        <Stagger className="mt-3 grid gap-2" gap={0.05}>
          {loans.map((l) => (
            <StaggerItem key={l.id}>
              <Card className="flex items-center justify-between p-4">
                <div>
                  <p className="font-medium">
                    {tData(l.name)} × {l.qty}
                  </p>
                  <p className="text-xs text-muted">
                    {l.member_name ? `${l.member_name}${l.member_code ? ` · ${l.member_code}` : ""} · ` : `${t("Guest")} · `}
                    {l.phone}
                  </p>
                </div>
                <Button size="sm" variant="outline" disabled={returning === l.id} onClick={() => void takeBack(l)}>
                  {t("Take it back")}
                </Button>
              </Card>
            </StaggerItem>
          ))}
          {!loans.length ? <p className="text-sm text-muted">{t("Nothing is out right now.")}</p> : null}
        </Stagger>
      )}
    </Shell>
  );
}
