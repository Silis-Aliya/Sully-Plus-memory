import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

if (args.includes("--help")) {
  console.log("Usage: node scripts/create-v2-deploy-snapshot.mjs [--source <authority.sqlite>] [--output <snapshot.sqlite>]");
  process.exit(0);
}

const sourceFile = path.resolve(valueAfter("--source", path.join(process.cwd(), ".memory-hub", "authority.sqlite")));
const defaultOutput = path.join(process.cwd(), "deploy-snapshots", `authority-v2-deploy-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
const outputFile = path.resolve(valueAfter("--output", defaultOutput));
const V2_LEGACY_DOMAINS = ["hub:memories", "hub:vectors", "hub:links", "hub:eventBoxes", "hub:roomPlates", "hub:anticipations", "hub:digestReports", "hub:characterRuntime", "_runtime_messages_hash"];
const CHECK_TABLES = ["authority_entities", "worldbook_mounts", "v2_messages", "v2_memory_nodes", "v2_memory_vectors", "v2_memory_links", "v2_event_boxes", "v2_event_box_members", "v2_room_plates", "v2_room_plate_entries", "v2_anticipations", "v2_digest_reports", "v2_character_runtime_state", "commands", "events", "scheduled_jobs", "outbox_deliveries"];

if (!existsSync(sourceFile)) throw new Error(`Source database not found: ${sourceFile}`);
if (existsSync(outputFile)) throw new Error(`Refusing to overwrite existing snapshot: ${outputFile}`);
mkdirSync(path.dirname(outputFile), { recursive: true });

function countRows(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count);
}

function controlMode(db) {
  const row = db.prepare("SELECT value_json FROM v2_runtime_control WHERE control_key='authority_mode'").get();
  return row ? JSON.parse(row.value_json) : "shadow";
}

const source = new DatabaseSync(sourceFile, { readOnly: true });
try {
  if (controlMode(source) !== "v2") throw new Error("Refusing to create a V2 deployment snapshot before V2 authority promotion.");
  const sourceCounts = Object.fromEntries(CHECK_TABLES.map((table) => [table, countRows(source, table)]));
  source.exec(`VACUUM INTO '${outputFile.replace(/'/g, "''")}'`);

  const target = new DatabaseSync(outputFile);
  try {
    if (controlMode(target) !== "v2") throw new Error("Copied snapshot lost V2 authority mode.");
    target.exec("BEGIN IMMEDIATE");
    const removedMessages = target.prepare("DELETE FROM runtime_messages").run().changes;
    const placeholders = V2_LEGACY_DOMAINS.map(() => "?").join(",");
    const removedDomains = target.prepare(`DELETE FROM runtime_domains WHERE domain_key IN (${placeholders})`).run(...V2_LEGACY_DOMAINS).changes;
    target.exec("COMMIT");
    target.exec("VACUUM");
    const targetCounts = Object.fromEntries(CHECK_TABLES.map((table) => [table, countRows(target, table)]));
    const differences = Object.entries(sourceCounts).filter(([table, count]) => targetCounts[table] !== count).map(([table, sourceCount]) => ({ table, sourceCount, targetCount: targetCounts[table] }));
    const integrity = target.prepare("PRAGMA integrity_check").get().integrity_check;
    const legacy = {
      runtimeMessages: countRows(target, "runtime_messages"),
      removedMessages: Number(removedMessages || 0),
      removedDomains: Number(removedDomains || 0),
      remainingMirroredDomains: target.prepare(`SELECT domain_key FROM runtime_domains WHERE domain_key IN (${placeholders}) ORDER BY domain_key`).all(...V2_LEGACY_DOMAINS).map((row) => row.domain_key),
    };
    if (integrity !== "ok" || differences.length || legacy.runtimeMessages || legacy.remainingMirroredDomains.length) {
      throw new Error(`Deployment snapshot validation failed: ${JSON.stringify({ integrity, differences, legacy })}`);
    }
    console.log(JSON.stringify({ ok: true, sourceFile, outputFile, sourceBytes: statSync(sourceFile).size, outputBytes: statSync(outputFile).size, authorityMode: controlMode(target), sourceCounts, targetCounts, integrity, legacy }, null, 2));
  } finally {
    target.close();
  }
} finally {
  source.close();
}
