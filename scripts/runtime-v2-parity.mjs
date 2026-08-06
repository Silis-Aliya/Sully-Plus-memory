import path from "node:path";
import { RuntimeV2Parity } from "../src/storage/runtimeV2Parity.mjs";

const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
if (args.includes("--help")) {
  console.log(`Usage: node scripts/runtime-v2-parity.mjs [--database <file>] [--sample-limit <n>]

Runs a strictly read-only comparison between legacy runtime storage and V2. It never switches the production read path.`);
  process.exit(0);
}
const databaseFile = path.resolve(valueAfter("--database", path.join(process.cwd(), ".memory-hub", "authority.sqlite")));
const sampleLimit = Number(valueAfter("--sample-limit", "20"));
console.log(JSON.stringify(new RuntimeV2Parity(databaseFile, { sampleLimit }).run(), null, 2));
