import { core } from "./vi.core";
import { desk } from "./vi.desk";
import { manager } from "./vi.manager";
import { member } from "./vi.member";
import { ops } from "./vi.ops";
import { pub } from "./vi.public";
import { redesign } from "./vi.redesign";

/** Vietnamese for every `t("English")` in the app, merged from the per-area files. */
export const VI: Record<string, string> = { ...core, ...pub, ...member, ...desk, ...manager, ...ops, ...redesign };
