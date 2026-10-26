import { cn } from "@/lib/cn";

/**
 * Numbered steps for a long job split into short screens: only the chosen step is on the page,
 * the others are one tap away. The number says "there is an order", the tick says "done".
 */
export function StepTabs({
  value,
  onChange,
  steps,
  numbered = true,
}: {
  value: string;
  onChange: (v: string) => void;
  steps: { value: string; label: string }[];
  numbered?: boolean;
}) {
  return (
    <div role="tablist" className="flex flex-wrap gap-1.5">
      {steps.map((s, i) => {
        const active = s.value === value;
        return (
          <button
            key={s.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(s.value)}
            className={cn(
              numbered ? "min-w-[9.5rem]" : "min-w-[6.5rem] justify-center",
              "flex min-h-12 flex-1 items-center gap-2.5 rounded-[var(--radius-md)] border px-3 text-left text-sm font-medium transition-colors duration-150",
              active
                ? "border-accent bg-accent/10 text-accent-2"
                : "border-line bg-surface text-muted hover:bg-wood hover:text-fg",
            )}
          >
            {numbered ? (
              <span
                aria-hidden
                className={cn(
                  "grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold tabular-nums",
                  active ? "bg-accent text-accent-fg" : "bg-wood text-muted",
                )}
              >
                {i + 1}
              </span>
            ) : null}
            <span className="min-w-0 leading-tight">{s.label}</span>
          </button>
        );
      })}
    </div>
  );
}
