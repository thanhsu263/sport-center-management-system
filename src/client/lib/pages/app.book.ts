import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAvailability } from "@/client/components/availability-calendar";
import { freeHours, type Court, type OccSlot } from "@/client/components/court-grid";
import { useCentreBank } from "@/client/components/transfer-qr-modal";
import { apiGet, apiPost, openInvoice, ApiClientError } from "@/client/arena3/client";
import type { ConfirmResponse, HoldResponse, MeBookingsResponse, MyBooking, MyClassSession } from "@/shared/arena3/contracts";
import { todayISO } from "@/shared/arena3/labels";
import { t } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";
import { useLimits } from "@/client/lib/use-centre";
import { useLive } from "@/client/lib/use-live";
import { useSports } from "@/client/components/sports-ui";
import { DEFAULT_VENUE, hoursOf, venueFrom, type Venue, type VenueRaw } from "@/client/lib/venue";


/** The closest still-free hours on the same sport, nearest to what they wanted. */
function nearestFree(
  data: { courts: Court[]; slots: OccSlot[] },
  wanted: Court,
  hour: number,
  date: string,
  hours: readonly number[],
  count: number,
) {
  const sameSport = data.courts.filter((c) => c.sport === wanted.sport);
  return freeHours(sameSport, data.slots, date, Date.now(), true, hours)
    .sort(
      (a, b) =>
        Math.abs(a.hour - hour) - Math.abs(b.hour - hour) ||
        Number(b.court.court_code === wanted.court_code) -
          Number(a.court.court_code === wanted.court_code),
    )
    .slice(0, count);
}


/** One of the member's own upcoming court bookings (M-04). */
type Hold = HoldResponse & {
  /** Which slot this is, carried from the tap so the card can name it. */
  court_code?: string;
  hour?: number;
};


/** A hold that was refused, and — when another hour would help — where to go instead. */
type Taken = {
  message: string;
  alts: { court: Court; hour: number }[];
  /** False when the refusal was about the member, not the slot. */
  canRetry: boolean;
};

export function useCourtBooking(useRouteSearch: () => { sport?: string }) {
  const limits = useLimits();
  const { sports } = useSports();
  const searchSport = useRouteSearch().sport;
  const [date, setDate] = useState(todayISO);
  const [sport, setSport] = useState(searchSport ?? "");
  // Open on the first sport once; after that "All" ("") is a real choice, not a gap to fill.
  const sportDefaulted = useRef(searchSport != null);
  useEffect(() => {
    if (!sportDefaulted.current && sports.length > 0) {
      sportDefaulted.current = true;
      setSport(sports[0].code);
    }
  }, [sports]);
  // The day on screen. A day the server will not show comes back as `error` (not a grid of grey
  // blocks behind a toast), and a late reply for an earlier date never lands on a later one.
  const { data, error, reload } = useRead<{ courts: Court[]; slots: OccSlot[] }>(`/occupancy?date=${date}`);
  const [hold, setHold] = useState<Hold | null>(null);
  // Typed before tapping a slot: the hold is priced when it is made, so the code goes with it.
  const [promoCode, setPromoCode] = useState("");
  const [promoOpen, setPromoOpen] = useState(false);
  // Refusals and clash warnings appear above the grid; a tap deep in the grid must still see them.
  const notices = useRef<HTMLDivElement>(null);
  const [overlap, setOverlap] = useState<{ court: Court; hour: number; message: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const avail = useAvailability(sport, refresh);
  const [mine, setMine] = useState<MyBooking[] | null>(null);
  const [myClasses, setMyClasses] = useState<MyClassSession[]>([]);
  const [showAllClasses, setShowAllClasses] = useState(false);
  const [windowHours, setWindowHours] = useState(2);
  const [showAllMine, setShowAllMine] = useState(false);
  type MySub = {
    plan_name: string;
    end_on: string;
  };
  const [mySubs, setMySubs] = useState<MySub[]>([]);

  // The booking being moved: the grid's next tap lands on it instead of making a new hold.
  const [moving, setMoving] = useState<MyBooking | null>(null);
  const [moveError, setMoveError] = useState("");
  const [cancelId, setCancelId] = useState<string | null>(null);
  async function loadMine() {
    try {
      const r = await apiGet<MeBookingsResponse>("/me/bookings");
      setMine(r.items);
      setMyClasses(r.class_sessions ?? []);
      setWindowHours(r.window_hours);
    } catch {
      // Keep the list that is already on screen
    }
    try {
      const me = await apiGet<{ subscriptions?: MySub[] }>("/me");
      if (Array.isArray(me.subscriptions)) {
        setMySubs(me.subscriptions);
      }
    } catch {
      // Ignore if /me subscriptions unavailable
    }
  }
  const [taken, setTaken] = useState<Taken | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (taken || overlap) notices.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [taken, overlap]);
  // Leave the online button out entirely when the centre has no payOS set up,
  // rather than offering one that errors.
  const [onlineOn, setOnlineOn] = useState(false);
  // The centre's hours and hold length come with the same answer, for the grid and the copy.
  const [venue, setVenue] = useState<Venue>(DEFAULT_VENUE);
  useEffect(() => {
    void apiGet<{ capabilities?: { online_payment?: boolean }; venue?: VenueRaw }>("/flags")
      .then((r) => {
        setOnlineOn(Boolean(r.capabilities?.online_payment));
        setVenue(venueFrom(r.venue));
      })
      .catch(() => setOnlineOn(false));
  }, []);
  // Sticks around after the toast has gone. A receipt people paid for should
  // not be something you have four seconds to notice.
  const [receipt, setReceipt] = useState<string | null>(null);
  // A transfer the member has promised but reception has not yet found.
  const [pending, setPending] = useState<{ amount: number; until: string; code: string } | null>(null);
  // The centre's own account for VietQR. Without one the transfer option is left out entirely,
  // rather than asking for money with nowhere to send it (B-5).
  const { bank } = useCentreBank();
  const bankOn = bank?.configured === true;
  const [transferOpen, setTransferOpen] = useState<"hold" | "pending" | null>(null);

  /** Ask again for the day on screen and for everything counted from it. */
  function load() {
    reload();
    setRefresh((n) => n + 1);
    void loadMine();
  }

  useLive("courts", load);

  async function moveTo(court: Court, hour: number, confirmOverlap = false) {
    if (!moving) return;
    const start = `${date}T${String(hour).padStart(2, "0")}:00:00+07:00`;
    setBusy(true);
    setMoveError("");
    try {
      await apiPost(
        `/bookings/${moving.id}/reschedule`,
        { start_at: start, court_id: court.id, ...(confirmOverlap ? { confirm_overlap: true } : {}) },
      );
      toast.success(
        t("Moved {code} to {court} · {time}", {
          code: moving.code,
          court: court.court_code,
          time: `${String(hour).padStart(2, "0")}:00`,
        }),
      );
      setMoving(null);
      setOverlap(null);
      load();
    } catch (e) {
      if (e instanceof ApiClientError && e.body.requires_confirm && !confirmOverlap) {
        setOverlap({ court, hour, message: e.body.message });
      } else {
        setMoveError(e instanceof Error ? e.message : t("Could not move that booking"));
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  function startMove(b: MyBooking) {
    setMoving(b);
    setMoveError("");
    setHold(null);
    setTaken(null);
    setSport(b.sport);
    // Open the booking's own day: most changes are another hour the same day.
    setDate(
      new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(b.start_at)),
    );
  }
  // Opening a day also refreshes the counts on the strip and the member's own list.
  useEffect(() => {
    setRefresh((n) => n + 1);
    void loadMine();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  async function holdSlot(court: Court, hour: number, confirmOverlap = false) {
    const start = `${date}T${String(hour).padStart(2, "0")}:00:00+07:00`;
    setBusy(true);
    try {
      const res = await apiPost<HoldResponse>(
        "/bookings",
        {
          court_id: court.id,
          start_at: start,
          ...(confirmOverlap ? { confirm_overlap: true } : {}),
          ...(promoCode.trim() ? { promo_code: promoCode.trim() } : {}),
        },
        true,
      );
      setHold({ ...res, court_code: court.court_code, hour });
      setOverlap(null);
      setTaken(null);
      toast.success(t("Holding {court} · {code}", { court: court.court_code, code: res.booking.code }));
      load();
    } catch (e) {
      if (e instanceof ApiClientError && e.body.requires_confirm && !confirmOverlap) {
        setOverlap({ court, hour, message: e.body.message });
      } else {
        // Two people reaching for the same 19:00 on a Saturday is the system
        // working, not breaking — but a red toast saying "slot unavailable"
        // leaves the member to start the search again from nothing. Offer the
        // nearest hours that are still open instead, closest first.
        const message = e instanceof Error ? e.message : t("Could not hold that slot");
        // Only when another hour would actually help. A member who has used up
        // their two holds for the day, or whose balance is over the limit, is
        // not going to get anywhere by tapping a different court — offering
        // three of them would just be three more refusals.
        const aboutTheSlot =
          !(e instanceof ApiClientError) ||
          e.body.code === "CONFLICT_SLOT" ||
          e.body.br === "BR-06" ||
          e.body.br === "BR-07";
        // Re-read the day before suggesting anything: the grid on screen is
        // the one that just turned out to be wrong.
        const fresh = aboutTheSlot
          ? await apiGet<{ courts: Court[]; slots: OccSlot[] }>(`/occupancy?date=${date}`).catch(
              () => null,
            )
          : null;
        if (aboutTheSlot) reload();
        setTaken({
          message,
          alts: fresh ? nearestFree(fresh, court, hour, date, hoursOf(venue), limits.book_alternatives) : [],
          canRetry: aboutTheSlot,
        });
      }
    } finally {
      setBusy(false);
    }
  }

  async function confirmPay(method: "transfer") {
    if (!hold) return;
    setBusy(true);
    try {
      // The endpoint issues an invoice and hands back its id. Dropping that on
      // the floor is why a member could pay and never see a receipt — nothing
      // in the UI ever mentioned one existed.
      const res = await apiPost<ConfirmResponse>(`/bookings/${hold.booking.id}/confirm`, { method }, true);
      setHold(null);
      load();
      // A transfer is not a booking yet. Saying "Booking confirmed" here would
      // be the app telling a member their court is theirs while reception has
      // not found a single dong of it in the bank.
      if ("awaiting_transfer" in res) {
        setPending({ amount: hold.due_now_vnd, until: res.hold_until, code: hold.booking.code });
        toast.success(t("Transfer noted"), {
          description: t("Your court is held while reception checks the bank."),
        });
        return;
      }
      if (res.invoice_id) {
        setReceipt(res.invoice_id);
        toast.success(t("Booking confirmed"), {
          description: t("Your receipt is ready."),
          action: {
            label: t("Open receipt"),
            onClick: () => void openInvoice(res.invoice_id!),
          },
        });
      } else {
        toast.success(t("Booking confirmed"));
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Could not confirm the booking"));
    } finally {
      setBusy(false);
    }
  }

  // Sentences that wrap a live component: the translation carries a {placeholder}
  // and the component is dropped in between the two halves.
  const [heldBefore, heldAfter] = t(
    "Reception confirms it against the bank, usually the same day. We hold the slot for another {timer}; after that it goes back on the grid.",
  ).split("{timer}");
  const [keptBefore, keptAfter] = t("It is also kept in {link}.").split("{link}");

  // How many courts the member already has on the day on screen: said before they tap, not after.
  const dayKey = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(iso));
  const onThisDay = (mine ?? []).filter(
    (b) => (b.status === "confirmed" || b.status === "in_use" || b.status === "hold") && dayKey(b.start_at) === date,
  ).length;
  return {
    limits, sports, date, setDate, sport, setSport, data, error, reload, hold, setHold, promoCode,
    setPromoCode, promoOpen, setPromoOpen, notices, overlap, setOverlap, avail, mine, myClasses,
    showAllClasses, setShowAllClasses, windowHours, showAllMine, setShowAllMine, mySubs, moving,
    setMoving, moveError, setMoveError, cancelId, setCancelId, taken, setTaken, busy, onlineOn,
    venue, receipt, setReceipt, pending, setPending, bank, bankOn, transferOpen, setTransferOpen,
    load, moveTo, startMove, holdSlot, confirmPay, heldBefore, heldAfter, keptBefore, keptAfter,
    onThisDay,
  };
}
