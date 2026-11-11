export function assertAppDataServerOnly(
  context = "app-data/client.server",
): void {
  if (typeof window !== "undefined") {
    throw new Error(
      `@/server/${context} is server-only. Call connector tools from a createServerFn handler (dynamic import of @/server/app-data/client.server), never from a React component, useEffect, or browser fetch. Types and login helpers are client-safe via @/client/app-data.`,
    );
  }
}

assertAppDataServerOnly("app-data/client.server");
