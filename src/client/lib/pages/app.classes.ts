import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useSports } from "@/client/components/ui";
import { apiDelete, apiGet, apiPost } from "@/client/arena3/client";
import { classSlotMatches } from "@/shared/arena3/labels";
import { t, tServer } from "@/client/lib/i18n";
import { useRead } from "@/client/lib/use-read";
import { useLive } from "@/client/lib/use-live";


type Cl = {
  id: string;
  sport: string;
  level: string;
  capacity: number;
  enrolled_count: number;
  court_code: string;
  coach_name: string;
  rrule: string;
  duration_min: number;
  status: string;
  price_vnd: number | null;
  min_enrolled?: number | null;
  start_on?: string;
  end_on?: string;
  description?: string | null;
  syllabus?: string | null;
  who_for?: string | null;
  bring?: string | null;
  my_enrollment: {
    id: string;
    status: string;
    hold_until: string | null;
    price_vnd: number | null;
    transfer_requested_at: string | null;
  } | null;
};


type EnrolQuote = {
  tuition_vnd: number;
  promo: { code: string; discount_vnd: number } | null;
  total_vnd: number;
  eligible: boolean;
  current_end: string | null;
  class_end: string;
  suggested_plan: { name: string; price_vnd: number } | null;
};


type Enr = {
  id: string;
  class_id: string;
  status: string;
  waitlist_pos: number | null;
  /** The class's next scheduled session, and the last moment leaving is allowed (BR-24). */
  next_session_at?: string | null;
  leave_until?: string | null;
};

type Offer = { id: string; class_id: string; expires_at: string; sport: string; level: string };

export function useMemberClasses(useRouteSearch: () => { sport?: string }) {
  const classesRead = useRead<{ items: Cl[] }>("/classes");
  const meRead = useRead<{ enrollments?: Enr[]; offers?: Offer[] }>("/me");
  // The list is only shown once the member's own enrolments are known too: without them every class would read "Enrol".
  const items = classesRead.data && meRead.data ? classesRead.data.items : null;
  const mine = meRead.data?.enrollments ?? [];
  const offers = meRead.data?.offers ?? [];
  const failure = classesRead.error ?? meRead.error;
  const [sport, setSport] = useState(useRouteSearch().sport ?? "");
  const load = () => {
    classesRead.reload();
    meRead.reload();
  };
  useLive("classes", load);

  const sports = useSports();
  const [limit, setLimit] = useState(6);
  const [detail, setDetail] = useState<Cl | null>(null);
  // The member's own classes come first (C-4): they are what someone opens this page to manage.
  const enrolledIds = new Set(mine.map((e) => e.class_id));
  // The order is fixed from the first load: holding a seat must not move the card the member just tapped.
  const pinned = useRef<Set<string> | null>(null);
  if (pinned.current == null && meRead.data) pinned.current = enrolledIds;
  const firstIds = pinned.current ?? enrolledIds;
  // Narrowing by coach, weekday and part of the day saves scrolling through every class.
  const [coach, setCoach] = useState("");
  const [day, setDay] = useState("");
  const [part, setPart] = useState("");
  const coachNames = [...new Set((items ?? []).filter((c) => !sport || c.sport === sport).map((c) => c.coach_name))].sort((a, b) =>
    a.localeCompare(b, "vi"),
  );
  const matching = (items ?? [])
    .filter((c) => !sport || c.sport === sport)
    .filter((c) => !coach || c.coach_name === coach)
    .filter((c) => classSlotMatches(c.rrule, day, part))
    .sort((a, b) => Number(firstIds.has(b.id)) - Number(firstIds.has(a.id)));
  const shown = matching.slice(0, limit);
  useEffect(() => setLimit(6), [sport, coach, day, part]);
  const byClass = Object.fromEntries(mine.map((e) => [e.class_id, e]));
  // Leaving a class (or the waitlist) is asked twice: one tap used to give the seat away.
  const [leaving, setLeaving] = useState<{ enr: Enr; cls: Cl } | null>(null);
  // The class being enrolled in, with what it will cost said before anything is held.
  const [enrolling, setEnrolling] = useState<{ cls: Cl; quote: EnrolQuote } | null>(null);
  const [enrolCode, setEnrolCode] = useState("");
  const [enrolBusy, setEnrolBusy] = useState(false);

  async function openQuote(cls: Cl, code = "") {
    setEnrolBusy(true);
    try {
      const qs = code.trim() ? `?promo_code=${encodeURIComponent(code.trim())}` : "";
      const quote = await apiGet<EnrolQuote>(`/classes/${cls.id}/quote${qs}`);
      setEnrolling({ cls, quote });
    } catch (e) {
      toast.error(enrolError(e));
    } finally {
      setEnrolBusy(false);
    }
  }

  /** The gate's refusal is shown from here, so it reads in the member's language. */
  function enrolError(e: unknown): string {
    const body = (e as { body?: { br?: string; class_end?: string } } | null)?.body;
    if (body?.br === "BR-19" && body.class_end) {
      return t("Your membership must end after this class ends ({date}). Buy or extend a plan first.", { date: body.class_end });
    }
    return e instanceof Error ? tServer(e.message) : t("Could not enrol");
  }

  async function enrol(cls: Cl, code = "") {
    setEnrolBusy(true);
    try {
      const r = await apiPost<{ waitlisted?: boolean; enrollment?: { status?: string } }>(
        `/classes/${cls.id}/enroll`,
        code.trim() ? { promo_code: code.trim() } : {},
      );
      toast.success(
        r.waitlisted
          ? t("Added to the waitlist")
          : r.enrollment?.status === "hold"
            ? t("Seat held. Pay before the timer runs out.")
            : t("You are enrolled"),
      );
      setEnrolling(null);
      setEnrolCode("");
      load();
    } catch (e) {
      toast.error(enrolError(e));
    } finally {
      setEnrolBusy(false);
    }
  }
  const [leaveBusy, setLeaveBusy] = useState(false);
  // One seat action at a time: asking for a transfer or releasing a hold both settle on the server.
  const [seatBusy, setSeatBusy] = useState<string | null>(null);
  async function askTransfer(enrId: string) {
    if (seatBusy) return;
    setSeatBusy(enrId);
    try {
      await apiPost(`/enrollments/${enrId}/transfer`);
      toast.success(t("The desk has been told. Your seat stays held."));
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Could not ask the desk"));
    } finally {
      setSeatBusy(null);
      load();
    }
  }
  async function releaseSeat(enrId: string) {
    if (seatBusy) return;
    setSeatBusy(enrId);
    try {
      await apiDelete(`/enrollments/${enrId}`);
      toast.success(t("Seat released"));
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Could not release the seat"));
    } finally {
      setSeatBusy(null);
      load();
    }
  }
  async function leave() {
    if (!leaving || leaveBusy) return;
    setLeaveBusy(true);
    try {
      await apiDelete(`/enrollments/${leaving.enr.id}`);
      toast.success(leaving.enr.status === "waitlisted" ? t("Left the waitlist") : t("Enrolment cancelled"));
      setLeaving(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("Could not cancel"));
    } finally {
      setLeaveBusy(false);
    }
  }
  return {
    items, mine, offers, failure, sport, setSport, load, sports, setLimit, detail, setDetail,
    coach, setCoach, day, setDay, part, setPart, coachNames, matching, shown, byClass, leaving,
    setLeaving, enrolling, setEnrolling, enrolCode, setEnrolCode, enrolBusy, openQuote, enrol,
    leaveBusy, seatBusy, askTransfer, releaseSeat, leave,
  };
}

export { type Cl };
