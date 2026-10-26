import { useState } from "react";
import { Button, Input } from "@/components/ui";
import { apiPost } from "@/lib/arena3/client";
import { locale, t, tServer } from "@/lib/i18n";

export type PromoQuote = {
  valid: boolean;
  code: string;
  name: string;
  order_vnd: number;
  discount_vnd: number;
  final_vnd: number;
};

/**
 * One code box for every order form. "Apply" asks the server what the code would
 * take off (nothing is written), so the price on screen is the price that gets
 * charged. The parent keeps the applied code and sends it with the order itself.
 */
export function PromoInput({
  scope,
  target,
  onChange,
  compact = false,
}: {
  scope: "plan" | "court";
  /** The thing being priced: `{plan_id}` or `{court_id, start_at}`, plus `user_id` when staff order for a member. */
  target: Record<string, string | undefined>;
  onChange: (quote: PromoQuote | null) => void;
  compact?: boolean;
}) {
  const [code, setCode] = useState("");
  const [quote, setQuote] = useState<PromoQuote | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function apply() {
    const c = code.trim();
    if (!c) return;
    setBusy(true);
    setError("");
    try {
      const q = await apiPost<PromoQuote>("/promotions/validate", { scope, code: c, ...target });
      setQuote(q);
      onChange(q);
    } catch (e) {
      setQuote(null);
      onChange(null);
      setError(e instanceof Error ? tServer(e.message) : t("That code could not be applied."));
    } finally {
      setBusy(false);
    }
  }

  function clear() {
    setCode("");
    setQuote(null);
    setError("");
    onChange(null);
  }

  return (
    <div className="grid gap-1.5">
      <div className="flex gap-2">
        <Input
          value={code}
          placeholder={t("Promo code")}
          aria-label={t("Promo code")}
          className={compact ? "h-11 sm:h-9" : undefined}
          disabled={quote !== null}
          autoCapitalize="characters"
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void apply();
            }
          }}
        />
        {quote ? (
          <Button type="button" variant="ghost" size="sm" onClick={clear}>
            {t("Remove")}
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" disabled={busy || !code.trim()} onClick={() => void apply()}>
            {busy ? t("Checking…") : t("Apply")}
          </Button>
        )}
      </div>
      {quote ? (
        <p className="text-xs text-accent">
          {t("{name}: −{discount} ₫ → pay {total} ₫", {
            name: quote.name,
            discount: quote.discount_vnd.toLocaleString(locale()),
            total: quote.final_vnd.toLocaleString(locale()),
          })}
        </p>
      ) : null}
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}
