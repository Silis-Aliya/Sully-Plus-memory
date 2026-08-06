import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeV2Migrator } from "../src/storage/runtimeV2Migrator.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const valueAfter = (name, fallback = "") => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

if (args.includes("--help")) {
  console.log(`Usage:
  node scripts/runtime-v2-migrate.mjs [--database <file>] [--batch-size <n>]
  node scripts/runtime-v2-migrate.mjs --apply [--database <file>] [--batch-size <n>]

Without --apply this command is strictly read-only and prints the current source/V2 validation report.
--apply creates and backfills side-by-side v2_* tables. It never deletes or rewrites legacy tables or runtime_domains.`);
  process.exit(0);
}

const databaseFile = path.resolve(valueAfter("--database", path.join(root, ".memory-hub", "authority.sqlite")));
const batchSize = Number(valueAfter("--batch-size", "5000"));
const migrator = new RuntimeV2Migrator(databaseFile, { batchSize });

if (args.includes("--apply")) {
  const result = migrator.apply();
  console.log(JSON.stringify({ mode: "apply", ...result }, null, 2));
} else {
  console.log(JSON.stringify({ mode: "read-only-validation", ...migrator.validate() }, null, 2));
}
