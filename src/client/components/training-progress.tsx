import { useEffect, useState } from "react";
import { Flame, Trophy, Clock } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { useReducedMotionAfterMount } from "./motion";

export function ActivityRings({
  pct,
  sessionsDone = 0,
  sessionsGoal,
  className,
}: {
  pct?: number | null;
  sessionsDone?: number;
  sessionsGoal?: number | null;
  className?: string;
}) {
  const reduced = useReducedMotionAfterMount();
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  const hasGoal = sessionsGoal != null && sessionsGoal > 0;
  const displayPct = hasGoal
    ? (pct ?? Math.min(100, Math.round((sessionsDone / sessionsGoal) * 100)))
    : sessionsDone > 0
      ? 100
      : 0;
  const strokeDashoffset = circumference - (displayPct / 100) * circumference;

  return (
    <div className={cn("flex flex-col items-center justify-center p-4 text-center sm:p-5", className)}>
      <div className="relative flex items-center justify-center size-28 sm:size-32">
        <svg className="size-full -rotate-90 transform" viewBox="0 0 100 100">
          {/* Background Track */}
          <circle
            cx="50"
            cy="50"
            r={radius}
            className="stroke-line"
            strokeWidth="9"
            fill="transparent"
          />
          {/* Progress Ring */}
          <circle
            cx="50"
            cy="50"
            r={radius}
            className={cn("stroke-accent", reduced ? "" : "transition-all duration-1000 ease-out")}
            strokeWidth="9"
            strokeDasharray={circumference}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            fill="transparent"
          />
        </svg>

        {/* Center content */}
        <div className="absolute flex flex-col items-center justify-center">
          {hasGoal ? (
            <>
              <span className="font-display text-xl font-bold text-fg sm:text-2xl">{displayPct}%</span>
              <span className="text-2xs text-muted font-medium">{t("Goal")}</span>
            </>
          ) : (
            <>
              <span className="font-display text-xl font-bold text-fg sm:text-2xl">{sessionsDone}</span>
              <span className="text-2xs text-muted font-medium">{t("Sessions")}</span>
            </>
          )}
        </div>
      </div>

      <p className="mt-2.5 text-xs font-semibold text-fg">
        {hasGoal
          ? t("{done} of {goal} sessions", { done: sessionsDone, goal: sessionsGoal })
          : t("{n} completed sessions", { n: sessionsDone })}
      </p>
    </div>
  );
}

export function WorkoutStreak({
  days = 0,
  activeDays = [false, false, false, false, false, false, false],
  className,
}: {
  days?: number;
  activeDays?: boolean[];
  className?: string;
}) {
  const weekDays = [t("M"), t("T"), t("W"), t("T"), t("F"), t("S"), t("S")];

  return (
    <div className={cn("flex flex-col justify-between rounded-[var(--radius-lg)] border border-line bg-surface p-4 shadow-[var(--shadow-soft)]", className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="grid size-8 place-items-center rounded-full bg-hold/15 text-hold">
            <Flame className="size-4.5" strokeWidth={2.2} />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-fg sm:text-sm">{t("Workout streak")}</h4>
            <p className="text-2xs text-muted">
              {days > 0 ? t("{n} days in a row", { n: days }) : t("Train regularly to build a streak!")}
            </p>
          </div>
        </div>
        <span className="font-display text-lg font-bold text-hold sm:text-xl">
          {days} {t("days")}
        </span>
      </div>

      {/* 7-day pill strip */}
      <div className="mt-3.5 flex items-center justify-between gap-1">
        {weekDays.map((d, i) => (
          <div key={i} className="flex flex-col items-center gap-1.5">
            <span className="text-2xs font-medium text-muted">{d}</span>
            <div
              className={cn(
                "size-6 sm:size-7 rounded-full flex items-center justify-center text-2xs font-semibold transition-colors",
                activeDays[i]
                  ? "bg-accent text-accent-fg shadow-[var(--shadow-accent)]"
                  : "bg-wood/60 text-muted",
              )}
            >
              {activeDays[i] ? "✓" : "·"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function NextMilestoneCard({
  target,
  className,
}: {
  target?: string | null;
  className?: string;
}) {
  if (!target) {
    return (
      <div className={cn("flex flex-col justify-between rounded-[var(--radius-lg)] border border-line bg-surface p-4 shadow-[var(--shadow-soft)]", className)}>
        <div className="flex items-center gap-2">
          <div className="grid size-8 place-items-center rounded-full bg-accent/15 text-accent-2">
            <Trophy className="size-4.5" strokeWidth={2} />
          </div>
          <div>
            <h4 className="text-xs font-semibold text-fg sm:text-sm">{t("Skill milestones")}</h4>
            <p className="text-2xs text-muted">{t("Enrol in a class to unlock milestones.")}</p>
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between">
          <p className="text-2xs text-muted">{t("Learn techniques with coach")}</p>
          <a
            href="/app/classes"
            className="inline-flex items-center justify-center rounded-[var(--radius-md)] bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg transition-colors hover:opacity-90"
          >
            {t("Explore classes")}
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("flex flex-col justify-between rounded-[var(--radius-lg)] border border-line bg-surface p-4 shadow-[var(--shadow-soft)]", className)}>
      <div className="flex items-center gap-2">
        <div className="grid size-8 place-items-center rounded-full bg-accent/15 text-accent-2">
          <Trophy className="size-4.5" strokeWidth={2} />
        </div>
        <div>
          <h4 className="text-xs font-semibold text-fg sm:text-sm">{t("Next milestone")}</h4>
          <p className="text-2xs text-muted">{t("Current level: {level}", { level: target })}</p>
        </div>
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between text-2xs font-medium text-muted mb-1.5">
          <span>{t("Progress")}</span>
          <span className="font-semibold text-accent-2">{t("Coach assessment")}</span>
        </div>
        <p className="text-xs text-muted">
          {t("Your coach reviews and updates your level after class sessions.")}
        </p>
      </div>
    </div>
  );
}

export function SessionCountdown({
  startAt,
  className,
}: {
  startAt: string;
  className?: string;
}) {
  const [left, setLeft] = useState<string>("");

  useEffect(() => {
    function update() {
      const diff = new Date(startAt).getTime() - Date.now();
      if (diff <= 0) {
        setLeft(t("Starting now"));
        return;
      }
      const hrs = Math.floor(diff / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      if (hrs > 24) {
        const days = Math.floor(hrs / 24);
        setLeft(t("in {n} days", { n: days }));
      } else if (hrs > 0) {
        setLeft(t("in {h}h {m}m", { h: hrs, m: mins }));
      } else {
        setLeft(t("in {m} minutes", { m: mins }));
      }
    }
    update();
    const interval = setInterval(update, 30000);
    return () => clearInterval(interval);
  }, [startAt]);

  return (
    <div className={cn("inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-accent/10 px-2.5 py-1 text-xs font-semibold text-accent-2", className)}>
      <Clock className="size-3.5" />
      <span>{left}</span>
    </div>
  );
}
