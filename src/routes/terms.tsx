import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/legal-page";
import { TERMS } from "@/lib/legal";

export const Route = createFileRoute("/terms")({
  head: () => ({ meta: [{ title: "Terms of use · Lê Long Sport Center" }] }),
  component: () => <LegalPage doc={TERMS} other="privacy" />,
});
