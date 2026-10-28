import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SectionTitle } from "@/components/section";
import { Shell, money, when } from "@/components/shell";
import { Badge, Button, Card, Check, DateField, EmptyState, Field, LoadError, Skeleton, Stat, Pagination } from "@/components/ui";
import { Reveal } from "@/components/motion";
import { downloadReport } from "@/lib/arena3/client";
import { todayISO } from "@/lib/arena3/labels";
import { t, tServer } from "@/lib/i18n";
import { usePageState } from "@/lib/use-page-state";
import { useRead } from "@/lib/use-read";

export const Route = createFileRoute("/manager/invoices")({ component: Page });

type Item = {
  id: string;
  code: string;
  issued_at: string;
  buyer_name: string;
  buyer_tax_code: string | null;
  total_vnd: number;
  vat_vnd: number;
  exported_at: string | null;
};
type Data = { from: string; to: string; items: Item[]; n: number; total: number; vat: number; pending: number };

function Page() {
  const [from, setFrom] = useState(`${todayISO().slice(0, 8)}01`);
  const [to, setTo] = useState(todayISO());
  const [onlyNew, setOnlyNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const { offset, setOffset, pageSize, setPageSize, reset } = usePageState("manager.invoices", 25);
  useEffect(reset, [from, to, reset]);
  const { data, error, reload } = useRead<Data>(
    `/invoices/export-list?from=${from}&to=${to}&limit=${pageSize}&offset=${offset}`,
    { keepPrevious: true },
  );
  // A range the server refuses names no date (it only says the range is not valid), so both boxes are marked.
  const refused = error?.refused === true;
  const errorId = "invoices-error";

  async function exp(format: "csv" | "xml") {
    setBusy(true);
    try {
      const name = await downloadReport(`/invoices/export?format=${format}&from=${from}&to=${to}${onlyNew ? "&only_new=1" : ""}`, `hoa-don.${format}`);
      toast.success(t("Saved {name}", { name }));
      reload();
    } catch (e) {
      toast.error(e instanceof Error ? tServer(e.message) : t("Something went wrong"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell
      role="manager"
      title={t("E-invoice export")}
      subtitle={t("Hand the month's invoices to your accountant as a spreadsheet or an XML file for the e-invoice system.")}
    >
      <Reveal from="down">
        <Card className="mb-4 grid gap-3 md:grid-cols-[1fr_1fr_auto_auto_auto] md:items-end">
          <Field label={t("From")}>
            <DateField
              required
              value={from}
              max={to}
              onChange={setFrom}
              invalid={refused}
              aria-describedby={refused ? errorId : undefined}
              aria-label={t("From")}
            />
          </Field>
          <Field label={t("To")}>
            <DateField
              required
              value={to}
              min={from}
              onChange={setTo}
              invalid={refused}
              aria-describedby={refused ? errorId : undefined}
              aria-label={t("To")}
            />
          </Field>
          <Check checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} label={t("Only not yet exported")} />
          <Button disabled={busy || !data?.n} onClick={() => void exp("csv")}>
            {t("Download spreadsheet (CSV)")}
          </Button>
          <Button variant="outline" disabled={busy || !data?.n} onClick={() => void exp("xml")}>
            {t("Download XML")}
          </Button>
        </Card>
      </Reveal>
      <p className="mb-4 text-xs text-muted">
        {t("This file is a hand-over for your accountant. It is not yet an invoice issued through a registered e-invoice provider.")}
      </p>

      {error ? (
        <LoadError id={errorId} message={error.message} onRetry={refused ? undefined : reload} />
      ) : !data ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            <Stat label={t("Invoices")} value={String(data.n)} />
            <Stat label={t("Total")} value={money(data.total)} />
            <Stat label={t("VAT")} value={money(data.vat)} />
            <Stat label={t("Not exported yet")} value={String(data.pending)} />
          </div>
          <SectionTitle text={t("Invoices in range")} className="mb-3 font-display text-2xl" />
          {data.items.length === 0 ? (
            <EmptyState title={t("No invoices in these dates")} hint={t("Pick a wider range.")} />
          ) : (
            <div className="grid gap-2">
              {data.items.map((i) => (
                <Card key={i.id} className="flex flex-wrap items-center justify-between gap-3 p-3 text-sm">
                  <span>
                    <span className="font-mono">{i.code}</span> · {i.buyer_name}
                    {i.buyer_tax_code ? <span className="text-muted"> · {t("Tax code")} {i.buyer_tax_code}</span> : null}
                    <span className="block text-xs text-muted">{when(i.issued_at)}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="tabular-nums">{money(i.total_vnd)}</span>
                    <Badge tone={i.exported_at ? "accent" : "hold"}>{i.exported_at ? t("Exported") : t("New")}</Badge>
                  </span>
                </Card>
              ))}
            </div>
          )}
          {/* `n` is how many invoices the range holds; `total` in this answer is money. */}
          <Pagination
            offset={offset}
            total={data.n ?? 0}
            pageSize={pageSize}
            onChange={setOffset}
            onPageSizeChange={setPageSize}
            label={t("Invoice pages")}
          />
        </>
      )}
    </Shell>
  );
}
