import { Outlet, createFileRoute } from "@tanstack/react-router";
import { Guard } from "@/components/shell";

export const Route = createFileRoute("/manager")({
  component: () => (
    <Guard roles={["manager"]}>
      <Outlet />
    </Guard>
  ),
});
