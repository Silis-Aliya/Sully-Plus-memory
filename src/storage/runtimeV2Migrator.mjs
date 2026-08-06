import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { contentHash } from "../../authorityStore.mjs";
import { RuntimeV2Repository } from "./runtimeV2Repository.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const RUNTIME_V2_SCHEMA_FILE = path.join(here, "migrations", "002_incremental_runtime.sql");
export const RUNTIME_V2_MIGRATION_ID = "002_incremental_runtime";

const DOMAIN_TABLES = {
  memories: "v2_memory_nodes",
  vectors: "v2_memory_vectors",
  links: "v2_memory_links",
  eventBoxes: "v2_event_boxes",
  roomPlates: "v2_room_plates",
  anticipations: "v2_anticipations",
  digestReports: "v2_digest_reports",
};

const nowIso = () => new Date().toISOString();
const text = (value, fallback = "") => value === undefined || value === null ? fallback : String(value).trim();
const asArray = (value) => Array.isArray(value) ? value : [];
const boolInt = (value) => value ? 1 : 0;
const json = (value, fallback) => {
  try { return JSON.parse(value); } catch { return fallback; }
};

function iso(value, fallback = nowIso()) {
  if (value === undefined || value === null || value === "") return fallback;
  const numeric = typeof value === "number" || /^\d{10,}$/.test(String(value)) ? Number(value) : NaN;
  const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function stableLegacyMessageId(charId, messageId) {
  return `legacy:${encodeURIComponent(charId)}:${encodeURIComponent(messageId)}`;
}

function vectorBuffer(values) {
  const floats = Float32Array.from(values.map((value) => Number(value) || 0));
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function scalar(db, sql, ...args) {
  const row = db.prepare(sql).get(...args);
  return Number(Object.values(row || {})[0] || 0);
}

export class RuntimeV2Migrator {
  constructor(databaseFile, { batchSize = 5000 } = {}) {
    this.databaseFile = path.resolve(databaseFile);
    this.batchSize = Math.max(1, Math.min(50000, Number(batchSize) || 5000));
  }

  openRead() {
    return new DatabaseSync(this.databaseFile, { readOnly: true });
  }

  openWrite() {
    const db = new DatabaseSync(this.databaseFile);
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;");
    return db;
  }

  sourceCounts(db) {
    const result = { messages: tableExists(db, "runtime_messages") ? scalar(db, "SELECT COUNT(*) FROM runtime_messages") : 0 };
    for (const domain of Object.keys(DOMAIN_TABLES)) {
      result[domain] = tableExists(db, "runtime_domains")
        ? scalar(db, "SELECT COALESCE(json_array_length(data_json),0) FROM runtime_domains WHERE domain_key=?", `hub:${domain}`)
        : 0;
    }
    return result;
  }

  sourceDomainHashes(db) {
    if (!tableExists(db, "runtime_domains")) return {};
    return Object.fromEntries(db.prepare("SELECT domain_key,content_hash FROM runtime_domains WHERE domain_key LIKE 'hub:%' ORDER BY domain_key").all()
      .map((row) => [row.domain_key.slice(4), row.content_hash]));
  }

  targetCounts(db) {
    const result = { messages: tableExists(db, "v2_messages") ? scalar(db, "SELECT COUNT(*) FROM v2_messages WHERE deleted_at IS NULL") : 0 };
    for (const [domain, table] of Object.entries(DOMAIN_TABLES)) {
      if (!tableExists(db, table)) { result[domain] = 0; continue; }
      const hasDeletedAt = db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === "deleted_at");
      result[domain] = scalar(db, `SELECT COUNT(*) FROM ${table}${hasDeletedAt ? " WHERE deleted_at IS NULL" : ""}`);
    }
    result.eventBoxMembers = tableExists(db, "v2_event_box_members") ? scalar(db, "SELECT COUNT(*) FROM v2_event_box_members WHERE deleted_at IS NULL") : 0;
    result.roomPlateEntries = tableExists(db, "v2_room_plate_entries") ? scalar(db, "SELECT COUNT(*) FROM v2_room_plate_entries WHERE deleted_at IS NULL") : 0;
    return result;
  }

  validate() {
    const db = this.openRead();
    try {
      const sourceCounts = this.sourceCounts(db);
      const targetCounts = this.targetCounts(db);
      const countDifferences = Object.fromEntries(Object.keys(sourceCounts)
        .filter((key) => sourceCounts[key] !== targetCounts[key])
        .map((key) => [key, { source: sourceCounts[key], target: targetCounts[key], difference: targetCounts[key] - sourceCounts[key] }]));
      const issues = tableExists(db, "v2_migration_issues")
        ? db.prepare("SELECT domain,issue_code,COUNT(*) AS count FROM v2_migration_issues GROUP BY domain,issue_code ORDER BY domain,issue_code").all()
          .map((row) => ({ domain: row.domain, code: row.issue_code, count: Number(row.count) }))
        : [];
      const integrity = tableExists(db, "v2_memory_nodes") ? {
        vectorsWithoutMemory: scalar(db, "SELECT COUNT(*) FROM v2_memory_vectors v LEFT JOIN v2_memory_nodes m ON m.memory_id=v.memory_id AND m.deleted_at IS NULL WHERE v.deleted_at IS NULL AND m.memory_id IS NULL"),
        linksWithoutSource: scalar(db, "SELECT COUNT(*) FROM v2_memory_links l LEFT JOIN v2_memory_nodes m ON m.memory_id=l.source_memory_id AND m.deleted_at IS NULL WHERE l.deleted_at IS NULL AND m.memory_id IS NULL"),
        linksWithoutTarget: scalar(db, "SELECT COUNT(*) FROM v2_memory_links l LEFT JOIN v2_memory_nodes m ON m.memory_id=l.target_memory_id AND m.deleted_at IS NULL WHERE l.deleted_at IS NULL AND m.memory_id IS NULL"),
        eventMembersWithoutMemory: scalar(db, "SELECT COUNT(*) FROM v2_event_box_members e LEFT JOIN v2_memory_nodes m ON m.memory_id=e.memory_id AND m.deleted_at IS NULL WHERE e.deleted_at IS NULL AND m.memory_id IS NULL"),
        invalidVectorBytes: scalar(db, "SELECT COUNT(*) FROM v2_memory_vectors WHERE deleted_at IS NULL AND length(vector_blob) != dimensions * 4"),
      } : {};
      const missingReferences = tableExists(db, "v2_memory_nodes") ? {
        vectors: db.prepare("SELECT v.memory_id FROM v2_memory_vectors v LEFT JOIN v2_memory_nodes m ON m.memory_id=v.memory_id AND m.deleted_at IS NULL WHERE v.deleted_at IS NULL AND m.memory_id IS NULL LIMIT 100").all(),
        linkSources: db.prepare("SELECT l.link_id,l.source_memory_id AS memory_id FROM v2_memory_links l LEFT JOIN v2_memory_nodes m ON m.memory_id=l.source_memory_id AND m.deleted_at IS NULL WHERE l.deleted_at IS NULL AND m.memory_id IS NULL LIMIT 100").all(),
        linkTargets: db.prepare("SELECT l.link_id,l.target_memory_id AS memory_id FROM v2_memory_links l LEFT JOIN v2_memory_nodes m ON m.memory_id=l.target_memory_id AND m.deleted_at IS NULL WHERE l.deleted_at IS NULL AND m.memory_id IS NULL LIMIT 100").all(),
        eventBoxMembers: db.prepare("SELECT e.event_box_id,e.memory_id,e.member_state,e.ordinal FROM v2_event_box_members e LEFT JOIN v2_memory_nodes m ON m.memory_id=e.memory_id AND m.deleted_at IS NULL WHERE e.deleted_at IS NULL AND m.memory_id IS NULL LIMIT 100").all(),
      } : {};
      const checkpoints = tableExists(db, "v2_migration_checkpoints")
        ? db.prepare("SELECT domain,last_index,migrated_count,updated_at FROM v2_migration_checkpoints ORDER BY domain").all()
          .map((row) => ({ domain: row.domain, lastIndex: Number(row.last_index), migratedCount: Number(row.migrated_count), updatedAt: row.updated_at }))
        : [];
      return {
        databaseFile: this.databaseFile,
        schemaInstalled: tableExists(db, "v2_schema_migrations"),
        sourceCounts,
        targetCounts,
        countDifferences,
        sourceDomainHashes: this.sourceDomainHashes(db),
        integrity,
        missingReferences,
        issues,
        checkpoints,
        ok: Object.keys(countDifferences).length === 0 && Object.values(integrity).every((value) => value === 0),
      };
    } finally {
      db.close();
    }
  }

  applySchema(db) {
    db.exec(readFileSync(RUNTIME_V2_SCHEMA_FILE, "utf8"));
    const additions = [
      ["v2_messages", "source_sequence_no", "INTEGER"],
      ["v2_memory_nodes", "row_version", "INTEGER NOT NULL DEFAULT 1"],
      ["v2_memory_vectors", "source_vector_field", "TEXT NOT NULL DEFAULT 'vector'"],
      ["v2_memory_vectors", "source_had_dimensions", "INTEGER NOT NULL DEFAULT 1"],
      ["v2_memory_vectors", "row_version", "INTEGER NOT NULL DEFAULT 1"],
      ["v2_memory_links", "row_version", "INTEGER NOT NULL DEFAULT 1"],
      ["v2_event_boxes", "row_version", "INTEGER NOT NULL DEFAULT 1"],
      ["v2_room_plates", "row_version", "INTEGER NOT NULL DEFAULT 1"],
      ["v2_anticipations", "row_version", "INTEGER NOT NULL DEFAULT 1"],
      ["v2_digest_reports", "row_version", "INTEGER NOT NULL DEFAULT 1"],
      ["v2_memory_vectors", "deleted_at", "TEXT"],
      ["v2_memory_links", "deleted_at", "TEXT"],
      ["v2_event_box_members", "deleted_at", "TEXT"],
      ["v2_room_plate_entries", "deleted_at", "TEXT"],
      ["v2_digest_reports", "deleted_at", "TEXT"],
      ["v2_character_runtime_state", "deleted_at", "TEXT"],
      ["v2_runtime_promotions", "shadow_marker", "TEXT NOT NULL DEFAULT ''"],
      ["v2_cc_wake_runs", "attempt_count", "INTEGER NOT NULL DEFAULT 0"],
      ["v2_cc_wake_runs", "lease_token", "TEXT"],
      ["v2_cc_wake_runs", "lease_expires_at", "TEXT"],
      ["v2_cc_wake_runs", "context_json", "TEXT"],
      ["v2_cc_wake_runs", "context_hash", "TEXT"],
      ["v2_cc_wake_runs", "context_from_event_id", "INTEGER NOT NULL DEFAULT 0"],
      ["v2_cc_wake_runs", "context_to_event_id", "INTEGER NOT NULL DEFAULT 0"],
      ["v2_cc_wake_runs", "updated_at", "TEXT NOT NULL DEFAULT ''"],
    ];
    for (const [table, column, type = "TEXT"] of additions) {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    db.exec("CREATE INDEX IF NOT EXISTS idx_v2_messages_source_sequence ON v2_messages(source_sequence_no)");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_v2_cc_wake_runs_job ON v2_cc_wake_runs(job_id) WHERE job_id IS NOT NULL");
    db.exec("CREATE INDEX IF NOT EXISTS idx_v2_cc_wake_runs_claim ON v2_cc_wake_runs(status,lease_expires_at,started_at)");
    db.prepare("INSERT OR IGNORE INTO v2_runtime_control(control_key,value_json,updated_at) VALUES('authority_mode','\"shadow\"',?)").run(nowIso());
    db.prepare("INSERT OR IGNORE INTO v2_runtime_control(control_key,value_json,updated_at) VALUES('native_mutation_seq','0',?)").run(nowIso());
    db.prepare("INSERT OR IGNORE INTO v2_schema_migrations(migration_id,applied_at,details_json) VALUES(?,?,?)")
      .run(RUNTIME_V2_MIGRATION_ID, nowIso(), JSON.stringify({ source: "runtime_domains", mode: "side-by-side" }));
  }

  checkpoint(db, domain) {
    const row = db.prepare("SELECT last_index,migrated_count FROM v2_migration_checkpoints WHERE domain=?").get(domain);
    return { lastIndex: Number(row?.last_index ?? -1), migratedCount: Number(row?.migrated_count || 0) };
  }

  saveCheckpoint(db, domain, lastIndex, migratedCount) {
    db.prepare(`INSERT INTO v2_migration_checkpoints(domain,last_index,migrated_count,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(domain) DO UPDATE SET last_index=excluded.last_index,migrated_count=excluded.migrated_count,updated_at=excluded.updated_at`)
      .run(domain, lastIndex, migratedCount, nowIso());
  }

  addIssue(db, runId, domain, sourceIndex, objectId, code, details = {}) {
    db.prepare("INSERT INTO v2_migration_issues(run_id,domain,source_index,object_id,issue_code,details_json,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(runId, domain, sourceIndex, objectId || null, code, JSON.stringify(details), nowIso());
  }

  markShadowBaselines(readDb, writeDb) {
    const upsert = writeDb.prepare(`INSERT INTO v2_shadow_domains(domain_key,source_version,source_hash,item_count,status,updated_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(domain_key) DO UPDATE SET source_version=excluded.source_version,source_hash=excluded.source_hash,item_count=excluded.item_count,status='current',updated_at=excluded.updated_at`);
    for (const domain of Object.keys(DOMAIN_TABLES)) {
      const row = readDb.prepare("SELECT version,content_hash,COALESCE(json_array_length(data_json),0) AS item_count,updated_at FROM runtime_domains WHERE domain_key=?").get(`hub:${domain}`);
      if (row) upsert.run(`hub:${domain}`, Number(row.version), row.content_hash, Number(row.item_count), "current", row.updated_at || nowIso());
    }
    const messageMeta = readDb.prepare("SELECT version,data_json,updated_at FROM runtime_domains WHERE domain_key='_runtime_messages_hash'").get();
    const parsed = json(messageMeta?.data_json, {});
    if (messageMeta && parsed.hash) upsert.run("message:all", Number(messageMeta.version), parsed.hash, Number(parsed.count || 0), "current", messageMeta.updated_at || nowIso());
  }

  backfillSourceOrders(readDb, writeDb) {
    const definitions = {
      memories: "COALESCE(NULLIF(json_extract(j.value,'$.id'),''),'legacy-memory:' || j.key)",
      vectors: "NULLIF(json_extract(j.value,'$.memoryId'),'')",
      links: "COALESCE(NULLIF(json_extract(j.value,'$.id'),''),'legacy-link:' || j.key)",
      eventBoxes: "COALESCE(NULLIF(json_extract(j.value,'$.id'),''),'legacy-event-box:' || j.key)",
      roomPlates: "COALESCE(NULLIF(json_extract(j.value,'$.id'),''),COALESCE(NULLIF(json_extract(j.value,'$.charId'),''),'unbound') || ':' || COALESCE(NULLIF(json_extract(j.value,'$.room'),''),'unknown'))",
      anticipations: "COALESCE(NULLIF(json_extract(j.value,'$.id'),''),'legacy-anticipation:' || j.key)",
      digestReports: "COALESCE(NULLIF(json_extract(j.value,'$.id'),''),'legacy-digest:' || j.key)",
    };
    const upsertSql = (idExpression) => `INSERT INTO v2_source_order(domain_key,object_id,ordinal,updated_at,deleted_at)
      SELECT ?,${idExpression},CAST(j.key AS INTEGER),?,NULL FROM runtime_domains r,json_each(r.data_json) j
      WHERE r.domain_key=? AND ${idExpression} IS NOT NULL
      ON CONFLICT(domain_key,object_id) DO UPDATE SET ordinal=excluded.ordinal,updated_at=excluded.updated_at,deleted_at=NULL`;
    let changed = 0;
    for (const [domain, idExpression] of Object.entries(definitions)) {
      const domainKey = `hub:${domain}`;
      const source = readDb.prepare("SELECT content_hash,COALESCE(json_array_length(data_json),0) count FROM runtime_domains WHERE domain_key=?").get(domainKey);
      if (!source) continue;
      const current = writeDb.prepare("SELECT source_hash FROM v2_shadow_domains WHERE domain_key=? AND status='current'").get(domainKey);
      const active = scalar(writeDb, "SELECT COUNT(*) FROM v2_source_order WHERE domain_key=? AND deleted_at IS NULL", domainKey);
      if (current?.source_hash === source.content_hash && active === Number(source.count)) continue;
      const at = nowIso();
      writeDb.exec("BEGIN IMMEDIATE");
      try {
        writeDb.prepare("UPDATE v2_source_order SET deleted_at=? WHERE domain_key=? AND deleted_at IS NULL").run(at, domainKey);
        changed += Number(writeDb.prepare(upsertSql(idExpression)).run(domainKey, at, domainKey).changes || 0);
        writeDb.exec("COMMIT");
      } catch (error) {
        try { writeDb.exec("ROLLBACK"); } catch {}
        throw error;
      }
    }
    const runtime = readDb.prepare("SELECT content_hash,data_json FROM runtime_domains WHERE domain_key='hub:characterRuntime'").get();
    if (runtime) {
      const count = scalar(readDb, "SELECT COUNT(*) FROM runtime_domains r,json_each(r.data_json) j WHERE r.domain_key='hub:characterRuntime'");
      const current = writeDb.prepare("SELECT source_hash FROM v2_shadow_domains WHERE domain_key='hub:characterRuntime' AND status='current'").get();
      const active = scalar(writeDb, "SELECT COUNT(*) FROM v2_source_order WHERE domain_key='hub:characterRuntime' AND deleted_at IS NULL");
      if (current?.source_hash !== runtime.content_hash || active !== count) {
        const at = nowIso();
        writeDb.exec("BEGIN IMMEDIATE");
        try {
          writeDb.prepare("UPDATE v2_source_order SET deleted_at=? WHERE domain_key='hub:characterRuntime' AND deleted_at IS NULL").run(at);
          changed += Number(writeDb.prepare(`INSERT INTO v2_source_order(domain_key,object_id,ordinal,updated_at,deleted_at)
            SELECT 'hub:characterRuntime',COALESCE(NULLIF(json_extract(j.value,'$.characterId'),''),NULLIF(json_extract(j.value,'$.charId'),''),NULLIF(json_extract(j.value,'$.id'),''),j.key),CAST(j.key AS INTEGER),?,NULL
            FROM runtime_domains r,json_each(r.data_json) j WHERE r.domain_key='hub:characterRuntime'
            ON CONFLICT(domain_key,object_id) DO UPDATE SET ordinal=excluded.ordinal,updated_at=excluded.updated_at,deleted_at=NULL`).run(at).changes || 0);
          writeDb.exec("COMMIT");
        } catch (error) {
          try { writeDb.exec("ROLLBACK"); } catch {}
          throw error;
        }
      }
    }
    return changed;
  }

  migrateMessages(readDb, writeDb, runId) {
    if (!tableExists(readDb, "runtime_messages")) return 0;
    const checkpoint = this.checkpoint(writeDb, "messages");
    const rows = readDb.prepare("SELECT char_id,message_id,sequence_no,data_json,content_hash,updated_at FROM runtime_messages WHERE sequence_no>? ORDER BY sequence_no").iterate(checkpoint.lastIndex);
    const insert = writeDb.prepare(`INSERT INTO v2_messages(message_id,source_sequence_no,character_id,conversation_id,turn_id,role,message_type,content,surface,visibility,origin,source_client_id,source_message_id,metadata_json,raw_json,content_hash,occurred_at,created_at,deleted_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET source_sequence_no=excluded.source_sequence_no,metadata_json=excluded.metadata_json,raw_json=excluded.raw_json,content_hash=excluded.content_hash`);
    let count = checkpoint.migratedCount, lastIndex = checkpoint.lastIndex, pending = 0;
    writeDb.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const item = json(row.data_json, {});
        const charId = text(row.char_id, "unbound");
        const sourceId = text(row.message_id);
        const occurredAt = iso(item.timestamp ?? item.createdAt, row.updated_at || nowIso());
        insert.run(
          stableLegacyMessageId(charId, sourceId), Number(row.sequence_no), charId, text(item.conversationId, `direct:me:${charId}`), text(item.turnId) || null,
          text(item.role, "user"), text(item.type, "text"), text(item.content ?? item.text), text(item.surface, "chat"),
          text(item.visibility, item.surface === "chat" ? "user" : "internal"), text(item.origin, "legacy"), "legacy-runtime", sourceId,
          JSON.stringify(item.metadata || {}), row.data_json, row.content_hash || contentHash(item), occurredAt, iso(row.updated_at, occurredAt), item.deletedAt ? iso(item.deletedAt) : null,
        );
        count += 1; pending += 1; lastIndex = Number(row.sequence_no);
        if (pending >= this.batchSize) {
          this.saveCheckpoint(writeDb, "messages", lastIndex, count);
          writeDb.exec("COMMIT");
          writeDb.exec("BEGIN IMMEDIATE");
          pending = 0;
        }
      }
      this.saveCheckpoint(writeDb, "messages", lastIndex, count);
      writeDb.exec("COMMIT");
      return count - checkpoint.migratedCount;
    } catch (error) {
      try { writeDb.exec("ROLLBACK"); } catch {}
      this.addIssue(writeDb, runId, "messages", lastIndex, null, "MIGRATION_FAILED", { message: error.message });
      throw error;
    }
  }

  backfillMessageSourceSequences(readDb, writeDb) {
    if (!tableExists(readDb, "runtime_messages")) return 0;
    const update = writeDb.prepare("UPDATE v2_messages SET source_sequence_no=? WHERE message_id=? AND (source_sequence_no IS NULL OR source_sequence_no<>?)");
    let changed = 0;
    writeDb.exec("BEGIN IMMEDIATE");
    try {
      for (const row of readDb.prepare("SELECT char_id,message_id,sequence_no FROM runtime_messages ORDER BY sequence_no").iterate()) {
        changed += Number(update.run(Number(row.sequence_no), stableLegacyMessageId(row.char_id, row.message_id), Number(row.sequence_no)).changes || 0);
      }
      writeDb.exec("COMMIT");
      return changed;
    } catch (error) {
      try { writeDb.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  repairMessageRawParity(readDb, writeDb) {
    if (!tableExists(readDb, "runtime_messages")) return 0;
    const update = writeDb.prepare("UPDATE v2_messages SET raw_json=?,content_hash=? WHERE message_id=? AND (raw_json<>? OR content_hash<>?)");
    let changed = 0;
    writeDb.exec("BEGIN IMMEDIATE");
    try {
      for (const row of readDb.prepare("SELECT char_id,message_id,data_json,content_hash FROM runtime_messages ORDER BY sequence_no").iterate()) {
        changed += Number(update.run(row.data_json, row.content_hash, stableLegacyMessageId(row.char_id, row.message_id), row.data_json, row.content_hash).changes || 0);
      }
      writeDb.exec("COMMIT");
      return changed;
    } catch (error) {
      try { writeDb.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  repairVectorSourceShape(readDb, writeDb) {
    const row = readDb.prepare("SELECT 1 FROM runtime_domains WHERE domain_key='hub:vectors'").get();
    if (!row) return 0;
    const update = writeDb.prepare("UPDATE v2_memory_vectors SET dimensions=CAST(length(vector_blob)/4 AS INTEGER),source_vector_field=?,source_had_dimensions=? WHERE memory_id=? AND (dimensions<>CAST(length(vector_blob)/4 AS INTEGER) OR source_vector_field<>? OR source_had_dimensions<>?)");
    let changed = 0;
    writeDb.exec("BEGIN IMMEDIATE");
    try {
      for (const source of readDb.prepare(`SELECT json_extract(j.value,'$.memoryId') memory_id,
        CASE WHEN json_type(j.value,'$.vector')='array' AND json_array_length(json_extract(j.value,'$.vector'))>0 THEN 'vector' ELSE 'embedding' END vector_field,
        CASE WHEN json_type(j.value,'$.dimensions') IS NULL THEN 0 ELSE 1 END had_dimensions
        FROM runtime_domains r,json_each(r.data_json) j WHERE r.domain_key='hub:vectors'`).iterate()) {
        changed += Number(update.run(source.vector_field, Number(source.had_dimensions), source.memory_id, source.vector_field, Number(source.had_dimensions)).changes || 0);
      }
      writeDb.exec("COMMIT");
      return changed;
    } catch (error) {
      try { writeDb.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  repairVectorPayloadParity(readDb, writeDb) {
    const row = readDb.prepare("SELECT 1 FROM runtime_domains WHERE domain_key='hub:vectors'").get();
    if (!row) return 0;
    const upsert = writeDb.prepare(`UPDATE v2_memory_vectors
      SET character_id=?,model=?,dimensions=?,vector_blob=?,vector_hash=?,source_vector_field=?,source_had_dimensions=?,updated_at=?,raw_metadata_json=?
      WHERE memory_id=? AND (character_id IS NOT ? OR model IS NOT ? OR dimensions<>? OR vector_hash<>? OR source_vector_field<>? OR source_had_dimensions<>? OR updated_at<>? OR raw_metadata_json<>?)`);
    let changed = 0;
    writeDb.exec("BEGIN IMMEDIATE");
    try {
      for (const source of readDb.prepare("SELECT j.value AS data_json FROM runtime_domains r,json_each(r.data_json) j WHERE r.domain_key='hub:vectors'").iterate()) {
        const item = json(source.data_json, null);
        if (!item || !text(item.memoryId)) continue;
        const field = asArray(item.vector).length ? "vector" : "embedding";
        const values = asArray(item[field]);
        if (!values.length) continue;
        const buffer = vectorBuffer(values);
        const metadata = { ...item };
        delete metadata.vector;
        delete metadata.embedding;
        const characterId = text(item.charId) || null;
        const model = text(item.model);
        const dimensions = values.length;
        const vectorHash = sha256(buffer);
        const sourceHadDimensions = Object.hasOwn(item, "dimensions") ? 1 : 0;
        const updatedAt = iso(item.updatedAt);
        const rawMetadata = JSON.stringify(metadata);
        changed += Number(upsert.run(characterId, model, dimensions, buffer, vectorHash, field, sourceHadDimensions, updatedAt, rawMetadata, text(item.memoryId), characterId, model, dimensions, vectorHash, field, sourceHadDimensions, updatedAt, rawMetadata).changes || 0);
      }
      writeDb.exec("COMMIT");
      return changed;
    } catch (error) {
      try { writeDb.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  migrateDomain(readDb, writeDb, runId, domain, handler) {
    if (!tableExists(readDb, "runtime_domains")) return 0;
    const exists = readDb.prepare("SELECT 1 FROM runtime_domains WHERE domain_key=?").get(`hub:${domain}`);
    if (!exists) return 0;
    const checkpoint = this.checkpoint(writeDb, domain);
    const rows = readDb.prepare(`SELECT CAST(j.key AS INTEGER) AS source_index,j.value AS data_json
      FROM runtime_domains r,json_each(r.data_json) j WHERE r.domain_key=? AND CAST(j.key AS INTEGER)>? ORDER BY CAST(j.key AS INTEGER)`)
      .iterate(`hub:${domain}`, checkpoint.lastIndex);
    let count = checkpoint.migratedCount, lastIndex = checkpoint.lastIndex, pending = 0;
    writeDb.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const item = json(row.data_json, null);
        if (!item || typeof item !== "object") {
          this.addIssue(writeDb, runId, domain, Number(row.source_index), null, "INVALID_JSON_OBJECT");
        } else {
          handler(item, row.data_json, Number(row.source_index));
        }
        count += 1; pending += 1; lastIndex = Number(row.source_index);
        if (pending >= this.batchSize) {
          this.saveCheckpoint(writeDb, domain, lastIndex, count);
          writeDb.exec("COMMIT");
          writeDb.exec("BEGIN IMMEDIATE");
          pending = 0;
        }
      }
      this.saveCheckpoint(writeDb, domain, lastIndex, count);
      writeDb.exec("COMMIT");
      return count - checkpoint.migratedCount;
    } catch (error) {
      try { writeDb.exec("ROLLBACK"); } catch {}
      this.addIssue(writeDb, runId, domain, lastIndex, null, "MIGRATION_FAILED", { message: error.message });
      throw error;
    }
  }

  apply() {
    const readDb = this.openRead();
    const writeDb = this.openWrite();
    const runId = randomUUID();
    let readDbClosed = false;
    try {
      this.applySchema(writeDb);
      writeDb.prepare(`UPDATE v2_migration_runs
        SET status='interrupted',completed_at=?,last_error=COALESCE(last_error,'Migration process ended before completion')
        WHERE status='running'`).run(nowIso());
      writeDb.prepare("INSERT INTO v2_migration_runs(run_id,source_kind,status,started_at,report_json) VALUES(?,?,?,?,?)")
        .run(runId, "runtime_domains", "running", nowIso(), "{}");
      const migrated = {};
      migrated.messages = this.migrateMessages(readDb, writeDb, runId);
      migrated.messageSequences = this.backfillMessageSourceSequences(readDb, writeDb);
      migrated.messageRawParity = this.repairMessageRawParity(readDb, writeDb);
      migrated.vectorShapes = this.repairVectorSourceShape(readDb, writeDb);
      migrated.vectorPayloadParity = this.repairVectorPayloadParity(readDb, writeDb);

      const memoryInsert = writeDb.prepare(`INSERT INTO v2_memory_nodes(memory_id,character_id,room,content,title,importance,mood,tags_json,event_box_id,archived,is_box_summary,embedded,occurred_at,created_at,updated_at,raw_json,content_hash,deleted_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET raw_json=excluded.raw_json,content_hash=excluded.content_hash`);
      migrated.memories = this.migrateDomain(readDb, writeDb, runId, "memories", (item, raw, index) => {
        const id = text(item.id, `legacy-memory:${index}`), createdAt = iso(item.createdAt ?? item.occurredAt);
        memoryInsert.run(id, text(item.charId, "unbound"), text(item.room, "living_room"), text(item.content), text(item.title), Number(item.importance || 0), text(item.mood), JSON.stringify(asArray(item.tags)), text(item.eventBoxId) || null, boolInt(item.archived), boolInt(item.isBoxSummary), boolInt(item.embedded), item.occurredAt == null ? null : iso(item.occurredAt), createdAt, iso(item.updatedAt, createdAt), raw, contentHash(item), item.deletedAt ? iso(item.deletedAt) : null);
      });

      const vectorInsert = writeDb.prepare(`INSERT INTO v2_memory_vectors(memory_id,character_id,model,dimensions,vector_blob,vector_hash,source_vector_field,source_had_dimensions,updated_at,raw_metadata_json)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET model=excluded.model,dimensions=excluded.dimensions,vector_blob=excluded.vector_blob,vector_hash=excluded.vector_hash,source_vector_field=excluded.source_vector_field,source_had_dimensions=excluded.source_had_dimensions,updated_at=excluded.updated_at,raw_metadata_json=excluded.raw_metadata_json`);
      migrated.vectors = this.migrateDomain(readDb, writeDb, runId, "vectors", (item, _raw, index) => {
        const id = text(item.memoryId);
        const field = asArray(item.vector).length ? "vector" : "embedding";
        const values = field === "vector" ? item.vector : asArray(item.embedding);
        if (!id || !values.length) {
          this.addIssue(writeDb, runId, "vectors", index, id, "VECTOR_MISSING_ID_OR_VALUES", { dimensions: values.length });
          return;
        }
        const buffer = vectorBuffer(values);
        const metadata = { ...item };
        delete metadata.vector; delete metadata.embedding;
        vectorInsert.run(id, text(item.charId) || null, text(item.model), values.length, buffer, sha256(buffer), field, Object.hasOwn(item, "dimensions") ? 1 : 0, iso(item.updatedAt), JSON.stringify(metadata));
      });

      const linkInsert = writeDb.prepare(`INSERT INTO v2_memory_links(link_id,character_id,source_memory_id,target_memory_id,link_type,strength,activation_count,last_activated_at,raw_json,content_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(link_id) DO UPDATE SET strength=excluded.strength,activation_count=excluded.activation_count,last_activated_at=excluded.last_activated_at,raw_json=excluded.raw_json,content_hash=excluded.content_hash`);
      migrated.links = this.migrateDomain(readDb, writeDb, runId, "links", (item, raw, index) => {
        const source = text(item.sourceId), target = text(item.targetId), type = text(item.type, "related");
        const id = text(item.id, `legacy-link:${index}`);
        if (!source || !target) this.addIssue(writeDb, runId, "links", index, id, "LINK_MISSING_ENDPOINT", { source, target });
        linkInsert.run(id, text(item.charId) || null, source || `missing:${index}:source`, target || `missing:${index}:target`, type, Number(item.strength || 0), Number(item.activationCount || 0), item.lastActivatedAt ? iso(item.lastActivatedAt) : null, raw, contentHash(item));
      });

      const boxInsert = writeDb.prepare(`INSERT INTO v2_event_boxes(event_box_id,character_id,name,tags_json,summary_memory_id,predecessor_box_id,compression_count,sealed,created_at,updated_at,raw_json,content_hash,deleted_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_box_id) DO UPDATE SET raw_json=excluded.raw_json,content_hash=excluded.content_hash`);
      const memberInsert = writeDb.prepare("INSERT OR IGNORE INTO v2_event_box_members(event_box_id,memory_id,member_state,ordinal) VALUES(?,?,?,?)");
      migrated.eventBoxes = this.migrateDomain(readDb, writeDb, runId, "eventBoxes", (item, raw, index) => {
        const id = text(item.id, `legacy-event-box:${index}`), createdAt = iso(item.createdAt);
        boxInsert.run(id, text(item.charId, "unbound"), text(item.name), JSON.stringify(asArray(item.tags)), text(item.summaryNodeId) || null, text(item.predecessorBoxId) || null, Number(item.compressionCount || 0), boolInt(item.sealed), createdAt, iso(item.updatedAt, createdAt), raw, contentHash(item), item.deletedAt ? iso(item.deletedAt) : null);
        asArray(item.liveMemoryIds).forEach((memoryId, ordinal) => memberInsert.run(id, text(memoryId), "live", ordinal));
        asArray(item.archivedMemoryIds).forEach((memoryId, ordinal) => memberInsert.run(id, text(memoryId), "archived", ordinal));
        if (text(item.summaryNodeId)) memberInsert.run(id, text(item.summaryNodeId), "summary", 0);
      });

      const plateInsert = writeDb.prepare(`INSERT INTO v2_room_plates(room_plate_id,character_id,room,version,updated_at,raw_json,content_hash,deleted_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(room_plate_id) DO UPDATE SET version=excluded.version,updated_at=excluded.updated_at,raw_json=excluded.raw_json,content_hash=excluded.content_hash`);
      const plateEntryInsert = writeDb.prepare(`INSERT INTO v2_room_plate_entries(entry_id,room_plate_id,character_id,room,text,tag,first_learned_at,updated_at,source_count,ordinal,raw_json,content_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET text=excluded.text,tag=excluded.tag,updated_at=excluded.updated_at,source_count=excluded.source_count,ordinal=excluded.ordinal,raw_json=excluded.raw_json,content_hash=excluded.content_hash`);
      migrated.roomPlates = this.migrateDomain(readDb, writeDb, runId, "roomPlates", (item, raw, index) => {
        const charId = text(item.charId, "unbound"), room = text(item.room, "unknown"), id = text(item.id, `${charId}:${room}`), updatedAt = iso(item.updatedAt);
        plateInsert.run(id, charId, room, Number(item.version || 1), updatedAt, raw, contentHash(item), item.deletedAt ? iso(item.deletedAt) : null);
        asArray(item.entries).forEach((entry, ordinal) => {
          const entryId = text(entry.id, `${id}:entry:${ordinal}`), entryRaw = JSON.stringify(entry);
          plateEntryInsert.run(entryId, id, charId, room, text(entry.text), text(entry.tag), entry.firstLearnedAt ? iso(entry.firstLearnedAt) : null, iso(entry.updatedAt, updatedAt), Number(entry.sourceCount || 1), ordinal, entryRaw, contentHash(entry));
        });
      });

      const anticipationInsert = writeDb.prepare(`INSERT INTO v2_anticipations(anticipation_id,character_id,content,status,created_at,anchored_at,resolved_at,raw_json,content_hash,deleted_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(anticipation_id) DO UPDATE SET status=excluded.status,anchored_at=excluded.anchored_at,resolved_at=excluded.resolved_at,raw_json=excluded.raw_json,content_hash=excluded.content_hash`);
      migrated.anticipations = this.migrateDomain(readDb, writeDb, runId, "anticipations", (item, raw, index) => anticipationInsert.run(text(item.id, `legacy-anticipation:${index}`), text(item.charId, "unbound"), text(item.content), text(item.status, "active"), iso(item.createdAt), item.anchoredAt ? iso(item.anchoredAt) : null, item.resolvedAt ? iso(item.resolvedAt) : null, raw, contentHash(item), item.deletedAt ? iso(item.deletedAt) : null));

      const digestInsert = writeDb.prepare(`INSERT INTO v2_digest_reports(digest_report_id,character_id,trigger_type,created_at,examined_json,outcomes_json,plate_submissions_json,plate_updated_json,raw_json,content_hash)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(digest_report_id) DO UPDATE SET raw_json=excluded.raw_json,content_hash=excluded.content_hash`);
      migrated.digestReports = this.migrateDomain(readDb, writeDb, runId, "digestReports", (item, raw, index) => digestInsert.run(text(item.id, `legacy-digest:${index}`), text(item.charId, "unbound"), text(item.trigger), iso(item.createdAt), JSON.stringify(asArray(item.examined)), JSON.stringify(asArray(item.outcomes)), JSON.stringify(asArray(item.plateSubmissions)), JSON.stringify(asArray(item.plateUpdated)), raw, contentHash(item)));

      const runtimeRow = readDb.prepare("SELECT version,data_json,content_hash FROM runtime_domains WHERE domain_key='hub:characterRuntime'").get();
      if (runtimeRow) {
        const runtimeV2 = new RuntimeV2Repository(writeDb, { contentHash });
        const result = runtimeV2.replaceDomain("hub:characterRuntime", json(runtimeRow.data_json, {}), { sourceHash: runtimeRow.content_hash, sourceVersion: Number(runtimeRow.version) });
        migrated.characterRuntime = Number(result.changedRows || 0);
      } else {
        migrated.characterRuntime = 0;
      }

      migrated.sourceOrder = this.backfillSourceOrders(readDb, writeDb);
      this.markShadowBaselines(readDb, writeDb);
      readDb.close();
      readDbClosed = true;
      const report = { runId, migrated, validation: this.validate() };
      writeDb.prepare("UPDATE v2_migration_runs SET status='completed',completed_at=?,report_json=?,last_error=NULL WHERE run_id=?")
        .run(nowIso(), JSON.stringify(report), runId);
      try {
        report.walCheckpoint = writeDb.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      } catch (error) {
        report.walCheckpoint = { error: String(error?.message || error) };
      }
      return report;
    } catch (error) {
      try {
        writeDb.prepare("UPDATE v2_migration_runs SET status='failed',completed_at=?,last_error=? WHERE run_id=?")
          .run(nowIso(), String(error?.stack || error).slice(0, 12000), runId);
      } catch {}
      throw error;
    } finally {
      if (!readDbClosed) readDb.close();
      writeDb.close();
    }
  }
}
