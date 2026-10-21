import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ChangeEvent,
  type ComponentProps,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type RefObject,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createLink } from "@tanstack/react-router";
import { createPortal } from "react-dom";
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Minus,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { PAGE_SIZES, lastPageOffset, pageWindow } from "@/lib/paging";
import { locale, t } from "@/lib/i18n";
import { formatDate, statusLabel, statusTone } from "@/lib/arena3/labels";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { EASE_SMOOTH } from "../motion";

type ButtonVariant = "primary" | "ghost" | "outline" | "danger" | "ink" | "espresso";
type ButtonSize = "md" | "sm" | "lg";
type ButtonLook = { variant?: ButtonVariant; size?: ButtonSize };

const BUTTON_BASE =
  "inline-flex items-center whitespace-nowrap justify-center gap-2 font-medium tracking-tight transition-[opacity,transform,background-color,box-shadow,color] duration-150 ease-[var(--ease-smooth)] disabled:bg-disabled disabled:text-disabled-fg disabled:border-transparent disabled:pointer-events-none disabled:shadow-none active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg";
// Softly squared (not pills): sits calmly next to tables, cards and court grids.
const BUTTON_SIZES = {
  lg: "min-h-13 rounded-[var(--radius-md)] px-7 text-[0.95rem]",
  md: "min-h-11 rounded-[var(--radius-md)] px-5 text-sm",
  // 44px on a phone (finger), 36px with a mouse: dense tables stay compact on a desk.
  sm: "min-h-11 rounded-[var(--radius-sm)] px-3.5 text-[0.8125rem] sm:min-h-9",
} as const;
const BUTTON_STYLES = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover",
  ink: "bg-espresso text-espresso-fg hover:opacity-90",
  espresso: "bg-espresso text-espresso-fg hover:opacity-90",
  outline: "border border-line-strong/70 bg-surface text-fg hover:bg-wood",
  ghost: "text-fg hover:bg-wood",
  danger: "bg-danger text-bg hover:opacity-90",
} as const;

/** The look of a button, for the things that must be a link but should read as a button. */
export function buttonClass({ variant = "primary", size = "md" }: ButtonLook = {}) {
  return cn(BUTTON_BASE, BUTTON_SIZES[size], BUTTON_STYLES[variant]);
}

export function Button({
  variant,
  size,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & ButtonLook) {
  return <button className={cn(buttonClass({ variant, size }), className)} {...props} />;
}

/**
 * Plain `<a>` that looks like a button (for same-page `#anchors`). A `<button>` inside an `<a>` is
 * two tab stops and two announcements for one action, so a link that should look like a button is
 * styled itself instead.
 */
export function ButtonAnchor({ variant, size, className, ...props }: ComponentProps<"a"> & ButtonLook) {
  return <a className={cn(buttonClass({ variant, size }), className)} {...props} />;
}

/** A router link that looks like a button: one control, one tab stop, keeps prefetch and "open in new tab". */
export const ButtonLink = createLink(ButtonAnchor);

export function Input({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-11 w-full rounded-[var(--radius-sm)] border border-line-strong/70 bg-surface px-3 text-sm text-fg placeholder:text-subtle outline-none transition-[box-shadow] duration-150 focus:ring-2 focus:ring-accent/30",
        className,
      )}
      {...props}
    />
  );
}

/**
 * An amount of money typed the way people read it: 1,500,000 with the thousands set apart and
 * the currency sign beside it, instead of a bare run of digits that is easy to miscount by a zero.
 *
 * What the caller holds is digits only ("1500000"), so a plain `Number(value)` on save keeps
 * working; only what is drawn is formatted. The caret stays on the same digit while typing.
 */
export function MoneyInput({
  value,
  onChange,
  className,
  wrapClassName,
  ...props
}: Omit<ComponentProps<"input">, "value" | "onChange" | "type" | "ref"> & {
  value: string;
  onChange: (digits: string) => void;
  /** Sizing of the box that holds the field and its "đ" (width, margin); `className` styles the field itself. */
  wrapClassName?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  const [, redraw] = useState(0);
  const digits = value.replace(/\D/g, "");
  const shown = digits ? new Intl.NumberFormat(locale()).format(Number(digits)) : "";

  // After every typed key the text is re-formatted, which throws the caret to the end;
  // walk the new text until the same number of digits has gone by and put it back there.
  useLayoutEffect(() => {
    const el = ref.current;
    const want = caret.current;
    if (!el || want == null || document.activeElement !== el) return;
    caret.current = null;
    let pos = 0;
    let seen = 0;
    while (pos < shown.length && seen < want) {
      if (/\d/.test(shown[pos]!)) seen++;
      pos++;
    }
    el.setSelectionRange(pos, pos);
  });

  function handle(e: ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    caret.current = raw.slice(0, e.target.selectionStart ?? raw.length).replace(/\D/g, "").length;
    onChange(raw.replace(/\D/g, "").replace(/^0+(?=\d)/, "").slice(0, 12));
    // Typing a separator changes no digits, so nothing else would redraw and fix the text.
    redraw((n) => n + 1);
  }

  return (
    <div className={cn("relative", wrapClassName)}>
      <Input
        ref={ref}
        inputMode="numeric"
        autoComplete="off"
        {...props}
        className={cn("pr-8 tabular-nums", className)}
        value={shown}
        onChange={handle}
      />
      <span aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted">
        đ
      </span>
    </div>
  );
}

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Open dialogs, topmost last: with one dialog over another, only the top one answers the keyboard. */
const dialogStack: object[] = [];

/**
 * What a keyboard or screen-reader user needs from a dialog, in one place: focus moves in when it
 * opens, Tab stays inside while it is open, Escape closes it, and focus goes back to whatever
 * opened it. Mark the element that should take focus first with `data-autofocus`; otherwise the
 * panel itself does, so the dialog's title is read out before its first field.
 */
export function useDialog(open: boolean, panel: RefObject<HTMLElement | null>, onClose: () => void) {
  // A fresh arrow function on every render must not re-run the effect (and steal focus back).
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const me = {};
    dialogStack.push(me);
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      const el = panel.current;
      if (!el) return;
      (el.querySelector<HTMLElement>("[data-autofocus]") ?? el).focus({ preventScroll: true });
    });
    const onKey = (e: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== me) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== "Tab") return;
      const el = panel.current;
      if (!el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.getClientRects().length > 0);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        el.focus();
        return;
      }
      const active = document.activeElement;
      const outside = !el.contains(active) || active === el;
      if (e.shiftKey && (active === first || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || (outside && active !== el))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      dialogStack.splice(dialogStack.indexOf(me), 1);
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [open, panel]);
}

/**
 * Native date picker with a readable "17 Sep 2026" overlay (Chromium ignores html lang).
 *
 * The input is transparent rather than hidden, which is what makes the overlay
 * possible — but it also means the only thing that opens the calendar natively
 * is the invisible icon glyph in its corner. Clicking anywhere else on the
 * field did nothing at all, which is exactly how the Reports "Custom from/to"
 * pair came to look broken. `showPicker()` on a click over the whole box is
 * what restores the obvious behaviour, with a real icon so there is something
 * to aim at.
 */
export function DateField({
  value,
  onChange,
  className,
  disabled,
  required,
  invalid,
  min,
  max,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
  disabled?: boolean;
  /**
   * A date the screen cannot do without, because what it shows is loaded by it. Emptying the box
   * (Backspace on a part of it, or "Clear" in the calendar) is then not passed on: the screen keeps
   * the date it has, the box reads "Pick a date" while it is being retyped, and it goes back to the
   * real date when the person leaves it. Without this the empty string reaches `onChange`, which is
   * what a form that checks its own date wants and a screen that fetches by it does not.
   */
  required?: boolean;
  /** The server refused this date: the box is marked the way a refused text field is. */
  invalid?: boolean;
  min?: string;
  max?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  // The `value` the box was emptied from. Remembering which value (not just "emptied") means a new
  // date chosen from outside, a "Tomorrow" button say, ends the blank state without an effect.
  const [blankOf, setBlankOf] = useState<string | null>(null);
  const blank = blankOf === value;
  const bad = invalid || blank;

  const open = () => {
    const el = ref.current;
    if (!el || disabled) return;
    el.focus();
    // Safari and older Firefox have no `showPicker`; there the focus above plus
    // the native field is all we can offer, and typing still works.
    try {
      el.showPicker?.();
    } catch {
      // Chrome throws if the call is not considered user-initiated. Focus stands.
    }
  };

  return (
    <div
      role="presentation"
      onClick={open}
      className={cn(
        "relative flex h-11 min-w-[11rem] items-center gap-2 rounded-[var(--radius-sm)] border border-line bg-surface px-3 transition-[border-color,box-shadow] duration-150",
        disabled
          ? "cursor-not-allowed opacity-50"
          : // The real input is see-through, so its own focus ring cannot show: draw the same ring here.
            "cursor-pointer hover:border-line-strong has-[:focus-visible]:border-accent has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent",
        // Same for the red edge the global rule gives a refused field: it lands on the invisible input.
        bad && "border-danger hover:border-danger has-[:focus-visible]:border-danger",
        className,
      )}
    >
      <span className="pointer-events-none flex-1 truncate text-sm tabular-nums text-fg">
        {value && !blank ? formatDate(value) : <span className={bad ? "text-danger" : "text-subtle"}>{t("Pick a date")}</span>}
      </span>
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="pointer-events-none size-4 shrink-0 text-muted"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
      >
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M8 3v4M16 3v4M3 10h18" />
      </svg>
      <input
        ref={ref}
        type="date"
        value={blank ? "" : value}
        min={min}
        max={max}
        disabled={disabled}
        required={required}
        aria-invalid={bad || undefined}
        aria-describedby={describedBy}
        onChange={(e) => {
          const v = e.target.value;
          if (required && !v) {
            setBlankOf(value);
            return;
          }
          setBlankOf(null);
          onChange(v);
        }}
        onBlur={() => setBlankOf(null)}
        aria-label={ariaLabel ?? t("Pick a date")}
        // Still stretched over the whole field so keyboard focus lands on the
        // real control, but `opacity-0` means the overlay above is what shows.
        className="absolute inset-0 size-full cursor-pointer rounded-[var(--radius-sm)] opacity-0 disabled:cursor-not-allowed"
      />
    </div>
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-11 w-full appearance-none rounded-[var(--radius-sm)] border border-line bg-surface bg-[length:12px] bg-[right_12px_center] bg-no-repeat px-3 pr-9 text-sm text-fg outline-none transition-[box-shadow] duration-150 focus:ring-2 focus:ring-accent/30",
        className,
      )}
      style={{
        backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='none' stroke='%23424c6b' stroke-width='1.75' viewBox='0 0 24 24'><path d='m6 9 6 6 6-6'/></svg>")`,
      }}
      {...props}
    >
      {children}
    </select>
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "w-full rounded-[var(--radius-sm)] border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-subtle outline-none focus:ring-2 focus:ring-accent/30",
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("kicker text-2xs text-muted", className)} {...props} />;
}

export function Card({
  className,
  interactive = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-[var(--radius-xl)] bg-surface p-5 border border-line shadow-[var(--shadow-soft)]",
        interactive &&
          "transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md",
        className,
      )}
      {...props}
    />
  );
}

export function Badge({
  tone = "ink",
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: "ink" | "accent" | "hold" | "muted" | "danger" }) {
  const map = {
    ink: "bg-fg text-bg",
    accent: "bg-accent/12 text-accent-2",
    hold: "bg-hold/12 text-hold",
    muted: "bg-wood text-muted",
    danger: "bg-danger/10 text-danger",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-2xs font-medium tabular-nums",
        map[tone],
        className,
      )}
      {...props}
    />
  );
}

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge tone={statusTone(status)} className={className}>
      {statusLabel(status)}
    </Badge>
  );
}

export function Field({
  label,
  children,
  hint,
  tone = "danger",
}: {
  label: string;
  children: ReactNode;
  /** Validation message or helper text shown under the control. */
  hint?: string;
  tone?: "danger" | "muted";
}) {
  return (
    <label className="grid gap-1.5">
      <Label>{t(label)}</Label>
      {children}
      {hint ? (
        <span className={cn("text-xs", tone === "danger" ? "text-danger" : "text-muted")}>{t(hint)}</span>
      ) : null}
    </label>
  );
}

/**
 * A tick box as a finger-sized row: the whole line toggles it, not just the small square.
 * 44px tall on a phone, 36px with a mouse.
 */
export function Check({
  label,
  hint,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: ReactNode; hint?: ReactNode }) {
  return (
    <label className={cn("flex min-h-11 cursor-pointer items-start gap-3 py-2.5 text-sm sm:min-h-9 sm:py-1.5", className)}>
      <input type="checkbox" className="mt-0.5 size-5 shrink-0 cursor-pointer accent-[var(--color-accent)]" {...props} />
      <span className="min-w-0">
        {label}
        {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn("relative overflow-hidden rounded-[var(--radius-md)] bg-wood", className)}>
      <div className="shimmer absolute inset-0" />
    </div>
  );
}


/**
 * What a panel shows when its data would not load: the reason, and a button that asks again.
 *
 * Without it a panel whose request failed kept its grey blocks for good, with the reason only in a
 * toast that faded after a few seconds. `role="alert"` so a screen reader hears it appear.
 */
export function LoadError({
  message,
  onRetry,
  id,
  title,
}: {
  message: string;
  onRetry?: () => void;
  id?: string;
  /** What did not happen, when "loaded" is the wrong word (a question that got no answer, say). */
  title?: string;
}) {
  return (
    <div
      id={id}
      role="alert"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[var(--radius-lg)] border border-hold/30 bg-hold/5 px-4 py-3 text-sm"
    >
      <div className="min-w-0 flex-1 basis-56">
        <p className="font-medium">{title ?? t("This could not be loaded.")}</p>
        <p className="mt-0.5 text-muted">{message}</p>
      </div>
      {onRetry ? (
        <Button size="sm" variant="outline" onClick={onRetry}>
          {t("Try again")}
        </Button>
      ) : null}
    </div>
  );
}

export function Seg({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  const group = useId();
  const reduced = useReducedMotion();
  return (
    // One line, always: on a narrow phone the segments scroll sideways instead of wrapping into a
    // second row that reads as a different control.
    <div className="inline-flex max-w-full gap-1 overflow-x-auto rounded-[var(--radius-md)] bg-wood p-1">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value || "all"}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className={cn(
              "relative min-h-11 min-w-11 shrink-0 whitespace-nowrap rounded-[var(--radius-sm)] px-3 text-sm font-medium transition-colors duration-200 sm:min-h-9 sm:min-w-9 sm:px-4",
              active ? "text-accent-fg" : "text-muted hover:text-fg",
            )}
          >
            {/* Sliding pill travels between options instead of blinking on. */}
            {active ? (
              reduced ? (
                <span className="absolute inset-0 rounded-[var(--radius-sm)] bg-accent" />
              ) : (
                <motion.span
                  layoutId={`seg-${group}`}
                  className="absolute inset-0 rounded-[var(--radius-sm)] bg-accent"
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                />
              )
            ) : null}
            <span className="relative z-[1]">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * A filter that doubles as a counter: "To call 412". Pressing it narrows the list,
 * pressing another one swaps. Used above long lists so the size of each pile is
 * visible before anyone starts scrolling.
 */
export function FilterChip({
  active,
  onClick,
  label,
  count,
  tone = "default",
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
  tone?: "default" | "hold";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-[var(--radius-pill)] border px-3.5 text-sm font-medium transition-colors duration-150 sm:min-h-9",
        active
          ? "border-accent bg-accent text-accent-fg"
          : "border-line bg-surface text-fg hover:bg-wood",
      )}
    >
      {label}
      {count !== undefined ? (
        <span
          className={cn(
            "rounded-full px-1.5 text-2xs font-semibold tabular-nums",
            active ? "bg-accent-fg/15" : tone === "hold" ? "bg-hold/15 text-hold" : "bg-wood text-muted",
          )}
        >
          {count}
        </span>
      ) : null}
    </button>
  );
}

/**
 * "21-40 of 1,000", rows per page, and the pages themselves: first, last, the ones around the
 * current page, gaps between. An old row is two clicks away instead of twenty presses of Next.
 * Phones get Previous / "Page 3 of 20" / Next, the numbers need more room than a phone has.
 *
 * `onPageSizeChange` adds the rows-per-page picker (pair it with `usePageState`, which remembers
 * the choice per list). A list that shrinks under the current page moves back to its last page.
 */
export function Pagination({
  offset,
  total,
  pageSize,
  onChange,
  onPageSizeChange,
  pageSizes = PAGE_SIZES,
  label,
}: {
  offset: number;
  total: number;
  pageSize: number;
  onChange: (offset: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizes?: readonly number[];
  label?: string;
}) {
  const outOfRange = total > 0 && offset >= total;
  useEffect(() => {
    if (outOfRange) onChange(lastPageOffset(total, pageSize));
  }, [outOfRange, total, pageSize, onChange]);

  if (total <= 0) return null;
  const page = Math.floor(Math.min(offset, total - 1) / pageSize) + 1;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);
  const go = (p: number) => onChange((Math.min(Math.max(p, 1), pages) - 1) * pageSize);
  // The picker only earns its place once there is more than the smallest page to show.
  const picker = onPageSizeChange && total > Math.min(...pageSizes);

  return (
    <nav aria-label={label ?? t("Pages")} className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 text-sm text-muted">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="tabular-nums">
          {t("Showing {from}-{to} of {total}", { from, to, total: total.toLocaleString(locale()) })}
        </span>
        {picker ? (
          <label className="flex items-center gap-2">
            <span>{t("Rows per page")}</span>
            <Select
              value={String(pageSize)}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="h-11 w-auto min-w-[4.5rem] pr-8 tabular-nums sm:h-9"
            >
              {pageSizes.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
      </div>
      {pages > 1 ? (
        <div className="flex items-center gap-1">
          <PageButton label={t("First page")} disabled={page === 1} onClick={() => go(1)}>
            <ChevronsLeft aria-hidden className="size-4" />
          </PageButton>
          <PageButton label={t("Previous page")} disabled={page === 1} onClick={() => go(page - 1)}>
            <ChevronLeft aria-hidden className="size-4" />
          </PageButton>
          <span className="px-2 tabular-nums sm:hidden">{t("Page {page} of {pages}", { page, pages })}</span>
          <div className="hidden items-center gap-1 sm:flex">
            {pageWindow(page, pages).map((p, i) =>
              p === "gap" ? (
                <span key={`gap-${i}`} aria-hidden className="px-1 text-subtle">
                  …
                </span>
              ) : (
                <PageButton key={p} label={t("Page {page}", { page: p })} current={p === page} onClick={() => go(p)}>
                  {p}
                </PageButton>
              ),
            )}
          </div>
          <PageButton label={t("Next page")} disabled={page === pages} onClick={() => go(page + 1)}>
            <ChevronRight aria-hidden className="size-4" />
          </PageButton>
          <PageButton label={t("Last page")} disabled={page === pages} onClick={() => go(pages)}>
            <ChevronsRight aria-hidden className="size-4" />
          </PageButton>
        </div>
      ) : null}
    </nav>
  );
}

function PageButton({
  label,
  current = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  current?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={current ? "page" : undefined}
      disabled={disabled || current}
      onClick={onClick}
      className={cn(
        "inline-grid min-h-11 min-w-11 place-items-center rounded-[var(--radius-sm)] px-2 text-sm tabular-nums transition-colors duration-150 sm:min-h-9 sm:min-w-9",
        current
          ? "bg-accent font-semibold text-accent-fg disabled:opacity-100"
          : "border border-line-strong/70 bg-surface text-fg hover:bg-wood disabled:cursor-not-allowed disabled:opacity-40",
      )}
    >
      {children}
    </button>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  // Portals need a document, which the server render does not have.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Focus in, Tab kept inside, Escape to close, focus handed back to the opener.
  useDialog(open, panel, onClose);

  // The page behind it stops scrolling while it is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  /*
   * Portalled to <body>, not rendered where it is written.
   *
   * A `position: fixed` element inside an ancestor that has a transform is
   * positioned against that ancestor instead of the viewport, and its stacking
   * is trapped there too. Every card on this app is inside an animated
   * wrapper, so a dialog opened from one was painted underneath the page
   * furniture around it — the payments filter row sat on top of the QR code a
   * customer was being asked to scan.
   *
   * `mounted` keeps this off the server render, where there is no document.
   */
  const body = mounted ? document.body : null;

  const dialog = (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-[60]">
          {/* Clicking the dimmed page closes the dialog. Keyboard users have Escape and the
              dialog's own buttons, so this is kept out of the tab order and the reading order. */}
          <motion.div
            role="presentation"
            aria-hidden="true"
            className="absolute inset-0 bg-fg/40 backdrop-blur-[2px]"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="relative mx-auto mt-[8vh] max-h-[84dvh] w-[min(32rem,calc(100%-2rem))] overflow-y-auto rounded-[var(--radius-xl)] bg-surface p-5 shadow-[var(--shadow-soft)] outline-none"
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.28, ease: EASE_SMOOTH }}
          >
            <h2 id={titleId} className="font-display text-2xl">
              {t(title)}
            </h2>
            <div className="mt-4">{children}</div>
            {footer ? <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div> : null}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );

  return body ? createPortal(dialog, body) : null;
}

/**
 * How a figure moved against the period before it.
 *
 * `good` is carried rather than derived from the sign, because whether "up" is
 * good news depends entirely on what is being counted. Revenue climbing is the
 * centre doing well; refunds climbing is the centre doing badly. Painting both
 * green for going up would tell a manager the opposite of what happened.
 */
export type Trend = {
  /** Percent change, or null when there was nothing to compare against. */
  pct: number | null;
  label: string;
  /** null when the figure did not move, or when the direction carries no verdict. */
  good: boolean | null;
};

export function Stat({
  label,
  value,
  hint,
  trend,
  icon: Icon,
  note,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  trend?: Trend;
  icon?: LucideIcon;
  /** Always-visible plain-words definition of the figure. */
  note?: string;
}) {
  const Arrow =
    trend?.pct == null || trend.pct === 0 ? Minus : trend.pct > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <p className="kicker text-2xs text-muted">{t(label)}</p>
        {Icon ? (
          <span aria-hidden="true" className="grid size-8 place-items-center rounded-[var(--radius-sm)] bg-accent/10 text-accent-2">
            <Icon className="size-4" strokeWidth={1.9} />
          </span>
        ) : null}
      </div>
      <p className="figure mt-2.5 text-4xl">{value}</p>
      {trend ? (
        <p
          className={cn(
            "mt-1.5 flex items-center gap-1 text-sm font-medium",
            trend.good === true && "text-accent",
            trend.good === false && "text-danger",
            trend.good == null && "text-muted",
          )}
        >
          <Arrow className="size-4 shrink-0" strokeWidth={2} aria-hidden />
          {trend.label}
        </p>
      ) : hint ? (
        <p className="mt-1.5 text-sm text-muted">{t(hint)}</p>
      ) : null}
      {note ? <p className="mt-2 border-t border-line/70 pt-2 text-xs leading-snug text-muted">{t(note)}</p> : null}
    </Card>
  );
}


/**
 * For catalogue-style lists (classes, plans) where paging would be heavy: show the first few and
 * let the person ask for more. Says how many are hidden so nobody wonders if the list ended.
 */
export function ShowMore({ shown, total, step, onMore }: { shown: number; total: number; step: number; onMore: () => void }) {
  if (shown >= total) return null;
  const left = total - shown;
  return (
    <div className="mt-4 flex flex-col items-center gap-1">
      <Button variant="outline" onClick={onMore}>
        {t("Show {n} more", { n: Math.min(step, left) })}
      </Button>
      <span className="text-xs text-muted tabular-nums">
        {t("{shown} of {total} shown", { shown, total })}
      </span>
    </div>
  );
}

export { PageHero, type PageHeroStat } from "@/components/page-hero";
export { StatStrip, type StatItem } from "@/components/stat-strip";
export { EmptyState, type EmptyStateAction } from "@/components/empty-state";
export { RowActions, type RowActionItem } from "@/components/row-actions";
export { ContextLayout, ContextCard } from "@/components/context-layout";
export { useSports, SportBadge, SportDot, SportThumbnail, type SportInfo } from "@/components/sports-ui";
