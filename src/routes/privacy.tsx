import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/client/components/legal-page";
import { PRIVACY } from "@/client/lib/legal";

export const Route = createFileRoute("/privacy")({
  head: () => ({ meta: [{ title: "Personal data notice · Lê Long Sport" }] }),
  component: () => <LegalPage doc={PRIVACY} other="terms" />,
});
