import fs from "node:fs/promises";

const file = process.argv[2] || "results/profile-checks.json";
const checks = JSON.parse(await fs.readFile(file, "utf8"));

// This script only counts classifications already produced by the sampler. It
// does not revisit Facebook or reinterpret the underlying profile evidence.
const summary = checks.reduce(
  (acc, check) => {
    acc.total += 1;
    acc[check.classification] = (acc[check.classification] || 0) + 1;
    return acc;
  },
  { total: 0, normal: 0, suspicious: 0, clear_bot_like: 0 }
);

summary.note = "Classifications are profile-signal judgments, not proof of automation.";
console.log(JSON.stringify(summary, null, 2));
