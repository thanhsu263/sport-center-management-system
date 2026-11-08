import { Link } from "@tanstack/react-router";
import { ArenaMark } from "@/components/mark";
import { LangSwitch } from "@/components/lang-switch";
import { formatDate } from "@/lib/arena3/labels";
import { t, useLang } from "@/lib/i18n";
import { LEGAL_DRAFT, LEGAL_UPDATED, type LegalDoc } from "@/lib/legal";

export function LegalBody({
  doc,
  showTitle = false,
}: {
  doc: Record<"en" | "vi", LegalDoc>;
  showTitle?: boolean;
}) {
  const lang = useLang();
  const d = doc[lang === "vi" ? "vi" : "en"];
  return (
    <article className="text-fg">
      {showTitle ? <h1 className="font-display text-4xl">{d.title}</h1> : null}
      <p className={showTitle ? "mt-2 text-sm text-muted" : "text-sm text-muted"}>
        {t("Last updated {date}", { date: formatDate(LEGAL_UPDATED) })}
        {LEGAL_DRAFT ? ` · ${t("Draft awaiting the centre's review")}` : ""}
      </p>
      <p className="mt-4 text-base leading-relaxed">{d.intro}</p>
      {d.sections.map((s) => (
        <section key={s.heading} className="mt-6">
          <h2 className={showTitle ? "font-display text-2xl" : "font-display text-lg font-semibold"}>
            {s.heading}
          </h2>
          {s.body.map((p, i) => (
            <p key={i} className="mt-2.5 max-w-prose leading-relaxed">
              {p}
            </p>
          ))}
        </section>
      ))}
    </article>
  );
}

/**
 * A plain reading page for the terms and the data notice: the documents a person is asked to
 * agree to when signing up, linked from the consent box (R-1). No effects, a readable measure.
 */
export function LegalPage({ doc, other }: { doc: Record<"en" | "vi", LegalDoc>; other: "terms" | "privacy" }) {
  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <Link to="/" className="inline-flex items-center gap-2" aria-label={t("Lê Long Sport Center home")}>
          <ArenaMark className="size-8" />
          <span className="font-display text-xl">Lê Long Sport Center</span>
        </Link>
        <LangSwitch />
      </header>
      <main id="main-content" tabIndex={-1} className="mx-auto max-w-3xl px-4 pb-16 sm:px-6">
        <LegalBody doc={doc} showTitle />
        <p className="mt-12 flex flex-wrap gap-x-4 gap-y-2 text-sm">
          <Link to="/register" className="hit underline underline-offset-2">
            {t("Back to sign up")}
          </Link>
          {other === "privacy" ? (
            <Link to="/privacy" className="hit underline underline-offset-2">
              {t("Personal data notice")}
            </Link>
          ) : (
            <Link to="/terms" className="hit underline underline-offset-2">
              {t("Terms of use")}
            </Link>
          )}
        </p>
      </main>
    </div>
  );
}
