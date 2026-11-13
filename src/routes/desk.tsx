import { Outlet, createFileRoute } from "@tanstack/react-router";
import { Guard } from "@/client/components/shell";

export const Route = createFileRoute("/desk")({
  component: () => (
    <Guard roles={["receptionist", "manager"]}>
      <Outlet />
    </Guard>
  ),
});
