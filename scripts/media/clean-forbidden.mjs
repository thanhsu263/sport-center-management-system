import fs from "node:fs";
import path from "node:path";

const BASE_DIR = "public/media/library";

// 1. Remove all forbidden files
const BAD_PATTERNS = [
  "centre-bell", "canadiens", "bell-centre", "marines", "navy",
  "ivanov", "limpele", "sozonov", "fiba", "penn-state", "penn_state",
  "nationals", "podium", "kowalczyk", "bj-rgen", "kim-yuna", "yuna",
  "boycott", "apartheid", "farzam", "humphries", "tinling",
  "spikes-a-point-home-in-inte", "colosseum"
];

let removed = 0;
function cleanDir(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, f.name);
    if (f.isDirectory()) {
      cleanDir(full);
    } else {
      const lower = f.name.toLowerCase();
      if (BAD_PATTERNS.some((p) => lower.includes(p))) {
        fs.unlinkSync(full);
        removed++;
        console.log(`Deleted forbidden: ${full}`);
      }
    }
  }
}
cleanDir(BASE_DIR);
console.log(`Finished removing ${removed} forbidden / problematic files.`);
