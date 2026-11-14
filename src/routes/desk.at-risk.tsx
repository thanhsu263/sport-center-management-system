import { createFileRoute } from "@tanstack/react-router";
import { AtRiskPanel } from "@/client/components/attendance-panels";
import { Shell, useSessionUser } from "@/client/components/shell";
import { t } from "@/client/lib/i18n";

export const Route = createFileRoute("/desk/at-risk")({ component: Page });

function Page() {
  const user = useSessionUser();
  return (
    <Shell
      role={user?.role === "manager" ? "manager" : "receptionist"}
      title={t("At risk")}
      subtitle={t("Members who have stopped coming. Call them before their plan lapses.")}
    >
      <AtRiskPanel />
    </Shell>
  );
}
