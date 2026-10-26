import { createFileRoute } from "@tanstack/react-router";
import { LegalPage } from "@/components/legal-page";
import { PRIVACY } from "@/lib/legal";

export const Route = createFileRoute("/privacy")({
  head: () => ({ meta: [{ title: "Personal data notice · Lê Long Sport Center" }] }),
  component: () => <LegalPage doc={PRIVACY} other="terms" />,
});
