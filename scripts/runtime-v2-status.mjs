import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const databaseFile = path.resolve(valueAfter("--database", path.join(process.cwd(), ".memory-hub", "authority.sqlite")));
const db = new DatabaseSync(databaseFile, { readOnly: true });
try {
  const authorityMode = db.prepare("SELECT value_json FROM v2_runtime_control WHERE control_key='authority_mode'").get();
  const nativeMutationSeq = db.prepare("SELECT value_json FROM v2_runtime_control WHERE control_key='native_mutation_seq'").get();
  const latestPromotion = db.prepare("SELECT promotion_id,status,actor_id,parity_hash,baseline_native_mutation_seq,prepared_at,expires_at,committed_at,rolled_back_at,rollback_reason FROM v2_runtime_promotions ORDER BY prepared_at DESC LIMIT 1").get() || null;
  const domains = db.prepare("SELECT domain_key,source_version,item_count,status,updated_at FROM v2_shadow_domains ORDER BY domain_key").all();
  const openFailures = Number(db.prepare("SELECT COUNT(*) AS count FROM v2_shadow_write_failures WHERE resolved_at IS NULL").get().count);
  const active = db.prepare(`SELECT
    (SELECT COUNT(*) FROM v2_messages WHERE deleted_at IS NULL) AS messages,
    (SELECT COUNT(*) FROM v2_memory_nodes WHERE deleted_at IS NULL) AS memories,
    (SELECT COUNT(*) FROM v2_memory_vectors WHERE deleted_at IS NULL) AS vectors,
    (SELECT COUNT(*) FROM v2_memory_links WHERE deleted_at IS NULL) AS links`).get();
  console.log(JSON.stringify({ databaseFile, authorityMode: authorityMode ? JSON.parse(authorityMode.value_json) : "shadow", nativeMutationSeq: nativeMutationSeq ? Number(JSON.parse(nativeMutationSeq.value_json)) : 0, latestPromotion, domains, openFailures, active }, null, 2));
} finally {
  db.close();
}
