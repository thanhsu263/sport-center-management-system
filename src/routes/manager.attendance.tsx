import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AtRiskPanel, AttendancePanel } from "@/client/components/attendance-panels";
import { Shell } from "@/client/components/shell";
import { Seg } from "@/client/components/ui";
import { t } from "@/client/lib/i18n";

export const Route = createFileRoute("/manager/attendance")({ component: Page });

function Page() {
  const [tab, setTab] = useState("rate");
  return (
    <Shell
      role="manager"
      title={t("Attendance")}
      subtitle={t("How often members come, and who has stopped coming.")}
    >
      <div className="mb-4">
        <Seg
          value={tab}
          onChange={setTab}
          options={[
            { value: "rate", label: t("Attendance rate") },
            { value: "risk", label: t("At risk") },
          ]}
        />
      </div>
      {tab === "rate" ? <AttendancePanel canExport /> : <AtRiskPanel />}
    </Shell>
  );
}
