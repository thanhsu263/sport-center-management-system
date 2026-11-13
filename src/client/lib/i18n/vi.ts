import { core } from "./vi.core.ts";
import { desk } from "./vi.desk.ts";
import { manager } from "./vi.manager.ts";
import { member } from "./vi.member.ts";
import { ops } from "./vi.ops.ts";
import { pub } from "./vi.public.ts";
import { redesign } from "./vi.redesign.ts";

/** Vietnamese for every `t("English")` in the app, merged from the per-area files. */
export const VI: Record<string, string> = { ...core, ...pub, ...member, ...desk, ...manager, ...ops, ...redesign };
