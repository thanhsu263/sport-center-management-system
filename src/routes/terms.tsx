import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/client/components/legal-page";
import { TERMS } from "@/client/lib/legal";

export const Route = createFileRoute("/terms")({
  head: () => ({ meta: [{ title: "Terms of use · Lê Long Sport" }] }),
  component: () => <LegalPage doc={TERMS} other="privacy" />,
});
