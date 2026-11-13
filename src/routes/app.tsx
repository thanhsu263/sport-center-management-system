import { Outlet, createFileRoute } from "@tanstack/react-router";
import { Guard } from "@/client/components/shell";

export const Route = createFileRoute("/app")({
  component: () => (
    <Guard roles={["member"]}>
      <Outlet />
    </Guard>
  ),
});
