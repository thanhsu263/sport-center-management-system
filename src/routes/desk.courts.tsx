import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { CourtGrid, DateStrip, freeHours, sportLabel, useNowMinute, type Court, type OccSlot } from "@/components/court-grid";
import { Shell, money } from "@/components/shell";
import { PageHero } from "@/components/page-hero";
import { StatStrip } from "@/components/stat-strip";
import { Button, Card, DateField, Field, Input, LoadError, Select, Seg, Skeleton } from "@/components/ui";
import { AnimatePresence, motion } from "motion/react";
import { SpotlightCard, StarBorder } from "@/components/fx";
import { ClassDetailModal, OccupancyDetailModal } from "@/components/class-detail";
import { apiPost, openInvoice } from "@/lib/arena3/client";
import { todayISO } from "@/lib/arena3/labels";
import { t, tServer } from "@/lib/i18n";
import { useRead } from "@/lib/use-read";
import { hoursOf, venueFrom, type VenueRaw } from "@/lib/venue";
import { useSports } from "@/components/sports-ui";
import { useLive } from "@/lib/use-live";

export const Route = createFileRoute("/desk/courts")({
  component: Page,
});

function Page() {
  const { sports } = useSports();
  const [date, setDate] = useState(todayISO);
  const [sport, setSport] = useState("");
  const { data, error, reload } = useRead<{ courts: Court[]; slots: OccSlot[] }>(`/occupancy?date=${date}`);
  useLive("courts", reload);
  const now = useNowMinute();
  const shiftRead = useRead<{ shift: { id: string; opened_at: string } | null; totals?: { cash: number } | null }>("/shifts/current?optional=1");
  const shift = shiftRead.data?.shift ? { shift: shiftRead.data.shift, totals: shiftRead.data.totals ?? undefined } : null;
  const waiting = useRead<{ waiting: number }>("/payments/pending?brief=1").data?.waiting ?? 0;

  // The centre's opening hours from its settings, so the map's rows match what can be sold.
  const flags = useRead<{ venue?: VenueRaw }>("/flags");
  const dayHours = hoursOf(venueFrom(flags.data?.venue));
  const [pick, setPick] = useState<{ court: Court; hour: number } | null>(null);
  const [form, setForm] = useState({ guest_name: "", guest_phone: "", method: "cash" });
  // The taken hour whose owner the desk is looking up, and the class it may lead to.
  const [look, setLook] = useState<{ kind: string; ref: string } | null>(null);
  const [lookClass, setLookClass] = useState<string | null>(null);

  const currentHour = now
    ? Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", hour12: false }).format(new Date(now)))
    : 10;
  const freeNowCount = data && now ? freeHours(data.courts, data.slots, date, now).filter((f) => f.hour === currentHour).length : 0;

  function isoAt(hour: number) {
    return `${date}T${String(hour).padStart(2, "0")}:00:00+07:00`;
  }

  const statItems = [
    { label: t("Courts free this hour"), value: freeNowCount },
    { label: t("Current shift"), value: shift?.shift ? t("Shift open") : t("No open shift") },
    { label: t("Cash in till"), value: shift?.totals?.cash ? money(shift.totals.cash) : "0 đ" },
    { label: t("Waiting payments"), value: waiting },
  ];

  return (
    <Shell role="receptionist">
      <PageHero
        slot="banner.gate"
        title={t("Court map")}
        subtitle={t("Take walk-in payment on the spot.")}
      />
      <StatStrip className="mb-4" items={statItems} />
      <div className="mb-4 grid gap-3">
        <DateStrip value={date} onChange={setDate} />
        <div className="flex flex-wrap items-center gap-2">
          <Seg
            value={sport}
            onChange={setSport}
            options={[
              { value: "", label: t("All") },
              ...sports
                .filter((s) => !data?.courts || data.courts.some((c) => c.sport === s.code))
                .map((s) => ({ value: s.code, label: sportLabel(s.code) })),
            ]}
          />
          <DateField required value={date} onChange={setDate} invalid={error?.refused === true} />
        </div>
      </div>
      <AnimatePresence>
      {pick ? (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          className="overflow-hidden"
        >
        <SpotlightCard className="mb-4 rounded-[var(--radius-xl)]" size={420} strength={0.1}>
        <Card className="relative z-[2] grid gap-3 md:grid-cols-4">
          <div className="md:col-span-4">
            <p className="text-sm text-muted">
              {t("Walk-in")} · {pick.court.court_code} · {sportLabel(pick.court.sport)} · {String(pick.hour).padStart(2, "0")}
              :00
            </p>
          </div>
          <Field label={t("Full name")}>
            <Input
              value={form.guest_name}
              onChange={(e) => setForm({ ...form, guest_name: e.target.value })}
              placeholder={t("Guest name")}
            />
          </Field>
          <Field label={t("Phone")}>
            <Input
              value={form.guest_phone}
              onChange={(e) => setForm({ ...form, guest_phone: e.target.value })}
              placeholder="0901…"
            />
          </Field>
          <Field label={t("Payment method")}>
            <Select value={form.method} onChange={(e) => setForm({ ...form, method: e.target.value })}>
              <option value="cash">{t("Cash")}</option>
              <option value="transfer">{t("Bank transfer")}</option>
              <option value="card">{t("Card")}</option>
            </Select>
          </Field>
          {/* Own row: the star border needs the button at its natural width, and
              a quarter-column squeezes "Take payment & hold" onto three lines. */}
          <div className="flex items-end gap-2 md:col-span-4">
            {/* The one control that moves money on this screen. */}
            <StarBorder speed={4}>
              <Button
                onClick={async () => {
                  try {
                    const res = await apiPost<{ payment: { amount_vnd: number; code: string }; invoice_id: string }>(
                      "/walk-in",
                      { court_id: pick.court.id, start_at: isoAt(pick.hour), ...form },
                      true,
                    );
                    toast.success(t("Took {amount} · {code}", { amount: money(res.payment.amount_vnd), code: res.payment.code }));
                    setPick(null);
                    setForm({ guest_name: "", guest_phone: "", method: "cash" });
                    reload();
                    if (res.invoice_id) await openInvoice(res.invoice_id);
                  } catch (e) {
                    toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
                  }
                }}
              >
                {t("Take payment & hold")}
              </Button>
            </StarBorder>
            <Button variant="ghost" onClick={() => setPick(null)}>
              {t("Never mind")}
            </Button>
          </div>
        </Card>
        </SpotlightCard>
        </motion.div>
      ) : null}
      </AnimatePresence>
      {error ? (
        <LoadError message={error.message} onRetry={error.refused ? undefined : reload} />
      ) : data ? (
        <CourtGrid
          defaultShowPast
          hours={dayHours}
          date={date}
          courts={data.courts}
          slots={data.slots}
          sport={sport || undefined}
          onRefresh={reload}
          onInspect={(_c, _h, occ) => setLook({ kind: occ.kind, ref: occ.ref })}
          onPick={(c, h) => {
            setPick({ court: c, hour: h });
          }}
          // A full day is a question a walk-in asks at the counter, so the
          // same two answers reception would give are on the grid itself.
          onPickSport={setSport}
          onPickDate={setDate}
        />
      ) : (
        <Skeleton className="h-72" />
      )}
      <OccupancyDetailModal
        target={look}
        onClose={() => setLook(null)}
        onOpenClass={(id) => {
          setLook(null);
          setLookClass(id);
        }}
      />
      <ClassDetailModal classId={lookClass} onClose={() => setLookClass(null)} />
    </Shell>
  );
}
