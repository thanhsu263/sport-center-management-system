import { useState } from "react";
import { toast } from "sonner";
import { Button, ButtonLink, Card, Modal } from "@/components/ui";
import { money, when } from "@/components/shell";
import { Stagger, StaggerItem } from "@/components/motion";
import { apiPost, openInvoice } from "@/lib/arena3/client";
import { sportLabel } from "@/lib/arena3/labels";
import { locale, t, tServer } from "@/lib/i18n";

export type Notification = {
  id: string;
  template: string;
  payload: unknown;
  sent_at: string;
  read_at: string | null;
};

type Content = {
  title: string;
  body: string;
  /** Somewhere to go from here, when there is somewhere. */
  link?: { to: string; label: string };
  receipt?: { invoice_id: string };
};

function asObj(p: unknown): Record<string, unknown> {
  return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
}

function methodLabel(m: unknown) {
  switch (String(m)) {
    case "cash":
      return t("cash");
    case "card":
      return t("card");
    case "transfer":
      return t("bank transfer");
    case "quota":
      return t("plan hours");
    default:
      return t("payment");
  }
}

/** Short date and time for a class session, in the language that is on. */
function sessionWhen(iso: string) {
  return new Date(iso).toLocaleString(locale(), {
    timeZone: "Asia/Ho_Chi_Minh",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * What a notification says once it is opened. The row in the list only has room
 * for a headline; this is the sentence behind it, built from what was stored.
 */
export function notificationContent(n: Pick<Notification, "template" | "payload">): Content {
  const p = asObj(n.payload);
  const code = typeof p.code === "string" ? p.code : null;
  switch (n.template) {
    case "payment_receipt": {
      const amount = typeof p.amount_vnd === "number" ? money(p.amount_vnd) : null;
      const method = methodLabel(p.method);
      return {
        title: amount ? t("Receipt · {amount}", { amount }) : t("Payment receipt"),
        body: amount
          ? t("We took {amount} by {method}. The receipt is saved to your account.", { amount, method })
          : t("A payment was recorded by {method}. The receipt is saved to your account.", { method }),
        receipt: typeof p.invoice_id === "string" ? { invoice_id: p.invoice_id } : undefined,
      };
    }
    case "booking_confirmed":
      return {
        title: t("Booking confirmed"),
        body: code
          ? t("Booking {code} is confirmed. Show your member code at the desk when you arrive.", { code })
          : t("Your booking is confirmed. Show your member code at the desk when you arrive."),
        link: { to: "/app/book", label: t("See my bookings") },
      };
    case "booking_cancelled":
      return {
        title: t("Booking cancelled"),
        body: t("That booking was cancelled and the court is free again. Any refund follows the cancellation rules."),
        link: { to: "/app/book", label: t("Book another court") },
      };
    case "booking_rescheduled":
      return {
        title: t("Booking moved"),
        body: code
          ? t("Booking {code} now has the new court time you picked. The old slot is free again.", { code })
          : t("Your booking now has the new court time you picked. The old slot is free again."),
        link: { to: "/app/book", label: t("See my bookings") },
      };
    case "transfer_requested":
      return {
        title: t("Transfer noted"),
        body: t("Reception has been told you sent the bank transfer. They will confirm it when it reaches the account, and your booking is held until then."),
        link: { to: "/app/book", label: t("See my bookings") },
      };
    case "transfer_rejected":
      return {
        title: t("We could not find your transfer"),
        body: t("The transfer did not reach the account. Check the amount and the reference, or pay at the desk. Your hold keeps running until it ends."),
        link: { to: "/app/book", label: t("See my bookings") },
      };
    case "hold_expiring":
    case "hold_expired":
      return {
        title: n.template === "hold_expired" ? t("Your hold ended") : t("Your hold is about to expire"),
        body:
          n.template === "hold_expired"
            ? t("The hold ran out before payment, so the court was released.")
            : t("Pay before the hold ends or the court goes back on sale."),
        link: { to: "/app/book", label: t("Open bookings") },
      };
    case "class_changed": {
      const reason =
        typeof p.reason === "string" && p.reason !== "conflict" ? ` ${t("Reason: {reason}.", { reason: p.reason })}` : "";
      const link = { to: "/app/classes", label: t("Open my classes") };
      switch (p.kind) {
        case "session_cancelled":
          return {
            title: t("A class session was cancelled"),
            body: `${typeof p.start === "string" ? t("The session on {when} will not run.", { when: sessionWhen(p.start) }) : t("A session will not run.")}${reason}`,
            link,
          };
        case "session_moved":
          return {
            title: t("A class session moved"),
            body: `${typeof p.start === "string" ? t("It now starts {when}.", { when: sessionWhen(p.start) }) : t("It has a new time.")}${reason}`,
            link,
          };
        case "coach_changed":
          return {
            title: t("Your class has a new coach"),
            body: `${typeof p.coach_name === "string" ? t("{name} takes the sessions still to come.", { name: p.coach_name }) : t("A new coach takes the sessions still to come.")}${reason}`,
            link,
          };
        case "class_cancelled":
          return {
            title: t("A class was cancelled"),
            body: `${t("The class has been cancelled and any session you had in it is given back.")}${reason}`,
            link,
          };
        default:
          return {
            title: t("Class schedule changed"),
            body:
              p.reason === "conflict"
                ? t("A class could not be scheduled for one date because the court or coach was busy.")
                : t("A class you are in has changed. Open your classes to see the new time and court."),
            link,
          };
      }
    }
    case "sub_expiring":
      return {
        title: t("Plan expiring soon"),
        body: t("Your plan ends within a week. Renew to keep your court hours and discount."),
        link: { to: "/app/plans", label: t("See plans") },
      };
    case "waitlist_offer":
      return {
        title: t("A class seat opened"),
        body: t("A seat is yours if you claim it before the offer runs out."),
        link: { to: "/app/classes", label: t("Claim the seat") },
      };
    case "refund_approved": {
      const amount = typeof p.amount_vnd === "number" ? money(p.amount_vnd) : null;
      const subject = amount
        ? code
          ? t("{amount} ({code}) was approved and paid back.", { amount, code })
          : t("{amount} was approved and paid back.", { amount })
        : code
          ? t("Your refund ({code}) was approved and paid back.", { code })
          : t("Your refund was approved and paid back.");
      return {
        title: t("Refund approved"),
        body: `${subject}${typeof p.note === "string" ? ` ${t("Note: {note}", { note: p.note })}` : ""}`,
      };
    }
    case "refund_rejected":
      return {
        title: t("Refund declined"),
        body: `${code ? t("Your refund request {code} was declined.", { code }) : t("Your refund request was declined.")} ${
          typeof p.note === "string" ? t("Reason: {note}", { note: p.note }) : t("Ask reception if you want to know why.")
        }`,
      };
    case "homework_assigned": {
      const coach = typeof p.coach_name === "string" ? p.coach_name : t("Your coach");
      const title = typeof p.title === "string" ? p.title : t("homework");
      return {
        title: t("New homework"),
        body:
          typeof p.due_on === "string"
            ? t("{coach} set “{title}”, due {date}.", { coach, title, date: p.due_on })
            : t("{coach} set “{title}”.", { coach, title }),
        link: { to: "/app/train", label: t("Open my progress") },
      };
    }
    case "review_added": {
      const coach = typeof p.coach_name === "string" ? p.coach_name : t("Your coach");
      const sport = typeof p.sport === "string" ? sportLabel(p.sport).toLowerCase() : null;
      const weeks = typeof p.period_weeks === "number" ? p.period_weeks : null;
      const body =
        weeks !== null
          ? sport
            ? t("{coach} reviewed your last {weeks} weeks of {sport}.", { coach, weeks, sport })
            : t("{coach} reviewed your last {weeks} weeks.", { coach, weeks })
          : sport
            ? t("{coach} reviewed your recent weeks of {sport}.", { coach, sport })
            : t("{coach} reviewed your recent weeks.", { coach });
      return {
        title: t("Your coach wrote a review"),
        body,
        link: { to: "/app/train", label: t("Read it") },
      };
    }
    case "absent_streak": {
      const name = typeof p.member_name === "string" ? p.member_name : t("A student");
      const streak = typeof p.streak === "number" ? p.streak : t("several");
      const sport = typeof p.sport === "string" ? sportLabel(p.sport).toLowerCase() : null;
      return {
        title: t("Three absences in a row"),
        body: sport
          ? t("{name} has missed {streak} sessions in a row of {sport}. Worth a check-in.", { name, streak, sport })
          : t("{name} has missed {streak} sessions in a row. Worth a check-in.", { name, streak }),
        link: typeof p.user_id === "string" ? { to: `/coach/student/${p.user_id}`, label: t("Open their profile") } : undefined,
      };
    }
    case "chat_message": {
      const senderName = typeof p.sender_name === "string" ? p.sender_name : t("Someone");
      const preview = typeof p.preview === "string" ? p.preview : "";
      const convId = typeof p.conversation_id === "string" ? p.conversation_id : "";
      return {
        title: t("New message from {name}", { name: senderName }),
        body: preview || t("You have a new message."),
        link: convId ? { to: `/chat?conv=${convId}`, label: t("Open chat") } : { to: "/chat", label: t("Open chat") },
      };
    }
    case "ticket_replied":
      return {
        title: t("Reception replied"),
        body: typeof p.reply === "string" && p.reply ? p.reply : t("Reception answered your message."),
        link: { to: "/account", label: t("Open Support") },
      };
    default:
      return { title: n.template.replace(/_/g, " "), body: t("Open your account for the details.") };
  }
}

/**
 * The member's notifications. A row opens its content and marks itself read;
 * unread ones carry a dot, so a glance at the list says what is new.
 */
export function NotificationList({
  items,
  onRead,
  limit = 8,
  hideRead = false,
}: {
  items: Notification[];
  /** Called with the ids just marked read, so the owner can update its copy. */
  onRead: (ids: string[]) => void;
  limit?: number;
  /** Tuck read notifications out of the list. Nothing is deleted. */
  hideRead?: boolean;
}) {
  const [open, setOpen] = useState<Notification | null>(null);
  const [all, setAll] = useState(false);
  const unread = items.filter((n) => !n.read_at);
  const visible = hideRead ? unread : items;
  const shown = all ? visible : visible.slice(0, limit);

  async function openOne(n: Notification) {
    setOpen(n);
    if (n.read_at) return;
    onRead([n.id]);
    try {
      await apiPost("/me/notifications/read", { id: n.id });
    } catch {
      // The flag is a convenience; failing to save it must not block reading.
    }
  }

  const c = open ? notificationContent(open) : null;

  return (
    <>
      {unread.length ? (
        <div className="mt-2 flex items-center justify-between text-sm text-muted">
          <span>{t("{n} unread", { n: unread.length })}</span>
          <button
            type="button"
            className="hit underline"
            onClick={async () => {
              const ids = unread.map((n) => n.id);
              try {
                await apiPost("/me/notifications/read", {});
                // Only once the server has them as read, so the list never claims more than is true.
                onRead(ids);
              } catch (e) {
                toast.error(e instanceof Error ? tServer(e.message) : t("Could not mark them read"));
              }
            }}
          >
            {t("Mark all read")}
          </button>
        </div>
      ) : null}
      {/* One card per message. The headline alone repeated ("Booking confirmed" twelve times), so
          each card also carries the first line of what it says: which court, when, how much. */}
      <Stagger className="mt-3 grid gap-2" gap={0.04}>
        {shown.map((n) => {
          const row = notificationContent(n);
          return (
            <StaggerItem key={n.id}>
              <button type="button" className="block w-full text-left" onClick={() => void openOne(n)}>
                <Card className="flex items-start gap-3 p-4 transition-colors duration-200 hover:bg-wood/40">
                  <span
                    aria-label={n.read_at ? t("Read") : t("Unread")}
                    className={`mt-1.5 size-2 shrink-0 rounded-full ${n.read_at ? "bg-transparent" : "bg-accent"}`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-3">
                      <span className={`truncate text-sm text-fg ${n.read_at ? "" : "font-semibold"}`}>{row.title}</span>
                      <span className="shrink-0 text-xs tabular-nums text-subtle">{when(n.sent_at)}</span>
                    </span>
                    {row.body ? <span className="mt-0.5 line-clamp-1 block text-sm text-muted">{row.body}</span> : null}
                  </span>
                </Card>
              </button>
            </StaggerItem>
          );
        })}
      </Stagger>
      {visible.length > limit ? (
        <div className="mt-2 flex justify-center">
          <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
            {all ? t("Show fewer") : t("Show all {n}", { n: visible.length })}
          </Button>
        </div>
      ) : null}
      <Modal
        open={!!open}
        onClose={() => setOpen(null)}
        title={c?.title ?? t("Notification")}
        footer={
          <div className="flex justify-end gap-2">
            {c?.receipt ? (
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    await openInvoice(c.receipt!.invoice_id);
                  } catch (e) {
                    toast.error(e instanceof Error ? tServer(e.message) : t("The receipt would not open"));
                  }
                }}
              >
                {t("Open receipt")}
              </Button>
            ) : null}
            {c?.link ? (
              <ButtonLink to={c.link.to} variant="outline" onClick={() => setOpen(null)}>
                {c.link.label}
              </ButtonLink>
            ) : null}
            <Button variant="ghost" onClick={() => setOpen(null)}>
              {t("Close")}
            </Button>
          </div>
        }
      >
        {open && c ? (
          <div className="grid gap-2 text-sm">
            <p>{c.body}</p>
            <p className="text-xs text-muted">{when(open.sent_at)}</p>
          </div>
        ) : null}
      </Modal>
    </>
  );
}
