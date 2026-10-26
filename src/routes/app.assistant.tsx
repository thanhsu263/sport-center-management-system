import { createFileRoute, Link } from "@tanstack/react-router";
import { Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AssistantMark } from "@/components/mark";
import { Shell } from "@/components/shell";
import { Button, LoadError } from "@/components/ui";
import { AnimatePresence, motion } from "motion/react";
import { GLBackground, Magnet, ShinyText } from "@/components/fx";
import { apiPost } from "@/lib/arena3/client";
import { cn } from "@/lib/cn";
import { scrollBehavior } from "@/lib/calm";
import { t, tk } from "@/lib/i18n";

export const Route = createFileRoute("/app/assistant")({ component: Page });

type Msg = { role: "me" | "bot"; text: string; source?: "gemini" | "xai" | "rules" };

/**
 * The longest question the assistant will read.
 *
 * This is the server's own limit, not a number picked for the UI. `assistantChat`
 * slices the message at 800 characters and answers whatever survives, so a long
 * question used to come back answered confidently — and wrong, because the half
 * that mattered was cut off silently. Stopping the typing at the same boundary
 * is the only place a member can be told about it.
 */
const MAX_CHARS = 800;

/** Where the remaining-characters line starts showing itself. */
const COUNTER_FROM = MAX_CHARS - 120;

// The chip's English text is what gets sent to the assistant; only the label drawn is translated.
const CHIPS = [
  tk("What are your opening hours?"),
  tk("Which plans are on sale?"),
  tk("Who coaches badminton?"),
  tk("How do I cancel a court?"),
];

const WELCOME: Msg = {
  role: "bot",
  text: tk(
    "Ask about the timetable, plans, coaches, cancelling, or waitlists. Every answer is grounded in the centre's own data. Type «ticket: …» to send a note to the desk.",
  ),
};

function sourceLabel(s?: Msg["source"]) {
  if (s === "gemini") return "Gemini";
  if (s === "xai") return "Grok";
  if (s === "rules") return t("in-house");
  return null;
}

function Page() {
  const [q, setQ] = useState("");
  const [log, setLog] = useState<Msg[]>([WELCOME]);
  const [busy, setBusy] = useState(false);
  // The question that got no answer, and why. Kept in the thread rather than in a toast that fades, so
  // the member can see what was asked and ask it again without typing it out a second time.
  const [failure, setFailure] = useState<{ message: string; reason: string } | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: scrollBehavior(), block: "end" });
  }, [log, busy, failure]);

  /** Asks the server about `message`, which is already the last line of `thread`. */
  async function ask(message: string, thread: Msg[]) {
    setBusy(true);
    setFailure(null);
    try {
      const history = thread
        .filter((m) => m !== WELCOME)
        .slice(0, -1)
        .map((m) => ({ role: m.role, text: m.text }));
      const r = await apiPost<{ reply: string; source?: Msg["source"] }>("/assistant", { message, history });
      setLog((l) => [...l, { role: "bot", text: r.reply, source: r.source }]);
    } catch (e) {
      setFailure({ message, reason: e instanceof Error ? e.message : t("The assistant is switched off") });
    } finally {
      setBusy(false);
    }
  }

  function send(text?: string) {
    // Trimmed before the cap so trailing spaces cannot eat the last words.
    const message = (text ?? q).trim().slice(0, MAX_CHARS);
    if (message.length < 2 || busy) return;
    setQ("");
    const nextLog: Msg[] = [...log, { role: "me", text: message }];
    setLog(nextLog);
    void ask(message, nextLog);
  }

  return (
    <Shell
      role="member"
      title={t("Assistant")}
      subtitle={t("Answers use Lê Long Sport Center's timetable, plans and coaches.")}
    >
      {/* The dot field tracks the cursor behind the thread — it makes an empty
          conversation feel awake without competing with the messages. */}
      <GLBackground
        variant="dotgrid"
        position="fixed"
        className="-z-[1]"
        color="#3f7d20"
        gap={30}
        dot={1.6}
        radius={140}
        opacity={0.18}
      />
      {/* One framed panel rather than bubbles floating loose on the page. The
          thread scrolls inside it and the composer is pinned to its foot, so
          the conversation reads as a single object with a beginning and an end. */}
      <div className="relative mx-auto flex max-w-2xl flex-col overflow-hidden rounded-[var(--radius-xl)] border border-line bg-surface/70 shadow-[0_24px_60px_-40px_rgba(20,28,18,0.7)] backdrop-blur-sm">
        <div className="flex items-center gap-2.5 border-b border-line/70 bg-surface/80 px-4 py-3">
          <span className="relative grid size-8 shrink-0 place-items-center rounded-full bg-accent/12 text-accent">
            <AssistantMark className="size-4" strokeWidth={1.9} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium leading-tight">{t("Lê Long Sport Center assistant")}</p>
            <p className="text-2xs text-muted">{t("Grounded in this centre's timetable and prices")}</p>
          </div>
          {log.length > 1 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setLog([WELCOME]);
                setFailure(null);
                setQ("");
              }}
            >
              {t("Clear")}
            </Button>
          ) : null}
        </div>

      <div className="relative grid max-h-[min(58vh,34rem)] gap-3 overflow-y-auto p-4">
        {log.map((m, i) => (
          <motion.div
            key={`${i}-${m.role}`}
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              "max-w-[85%] rounded-[var(--radius-lg)] px-4 py-3 shadow-[var(--shadow-border)]",
              m.role === "me"
                ? "ml-auto bg-accent text-accent-fg"
                : "mr-auto bg-surface text-fg",
            )}
          >
            <p className={cn("text-2xs", m.role === "me" ? "text-accent-fg/70" : "text-muted")}>
              {m.role === "me" ? t("You") : t("Assistant")}
            </p>
            <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-relaxed">
              {m === WELCOME ? t(m.text) : m.text}
            </p>
            {m.role === "bot" && sourceLabel(m.source) ? (
              <p className="mt-2 text-2xs text-muted">{sourceLabel(m.source)}</p>
            ) : null}
          </motion.div>
        ))}
        <AnimatePresence>
        {busy ? (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="mr-auto max-w-[85%] rounded-[var(--radius-lg)] bg-surface px-4 py-3 shadow-[var(--shadow-border)]"
          >
            <ShinyText className="shiny-muted text-2xs" speed={2.4}>
              {t("Assistant")}
            </ShinyText>
            <p className="mt-1 flex items-center gap-1 text-sm text-muted">
              {t("Typing")}
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className="inline-block size-1 rounded-full bg-muted"
                  animate={{ opacity: [0.2, 1, 0.2] }}
                  transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.18 }}
                />
              ))}
            </p>
          </motion.div>
        ) : null}
        </AnimatePresence>
        {failure && !busy ? (
          <LoadError
            title={t("The assistant could not answer.")}
            message={failure.reason}
            onRetry={() => void ask(failure.message, log)}
          />
        ) : null}
        <div ref={bottom} />
      </div>

        <div className="border-t border-line/70 bg-surface/80 p-3">
          {!busy && log.length < 3 ? (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
              className="mb-3 flex flex-wrap gap-2"
            >
              {CHIPS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => send(c)}
                  className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface px-3.5 py-2 text-left text-xs font-medium text-fg transition-[background-color,border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-accent hover:bg-wood active:scale-95 sm:min-h-9"
                >
                  {t(c)}
                </button>
              ))}
            </motion.div>
          ) : null}

          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <input
              value={q}
              onChange={(e) => setQ(e.target.value.slice(0, MAX_CHARS))}
              placeholder={t("Ask about prices, opening hours, coaches…")}
              disabled={busy}
              // maxLength stops typing; the slice above stops a paste, which
              // maxLength does not always catch on every browser.
              maxLength={MAX_CHARS}
              aria-describedby={q.length >= COUNTER_FROM ? "assistant-remaining" : undefined}
              className="h-11 min-w-0 flex-1 rounded-[var(--radius-pill)] border border-line bg-bg px-4 text-sm text-fg placeholder:text-subtle outline-none transition-[box-shadow,border-color] duration-150 focus:border-accent/40 focus:ring-2 focus:ring-accent/25"
            />
            <Magnet radius={110} pull={0.25} wrapperClassName="shrink-0">
              <Button type="submit" disabled={busy || q.trim().length < 2} aria-label={t("Send")} className="size-11 shrink-0 px-0">
                <Send className="size-4" />
              </Button>
            </Magnet>
          </form>

          {/* Silent until it is nearly relevant. A counter sitting under an empty
              box reads as a form with a word limit; what a member needs is a
              warning shortly before the box stops accepting their typing. */}
          {q.length >= COUNTER_FROM ? (
            <p
              id="assistant-remaining"
              aria-live="polite"
              className={cn(
                "mt-2 px-4 text-2xs tabular-nums",
                q.length >= MAX_CHARS ? "text-danger" : "text-muted",
              )}
            >
              {q.length >= MAX_CHARS
                ? t("That is as long as a question can be.")
                : t("{n} characters left", { n: MAX_CHARS - q.length })}
            </p>
          ) : null}
        </div>
      </div>

      <p className="mx-auto mt-3 max-w-2xl text-2xs text-muted">
        {t("No medical advice. Booking still happens on {book} and {classes}.")
          .split(/(\{book\}|\{classes\})/)
          .map((part, i) =>
            part === "{book}" ? (
              <Link key={i} to="/app/book" className="underline">
                {t("Book")}
              </Link>
            ) : part === "{classes}" ? (
              <Link key={i} to="/app/classes" className="underline">
                {t("Classes")}
              </Link>
            ) : (
              part
            ),
          )}
      </p>
    </Shell>
  );
}
