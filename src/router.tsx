import { createRouter } from "@tanstack/react-router";
import { AppErrorComponent, AppNotFoundComponent } from "@/client/lib/error-component";
import { routeTree } from "./routeTree.gen.ts";

export function getRouter() {
  return createRouter({ //find rounter to make sure things alright!!
    routeTree,
    defaultErrorComponent: AppErrorComponent,
    defaultNotFoundComponent: AppNotFoundComponent,
  });
}
