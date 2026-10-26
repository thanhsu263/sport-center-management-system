import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import { useRead } from "@/lib/use-read";
import { t } from "@/lib/i18n";
import { PageHero } from "@/components/page-hero";
import { ArrowLeft, ExternalLink, Search } from "lucide-react";

export const Route = createFileRoute("/credits")({
  component: CreditsPage,
});

type MediaCredit = {
  id: string;
  path: string;
  url: string;
  name: string;
  kind: string;
  category: string;
  tags: string[];
  alt_en: string;
  alt_vi: string;
  credit: string | null;
  source_url: string | null;
  license: string;
};

function CreditsPage() {
  const { data, error } = useRead<{ items: MediaCredit[] }>("/media/credits");
  const loading = !data && !error;
  const [selectedCategory, setSelectedCategory] = useState("all");
  const [search, setSearch] = useState("");

  const items = data?.items ?? [];

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) {
      if (it.category && it.category !== "legacy") set.add(it.category);
    }
    return ["all", ...Array.from(set).sort()];
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((it) => {
      if (selectedCategory !== "all" && it.category !== selectedCategory) return false;
      if (!search.trim()) return true;
      const q = search.trim().toLowerCase();
      return (
        it.alt_en?.toLowerCase().includes(q) ||
        it.alt_vi?.toLowerCase().includes(q) ||
        it.credit?.toLowerCase().includes(q) ||
        it.license?.toLowerCase().includes(q) ||
        it.category?.toLowerCase().includes(q)
      );
    });
  }, [items, selectedCategory, search]);

  const formatCategory = (cat: string) => {
    switch (cat) {
      case "all": return t("All categories");
      case "facility": return t("Facility");
      case "class": return t("Classes");
      case "event": return t("Event");
      case "equipment": return t("Equipment");
      case "other-sports": return t("Other sports");
      case "coach": return t("Coaches");
      case "badminton": return t("Badminton");
      case "basketball": return t("Basketball");
      case "volleyball": return t("Volleyball");
      default: return cat;
    }
  };

  return (
    <div className="min-h-screen bg-bg text-fg">
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-6">
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-sm text-muted transition hover:text-fg"
          >
            <ArrowLeft className="size-4" />
            <span>{t("Back to Home")}</span>
          </Link>
        </div>

        <PageHero
          title={t("Media Credits")}
          subtitle={t("Source and licence of each image used on this site.")}
        />

        <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("Search by keyword or tag...")}
              className="w-full rounded-md border border-line bg-surface py-2 pl-9 pr-4 text-sm text-fg placeholder:text-muted focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>

          <div className="flex flex-wrap gap-1.5">
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  selectedCategory === cat
                    ? "bg-accent text-accent-contrast"
                    : "bg-surface text-muted hover:bg-surface-elevated hover:text-fg"
                }`}
              >
                {formatCategory(cat)}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="mt-12 text-center text-sm text-muted">{t("Loading")}</div>
        ) : error ? (
          <div className="mt-12 text-center text-sm text-danger">{error.message}</div>
        ) : filtered.length === 0 ? (
          <div className="mt-12 rounded-lg border border-line bg-surface p-8 text-center text-sm text-muted">
            {t("No media items match the selected filter.")}
          </div>
        ) : (
          <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((item) => (
              <div
                key={item.id}
                className="overflow-hidden rounded-xl border border-line bg-surface shadow-xs transition hover:border-accent/40"
              >
                <div className="relative aspect-video w-full overflow-hidden bg-surface-elevated">
                  <img
                    src={item.url}
                    alt={item.alt_en}
                    loading="lazy"
                    className="h-full w-full object-cover transition duration-300 hover:scale-105"
                  />
                  <div className="absolute left-2.5 top-2.5">
                    <span className="rounded-full bg-surface/90 px-2 py-0.5 text-2xs font-semibold text-fg backdrop-blur-xs">
                      {formatCategory(item.category)}
                    </span>
                  </div>
                </div>

                <div className="p-4">
                  <h3 className="line-clamp-2 text-sm font-semibold text-fg">
                    {item.alt_vi || item.alt_en}
                  </h3>
                  <p className="mt-1 line-clamp-1 text-xs text-muted">
                    {item.alt_en}
                  </p>

                  <div className="mt-4 flex flex-col gap-2 border-t border-line/60 pt-3 text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-muted">{t("Credit")}:</span>
                      <span className="font-medium text-fg">{item.credit || "Lê Long Sport Center Studio"}</span>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-muted">{t("License")}:</span>
                      <span className="inline-block rounded bg-surface-elevated px-1.5 py-0.5 text-2xs font-mono text-muted">
                        {item.license}
                      </span>
                    </div>

                    {item.source_url && (
                      <div className="mt-1 flex items-center justify-end">
                        <a
                          href={item.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-accent transition hover:underline"
                        >
                          <span>{t("View original")}</span>
                          <ExternalLink className="size-3" />
                        </a>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
